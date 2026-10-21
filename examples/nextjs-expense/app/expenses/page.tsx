import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "../../components/ui";
import { getDemo } from "../../rungs/demo";
import { expensesByIds } from "../../rungs/expenses";
import { formatMoney, relative } from "../format";
import { requireUser } from "../session";

export const metadata: Metadata = { title: "My expenses" };

type Search = Promise<{ after?: string }>;

export default async function ExpensesPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const { after } = await searchParams;
  const { db, rungs, clock } = await getDemo();
  // #region list
  // The approval status comes from Rungs, newest first; the details from the app's own table.
  const page = await rungs.requests({
    requesterId: user.id,
    limit: 20,
    ...(after === undefined ? {} : { after }),
  });
  const expenses = await expensesByIds(
    db,
    page.requests.map((r) => r.subject.id),
  );
  // #endregion list
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
      {page.requests.length === 0 ? (
        <div className="card empty">
          <p>
            {after === undefined ? "You have not submitted anything yet." : "No older expenses."}
          </p>
        </div>
      ) : (
        <ul className="list">
          {page.requests.map((request) => {
            const expense = expenses.get(request.subject.id);
            return (
              <li key={request.id}>
                <Link href={`/requests/${request.id}`} className="row">
                  <div>
                    <div className="row-title">{expense?.title ?? request.subject.id}</div>
                    <div className="row-meta">
                      <span>{expense?.category}</span>
                      <span>Submitted {relative(request.submittedAt, now)}</span>
                    </div>
                  </div>
                  <div className="row-side">
                    <span className="amount">{formatMoney(expense?.amount ?? 0)}</span>
                    <StatusBadge status={request.status} />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {page.next !== undefined && (
        <p className="pager">
          <Link href={`/expenses?after=${encodeURIComponent(page.next)}`} className="button">
            Older expenses
          </Link>
        </p>
      )}
    </>
  );
}
