import type { Condition, FlowDefinition } from "./flow.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A flow definition pinned to the version assigned at registration. */
export interface RegisteredFlow extends FlowDefinition {
  readonly version: number;
  /** Set for a tenant's own flow; omitted for a global flow (EC-56). */
  readonly tenantId?: string;
}

/** The host record being approved. */
export interface Subject {
  type: string;
  id: string;
}

export type RequestStatus = "pending" | "approved" | "rejected" | "returned" | "withdrawn";
export type StepStatus =
  | "active"
  | "blocked"
  | "skipped"
  | "approved"
  | "rejected"
  | "returned"
  | "cancelled";
export type TaskStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "returned"
  | "superseded"
  | "delegated"
  | "reassigned"
  | "skipped-duplicate"
  | "cancelled"
  | "expired";

export type SkipReason =
  | { type: "condition-false"; condition: Condition }
  | { type: "no-approvers" };

/** Why a resolved user is not an approver of a step (EC-01, EC-06). */
export type RemovalReason = "inactive" | "requester" | "already-voted";

export interface RemovedApprover {
  userId: string;
  reason: RemovalReason;
}

/** Why a step cannot be activated with the approvers it resolved to (EC-02, EC-04, EC-45). */
export type ApproverShortfall =
  | { type: "no-approvers" }
  | { type: "quorum-unreachable"; required: number; available: number };

/** Timers of an active step with a deadline. Markers make `tick` idempotent (EC-27). */
export interface StepDeadline {
  deadlineAt: string;
  /** From `remindBefore`. */
  remindAt?: string;
  remindedAt?: string;
  /** When `onTimeout` was applied to this deadline. */
  timedOutAt?: string;
  /** Escalations so far (EC-28). */
  escalationDepth: number;
  /** Overdue reminders sent (EC-55). */
  reminders: number;
  nextReminderAt?: string;
}

/** Repeating reminder while a step is blocked (EC-53). */
export interface BlockedReminder {
  nextAt: string;
  count: number;
}

export interface Task {
  /** Derived from the request id: `${requestId}.t${n}`. */
  id: string;
  /** Who can act now. */
  assigneeId: string;
  /** The approver whose vote this task carries, when it reached the assignee by delegation. */
  onBehalfOf?: string;
  status: TaskStatus;
  assignedAt: string;
  decidedAt?: string;
  /** Set when the approver the task acts for decided it instead of its assignee (EC-60). */
  decidedBy?: string;
  comment?: string;
}

/**
 * One activation (or skip) of a step. A step can appear more than once after a return.
 * A `blocked` step resolved to too few approvers mid-flow and waits for an admin (EC-42).
 */
export interface StepInstance {
  stepId: string;
  /** Position of the step in the pinned flow definition. */
  index: number;
  status: StepStatus;
  activatedAt?: string;
  skippedAt?: string;
  blockedAt?: string;
  closedAt?: string;
  /**
   * Set when the instance stops counting after a return or a resubmit: its step will run again,
   * so its approvals no longer carry over (dedupe) or block delegation (EC-33, EC-34).
   */
  invalidatedAt?: string;
  skipReason?: SkipReason;
  blockReason?: ApproverShortfall;
  deadline?: StepDeadline;
  blockedReminder?: BlockedReminder;
  /** Snapshot of the approvers resolved at activation, after removals. */
  approvers: string[];
  /** Resolved users who were removed, with the reason. Absent when nobody was removed. */
  removed?: RemovedApprover[];
  tasks: Task[];
}

/** Everything the engine needs about one request. Plain JSON data. */
export interface RequestState {
  id: string;
  tenantId?: string;
  flowKey: string;
  flowVersion: number;
  /** Set when the pinned flow is a tenant's own flow rather than a global one (EC-56). */
  flowTenantId?: string;
  subject: Subject;
  requesterId: string;
  /** Snapshot taken at submit; conditions are evaluated against it (EC-36). */
  payload: JsonValue;
  status: RequestStatus;
  /** Index of the active step, or null when no step is active. */
  currentStepIndex: number | null;
  /** Optimistic-concurrency version; incremented by every decided command. */
  version: number;
  submittedAt: string;
  closedAt?: string;
  steps: StepInstance[];
  /** Highest audit `seq` written for this request. */
  lastAuditSeq: number;
  /** Counter used to derive task ids. */
  lastTaskNumber: number;
  /** While returned, when the requester is due to resubmit (EC-52). */
  resubmit?: { dueAt: string; remindedAt?: string };
  /** Earliest moment `tick` has something to do, or null. Lets a store find due requests. */
  nextDueAt: string | null;
}
