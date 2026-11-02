import { mkdirSync } from "node:fs";
import { fromPg, fromPglite, migrate, type PgClient } from "@rungsjs/store-postgres";

/** The local demo stores everything in this schema, so a reset never touches anything else. */
export const SCHEMA = "rungs_demo";

/** A client and the schema it works in: `rungs_demo` locally, one per visitor online. */
export type AppDb = PgClient & { readonly schema: string };

export const inSchema = (client: PgClient, schema: string): AppDb => ({ ...client, schema });

/**
 * PGlite (PostgreSQL compiled to WebAssembly, running in this process) by default, so the demo
 * needs no database server. Set DATABASE_URL to use a real PostgreSQL server instead.
 * `dataDir: "memory"` keeps PGlite in memory, for tests.
 */
export async function openDatabase(options: { dataDir?: string } = {}): Promise<PgClient> {
  const url = process.env.DATABASE_URL;
  if (url && options.dataDir === undefined) return openPool(url);
  // PGlite's files would be temporary and differ per instance on Vercel, so never fall back to it.
  if (process.env.VERCEL && options.dataDir === undefined) {
    throw new Error("DATABASE_URL is required on Vercel");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = options.dataDir ?? process.env.DEMO_DATA_DIR ?? ".data/pglite";
  if (dataDir === "memory") return fromPglite(await PGlite.create());
  mkdirSync(dataDir, { recursive: true });
  return fromPglite(await PGlite.create(dataDir));
}

/**
 * Serverless instances are many and short-lived, so each keeps few connections and lets idle ones
 * go. Without the error listener, a connection dropped by the server (Neon suspending after
 * inactivity) would end the process.
 */
async function openPool(connectionString: string): Promise<PgClient> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", () => undefined);
  if (process.env.VERCEL) {
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }
  return fromPg(pool);
}

/** Bump when the app's own tables change; an older local demo is then reset. */
export const APP_TABLES_VERSION = "2";

/** The four tables this app keeps for itself, next to Rungs' own. */
export function appTablesSql(schema: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${schema}.expenses (
      id text PRIMARY KEY,
      requester_id text NOT NULL,
      title text NOT NULL,
      category text NOT NULL,
      amount numeric(12, 2) NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.notifications (
      request_id text NOT NULL,
      seq integer NOT NULL,
      user_id text NOT NULL,
      message text NOT NULL,
      at timestamptz NOT NULL,
      PRIMARY KEY (request_id, seq, user_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.inactive_users (user_id text PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS ${schema}.settings (key text PRIMARY KEY, value text NOT NULL);
    INSERT INTO ${schema}.settings (key, value) VALUES ('app_tables_version', '${APP_TABLES_VERSION}')
      ON CONFLICT (key) DO NOTHING;
  `;
}

/** Rungs' own tables (through `migrate`) plus the four tables this app keeps for itself. */
export async function prepareSchema(db: AppDb): Promise<void> {
  const { schema } = db;
  const existing = await db.query<{ settings: string | null }>(
    `SELECT to_regclass('${schema}.settings')::text AS settings
     FROM pg_namespace WHERE nspname = '${schema}'`,
  );
  if (existing.rowCount > 0) {
    const version =
      existing.rows[0]?.settings === null
        ? undefined
        : (
            await db.query<{ value: string }>(
              `SELECT value FROM ${schema}.settings WHERE key = 'app_tables_version'`,
            )
          ).rows[0]?.value;
    if (version !== APP_TABLES_VERSION) await dropSchema(db);
  }

  await migrate(db, { schema });
  await db.execute(appTablesSql(schema));
}

/** Drops the demo schema; `prepareSchema` creates it again. */
export async function dropSchema(db: AppDb): Promise<void> {
  await db.execute(`DROP SCHEMA IF EXISTS ${db.schema} CASCADE`);
}
