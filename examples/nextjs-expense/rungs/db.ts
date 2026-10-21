import { mkdirSync } from "node:fs";
import { fromPg, fromPglite, migrate, type PgClient } from "@rungsjs/store-postgres";

/** Everything the demo stores lives in this schema, so a reset never touches anything else. */
export const SCHEMA = "rungs_demo";

/**
 * PGlite (PostgreSQL compiled to WebAssembly, running in this process) by default, so the demo
 * needs no database server. Set DATABASE_URL to use a real PostgreSQL server instead.
 * `dataDir: "memory"` keeps PGlite in memory, for tests.
 */
export async function openDatabase(options: { dataDir?: string } = {}): Promise<PgClient> {
  const url = process.env.DATABASE_URL;
  if (url && options.dataDir === undefined) {
    const { default: pg } = await import("pg");
    return fromPg(new pg.Pool({ connectionString: url }));
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = options.dataDir ?? ".data/pglite";
  if (dataDir === "memory") return fromPglite(await PGlite.create());
  mkdirSync(dataDir, { recursive: true });
  return fromPglite(await PGlite.create(dataDir));
}

/** Bump when the app's own tables change; an older local demo is then reset. */
const APP_TABLES_VERSION = "2";

/** Rungs' own tables (through `migrate`) plus the four tables this app keeps for itself. */
export async function prepareSchema(db: PgClient): Promise<void> {
  const existing = await db.query<{ settings: string | null }>(
    `SELECT to_regclass('${SCHEMA}.settings')::text AS settings
     FROM pg_namespace WHERE nspname = '${SCHEMA}'`,
  );
  if (existing.rowCount > 0) {
    const version =
      existing.rows[0]?.settings === null
        ? undefined
        : (
            await db.query<{ value: string }>(
              `SELECT value FROM ${SCHEMA}.settings WHERE key = 'app_tables_version'`,
            )
          ).rows[0]?.value;
    if (version !== APP_TABLES_VERSION) await dropSchema(db);
  }

  await migrate(db, { schema: SCHEMA });
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.expenses (
      id text PRIMARY KEY,
      requester_id text NOT NULL,
      title text NOT NULL,
      category text NOT NULL,
      amount numeric(12, 2) NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.notifications (
      request_id text NOT NULL,
      seq integer NOT NULL,
      user_id text NOT NULL,
      message text NOT NULL,
      at timestamptz NOT NULL,
      PRIMARY KEY (request_id, seq, user_id)
    );
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.inactive_users (user_id text PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.settings (key text PRIMARY KEY, value text NOT NULL);
    INSERT INTO ${SCHEMA}.settings (key, value) VALUES ('app_tables_version', '${APP_TABLES_VERSION}')
      ON CONFLICT (key) DO NOTHING;
  `);
}

/** Drops the demo schema; `prepareSchema` creates it again. */
export async function dropSchema(db: PgClient): Promise<void> {
  await db.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
}
