import { randomBytes } from "node:crypto";
import { migrationSql, type PgClient } from "@rungsjs/store-postgres";
import { APP_TABLES_VERSION, appTablesSql, inSchema } from "./db";
import { type Demo, openDemo } from "./demo";
import snapshot from "./seed-snapshot.json";

/**
 * The online demo gives every visitor a sandbox: a PostgreSQL schema of their own, with their own
 * data and demo clock. One visitor's "+3 days" runs `tick` on their schema only, and a request id
 * from another sandbox finds nothing, because the tables are not shared.
 */

export const CONTROL = "demo_control";
const ID = /^[0-9a-f]{32}$/;
const TOUCH_AFTER = "5 minutes";

/** A sandbox made by another app version is left to the cleanup, and the visitor starts again. */
const VERSION = `${APP_TABLES_VERSION}:${snapshot.end}`;

const schemaOf = (id: string) => `sb_${id}`;

export const isSandboxId = (value: string | undefined): value is string =>
  value !== undefined && ID.test(value);

const CONTROL_SQL = `
  CREATE SCHEMA IF NOT EXISTS ${CONTROL};
  CREATE TABLE IF NOT EXISTS ${CONTROL}.sandboxes (
    id text PRIMARY KEY,
    version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sandboxes_last_seen ON ${CONTROL}.sandboxes (last_seen);
  CREATE TABLE IF NOT EXISTS ${CONTROL}.rate_limits (
    key text PRIMARY KEY,
    window_seconds integer NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    count integer NOT NULL DEFAULT 1
  );
`;

/** The first sandbox after a fresh database creates the control tables, under a lock. */
async function ensureControl(client: PgClient): Promise<void> {
  await client.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CONTROL]);
    await tx.execute(CONTROL_SQL);
  });
}

const isMissingTable = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "42P01";

/** Runs `run`; if the control tables do not exist yet, creates them and runs it once more. */
export async function withControl<T>(client: PgClient, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    await ensureControl(client);
    return run();
  }
}

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/**
 * The seed as SQL: the rows of `seed-snapshot.json`, with every timestamp moved so that the story
 * ends at `now`. The rows come from replaying the story, so they are what the commands produce.
 */
function seedSql(schema: string, now: number): string {
  const shift = now - Date.parse(snapshot.end);
  return Object.entries(snapshot.tables)
    .filter(([, rows]) => rows.length > 0)
    .map(([table, rows]) => {
      const moved = JSON.stringify(rows).replace(ISO_TIME, (at) =>
        new Date(Date.parse(at) + shift).toISOString(),
      );
      return `INSERT INTO ${schema}.${table}
        SELECT * FROM jsonb_populate_recordset(null::${schema}.${table}, $seed$${moved}$seed$::jsonb);`;
    })
    .join("\n");
}

/**
 * Everything a sandbox needs, sent as one script: one round trip to the database. PostgreSQL runs
 * such a script as one transaction, so a sandbox is listed only once it is complete, and two tabs
 * opening at once cannot seed the same one twice.
 */
function provisionSql(id: string, now: number): string {
  const schema = schemaOf(id);
  return [
    migrationSql({ schema }),
    appTablesSql(schema),
    seedSql(schema, now),
    `INSERT INTO ${CONTROL}.sandboxes (id, version) VALUES ('${id}', '${VERSION}')
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, last_seen = now();`,
  ].join("\n");
}

export async function createSandbox(client: PgClient): Promise<string> {
  const id = randomBytes(16).toString("hex");
  await withControl(client, () => client.execute(provisionSql(id, Date.now())));
  return id;
}

/** Whether the sandbox can be used. Records the visit, at most once per `TOUCH_AFTER`. */
export async function sandboxExists(client: PgClient, id: string): Promise<boolean> {
  if (!isSandboxId(id)) return false;
  const { rows } = await withControl(client, () =>
    client.query<{ id: string }>(
      `WITH touched AS (
         UPDATE ${CONTROL}.sandboxes SET last_seen = now()
         WHERE id = $1 AND last_seen < now() - interval '${TOUCH_AFTER}'
       )
       SELECT id FROM ${CONTROL}.sandboxes WHERE id = $1 AND version = $2`,
      [id, VERSION],
    ),
  );
  return rows.length > 0;
}

export async function openSandbox(client: PgClient, id: string): Promise<Demo | null> {
  if (!(await sandboxExists(client, id))) return null;
  return openDemo(inSchema(client, schemaOf(id)));
}

/** Puts the sandbox back to the sample data; the visitor keeps their cookie. */
export async function resetSandbox(client: PgClient, id: string): Promise<void> {
  if (!isSandboxId(id)) throw new Error("Not a sandbox id");
  await client.execute(
    `DROP SCHEMA IF EXISTS ${schemaOf(id)} CASCADE;\n${provisionSql(id, Date.now())}`,
  );
}

/**
 * Deletes sandboxes nobody has visited for `olderThanHours`, schema and all. Dropping the schema
 * also removes requests that are still open, which `purgeRequests` refuses, on purpose, to touch.
 */
export async function cleanupSandboxes(
  client: PgClient,
  options: { olderThanHours: number; limit: number },
): Promise<{ deleted: number }> {
  const { rows } = await withControl(client, () =>
    client.query<{ id: string }>(
      `SELECT id FROM ${CONTROL}.sandboxes
       WHERE last_seen < now() - make_interval(hours => $1::int)
       ORDER BY last_seen LIMIT $2`,
      [options.olderThanHours, options.limit],
    ),
  );
  for (const { id } of rows) {
    if (!isSandboxId(id)) continue;
    await client.execute(
      `DROP SCHEMA IF EXISTS ${schemaOf(id)} CASCADE;
       DELETE FROM ${CONTROL}.sandboxes WHERE id = '${id}';`,
    );
  }
  await client.query(
    `DELETE FROM ${CONTROL}.rate_limits
     WHERE started_at < now() - make_interval(secs => window_seconds) - interval '1 hour'`,
  );
  return { deleted: rows.length };
}
