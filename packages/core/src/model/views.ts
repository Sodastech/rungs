import type { RequestState } from "./state.js";
import type { BlockedStepView, RequestSummary, TaskView } from "./store.js";

// How list queries see a request. Store adapters build their rows with these functions, so every
// store returns the same views. They are plain functions of the request state.

/** The inbox rows of a request: pending tasks on its active step while it is pending. */
export function taskViews(state: RequestState): TaskView[] {
  if (state.status !== "pending") return [];
  const step = state.steps.findLast((s) => s.status === "active");
  if (step === undefined) return [];
  return step.tasks
    .filter((task) => task.status === "pending")
    .map((task) => ({
      requestId: state.id,
      ...(state.tenantId === undefined ? {} : { tenantId: state.tenantId }),
      flowKey: state.flowKey,
      flowVersion: state.flowVersion,
      subject: state.subject,
      requesterId: state.requesterId,
      stepId: step.stepId,
      taskId: task.id,
      assigneeId: task.assigneeId,
      ...(task.onBehalfOf === undefined ? {} : { onBehalfOf: task.onBehalfOf }),
      assignedAt: task.assignedAt,
      ...(step.deadline === undefined ? {} : { deadlineAt: step.deadline.deadlineAt }),
      payload: state.payload,
    }));
}

/** The request as `findRequests` lists it. */
export function requestSummary(state: RequestState): RequestSummary {
  const open =
    state.status === "pending"
      ? state.steps.findLast((s) => s.status === "active" || s.status === "blocked")
      : undefined;
  return {
    id: state.id,
    ...(state.tenantId === undefined ? {} : { tenantId: state.tenantId }),
    flowKey: state.flowKey,
    flowVersion: state.flowVersion,
    subject: state.subject,
    requesterId: state.requesterId,
    status: state.status,
    submittedAt: state.submittedAt,
    ...(state.closedAt === undefined ? {} : { closedAt: state.closedAt }),
    version: state.version,
    payload: state.payload,
    openStep:
      open === undefined
        ? null
        : { stepId: open.stepId, status: open.status === "blocked" ? "blocked" : "active" },
  };
}

/** The blocked step of a pending request as `findBlocked` lists it; null when none is blocked. */
export function blockedStepView(state: RequestState): BlockedStepView | null {
  if (state.status !== "pending") return null;
  const step = state.steps.findLast((s) => s.status === "blocked");
  if (step === undefined || step.blockedAt === undefined || step.blockReason === undefined) {
    return null;
  }
  return {
    requestId: state.id,
    ...(state.tenantId === undefined ? {} : { tenantId: state.tenantId }),
    flowKey: state.flowKey,
    flowVersion: state.flowVersion,
    subject: state.subject,
    requesterId: state.requesterId,
    payload: state.payload,
    stepId: step.stepId,
    blockedAt: step.blockedAt,
    reason: step.blockReason,
    removed: step.removed ?? [],
    version: state.version,
  };
}
