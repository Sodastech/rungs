import type { DelegateCommand, ReassignTaskCommand } from "../model/command.js";
import type { Decision, EngineContext } from "../model/decision.js";
import { InvalidCommandError, NotAssignedError } from "../model/errors.js";
import type { RequestState, StepInstance, Task } from "../model/state.js";
import { followDelegations } from "../resolution/delegation.js";
import { type Draft, finish, record, startDraft } from "./draft.js";
import { activeStep, assignTask, delegationContext } from "./progress.js";

/**
 * EC-25: the assignee hands a pending task to a delegate. The old task becomes `delegated`; the
 * new one carries the same vote (`onBehalfOf` the original approver) and follows the delegate's
 * own out-of-office rules.
 */
export function delegateTask(
  state: RequestState,
  command: DelegateCommand,
  ctx: EngineContext,
): Decision {
  const draft = startDraft(state, command.actorId, ctx);
  const found = findTask(draft, command.taskId);
  const { instance, task } = found;
  if (
    instance !== activeStep(draft) ||
    task.status !== "pending" ||
    task.assigneeId !== command.actorId
  ) {
    throw new NotAssignedError({ requestId: state.id, actorId: command.actorId });
  }
  if (command.toUserId === command.actorId) {
    throw new InvalidCommandError(`Task "${task.id}": cannot delegate a task to its own assignee`);
  }
  return handOver(draft, found, command.toUserId, `delegate:${task.id}`, (handover) => {
    task.status = "delegated";
    record(draft, "task.delegated", {
      taskId: task.id,
      stepId: instance.stepId,
      ...handover,
      ...(command.comment === undefined ? {} : { comment: command.comment }),
    });
    return task.onBehalfOf ?? task.assigneeId;
  });
}

/** An admin moves one pending task to another user. The old task becomes `reassigned`. */
export function reassignTask(
  state: RequestState,
  command: ReassignTaskCommand,
  ctx: EngineContext,
): Decision {
  const draft = startDraft(state, command.adminId, ctx);
  const found = findTask(draft, command.taskId);
  const { instance, task } = found;
  if (instance !== activeStep(draft) || task.status !== "pending") {
    throw new InvalidCommandError(
      `Cannot reassign task "${task.id}" of request "${state.id}": it is not pending (${task.status})`,
    );
  }
  return handOver(draft, found, command.toUserId, `reassign:${task.id}`, (handover) => {
    task.status = "reassigned";
    record(draft, "task.reassigned", {
      taskId: task.id,
      stepId: instance.stepId,
      ...handover,
      comment: command.comment,
    });
    return undefined;
  });
}

interface Found {
  readonly instance: StepInstance;
  readonly task: Task;
}

function findTask(draft: Draft, taskId: string): Found {
  for (const instance of draft.state.steps) {
    const task = instance.tasks.find((t) => t.id === taskId);
    if (task) return { instance, task };
  }
  throw new InvalidCommandError(`Task "${taskId}" does not exist on request "${draft.state.id}"`);
}

interface Handover {
  readonly toTaskId: string;
  readonly toUserId: string;
  readonly returnedToOriginal?: true;
}

/**
 * Shared by delegate and reassign. The chosen user must be eligible: not the requester (unless
 * self-approval is allowed), active, not already holding a task in the step (EC-48) and not an
 * approver of an earlier step (EC-49). Their out-of-office rules then apply as usual.
 *
 * EC-50: the approver a task acts for (`onBehalfOf`) may always take it back, e.g. after returning
 * early. That is not a merge: the vote is theirs. The new task has no `onBehalfOf` and no rules are
 * followed; the requester and inactive checks still apply.
 *
 * `close` retires the old task, records its event and returns the vote the new task carries.
 */
function handOver(
  draft: Draft,
  { instance, task }: Found,
  toUserId: string,
  key: string,
  close: (handover: Handover) => string | undefined,
): Decision {
  const { state, ctx } = draft;
  const resolution = ctx.resolutions?.[key];
  if (resolution === undefined) {
    return {
      kind: "needs-resolution",
      needs: [{ key, stepId: instance.stepId, spec: { type: "users", ids: [toUserId] } }],
    };
  }

  const holders = new Set(instance.tasks.map((t) => t.assigneeId));
  const earlier = state.steps.filter((s) => s !== instance);
  const delegation = delegationContext(draft, earlier, resolution, holders);
  const returning = toUserId === task.onBehalfOf;
  const problems: string[] = [];
  if (holders.has(toUserId) && !returning) {
    problems.push(`"${toUserId}" already holds a task in step "${instance.stepId}"`);
  }
  if (toUserId === state.requesterId && !ctx.flow.allowSelfApproval) {
    problems.push(`"${toUserId}" is the requester and the flow does not allow self-approval`);
  }
  if (delegation.inactive.has(toUserId)) problems.push(`"${toUserId}" is inactive`);
  const decidedStep = returning ? undefined : delegation.decided.get(toUserId);
  if (decidedStep !== undefined) {
    problems.push(`"${toUserId}" already approved step "${decidedStep}" of this request`);
  }
  if (problems.length > 0) {
    throw new InvalidCommandError(`Cannot hand over task "${task.id}": ${problems.join("; ")}`);
  }

  task.decidedAt = ctx.now;
  const toTaskId = `${state.id}.t${state.lastTaskNumber + 1}`;
  if (returning) {
    close({ toTaskId, toUserId, returnedToOriginal: true });
    assignTask(draft, instance, { assigneeId: toUserId, chain: [toUserId], notes: [] }, undefined);
    return finish(draft);
  }
  const delegated = followDelegations(toUserId, {
    ...delegation,
    holders: new Set([...holders, toUserId]),
  });
  const vote = close({ toTaskId, toUserId });
  const onBehalfOf = vote ?? (delegated.assigneeId === toUserId ? undefined : toUserId);
  assignTask(draft, instance, delegated, onBehalfOf);
  return finish(draft);
}
