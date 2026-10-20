import { evaluateCondition } from "../flow/condition.js";
import type { ResolutionNeed, StepResolution } from "../model/decision.js";
import { FlowNotApplicableError } from "../model/errors.js";
import type { StepDefinition } from "../model/flow.js";
import type {
  ApproverShortfall,
  RemovedApprover,
  SkipReason,
  StepInstance,
} from "../model/state.js";
import {
  carriedApprovals,
  eligibleApprovers,
  requiredApprovals,
  shortfall,
} from "../resolution/pipeline.js";
import { clone, type Draft, record } from "./draft.js";

/** What resolving a step leads to, before anything is recorded. */
export type StepPlan =
  | { kind: "activate"; approvers: string[]; removed: RemovedApprover[] }
  | { kind: "skip"; removed: RemovedApprover[] }
  | { kind: "block"; reason: ApproverShortfall; removed: RemovedApprover[] };

/**
 * Runs the pure resolution pipeline for one step. Too few approvers skips the step only when it is
 * empty and the flow uses `onEmptyStep: "skip"`; otherwise the step cannot run (EC-02, EC-45).
 */
export function planStep(draft: Draft, step: StepDefinition, resolution: StepResolution): StepPlan {
  const { flow } = draft.ctx;
  const { approvers, removed } = eligibleApprovers(
    resolution,
    draft.state.requesterId,
    flow.allowSelfApproval,
  );
  const reason = shortfall(step.mode, approvers.length);
  if (reason === null) return { kind: "activate", approvers, removed };
  if (reason.type === "no-approvers" && flow.onEmptyStep === "skip")
    return { kind: "skip", removed };
  return { kind: "block", reason, removed };
}

/**
 * Activates the first step from `fromIndex` that applies: steps whose condition is false (EC-38)
 * or that resolve to nobody under `onEmptyStep: "skip"` (EC-04) are skipped with a reason, and a
 * step that cannot run is blocked (EC-42). Returns a need when approvers have not been resolved
 * yet. Approves the request when no steps remain.
 */
export function advance(draft: Draft, fromIndex: number): ResolutionNeed | null {
  const { flow, resolutions } = draft.ctx;
  for (let index = fromIndex; index < flow.steps.length; index++) {
    const step = flow.steps[index] as StepDefinition;

    if (step.when !== undefined && !evaluateCondition(step.when, draft.state.payload)) {
      skip(draft, newInstance(step, index), { type: "condition-false", condition: step.when }, []);
      continue;
    }

    const resolution = resolutions?.[step.id];
    if (resolution === undefined) return { key: step.id, stepId: step.id, spec: step.approvers };

    const instance = newInstance(step, index);
    const plan = planStep(draft, step, resolution);
    if (plan.kind === "skip") {
      skip(draft, instance, { type: "no-approvers" }, plan.removed);
      continue;
    }
    if (plan.kind === "block") {
      block(draft, instance, plan.reason, plan.removed);
      return null;
    }
    if (!activate(draft, instance, plan.approvers, plan.removed)) return null;
  }

  completeApproved(draft);
  return null;
}

/** Continues after a step instance that is already part of the state, e.g. once unblocked. */
export function resume(
  draft: Draft,
  instance: StepInstance,
  plan: StepPlan,
): ResolutionNeed | null {
  if (plan.kind === "block") throw new Error("resume needs a step that can run");
  if (plan.kind === "skip") {
    skip(draft, instance, { type: "no-approvers" }, plan.removed);
    return advance(draft, instance.index + 1);
  }
  if (!activate(draft, instance, plan.approvers, plan.removed)) return null;
  return advance(draft, instance.index + 1);
}

/** The step currently waiting for decisions or for an admin, if any. */
export function openStep(draft: Draft): StepInstance | undefined {
  return draft.state.steps.findLast((s) => s.status === "active" || s.status === "blocked");
}

export function activeStep(draft: Draft): StepInstance | undefined {
  const instance = openStep(draft);
  return instance?.status === "active" ? instance : undefined;
}

/**
 * EC-12: in mode "any" the first decision, approve or reject, decides the step.
 * EC-13, EC-14: "all" and quorum steps are approved once enough approvals arrive and rejected as
 * soon as the remaining pending tasks can no longer reach the quorum. Carried-over approvals
 * (`skipped-duplicate`, EC-03) count as votes, but while the step has other approvers at least
 * one of them must approve (EC-47, separation of duties).
 */
export function stepOutcome(
  draft: Draft,
  instance: StepInstance,
  decision?: "approved" | "rejected",
): "approved" | "rejected" | "pending" {
  const mode = draft.ctx.flow.steps[instance.index]?.mode ?? "any";
  if (mode === "any" && decision !== undefined) return decision;

  const required = requiredApprovals(mode, instance.approvers.length);
  const approvals = instance.tasks.filter(
    (t) => t.status === "approved" || t.status === "skipped-duplicate",
  ).length;
  const pending = instance.tasks.filter((t) => t.status === "pending").length;
  const needsFresh = instance.tasks.some((t) => t.status !== "skipped-duplicate");
  const fresh = instance.tasks.filter((t) => t.status === "approved").length;
  if (approvals >= required && (!needsFresh || fresh > 0)) return "approved";
  if (decision === undefined) return "pending";
  if (approvals + pending < required || (needsFresh && fresh === 0 && pending === 0)) {
    return "rejected";
  }
  return "pending";
}

