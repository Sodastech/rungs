import { PGlite } from "@electric-sql/pglite";
import { createRungs, type Rungs } from "@rungsjs/core";
import { fromPg, fromPglite, migrate, migrationSql, postgresStore } from "@rungsjs/store-postgres";
import pg from "pg";

// Needs a PostgreSQL server, so the tests only type-check it; the PGlite version below runs.
// #region connect
export async function connect(connectionString: string): Promise<Rungs> {
  const db = fromPg(new pg.Pool({ connectionString, max: 10 })); // more than one connection
  await migrate(db); // creates or upgrades the tables; safe to run from several processes
  return createRungs({
    store: postgresStore(db),
    clock: () => new Date(),
    ids: () => crypto.randomUUID(),
  });
}
// #endregion connect

// #region schema
const approvals = fromPglite(await PGlite.create());
await migrate(approvals, { schema: "approvals", tablePrefix: "wf_" });
const store = postgresStore(approvals, { schema: "approvals", tablePrefix: "wf_" });
// #endregion schema

// #region own-tool
// For Prisma, Drizzle, Flyway or plain psql: the same migrations as SQL.
const everything = migrationSql({ schema: "approvals" });
const upgradeFrom1 = migrationSql({ schema: "approvals", from: 1 });
// #endregion own-tool

const rungs = createRungs({ store, clock: () => new Date(), ids: () => crypto.randomUUID() });
await rungs.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 5 },
});

export { approvals, everything, request, upgradeFrom1 };
