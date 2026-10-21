import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
});
await rungs.flows.register({
  key: "expense",
  steps: [
    { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
    {
      id: "finance",
      approvers: { type: "users", ids: ["u_fin"] },
      when: { field: "amount", op: "gt", value: 500 },
    },
  ],
});
// Stands in for your own table.
const expenses = new Map<string, { title: string; amount: number; receipts: string[] }>();
const db = {
  expenses: {
    insert: async (row: { id: string; title: string; amount: number; receipts: string[] }) => {
      expenses.set(row.id, row);
    },
    byIds: async (ids: string[]) => ids.map((id) => ({ id, ...expenses.get(id) })),
  },
};
const form = { id: "EXP-42", title: "Conference hotel", amount: 890, receipts: ["hotel.pdf"] };

// #region link
// Your record, in your table.
await db.expenses.insert(form);

// Its approval, in Rungs: linked by the subject, with only what the conditions read.
await rungs.submit({
  flow: "expense",
  requesterId: "u_ana",
  subject: { type: "expense", id: form.id },
  payload: { amount: form.amount },
});
// #endregion link

// #region list
// "My expenses": approval status from Rungs, details from your table, one query each.
const page = await rungs.requests({ requesterId: "u_ana", limit: 20 });
const rows = await db.expenses.byIds(page.requests.map((r) => r.subject.id));

// #endregion list

export { page, rows };
