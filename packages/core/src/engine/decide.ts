import type {
  ApproveCommand,
  Command,
  OverrideCommand,
  ReassignStepCommand,
  RejectCommand,
  RetryStepCommand,
  SubmitCommand,
} from "../model/command.js";
import type { Decision, EngineContext, ResolutionNeed } from "../model/decision.js";
import {
  InvalidCommandError,
  InvalidTransitionError,
  NotAssignedError,
  RequestNotFoundError,
} from "../model/errors.js";
import type { StepDefinition } from "../model/flow.js";
import type { RequestState, StepInstance } from "../model/state.js";
import { requiredApprovals } from "../resolution/pipeline.js";
import { clone, type Draft, finish, jsonIssues, record, startDraft } from "./draft.js";
import { delegateTask, reassignTask } from "./handover.js";
import { checkRunnable, resubmitRequest, returnRequest, withdrawRequest } from "./lifecycle.js";
import {
  advance,
  cancelOpenStep,
  closeRejected,
  closeStep,
  decidableTask,
  decideOn,
  openStep,
  planStep,
  removedData,
  resume,
  stepOutcome,
  supersedeOpenTasks,
} from "./progress.js";
import { tickRequest } from "./tick.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * The pure engine: computes the next request state, audit events and domain events for one
 * command. No I/O, no clock, no randomness: the same state, command and context always give the
 * same result. Throws a `RungsError` when the command is not allowed; the input is never changed.
 */
export function decide(state: RequestState | null, command: Command, ctx: EngineContext): Decision {
  if (typeof ctx.now !== "string" || !ISO_UTC.test(ctx.now)) {
    throw new InvalidCommandError(
      `ctx.now must be an ISO 8601 UTC timestamp, got "${String(ctx.now)}"`,
    );
  }
  validateCommand(command);

  if (command.type === "submit") {
    if (state !== null) {
      throw new InvalidTransitionError({
        requestId: state.id,
        status: "exists",
        command: "submit",
      });
    }
    return submit(command, ctx);
  }

  if (state === null) throw new RequestNotFoundError(command.requestId);
  if (state.id !== command.requestId) {
    throw new InvalidCommandError(
      `Command is for request "${command.requestId}" but state is "${state.id}"`,
    );
  }
  if (
    state.flowKey !== ctx.flow.key ||
    state.flowVersion !== ctx.flow.version ||
    state.flowTenantId !== ctx.flow.tenantId
  ) {
    throw new InvalidCommandError(
      `Request is pinned to flow ${flowName(state.flowKey, state.flowVersion, state.flowTenantId)}, got ${flowName(ctx.flow.key, ctx.flow.version, ctx.flow.tenantId)}`,
    );
  }
  if (command.type === "tick") return tickRequest(state, command, ctx);
  if (!allowedStatuses(command.type).includes(state.status)) {
    throw new InvalidTransitionError({
      requestId: state.id,
      status: state.status,
      command: command.type,
    });
  }

  switch (command.type) {
    case "approve":
    case "reject":
      return decideTask(state, command, ctx);
    case "return":
      return returnRequest(state, command, ctx);
    case "resubmit":
      return resubmitRequest(state, command, ctx);
    case "withdraw":
      return withdrawRequest(state, command, ctx);
    case "delegate":
      return delegateTask(state, command, ctx);
    case "reassign":
      return command.taskId === undefined
        ? reassignStep(state, command, ctx)
        : reassignTask(state, command, ctx);
    case "retry":
      return retryStep(state, command, ctx);
    case "override":
      return overrideRequest(state, command, ctx);
  }
}

function flowName(key: string, version: number, tenantId: string | undefined): string {
  return `"${key}" v${version}${tenantId === undefined ? "" : ` of tenant "${tenantId}"`}`;
}

function submit(command: SubmitCommand, ctx: EngineContext): Decision {
  const { flow } = ctx;
  const payload = clone(command.payload);
  // EC-56: a tenant's own flow only serves requests of that tenant.
  if (flow.tenantId !== undefined && flow.tenantId !== command.tenantId) {
    throw new InvalidCommandError(
      `Flow "${flow.key}" belongs to tenant "${flow.tenantId}" and cannot serve this request`,
    );
  }

  const state: RequestState = {
    id: command.requestId,
    ...(command.tenantId === undefined ? {} : { tenantId: command.tenantId }),
    flowKey: flow.key,
    flowVersion: flow.version,
    ...(flow.tenantId === undefined ? {} : { flowTenantId: flow.tenantId }),
    subject: { type: command.subject.type, id: command.subject.id },
    requesterId: command.requesterId,
    payload,
    status: "pending",
    currentStepIndex: null,
    version: 0,
    submittedAt: ctx.now,
    steps: [],
    lastAuditSeq: 0,
    lastTaskNumber: 0,
    nextDueAt: null,
  };
  const draft = startDraft(state, command.requesterId, ctx);

  // EC-41, EC-43: invalid conditions and steps that could never run refuse the submit instead of
  // blocking an approver later. Steps re-evaluate and resolve again at activation (EC-38).
  const pending = checkRunnable(draft, payload, 0);
  if (pending) return pending;

  record(draft, "request.submitted", {
    flowKey: flow.key,
    flowVersion: flow.version,
    subject: state.subject,
  });
  return proceed(draft, advance(draft, 0));
}

