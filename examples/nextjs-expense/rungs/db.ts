import { mkdirSync } from "node:fs";
import { fromPg, fromPglite, migrate, type PgClient } from "@rungsjs/store-postgres";

// Spike (edited): PGlite file database by default, a real PostgreSQL server with DATABASE_URL.
const g = globalThis as unknown as { __db?: Promise<PgClient> };

async function open(): Promise<PgClient> {
  const url = process.env.DATABASE_URL;
  let client: PgClient;
  if (url) {
    const { default: pg } = await import("pg");
    client = fromPg(new pg.Pool({ connectionString: url }));
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    mkdirSync(".data", { recursive: true });
    client = fromPglite(await PGlite.create(".data/pglite"));
  }
  await migrate(client);
  return client;
}

export function db(): Promise<PgClient> {
  g.__db ??= open();
  return g.__db;
}
