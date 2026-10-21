import type { RequestStatus } from "@rungsjs/core";
import type { PgClient } from "@rungsjs/store-postgres";
import { SCHEMA } from "./db";

/**
 * The app's own record of an expense. Rungs keeps the approval (state, tasks, audit trail) and
 * points back here through the request subject `{ type: "expense", id }`; listing "my expenses"
 * or "everything open" is the app's job.
 */
export interface Expense {
  readonly id: string;
  readonly requestId: string;
  readonly requesterId: string;
  readonly title: string;
  readonly category: string;
  readonly amount: number;
  readonly status: RequestStatus;
  readonly submittedAt: string;
}

interface Row {
  id: string;
  request_id: string;
  requester_id: string;
  title: string;
  category: string;
  amount: string;
  status: RequestStatus;
  submitted_at: Date | string;
}

const toExpense = (r: Row): Expense => ({
  id: r.id,
  requestId: r.request_id,
  requesterId: r.requester_id,
  title: r.title,
  category: r.category,
  amount: Number(r.amount),
  status: r.status,
  submittedAt: new Date(r.submitted_at).toISOString(),
});

/** A repeated submit (same idempotency key) returns the same request: the insert is skipped. */
export async function insertExpense(db: PgClient, e: Expense): Promise<void> {
  await db.query(
    `INSERT INTO ${SCHEMA}.expenses
       (id, request_id, requester_id, title, category, amount, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING`,
    [e.id, e.requestId, e.requesterId, e.title, e.category, e.amount, e.status, e.submittedAt],
  );
}

export async function updateStatus(
  db: PgClient,
  requestId: string,
  status: RequestStatus,
): Promise<void> {
  await db.query(`UPDATE ${SCHEMA}.expenses SET status = $2 WHERE request_id = $1`, [
    requestId,
    status,
  ]);
}

export async function listExpenses(
  db: PgClient,
  filter: { requesterId?: string; open?: boolean } = {},
): Promise<Expense[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.requesterId !== undefined) {
    params.push(filter.requesterId);
    where.push(`requester_id = $${params.length}`);
  }
  if (filter.open === true) where.push(`status IN ('pending', 'returned')`);
  const { rows } = await db.query<Row>(
    `SELECT * FROM ${SCHEMA}.expenses
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY submitted_at DESC`,
    params,
  );
  return rows.map(toExpense);
}

export async function expenseByRequest(db: PgClient, requestId: string): Promise<Expense | null> {
  const { rows } = await db.query<Row>(`SELECT * FROM ${SCHEMA}.expenses WHERE request_id = $1`, [
    requestId,
  ]);
  return rows[0] === undefined ? null : toExpense(rows[0]);
}
