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
} from "@rungsjs/core";
import { describe, expect, it } from "vitest";
import type { StoreFactory } from "./store-contract.js";

const T0 = "2026-01-05T09:00:00.000Z";

const expense: FlowInput = {
  key: "expense",
  steps: [
    { id: "manager", approvers: { type: "role", role: "manager" } },
    { id: "finance", approvers: { type: "users", ids: ["u_fin"] } },
  ],
};

const roles: Record<string, string[]> = { manager: ["u_mgr"], lead: ["u_lead"] };

const FAR = "2100-01-01T00:00:00.000Z";

/** Everything still in the outbox, read through the public store interface. */
const outbox = (store: RungsStore) =>
  store.transaction((tx) => tx.pendingEvents({ now: FAR, limit: 1000 }));

/**
 * Runs every service test against stores made by `makeStore`, so an adapter proves that
 * `createRungs` works on it. Uses only the public API and the `RungsStore` interface.
 */
export function serviceSuite(name: string, makeStore: StoreFactory): void {
  async function setup(
    overrides: Partial<RungsOptions> = {},
    wrap: (store: RungsStore) => RungsStore = (s) => s,
  ) {
    let now = new Date(T0);
    let n = 0;
    const events: DomainEvent[] = [];
    const store = await makeStore();
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

  describe(`createRungs on ${name}`, () => {
    describe("flows", () => {
      it("registers versions; identical content returns the existing version (D23)", async () => {
        const { rungs } = await setup();
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
        const { rungs } = await setup({ resolvers: { projectOwner: async () => ["u_po"] } });
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
          {
            path: "steps[0].escalateTo.name",
            message: 'no resolver named "director" is configured',
          },
        ]);

        const noRoles = await setup({ roles: undefined });
        const roleError = await noRoles.rungs.flows.register(expense).catch((e: unknown) => e);
        expect((roleError as FlowDefinitionError).issues).toEqual([
          { path: "steps[0].approvers", message: "a role spec needs the roles callback" },
        ]);
      });

      it("validates the input like defineFlow", async () => {
        const { rungs } = await setup();
        const error = await rungs.flows.register({ key: "", steps: [] }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FlowDefinitionError);
      });
    });

    describe("commands", () => {
      it("runs a request end to end and delivers events after each commit", async () => {
        const { rungs, store, events } = await setup();
        await rungs.flows.register(expense);
        const submitted = await rungs.submit(submitInput());
        expect(submitted).toMatchObject({
          id: "r1",
          flowKey: "expense",
          flowVersion: 1,
          version: 1,
        });
        expect(submitted.steps[0]?.approvers).toEqual(["u_mgr"]);
        expect(events.map((e) => e.type)).toEqual([
          "request.submitted",
          "step.activated",
          "task.assigned",
        ]);

        await rungs.approve({ requestId: "r1", actorId: "u_mgr" });
        const done = await rungs.approve({ requestId: "r1", actorId: "u_fin", comment: "OK" });
        expect(done.status).toBe("approved");

        expect(await rungs.get("r1")).toEqual(done);
        const history = await rungs.history("r1");
        expect(history.map((e) => e.seq)).toEqual(
          Array.from({ length: done.lastAuditSeq }, (_, i) => i + 1),
        );
        expect(await outbox(store)).toEqual([]);
        expect(events.map((e) => e.seq)).toEqual(history.map((e) => e.seq));
      });

      it("refuses an unknown flow or request", async () => {
        const { rungs } = await setup();
        await expect(rungs.submit(submitInput())).rejects.toBeInstanceOf(FlowNotFoundError);
        await expect(rungs.approve({ requestId: "nope", actorId: "u_mgr" })).rejects.toBeInstanceOf(
          RequestNotFoundError,
        );
      });

      it("refuses a clock or id generator that returns something unusable", async () => {
        const badClock = await setup({ clock: () => new Date("nonsense") });
        await badClock.rungs.flows.register(expense);
        const error = await badClock.rungs.submit(submitInput()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConfigurationError);
        expect(error).toMatchObject({ code: "CONFIG_INVALID" });
        const badIds = await setup({ ids: () => "" });
        await badIds.rungs.flows.register(expense);
        await expect(badIds.rungs.submit(submitInput())).rejects.toBeInstanceOf(ConfigurationError);
      });

      it("refuses invalid options with ConfigurationError", async () => {
        const store = await makeStore();
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
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        await rungs.submit(submitInput());
        await rungs.flows.register({ ...expense, steps: [expense.steps[0] as never] });
        await rungs.approve({ requestId: "r1", actorId: "u_mgr" });
        const done = await rungs.approve({ requestId: "r1", actorId: "u_fin" });
        expect(done).toMatchObject({ flowVersion: 1, status: "approved" });
      });

      it("EC-05 a throwing resolver fails the command, keeps the cause and stores nothing", async () => {
        const cause = new Error("directory down");
        const { rungs, store, events } = await setup({ roles: async () => Promise.reject(cause) });
        await rungs.flows.register(expense);
        const error = await rungs.submit(submitInput()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResolutionError);
        expect((error as ResolutionError).cause).toBe(cause);
        expect(await rungs.get("r1")).toBeNull();
        expect(await rungs.history("r1")).toEqual([]);
        expect(await outbox(store)).toEqual([]);
        expect(events).toEqual([]);
      });

      it("loads out-of-office chains from the store and checks the delegates are active", async () => {
        const { rungs } = await setup({ isActiveUser: async (userId) => userId !== "u_c" });
        const january = {
          startsAt: "2026-01-01T00:00:00.000Z",
          endsAt: "2026-02-01T00:00:00.000Z",
        };
        await rungs.delegations.set({ fromUserId: "u_mgr", toUserId: "u_b", ...january });
        await rungs.delegations.set({ fromUserId: "u_b", toUserId: "u_c", ...january });
        await rungs.flows.register(expense);
        const state = await rungs.submit(submitInput());
        expect(state.steps[0]?.tasks).toMatchObject([{ assigneeId: "u_b", onBehalfOf: "u_mgr" }]);
      });
    });

    describe("tenants", () => {
      it("EC-56 uses the tenant's own flow first, then the global one, else FlowNotFoundError", async () => {
        const { rungs } = await setup();
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
        expect(missing).toMatchObject({
          code: "FLOW_NOT_FOUND",
          flowKey: "leave",
          tenantId: "acme",
        });
      });

      it("EC-56 a pinned request keeps the exact flow after its tenant registers its own", async () => {
        const { rungs } = await setup();
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
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        await rungs.submit(submitInput());
        const error = await rungs
          .approve({ requestId: "r1", actorId: "u_mgr", expectedVersion: 0 })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictError);
        expect(error).toMatchObject({ expectedVersion: 0, actualVersion: 1 });
        expect((await rungs.get("r1"))?.version).toBe(1);
      });

      it("EC-15 of two approvers acting on the same version, one wins and the other conflicts", async () => {
        const { rungs } = await setup();
        await rungs.flows.register({
          key: "expense",
          steps: [{ id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b"] } }],
        });
        const { version } = await rungs.submit(submitInput());
        const results = await Promise.allSettled([
          rungs.approve({ requestId: "r1", actorId: "u_a", expectedVersion: version }),
          rungs.approve({ requestId: "r1", actorId: "u_b", expectedVersion: version }),
        ]);
        // Either may win on a real database; exactly one does, the other conflicts.
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(loser.reason).toBeInstanceOf(ConflictError);
      });

      it("EC-16 the same idempotencyKey returns the first result without repeating anything", async () => {
        const { rungs, events } = await setup();
        await rungs.flows.register(expense);
        const first = await rungs.submit(submitInput({ idempotencyKey: "k1" }));
        const again = await rungs.submit(submitInput({ idempotencyKey: "k1" }));
        expect(again).toEqual(first);
        expect(await rungs.get("r2")).toBeNull();

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
        expect(await rungs.history("r1")).toHaveLength(approved.lastAuditSeq);
      });

      it("EC-57 a key reused for a different command is refused; keys are scoped per tenant", async () => {
        const { rungs } = await setup();
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
        const { rungs, events, at } = await setup();
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
        const { rungs, events, at } = await setup();
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
        const { rungs, at } = await setup({}, wrap);
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
        const { rungs, store, at } = await setup({
          onEvent: (event) => {
            if (down && event.requestId === "r1") throw new Error("webhook down");
            delivered.push(event);
          },
          onEventError: (error, event, attempts) => {
            failures.push([
              `${event.requestId}#${event.seq} ${(error as Error).message}`,
              attempts,
            ]);
          },
        });
        await rungs.flows.register(expense);
        const state = await rungs.submit(submitInput());
        expect(state.status).toBe("pending");
        await rungs.submit(submitInput());
        expect(failures).toEqual([["r1#1 webhook down", 1]]);
        expect(delivered.map((e) => `${e.requestId}#${e.seq}`)).toEqual(["r2#1", "r2#2", "r2#3"]);
        expect(
          (await outbox(store)).map((e) => [e.event.seq, e.attempts, e.nextAttemptAt]),
        ).toEqual([
          [1, 1, "2026-01-05T09:00:30.000Z"],
          [2, 0, T0],
          [3, 0, T0],
        ]);

        expect(await rungs.dispatchPending()).toEqual({ delivered: 0, failed: 0 });
        at("2026-01-05T09:00:30.000Z");
        expect(await rungs.dispatchPending()).toEqual({ delivered: 0, failed: 1 });
        expect((await outbox(store))[0]).toMatchObject({
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
        expect(await outbox(store)).toEqual([]);
      });

      it("the backoff doubles up to maxDelay", async () => {
        const { rungs, store, at } = await setup({
          onEvent: () => {
            throw new Error("down");
          },
          dispatchRetry: { baseDelay: "PT1M", maxDelay: "PT3M" },
        });
        await rungs.flows.register(expense);
        await rungs.submit(submitInput());
        const delays: string[] = [];
        for (let i = 0; i < 3; i++) {
          const next = (await outbox(store))[0]?.nextAttemptAt as string;
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
        const { rungs, store } = await setup({ onEvent: undefined });
        await rungs.flows.register(expense);
        await rungs.submit(submitInput());
        expect((await outbox(store)).map((e) => e.event.seq)).toEqual([1, 2, 3]);

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
        expect(await outbox(store)).toEqual([]);
      });

      it("EC-58 events: discard writes no outbox entries; the audit is kept", async () => {
        const { rungs, store } = await setup({ onEvent: undefined, events: "discard" });
        await rungs.flows.register(expense);
        const state = await rungs.submit(submitInput());
        expect(await outbox(store)).toEqual([]);
        expect(await rungs.history(state.id)).toHaveLength(state.lastAuditSeq);
      });

      it("EC-58 discarding events with onEvent, or dispatching without onEvent, is a configuration error", async () => {
        await expect(setup({ events: "discard" })).rejects.toThrow(ConfigurationError);
        const { rungs } = await setup({ onEvent: undefined });
        await expect(rungs.dispatchPending()).rejects.toBeInstanceOf(ConfigurationError);
      });
    });
    describe("queries", () => {
      const parallel: FlowInput = {
        key: "expense",
        steps: [
          {
            id: "reviewers",
            approvers: { type: "users", ids: ["u_a", "u_b"] },
            mode: "all",
            deadline: "P1D",
          },
        ],
      };

      it("get returns the request, or null when it does not exist", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        const state = await rungs.submit(submitInput());
        expect(await rungs.get(state.id)).toEqual(state);
        expect(await rungs.get("nope")).toBeNull();
      });

      it("history returns the audit trail in seq order", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        await rungs.submit(submitInput());
        await rungs.approve({ requestId: "r1", actorId: "u_mgr" });
        const history = await rungs.history("r1");
        expect(history.map((e) => [e.seq, e.type])).toEqual([
          [1, "request.submitted"],
          [2, "step.activated"],
          [3, "task.assigned"],
          [4, "task.approved"],
          [5, "step.completed"],
          [6, "step.activated"],
          [7, "task.assigned"],
        ]);
        expect(await rungs.history("nope")).toEqual([]);
      });

      it("inbox lists the user's pending tasks, oldest first, with overdue and paging", async () => {
        const { rungs, at } = await setup();
        await rungs.flows.register(parallel);
        await rungs.submit(submitInput());
        at("2026-01-05T10:00:00.000Z");
        await rungs.submit(submitInput());
        await rungs.submit(submitInput({ tenantId: "acme" }));
        await rungs.approve({ requestId: "r2", actorId: "u_b" });
        at("2026-01-06T09:30:00.000Z");

        const page = await rungs.inbox({ userId: "u_a", limit: 1 });
        expect(page.tasks).toEqual([
          {
            requestId: "r1",
            flowKey: "expense",
            flowVersion: 1,
            subject: { type: "expense", id: "EXP-1" },
            requesterId: "u_req",
            stepId: "reviewers",
            taskId: "r1.t1",
            assigneeId: "u_a",
            assignedAt: T0,
            deadlineAt: "2026-01-06T09:00:00.000Z",
            payload: { amount: 5000 },
            overdue: true,
          },
        ]);
        expect(page.next).toBeDefined();
        const rest = await rungs.inbox({ userId: "u_a", after: page.next as string });
        expect(rest.tasks.map((t) => [t.taskId, t.overdue])).toEqual([["r2.t1", false]]);
        expect(rest.next).toBeUndefined();

        expect((await rungs.inbox({ userId: "u_b" })).tasks.map((t) => t.taskId)).toEqual([
          "r1.t2",
        ]);
        const acme = await rungs.inbox({ userId: "u_a", tenantId: "acme" });
        expect(acme.tasks.map((t) => [t.requestId, t.tenantId])).toEqual([["r3", "acme"]]);
      });

      it("EC-60 inbox shows a delegated task to the delegate and, marked heldBy, to its owner", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(parallel);
        await rungs.submit(submitInput());
        await rungs.delegate({ requestId: "r1", taskId: "r1.t1", actorId: "u_a", toUserId: "u_x" });
        const delegate = await rungs.inbox({ userId: "u_x" });
        expect(delegate.tasks).toMatchObject([
          { taskId: "r1.t3", assigneeId: "u_x", onBehalfOf: "u_a" },
        ]);
        expect(delegate.tasks[0]).not.toHaveProperty("heldBy");
        const owner = await rungs.inbox({ userId: "u_a" });
        expect(owner.tasks).toMatchObject([
          { taskId: "r1.t3", assigneeId: "u_x", onBehalfOf: "u_a", heldBy: "u_x" },
        ]);

        await rungs.approve({ requestId: "r1", actorId: "u_a" });
        expect((await rungs.inbox({ userId: "u_a" })).tasks).toEqual([]);
        expect((await rungs.inbox({ userId: "u_x" })).tasks).toEqual([]);
        const history = await rungs.history("r1");
        expect(history.find((e) => e.type === "task.approved")).toMatchObject({
          actorId: "u_a",
          data: { taskId: "r1.t3", onBehalfOf: "u_a", heldBy: "u_x" },
        });
      });

      it("inbox refuses a malformed cursor or limit", async () => {
        const { rungs } = await setup();
        await expect(rungs.inbox({ userId: "u_a", after: "nonsense" })).rejects.toBeInstanceOf(
          InvalidCommandError,
        );
        await expect(rungs.inbox({ userId: "u_a", limit: 0 })).rejects.toBeInstanceOf(
          InvalidCommandError,
        );
      });
    });

    describe("list queries", () => {
      it("requests lists the newest first, filters, and pages with next", async () => {
        const { rungs, at } = await setup();
        await rungs.flows.register(expense);
        const first = await rungs.submit(submitInput());
        at("2026-01-05T10:00:00.000Z");
        const second = await rungs.submit(
          submitInput({ requesterId: "u_other", subject: { type: "expense", id: "EXP-2" } }),
        );
        at("2026-01-05T11:00:00.000Z");
        const third = await rungs.submit(
          submitInput({ subject: { type: "expense", id: "EXP-3" } }),
        );
        await rungs.withdraw({ requestId: third.id, actorId: "u_req" });

        const all = await rungs.requests();
        expect(all.requests.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
        expect(all.next).toBeUndefined();
        expect(all.requests[1]).toMatchObject({
          id: second.id,
          status: "pending",
          payload: { amount: 5000 },
          openStep: { stepId: "manager", status: "active" },
        });

        const mine = await rungs.requests({ requesterId: "u_req", status: "pending" });
        expect(mine.requests.map((r) => r.id)).toEqual([first.id]);
        const bySubject = await rungs.requests({ subject: { type: "expense", id: "EXP-2" } });
        expect(bySubject.requests.map((r) => r.id)).toEqual([second.id]);

        const page1 = await rungs.requests({ limit: 2 });
        expect(page1.requests.map((r) => r.id)).toEqual([third.id, second.id]);
        expect(page1.next).toBeDefined();
        const page2 = await rungs.requests({ limit: 2, after: page1.next as string });
        expect(page2.requests.map((r) => r.id)).toEqual([first.id]);
        expect(page2.next).toBeUndefined();
      });

      it("EC-42 blocked lists steps waiting for an admin until one acts", async () => {
        const inactive = new Set<string>();
        const { rungs } = await setup({ isActiveUser: (id) => !inactive.has(id) });
        await rungs.flows.register(expense);
        const request = await rungs.submit(submitInput());
        inactive.add("u_fin");
        await rungs.approve({ requestId: request.id, actorId: "u_mgr" });

        const { steps } = await rungs.blocked();
        expect(steps).toEqual([
          expect.objectContaining({
            requestId: request.id,
            stepId: "finance",
            reason: { type: "no-approvers" },
            removed: [{ userId: "u_fin", reason: "inactive" }],
            payload: { amount: 5000 },
          }),
        ]);
        expect((await rungs.requests()).requests[0]?.openStep).toEqual({
          stepId: "finance",
          status: "blocked",
        });
        await rungs.reassign({
          requestId: request.id,
          stepId: "finance",
          adminId: "u_admin",
          toUserIds: ["u_lead"],
          comment: "Finance is away",
          expectedVersion: steps[0]?.version as number,
        });
        expect((await rungs.blocked()).steps).toEqual([]);
      });

      it("EC-62 requests and blocked never cross tenants", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        const global = await rungs.submit(submitInput());
        const acme = await rungs.submit(submitInput({ tenantId: "acme" }));
        expect((await rungs.requests()).requests.map((r) => r.id)).toEqual([global.id]);
        expect((await rungs.requests({ tenantId: "acme" })).requests.map((r) => r.id)).toEqual([
          acme.id,
        ]);
        expect((await rungs.requests({ tenantId: "globex" })).requests).toEqual([]);
        expect((await rungs.blocked({ tenantId: "globex" })).steps).toEqual([]);
      });

      it("refuses an invalid limit, status, subject or cursor", async () => {
        const { rungs } = await setup();
        for (const input of [
          { limit: 0 },
          { limit: 201 },
          { limit: 1.5 },
          { status: [] },
          { status: "cancelled" },
          { subject: { type: "" } },
          { after: "not-a-cursor" },
          { after: "2026-01-05T09:00:00.000Z~" },
        ]) {
          await expect(
            rungs.requests(input as Parameters<typeof rungs.requests>[0]),
          ).rejects.toBeInstanceOf(InvalidCommandError);
        }
        await expect(rungs.blocked({ limit: 0 })).rejects.toBeInstanceOf(InvalidCommandError);
        await expect(rungs.blocked({ after: "x" })).rejects.toBeInstanceOf(InvalidCommandError);
      });

      it("inbox entries carry the request payload for display", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        await rungs.submit(submitInput());
        const { tasks } = await rungs.inbox({ userId: "u_mgr" });
        expect(tasks[0]?.payload).toEqual({ amount: 5000 });
      });
    });

    describe("preview", () => {
      const purchase: FlowInput = {
        key: "purchase",
        steps: [
          { id: "manager", approvers: { type: "role", role: "manager" } },
          {
            id: "finance",
            approvers: { type: "users", ids: ["u_fin"] },
            when: { field: "amount", op: "gt", value: 1000 },
          },
          {
            id: "board",
            approvers: { type: "users", ids: ["u_req", "u_b1"] },
            mode: { quorum: 2 },
          },
        ],
      };

      it("shows who would approve each step without storing anything", async () => {
        const { rungs, store } = await setup();
        await rungs.flows.register(purchase);
        await rungs.delegations.set({
          fromUserId: "u_mgr",
          toUserId: "u_dep",
          startsAt: "2026-01-01T00:00:00.000Z",
          endsAt: "2026-02-01T00:00:00.000Z",
        });
        const preview = await rungs.preview({
          flow: "purchase",
          requesterId: "u_req",
          subject: { type: "purchase", id: "PO-7" },
          payload: { amount: 50 },
        });
        expect(preview).toEqual({
          flowKey: "purchase",
          flowVersion: 1,
          submittable: false,
          steps: [
            {
              stepId: "manager",
              mode: "any",
              status: "will-run",
              approvers: ["u_dep"],
              removed: [],
              delegations: [{ userId: "u_mgr", toUserId: "u_dep" }],
            },
            {
              stepId: "finance",
              mode: "any",
              status: "skipped",
              skipReason: {
                type: "condition-false",
                condition: { field: "amount", op: "gt", value: 1000 },
              },
              approvers: [],
              removed: [],
              delegations: [],
            },
            {
              stepId: "board",
              mode: { quorum: 2 },
              status: "cannot-run",
              shortfall: { type: "quorum-unreachable", required: 2, available: 1 },
              approvers: [],
              removed: [{ userId: "u_req", reason: "requester" }],
              delegations: [],
            },
          ],
        });
        expect(await rungs.get("r1")).toBeNull();
        expect(await outbox(store)).toEqual([]);
      });

      it("a submittable preview matches what a submit then does", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(expense);
        const preview = await rungs.preview({
          flow: "expense",
          requesterId: "u_req",
          subject: { type: "expense", id: "EXP-1" },
          payload: { amount: 5000 },
        });
        expect(preview.submittable).toBe(true);
        const state = await rungs.submit(submitInput());
        expect(state.steps[0]?.approvers).toEqual(preview.steps[0]?.approvers);
      });

      it("the subject is required and reaches the resolvers, like on submit", async () => {
        const seen: string[] = [];
        const { rungs } = await setup({
          resolvers: {
            projectOwner: async ({ request }) => {
              seen.push(`${request.subject.type}:${request.subject.id}`);
              return ["u_po"];
            },
          },
        });
        await rungs.flows.register({
          key: "project",
          steps: [{ id: "owner", approvers: { type: "resolver", name: "projectOwner" } }],
        });
        const missing = { flow: "project", requesterId: "u_req", payload: {} };
        await expect(rungs.preview(missing as never)).rejects.toThrow(
          "subject.type must be a non-empty string",
        );
        await expect(
          rungs.preview({ ...missing, subject: { type: "project", id: "" } }),
        ).rejects.toBeInstanceOf(InvalidCommandError);
        expect(seen).toEqual([]);
        const preview = await rungs.preview({
          ...missing,
          subject: { type: "project", id: "P-9" },
        });
        expect(preview.steps[0]?.approvers).toEqual(["u_po"]);
        expect(seen).toEqual(["project:P-9"]);
      });

      it("an invalid payload fails the preview like a submit", async () => {
        const { rungs } = await setup();
        await rungs.flows.register(purchase);
        await expect(
          rungs.preview({
            flow: "purchase",
            requesterId: "u_req",
            subject: { type: "purchase", id: "PO-7" },
            payload: { amount: "x" },
          }),
        ).rejects.toThrow("Condition cannot be evaluated");
      });
    });

    describe("delegation rules", () => {
      const january = { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-02-01T00:00:00.000Z" };

      it("set stores a rule with a generated id; list finds it from both sides", async () => {
        const { rungs } = await setup();
        const rule = await rungs.delegations.set({
          fromUserId: "u_a",
          toUserId: "u_b",
          ...january,
          scope: { flowKeys: ["expense"] },
        });
        expect(rule).toEqual({
          id: "r1",
          fromUserId: "u_a",
          toUserId: "u_b",
          ...january,
          scope: { flowKeys: ["expense"] },
        });
        expect(await rungs.delegations.list({ userId: "u_a" })).toEqual([rule]);
        expect(await rungs.delegations.list({ userId: "u_b" })).toEqual([rule]);
        expect(await rungs.delegations.list({ userId: "u_c" })).toEqual([]);
      });

      it("set refuses self-delegation, bad times and an empty period", async () => {
        const { rungs } = await setup();
        const bad = [
          { fromUserId: "u_a", toUserId: "u_a", ...january },
          { fromUserId: "u_a", toUserId: "u_b", startsAt: "tomorrow", endsAt: january.endsAt },
          {
            fromUserId: "u_a",
            toUserId: "u_b",
            startsAt: january.endsAt,
            endsAt: january.startsAt,
          },
          { fromUserId: "", toUserId: "u_b", ...january },
        ];
        for (const input of bad) {
          await expect(rungs.delegations.set(input)).rejects.toBeInstanceOf(InvalidCommandError);
        }
      });

      it("end stops an active rule now; tasks already delegated stay (EC-24)", async () => {
        const { rungs, at } = await setup();
        await rungs.flows.register(expense);
        const rule = await rungs.delegations.set({
          fromUserId: "u_mgr",
          toUserId: "u_b",
          ...january,
        });
        await rungs.submit(submitInput());
        at("2026-01-10T00:00:00.000Z");
        const ended = await rungs.delegations.end({ id: rule.id });
        expect(ended).toEqual({ ...rule, endsAt: "2026-01-10T00:00:00.000Z" });
        expect((await rungs.get("r2"))?.steps[0]?.tasks[0]?.assigneeId).toBe("u_b");
        const next = await rungs.submit(submitInput());
        expect(next.steps[0]?.tasks[0]?.assigneeId).toBe("u_mgr");
        expect(await rungs.delegations.end({ id: rule.id })).toEqual(ended);
      });

      it("end cancels a rule that has not started, which then never applies", async () => {
        const { rungs, at } = await setup();
        await rungs.flows.register(expense);
        const rule = await rungs.delegations.set({
          fromUserId: "u_mgr",
          toUserId: "u_b",
          startsAt: "2026-01-20T00:00:00.000Z",
          endsAt: "2026-01-30T00:00:00.000Z",
        });
        const cancelled = await rungs.delegations.end({ id: rule.id });
        expect(cancelled).toEqual({ ...rule, cancelledAt: T0 });
        at("2026-01-25T00:00:00.000Z");
        const state = await rungs.submit(submitInput());
        expect(state.steps[0]?.tasks[0]?.assigneeId).toBe("u_mgr");
      });

      it("end refuses an unknown rule", async () => {
        const { rungs } = await setup();
        await expect(rungs.delegations.end({ id: "nope" })).rejects.toBeInstanceOf(
          InvalidCommandError,
        );
      });
    });
  });
}
