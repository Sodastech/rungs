import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type Demo, getDemo, resetDemo, sharedDatabase } from "../rungs/demo";
import { hasRole, type Person, people, person } from "../rungs/directory";
import { admitSandbox, checkWrite } from "../rungs/limits";
import { isSandboxId, openSandbox, resetSandbox, sandboxExists } from "../rungs/sandbox";

// Demo sign-in: a cookie holding the chosen person's id. There is no password and no real
// authentication. Server code always takes the actor from here, never from form fields.
const COOKIE = "demo_user";

// The online demo (DEMO_PUBLIC=1) gives each visitor a sandbox. This cookie holds its random id,
// which is also what keeps other visitors out, so it is not readable from scripts.
const SANDBOX_COOKIE = "demo_sandbox";
const COOKIE_MAX_AGE = 48 * 3600;

export const isPublicDemo = () => process.env.DEMO_PUBLIC === "1";

const cookieOptions = () =>
  isPublicDemo()
    ? ({
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
        maxAge: COOKIE_MAX_AGE,
      } as const)
    : ({ httpOnly: true, sameSite: "lax", path: "/" } as const);

const sandboxCookie = async () => (await cookies()).get(SANDBOX_COOKIE)?.value;

/** This visitor's demo: their sandbox online, or the one shared demo locally. Once per render. */
export const currentDemo = cache(async (): Promise<Demo | null> => {
  if (!isPublicDemo()) return getDemo();
  const id = await sandboxCookie();
  return isSandboxId(id) ? openSandbox(await sharedDatabase(), id) : null;
});

/** A sandbox that has been cleaned up sends its visitor back to choose a person, and start anew. */
export async function requireDemo(): Promise<Demo> {
  const demo = await currentDemo();
  if (demo === null) redirect("/login");
  return demo;
}

export async function resetCurrentDemo(): Promise<void> {
  if (!isPublicDemo()) return resetDemo();
  const id = await sandboxCookie();
  if (isSandboxId(id)) await resetSandbox(await sharedDatabase(), id);
}

export async function currentUser(): Promise<Person | undefined> {
  const id = (await cookies()).get(COOKIE)?.value;
  return id === undefined ? undefined : person(id);
}

export async function requireUser(): Promise<Person> {
  const user = await currentUser();
  if (user === undefined) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<Person> {
  const user = await requireUser();
  // Rungs does not check who is an admin (docs/04-api-design.md); the app must.
  if (!hasRole(user.id, "admin")) redirect("/");
  return user;
}

/** Vercel sets these itself, so a visitor cannot choose their own address. */
async function visitorIp(): Promise<string> {
  const all = await headers();
  return all.get("x-real-ip") ?? all.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

/** Online, choosing a person is what creates the sandbox, so crawlers never cause one. */
async function ensureSandbox(): Promise<void> {
  if (!isPublicDemo()) return;
  const client = await sharedDatabase();
  const id = await sandboxCookie();
  if (isSandboxId(id) && (await sandboxExists(client, id))) return;
  (await cookies()).set(
    SANDBOX_COOKIE,
    await admitSandbox(client, await visitorIp()),
    cookieOptions(),
  );
}

/** Online, call before a write: throws `DemoLimitError` when this visitor is over a limit. */
export async function checkWriteLimit(options: { clock?: boolean } = {}): Promise<void> {
  if (!isPublicDemo()) return;
  const sandboxId = await sandboxCookie();
  if (!isSandboxId(sandboxId)) return;
  await checkWrite(await sharedDatabase(), { ip: await visitorIp(), sandboxId, ...options });
}

export async function signIn(userId: string): Promise<void> {
  if (person(userId) === undefined) throw new Error(`Unknown person: ${userId}`);
  await ensureSandbox();
  (await cookies()).set(COOKIE, userId, cookieOptions());
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export const isApprover = (user: Person) =>
  user.roles.length > 0 || people.some((p) => p.reportsTo === user.id);

/** Where each person starts: approvers at their inbox, the admin on the admin page. */
export function homeFor(user: Person): string {
  if (hasRole(user.id, "admin")) return "/admin";
  return isApprover(user) ? "/inbox" : "/expenses";
}
