import { evaluateCondition } from "../flow/condition.js";
import type { ApproveCommand, Command, RejectCommand, SubmitCommand } from "../model/command.js";
import type { Decision, EngineContext } from "../model/decision.js";
import {
  InvalidCommandError,
  InvalidTransitionError,
  NotAssignedError,
  RequestNotFoundError,
} from "../model/errors.js";
import type { StepMode } from "../model/flow.js";
import type { RequestState, StepInstance } from "../model/state.js";
import { clone, type Draft, finish, isJson, record, startDraft } from "./draft.js";
import { activeStep, advance, closeRejected, closeStep } from "./progress.js";

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
  if (state.flowKey !== ctx.flow.key || state.flowVersion !== ctx.flow.version) {
    throw new InvalidCommandError(
      `Request is pinned to flow "${state.flowKey}" v${state.flowVersion}, got "${ctx.flow.key}" v${ctx.flow.version}`,
    );
  }
  if (state.status !== "pending") {
    throw new InvalidTransitionError({
      requestId: state.id,
      status: state.status,
      command: command.type,
    });
  }
  return decideTask(state, command, ctx);
}

function submit(command: SubmitCommand, ctx: EngineContext): Decision {
  const { flow } = ctx;
  const payload = clone(command.payload);

  // EC-41: evaluate every condition now, so an invalid one fails the requester's submit instead
  // of blocking an approver later. Results are discarded; steps re-evaluate at activation (EC-38).
  for (const step of flow.steps) {
    if (step.when !== undefined) evaluateCondition(step.when, payload);
  }

  const state: RequestState = {
    id: command.requestId,
    ...(command.tenantId === undefined ? {} : { tenantId: command.tenantId }),
    flowKey: flow.key,
    flowVersion: flow.version,
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
  };
  const draft = startDraft(state, command.requesterId, ctx);
  record(draft, "request.submitted", {
    flowKey: flow.key,
    flowVersion: flow.version,
    subject: state.subject,
  });

  const need = advance(draft, 0);
  if (need) return { kind: "needs-resolution", needs: [need] };
  return finish(draft);
}

function decideTask(
  state: RequestState,
  command: ApproveCommand | RejectCommand,
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

  const decision = command.type === "approve" ? "approved" : "rejected";
  task.status = decision;
  task.decidedAt = ctx.now;
  if (command.comment !== undefined) task.comment = command.comment;
  record(draft, command.type === "approve" ? "task.approved" : "task.rejected", {
    taskId: task.id,
    stepId: instance.stepId,
    ...(command.comment === undefined ? {} : { comment: command.comment }),
  });

  const step = ctx.flow.steps[instance.index];
  const outcome = stepOutcome(instance, step?.mode ?? "any", decision);
  if (outcome === "pending") return finish(draft);

  supersedeOpenTasks(draft, instance, task.id);
  closeStep(draft, instance, outcome);
  if (outcome === "rejected") {
    closeRejected(draft, instance.stepId);
    return finish(draft);
  }

  const need = advance(draft, instance.index + 1);
  if (need) return { kind: "needs-resolution", needs: [need] };
  return finish(draft);
}

/** EC-12: in mode "any" the first decision, approve or reject, decides the step. */
function stepOutcome(
  _instance: StepInstance,
  mode: StepMode,
  decision: "approved" | "rejected",
): "approved" | "rejected" | "pending" {
  if (mode === "any") return decision;
  throw new Error(`Step mode ${JSON.stringify(mode)} is not implemented yet (milestone 1.3)`);
}

function supersedeOpenTasks(draft: Draft, instance: StepInstance, byTaskId: string): void {
  for (const task of instance.tasks) {
    if (task.status !== "pending") continue;
    task.status = "superseded";
    task.decidedAt = draft.ctx.now;
    record(draft, "task.superseded", { taskId: task.id, stepId: instance.stepId, byTaskId });
  }
}

function validateCommand(command: Command): void {
  const problems: string[] = [];
  const text = (value: unknown, name: string) => {
    if (typeof value !== "string" || value.length === 0)
      problems.push(`${name} must be a non-empty string`);
  };

  switch (command.type) {
    case "submit":
      text(command.requestId, "requestId");
      text(command.requesterId, "requesterId");
      text(command.subject?.type, "subject.type");
      text(command.subject?.id, "subject.id");
      if (command.tenantId !== undefined) text(command.tenantId, "tenantId");
      if (!isJson(command.payload)) {
        problems.push(
          "payload must be plain JSON (no undefined, NaN, Infinity, Date, functions or class instances)",
        );
      }
      break;
    case "approve":
    case "reject":
      text(command.requestId, "requestId");
      text(command.actorId, "actorId");
      if (command.comment !== undefined && typeof command.comment !== "string") {
        problems.push("comment must be a string");
      }
      break;
    default:
      problems.push(`unknown command type "${String((command as { type?: unknown }).type)}"`);
  }

  if (problems.length > 0) throw new InvalidCommandError(`Invalid command: ${problems.join("; ")}`);
}
