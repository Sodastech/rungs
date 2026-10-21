import type { DelegationRule } from "./delegation.js";
import type { AuditEvent, DomainEvent } from "./event.js";
import type {
  ApproverShortfall,
  JsonValue,
  RegisteredFlow,
  RemovedApprover,
  RequestState,
  RequestStatus,
  Subject,
} from "./state.js";

/** A flow belongs to one tenant, or is global when `tenantId` is omitted. No version: the latest. */
export interface FlowRef {
  readonly key: string;
  readonly tenantId?: string;
  readonly version?: number;
}

/** An idempotency key is scoped per tenant (EC-57); global when `tenantId` is omitted. */
export interface IdempotencyRef {
  readonly key: string;
  readonly tenantId?: string;
}

export interface EventKey {
  readonly requestId: string;
  readonly seq: number;
}

export interface OutboxEntry {
  readonly event: DomainEvent;
  /** Failed deliveries so far. */
  readonly attempts: number;
  /** ISO 8601 UTC. */
  readonly nextAttemptAt: string;
  readonly lastError?: string;
}

export interface IdempotentRecord {
  /** Canonical form of the command, so a key reused for another command is refused. */
  readonly fingerprint: string;
  /** What the first call returned. */
  readonly result: RequestState;
  readonly at: string;
}

/** A pending task as the inbox lists it. */
export interface TaskView {
  readonly requestId: string;
  readonly tenantId?: string;
  readonly flowKey: string;
  readonly flowVersion: number;
  readonly subject: Subject;
  readonly requesterId: string;
  readonly stepId: string;
  readonly taskId: string;
  readonly assigneeId: string;
  readonly onBehalfOf?: string;
  readonly assignedAt: string;
  readonly deadlineAt?: string;
  /** In the inbox of the approver a task acts for: the delegate holding it (EC-60). */
  readonly heldBy?: string;
  /** The request payload, for display. It may contain personal data. */
  readonly payload: JsonValue;
}

/** A request as `findRequests` and `rungs.requests` list it. */
export interface RequestSummary {
  readonly id: string;
  readonly tenantId?: string;
  readonly flowKey: string;
  readonly flowVersion: number;
  readonly subject: Subject;
  readonly requesterId: string;
  readonly status: RequestStatus;
  readonly submittedAt: string;
  readonly closedAt?: string;
  /** Pass as `expectedVersion` to act on what was listed (EC-15). */
  readonly version: number;
  /** The request payload, for display. It may contain personal data. */
  readonly payload: JsonValue;
  /** The step waiting for a decision (`active`) or for an admin (`blocked`); null otherwise. */
  readonly openStep: { readonly stepId: string; readonly status: "active" | "blocked" } | null;
}

export interface RequestQuery {
  /** Omitted: only requests without a tenant, so nothing leaks across tenants. */
  readonly tenantId?: string;
  readonly requesterId?: string;
  /** Any of these statuses; omitted: every status. */
  readonly statuses?: readonly RequestStatus[];
  /** Requests about one host record (`type` and `id`) or one kind of record (`type` only). */
  readonly subject?: { readonly type: string; readonly id?: string };
  readonly flowKey?: string;
  readonly limit: number;
  /** Continue after this request, in (`submittedAt` desc, `id` desc) order: newest first. */
  readonly after?: { readonly submittedAt: string; readonly id: string };
}

/** A blocked step as `findBlocked` and `rungs.blocked` list it (EC-42). */
export interface BlockedStepView {
  readonly requestId: string;
  readonly tenantId?: string;
  readonly flowKey: string;
  readonly flowVersion: number;
  readonly subject: Subject;
  readonly requesterId: string;
  /** The request payload, for display. It may contain personal data. */
  readonly payload: JsonValue;
  readonly stepId: string;
  readonly blockedAt: string;
  readonly reason: ApproverShortfall;
  /** Who the resolution removed, and why. Empty when nobody was removed. */
  readonly removed: readonly RemovedApprover[];
  /** Pass as `expectedVersion` to `reassign` or `retry` (EC-15). */
  readonly version: number;
}

export interface BlockedQuery {
  /** Omitted: only requests without a tenant. */
  readonly tenantId?: string;
  readonly limit: number;
  /** Continue after this step, in (`blockedAt`, `requestId`) order: blocked longest first. */
  readonly after?: { readonly blockedAt: string; readonly requestId: string };
}

