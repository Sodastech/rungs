import assert from "node:assert/strict";
import { createRungs, type FlowInput } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const expenseFlow: FlowInput = {
  key: "expense",
  steps: [
    {
      id: "manager",
      approvers: { type: "users", ids: ["u_mgr"] },
      deadline: "P2D",
      onTimeout: "escalate",
      escalateTo: { type: "users", ids: ["u_dir"] },
    },
  ],
};

// #region test
// Your flow, on the memory store, with a clock the test moves. No database, no waiting.
async function setup() {
  let now = new Date("2026-03-02T09:00:00.000Z");
  const rungs = createRungs({
    store: memoryStore(),
    clock: () => now,
    ids: (() => {
      let n = 0;
      return () => `r${++n}`; // predictable ids
    })(),
    events: "discard",
  });
  await rungs.flows.register(expenseFlow);
  return { rungs, advance: (hours: number) => (now = new Date(+now + hours * 3_600_000)) };
}

// Inside your test runner's it(...):
const { rungs, advance } = await setup();
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 10 },
});
advance(49);
await rungs.tick();
const { tasks } = await rungs.inbox({ userId: "u_dir" });
assert.deepEqual(
  tasks.map((t) => t.requestId),
  [request.id],
);
// #endregion test

export const passed = true;
