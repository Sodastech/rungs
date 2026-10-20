import {
  ConflictError,
  type DomainEvent,
  defineFlow,
  type RegisteredFlow,
  type RequestState,
} from "@rungs/core";
import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/index.js";

const NOW = "2026-01-05T09:00:00.000Z";
const LATER = "2026-01-05T10:00:00.000Z";

function request(overrides: Partial<RequestState> = {}): RequestState {
  return {
    id: "r1",
    flowKey: "expense",
    flowVersion: 1,
    subject: { type: "expense", id: "EXP-1" },
    requesterId: "u_req",
    payload: { amount: 5 },
    status: "pending",
    currentStepIndex: 0,
    version: 1,
    submittedAt: NOW,
    steps: [],
    lastAuditSeq: 1,
    lastTaskNumber: 0,
    nextDueAt: null,
    ...overrides,
  };
}

function flow(version: number, tenantId?: string): RegisteredFlow {
  const definition = defineFlow({
    key: "expense",
    steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
  });
  return { ...definition, version, ...(tenantId ? { tenantId } : {}) };
}

function event(requestId: string, seq: number): DomainEvent {
  return {
    requestId,
    seq,
    actorId: "u_req",
    at: NOW,
    type: "request.submitted",
    data: { flowKey: "expense", flowVersion: 1, subject: { type: "expense", id: "EXP-1" } },
  };
}

