import type { Metadata } from "next";
import { ActionForm, SubmitButton } from "../../components/ActionForm";
import { Badge } from "../../components/ui";
import { getDemo } from "../../rungs/demo";
import { nameOf, people } from "../../rungs/directory";
import { endAwayAction, setAwayAction } from "../actions";
import { formatDate } from "../format";
import { requireUser } from "../session";

export const metadata: Metadata = { title: "Out of office" };

const day = (d: Date) => d.toISOString().slice(0, 10);

export default async function AwayPage() {
  const user = await requireUser();
  const { rungs, clock } = await getDemo();
  const now = clock.now();
  const rules = await rungs.delegations.list({ userId: user.id });
  const mine = rules.filter((r) => r.fromUserId === user.id);
  const coveringFor = rules.filter((r) => r.toUserId === user.id);
  const inAWeek = new Date(now.getTime() + 6 * 86_400_000);

  const state = (r: (typeof rules)[number]) => {
    if (r.cancelledAt !== undefined) return <Badge tone="idle">Cancelled</Badge>;
    if (r.endsAt <= now.toISOString()) return <Badge tone="idle">Ended</Badge>;
    if (r.startsAt > now.toISOString()) return <Badge tone="info">Planned</Badge>;
    return <Badge tone="ok">Active</Badge>;
  };
  const lastDay = (endsAt: string) =>
    formatDate(new Date(new Date(endsAt).getTime() - 1).toISOString());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Out of office</h1>
          <p className="lede">
            While you are away, new approval tasks go to the person covering for you. Tasks you
            already have stay with you, and you can still decide anything they hold for you.
          </p>
        </div>
      </div>
      <div className="grid-2">
        <section className="card" aria-labelledby="away-title">
          <h2 id="away-title">Plan time away</h2>
          <ActionForm action={setAwayAction} label="Plan time away">
            <div className="field">
              <label htmlFor="toUserId">Who covers for you</label>
              <select id="toUserId" name="toUserId" required defaultValue="">
                <option value="" disabled>
                  Choose a person
                </option>
                {people
                  .filter((p) => p.id !== user.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}, {p.title}
                    </option>
                  ))}
              </select>
            </div>
            <div className="inline-fields">
              <div className="field">
                <label htmlFor="from">First day</label>
                <input id="from" name="from" type="date" required defaultValue={day(now)} />
              </div>
              <div className="field">
                <label htmlFor="until">Last day</label>
                <input id="until" name="until" type="date" required defaultValue={day(inAWeek)} />
              </div>
            </div>
            <SubmitButton className="button primary">Save</SubmitButton>
          </ActionForm>
        </section>

        <div className="stack">
          <section className="card" aria-labelledby="rules-title">
            <h2 id="rules-title">Your plans</h2>
            {mine.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul className="list">
                {mine.map((r) => (
                  <li key={r.id} className="row">
                    <div>
                      <div className="row-title">{nameOf(r.toUserId)} covers</div>
                      <div className="row-meta">
                        {formatDate(r.startsAt)} – {lastDay(r.endsAt)}
                      </div>
                    </div>
                    <div className="row-side">
                      {state(r)}
                      {r.cancelledAt === undefined && r.endsAt > now.toISOString() && (
                        <form action={endAwayAction.bind(null, r.id)}>
                          <button type="submit" className="button">
                            {r.startsAt > now.toISOString() ? "Cancel" : "End now"}
                          </button>
                        </form>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {coveringFor.length > 0 && (
            <section className="card" aria-labelledby="covering-title">
              <h2 id="covering-title">You cover for</h2>
              <ul className="list">
                {coveringFor.map((r) => (
                  <li key={r.id} className="row">
                    <div>
                      <div className="row-title">{nameOf(r.fromUserId)}</div>
                      <div className="row-meta">
                        {formatDate(r.startsAt)} – {lastDay(r.endsAt)}
                      </div>
                    </div>
                    <div className="row-side">{state(r)}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
