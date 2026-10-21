import type { PreviewResult } from "@rungsjs/core";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton } from "../../../components/ActionForm";
import { Avatar, Badge } from "../../../components/ui";
import { getDemo, newId } from "../../../rungs/demo";
import { nameOf } from "../../../rungs/directory";
import { describeError } from "../../../rungs/errors";
import { categories, expenseFlow } from "../../../rungs/flow";
import { submitAction } from "../../actions";
import { formatMoney } from "../../format";
import { requireUser } from "../../session";

export const metadata: Metadata = { title: "New expense" };

type Search = Promise<{ title?: string; category?: string; amount?: string }>;

export default async function NewExpensePage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser();
  const query = await searchParams;
  const title = query.title?.trim() ?? "";
  const category = query.category ?? "";
  const amount = Number(query.amount);
  const reviewing = title !== "" && Number.isFinite(amount) && amount > 0;
  const expenseId = newId("exp"); // one per rendered form: the submit's idempotency key

  let preview: PreviewResult | null = null;
  let previewError: string | null = null;
  if (reviewing) {
    // Who would approve if this were submitted now. Nothing is stored.
    const { rungs } = await getDemo();
    try {
      preview = await rungs.preview({
        flow: expenseFlow.key,
        requesterId: user.id,
        subject: { type: "expense", id: expenseId },
        payload: { amount }, // what the conditions read; the details stay in the app
      });
    } catch (error) {
      previewError = describeError(error);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New expense</h1>
          <p className="lede">
            Over $500 finance checks it after your manager; over $5,000 the director signs off.
          </p>
        </div>
      </div>
      <div className="grid-2">
        <form className="card" action="/expenses/new" method="get" aria-label="Expense details">
          <div className="field">
            <label htmlFor="title">What did you pay for?</label>
            <input
              id="title"
              name="title"
              type="text"
              required
              minLength={3}
              maxLength={80}
              defaultValue={title}
            />
          </div>
          <div className="inline-fields">
            <div className="field">
              <label htmlFor="category">Category</label>
              <select id="category" name="category" required defaultValue={category || "Travel"}>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="amount">Amount (USD)</label>
              <input
                id="amount"
                name="amount"
                type="number"
                required
                min="0.01"
                step="0.01"
                inputMode="decimal"
                defaultValue={reviewing ? String(amount) : ""}
              />
            </div>
          </div>
          <button type="submit" className="button">
            {reviewing ? "Update preview" : "Preview approvers"}
          </button>
        </form>

        <section className="card" aria-labelledby="preview-title">
          <h2 id="preview-title">Who will approve</h2>
          {!reviewing && (
            <p className="muted">
              Fill in the details to see the approval chain before you submit.
            </p>
          )}
          {previewError !== null && <p className="alert error">{previewError}</p>}
          {preview !== null && (
            <>
              <ol className="ladder">
                {preview.steps.map((step) => (
                  <li
                    key={step.stepId}
                    className={`rung ${step.status === "will-run" ? "active" : step.status === "cannot-run" ? "bad" : ""}`}
                  >
                    <div>
                      <div className="rung-title">{step.name ?? step.stepId}</div>
                      {step.status === "will-run" && (
                        <ul className="people">
                          {step.approvers.map((id) => (
                            <li key={id}>
                              <Avatar userId={id} small /> {nameOf(id)}
                            </li>
                          ))}
                          {step.delegations.map((d) => (
                            <li key={d.userId} className="muted small">
                              {nameOf(d.toUserId)} covers for {nameOf(d.userId)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {step.status === "cannot-run" && (
                        <p className="small muted">Nobody active can approve this step.</p>
                      )}
                    </div>
                    {step.status === "will-run" ? (
                      <Badge tone="info">
                        {step.approvers.length > 1 ? "Any one of" : "Approver"}
                      </Badge>
                    ) : step.status === "skipped" ? (
                      <Badge tone="idle">Not needed</Badge>
                    ) : (
                      <Badge tone="bad">Cannot run</Badge>
                    )}
                  </li>
                ))}
              </ol>
              <hr className="divider" />
              {preview.submittable ? (
                <ActionForm action={submitAction} label="Submit expense">
                  <input type="hidden" name="expenseId" value={expenseId} />
                  <input type="hidden" name="title" value={title} />
                  <input type="hidden" name="category" value={category} />
                  <input type="hidden" name="amount" value={String(amount)} />
                  <p>
                    <strong>{title}</strong> · {category} ·{" "}
                    <span className="amount">{formatMoney(amount)}</span>
                  </p>
                  <div className="actions">
                    <SubmitButton className="button primary">Submit expense</SubmitButton>
                    <Link href="/expenses" className="button">
                      Cancel
                    </Link>
                  </div>
                </ActionForm>
              ) : (
                <p className="alert error">
                  This expense cannot be submitted now: a step has nobody who can approve it. An
                  administrator can reactivate people on the admin page.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
