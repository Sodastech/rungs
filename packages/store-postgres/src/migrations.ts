import type { PgClient } from "./client.js";
import { type Names, type NamingOptions, names } from "./naming.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: (n: Names) => string;
}

/**
 * Forward-only migrations. A release that changes the schema adds a new entry (never edits an old
 * one) and its changeset says that `migrate()` must run.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "init",
    sql: (n) => {
      const t = n.table;
      return `
-- Requests: the engine's state as JSONB, plus the columns the hot queries filter on.
CREATE TABLE ${t.requests} (
  id            text PRIMARY KEY,
  tenant        text NOT NULL,
  status        text NOT NULL,
  version       integer NOT NULL,
  closed_at     timestamptz,
  next_due_at   timestamptz,
  claimed_until timestamptz,
  state         jsonb NOT NULL
);
CREATE INDEX ${n.local("requests_due")} ON ${t.requests} (next_due_at) WHERE next_due_at IS NOT NULL;
CREATE INDEX ${n.local("requests_closed")} ON ${t.requests} (closed_at) WHERE closed_at IS NOT NULL;

-- Inbox: one row per pending task on an active step, rewritten with the request.
CREATE TABLE ${t.inbox} (
  task_id      text PRIMARY KEY,
  request_id   text NOT NULL REFERENCES ${t.requests} (id) ON DELETE CASCADE,
  tenant       text NOT NULL,
  assignee_id  text NOT NULL,
  on_behalf_of text,
  assigned_at  timestamptz NOT NULL,
  view         jsonb NOT NULL
);
CREATE INDEX ${n.local("inbox_assignee")} ON ${t.inbox} (tenant, assignee_id, assigned_at, task_id);
CREATE INDEX ${n.local("inbox_owner")} ON ${t.inbox} (tenant, on_behalf_of, assigned_at, task_id)
  WHERE on_behalf_of IS NOT NULL;
CREATE INDEX ${n.local("inbox_request")} ON ${t.inbox} (request_id);

-- Audit: append-only. Deleting is allowed only inside purgeRequest / purgeRequests (EC-61).
CREATE TABLE ${t.audit} (
  request_id text NOT NULL,
  seq        integer NOT NULL,
  tenant     text NOT NULL,
  type       text NOT NULL,
  at         timestamptz NOT NULL,
  event      jsonb NOT NULL,
  PRIMARY KEY (request_id, seq)
);
CREATE FUNCTION ${n.quotedLocal("audit_append_only")}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND current_setting('rungs.purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'Rungs audit events are append-only (%); use purgeRequest or purgeRequests to delete closed requests', TG_OP;
END
$$;
CREATE TRIGGER ${n.local("audit_append_only")} BEFORE UPDATE OR DELETE ON ${t.audit}
  FOR EACH ROW EXECUTE FUNCTION ${n.quotedLocal("audit_append_only")}();
CREATE TRIGGER ${n.local("audit_no_truncate")} BEFORE TRUNCATE ON ${t.audit}
  FOR EACH STATEMENT EXECUTE FUNCTION ${n.quotedLocal("audit_append_only")}();

-- Outbox: domain events until delivered; delivered rows are kept until purgeDispatchedEvents.
CREATE TABLE ${t.outbox} (
  request_id      text NOT NULL,
  seq             integer NOT NULL,
  event           jsonb NOT NULL,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error      text,
  claimed_until   timestamptz,
  dispatched_at   timestamptz,
  PRIMARY KEY (request_id, seq)
);
CREATE INDEX ${n.local("outbox_pending")} ON ${t.outbox} (next_attempt_at) WHERE dispatched_at IS NULL;
CREATE INDEX ${n.local("outbox_dispatched")} ON ${t.outbox} (dispatched_at) WHERE dispatched_at IS NOT NULL;

CREATE TABLE ${t.flows} (
  tenant  text NOT NULL,
  key     text NOT NULL,
  version integer NOT NULL,
  flow    jsonb NOT NULL,
  PRIMARY KEY (tenant, key, version)
);

CREATE TABLE ${t.idempotency} (
  tenant     text NOT NULL,
  key        text NOT NULL,
  request_id text,
  at         timestamptz NOT NULL,
  record     jsonb NOT NULL,
  PRIMARY KEY (tenant, key)
);
CREATE INDEX ${n.local("idempotency_request")} ON ${t.idempotency} (request_id);
CREATE INDEX ${n.local("idempotency_at")} ON ${t.idempotency} (at);

CREATE TABLE ${t.delegations} (
  id           text PRIMARY KEY,
  tenant       text NOT NULL,
  from_user_id text NOT NULL,
  to_user_id   text NOT NULL,
  rule         jsonb NOT NULL
);
CREATE INDEX ${n.local("delegations_from")} ON ${t.delegations} (from_user_id);
CREATE INDEX ${n.local("delegations_to")} ON ${t.delegations} (to_user_id);
`.trimStart();
    },
  },
];

/** The schema version this release needs; the store refuses an older one. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

function bookkeeping(n: Names): string {
  return `CREATE SCHEMA IF NOT EXISTS "${n.schema}";
CREATE TABLE IF NOT EXISTS ${n.table.schema_migrations} (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;
}

/**
 * The schema as one SQL script, for hosts that run migrations with their own tool (Prisma,
 * Drizzle, Flyway). With `from` (and `to`), only the migrations after that version, for an upgrade. It records
 * each version, so `migrate()` and the store's version check keep working afterwards. The same
 * scripts for the default names ship in the package as `migrations/NNNN_name.sql`.
 */
export function migrationSql(options: NamingOptions & { from?: number; to?: number } = {}): string {
  const n = names(options);
  const from = options.from ?? 0;
  const to = options.to ?? SCHEMA_VERSION;
  const parts = MIGRATIONS.filter((m) => m.version > from && m.version <= to).map(
    (m) =>
      `-- Migration ${m.version}: ${m.name}\n${m.sql(n)}\n` +
      `INSERT INTO ${n.table.schema_migrations} (version, name) VALUES (${m.version}, '${m.name}');\n`,
  );
  return `${bookkeeping(n)}\n${parts.join("\n")}`;
}

/** File name and default-named script of each migration, as shipped in `migrations/`. */
export function migrationFiles(): { file: string; sql: string }[] {
  return MIGRATIONS.map((m) => ({
    file: `${String(m.version).padStart(4, "0")}_${m.name}.sql`,
    sql: migrationSql({ from: m.version - 1, to: m.version }),
  }));
}

/**
 * Applies the migrations that are missing, in one transaction under an advisory lock, so several
 * processes starting at once cannot apply the same migration twice. Returns the versions applied.
 */
export async function migrate(
  client: PgClient,
  options: NamingOptions = {},
): Promise<{ applied: number[]; version: number }> {
  const n = names(options);
  return client.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [n.lockKey]);
    await tx.execute(bookkeeping(n));
    const done = await tx.query<{ version: number }>(
      `SELECT version FROM ${n.table.schema_migrations}`,
    );
    const have = new Set(done.rows.map((r) => Number(r.version)));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (have.has(m.version)) continue;
      await tx.execute(m.sql(n));
      await tx.query(`INSERT INTO ${n.table.schema_migrations} (version, name) VALUES ($1, $2)`, [
        m.version,
        m.name,
      ]);
      applied.push(m.version);
    }
    return { applied, version: SCHEMA_VERSION };
  });
}
