import type { StepResolution } from "../model/decision.js";
import type { DedupePolicy, StepMode } from "../model/flow.js";
import type { ApproverShortfall, RemovedApprover, StepInstance } from "../model/state.js";

export interface Eligible {
  /** Distinct approvers in resolution order. */
  readonly approvers: string[];
  readonly removed: RemovedApprover[];
}

/**
 * The pure part of resolution: merges duplicates (EC-44), removes inactive users (EC-06) and
 * then the requester unless self-approval is allowed (EC-01). Delegation is added in 1.5.
 */
export function eligibleApprovers(
  resolution: StepResolution,
  requesterId: string,
  allowSelfApproval: boolean,
): Eligible {
  const inactive = new Set(resolution.inactiveUserIds ?? []);
  const approvers: string[] = [];
  const removed: RemovedApprover[] = [];
  for (const userId of new Set(resolution.userIds)) {
    if (inactive.has(userId)) removed.push({ userId, reason: "inactive" });
    else if (userId === requesterId && !allowSelfApproval) {
      removed.push({ userId, reason: "requester" });
    } else approvers.push(userId);
  }
  return { approvers, removed };
}

/** Number of approvals a step needs before it is approved. */
export function requiredApprovals(mode: StepMode, approvers: number): number {
  if (mode === "any") return 1;
  if (mode === "all") return approvers;
  return mode.quorum;
}

/** Why `count` approvers cannot carry the step, or null when they can (EC-02, EC-45). */
export function shortfall(mode: StepMode, count: number): ApproverShortfall | null {
  if (count === 0) return { type: "no-approvers" };
  const required = requiredApprovals(mode, count);
  return required > count ? { type: "quorum-unreachable", required, available: count } : null;
}

/**
 * Task ids of earlier approvals that carry over to a new activation (EC-03), keyed by user.
 * `consecutive` looks at the latest step that ran (skipped steps do not count); `all` looks at
 * every approved step. Only real decisions carry over: superseded approvers decided nothing.
 */
export function carriedApprovals(
  previous: readonly StepInstance[],
  policy: DedupePolicy,
): Map<string, string> {
  const carried = new Map<string, string>();
  if (policy === "none") return carried;
  const ran = previous.filter((instance) => instance.status !== "skipped");
  const sources = (policy === "consecutive" ? ran.slice(-1) : ran).filter(
    (instance) => instance.status === "approved",
  );
  for (const instance of sources) {
    for (const task of instance.tasks) {
      if (task.status !== "approved" && task.status !== "skipped-duplicate") continue;
      if (!carried.has(task.assigneeId)) carried.set(task.assigneeId, task.id);
    }
  }
  return carried;
}
