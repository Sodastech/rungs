import type { ComparisonOperator } from "./flow.js";
import type { ApproverShortfall, RemovedApprover } from "./state.js";

/** Base class for every error thrown by Rungs. `code` is stable and safe to branch on. */
export abstract class RungsError extends Error {
  abstract readonly code: string;
}

export interface FlowIssue {
  /** Location in the flow input, e.g. `"steps[1].deadline"`. Empty for the input itself. */
  readonly path: string;
  readonly message: string;
}

export class FlowDefinitionError extends RungsError {
  readonly code = "FLOW_INVALID";
  readonly issues: readonly FlowIssue[];

  constructor(issues: readonly FlowIssue[]) {
    const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
    const lines = issues.map((issue) => `- ${issue.path || "(flow)"}: ${issue.message}`);
    super(`Invalid flow definition (${count}):\n${lines.join("\n")}`);
    this.name = "FlowDefinitionError";
    this.issues = issues;
  }
}

/** Type of a payload value as reported by `ConditionError`; `"missing"` when the path does not exist. */
export type ReceivedType =
  | "missing"
  | "null"
  | "boolean"
  | "number"
  | "NaN"
  | "string"
  | "array"
  | "object"
  | "other";

export class ConditionError extends RungsError {
  readonly code = "CONDITION_INVALID";
  readonly field: string;
  readonly op: ComparisonOperator;
  readonly expected: "number" | "string";
  readonly received: ReceivedType;

  constructor(details: {
    field: string;
    op: ComparisonOperator;
    expected: "number" | "string";
    received: ReceivedType;
  }) {
    super(
      `Condition cannot be evaluated: "${details.field}" ${details.op} expects a field of type ` +
        `${details.expected}, received ${details.received}`,
    );
    this.name = "ConditionError";
    this.field = details.field;
    this.op = details.op;
    this.expected = details.expected;
    this.received = details.received;
  }
}

/** `createRungs` was given unusable options, or a configured function returned unusable data. */
export class ConfigurationError extends RungsError {
  readonly code = "CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class InvalidCommandError extends RungsError {
  readonly code = "COMMAND_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "InvalidCommandError";
  }
}

export class RequestNotFoundError extends RungsError {
  readonly code = "REQUEST_NOT_FOUND";
  readonly requestId: string;

  constructor(requestId: string) {
    super(`Request "${requestId}" does not exist`);
    this.name = "RequestNotFoundError";
    this.requestId = requestId;
  }
}

export class NotAssignedError extends RungsError {
  readonly code = "NOT_ASSIGNED";
  readonly requestId: string;
  readonly actorId: string;

  /** `role: "requester"` for commands only the requester may send (resubmit, withdraw). */
  constructor(details: { requestId: string; actorId: string; role?: "requester" }) {
    super(
      details.role === "requester"
        ? `"${details.actorId}" is not the requester of request "${details.requestId}"`
        : `"${details.actorId}" has no pending task on request "${details.requestId}"`,
    );
    this.name = "NotAssignedError";
    this.requestId = details.requestId;
    this.actorId = details.actorId;
  }
}

export class InvalidTransitionError extends RungsError {
  readonly code = "INVALID_TRANSITION";
  readonly requestId: string;
  /** Current request status, or `"exists"` when submitting over an existing request. */
  readonly status: string;
  readonly command: string;

  constructor(details: { requestId: string; status: string; command: string }) {
    super(
      `Cannot ${details.command} request "${details.requestId}" while its status is "${details.status}"`,
    );
    this.name = "InvalidTransitionError";
    this.requestId = details.requestId;
    this.status = details.status;
    this.command = details.command;
  }
}

/**
 * A host callback (role lookup, named resolver, `isActiveUser`) threw or returned invalid data
 * (EC-05). Nothing changed, so the command can be retried; the original error is in `cause`.
 */
export class ResolutionError extends RungsError {
  readonly code = "RESOLUTION_FAILED";
  readonly stepId: string;

  constructor(details: { stepId: string; cause: unknown }) {
    const detail = details.cause instanceof Error ? details.cause.message : String(details.cause);
    super(`Resolving the approvers of step "${details.stepId}" failed: ${detail}`, {
      cause: details.cause,
    });
    this.name = "ResolutionError";
    this.stepId = details.stepId;
  }
}

/**
 * A step resolved to too few approvers when the request was submitted (EC-02, EC-04, EC-43,
 * EC-45). This is a configuration or data problem: retrying the same command will not help.
 */
export class NoApproversError extends RungsError {
  readonly code = "NO_APPROVERS";
  readonly stepId: string;
  readonly reason: ApproverShortfall;
  readonly removed: readonly RemovedApprover[];

  constructor(details: {
    stepId: string;
    reason: ApproverShortfall;
    removed: readonly RemovedApprover[];
  }) {
    const problem =
      details.reason.type === "no-approvers"
        ? "has no approvers"
        : `needs ${details.reason.required} approvers but resolved to ${details.reason.available}`;
    const removed = details.removed.map((r) => `"${r.userId}" (${r.reason})`).join(", ");
    super(`Step "${details.stepId}" ${problem}${removed ? `; removed: ${removed}` : ""}`);
    this.name = "NoApproversError";
    this.stepId = details.stepId;
    this.reason = details.reason;
    this.removed = details.removed;
  }
}

/** `expectedVersion` did not match, or another command committed first (EC-15). Re-read and retry. */
export class ConflictError extends RungsError {
  readonly code = "VERSION_CONFLICT";
  readonly requestId: string;
  /** `null`: the request was expected not to exist yet. */
  readonly expectedVersion: number | null;
  /** `null`: the request does not exist. */
  readonly actualVersion: number | null;

  constructor(details: {
    requestId: string;
    expectedVersion: number | null;
    actualVersion: number | null;
  }) {
    super(
      `Request "${details.requestId}" is at version ${details.actualVersion ?? "none"}, expected ${details.expectedVersion ?? "none"}`,
    );
    this.name = "ConflictError";
    this.requestId = details.requestId;
    this.expectedVersion = details.expectedVersion;
    this.actualVersion = details.actualVersion;
  }
}

/** No flow with this key (and version) is registered for the tenant or globally (EC-56). */
export class FlowNotFoundError extends RungsError {
  readonly code = "FLOW_NOT_FOUND";
  readonly flowKey: string;
  readonly version?: number;
  readonly tenantId?: string;

  constructor(details: { flowKey: string; version?: number; tenantId?: string }) {
    const version = details.version === undefined ? "" : ` v${details.version}`;
    const scope =
      details.tenantId === undefined ? "" : ` for tenant "${details.tenantId}" or globally`;
    super(`Flow "${details.flowKey}"${version} is not registered${scope}`);
    this.name = "FlowNotFoundError";
    this.flowKey = details.flowKey;
    if (details.version !== undefined) this.version = details.version;
    if (details.tenantId !== undefined) this.tenantId = details.tenantId;
  }
}

/** The flow does not apply to the submitted payload: every step was skipped and `onAllSkipped` is "fail". */
export class FlowNotApplicableError extends RungsError {
  readonly code = "FLOW_NOT_APPLICABLE";
  readonly flowKey: string;
  readonly skippedStepIds: readonly string[];

  constructor(details: { flowKey: string; skippedStepIds: readonly string[] }) {
    super(
      `Flow "${details.flowKey}" does not apply to this request: every step was skipped ` +
        `(${details.skippedStepIds.join(", ")}) and the flow uses onAllSkipped "fail"`,
    );
    this.name = "FlowNotApplicableError";
    this.flowKey = details.flowKey;
    this.skippedStepIds = details.skippedStepIds;
  }
}
