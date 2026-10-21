import { PGlite } from "@electric-sql/pglite";
import type { RungsStore } from "@rungsjs/core";
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
