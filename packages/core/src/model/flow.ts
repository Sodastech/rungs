/**
 * ISO 8601 duration, restricted to fixed-length units: `PnW` or `PnDTnHnMnS` (e.g. `"P2D"`, `"PT8H"`).
 * Years and months are rejected because their length varies.
 */
export type Duration = string;

export type ApproverSpec =
  | { readonly type: "users"; readonly ids: readonly string[] }
  | { readonly type: "role"; readonly role: string }
  | { readonly type: "resolver"; readonly name: string; readonly params?: unknown }
  | { readonly type: "union"; readonly of: readonly ApproverSpec[] };

export type Primitive = string | number | boolean | null;

export type EqualityOperator = "eq" | "neq";
export type ComparisonOperator = "gt" | "gte" | "lt" | "lte";
export type MembershipOperator = "in" | "nin";
export type ConditionOperator = EqualityOperator | ComparisonOperator | MembershipOperator;

/** JSON rule evaluated against the request payload snapshot. `field` is a dot path. */
export type Condition =
  | { readonly field: string; readonly op: EqualityOperator; readonly value: Primitive }
  | { readonly field: string; readonly op: ComparisonOperator; readonly value: number | string }
  | {
      readonly field: string;
      readonly op: MembershipOperator;
      readonly value: readonly Primitive[];
    }
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition };

export type StepMode = "any" | "all" | { readonly quorum: number };
export type TimeoutAction = "remind" | "escalate" | "auto-approve" | "auto-reject";
export type EmptyStepPolicy = "fail" | "skip";
export type DedupePolicy = "none" | "consecutive" | "all";
export type ReturnPolicy = "restart" | "from-returned-step";
export type AllSkippedPolicy = "approve" | "fail";

export interface StepInput {
  readonly id: string;
  readonly name?: string;
  readonly approvers: ApproverSpec;
  /** Default `"any"`. */
  readonly mode?: StepMode;
  readonly when?: Condition;
  readonly deadline?: Duration;
  readonly remindBefore?: Duration;
  /** Default `"remind"`. Requires `deadline`. */
  readonly onTimeout?: TimeoutAction;
  /** Required when `onTimeout` is `"escalate"`, not allowed otherwise. */
  readonly escalateTo?: ApproverSpec;
}

export interface FlowInput {
  readonly key: string;
  readonly steps: readonly StepInput[];
  /** Default `"fail"`. */
  readonly onEmptyStep?: EmptyStepPolicy;
  /** Default `"consecutive"`. */
  readonly dedupeApprovers?: DedupePolicy;
  /** Default `false`. */
  readonly allowSelfApproval?: boolean;
  /** Default `"restart"`. */
  readonly returnPolicy?: ReturnPolicy;
  /** Default `"approve"`. */
  readonly onAllSkipped?: AllSkippedPolicy;
  /** Default `3`. */
  readonly maxEscalationDepth?: number;
}

export interface StepDefinition {
  readonly id: string;
  readonly name?: string;
  readonly approvers: ApproverSpec;
  readonly mode: StepMode;
  readonly when?: Condition;
  readonly deadline?: Duration;
  readonly remindBefore?: Duration;
  /** Present exactly when `deadline` is set (default `"remind"`). */
  readonly onTimeout?: TimeoutAction;
  readonly escalateTo?: ApproverSpec;
}

/** A validated flow with every default applied. Deeply frozen. */
export interface FlowDefinition {
  readonly key: string;
  readonly steps: readonly StepDefinition[];
  readonly onEmptyStep: EmptyStepPolicy;
  readonly dedupeApprovers: DedupePolicy;
  readonly allowSelfApproval: boolean;
  readonly returnPolicy: ReturnPolicy;
  readonly onAllSkipped: AllSkippedPolicy;
  readonly maxEscalationDepth: number;
}
