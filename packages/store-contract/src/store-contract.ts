import {
  type AuditEvent,
  ConflictError,
  type DelegationRule,
  type DomainEvent,
  defineFlow,
  type RegisteredFlow,
  type RequestState,
  type RungsStore,
} from "@rungsjs/core";
import { describe, expect, it } from "vitest";

/** Makes an empty store for one test. Adapters clean up their database here. */
export type StoreFactory = () => RungsStore | Promise<RungsStore>;

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

/** The behavior every `RungsStore` adapter must have. Run it from the adapter's own tests. */
export function storeContract(name: string, makeStore: StoreFactory): void {
  describe(`store contract: ${name}`, () => {
    it("commits a transaction's writes together", async () => {
      const store = await makeStore();
      await store.transaction(async (tx) => {
        await tx.saveRequest(request(), null);
        await tx.appendAudit([]);
      });
      const loaded = await store.transaction((tx) => tx.getRequest("r1"));
      expect(loaded?.version).toBe(1);
    });

    it("rolls back every write when the transaction throws", async () => {
      const store = await makeStore();
      const failing = store.transaction(async (tx) => {
        await tx.saveRequest(request(), null);
        await tx.enqueueEvents([event("r1", 1)], NOW);
        throw new Error("boom");
      });
      await expect(failing).rejects.toThrow("boom");
      expect(await store.transaction((tx) => tx.getRequest("r1"))).toBeNull();
      expect(await store.transaction((tx) => tx.pendingEvents({ now: NOW, limit: 10 }))).toEqual(
        [],
      );
    });

    it("getRequest with forUpdate serializes writers, so each one sees the previous commit", async () => {
      const store = await makeStore();
      await store.transaction((tx) => tx.saveRequest(request(), null));
      const bump = () =>
        store.transaction(async (tx) => {
          const current = (await tx.getRequest("r1", { forUpdate: true })) as RequestState;
          await tx.saveRequest({ ...current, version: current.version + 1 }, current.version);
        });
      await Promise.all([bump(), bump(), bump()]);
      expect((await store.transaction((tx) => tx.getRequest("r1")))?.version).toBe(4);
    });

    it("never shares objects with the caller", async () => {
      const store = await makeStore();
      const state = request();
      await store.transaction((tx) => tx.saveRequest(state, null));
      state.status = "approved";
      const loaded = (await store.transaction((tx) => tx.getRequest("r1"))) as RequestState;
      expect(loaded.status).toBe("pending");
      loaded.status = "rejected";
      expect((await store.transaction((tx) => tx.getRequest("r1")))?.status).toBe("pending");
    });

    it("EC-15 saveRequest is a compare-and-set on the version", async () => {
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
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
        const store = await makeStore();
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
        const store = await makeStore();
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
        expect(later.map((e) => [e.event.requestId, e.event.seq, e.attempts, e.lastError])).toEqual(
          [
            ["r2", 1, 0, undefined],
            ["r1", 1, 1, "smtp down"],
            ["r1", 2, 0, undefined],
          ],
        );
      });

      it("dispatched events leave the outbox", async () => {
        const store = await makeStore();
        await store.transaction(async (tx) => {
          await tx.enqueueEvents([event("r1", 1), event("r1", 2)], NOW);
          await tx.markDispatched([{ requestId: "r1", seq: 1 }]);
        });
        const pending = await store.transaction((tx) => tx.pendingEvents({ now: NOW, limit: 10 }));
        expect(pending.map((e) => e.event.seq)).toEqual([2]);
      });
    });

    it("EC-57 scopes idempotency keys per tenant", async () => {
      const store = await makeStore();
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
      const store = await makeStore();
      await store.transaction(async (tx) => {
        for (const r of [
          rule("d1", "u_a"),
          rule("d2", "u_a", "acme"),
          rule("d3", "u_a", "globex"),
        ]) {
          await tx.saveDelegation(r);
        }
      });
      const found = await store.transaction((tx) => tx.findDelegations(["u_a"], "acme"));
      expect(found.map((r) => r.id)).toEqual(["d1", "d2"]);
      const global = await store.transaction((tx) => tx.findDelegations(["u_a", "u_b"]));
      expect(global.map((r) => r.id)).toEqual(["d1"]);
    });
    it("returns a request's audit events in seq order", async () => {
      const store = await makeStore();
      const audit = (requestId: string, seq: number): AuditEvent => ({
        requestId,
        seq,
        actorId: "u_req",
        at: NOW,
        type: "request.submitted",
        data: { flowKey: "expense", flowVersion: 1, subject: { type: "expense", id: "EXP-1" } },
      });
      await store.transaction(async (tx) => {
        await tx.appendAudit([audit("r1", 2), audit("r2", 1)]);
        await tx.appendAudit([audit("r1", 1)]);
      });
      const history = await store.transaction((tx) => tx.getAudit("r1"));
      expect(history.map((e) => [e.requestId, e.seq])).toEqual([
        ["r1", 1],
        ["r1", 2],
      ]);
      expect(await store.transaction((tx) => tx.getAudit("nope"))).toEqual([]);
    });

    describe("inbox", () => {
      const task = (id: string, assigneeId: string, assignedAt: string, status = "pending") => ({
        id,
        assigneeId,
        status,
        assignedAt,
      });
      const withTasks = (id: string, tasks: unknown[], overrides: Partial<RequestState> = {}) =>
        request({
          id,
          steps: [
            {
              stepId: "old",
              index: 0,
              status: "approved",
              approvers: [],
              tasks: [task(`${id}.t0`, "u_a", NOW)],
            },
            {
              stepId: "manager",
              index: 1,
              status: "active",
              approvers: [],
              tasks,
              deadline: { deadlineAt: LATER, escalationDepth: 0, reminders: 0 },
            },
          ] as RequestState["steps"],
          ...overrides,
        });

      it("lists pending tasks of the user on open requests, oldest first, with a cursor", async () => {
        const store = await makeStore();
        await store.transaction(async (tx) => {
          await tx.saveRequest(withTasks("r2", [task("r2.t1", "u_a", LATER)]), null);
          await tx.saveRequest(
            withTasks("r1", [
              task("r1.t1", "u_a", NOW),
              task("r1.t2", "u_b", NOW),
              task("r1.t3", "u_a", NOW, "approved"),
            ]),
            null,
          );
          await tx.saveRequest(
            withTasks("r3", [task("r3.t1", "u_a", NOW)], { status: "withdrawn" }),
            null,
          );
        });
        const all = await store.transaction((tx) => tx.findInbox({ userId: "u_a", limit: 10 }));
        expect(all).toEqual([
          {
            requestId: "r1",
            flowKey: "expense",
            flowVersion: 1,
            subject: { type: "expense", id: "EXP-1" },
            requesterId: "u_req",
            stepId: "manager",
            taskId: "r1.t1",
            assigneeId: "u_a",
            assignedAt: NOW,
            deadlineAt: LATER,
          },
          expect.objectContaining({ taskId: "r2.t1" }),
        ]);
        const page = await store.transaction((tx) =>
          tx.findInbox({ userId: "u_a", limit: 10, after: { assignedAt: NOW, taskId: "r1.t1" } }),
        );
        expect(page.map((t) => t.taskId)).toEqual(["r2.t1"]);
        const first = await store.transaction((tx) => tx.findInbox({ userId: "u_a", limit: 1 }));
        expect(first.map((t) => t.taskId)).toEqual(["r1.t1"]);
      });

      it("EC-60 also lists pending tasks held by a delegate on the user's behalf", async () => {
        const store = await makeStore();
        await store.transaction(async (tx) => {
          await tx.saveRequest(
            withTasks("r1", [
              { ...task("r1.t1", "u_b", NOW), onBehalfOf: "u_a" },
              { ...task("r1.t2", "u_c", NOW), onBehalfOf: "u_a", status: "approved" },
            ]),
            null,
          );
        });
        const owner = await store.transaction((tx) => tx.findInbox({ userId: "u_a", limit: 10 }));
        expect(owner.map((t) => [t.taskId, t.assigneeId, t.onBehalfOf])).toEqual([
          ["r1.t1", "u_b", "u_a"],
        ]);
        const holder = await store.transaction((tx) => tx.findInbox({ userId: "u_b", limit: 10 }));
        expect(holder.map((t) => t.taskId)).toEqual(["r1.t1"]);
      });

      it("matches the tenant exactly: without a tenant only requests without one", async () => {
        const store = await makeStore();
        await store.transaction(async (tx) => {
          await tx.saveRequest(withTasks("r1", [task("r1.t1", "u_a", NOW)]), null);
          await tx.saveRequest(
            withTasks("r2", [task("r2.t1", "u_a", NOW)], { tenantId: "acme" }),
            null,
          );
        });
        const ids = async (tenantId?: string) =>
          (
            await store.transaction((tx) =>
              tx.findInbox({ userId: "u_a", limit: 10, ...(tenantId ? { tenantId } : {}) }),
            )
          ).map((t) => t.requestId);
        expect(await ids()).toEqual(["r1"]);
        expect(await ids("acme")).toEqual(["r2"]);
        expect(await ids("globex")).toEqual([]);
      });
    });

    it("saves, replaces and lists delegation rules from or to a user", async () => {
      const store = await makeStore();
      const rule = (
        id: string,
        fromUserId: string,
        toUserId: string,
        extra = {},
      ): DelegationRule => ({
        id,
        fromUserId,
        toUserId,
        startsAt: NOW,
        endsAt: LATER,
        ...extra,
      });
      await store.transaction(async (tx) => {
        await tx.saveDelegation(rule("d1", "u_a", "u_b"));
        await tx.saveDelegation(rule("d2", "u_c", "u_a"));
        await tx.saveDelegation(rule("d3", "u_c", "u_d"));
        await tx.saveDelegation(rule("d4", "u_a", "u_e", { tenantId: "acme" }));
        await tx.saveDelegation(rule("d1", "u_a", "u_b", { cancelledAt: NOW }));
      });
      expect(await store.transaction((tx) => tx.getDelegation("d1"))).toEqual(
        rule("d1", "u_a", "u_b", { cancelledAt: NOW }),
      );
      expect(await store.transaction((tx) => tx.getDelegation("nope"))).toBeNull();
      const list = async (tenantId?: string) =>
        (
          await store.transaction((tx) =>
            tx.listDelegations({ userId: "u_a", ...(tenantId ? { tenantId } : {}) }),
          )
        )
          .map((r) => r.id)
          .sort();
      expect(await list()).toEqual(["d1", "d2"]);
      expect(await list("acme")).toEqual(["d1", "d2", "d4"]);
    });
  });
}
