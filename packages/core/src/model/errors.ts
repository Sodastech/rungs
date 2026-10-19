import type { ComparisonOperator } from "./flow.js";

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

  constructor(details: { requestId: string; actorId: string }) {
    super(`"${details.actorId}" has no pending task on request "${details.requestId}"`);
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

export type ResolutionFailure = "no-approvers";

export class ResolutionError extends RungsError {
  readonly code = "RESOLUTION_FAILED";
  readonly stepId: string;
  readonly reason: ResolutionFailure;

  constructor(details: { stepId: string; reason: ResolutionFailure }) {
    super(`Step "${details.stepId}" has no approvers and the flow uses onEmptyStep "fail"`);
    this.name = "ResolutionError";
    this.stepId = details.stepId;
    this.reason = details.reason;
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
