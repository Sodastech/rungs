// Public entry point: everything exported here is public API (see docs/04-api-design.md).

export { defineFlow } from "./flow/define-flow.js";
export type { FlowIssue, ReceivedType } from "./model/errors.js";
export { ConditionError, FlowDefinitionError, RungsError } from "./model/errors.js";
export type {
  AllSkippedPolicy,
  ApproverSpec,
  ComparisonOperator,
  Condition,
  ConditionOperator,
  DedupePolicy,
  Duration,
  EmptyStepPolicy,
  EqualityOperator,
  FlowDefinition,
  FlowInput,
  MembershipOperator,
  Primitive,
  ReturnPolicy,
  StepDefinition,
  StepInput,
  StepMode,
  TimeoutAction,
} from "./model/flow.js";
