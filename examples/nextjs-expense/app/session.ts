import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hasRole, type Person, people, person } from "../rungs/directory";

// Demo sign-in: a cookie holding the chosen person's id. There is no password and no real
// authentication. Server code always takes the actor from here, never from form fields.
const COOKIE = "demo_user";

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

export async function signIn(userId: string): Promise<void> {
  if (person(userId) === undefined) throw new Error(`Unknown person: ${userId}`);
  (await cookies()).set(COOKIE, userId, { httpOnly: true, sameSite: "lax", path: "/" });
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
