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