function decideTask(
  state: RequestState,
  command: ApproveCommand | RejectCommand,
  ctx: EngineContext,
): Decision {
  const draft = startDraft(state, command.actorId, ctx);
  const found = decidableTask(draft, command.actorId);
  if (found === undefined) {
    throw new NotAssignedError({ requestId: state.id, actorId: command.actorId });
  }
  const { instance, task } = found;

  const decision = command.type === "approve" ? "approved" : "rejected";
  const data = decideOn(draft, instance, task, decision, command.comment);
  record(draft, command.type === "approve" ? "task.approved" : "task.rejected", data);

  const outcome = stepOutcome(draft, instance, decision);
  if (outcome === "pending") return finish(draft);

  supersedeOpenTasks(draft, instance, task.id);
  closeStep(draft, instance, outcome);
  if (outcome === "rejected") {
    closeRejected(draft, instance.stepId);
    return finish(draft);
  }
  return proceed(draft, advance(draft, instance.index + 1));
}

/**
 * EC-46: gives a blocked step to users the admin chose. They pass the same checks as resolved
 * approvers (inactive, requester, quorum); any failure refuses the command instead of silently
 * dropping someone the admin named.
 */
function reassignStep(
  state: RequestState,
  command: ReassignStepCommand,
  ctx: EngineContext,
): Decision {
  const draft = startDraft(state, command.adminId, ctx);
  const { instance, step } = blockedStep(draft, command);
  const toUserIds = [...new Set(command.toUserIds)];
  const key = `reassign:${step.id}`;
  const resolution = ctx.resolutions?.[key];
  if (resolution === undefined) {
    return {
      kind: "needs-resolution",
      needs: [{ key, stepId: step.id, spec: { type: "users", ids: toUserIds } }],
    };
  }

  const plan = planStep(draft, step, { ...resolution, userIds: toUserIds });
  const problems = plan.removed.map((r) =>
    r.reason === "requester"
      ? `"${r.userId}" is the requester and the flow does not allow self-approval`
      : `"${r.userId}" is inactive`,
  );
  if (plan.kind !== "activate") {
    const eligible = toUserIds.length - plan.removed.length;
    const required = Math.max(1, requiredApprovals(step.mode, eligible));
    problems.push(`step "${step.id}" needs ${required} approvers, got ${eligible} eligible`);
  }
  if (problems.length > 0) {
    throw new InvalidCommandError(`Cannot reassign step "${step.id}": ${problems.join("; ")}`);
  }

  record(draft, "step.reassigned", {
    stepId: step.id,
    stepIndex: instance.index,
    toUserIds,
    comment: command.comment,
  });
  return proceed(draft, resume(draft, instance, plan));
}

/**
 * EC-46: resolves a blocked step again through the full pipeline. When it still cannot run the
 * step stays blocked and only the attempt is recorded; no new `step.blocked` is emitted.
 */
function retryStep(state: RequestState, command: RetryStepCommand, ctx: EngineContext): Decision {
  const draft = startDraft(state, command.adminId, ctx);
  const { instance, step } = blockedStep(draft, command);
  const resolution = ctx.resolutions?.[step.id];
  if (resolution === undefined) {
    return {
      kind: "needs-resolution",
      needs: [{ key: step.id, stepId: step.id, spec: step.approvers }],
    };
  }

  const plan = planStep(draft, step, resolution);
  const data = { stepId: step.id, stepIndex: instance.index };
  if (plan.kind === "block") {
    instance.blockReason = clone(plan.reason);
    delete instance.removed;
    if (plan.removed.length > 0) instance.removed = clone(plan.removed);
    record(draft, "step.retried", {
      ...data,
      result: "still-blocked",
      reason: plan.reason,
      ...removedData(plan.removed),
    });
    return finish(draft);
  }
  record(draft, "step.retried", { ...data, result: "unblocked" });
  return proceed(draft, resume(draft, instance, plan));
}

/** EC-18: closes the request with the admin's decision; every open task and step is cancelled. */
function overrideRequest(
  state: RequestState,
  command: OverrideCommand,
  ctx: EngineContext,
): Decision {
  const draft = startDraft(state, command.adminId, ctx);
  cancelOpenStep(draft);
  delete draft.state.resubmit;

  const { state: next } = draft;
  next.status = command.decision === "approve" ? "approved" : "rejected";
  next.closedAt = ctx.now;
  next.currentStepIndex = null;
  const data = { reason: "override" as const, comment: command.comment };
  if (command.decision === "approve") record(draft, "request.approved", data);
  else record(draft, "request.rejected", data);
  return finish(draft);
}

