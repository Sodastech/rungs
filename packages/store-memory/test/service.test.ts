import {
  ConfigurationError,
  ConflictError,
  createRungs,
  type DomainEvent,
  FlowDefinitionError,
  type FlowInput,
  FlowNotFoundError,
  InvalidCommandError,
  RequestNotFoundError,
  ResolutionError,
  type RungsOptions,
  type RungsStore,
} from "@rungs/core";
import { describe, expect, it } from "vitest";
import { type MemoryStoreOptions, memoryStore } from "../src/index.js";

const T0 = "2026-01-05T09:00:00.000Z";

const expense: FlowInput = {
  key: "expense",
  steps: [
    { id: "manager", approvers: { type: "role", role: "manager" } },
    { id: "finance", approvers: { type: "users", ids: ["u_fin"] } },
  ],
};

const roles: Record<string, string[]> = { manager: ["u_mgr"], lead: ["u_lead"] };

function setup(
  overrides: Partial<RungsOptions> = {},
  storeOptions: MemoryStoreOptions = {},
  wrap: (store: RungsStore) => RungsStore = (s) => s,
) {
  let now = new Date(T0);
  let n = 0;
  const events: DomainEvent[] = [];
  const store = memoryStore(storeOptions);
  const rungs = createRungs({
    store: wrap(store),
    clock: () => now,
    ids: () => `r${++n}`,
    roles: async (role) => roles[role] ?? [],
    onEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  return { rungs, store, events, at };
}

const submitInput = (overrides = {}) => ({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 5000 },
  ...overrides,
});

describe("createRungs", () => {
  describe("flows", () => {
    it("registers versions; identical content returns the existing version (D23)", async () => {
      const { rungs } = setup();
      expect(await rungs.flows.register(expense)).toEqual({
        key: "expense",
        version: 1,
        created: true,
      });
      expect(await rungs.flows.register(expense)).toEqual({
        key: "expense",
        version: 1,
        created: false,
      });
      const changed = { ...expense, allowSelfApproval: true };
      expect(await rungs.flows.register(changed)).toMatchObject({ version: 2, created: true });
      expect((await rungs.flows.get("expense")).version).toBe(2);
      expect((await rungs.flows.get("expense", { version: 1 })).allowSelfApproval).toBe(false);
    });

    it("refuses a flow naming a resolver that is not configured, or roles without a callback", async () => {
      const { rungs } = setup({ resolvers: { projectOwner: async () => ["u_po"] } });
      const flow: FlowInput = {
        key: "purchase",
        steps: [
          {
            id: "owner",
            approvers: {
              type: "union",
              of: [
                { type: "resolver", name: "projectOwner" },
                { type: "resolver", name: "costCentreHead" },
              ],
            },
            deadline: "P1D",
            onTimeout: "escalate",
            escalateTo: { type: "resolver", name: "director" },
          },
        ],
      };
      const error = await rungs.flows.register(flow).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowDefinitionError);
      expect((error as FlowDefinitionError).issues).toEqual([
        {
          path: "steps[0].approvers.of[1].name",
          message: 'no resolver named "costCentreHead" is configured',
        },
        { path: "steps[0].escalateTo.name", message: 'no resolver named "director" is configured' },
      ]);

      const noRoles = setup({ roles: undefined });
      const roleError = await noRoles.rungs.flows.register(expense).catch((e: unknown) => e);
      expect((roleError as FlowDefinitionError).issues).toEqual([
        { path: "steps[0].approvers", message: "a role spec needs the roles callback" },
      ]);
    });

    it("validates the input like defineFlow", async () => {
      const { rungs } = setup();
      const error = await rungs.flows.register({ key: "", steps: [] }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowDefinitionError);
    });
  });

  describe("commands", () => {
    it("runs a request end to end and delivers events after each commit", async () => {
      const { rungs, store, events } = setup();
      await rungs.flows.register(expense);
      const submitted = await rungs.submit(submitInput());
      expect(submitted).toMatchObject({ id: "r1", flowKey: "expense", flowVersion: 1, version: 1 });
      expect(submitted.steps[0]?.approvers).toEqual(["u_mgr"]);
      expect(events.map((e) => e.type)).toEqual([
        "request.submitted",
        "step.activated",
        "task.assigned",
      ]);

      await rungs.approve({ requestId: "r1", actorId: "u_mgr" });
      const done = await rungs.approve({ requestId: "r1", actorId: "u_fin", comment: "OK" });
      expect(done.status).toBe("approved");

      const snapshot = store.snapshot();
      expect(snapshot.requests).toEqual([done]);
      expect(snapshot.audit.map((e) => e.seq)).toEqual(
        Array.from({ length: done.lastAuditSeq }, (_, i) => i + 1),
      );
      expect(snapshot.outbox).toEqual([]);
      expect(events.map((e) => e.seq)).toEqual(snapshot.audit.map((e) => e.seq));
    });

    it("refuses an unknown flow or request", async () => {
      const { rungs } = setup();
      await expect(rungs.submit(submitInput())).rejects.toBeInstanceOf(FlowNotFoundError);
      await expect(rungs.approve({ requestId: "nope", actorId: "u_mgr" })).rejects.toBeInstanceOf(
        RequestNotFoundError,
      );
    });

    it("refuses a clock or id generator that returns something unusable", async () => {
      const badClock = setup({ clock: () => new Date("nonsense") });
      await badClock.rungs.flows.register(expense);
      const error = await badClock.rungs.submit(submitInput()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      const badIds = setup({ ids: () => "" });
      await badIds.rungs.flows.register(expense);
      await expect(badIds.rungs.submit(submitInput())).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("refuses invalid options with ConfigurationError", () => {
      const store = memoryStore();
      const clock = () => new Date(T0);
      const ids = () => "r1";
      const invalid = [
        { clock, ids },
        { store, ids },
        { store, clock },
        { store, clock, ids, dispatchRetry: { baseDelay: "P1M" } },
        { store, clock, ids, events: "sometimes" },
      ];
      for (const options of invalid) {
        const error = (() => {
          try {
            createRungs(options as never);
          } catch (e) {
            return e;
          }
        })();
        expect(error).toBeInstanceOf(ConfigurationError);
      }
    });

    it("EC-37 in-flight requests keep their pinned version after a new one is registered", async () => {
      const { rungs } = setup();
      await rungs.flows.register(expense);
      await rungs.submit(submitInput());
      await rungs.flows.register({ ...expense, steps: [expense.steps[0] as never] });
      await rungs.approve({ requestId: "r1", actorId: "u_mgr" });
      const done = await rungs.approve({ requestId: "r1", actorId: "u_fin" });
      expect(done).toMatchObject({ flowVersion: 1, status: "approved" });
    });

    it("EC-05 a throwing resolver fails the command, keeps the cause and stores nothing", async () => {
      const cause = new Error("directory down");
      const { rungs, store, events } = setup({ roles: async () => Promise.reject(cause) });
      await rungs.flows.register(expense);
      const error = await rungs.submit(submitInput()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).cause).toBe(cause);
      expect(store.snapshot()).toMatchObject({ requests: [], audit: [], outbox: [] });
      expect(events).toEqual([]);
    });

    it("loads out-of-office chains from the store and checks the delegates are active", async () => {
      const rule = (id: string, fromUserId: string, toUserId: string) => ({
        id,
        fromUserId,
        toUserId,
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-02-01T00:00:00.000Z",
      });
      const { rungs } = setup(
        { isActiveUser: async (userId) => userId !== "u_c" },
        { delegations: [rule("d1", "u_mgr", "u_b"), rule("d2", "u_b", "u_c")] },
      );
      await rungs.flows.register(expense);
      const state = await rungs.submit(submitInput());
      expect(state.steps[0]?.tasks).toMatchObject([{ assigneeId: "u_b", onBehalfOf: "u_mgr" }]);
    });
  });

  describe("tenants", () => {
    it("EC-56 uses the tenant's own flow first, then the global one, else FlowNotFoundError", async () => {
      const { rungs } = setup();
      await rungs.flows.register(expense);
      await rungs.flows.register(
        { ...expense, steps: [expense.steps[1] as never] },
        { tenantId: "acme" },
      );
      const acme = await rungs.submit(submitInput({ tenantId: "acme" }));
      expect(acme).toMatchObject({ flowTenantId: "acme", flowVersion: 1 });
      expect(acme.steps[0]?.stepId).toBe("finance");
      const globex = await rungs.submit(submitInput({ tenantId: "globex" }));
      expect(globex.flowTenantId).toBeUndefined();
      expect(globex.steps[0]?.stepId).toBe("manager");
      const missing = await rungs
        .submit(submitInput({ flow: "leave", tenantId: "acme" }))
        .catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(FlowNotFoundError);
      expect(missing).toMatchObject({ code: "FLOW_NOT_FOUND", flowKey: "leave", tenantId: "acme" });
    });

    it("EC-56 a pinned request keeps the exact flow after its tenant registers its own", async () => {
      const { rungs } = setup();
      await rungs.flows.register(expense);
      await rungs.submit(submitInput({ tenantId: "acme" }));
      await rungs.flows.register(
        { ...expense, steps: [{ id: "cfo", approvers: { type: "users", ids: ["u_cfo"] } }] },
        { tenantId: "acme" },
      );
      const afterManager = await rungs.approve({ requestId: "r1", actorId: "u_mgr" });
      expect(afterManager.flowTenantId).toBeUndefined();
      expect(afterManager.steps.at(-1)?.stepId).toBe("finance");
    });
  });

  describe("concurrency and idempotency", () => {
    it("EC-15 a stale expectedVersion is refused with ConflictError and nothing changes", async () => {
      const { rungs, store } = setup();
      await rungs.flows.register(expense);
      await rungs.submit(submitInput());
      const error = await rungs
        .approve({ requestId: "r1", actorId: "u_mgr", expectedVersion: 0 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ expectedVersion: 0, actualVersion: 1 });
      expect(store.snapshot().requests[0]?.version).toBe(1);
    });

    it("EC-15 of two approvers acting on the same version, one wins and the other conflicts", async () => {
      const { rungs } = setup();
      await rungs.flows.register({
        key: "expense",
        steps: [{ id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b"] } }],
      });
      const { version } = await rungs.submit(submitInput());
      const results = await Promise.allSettled([
        rungs.approve({ requestId: "r1", actorId: "u_a", expectedVersion: version }),
        rungs.approve({ requestId: "r1", actorId: "u_b", expectedVersion: version }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    });

    it("EC-16 the same idempotencyKey returns the first result without repeating anything", async () => {
      const { rungs, store, events } = setup();
      await rungs.flows.register(expense);
      const first = await rungs.submit(submitInput({ idempotencyKey: "k1" }));
      const again = await rungs.submit(submitInput({ idempotencyKey: "k1" }));
      expect(again).toEqual(first);
      expect(store.snapshot().requests).toHaveLength(1);

      const approved = await rungs.approve({
        requestId: "r1",
        actorId: "u_mgr",
        idempotencyKey: "k2",
      });
      const eventCount = events.length;
      expect(
        await rungs.approve({ requestId: "r1", actorId: "u_mgr", idempotencyKey: "k2" }),
      ).toEqual(approved);
      expect(events).toHaveLength(eventCount);
      expect(store.snapshot().audit).toHaveLength(approved.lastAuditSeq);
    });

    it("EC-57 a key reused for a different command is refused; keys are scoped per tenant", async () => {
      const { rungs } = setup();
      await rungs.flows.register(expense);
      await rungs.submit(submitInput({ idempotencyKey: "k1", tenantId: "acme" }));
      const reused = await rungs
        .submit(submitInput({ idempotencyKey: "k1", tenantId: "acme", payload: { amount: 1 } }))
        .catch((e: unknown) => e);
      expect(reused).toBeInstanceOf(InvalidCommandError);
      expect((reused as Error).message).toContain("idempotency key");

      const otherTenant = await rungs.submit(
        submitInput({ idempotencyKey: "k1", tenantId: "globex" }),
      );
      expect(otherTenant.id).not.toBe("r1");
    });
  });

  describe("tick", () => {
    const timed: FlowInput = {
      key: "expense",
      steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] }, deadline: "P1D" }],
    };

    it("processes due requests, each in its own transaction, and reports what happened", async () => {
      const { rungs, events, at } = setup();
      await rungs.flows.register(timed);
      await rungs.submit(submitInput());
      await rungs.submit(submitInput());
      expect(await rungs.tick()).toEqual({ processed: 0, changed: [], skipped: [], failed: [] });
      at("2026-01-06T09:00:00.000Z");
      expect(await rungs.tick()).toEqual({
        processed: 2,
        changed: ["r1", "r2"],
        skipped: [],
        failed: [],
      });
      expect(events.filter((e) => e.type === "task.reminder")).toHaveLength(2);
    });

    it("EC-27 concurrent ticks apply each action once", async () => {
      const { rungs, events, at } = setup();
      await rungs.flows.register(timed);
      await rungs.submit(submitInput());
      at("2026-01-06T09:00:00.000Z");
      await Promise.all([rungs.tick(), rungs.tick(), rungs.tick()]);
      expect(events.filter((e) => e.type === "task.reminder")).toHaveLength(1);
    });

    it("EC-27 a request another worker changed meanwhile is skipped, not failed", async () => {
      let conflicts = 1;
      const wrap = (store: RungsStore): RungsStore => ({
        transaction: (fn) =>
          store.transaction((tx) =>
            fn({
              ...tx,
              saveRequest: async (state, expected) => {
                if (conflicts-- > 0) {
                  throw new ConflictError({
                    requestId: state.id,
                    expectedVersion: expected,
                    actualVersion: 9,
                  });
                }
                return tx.saveRequest(state, expected);
              },
            }),
          ),
      });
      const { rungs, at } = setup({}, {}, wrap);
      conflicts = 0;
      await rungs.flows.register(timed);
      await rungs.submit(submitInput());
      conflicts = 1;
      at("2026-01-06T09:00:00.000Z");
      expect(await rungs.tick()).toMatchObject({ processed: 1, changed: [], skipped: ["r1"] });
    });
  });

  describe("event delivery", () => {
    it("a failing onEvent never fails the command; the event waits out a backoff", async () => {
      const failures: [string, number][] = [];
      let down = true;
      const delivered: DomainEvent[] = [];
      const { rungs, store, at } = setup({
        onEvent: (event) => {
          if (down && event.requestId === "r1") throw new Error("webhook down");
          delivered.push(event);
        },
        onEventError: (error, event, attempts) => {
          failures.push([`${event.requestId}#${event.seq} ${(error as Error).message}`, attempts]);
        },
      });
      await rungs.flows.register(expense);
      const state = await rungs.submit(submitInput());
      expect(state.status).toBe("pending");
      await rungs.submit(submitInput());
      expect(failures).toEqual([["r1#1 webhook down", 1]]);
      expect(delivered.map((e) => `${e.requestId}#${e.seq}`)).toEqual(["r2#1", "r2#2", "r2#3"]);
      expect(
        store.snapshot().outbox.map((e) => [e.event.seq, e.attempts, e.nextAttemptAt]),
      ).toEqual([
        [1, 1, "2026-01-05T09:00:30.000Z"],
        [2, 0, T0],
        [3, 0, T0],
      ]);

      expect(await rungs.dispatchPending()).toEqual({ delivered: 0, failed: 0 });
      at("2026-01-05T09:00:30.000Z");
      expect(await rungs.dispatchPending()).toEqual({ delivered: 0, failed: 1 });
      expect(store.snapshot().outbox[0]).toMatchObject({
        attempts: 2,
        nextAttemptAt: "2026-01-05T09:01:30.000Z",
        lastError: "webhook down",
      });

      down = false;
      at("2026-01-05T09:01:30.000Z");
      expect(await rungs.dispatchPending()).toEqual({ delivered: 3, failed: 0 });
      expect(delivered.slice(3).map((e) => `${e.requestId}#${e.seq}`)).toEqual([
        "r1#1",
        "r1#2",
        "r1#3",
      ]);
      expect(store.snapshot().outbox).toEqual([]);
    });

    it("the backoff doubles up to maxDelay", async () => {
      const { rungs, store, at } = setup({
        onEvent: () => {
          throw new Error("down");
        },
        dispatchRetry: { baseDelay: "PT1M", maxDelay: "PT3M" },
      });
      await rungs.flows.register(expense);
      await rungs.submit(submitInput());
      const delays: string[] = [];
      for (let i = 0; i < 3; i++) {
        const next = store.snapshot().outbox[0]?.nextAttemptAt as string;
        delays.push(next);
        at(next);
        await rungs.dispatchPending();
      }
      expect(delays).toEqual([
        "2026-01-05T09:01:00.000Z",
        "2026-01-05T09:03:00.000Z",
        "2026-01-05T09:06:00.000Z",
      ]);
    });

    it("EC-58 without onEvent the events stay in the outbox for a worker to deliver", async () => {
      const { rungs, store } = setup({ onEvent: undefined });
      await rungs.flows.register(expense);
      await rungs.submit(submitInput());
      expect(store.snapshot().outbox.map((e) => e.event.seq)).toEqual([1, 2, 3]);

      const delivered: DomainEvent[] = [];
      const worker = createRungs({
        store,
        clock: () => new Date(T0),
        ids: () => "unused",
        onEvent: (event) => {
          delivered.push(event);
        },
      });
      expect(await worker.dispatchPending()).toEqual({ delivered: 3, failed: 0 });
      expect(delivered.map((e) => e.type)).toEqual([
        "request.submitted",
        "step.activated",
        "task.assigned",
      ]);
      expect(store.snapshot().outbox).toEqual([]);
    });

    it("EC-58 events: discard writes no outbox entries; the audit is kept", async () => {
      const { rungs, store } = setup({ onEvent: undefined, events: "discard" });
      await rungs.flows.register(expense);
      const state = await rungs.submit(submitInput());
      expect(store.snapshot().outbox).toEqual([]);
      expect(store.snapshot().audit).toHaveLength(state.lastAuditSeq);
    });

    it("EC-58 discarding events with onEvent, or dispatching without onEvent, is a configuration error", async () => {
      expect(() => setup({ events: "discard" })).toThrow(ConfigurationError);
      const { rungs } = setup({ onEvent: undefined });
      await expect(rungs.dispatchPending()).rejects.toBeInstanceOf(ConfigurationError);
    });
  });
});
