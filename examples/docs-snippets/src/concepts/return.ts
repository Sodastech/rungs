import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
});

// #region policy
await rungs.flows.register({
  key: "expense",
  returnPolicy: "restart", // after a resubmit every step runs again; or "from-returned-step"
  resubmitDeadline: "P7D", // optional: how long a returned request waits for the requester
  steps: [
    { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
    { id: "finance", approvers: { type: "users", ids: ["u_fin"] } },
  ],
});
// #endregion policy

const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-5" },
  payload: { amount: 300 },
});
await rungs.approve({ requestId: request.id, actorId: "u_mgr" });

// #region return
const returned = await rungs.return({
  requestId: request.id,
  actorId: "u_fin",
  to: "requester", // or { stepId: "manager" } to send it back one step
  comment: "Please attach the invoice",
});
console.log(returned.status); // "returned"

const resubmitted = await rungs.resubmit({
  requestId: request.id,
  actorId: "u_req",
  payload: { amount: 320 },
});
console.log(resubmitted.status); // "pending", at the manager step again

// #endregion return

export { resubmitted, returned };