describe("memoryStore", () => {
  it("commits a transaction's writes together", async () => {
    const store = memoryStore();
    await store.transaction(async (tx) => {
      await tx.saveRequest(request(), null);
      await tx.appendAudit([]);
    });
    const loaded = await store.transaction((tx) => tx.getRequest("r1"));
    expect(loaded?.version).toBe(1);
  });

  it("rolls back every write when the transaction throws", async () => {
    const store = memoryStore();
    const failing = store.transaction(async (tx) => {
      await tx.saveRequest(request(), null);
      await tx.enqueueEvents([event("r1", 1)], NOW);
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await store.transaction((tx) => tx.getRequest("r1"))).toBeNull();
    expect(store.snapshot().outbox).toEqual([]);
  });

  it("serializes transactions so each one sees the previous commit", async () => {
    const store = memoryStore();
    await store.transaction((tx) => tx.saveRequest(request(), null));
    const bump = () =>
      store.transaction(async (tx) => {
        const current = (await tx.getRequest("r1")) as RequestState;
        await tx.saveRequest({ ...current, version: current.version + 1 }, current.version);
      });
    await Promise.all([bump(), bump(), bump()]);
    expect((await store.transaction((tx) => tx.getRequest("r1")))?.version).toBe(4);
  });

  it("never shares objects with the caller", async () => {
    const store = memoryStore();
    const state = request();
    await store.transaction((tx) => tx.saveRequest(state, null));
    state.status = "approved";
    const loaded = (await store.transaction((tx) => tx.getRequest("r1"))) as RequestState;
    expect(loaded.status).toBe("pending");
    loaded.status = "rejected";
    expect((await store.transaction((tx) => tx.getRequest("r1")))?.status).toBe("pending");
  });

  it("EC-15 saveRequest is a compare-and-set on the version", async () => {
    const store = memoryStore();
    await store.transaction((tx) => tx.saveRequest(request(), null));
    const exists = store.transaction((tx) => tx.saveRequest(request(), null));
    await expect(exists).rejects.toBeInstanceOf(ConflictError);
    const stale = await store
      .transaction((tx) => tx.saveRequest(request({ version: 3 }), 2))
      .catch((e: unknown) => e);
    expect(stale).toMatchObject({
      code: "VERSION_CONFLICT",
      requestId: "r1",
      expectedVersion: 2,
      actualVersion: 1,
    });
    await store.transaction((tx) => tx.saveRequest(request({ version: 2 }), 1));
  });

  it("EC-56 numbers flow versions per tenant and key, and matches the scope exactly", async () => {
    const store = memoryStore();
    await store.transaction(async (tx) => {
      await tx.saveFlow(flow(1));
      await tx.saveFlow(flow(2));
      await tx.saveFlow(flow(1, "acme"));
    });
    const get = (ref: { key: string; tenantId?: string; version?: number }) =>
      store.transaction((tx) => tx.getFlow(ref));
    expect((await get({ key: "expense" }))?.version).toBe(2);
    expect((await get({ key: "expense", version: 1 }))?.tenantId).toBeUndefined();
    expect(await get({ key: "expense", tenantId: "acme" })).toMatchObject({
      version: 1,
      tenantId: "acme",
    });
    expect(await get({ key: "expense", tenantId: "globex" })).toBeNull();
    expect(await get({ key: "expense", version: 9 })).toBeNull();
  });

  it("finds due requests earliest first", async () => {
    const store = memoryStore();
    await store.transaction(async (tx) => {
      await tx.saveRequest(request({ id: "a", nextDueAt: LATER }), null);
      await tx.saveRequest(request({ id: "b", nextDueAt: NOW }), null);
      await tx.saveRequest(request({ id: "c", nextDueAt: "2026-01-06T00:00:00.000Z" }), null);
      await tx.saveRequest(request({ id: "d" }), null);
    });
    expect(await store.transaction((tx) => tx.findDue(LATER, 10))).toEqual(["b", "a"]);
    expect(await store.transaction((tx) => tx.findDue(LATER, 1))).toEqual(["b"]);
  });

  describe("outbox", () => {
    it("returns due entries in order and keeps each request's events in sequence", async () => {
      const store = memoryStore();
      await store.transaction(async (tx) => {
        await tx.enqueueEvents([event("r1", 1), event("r1", 2)], NOW);
        await tx.enqueueEvents([event("r2", 1)], NOW);
      });
      const pending = await store.transaction((tx) => tx.pendingEvents({ now: NOW, limit: 10 }));
      expect(pending.map((e) => [e.event.requestId, e.event.seq, e.attempts])).toEqual([
        ["r1", 1, 0],
        ["r1", 2, 0],
        ["r2", 1, 0],
      ]);
      const forR2 = await store.transaction((tx) =>
        tx.pendingEvents({ now: NOW, limit: 10, requestId: "r2" }),
      );
      expect(forR2.map((e) => e.event.seq)).toEqual([1]);
    });

    it("a failed event waits out its backoff and holds back only its own request", async () => {
      const store = memoryStore();
      await store.transaction(async (tx) => {
        await tx.enqueueEvents([event("r1", 1), event("r1", 2), event("r2", 1)], NOW);
        await tx.markFailed(
          { requestId: "r1", seq: 1 },
          { attempts: 1, nextAttemptAt: LATER, error: "smtp down" },
        );
      });
      const now = await store.transaction((tx) => tx.pendingEvents({ now: NOW, limit: 1 }));
      expect(now.map((e) => [e.event.requestId, e.event.seq])).toEqual([["r2", 1]]);
      const later = await store.transaction((tx) => tx.pendingEvents({ now: LATER, limit: 10 }));
      expect(later.map((e) => [e.event.requestId, e.event.seq, e.attempts, e.lastError])).toEqual([
        ["r2", 1, 0, undefined],
        ["r1", 1, 1, "smtp down"],
        ["r1", 2, 0, undefined],
      ]);
    });

    it("dispatched events leave the outbox", async () => {
      const store = memoryStore();
      await store.transaction(async (tx) => {
        await tx.enqueueEvents([event("r1", 1), event("r1", 2)], NOW);
        await tx.markDispatched([{ requestId: "r1", seq: 1 }]);
      });
      const pending = await store.transaction((tx) => tx.pendingEvents({ now: NOW, limit: 10 }));
      expect(pending.map((e) => e.event.seq)).toEqual([2]);
    });
  });

  it("EC-57 scopes idempotency keys per tenant", async () => {
    const store = memoryStore();
    const record = { fingerprint: "f", result: request(), at: NOW };
    await store.transaction((tx) => tx.putIdempotent({ key: "k", tenantId: "acme" }, record));
    expect(
      await store.transaction((tx) => tx.getIdempotent({ key: "k", tenantId: "acme" })),
    ).toEqual(record);
    expect(await store.transaction((tx) => tx.getIdempotent({ key: "k" }))).toBeNull();
    expect(
      await store.transaction((tx) => tx.getIdempotent({ key: "k", tenantId: "globex" })),
    ).toBeNull();
  });

  it("finds delegation rules of the given users, for the tenant or without one", async () => {
    const rule = (id: string, fromUserId: string, tenantId?: string) => ({
      id,
      fromUserId,
      toUserId: "u_x",
      startsAt: NOW,
      endsAt: LATER,
      ...(tenantId ? { tenantId } : {}),
    });
    const store = memoryStore({
      delegations: [rule("d1", "u_a"), rule("d2", "u_a", "acme"), rule("d3", "u_a", "globex")],
    });
    const found = await store.transaction((tx) => tx.findDelegations(["u_a"], "acme"));
    expect(found.map((r) => r.id)).toEqual(["d1", "d2"]);
    const global = await store.transaction((tx) => tx.findDelegations(["u_a", "u_b"]));
    expect(global.map((r) => r.id)).toEqual(["d1"]);
  });
});
