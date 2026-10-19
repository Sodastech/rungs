import { evaluateCondition } from "../flow/condition.js";
import type { ResolutionNeed } from "../model/decision.js";
import { InvalidCommandError, ResolutionError } from "../model/errors.js";
import type { StepDefinition } from "../model/flow.js";
import type { SkipReason, StepInstance } from "../model/state.js";
import { clone, type Draft, record } from "./draft.js";

/**
 * Activates the first step from `fromIndex` that applies: steps whose condition is false (EC-38)
 * or that resolve to nobody under `onEmptyStep: "skip"` (EC-04) are skipped with a reason.
 * Returns a need when approvers have not been resolved yet. Approves the request when no steps
 * remain.
 */
export function advance(draft: Draft, fromIndex: number): ResolutionNeed | null {
  const { flow, resolutions } = draft.ctx;
  for (let index = fromIndex; index < flow.steps.length; index++) {
    const step = flow.steps[index] as StepDefinition;

    if (step.when !== undefined && !evaluateCondition(step.when, draft.state.payload)) {
      skip(draft, step, index, { type: "condition-false", condition: step.when });
      continue;
    }

    const resolution = resolutions?.[step.id];
    if (resolution === undefined) return { key: step.id, stepId: step.id, spec: step.approvers };

    const approvers = [...new Set(resolution.userIds)];
    if (approvers.length === 0) {
      if (flow.onEmptyStep === "fail") {
        throw new ResolutionError({ stepId: step.id, reason: "no-approvers" });
      }
      skip(draft, step, index, { type: "no-approvers" });
      continue;
    }

    activate(draft, step, index, approvers);
    return null;
  }

  completeApproved(draft);
  return null;
}

export function activeStep(draft: Draft): StepInstance | undefined {
  return draft.state.steps.findLast((instance) => instance.status === "active");
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
  record(draft, "request.rejected", { stepId });
}

function activate(draft: Draft, step: StepDefinition, index: number, approvers: string[]): void {
  const { state, ctx } = draft;
  const instance: StepInstance = {
    stepId: step.id,
    index,
    status: "active",
    activatedAt: ctx.now,
    approvers,
    tasks: [],
  };
  state.steps.push(instance);
  state.currentStepIndex = index;
  record(draft, "step.activated", { stepId: step.id, stepIndex: index, approvers });

  for (const assigneeId of approvers) {
    state.lastTaskNumber += 1;
    const taskId = `${state.id}.t${state.lastTaskNumber}`;
    instance.tasks.push({ id: taskId, assigneeId, status: "pending", assignedAt: ctx.now });
    record(draft, "task.assigned", { taskId, stepId: step.id, assigneeId });
  }
}

function skip(draft: Draft, step: StepDefinition, index: number, reason: SkipReason): void {
  draft.state.steps.push({
    stepId: step.id,
    index,
    status: "skipped",
    skippedAt: draft.ctx.now,
    skipReason: clone(reason),
    approvers: [],
    tasks: [],
  });
  record(draft, "step.skipped", { stepId: step.id, stepIndex: index, reason });
}

/** EC-39: a request whose every step was skipped is approved, or refused with `onAllSkipped: "fail"`. */
function completeApproved(draft: Draft): void {
  const { state, ctx } = draft;
  const allSkipped = state.steps.every((instance) => instance.status === "skipped");
  if (allSkipped && ctx.flow.onAllSkipped === "fail") {
    throw new InvalidCommandError(
      `Flow "${ctx.flow.key}" does not apply to this request: every step was skipped and the flow uses onAllSkipped "fail"`,
    );
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
