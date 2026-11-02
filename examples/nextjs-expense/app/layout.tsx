import type { Metadata, Viewport } from "next";
import Image from "next/image";
import Link from "next/link";
import { ClockBar } from "../components/ClockBar";
import { type NavItem, NavLinks } from "../components/NavLinks";
import { Avatar } from "../components/ui";
import { hasRole } from "../rungs/directory";
import { signOutAction } from "./actions";
import { currentDemo, currentUser, isApprover } from "./session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Rungs expense demo", template: "%s · Rungs expense demo" },
  description: "Expense approvals with Rungs, an approval workflow engine for TypeScript.",
};

export const viewport: Viewport = { themeColor: "#0e1422" };

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The sign-in page needs no database, so a first visit does not wake one up.
  const cookieUser = await currentUser();
  const demo = cookieUser === undefined ? null : await currentDemo();
  const user = demo === null ? undefined : cookieUser;
  let items: NavItem[] = [];
  if (user !== undefined && demo !== null) {
    const inbox = isApprover(user) ? await demo.rungs.inbox({ userId: user.id, limit: 100 }) : null;
    items = [
      ...(inbox === null ? [] : [{ href: "/inbox", label: "Inbox", count: inbox.tasks.length }]),
      { href: "/expenses", label: "My expenses" },
      { href: "/expenses/new", label: "New expense" },
      { href: "/away", label: "Out of office" },
      { href: "/notifications", label: "Notifications" },
      ...(hasRole(user.id, "admin") ? [{ href: "/admin", label: "Admin" }] : []),
    ];
  }

  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">
              <Image src="/rungs-icon.svg" alt="" width={32} height={32} priority />
              <span>
                Rungs <small>expense demo</small>
              </span>
            </Link>
            {user !== undefined && (
              <>
                <NavLinks items={items} />
                <div className="who">
                  <Avatar userId={user.id} />
                  <div className="who-text">
                    {user.name}
                    <span>{user.title}</span>
                  </div>
                  <form action={signOutAction}>
                    <button type="submit" className="button ghost">
                      Switch person
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        </header>
        {user !== undefined && demo !== null && <ClockBar now={demo.clock.now()} />}
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
