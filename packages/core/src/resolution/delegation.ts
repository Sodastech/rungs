import type { DelegationRule, DelegationSkipReason } from "../model/delegation.js";
import type { StepInstance } from "../model/state.js";

export interface DelegationContext {
  readonly now: string;
  readonly flowKey: string;
  readonly tenantId?: string;
  readonly requesterId: string;
  readonly allowSelfApproval: boolean;
  readonly maxDepth: number;
  readonly rules: readonly DelegationRule[];
  readonly inactive: ReadonlySet<string>;
  /** Users who already hold a vote in the step; a delegation never merges votes (EC-48). */
  readonly holders: ReadonlySet<string>;
  /** Users who approved an earlier step of the request, by step id (EC-49). */
  readonly decided: ReadonlyMap<string, string>;
}

export type DelegationNote =
  | { type: "skipped"; userId: string; toUserId: string; reason: DelegationSkipReason }
  | { type: "cycle"; userId: string; chain: string[] };

export interface Delegated {
  /** Who gets the task. Equal to the start user when no hop was taken. */
  readonly assigneeId: string;
  /** Users from the start to the assignee, including skipped hops in between. */
  readonly chain: string[];
  readonly notes: DelegationNote[];
}

/**
 * Follows active out-of-office rules from `start` (EC-20), at most `maxDepth` hops (EC-21). A
 * cycle keeps the task with `start` (EC-22). A requester or inactive delegate is passed over and
 * the chain continues with their own rule (EC-23). A delegate who already holds a vote in the step
 * or approved an earlier step ends the chain at the last valid delegate (EC-48, EC-49).
 * Rules are evaluated once, when the task is created (EC-24).
 */
export function followDelegations(start: string, ctx: DelegationContext): Delegated {
  const path = [start];
  const notes: DelegationNote[] = [];
  let assigned = 0;
  let current = start;

  for (let hop = 0; hop < ctx.maxDepth; hop++) {
    const rule = activeRule(current, ctx);
    if (rule === undefined) break;
    const target = rule.toUserId;
    if (path.includes(target)) {
      notes.push({ type: "cycle", userId: start, chain: [...path, target] });
      return { assigneeId: start, chain: [start], notes };
    }
    path.push(target);

    const reason = skipReason(target, ctx);
    if (reason !== null) notes.push({ type: "skipped", userId: current, toUserId: target, reason });
    if (reason === "target-already-approver" || reason === "target-already-decided") break;
    if (reason === null) assigned = path.length - 1;
    current = target;
  }

  const chain = path.slice(0, assigned + 1);
  return { assigneeId: chain.at(-1) ?? start, chain, notes };
}

/** The users who approved earlier steps (carried-over votes included), mapped to that step id. */
export function decidedEarlier(previous: readonly StepInstance[]): Map<string, string> {
  const decided = new Map<string, string>();
  for (const instance of previous) {
    if (instance.invalidatedAt !== undefined) continue;
    for (const task of instance.tasks) {
      if (task.status !== "approved" && task.status !== "skipped-duplicate") continue;
      if (!decided.has(task.assigneeId)) decided.set(task.assigneeId, instance.stepId);
    }
  }
  return decided;
}

function skipReason(userId: string, ctx: DelegationContext): DelegationSkipReason | null {
  if (userId === ctx.requesterId && !ctx.allowSelfApproval) return "requester";
  if (ctx.inactive.has(userId)) return "inactive";
  if (ctx.holders.has(userId)) return "target-already-approver";
  if (ctx.decided.has(userId)) return "target-already-decided";
  return null;
}

/** The rule that applies to `userId` now; the most recently started one wins, then the lowest id. */
function activeRule(userId: string, ctx: DelegationContext): DelegationRule | undefined {
  const now = Date.parse(ctx.now);
  const active = ctx.rules.filter((rule) => {
    if (rule.fromUserId !== userId || rule.cancelledAt !== undefined) return false;
    if (!(Date.parse(rule.startsAt) <= now && now < Date.parse(rule.endsAt))) return false;
    if (rule.tenantId !== undefined && rule.tenantId !== ctx.tenantId) return false;
    const flowKeys = rule.scope?.flowKeys ?? [];
    return flowKeys.length === 0 || flowKeys.includes(ctx.flowKey);
  });
  active.sort(
    (a, b) =>
      Date.parse(b.startsAt) - Date.parse(a.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return active[0];
}
