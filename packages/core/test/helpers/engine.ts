import {
  type ApproveCommand,
  type Calendar,
  type Command,
  type DecidedResult,
  type DelegateCommand,
  type DelegationRule,
  decide,
  defineFlow,
  type FlowInput,
  type OverrideCommand,
  type ReassignStepCommand,
  type ReassignTaskCommand,
  type RegisteredFlow,
  type RejectCommand,
  type RequestState,
  type ResubmitCommand,
  type RetryStepCommand,
  type ReturnCommand,
  type StepResolution,
  type SubmitCommand,
  type TickCommand,
  type Unchanged,
  type WithdrawCommand,
} from "../../src/index.js";

export const T0 = "2026-01-05T09:00:00.000Z";
export const T1 = "2026-01-05T10:00:00.000Z";
export const T2 = "2026-01-05T11:00:00.000Z";
export const T3 = "2026-01-05T12:00:00.000Z";

export function registeredFlow(input: FlowInput, version = 1): RegisteredFlow {
  return { ...defineFlow(input), version };
}

/** manager → finance (only when amount > 1000) → director */
export const expenseFlow = registeredFlow({
  key: "expense",
  steps: [
    { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
    {
      id: "finance",
      approvers: { type: "users", ids: ["u_fin"] },
      when: { field: "amount", op: "gt", value: 1000 },
    },
    { id: "director", approvers: { type: "users", ids: ["u_dir"] } },
  ],
});

export function submitCommand(overrides: Partial<SubmitCommand> = {}): SubmitCommand {
  return {
    type: "submit",
    requestId: "r1",
    requesterId: "u_req",
    subject: { type: "expense", id: "EXP-1" },
    payload: { amount: 5000 },
    ...overrides,
  };
}

export function approve(actorId: string, comment?: string): ApproveCommand {
  return { type: "approve", requestId: "r1", actorId, ...(comment ? { comment } : {}) };
}

export function reject(actorId: string, comment?: string): RejectCommand {
  return { type: "reject", requestId: "r1", actorId, ...(comment ? { comment } : {}) };
}

export function reassignStep(
  stepId: string,
  toUserIds: string[],
  comment = "Approver on leave",
): ReassignStepCommand {
  return { type: "reassign", requestId: "r1", adminId: "u_admin", stepId, toUserIds, comment };
}

export function reassignTask(
  taskId: string,
  toUserId: string,
  comment = "Approver left",
): ReassignTaskCommand {
  return { type: "reassign", requestId: "r1", adminId: "u_admin", taskId, toUserId, comment };
}

export function delegate(
  actorId: string,
  taskId: string,
  toUserId: string,
  comment?: string,
): DelegateCommand {
  return {
    type: "delegate",
    requestId: "r1",
    actorId,
    taskId,
    toUserId,
    ...(comment ? { comment } : {}),
  };
}

/** An out-of-office rule active for the whole of January 2026 unless overridden. */
export function rule(
  fromUserId: string,
  toUserId: string,
  overrides: Partial<DelegationRule> = {},
): DelegationRule {
  return {
    id: `d_${fromUserId}_${toUserId}`,
    fromUserId,
    toUserId,
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

export function returnTo(
  actorId: string,
  to: ReturnCommand["to"],
  comment?: string,
): ReturnCommand {
  return { type: "return", requestId: "r1", actorId, to, ...(comment ? { comment } : {}) };
}

export function resubmit(payload?: ResubmitCommand["payload"], actorId = "u_req"): ResubmitCommand {
  return {
    type: "resubmit",
    requestId: "r1",
    actorId,
    ...(payload === undefined ? {} : { payload }),
  };
}

export function withdraw(actorId = "u_req", comment?: string): WithdrawCommand {
  return { type: "withdraw", requestId: "r1", actorId, ...(comment ? { comment } : {}) };
}

export function retryStep(stepId: string): RetryStepCommand {
  return { type: "retry", requestId: "r1", adminId: "u_admin", stepId };
}

export function override(
  decision: "approve" | "reject",
  comment = "Board decision",
): OverrideCommand {
  return { type: "override", requestId: "r1", adminId: "u_admin", decision, comment };
}

export interface RunOptions {
  flow?: RegisteredFlow;
  now?: string;
  /** Approvers per need key (the step id). Static `users` specs default to their ids. */
  approvers?: Record<string, readonly string[]>;
  /** Users reported inactive by the host. */
  inactive?: readonly string[];
  /** Out-of-office rules the service would load; passed with every resolution. */
  delegations?: readonly DelegationRule[];
  calendar?: Calendar;
}

/**
 * Plays the service's role in the resolution loop: calls `decide`, answers every need from
 * `options.approvers` (or the static `users` list), and calls again until the engine decides.
 */
export function run(
  state: RequestState | null,
  command: Command,
  options: RunOptions = {},
): DecidedResult {
  const result = resolveAll(state, command, options);
  if (result.kind === "unchanged") throw new Error("expected the command to change the request");
  return result;
}

/** Runs one tick at `now`; `unchanged` when nothing was due. */
export function tick(
  state: RequestState,
  now: string,
  options: RunOptions = {},
): DecidedResult | Unchanged {
  return resolveAll(state, { type: "tick", requestId: state.id } satisfies TickCommand, {
    ...options,
    now,
  });
}

function resolveAll(
  state: RequestState | null,
  command: Command,
  options: RunOptions,
): DecidedResult | Unchanged {
  const flow = options.flow ?? expenseFlow;
  const resolutions: Record<string, StepResolution> = {};
  for (let attempt = 0; attempt <= flow.steps.length + 1; attempt++) {
    const decision = decide(state, command, {
      now: options.now ?? T0,
      flow,
      resolutions,
      ...(options.calendar ? { calendar: options.calendar } : {}),
    });
    if (decision.kind !== "needs-resolution") return decision;
    for (const need of decision.needs) {
      const userIds =
        options.approvers?.[need.key] ?? (need.spec.type === "users" ? need.spec.ids : undefined);
      if (userIds === undefined) throw new Error(`test gave no approvers for need "${need.key}"`);
      const inactiveUserIds = options.inactive?.filter((id) => id.length > 0) ?? [];
      resolutions[need.key] = {
        userIds,
        ...(inactiveUserIds.length > 0 ? { inactiveUserIds } : {}),
        ...(options.delegations ? { delegations: options.delegations } : {}),
      };
    }
  }
  throw new Error("resolution loop did not converge");
}

/** Runs a sequence of commands from scratch and returns the final result. */
export function runAll(commands: Command[], options: RunOptions = {}): DecidedResult {
  let state: RequestState | null = null;
  let result: DecidedResult | undefined;
  commands.forEach((command, i) => {
    result = run(state, command, { ...options, now: options.now ?? [T0, T1, T2, T3][i] ?? T3 });
    state = result.state;
  });
  if (!result) throw new Error("no commands");
  return result;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
