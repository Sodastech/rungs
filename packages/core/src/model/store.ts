import type { DelegationRule } from "./delegation.js";
import type { AuditEvent, DomainEvent } from "./event.js";
import type { RegisteredFlow, RequestState } from "./state.js";

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
  findDue(now: string, limit: number): Promise<string[]>;

  /** Adds events with zero attempts, due at `now`. */
  enqueueEvents(events: readonly DomainEvent[], now: string): Promise<void>;
  /**
   * Due entries (`nextAttemptAt <= now`), never one while an earlier entry of the same request is
   * still undelivered: each request contributes its due events in `seq` order from its oldest
   * undelivered one. Requests are ordered by that oldest event's `nextAttemptAt`, then by id.
   */
  pendingEvents(query: { now: string; limit: number; requestId?: string }): Promise<OutboxEntry[]>;
  markDispatched(keys: readonly EventKey[]): Promise<void>;
  markFailed(
    key: EventKey,
    failure: { attempts: number; nextAttemptAt: string; error: string },
  ): Promise<void>;

  getIdempotent(ref: IdempotencyRef): Promise<IdempotentRecord | null>;
  putIdempotent(ref: IdempotencyRef, record: IdempotentRecord): Promise<void>;

  /** Every rule of these users, active or not; the engine filters by time, scope and tenant. */
  findDelegations(fromUserIds: readonly string[], tenantId?: string): Promise<DelegationRule[]>;
}
