import { createRungs, type DomainEvent } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const sent: DomainEvent[] = [];
const email = async (event: DomainEvent) => {
  sent.push(event);
};

// #region on-event
const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
  // After each command commits, at least once and in order per request. Make it idempotent:
  // `requestId` and `seq` identify an event.
  onEvent: async (event) => {
    if (event.type === "task.assigned") await email(event);
  },
});
// #endregion on-event

await rungs.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-8" },
  payload: { amount: 40 },
});
await rungs.approve({ requestId: request.id, actorId: "u_mgr", comment: "Fine" });

// #region history
const history = await rungs.history(request.id);
for (const event of history) console.log(event.seq, event.at, event.actorId, event.type);

// 1 … u_req request.submitted
// 2 … u_req step.activated
// 3 … u_req task.assigned
// 4 … u_mgr task.approved
// …
// #endregion history

export { history, sent };
