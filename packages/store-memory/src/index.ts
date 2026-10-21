/**
 * An in-memory store for tests and prototypes.
 *
 * @packageDocumentation
 * @module @rungsjs/store-memory
 */

// Public entry point: everything exported here is public API.

import {
  type AuditEvent,
  type BlockedStepView,
  blockedStepView,
  ConflictError,
  type DelegationRule,
  type EventKey,
  type FlowRef,
  type IdempotencyRef,
  type IdempotentRecord,
  type OutboxEntry,
  type RegisteredFlow,
  type RequestState,
  type RungsStore,
  requestSummary,
  type StoreTx,
  type TaskView,
  taskViews,
} from "@rungsjs/core";

export interface MemoryStoreOptions {
  /** Out-of-office rules to start with (managing them through the service comes later). */
  readonly delegations?: readonly DelegationRule[];
}

/** Everything the store holds, as copies. For tests and debugging. */
export interface MemorySnapshot {
  readonly flows: RegisteredFlow[];
  readonly requests: RequestState[];
  readonly audit: AuditEvent[];
  readonly outbox: OutboxEntry[];
  readonly idempotency: { ref: IdempotencyRef; record: IdempotentRecord }[];
  readonly delegations: DelegationRule[];
}

export interface MemoryStore extends RungsStore {
  snapshot(): MemorySnapshot;
}

interface Data {
  flows: RegisteredFlow[];
  requests: Record<string, RequestState>;
  audit: AuditEvent[];
  outbox: OutboxEntry[];
  idempotency: { ref: IdempotencyRef; record: IdempotentRecord }[];
  delegations: DelegationRule[];
}

/**
 * An in-memory `RungsStore` for tests and prototypes. Transactions run one at a time on a copy
 * of the data, which replaces the data on success and is dropped when the callback throws.
 */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  let data: Data = {
    flows: [],
    requests: {},
    audit: [],
    outbox: [],
    idempotency: [],
    delegations: copy([...(options.delegations ?? [])]),
  };
  let queue: Promise<unknown> = Promise.resolve();

  return {
    transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
      const run = queue.then(async () => {
        const working = copy(data);
        const result = await fn(transactionOn(working));
        data = working;
        return copy(result);
      });
      queue = run.catch(() => undefined);
      return run;
    },
    snapshot(): MemorySnapshot {
      return copy({ ...data, requests: Object.values(data.requests) });
    },
  };
}

