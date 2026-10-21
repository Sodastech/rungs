import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

let now = new Date("2026-03-02T09:00:00.000Z");
const rungs = createRungs({
  store: memoryStore(),
  clock: () => now,
  ids: () => crypto.randomUUID(),
});
await rungs.flows.register({
  key: "leave",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_maria"] } }],
});
const submit = (id: string) =>
  rungs.submit({
    flow: "leave",
    requesterId: "u_tom",
    subject: { type: "leave", id },
    payload: { days: 3 },
  });

// #region out-of-office
await rungs.delegations.set({
  fromUserId: "u_maria",
  toUserId: "u_omar",
  startsAt: "2026-03-02T00:00:00.000Z",
  endsAt: "2026-03-09T00:00:00.000Z",
});

const request = await submit("LV-1");
const [task] = request.steps[0]?.tasks ?? [];
console.log(task?.assigneeId, task?.onBehalfOf); // "u_omar" "u_maria"
// #endregion out-of-office

now = new Date("2026-03-10T09:00:00.000Z");
const second = await submit("LV-2");
const secondTask = second.steps[0]?.tasks[0];

// #region delegate
// After the rule ended, Maria hands one task to a colleague herself.
const handed = await rungs.delegate({
  requestId: second.id,
  taskId: secondTask?.id ?? "",
  actorId: "u_maria",
  toUserId: "u_lena",
  comment: "Lena knows this team",
});

// #endregion delegate

export { handed, task };
