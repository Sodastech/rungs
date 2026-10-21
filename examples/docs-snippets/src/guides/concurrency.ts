import { ConflictError, createRungs, InvalidCommandError } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
});
await rungs.flows.register({
  key: "expense",
  steps: [{ id: "review", approvers: { type: "users", ids: ["u_a", "u_b"] } }],
});

// #region idempotency
// A client that retries a timed-out POST sends the same key; the request is created once.
const input = {
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 50 },
  idempotencyKey: "form-7f3a",
};
const first = await rungs.submit(input);
const retry = await rungs.submit(input);
console.log(retry.id === first.id); // true

// The same key for a different command is refused, so a bug cannot hide behind it.
const misuse = await rungs
  .submit({ ...input, payload: { amount: 60 } })
  .catch((error: unknown) => error instanceof InvalidCommandError);
// #endregion idempotency

// #region expected-version
// Both approvers opened the request at the same version. The first decision wins;
// the second gets ConflictError instead of deciding something that already changed.
const seen = first.version;
await rungs.approve({ requestId: first.id, actorId: "u_a", expectedVersion: seen });
try {
  await rungs.reject({ requestId: first.id, actorId: "u_b", expectedVersion: seen });
} catch (error) {
  if (error instanceof ConflictError) {
    console.log("Someone decided first; showing the latest state.");
  }
}

// #endregion expected-version

export { misuse };
