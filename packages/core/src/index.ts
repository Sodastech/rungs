/**
 * Rungs for applications: `createRungs`, flows, commands, queries, events and errors.
 * No dependencies, no I/O. Store adapters use `@rungsjs/core/store`; the pure engine is
 * `@rungsjs/core/engine`.
 *
 * @packageDocumentation
 * @module @rungsjs/core
 */

// Public entry point: everything exported here is public API (see docs/04-api-design.md).

export type { PreviewResult, PreviewStep } from "./engine/preview.js";
export { defineFlow } from "./flow/define-flow.js";
export type { Calendar } from "./model/decision.js";
export type { DelegationRule, DelegationSkipReason } from "./model/delegation.js";
export type { FlowIssue, ReceivedType } from "./model/errors.js";
export {
  ConditionError,
  ConfigurationError,
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
export type { BlockedStepView, RequestSummary, RungsStore, TaskView } from "./model/store.js";
export type {
  ResolutionHooks,
  ResolveContext,
  ResolveRequest,
  ResolverArgs,
} from "./resolution/collect.js";
export {
  type ApproveInput,
  type CommandOptions,
  createRungs,
  type DelegateInput,
  type DispatchOptions,
  type DispatchSummary,
  type OverrideInput,
  type ReassignInput,
  type RejectInput,
  type ResubmitInput,
  type RetryInput,
  type ReturnInput,
  type Rungs,
  type RungsOptions,
  type SubmitInput,
  type TickOptions,
  type TickSummary,
  type WithdrawInput,
} from "./service/create-rungs.js";
export type { FlowRegistration, FlowRegistry } from "./service/flows.js";
export type {
  BlockedInput,
  BlockedPage,
  DelegationInput,
  Delegations,
  InboxEntry,
  InboxInput,
  InboxPage,
  PreviewRequestInput,
  Queries,
  RequestsInput,
  RequestsPage,
} from "./service/queries.js";
