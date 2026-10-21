import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
});

// #region flows
// A global flow for everyone, and Acme's own version with an extra step.
await rungs.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});
await rungs.flows.register(
  {
    key: "expense",
    steps: [
      { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
      { id: "controller", approvers: { type: "users", ids: ["u_ctrl"] } },
    ],
  },
  { tenantId: "acme" },
);
// #endregion flows

// #region submit
const acme = await rungs.submit({
  flow: "expense",
  tenantId: "acme", // uses Acme's flow; tenants without one use the global flow
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 90 },
});
const globex = await rungs.submit({
  flow: "expense",
  tenantId: "globex",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 90 },
});
// #endregion submit

// #region lists
// Every list matches the tenant exactly. Without tenantId, only requests without a tenant.
const acmeInbox = await rungs.inbox({ userId: "u_mgr", tenantId: "acme" });
const acmeRequests = await rungs.requests({ tenantId: "acme" });
const noTenant = await rungs.requests();

// #endregion lists

export { acme, acmeInbox, acmeRequests, globex, noTenant };
