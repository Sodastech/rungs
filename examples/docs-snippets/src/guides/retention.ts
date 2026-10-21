import { PGlite } from "@electric-sql/pglite";
import { createRungs } from "@rungsjs/core";
import {
  fromPglite,
  migrate,
  postgresStore,
  purgeDispatchedEvents,
  purgeIdempotency,
  purgeRequest,
  purgeRequests,
} from "@rungsjs/store-postgres";

const db = fromPglite(await PGlite.create());
await migrate(db);
const rungs = createRungs({
  store: postgresStore(db),
  clock: () => new Date("2025-06-01T09:00:00.000Z"),
  ids: () => crypto.randomUUID(),
  events: "discard",
});
await rungs.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});
const submit = (id: string) =>
  rungs.submit({
    flow: "expense",
    tenantId: "acme",
    requesterId: "u_req",
    subject: { type: "expense", id },
    payload: { amount: 10 },
    idempotencyKey: `submit:${id}`,
  });
const old = await submit("EXP-1");
await rungs.approve({ requestId: old.id, actorId: "u_mgr" });
const open = await submit("EXP-2");

// #region policy
// A scheduled job: keep closed requests two years, per tenant. Log what was deleted.
const result = await purgeRequests(db, {
  tenantId: "acme", // or allTenants: true; one of the two is required
  closedBefore: "2026-01-01T00:00:00.000Z",
});
console.log(result); // { requests: 1, auditEvents: …, outboxEvents: …, idempotencyKeys: 1 }
// #endregion policy

// #region erase
// A request to erase one person's data: purge their closed requests one by one.
// An open request is refused with InvalidTransitionError; withdraw or decide it first.
const refused = await purgeRequest(db, open.id).catch((error: unknown) => error);
// #endregion erase

// #region housekeeping
await purgeIdempotency(db, { olderThan: "2026-01-01T00:00:00.000Z" });
await purgeDispatchedEvents(db, { olderThan: "2026-01-01T00:00:00.000Z" });
// #endregion housekeeping

const remaining = await rungs.requests({ tenantId: "acme" });

export { refused, remaining, result };
