import { createRungs, type TickSummary } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

// #region clock
let now = new Date("2026-03-02T09:00:00.000Z");
const rungs = createRungs({
  store: memoryStore(),
  clock: () => now, // Rungs never reads the time itself
  ids: () => crypto.randomUUID(),
  roles: (role) => (role === "director" ? ["u_dir"] : []),
  onEvent: (event) => {
    if (event.type === "task.reminder") console.log("remind", event.data.assigneeId);
  },
});
// #endregion clock

await rungs.flows.register({
  key: "expense",
  steps: [
    // #region deadline
    {
      id: "manager",
      approvers: { type: "users", ids: ["u_mgr"] },
      deadline: "P2D", // two days after the step starts
      remindBefore: "P1D", // one reminder a day before
      onTimeout: "escalate", // or "remind", "auto-approve", "auto-reject"
      escalateTo: { type: "role", role: "director" },
    },
    // #endregion deadline
  ],
});
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-3" },
  payload: { amount: 80 },
});

const ticks: TickSummary[] = [];

// #region tick
// Run tick on a schedule, for example every minute. It applies whatever is due at `now`.
now = new Date("2026-03-03T10:00:00.000Z");
ticks.push(await rungs.tick()); // remind u_mgr
now = new Date("2026-03-04T10:00:00.000Z");
ticks.push(await rungs.tick()); // escalated: the task moves to u_dir
// #endregion tick

const escalated = await rungs.get(request.id);

export { escalated, ticks };
