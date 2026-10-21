import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "../../components/ui";
import { getDemo } from "../../rungs/demo";
import { listExpenses } from "../../rungs/expenses";
import { formatMoney, relative } from "../format";
import { requireUser } from "../session";

export const metadata: Metadata = { title: "My expenses" };

export default async function ExpensesPage() {
  const user = await requireUser();
  const { db, clock } = await getDemo();
  // The app's own table: Rungs stores approvals, not the list of a person's expenses.
  const expenses = await listExpenses(db, { requesterId: user.id });
  const now = clock.now();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My expenses</h1>
          <p className="lede">Everything you submitted, newest first.</p>
        </div>
        <Link href="/expenses/new" className="button primary">
          New expense
        </Link>
      </div>
      {expenses.length === 0 ? (
        <div className="card empty">
          <p>You have not submitted anything yet.</p>
        </div>
      ) : (
        <ul className="list">
          {expenses.map((e) => (
            <li key={e.id}>
              <Link href={`/requests/${e.requestId}`} className="row">
                <div>
                  <div className="row-title">{e.title}</div>
                  <div className="row-meta">
                    <span>{e.category}</span>
                    <span>Submitted {relative(e.submittedAt, now)}</span>
                  </div>
                </div>
                <div className="row-side">
                  <span className="amount">{formatMoney(e.amount)}</span>
                  <StatusBadge status={e.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
