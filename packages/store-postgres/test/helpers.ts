import { PGlite } from "@electric-sql/pglite";
import type { RungsStore } from "@rungsjs/core";
import { expect } from "vitest";
import { fromPglite, migrate, type PgClient, postgresStore } from "../src/index.js";

/**
 * One in-process PGlite database per test file. It takes seconds to start (longer on CI), so
 * call `start()` in `beforeAll` with its own timeout instead of inside the first test. Every
 * store gets its own freshly migrated schema, so tests never see each other's rows.
 */
export function pgliteHarness() {
  let db: PGlite | undefined;
  let next = 0;
  const client = (): PgClient => {
    db ??= new PGlite();
    return fromPglite(db);
  };
  return {
    client,
    async start() {
      db ??= await PGlite.create();
    },
    async freshSchema(): Promise<{ client: PgClient; schema: string }> {
      const schema = `t${++next}`;
      await migrate(client(), { schema });
      return { client: client(), schema };
    },
    async freshStore(): Promise<RungsStore> {
      const { client: c, schema } = await this.freshSchema();
      return postgresStore(c, { schema });
    },
    async close() {
      await db?.close();
    },
  };
}

/** Every adapter reports rowCount the way node-postgres does. */
export async function checkRowCount(client: PgClient, table: string): Promise<void> {
  await client.execute(`CREATE TABLE ${table} (n integer)`);
  const counts = [
    (await client.query(`INSERT INTO ${table} SELECT generate_series(1, 3)`)).rowCount,
    (await client.query(`SELECT n FROM ${table}`)).rowCount,
    (await client.query(`SELECT n FROM ${table} WHERE n > 5`)).rowCount,
    (await client.query(`UPDATE ${table} SET n = n + 1 WHERE n < 3`)).rowCount,
    (await client.query(`DELETE FROM ${table} WHERE n > 100`)).rowCount,
    (await client.transaction((tx) => tx.query(`SELECT n FROM ${table}`))).rowCount,
  ];
  expect(counts).toEqual([3, 3, 0, 2, 0, 3]);
}
