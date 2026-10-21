import { defineFlow } from "@rungsjs/core";

/**
 * Every expense goes to the requester's manager. Above 500 finance checks it too (either
 * finance officer may decide), and above 5,000 the director signs off last.
 */
export const expenseFlow = defineFlow({
  key: "expense",
  steps: [
    {
      id: "manager",
      name: "Manager",
      approvers: { type: "resolver", name: "reportsTo" },
      deadline: "P2D",
      remindBefore: "P1D",
      onTimeout: "escalate",
      escalateTo: { type: "role", role: "director" },
    },
    {
      id: "finance",
      name: "Finance",
      approvers: { type: "role", role: "finance" },
      mode: "any",
      when: { field: "amount", op: "gt", value: 500 },
      deadline: "P3D",
      onTimeout: "remind",
    },
    {
      id: "director",
      name: "Director",
      approvers: { type: "role", role: "director" },
      when: { field: "amount", op: "gt", value: 5000 },
    },
  ],
});

/** What the requester fills in. It is the request payload, so step conditions can read it. */
export interface ExpensePayload {
  readonly title: string;
  readonly category: string;
  readonly amount: number;
}

export const categories = ["Travel", "Meals", "Equipment", "Software", "Training"] as const;

export function stepName(stepId: string): string {
  return expenseFlow.steps.find((s) => s.id === stepId)?.name ?? stepId;
}
