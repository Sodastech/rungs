import type { PgClient } from "@rungsjs/store-postgres";
import { SCHEMA } from "./db";

/**
 * The app's own record of an expense: its business data. Rungs keeps the approval (status, tasks,
 * audit trail) and points back here through the request subject `{ type: "expense", id }`. Only
 * the amount is copied into the request payload, because the flow's conditions read it.
 */
export interface Expense {
  readonly id: string;
  readonly requesterId: string;
  readonly title: string;
  readonly category: string;
  readonly amount: number;
  readonly createdAt: string;
}

/** What the requester fills in on the form. */
export type ExpenseDetails = Pick<Expense, "title" | "category" | "amount">;

interface Row {
  id: string;
  requester_id: string;
  title: string;
  category: string;
  amount: string;
  created_at: Date | string;
}

const toExpense = (r: Row): Expense => ({
  id: r.id,
  requesterId: r.requester_id,
  title: r.title,
  category: r.category,
  amount: Number(r.amount),
  createdAt: new Date(r.created_at).toISOString(),
});

/** Inserts the record; inserting the same id again (a repeated submit) does nothing. */
export async function insertExpense(db: PgClient, e: Expense): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.expenses (id, requester_id, title, category, amount, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [e.id, e.requesterId, e.title, e.category, e.amount, e.createdAt],
  );
}

export async function updateExpense(
  db: PgClient,
  id: string,
  details: ExpenseDetails,
): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.expenses SET title = $2, category = $3, amount = $4 WHERE id = $1`,
    [id, details.title, details.category, details.amount],
  );
}

export async function deleteExpense(db: PgClient, id: string): Promise<void> {
  await db.query(`DELETE FROM ${SCHEMA}.expenses WHERE id = $1`, [id]);
}

/**
 * The records behind a page of Rungs results, in one query: pass the `subject.id` of each
 * request, task or blocked step, and join by id when rendering.
 */
export async function expensesByIds(
  db: PgClient,
  ids: readonly string[],
): Promise<Map<string, Expense>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<Row>(`SELECT * FROM ${SCHEMA}.expenses WHERE id = ANY($1)`, [
    [...new Set(ids)],
  ]);
  return new Map(rows.map((r) => [r.id, toExpense(r)]));
}

export async function expenseById(db: PgClient, id: string): Promise<Expense | null> {
  return (await expensesByIds(db, [id])).get(id) ?? null;
}