export function supersedeOpenTasks(draft: Draft, instance: StepInstance, byTaskId: string): void {
  for (const task of instance.tasks) {
    if (task.status !== "pending") continue;
    task.status = "superseded";
    task.decidedAt = draft.ctx.now;
    record(draft, "task.superseded", { taskId: task.id, stepId: instance.stepId, byTaskId });
  }
}

export function closeStep(
  draft: Draft,
  instance: StepInstance,
  outcome: "approved" | "rejected",
): void {
  instance.status = outcome;
  instance.closedAt = draft.ctx.now;
  record(draft, "step.completed", { stepId: instance.stepId, stepIndex: instance.index, outcome });
}

export function closeRejected(draft: Draft, stepId: string): void {
  const { state } = draft;
  state.status = "rejected";
  state.closedAt = draft.ctx.now;
  state.currentStepIndex = null;
  record(draft, "request.rejected", { reason: "step-rejected", stepId });
}

function newInstance(step: StepDefinition, index: number): StepInstance {
  return { stepId: step.id, index, status: "active", approvers: [], tasks: [] };
}

/** Adds the instance to the state when it is new; blocked instances are reused in place. */
function place(draft: Draft, instance: StepInstance): void {
  if (!draft.state.steps.includes(instance)) draft.state.steps.push(instance);
}

/**
 * Activates the step with its tasks. Approvers who already approved earlier get a
 * `skipped-duplicate` task that counts as their vote (EC-03). The step is approved at once only
 * when every approver is carried over; otherwise someone else must decide (EC-47).
 * Returns true when the step closed that way.
 */
function activate(
  draft: Draft,
  instance: StepInstance,
  approvers: string[],
  removed: RemovedApprover[],
): boolean {
  const { state, ctx } = draft;
  const earlier = state.steps.filter((s) => s !== instance);
  const carried = carriedApprovals(earlier, ctx.flow.dedupeApprovers);
  place(draft, instance);
  Object.assign(instance, { status: "active", activatedAt: ctx.now, approvers, tasks: [] });
  delete instance.blockReason;
  delete instance.removed;
  if (removed.length > 0) instance.removed = clone(removed);
  state.currentStepIndex = instance.index;
  record(draft, "step.activated", {
    stepId: instance.stepId,
    stepIndex: instance.index,
    approvers,
    ...removedData(removed),
  });

  for (const assigneeId of approvers) {
    state.lastTaskNumber += 1;
    const taskId = `${state.id}.t${state.lastTaskNumber}`;
    const ofTaskId = carried.get(assigneeId);
    if (ofTaskId === undefined) {
      instance.tasks.push({ id: taskId, assigneeId, status: "pending", assignedAt: ctx.now });
      record(draft, "task.assigned", { taskId, stepId: instance.stepId, assigneeId });
      continue;
    }
    instance.tasks.push({
      id: taskId,
      assigneeId,
      status: "skipped-duplicate",
      assignedAt: ctx.now,
      decidedAt: ctx.now,
    });
    record(draft, "task.deduplicated", { taskId, stepId: instance.stepId, assigneeId, ofTaskId });
  }

  if (!approvers.every((id) => carried.has(id))) return false;
  closeStep(draft, instance, "approved");
  return true;
}

function skip(
  draft: Draft,
  instance: StepInstance,
  reason: SkipReason,
  removed: RemovedApprover[],
): void {
  place(draft, instance);
  Object.assign(instance, {
    status: "skipped",
    skippedAt: draft.ctx.now,
    approvers: [],
    tasks: [],
  });
  instance.skipReason = clone(reason);
  delete instance.blockReason;
  delete instance.removed;
  if (removed.length > 0) instance.removed = clone(removed);
  record(draft, "step.skipped", {
    stepId: instance.stepId,
    stepIndex: instance.index,
    reason,
    ...removedData(removed),
  });
}

/** EC-42: the step waits for an admin to reassign, retry or override. The command still succeeds. */
function block(
  draft: Draft,
  instance: StepInstance,
  reason: ApproverShortfall,
  removed: RemovedApprover[],
): void {
  place(draft, instance);
  Object.assign(instance, { status: "blocked", blockedAt: draft.ctx.now });
  instance.blockReason = clone(reason);
  if (removed.length > 0) instance.removed = clone(removed);
  draft.state.currentStepIndex = instance.index;
  record(draft, "step.blocked", {
    stepId: instance.stepId,
    stepIndex: instance.index,
    reason,
    ...removedData(removed),
  });
}

export function removedData(removed: RemovedApprover[]): { removed?: RemovedApprover[] } {
  return removed.length > 0 ? { removed } : {};
}

/** EC-39: a request whose every step was skipped is approved, or refused with `onAllSkipped: "fail"`. */
function completeApproved(draft: Draft): void {
  const { state, ctx } = draft;
  const allSkipped = state.steps.every((instance) => instance.status === "skipped");
  if (allSkipped && ctx.flow.onAllSkipped === "fail") {
    throw new FlowNotApplicableError({
      flowKey: ctx.flow.key,
      skippedStepIds: state.steps.map((s) => s.stepId),
    });
  }

  state.status = "approved";
  state.closedAt = ctx.now;
  state.currentStepIndex = null;
  record(
    draft,
    "request.approved",
    allSkipped
      ? { reason: "all-steps-skipped", skippedStepIds: state.steps.map((s) => s.stepId) }
      : { reason: "steps-approved" },
  );
}
