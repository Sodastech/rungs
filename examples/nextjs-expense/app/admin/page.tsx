import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton } from "../../components/ActionForm";
import { Avatar, Badge, StatusBadge } from "../../components/ui";
import { getDemo } from "../../rungs/demo";
import { nameOf, people } from "../../rungs/directory";
import { expensesByIds } from "../../rungs/expenses";
import { stepName } from "../../rungs/flow";
import { reassignStepAction, retryStepAction, setActiveAction } from "../actions";
import { formatMoney, relative } from "../format";
import { requireAdmin } from "../session";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  await requireAdmin();
  const { db, rungs, clock, inactive } = await getDemo();
  const now = clock.now();
  // Two Rungs queries, then one query for the expenses behind them (joined by subject id).
  const { steps: blocked } = await rungs.blocked({ limit: 50 });
  const { requests: open } = await rungs.requests({ status: ["pending", "returned"], limit: 50 });
  const expenses = await expensesByIds(db, [
    ...blocked.map((s) => s.subject.id),
    ...open.map((r) => r.subject.id),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="lede">
            Unblock approvals that nobody can decide, and manage who is active.
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <section className="card" aria-labelledby="blocked-title">
            <h2 id="blocked-title">
              Blocked steps {blocked.length > 0 && <Badge tone="warn">{blocked.length}</Badge>}
            </h2>
            {blocked.length === 0 ? (
              <p className="muted">
                Nothing is blocked. Try it: mark both finance officers inactive, then let Marco
                approve an expense above $500.
              </p>
            ) : (
              <ul className="list">
                {blocked.map((step) => (
                  <li key={step.requestId} className="card flat">
                    <p className="row-title">
                      <Link href={`/requests/${step.requestId}`}>
                        {expenses.get(step.subject.id)?.title ?? step.subject.id}
                      </Link>{" "}
                      ·{" "}
                      <span className="amount">
                        {formatMoney(expenses.get(step.subject.id)?.amount ?? 0)}
                      </span>
                    </p>
                    <p className="muted small">
                      {stepName(step.stepId)} step, blocked {relative(step.blockedAt, now)}.{" "}
                      {step.removed.length > 0 &&
                        `Removed: ${step.removed
                          .map((r) => `${nameOf(r.userId)} (${r.reason})`)
                          .join(", ")}.`}
                    </p>
                    <ActionForm
                      action={retryStepAction.bind(null, step.requestId, step.stepId, step.version)}
                      label="Retry"
                    >
                      <p className="small muted">
                        Fixed the cause (for example, reactivated someone)? Resolve the approvers
                        again:
                      </p>
                      <SubmitButton>Retry step</SubmitButton>
                    </ActionForm>
                    <hr className="divider" />
                    <ActionForm
                      action={reassignStepAction.bind(
                        null,
                        step.requestId,
                        step.stepId,
                        step.version,
                      )}
                      label="Reassign step"
                    >
                      <fieldset className="field">
                        <legend>Or give the step to</legend>
                        <div className="checks">
                          {people
                            .filter((p) => p.id !== step.requesterId && !inactive.has(p.id))
                            .map((p) => (
                              <label key={p.id}>
                                <input type="checkbox" name="toUserIds" value={p.id} /> {p.name}
                                <span className="muted small">{p.title}</span>
                              </label>
                            ))}
                        </div>
                      </fieldset>
                      <div className="field">
                        <label htmlFor={`why-${step.requestId}`}>Reason</label>
                        <input
                          id={`why-${step.requestId}`}
                          name="comment"
                          type="text"
                          required
                          placeholder="Finance team is away this week"
                        />
                      </div>
                      <SubmitButton className="button primary">Reassign</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="open-title">
            <h2 id="open-title">Open expenses</h2>
            {open.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Expense</th>
                    <th scope="col">Requester</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((request) => (
                    <tr key={request.id}>
                      <td>
                        <Link href={`/requests/${request.id}`}>
                          {expenses.get(request.subject.id)?.title ?? request.subject.id}
                        </Link>
                      </td>
                      <td>{nameOf(request.requesterId)}</td>
                      <td className="amount">
                        {formatMoney(expenses.get(request.subject.id)?.amount ?? 0)}
                      </td>
                      <td>
                        <StatusBadge status={request.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <section className="card" aria-labelledby="people-title">
          <h2 id="people-title">People</h2>
          <p className="muted small">
            Rungs skips inactive people when it picks approvers. It does not stop them deciding
            tasks they already have: blocking sign-in is the app's job.
          </p>
          <ul className="list">
            {people.map((p) => {
              const active = !inactive.has(p.id);
              return (
                <li key={p.id} className="row">
                  <div className="inline-person">
                    <Avatar userId={p.id} small />
                    <div>
                      <div className="row-title">{p.name}</div>
                      <div className="row-meta">{p.title}</div>
                    </div>
                  </div>
                  <div className="row-side across">
                    <Badge tone={active ? "ok" : "idle"}>{active ? "Active" : "Inactive"}</Badge>
                    <form action={setActiveAction.bind(null, p.id, !active)}>
                      <button
                        type="submit"
                        className="button"
                        aria-label={`${active ? "Deactivate" : "Activate"} ${p.name}`}
                      >
                        {active ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}