function transactionOn(data: Data): StoreTx {
  return {
    async getFlow(ref: FlowRef) {
      const matching = data.flows.filter(
        (f) =>
          f.key === ref.key &&
          f.tenantId === ref.tenantId &&
          (ref.version === undefined || f.version === ref.version),
      );
      const latest = matching.reduce<RegisteredFlow | null>(
        (best, f) => (best === null || f.version > best.version ? f : best),
        null,
      );
      return copy(latest);
    },
    async saveFlow(flow) {
      data.flows.push(copy(flow));
    },
    async getRequest(id) {
      return copy(data.requests[id] ?? null);
    },
    async saveRequest(state, expectedVersion) {
      const current = data.requests[state.id];
      const actual = current?.version ?? null;
      if (actual !== expectedVersion) {
        throw new ConflictError({ requestId: state.id, expectedVersion, actualVersion: actual });
      }
      data.requests[state.id] = copy(state);
    },
    async appendAudit(events) {
      data.audit.push(...copy([...events]));
    },
    async findDue(now, limit) {
      return Object.values(data.requests)
        .filter((r) => r.nextDueAt !== null && Date.parse(r.nextDueAt) <= Date.parse(now))
        .sort((a, b) => Date.parse(a.nextDueAt as string) - Date.parse(b.nextDueAt as string))
        .slice(0, limit)
        .map((r) => r.id);
    },
    async enqueueEvents(events, now) {
      for (const event of events) {
        data.outbox.push({ event: copy(event), attempts: 0, nextAttemptAt: now });
      }
    },
    async pendingEvents({ now, limit, requestId }) {
      return copy(pending(data.outbox, now, requestId).slice(0, limit));
    },
    async markDispatched(keys) {
      data.outbox = data.outbox.filter((entry) => !keys.some((key) => same(entry.event, key)));
    },
    async markFailed(key, failure) {
      data.outbox = data.outbox.map((entry) =>
        same(entry.event, key)
          ? {
              ...entry,
              attempts: failure.attempts,
              nextAttemptAt: failure.nextAttemptAt,
              lastError: failure.error,
            }
          : entry,
      );
    },
    async getIdempotent(ref) {
      const found = data.idempotency.find(
        (entry) => entry.ref.key === ref.key && entry.ref.tenantId === ref.tenantId,
      );
      return copy(found?.record ?? null);
    },
    async putIdempotent(ref, record) {
      data.idempotency.push(copy({ ref: scoped(ref), record }));
    },
    async getAudit(requestId) {
      return copy(
        data.audit.filter((e) => e.requestId === requestId).sort((a, b) => a.seq - b.seq),
      );
    },
    async findInbox({ userId, tenantId, limit, after }) {
      const views: TaskView[] = Object.values(data.requests)
        .filter((request) => request.tenantId === tenantId)
        .flatMap(taskViews)
        .filter((view) => view.assigneeId === userId || view.onBehalfOf === userId);
      const order = (v: { assignedAt: string; taskId: string }) =>
        [Date.parse(v.assignedAt), v.taskId] as const;
      const before = (
        a: { assignedAt: string; taskId: string },
        b: { assignedAt: string; taskId: string },
      ) => {
        const [ta, ia] = order(a);
        const [tb, ib] = order(b);
        return ta !== tb ? ta < tb : ia < ib;
      };
      views.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
      const start = after === undefined ? views : views.filter((v) => before(after, v));
      return copy(start.slice(0, limit));
    },
    async findRequests({ tenantId, requesterId, statuses, subject, flowKey, limit, after }) {
      type Key = { submittedAt: string; id: string };
      const newer = (a: Key, b: Key) => {
        const ta = Date.parse(a.submittedAt);
        const tb = Date.parse(b.submittedAt);
        return ta !== tb ? ta > tb : a.id > b.id;
      };
      const rows = Object.values(data.requests)
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            (requesterId === undefined || r.requesterId === requesterId) &&
            (statuses === undefined || statuses.includes(r.status)) &&
            (subject === undefined ||
              (r.subject.type === subject.type &&
                (subject.id === undefined || r.subject.id === subject.id))) &&
            (flowKey === undefined || r.flowKey === flowKey),
        )
        .map(requestSummary)
        .sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
      const start = after === undefined ? rows : rows.filter((r) => newer(after, r));
      return copy(start.slice(0, limit));
    },
    async findBlocked({ tenantId, limit, after }) {
      const earlier = (
        a: { blockedAt: string; requestId: string },
        b: { blockedAt: string; requestId: string },
      ) => {
        const ta = Date.parse(a.blockedAt);
        const tb = Date.parse(b.blockedAt);
        return ta !== tb ? ta < tb : a.requestId < b.requestId;
      };
      const rows = Object.values(data.requests)
        .filter((r) => r.tenantId === tenantId)
        .map(blockedStepView)
        .filter((view): view is BlockedStepView => view !== null)
        .sort((a, b) => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0));
      const start = after === undefined ? rows : rows.filter((v) => earlier(after, v));
      return copy(start.slice(0, limit));
    },
    async findDelegations(fromUserIds, tenantId) {
      return copy(
        data.delegations.filter(
          (rule) =>
            fromUserIds.includes(rule.fromUserId) &&
            (rule.tenantId === undefined || rule.tenantId === tenantId),
        ),
      );
    },
    async saveDelegation(rule) {
      data.delegations = [...data.delegations.filter((r) => r.id !== rule.id), copy(rule)];
    },
    async getDelegation(id) {
      return copy(data.delegations.find((r) => r.id === id) ?? null);
    },
    async listDelegations({ userId, tenantId }) {
      return copy(
        data.delegations.filter(
          (rule) =>
            (rule.fromUserId === userId || rule.toUserId === userId) &&
            (rule.tenantId === undefined || rule.tenantId === tenantId),
        ),
      );
    },
  };
}

/**
 * Due chains of undelivered events: each request contributes its events in `seq` order, starting
 * with its oldest undelivered one, as long as they are due. Requests are ordered by the
 * `nextAttemptAt` of that oldest event, then by id.
 */
function pending(outbox: readonly OutboxEntry[], now: string, requestId?: string): OutboxEntry[] {
  const byRequest = new Map<string, OutboxEntry[]>();
  for (const entry of outbox) {
    if (requestId !== undefined && entry.event.requestId !== requestId) continue;
    const list = byRequest.get(entry.event.requestId) ?? [];
    list.push(entry);
    byRequest.set(entry.event.requestId, list);
  }
  const chains: OutboxEntry[][] = [];
  for (const list of byRequest.values()) {
    list.sort((a, b) => a.event.seq - b.event.seq);
    const chain: OutboxEntry[] = [];
    for (const entry of list) {
      if (Date.parse(entry.nextAttemptAt) > Date.parse(now)) break;
      chain.push(entry);
    }
    if (chain.length > 0) chains.push(chain);
  }
  chains.sort((a, b) => {
    const [x, y] = [a[0] as OutboxEntry, b[0] as OutboxEntry];
    const byTime = Date.parse(x.nextAttemptAt) - Date.parse(y.nextAttemptAt);
    if (byTime !== 0) return byTime;
    return x.event.requestId < y.event.requestId ? -1 : 1;
  });
  return chains.flat();
}

function same(event: { requestId: string; seq: number }, key: EventKey): boolean {
  return event.requestId === key.requestId && event.seq === key.seq;
}

function scoped(ref: IdempotencyRef): IdempotencyRef {
  return ref.tenantId === undefined ? { key: ref.key } : { key: ref.key, tenantId: ref.tenantId };
}

/** Plain JSON copy; `undefined` stays `undefined`. */
function copy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
