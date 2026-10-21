import { type Condition, ConditionError, createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

// #region conditions
// Plain JSON, evaluated against the payload; no code runs.
const bigOrForeign: Condition = {
  any: [
    { field: "amount", op: "gt", value: 10_000 },
    { field: "vendor.country", op: "nin", value: ["NL", "BE", "DE"] },
  ],
};
const notInternal: Condition = { not: { field: "internal", op: "eq", value: true } };
// #endregion conditions

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
});
await rungs.flows.register({
  key: "purchase",
  steps: [
    { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
    {
      id: "procurement",
      approvers: { type: "users", ids: ["u_proc"] },
      when: { all: [bigOrForeign, notInternal] },
    },
  ],
});

let refused: ConditionError | undefined;

// #region condition-error
try {
  await rungs.submit({
    flow: "purchase",
    requesterId: "u_req",
    subject: { type: "purchase", id: "PO-9" },
    payload: { amount: "12000", vendor: { country: "US" }, internal: false }, // amount is a string
  });
} catch (error) {
  if (error instanceof ConditionError) {
    // Refused at submit, so an approver never meets a broken condition later (EC-40, EC-41).
    console.log(error.field, error.expected, error.received); // "amount" "number" "string"
    refused = error;
  }
}

// #endregion condition-error

export { refused };
