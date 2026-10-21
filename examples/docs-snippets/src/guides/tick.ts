import { createRungs, type Rungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

// #region worker
// One loop in a worker process: apply what is due, then deliver events. Several workers may run
// at once; with the PostgreSQL store they claim different requests (EC-27).
export function startWorker(rungs: Rungs, everyMs = 60_000): () => void {
  let running = false;
  const run = async () => {
    if (running) return; // never overlap with a slow previous run
    running = true;
    try {
      const { failed } = await rungs.tick({ limit: 500 });
      for (const { requestId, error } of failed) console.error("tick failed", requestId, error);
      await rungs.dispatchPending({ limit: 500 });
    } catch (error) {
      console.error("worker run failed", error); // the next run tries again
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, everyMs);
  void run();
  return () => clearInterval(timer);
}
// #endregion worker

let now = new Date("2026-03-02T09:00:00.000Z");
const rungs = createRungs({
  store: memoryStore(),
  clock: () => now,
  ids: () => crypto.randomUUID(),
  onEvent: () => undefined,
});
await rungs.flows.register({
  key: "expense",
  steps: [
    {
      id: "manager",
      approvers: { type: "users", ids: ["u_mgr"] },
      deadline: "P1D",
      onTimeout: "auto-reject",
    },
  ],
});
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 10 },
});
now = new Date("2026-03-03T10:00:00.000Z");

export { request, rungs };
