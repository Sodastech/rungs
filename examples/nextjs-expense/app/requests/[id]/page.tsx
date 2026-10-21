import type { PreviewResult } from "@rungsjs/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "../../../components/ActionForm";
import { Ladder } from "../../../components/Ladder";
import { Timeline } from "../../../components/Timeline";
import { Avatar, StatusBadge } from "../../../components/ui";
import { getDemo } from "../../../rungs/demo";
import { hasRole, nameOf, people } from "../../../rungs/directory";
import { categories, type ExpensePayload, expenseFlow } from "../../../rungs/flow";
import {
  decideAction,
  delegateAction,
  overrideAction,
  resubmitAction,
  withdrawAction,
} from "../../actions";
import { formatDateTime, formatMoney } from "../../format";
import { requireUser } from "../../session";

export const metadata: Metadata = { title: "Expense" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const { rungs, clock } = await getDemo();
  const request = await rungs.get(id);
  if (request === null) notFound();
  const history = await rungs.history(id);
  const payload = request.payload as unknown as ExpensePayload;
  const open = request.status === "pending" || request.status === "returned";

  // Steps that have not started yet: ask Rungs who they would go to now.
  let preview: PreviewResult | null = null;
  if (open) {
    preview = await rungs
      .preview({
        flow: expenseFlow.key,
        requesterId: request.requesterId,
        subject: request.subject,
        payload: request.payload,
      })
      .catch(() => null);
  }

  // The task this person can decide: their own, or one a delegate holds for them (EC-60).
  const active = request.steps.findLast(
    (s) => (s.status === "active" || s.status === "blocked") && s.invalidatedAt === undefined,
  );
  const myTask =
    active?.status === "active"
      ? active.tasks.find(
          (t) => t.status === "pending" && (t.assigneeId === user.id || t.onBehalfOf === user.id),
        )
      : undefined;
  const isRequester = request.requesterId === user.id;
  const isAdmin = hasRole(user.id, "admin");
  const v = request.version; // sent back with every command: a stale page gets ConflictError

  return (
    <>
      <p className="small">
        <Link href={isRequester ? "/expenses" : "/inbox"}>← Back</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{payload.title}</h1>
          <p className="lede">
            {payload.category} · submitted {formatDateTime(request.submittedAt)}
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      <div className="detail">
        <div className="stack detail-main">
          <section className="card" aria-label="Summary">
            <dl className="facts">
              <div>
                <dt>Amount</dt>
                <dd className="amount">{formatMoney(payload.amount)}</dd>
              </div>
              <div>
                <dt>Requester</dt>
                <dd className="inline-person">
                  <Avatar userId={request.requesterId} small /> {nameOf(request.requesterId)}
                </dd>
              </div>
              <div>
                <dt>Request</dt>
                <dd>
                  <code>{request.id}</code>
                </dd>
              </div>
            </dl>
          </section>

          {myTask !== undefined && (
            <section className="card" aria-labelledby="decide-title">
              <h2 id="decide-title">Your decision</h2>
              {myTask.onBehalfOf !== undefined && myTask.assigneeId === user.id && (
                <p className="muted small">You are covering for {nameOf(myTask.onBehalfOf)}.</p>
              )}
              {myTask.onBehalfOf === user.id && (
                <p className="muted small">
                  {nameOf(myTask.assigneeId)} holds this while you were away. You can still decide
                  it yourself.
                </p>
              )}
              <ActionForm action={decideAction.bind(null, request.id, v)} label="Decide">
                <div className="field">
                  <label htmlFor="comment">Comment</label>
                  <textarea id="comment" name="comment" maxLength={500} />
                  <p className="hint">Optional. It is kept in the audit trail.</p>
                </div>
                <div className="actions">
                  <SubmitButton className="button approve" name="decision" value="approve">
                    Approve
                  </SubmitButton>
                  <SubmitButton className="button reject" name="decision" value="reject">
                    Reject
                  </SubmitButton>
                  <SubmitButton name="decision" value="return">
                    Return for changes
                  </SubmitButton>
                </div>
              </ActionForm>
              {myTask.assigneeId === user.id && (
                <>
                  <hr className="divider" />
                  <ActionForm
                    action={delegateAction.bind(null, request.id, myTask.id, v)}
                    label="Hand over"
                  >
                    <div className="field">
                      <label htmlFor="toUserId">Hand over to</label>
                      <select id="toUserId" name="toUserId" required defaultValue="">
                        <option value="" disabled>
                          Choose a person
                        </option>
                        {people
                          .filter((p) => p.id !== user.id && p.id !== request.requesterId)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}, {p.title}
                            </option>
                          ))}
                      </select>
                      <p className="hint">They decide instead of you; your vote moves with it.</p>
                    </div>
                    <SubmitButton>Hand over</SubmitButton>
                  </ActionForm>
                </>
              )}
            </section>
          )}

          {isRequester && request.status === "returned" && (
            <section className="card" aria-labelledby="resubmit-title">
              <h2 id="resubmit-title">Make changes and resubmit</h2>
              <ActionForm action={resubmitAction.bind(null, request.id, v)} label="Resubmit">
                <div className="field">
                  <label htmlFor="r-title">Title</label>
                  <input
                    id="r-title"
                    name="title"
                    type="text"
                    required
                    defaultValue={payload.title}
                  />
                </div>
                <div className="inline-fields">
                  <div className="field">
                    <label htmlFor="r-category">Category</label>
                    <select id="r-category" name="category" defaultValue={payload.category}>
                      {categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="r-amount">Amount (USD)</label>
                    <input
                      id="r-amount"
                      name="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      defaultValue={payload.amount}
                    />
                  </div>
                </div>
                <SubmitButton className="button primary">Resubmit</SubmitButton>
              </ActionForm>
            </section>
          )}

          {isRequester && open && (
            <section className="card" aria-labelledby="withdraw-title">
              <h2 id="withdraw-title">Withdraw</h2>
              <ActionForm action={withdrawAction.bind(null, request.id, v)} label="Withdraw">
                <p className="muted small">Stops the approval. This cannot be undone.</p>
                <SubmitButton className="button reject">Withdraw expense</SubmitButton>
              </ActionForm>
            </section>
          )}

          {isAdmin && open && (
            <section className="card" aria-labelledby="override-title">
              <h2 id="override-title">Administrator override</h2>
              <ActionForm action={overrideAction.bind(null, request.id, v)} label="Override">
                <div className="field">
                  <label htmlFor="o-comment">Reason</label>
                  <textarea id="o-comment" name="comment" required maxLength={500} />
                  <p className="hint">Required. Closes the request and cancels open tasks.</p>
                </div>
                <div className="actions">
                  <SubmitButton className="button approve" name="decision" value="approve">
                    Approve now
                  </SubmitButton>
                  <SubmitButton className="button reject" name="decision" value="reject">
                    Reject now
                  </SubmitButton>
                </div>
              </ActionForm>
            </section>
          )}
        </div>

        <section className="card detail-side" aria-labelledby="chain-title">
          <h2 id="chain-title">Approval chain</h2>
          <Ladder request={request} preview={preview} now={clock.now()} />
          {isAdmin && active?.status === "blocked" && (
            <p className="small">
              <Link href="/admin">Unblock it on the admin page →</Link>
            </p>
          )}
        </section>

        <section className="card detail-timeline" aria-labelledby="timeline-title">
          <h2 id="timeline-title">Timeline</h2>
          <Timeline events={history} />
        </section>
      </div>
    </>
  );
}
