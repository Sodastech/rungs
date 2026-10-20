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
  ResubmitCommand,
  RetryStepCommand,
  ReturnCommand,
  SubmitCommand,
  TickCommand,
  WithdrawCommand,
} from "./model/command.js";
export type {
  Calendar,
  DecidedResult,
  Decision,
  EngineContext,
  NeedsResolution,
  ResolutionNeed,
  StepResolution,
  Unchanged,
} from "./model/decision.js";
export type { DelegationRule, DelegationSkipReason } from "./model/delegation.js";
export type { FlowIssue, ReceivedType } from "./model/errors.js";
export {
  ConditionError,
  ConflictError,
  FlowDefinitionError,
  FlowNotApplicableError,
  FlowNotFoundError,
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
  ReminderInterval,
  ResubmitTimeoutAction,
  ReturnPolicy,
  StepDefinition,
  StepInput,
  StepMode,
  TimeoutAction,
} from "./model/flow.js";
export type {
  ApproverShortfall,
  BlockedReminder,
  JsonValue,
  RegisteredFlow,
  RemovalReason,
  RemovedApprover,
  RequestState,
  RequestStatus,
  SkipReason,
  StepDeadline,
  StepInstance,
  StepStatus,
  Subject,
  Task,
  TaskStatus,
} from "./model/state.js";
export type {
  EventKey,
  FlowRef,
  IdempotencyRef,
  IdempotentRecord,
  OutboxEntry,
  RungsStore,
  StoreTx,
} from "./model/store.js";
export type {
  ResolutionHooks,
  ResolveContext,
  ResolveRequest,
  ResolverArgs,
} from "./resolution/collect.js";
export {
  type CommandOptions,
  createRungs,
  type DispatchSummary,
  type Rungs,
  type RungsOptions,
  type SubmitInput,
  type TickSummary,
} from "./service/create-rungs.js";
export type { FlowRegistration, FlowRegistry } from "./service/flows.js";
