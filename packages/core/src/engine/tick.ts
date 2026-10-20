import type { TickCommand } from "../model/command.js";
import type { Decision, EngineContext, ResolutionNeed } from "../model/decision.js";
import type { StepDefinition } from "../model/flow.js";
import type { RequestState, StepDeadline, StepInstance } from "../model/state.js";
import { decidedEarlier, followDelegations } from "../resolution/delegation.js";
import { eligibleApprovers, requiredApprovals } from "../resolution/pipeline.js";
import { type Draft, finish, record, startDraft } from "./draft.js";
import {
  advance,
  assignTask,
  closeRejected,
  closeStep,
  delegationContext,
  openStep,
  removedData,
} from "./progress.js";
import { isDue, nextAfter, startDeadline } from "./timers.js";

/**
 * EC-26, EC-27: applies whatever is due at `ctx.now`, as a system action (`actorId: null`). Each
 * action is applied once; a tick that finds nothing due returns `unchanged`.
 */
export function tickRequest(
  state: RequestState,
  _command: TickCommand,
  ctx: EngineContext,
): Decision {
  if (state.status !== "pending" && state.status !== "returned") return { kind: "unchanged" };
  const draft = startDraft(state, null, ctx);
  const need = state.status === "returned" ? tickReturned(draft) : tickOpenStep(draft);
  if (need) return { kind: "needs-resolution", needs: [need] };
  return draft.audit.length === 0 ? { kind: "unchanged" } : finish(draft);
}

/** EC-52: the requester did not resubmit in time. */
function tickReturned(draft: Draft): null {
  const { state, ctx } = draft;
  const timer = state.resubmit;
  if (timer === undefined || timer.remindedAt !== undefined || !isDue(timer.dueAt, ctx.now)) {
    return null;
  }
  if (ctx.flow.onResubmitTimeout === "auto-withdraw") {
    delete state.resubmit;
    state.status = "withdrawn";
    state.closedAt = ctx.now;
    state.currentStepIndex = null;
    record(draft, "request.withdrawn", { reason: "resubmit-timeout" });
    return null;
  }
  timer.remindedAt = ctx.now;
  const stepId = state.steps.findLast((s) => s.status === "returned")?.stepId ?? "";
  record(draft, "request.resubmit_overdue", { stepId, dueAt: timer.dueAt });
  return null;
}

function tickOpenStep(draft: Draft): ResolutionNeed | null {
  const { ctx } = draft;
  const instance = openStep(draft);
  if (instance === undefined) return null;

  if (instance.status === "blocked") {
    const reminder = instance.blockedReminder;
    const every = ctx.flow.remindBlockedEvery;
    if (reminder === undefined || every === "never" || !isDue(reminder.nextAt, ctx.now)) {
      return null;
    }
    reminder.count += 1;
    record(draft, "step.still_blocked", {
      stepId: instance.stepId,
      stepIndex: instance.index,
      blockedSince: instance.blockedAt ?? reminder.nextAt,
      reason: instance.blockReason ?? { type: "no-approvers" },
      count: reminder.count,
    });
    reminder.nextAt = nextAfter(draft, reminder.nextAt, every);
    return null;
  }

  const deadline = instance.deadline;
  if (deadline === undefined) return null;
  const step = ctx.flow.steps[instance.index] as StepDefinition;

  if (
    deadline.remindAt !== undefined &&
    deadline.remindedAt === undefined &&
    isDue(deadline.remindAt, ctx.now)
  ) {
    deadline.remindedAt = ctx.now;
    // A tick that arrives after the deadline skips the early reminder; the overdue one follows.
    if (!isDue(deadline.deadlineAt, ctx.now)) remind(draft, instance, deadline, false);
  }
  if (deadline.timedOutAt === undefined) {
    return isDue(deadline.deadlineAt, ctx.now) ? timeOut(draft, instance, step, deadline) : null;
  }
  if (deadline.nextReminderAt !== undefined && isDue(deadline.nextReminderAt, ctx.now)) {
    deadline.reminders += 1;
    remind(draft, instance, deadline, true);
    scheduleOverdue(draft, deadline);
  }
  return null;
}

function timeOut(
  draft: Draft,
  instance: StepInstance,
  step: StepDefinition,
  deadline: StepDeadline,
): ResolutionNeed | null {
  const action = step.onTimeout ?? "remind";
  if (action === "escalate") return escalate(draft, instance, step, deadline);

  deadline.timedOutAt = draft.ctx.now;
  // EC-59: fail closed. Auto-approve never overrides a rejection already cast in the step; the
  // step stays active and is reminded like an overdue step (EC-55).
  const rejected = instance.tasks.some((t) => t.status === "rejected");
  if (action === "auto-approve" && rejected) {
    record(draft, "step.timed_out", {
      stepId: instance.stepId,
      stepIndex: instance.index,
      action: "remind",
      reason: "auto-approve-skipped-rejection-present",
    });
  }
  if (action === "remind" || (action === "auto-approve" && rejected)) {
    deadline.reminders = 1;
    remind(draft, instance, deadline, true);
    scheduleOverdue(draft, deadline);
    return null;
  }

  // Auto decisions are explicit opt-ins; they count as nobody's vote.
  expirePending(draft, instance);
  record(draft, "step.timed_out", {
    stepId: instance.stepId,
    stepIndex: instance.index,
    action,
  });
  if (action === "auto-reject") {
    closeStep(draft, instance, "rejected");
    closeRejected(draft, instance.stepId, "timeout");
    return null;
  }
  closeStep(draft, instance, "approved");
  return advance(draft, instance.index + 1);
}

