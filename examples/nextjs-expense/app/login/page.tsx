import type { Metadata } from "next";
import { Avatar } from "../../components/ui";
import { nameOf, people } from "../../rungs/directory";
import { signInAction } from "../actions";

export const metadata: Metadata = { title: "Choose a person" };

const roleNote: Record<string, string> = {
  alice: "Submits expenses. Reports to Marco.",
  marco: "Approves his team's expenses first.",
  fatima: "Checks expenses above $500.",
  kenji: "Checks expenses above $500.",
  diego: "Signs off above $5,000; escalations land here.",
  ada: "Unblocks stuck approvals; can override.",
};

export default function LoginPage() {
  return (
    <>
      <h1>Who are you today?</h1>
      <p className="lede">
        This demo has no passwords. Pick anyone to see Rungs from their side, and switch at any time
        to follow an expense through the approval chain.
      </p>
      <ul className="people-grid list">
        {people.map((p) => (
          <li key={p.id}>
            <form action={signInAction.bind(null, p.id)}>
              <button type="submit" className="person-card">
                <Avatar userId={p.id} />
                <span>
                  <strong>{nameOf(p.id)}</strong>
                  <span>{p.title}</span>
                  <span>{roleNote[p.id]}</span>
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
