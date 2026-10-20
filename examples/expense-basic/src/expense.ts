import { createRungs, type DomainEvent, type FlowInput, type Rungs } from "@rungs/core";
import { memoryStore } from "@rungs/store-memory";

/** Who reports to whom, and who holds which role. A real app reads this from its own database. */
const directory = {
  managers: { u_alice: "u_bob", u_bob: "u_carol" } as Record<string, string>,
  roles: { finance: ["u_fin1", "u_fin2"], director: ["u_dan"] } as Record<string, string[]>,
};

/** manager → finance (only above 1000, two-day deadline) → director. */
export const expenseFlow: FlowInput = {
  key: "expense",
  steps: [
    {
      id: "manager",
      name: "Direct manager",
      approvers: { type: "resolver", name: "directManager" },
    },
    {
      id: "finance",
      name: "Finance",
      approvers: { type: "role", role: "finance" },
      when: { field: "amount", op: "gt", value: 1000 },
      deadline: "P2D",
      remindBefore: "PT4H",
    },
    { id: "director", name: "Director", approvers: { type: "role", role: "director" } },
  ],
};

export interface ExpenseApp {
  readonly rungs: Rungs;
  /** Every domain event, as a notification service would receive it. */
  readonly notifications: DomainEvent[];
  /** Moves the fake clock. */
  setTime(iso: string): void;
}

export async function createExpenseApp(start: string): Promise<ExpenseApp> {
  let now = new Date(start);
  let next = 0;
  const notifications: DomainEvent[] = [];
  const rungs = createRungs({
    store: memoryStore(),
    clock: () => now,
    ids: () => `exp-${++next}`,
    roles: async (role) => directory.roles[role] ?? [],
    resolvers: {
      directManager: async ({ request }) => {
        const manager = directory.managers[request.requesterId];
        return manager ? [manager] : [];
      },
    },
    onEvent: (event) => {
      notifications.push(event);
    },
  });
  await rungs.flows.register(expenseFlow);
  return {
    rungs,
    notifications,
    setTime(iso) {
      now = new Date(iso);
    },
  };
}
