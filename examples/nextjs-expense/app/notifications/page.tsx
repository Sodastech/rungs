import type { Metadata } from "next";
import Link from "next/link";
import { getDemo } from "../../rungs/demo";
import { notificationsFor } from "../../rungs/notifications";
import { relative } from "../format";
import { requireUser } from "../session";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const user = await requireUser();
  const { db, clock } = await getDemo();
  const now = clock.now();
  // Written by the onEvent handler (rungs/notifications.ts). A real app would send email here.
  const items = await notificationsFor(db, user.id);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="lede">What Rungs told this app about your expenses and tasks.</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="card empty">
          <p>No notifications yet.</p>
        </div>
      ) : (
        <ul className="list">
          {items.map((n) => (
            <li key={`${n.requestId}-${n.at}-${n.message}`}>
              <Link href={`/requests/${n.requestId}`} className="row">
                <div>{n.message}</div>
                <div className="row-side muted small">{relative(n.at, now)}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
