import { defineFlow, FlowDefinitionError, type FlowIssue } from "@rungsjs/core";

// #region define-flow
const purchase = defineFlow({
  key: "purchase",
  steps: [
    // One person: the requester's manager, found by a resolver you write.
    { id: "manager", approvers: { type: "resolver", name: "directManager" } },
    // Any two of the committee must approve.
    { id: "committee", approvers: { type: "role", role: "committee" }, mode: { quorum: 2 } },
    // Only for contracts.
    {
      id: "legal",
      approvers: { type: "users", ids: ["u_legal"] },
      when: { field: "category", op: "eq", value: "contract" },
    },
    // Every board member, only from 50,000.
    {
      id: "board",
      approvers: { type: "role", role: "board" },
      mode: "all",
      when: { field: "amount", op: "gte", value: 50_000 },
    },
  ],
});
// #endregion define-flow

let issues: readonly FlowIssue[] = [];

// #region invalid-flow
try {
  defineFlow({
    key: "broken",
    steps: [{ id: "a", approvers: { type: "users", ids: [] }, deadline: "P1M" }],
  });
} catch (error) {
  if (error instanceof FlowDefinitionError) {
    console.log(error.issues); // every problem, each with its path: steps[0].deadline, ...
    issues = error.issues;
  }
}

// #endregion invalid-flow

export { issues, purchase };