/**
 * EC-28, EC-54: replaces the pending tasks with fresh escalation targets. Targets pass the usual
 * pipeline (inactive, requester, delegation) and lose anyone who already voted in this step or
 * approved an earlier one; there is no dedupe, so an escalation never closes the step by itself.
 * When the depth limit is reached or too few targets remain for the votes still needed, the
 * current tasks stay pending and `request.escalation_failed` alerts (fail-safe).
 */
function escalate(
  draft: Draft,
  instance: StepInstance,
  step: StepDefinition,
  deadline: StepDeadline,
): ResolutionNeed | null {
  const { state, ctx } = draft;
  const depth = deadline.escalationDepth;
  const stepData = { stepId: instance.stepId, stepIndex: instance.index, depth };
  if (depth >= ctx.flow.maxEscalationDepth) {
    failEscalation(draft, deadline);
    record(draft, "request.escalation_failed", { ...stepData, reason: "max-depth" });
    return null;
  }

  const key = `escalate:${step.id}`;
  const resolution = ctx.resolutions?.[key];
  if (resolution === undefined || step.escalateTo === undefined) {
    return {
      key,
      stepId: step.id,
      spec: step.escalateTo ?? step.approvers,
      escalationDepth: depth + 1,
    };
  }

  const earlier = state.steps.filter((s) => s !== instance);
  const decided = decidedEarlier(earlier);
  const voted = new Set(
    instance.tasks
      .filter((t) => ["approved", "rejected", "skipped-duplicate"].includes(t.status))
      .map((t) => t.assigneeId),
  );
  const { approvers, removed } = eligibleApprovers(
    resolution,
    state.requesterId,
    ctx.flow.allowSelfApproval,
  );
  const targets: string[] = [];
  for (const userId of approvers) {
    if (voted.has(userId) || decided.has(userId)) removed.push({ userId, reason: "already-voted" });
    else targets.push(userId);
  }

  const approvals = instance.tasks.filter(
    (t) => t.status === "approved" || t.status === "skipped-duplicate",
  ).length;
  const required = requiredApprovals(step.mode, instance.approvers.length) - approvals;
  if (targets.length < required) {
    failEscalation(draft, deadline);
    record(draft, "request.escalation_failed", {
      ...stepData,
      reason: "too-few-targets",
      required,
      available: targets.length,
      ...removedData(removed),
    });
    return null;
  }

  expirePending(draft, instance);
  record(draft, "request.escalated", {
    stepId: instance.stepId,
    stepIndex: instance.index,
    depth: depth + 1,
    toUserIds: targets,
    ...removedData(removed),
  });
  const holders = new Set([...instance.tasks.map((t) => t.assigneeId), ...targets]);
  const delegation = delegationContext(draft, earlier, resolution, holders);
  for (const userId of targets) {
    const delegated = followDelegations(userId, delegation);
    holders.add(delegated.assigneeId);
    assignTask(draft, instance, delegated, delegated.assigneeId === userId ? undefined : userId);
  }
  startDeadline(draft, instance, step, depth + 1);
  return null;
}

/** Fail-safe: the tasks stay pending and overdue reminders keep coming (EC-28, EC-55). */
function failEscalation(draft: Draft, deadline: StepDeadline): void {
  deadline.timedOutAt = draft.ctx.now;
  scheduleOverdue(draft, deadline);
}

function scheduleOverdue(draft: Draft, deadline: StepDeadline): void {
  const every = draft.ctx.flow.remindOverdueEvery;
  if (every === "never") {
    delete deadline.nextReminderAt;
    return;
  }
  deadline.nextReminderAt = nextAfter(draft, deadline.nextReminderAt ?? deadline.deadlineAt, every);
}

function remind(
  draft: Draft,
  instance: StepInstance,
  deadline: StepDeadline,
  overdue: boolean,
): void {
  for (const task of instance.tasks) {
    if (task.status !== "pending") continue;
    const data = {
      taskId: task.id,
      stepId: instance.stepId,
      assigneeId: task.assigneeId,
      deadlineAt: deadline.deadlineAt,
    };
    record(
      draft,
      "task.reminder",
      overdue ? { ...data, overdue: true, count: deadline.reminders } : { ...data, overdue: false },
    );
  }
}

function expirePending(draft: Draft, instance: StepInstance): void {
  for (const task of instance.tasks) {
    if (task.status !== "pending") continue;
    task.status = "expired";
    task.decidedAt = draft.ctx.now;
    record(draft, "task.expired", { taskId: task.id, stepId: instance.stepId });
  }
}
