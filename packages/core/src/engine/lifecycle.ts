import { evaluateCondition } from "../flow/condition.js";
import type { ResubmitCommand, ReturnCommand, WithdrawCommand } from "../model/command.js";
import type { Decision, EngineContext, ResolutionNeed } from "../model/decision.js";
import { InvalidCommandError, NoApproversError, NotAssignedError } from "../model/errors.js";
import type { RequestState } from "../model/state.js";
import { clone, type Draft, finish, record, startDraft } from "./draft.js";
import {
  activeStep,
  advance,
  cancelOpenStep,
  closeStep,
  planStep,
  supersedeOpenTasks,
} from "./progress.js";

/**
 * EC-41, EC-43: evaluates every step condition against `payload` (so an invalid one fails the
 * requester's command) and dry-runs the resolution of each applicable step from `fromIndex`, so a
 * step that could never run refuses the command instead of blocking the request later. Returns the
 * needs when approvers are still missing, otherwise null. Nothing is stored.
 */
export function checkRunnable(
  draft: Draft,
  payload: RequestState["payload"],
  fromIndex: number,
): Decision | null {
  const { flow, resolutions } = draft.ctx;
  const applicable = flow.steps.filter(
    (step) => step.when === undefined || evaluateCondition(step.when, payload),
  );
  const steps = applicable.filter((step) => flow.steps.indexOf(step) >= fromIndex);
  const needs = steps
    .filter((step) => resolutions?.[step.id] === undefined)
    .map((step): ResolutionNeed => ({ key: step.id, stepId: step.id, spec: step.approvers }));
  if (needs.length > 0) return { kind: "needs-resolution", needs };
  for (const step of steps) {
    const plan = planStep(draft, step, resolutions?.[step.id] ?? { userIds: [] });
    if (plan.kind === "block") {
      throw new NoApproversError({ stepId: step.id, reason: plan.reason, removed: plan.removed });
    }
  }
  return null;
}

/**
 * EC-32: returns the request to the requester, who may edit and resubmit it.
 * EC-33: returns it to an earlier step that ran; that step and every later one run again with
 * freshly resolved approvers. Other pending tasks of the step are superseded.
 */
export function returnRequest(
  state: RequestState,
  command: ReturnCommand,
  ctx: EngineContext,
): Decision {
  const draft = startDraft(state, command.actorId, ctx);
  const instance = activeStep(draft);
  const task = instance?.tasks.find(
    (t) => t.status === "pending" && t.assigneeId === command.actorId,
  );
  if (instance === undefined || task === undefined) {
    throw new NotAssignedError({ requestId: state.id, actorId: command.actorId });
  }
  const targetIndex = command.to === "requester" ? null : earlierStep(draft, command.to.stepId);
  if (targetIndex !== null && targetIndex >= instance.index) {
    throw new InvalidCommandError(
      `Cannot return to step "${(command.to as { stepId: string }).stepId}": it is not an earlier step that ran`,
    );
  }

  task.status = "returned";
  task.decidedAt = ctx.now;
  if (command.comment !== undefined) task.comment = command.comment;
  const comment = command.comment === undefined ? {} : { comment: command.comment };
  record(draft, "task.returned", {
    taskId: task.id,
    stepId: instance.stepId,
    to: command.to,
    ...comment,
  });
  supersedeOpenTasks(draft, instance, task.id);
  closeStep(draft, instance, "returned");

  if (targetIndex === null) {
    draft.state.status = "returned";
    draft.state.currentStepIndex = null;
    record(draft, "request.returned", { stepId: instance.stepId, ...comment });
    return finish(draft);
  }
  invalidateFrom(draft, targetIndex);
  const need = advance(draft, targetIndex);
  return need ? { kind: "needs-resolution", needs: [need] } : finish(draft);
}

/**
 * EC-34: the requester sends a returned request again. `restart` runs every step from the
 * beginning; `from-returned-step` resumes at the step that returned it, keeping earlier approvals,
 * but only when the payload is unchanged: a changed payload restarts, because earlier conditional
 * steps must be evaluated again (EC-51). The flow version stays pinned (EC-37).
 */
export function resubmitRequest(
  state: RequestState,
  command: ResubmitCommand,
  ctx: EngineContext,
): Decision {
  requireRequester(state, command.actorId);
  const draft = startDraft(state, command.actorId, ctx);
  const payload = command.payload === undefined ? state.payload : clone(command.payload);
  const payloadChanged = canonical(payload) !== canonical(state.payload);
  const returned = draft.state.steps.findLast(
    (s) => s.status === "returned" && s.invalidatedAt === undefined,
  );
  const policy = ctx.flow.returnPolicy;
  const applied =
    policy === "from-returned-step" && !payloadChanged && returned !== undefined
      ? "from-returned-step"
      : "restart";
  const fromIndex = applied === "restart" ? 0 : (returned?.index ?? 0);

  draft.state.payload = payload;
  const pending = checkRunnable(draft, payload, fromIndex);
  if (pending) return pending;

  invalidateFrom(draft, fromIndex);
  draft.state.status = "pending";
  record(draft, "request.resubmitted", { returnPolicy: policy, applied, payloadChanged });
  const need = advance(draft, fromIndex);
  return need ? { kind: "needs-resolution", needs: [need] } : finish(draft);
}

/** EC-35: the requester withdraws; open tasks and the open step are cancelled. */
export function withdrawRequest(
  state: RequestState,
  command: WithdrawCommand,
  ctx: EngineContext,
): Decision {
  requireRequester(state, command.actorId);
  const draft = startDraft(state, command.actorId, ctx);
  cancelOpenStep(draft);
  draft.state.status = "withdrawn";
  draft.state.closedAt = ctx.now;
  draft.state.currentStepIndex = null;
  record(
    draft,
    "request.withdrawn",
    command.reason === undefined ? {} : { comment: command.reason },
  );
  return finish(draft);
}

function requireRequester(state: RequestState, actorId: string): void {
  if (actorId !== state.requesterId) {
    throw new NotAssignedError({ requestId: state.id, actorId, role: "requester" });
  }
}

/** Index of `stepId` when it has a counting, approved instance; otherwise the command is refused. */
function earlierStep(draft: Draft, stepId: string): number {
  const ran = draft.state.steps.find(
    (s) => s.stepId === stepId && s.status === "approved" && s.invalidatedAt === undefined,
  );
  if (ran === undefined) {
    throw new InvalidCommandError(
      `Cannot return to step "${stepId}": it is not an earlier step that ran`,
    );
  }
  return ran.index;
}

/** Instances at or after `index` stop counting: those steps will run again. */
function invalidateFrom(draft: Draft, index: number): void {
  for (const instance of draft.state.steps) {
    if (instance.index >= index && instance.invalidatedAt === undefined) {
      instance.invalidatedAt = draft.ctx.now;
    }
  }
}

/** JSON with object keys sorted, so key order does not count as a change (EC-51). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
