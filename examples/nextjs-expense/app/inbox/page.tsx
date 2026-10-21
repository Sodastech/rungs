import type { Metadata } from "next";
import Link from "next/link";
import { Avatar, Badge } from "../../components/ui";
import { getDemo } from "../../rungs/demo";
import { nameOf } from "../../rungs/directory";
import { expensesByIds } from "../../rungs/expenses";
import { stepName } from "../../rungs/flow";
import { formatMoney, relative } from "../format";
import { requireUser } from "../session";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage() {
  const user = await requireUser();
  const { db, rungs, clock } = await getDemo();
  const now = clock.now();
  // Tasks the user can decide: their own, ones they hold for someone on leave, and their own
  // tasks a delegate holds while they were away (EC-60).
  const { tasks } = await rungs.inbox({ userId: user.id, limit: 100 });
  // The expenses behind these tasks, in one query, joined by the request subject.
  const expenses = await expensesByIds(
    db,
    tasks.map((t) => t.subject.id),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="lede">Expenses waiting for your decision, oldest first.</p>
        </div>
      </div>
      {tasks.length === 0 ? (
        <div className="card empty">
          <p>Nothing waits for you. Switch person or submit an expense to see it arrive here.</p>
        </div>
      ) : (
        <ul className="list">
          {tasks.map((task) => {
            const expense = expenses.get(task.subject.id);
            return (
              <li key={task.taskId}>
                <Link href={`/requests/${task.requestId}`} className="row">
                  <div>
                    <div className="row-title">{expense?.title ?? task.subject.id}</div>
                    <div className="row-meta">
                      <span className="inline-person">
                        <Avatar userId={task.requesterId} small /> {nameOf(task.requesterId)}
                      </span>
                      <span>{stepName(task.stepId)} step</span>
                      <span>Assigned {relative(task.assignedAt, now)}</span>
                      {task.onBehalfOf !== undefined && (
                        <span>Covering for {nameOf(task.onBehalfOf)}</span>
                      )}
                      {task.heldBy !== undefined && (
                        <span>Held by {nameOf(task.heldBy)} while you were away</span>
                      )}
                    </div>
                  </div>
                  <div className="row-side">
                    <span className="amount">{formatMoney(expense?.amount ?? 0)}</span>
                    {task.overdue ? (
                      <Badge tone="bad">Overdue</Badge>
                    ) : task.deadlineAt !== undefined ? (
                      <Badge tone="warn">Due {relative(task.deadlineAt, now)}</Badge>
                    ) : (
                      <Badge tone="idle">No deadline</Badge>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