/** Statuses a command may act on: a returned request can only be resubmitted, withdrawn or overridden. */
function allowedStatuses(type: Command["type"]): readonly RequestState["status"][] {
  if (type === "resubmit") return ["returned"];
  if (type === "withdraw" || type === "override") return ["pending", "returned"];
  return ["pending"];
}

function blockedStep(
  draft: Draft,
  command: ReassignStepCommand | RetryStepCommand,
): { instance: StepInstance; step: StepDefinition } {
  const instance = openStep(draft);
  if (instance?.status !== "blocked" || instance.stepId !== command.stepId) {
    const current = instance ? `"${instance.stepId}" is ${instance.status}` : "no step is open";
    throw new InvalidCommandError(
      `Cannot ${command.type} step "${command.stepId}" of request "${draft.state.id}": it is not blocked (${current})`,
    );
  }
  return { instance, step: draft.ctx.flow.steps[instance.index] as StepDefinition };
}

function proceed(draft: Draft, need: ResolutionNeed | null): Decision {
  return need ? { kind: "needs-resolution", needs: [need] } : finish(draft);
}

function validateCommand(command: Command): void {
  const problems: string[] = [];
  const text = (value: unknown, name: string) => {
    if (typeof value !== "string" || value.length === 0)
      problems.push(`${name} must be a non-empty string`);
  };
  const requiredComment = (value: unknown) => {
    if (typeof value !== "string" || value.trim().length === 0)
      problems.push("comment must be a non-empty string");
  };
  const optionalComment = (value: unknown) => {
    if (value !== undefined && typeof value !== "string") problems.push("comment must be a string");
  };

  switch (command.type) {
    case "submit":
      text(command.requestId, "requestId");
      text(command.requesterId, "requesterId");
      text(command.subject?.type, "subject.type");
      text(command.subject?.id, "subject.id");
      if (command.tenantId !== undefined) text(command.tenantId, "tenantId");
      problems.push(...jsonIssues(command.payload, "payload"));
      break;
    case "approve":
    case "reject":
      text(command.requestId, "requestId");
      text(command.actorId, "actorId");
      if (command.comment !== undefined && typeof command.comment !== "string") {
        problems.push("comment must be a string");
      }
      break;
    case "return":
      text(command.requestId, "requestId");
      text(command.actorId, "actorId");
      if (command.to !== "requester") text(command.to?.stepId, "to.stepId");
      if (command.comment !== undefined && typeof command.comment !== "string") {
        problems.push("comment must be a string");
      }
      break;
    case "resubmit":
      text(command.requestId, "requestId");
      text(command.actorId, "actorId");
      if (command.payload !== undefined) problems.push(...jsonIssues(command.payload, "payload"));
      break;
    case "withdraw":
      text(command.requestId, "requestId");
      text(command.actorId, "actorId");
      optionalComment(command.comment);
      break;
    case "delegate":
      text(command.requestId, "requestId");
      text(command.actorId, "actorId");
      text(command.taskId, "taskId");
      text(command.toUserId, "toUserId");
      optionalComment(command.comment);
      break;
    case "reassign":
      text(command.requestId, "requestId");
      text(command.adminId, "adminId");
      requiredComment(command.comment);
      if ((command.stepId === undefined) === (command.taskId === undefined)) {
        problems.push("a reassign names either stepId or taskId");
      } else if (command.taskId !== undefined) {
        text(command.taskId, "taskId");
        text(command.toUserId, "toUserId");
      } else {
        text(command.stepId, "stepId");
        if (!Array.isArray(command.toUserIds) || command.toUserIds.length === 0) {
          problems.push("toUserIds must be a non-empty array");
        } else {
          for (const [i, id] of command.toUserIds.entries()) text(id, `toUserIds[${i}]`);
        }
      }
      break;
    case "tick":
      text(command.requestId, "requestId");
      break;
    case "retry":
      text(command.requestId, "requestId");
      text(command.adminId, "adminId");
      text(command.stepId, "stepId");
      break;
    case "override":
      text(command.requestId, "requestId");
      text(command.adminId, "adminId");
      requiredComment(command.comment);
      if (command.decision !== "approve" && command.decision !== "reject") {
        problems.push('decision must be "approve" or "reject"');
      }
      break;
    default:
      problems.push(`unknown command type "${String((command as { type?: unknown }).type)}"`);
  }

  if (problems.length > 0) throw new InvalidCommandError(`Invalid command: ${problems.join("; ")}`);
}
