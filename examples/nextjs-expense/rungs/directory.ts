import type { ResolutionHooks } from "@rungsjs/core";
import type { PgClient } from "@rungsjs/store-postgres";
import { SCHEMA } from "./db";

export type Role = "finance" | "director" | "admin";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly roles: readonly Role[];
  /** Whose approval this person's expenses need first. */
  readonly reportsTo?: string;
}

/** A fictional company. A real app would read this from its own user tables. */
export const people: readonly Person[] = [
  { id: "alice", name: "Alice Moreau", title: "Software engineer", roles: [], reportsTo: "marco" },
  { id: "marco", name: "Marco Rossi", title: "Engineering manager", roles: [], reportsTo: "diego" },
  { id: "fatima", name: "Fatima Khan", title: "Finance officer", roles: ["finance"] },
  { id: "kenji", name: "Kenji Sato", title: "Finance officer", roles: ["finance"] },
  { id: "diego", name: "Diego Alvarez", title: "Director", roles: ["director"] },
  { id: "ada", name: "Ada Okafor", title: "Administrator", roles: ["admin"] },
];

export function person(id: string): Person | undefined {
  return people.find((p) => p.id === id);
}

export function nameOf(id: string | null | undefined): string {
  if (id === null || id === undefined) return "System";
  return person(id)?.name ?? id;
}

export function hasRole(id: string, role: Role): boolean {
  return person(id)?.roles.includes(role) ?? false;
}

/**
 * Who is marked inactive (on the admin page). Rungs calls `isActiveUser` while it resolves
 * approvers, inside the command's transaction, so the answer must be fast: it comes from memory,
 * and the table only makes it survive a restart.
 */
export async function loadInactiveUsers(db: PgClient): Promise<Set<string>> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM ${SCHEMA}.inactive_users`,
  );
  return new Set(rows.map((r) => r.user_id));
}

export async function setActive(
  db: PgClient,
  inactive: Set<string>,
  userId: string,
  active: boolean,
): Promise<void> {
  if (active) {
    await db.query(`DELETE FROM ${SCHEMA}.inactive_users WHERE user_id = $1`, [userId]);
    inactive.delete(userId);
  } else {
    await db.query(
      `INSERT INTO ${SCHEMA}.inactive_users (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [userId],
    );
    inactive.add(userId);
  }
}

/** How Rungs finds approvers in this app: roles, one resolver, and who is active. */
export function resolutionHooks(inactive: ReadonlySet<string>): ResolutionHooks {
  return {
    roles: (role) => people.filter((p) => p.roles.includes(role as Role)).map((p) => p.id),
    resolvers: {
      // The requester's manager, from a fixed table.
      reportsTo: ({ request }) => {
        const manager = person(request.requesterId)?.reportsTo;
        return manager === undefined ? [] : [manager];
      },
    },
    isActiveUser: (userId) => !inactive.has(userId),
  };
}
