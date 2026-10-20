// Public entry point: everything exported here is public API (see docs/04-api-design.md).

export { decide } from "./engine/decide.js";
export { defineFlow } from "./flow/define-flow.js";
export type {
  ApproveCommand,
  Command,
  DelegateCommand,
  OverrideCommand,
  ReassignStepCommand,
  ReassignTaskCommand,
  RejectCommand,
  RetryStepCommand,
  SubmitCommand,
} from "./model/command.js";
export type {
  DecidedResult,
  Decision,
  EngineContext,
  NeedsResolution,
  ResolutionNeed,
  StepResolution,
} from "./model/decision.js";
export type { DelegationRule, DelegationSkipReason } from "./model/delegation.js";
export type { FlowIssue, ReceivedType } from "./model/errors.js";
export {
  ConditionError,
  FlowDefinitionError,
  FlowNotApplicableError,
  InvalidCommandError,
  InvalidTransitionError,
  NoApproversError,
  NotAssignedError,
  RequestNotFoundError,
  ResolutionError,
  RungsError,
} from "./model/errors.js";
export type {
  AuditEvent,
  AuditEventBody,
  AuditEventType,
  DomainEvent,
  DomainEventBody,
  DomainEventType,
} from "./model/event.js";
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
export type {
  ApproverShortfall,
  JsonValue,
  RegisteredFlow,
  RemovalReason,
  RemovedApprover,
  RequestState,
  RequestStatus,
  SkipReason,
  StepInstance,
  StepStatus,
  Subject,
  Task,
  TaskStatus,
} from "./model/state.js";
