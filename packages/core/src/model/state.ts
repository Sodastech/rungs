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
}

/** The host record being approved. */
export interface Subject {
  type: string;
  id: string;
}

export type RequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "returned"
  | "withdrawn"
  | "cancelled";
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
export type RemovalReason = "inactive" | "requester";

export interface RemovedApprover {
  userId: string;
  reason: RemovalReason;
}

/** Why a step cannot be activated with the approvers it resolved to (EC-02, EC-04, EC-45). */
export type ApproverShortfall =
  | { type: "no-approvers" }
  | { type: "quorum-unreachable"; required: number; available: number };

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
  skipReason?: SkipReason;
  blockReason?: ApproverShortfall;
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
}