export interface InboxQuery {
  readonly userId: string;
  /** Omitted: only requests without a tenant, so nothing leaks across tenants. */
  readonly tenantId?: string;
  readonly limit: number;
  /** Continue after this task, in (`assignedAt`, `taskId`) order. */
  readonly after?: { readonly assignedAt: string; readonly taskId: string };
}

/**
 * `claim: true` is passed by `tick` and event delivery. An adapter may then lease what it returns
 * for a short time, so that concurrent workers skip it instead of doing the same work twice (the
 * PostgreSQL store does, with `FOR UPDATE SKIP LOCKED`). Without it nothing is leased, so reads for
 * inspection never hide anything. Correctness never depends on the lease (EC-27).
 */
export interface ClaimOptions {
  readonly claim?: boolean;
}

/** Persistence for the service. Everything passed in and out is plain JSON. */
export interface RungsStore {
  /** Runs `fn` atomically: all writes commit together, or none do when `fn` throws. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
}

export interface StoreTx {
  /** Matches the scope exactly; versions are numbered per (tenantId, key). */
  getFlow(ref: FlowRef): Promise<RegisteredFlow | null>;
  /** `flow.tenantId` sets the scope. */
  saveFlow(flow: RegisteredFlow): Promise<void>;

  getRequest(id: string, opts?: { forUpdate?: boolean }): Promise<RequestState | null>;
  /**
   * Compare-and-set on `version`: `expectedVersion` null means the request must not exist yet.
   * A mismatch throws `ConflictError` (EC-15).
   */
  saveRequest(state: RequestState, expectedVersion: number | null): Promise<void>;
  appendAudit(events: readonly AuditEvent[]): Promise<void>;
  /** Ids of requests with `nextDueAt <= now`, earliest first. */
  findDue(now: string, limit: number, options?: ClaimOptions): Promise<string[]>;

  /** Adds events with zero attempts, due at `now`. */
  enqueueEvents(events: readonly DomainEvent[], now: string): Promise<void>;
  /**
   * Due entries (`nextAttemptAt <= now`), never one while an earlier entry of the same request is
   * still undelivered: each request contributes its due events in `seq` order from its oldest
   * undelivered one. Requests are ordered by that oldest event's `nextAttemptAt`, then by id.
   */
  pendingEvents(
    query: { now: string; limit: number; requestId?: string } & ClaimOptions,
  ): Promise<OutboxEntry[]>;
  /** `now`: when they were delivered; adapters that keep delivered events may record it. */
  markDispatched(keys: readonly EventKey[], now?: string): Promise<void>;
  markFailed(
    key: EventKey,
    failure: { attempts: number; nextAttemptAt: string; error: string },
  ): Promise<void>;

  getIdempotent(ref: IdempotencyRef): Promise<IdempotentRecord | null>;
  putIdempotent(ref: IdempotencyRef, record: IdempotentRecord): Promise<void>;

  /** Audit events of one request, ordered by `seq`. */
  getAudit(requestId: string): Promise<AuditEvent[]>;
  /**
   * Pending tasks on active steps of pending requests that the user holds (`assigneeId`) or that a
   * delegate holds on the user's behalf (`onBehalfOf`, EC-60), ordered by (`assignedAt`, `taskId`).
   * The tenant must match exactly. Adapters return the task as stored; the service adds `heldBy`.
   */
  findInbox(query: InboxQuery): Promise<TaskView[]>;
  /**
   * Requests matching every given filter, newest first by (`submittedAt` desc, `id` desc). The
   * tenant must match exactly. Build each item with `requestSummary(state)`.
   */
  findRequests(query: RequestQuery): Promise<RequestSummary[]>;
  /**
   * Blocked steps of pending requests, blocked longest first by (`blockedAt`, `requestId`). The
   * tenant must match exactly. Build each item with `blockedStepView(state)`.
   */
  findBlocked(query: BlockedQuery): Promise<BlockedStepView[]>;

  /**
   * Every rule of these users, active or not; the engine filters by time, scope and tenant.
   * With a `tenantId`: rules of that tenant and rules without one. Without: rules without one.
   */
  findDelegations(fromUserIds: readonly string[], tenantId?: string): Promise<DelegationRule[]>;
  /** Inserts or replaces the rule with this id. */
  saveDelegation(rule: DelegationRule): Promise<void>;
  getDelegation(id: string): Promise<DelegationRule | null>;
  /** Rules from or to the user, with the same tenant matching as `findDelegations`. */
  listDelegations(query: { userId: string; tenantId?: string }): Promise<DelegationRule[]>;
}
