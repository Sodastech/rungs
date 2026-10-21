import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine.js";
import {
  type FlowInput,
  InvalidCommandError,
  NotAssignedError,
  type RequestState,
  type StepInput,
} from "../../src/index.js";
import {
  approve,
  delegate,
  reassignTask,
  registeredFlow,
  reject,
  returnTo,
  rule,
  run,
  runAll,
  submitCommand,
  T0,
  T1,
  T2,
  thrown,
} from "../helpers/engine.js";

const users = (...ids: string[]) => ({ type: "users" as const, ids });

/** One step by default: manager [u_a]. */
const flow = (overrides: Partial<FlowInput> = {}, steps: StepInput[] = [single("u_a")]) =>
  registeredFlow({ key: "expense", steps, ...overrides });

function single(...ids: string[]): StepInput {
  return { id: "manager", approvers: users(...ids) };
}

const tasks = (state: RequestState, index = 0) =>
  state.steps[index]?.tasks.map((t) => [t.assigneeId, t.status, t.onBehalfOf ?? null]);

const typesOf = (audit: { type: string }[]) => audit.map((e) => e.type);

describe("C. Delegation", () => {
  describe("out-of-office rules", () => {
    it("EC-20 a task for an approver with an active rule goes to the delegate on their behalf", () => {
      const { state, audit } = run(null, submitCommand(), {
        flow: flow(),
        delegations: [rule("u_a", "u_b")],
      });
      expect(state.steps[0]?.approvers).toEqual(["u_b"]);
      expect(tasks(state)).toEqual([["u_b", "pending", "u_a"]]);
      expect(audit.find((e) => e.type === "task.assigned")?.data).toEqual({
        taskId: "r1.t1",
        stepId: "manager",
        assigneeId: "u_b",
        onBehalfOf: "u_a",
        chain: ["u_a", "u_b"],
      });

      // u_a could also decide it directly (EC-60).
      expect(run(state, approve("u_b"), { flow: flow() }).state.status).toBe("approved");
    });

    it("EC-20 only rules that are active now, in scope, in the tenant and not cancelled apply", () => {
      const ignored = [
        rule("u_a", "u_b", { startsAt: T1 }),
        rule("u_a", "u_b", { endsAt: T0 }),
        rule("u_a", "u_b", { scope: { flowKeys: ["leave"] } }),
        rule("u_a", "u_b", { tenantId: "other" }),
        rule("u_a", "u_b", { cancelledAt: T0 }),
      ];
      for (const r of ignored) {
        const { state } = run(null, submitCommand({ tenantId: "acme" }), {
          flow: flow(),
          delegations: [r],
        });
        expect(tasks(state)).toEqual([["u_a", "pending", null]]);
      }
      const scoped = run(null, submitCommand({ tenantId: "acme" }), {
        flow: flow(),
        delegations: [rule("u_a", "u_b", { scope: { flowKeys: ["expense"] }, tenantId: "acme" })],
      });
      expect(tasks(scoped.state)).toEqual([["u_b", "pending", "u_a"]]);
    });

    it("EC-20 when several rules are active the most recently started one applies", () => {
      const { state } = run(null, submitCommand(), {
        flow: flow(),
        delegations: [
          rule("u_a", "u_b"),
          rule("u_a", "u_c", { startsAt: "2026-01-04T00:00:00.000Z" }),
        ],
      });
      expect(tasks(state)).toEqual([["u_c", "pending", "u_a"]]);
    });

    it("EC-21 a chain is followed to the last delegate", () => {
      const { state, audit } = run(null, submitCommand(), {
        flow: flow(),
        delegations: [rule("u_a", "u_b"), rule("u_b", "u_c")],
      });
      expect(tasks(state)).toEqual([["u_c", "pending", "u_a"]]);
      expect(audit.find((e) => e.type === "task.assigned")?.data).toMatchObject({
        chain: ["u_a", "u_b", "u_c"],
      });
    });

    it("EC-21 a chain stops after maxDelegationDepth hops (default 3)", () => {
      const delegations = [
        rule("u_a", "u_b"),
        rule("u_b", "u_c"),
        rule("u_c", "u_d"),
        rule("u_d", "u_e"),
      ];
      const deep = run(null, submitCommand(), { flow: flow(), delegations });
      expect(tasks(deep.state)).toEqual([["u_d", "pending", "u_a"]]);
      const shallow = run(null, submitCommand(), {
        flow: flow({ maxDelegationDepth: 1 }),
        delegations,
      });
      expect(tasks(shallow.state)).toEqual([["u_b", "pending", "u_a"]]);
    });

    it("EC-22 a cycle keeps the task with the original approver and records a warning", () => {
      const { state, audit, events } = run(null, submitCommand(), {
        flow: flow(),
        delegations: [rule("u_a", "u_b"), rule("u_b", "u_c"), rule("u_c", "u_b")],
      });
      expect(tasks(state)).toEqual([["u_a", "pending", null]]);
      expect(audit.find((e) => e.type === "delegation.cycle_detected")?.data).toEqual({
        stepId: "manager",
        userId: "u_a",
        chain: ["u_a", "u_b", "u_c", "u_b"],
      });
      expect(typesOf(events)).toContain("delegation.cycle_detected");
    });

    it("EC-23 a delegate who is the requester is skipped; the task stays with the approver", () => {
      const { state, audit } = run(null, submitCommand(), {
        flow: flow(),
        delegations: [rule("u_a", "u_req")],
      });
      expect(tasks(state)).toEqual([["u_a", "pending", null]]);
      expect(audit.find((e) => e.type === "delegation.skipped")?.data).toEqual({
        stepId: "manager",
        userId: "u_a",
        toUserId: "u_req",
        reason: "requester",
      });
    });

    it("EC-23 the chain continues past a skipped requester or inactive delegate", () => {
      const viaRequester = run(null, submitCommand(), {
        flow: flow(),
        delegations: [rule("u_a", "u_req"), rule("u_req", "u_c")],
      });
      expect(tasks(viaRequester.state)).toEqual([["u_c", "pending", "u_a"]]);

      const viaInactive = run(null, submitCommand(), {
        flow: flow(),
        delegations: [rule("u_a", "u_old"), rule("u_old", "u_c")],
        inactive: ["u_old"],
      });
      expect(tasks(viaInactive.state)).toEqual([["u_c", "pending", "u_a"]]);
      expect(viaInactive.audit.find((e) => e.type === "delegation.skipped")?.data).toMatchObject({
        toUserId: "u_old",
        reason: "inactive",
      });
    });

    it("EC-23 with allowSelfApproval the requester can be a delegate", () => {
      const { state } = run(null, submitCommand(), {
        flow: flow({ allowSelfApproval: true }),
        delegations: [rule("u_a", "u_req")],
      });
      expect(tasks(state)).toEqual([["u_req", "pending", "u_a"]]);
    });

    it("EC-24 a task stays with the delegate after the rule ends", () => {
      const delegations = [rule("u_a", "u_b", { endsAt: "2026-01-05T09:30:00.000Z" })];
      const submitted = run(null, submitCommand(), { flow: flow(), delegations });
      const { state } = run(submitted.state, approve("u_b"), {
        flow: flow(),
        now: T2,
        delegations,
      });
      expect(state.status).toBe("approved");
    });
  });

  describe("one person, one vote", () => {
    it("EC-48 a delegation to someone who already approves in the step is skipped", () => {
      const target = flow({}, [single("u_a", "u_d")]);
      const { state, audit } = run(null, submitCommand(), {
        flow: target,
        delegations: [rule("u_a", "u_d")],
      });
      expect(tasks(state)).toEqual([
        ["u_a", "pending", null],
        ["u_d", "pending", null],
      ]);
      expect(audit.find((e) => e.type === "delegation.skipped")?.data).toEqual({
        stepId: "manager",
        userId: "u_a",
        toUserId: "u_d",
        reason: "target-already-approver",
      });
    });

    it("EC-48 two approvers delegating to the same person: only the first delegation applies", () => {
      const target = flow({}, [{ ...single("u_a", "u_c"), mode: "all" }]);
      const { state } = run(null, submitCommand(), {
        flow: target,
        delegations: [rule("u_a", "u_d"), rule("u_c", "u_d")],
      });
      expect(tasks(state)).toEqual([
        ["u_d", "pending", "u_a"],
        ["u_c", "pending", null],
      ]);
      const partial = run(state, approve("u_d"), { flow: target });
      expect(partial.state.steps[0]?.status).toBe("active");
    });

    it("EC-48 a chain stops before a delegate who already holds a vote", () => {
      const target = flow({}, [single("u_a", "u_c")]);
      const { state, audit } = run(null, submitCommand(), {
        flow: target,
        delegations: [rule("u_a", "u_b"), rule("u_b", "u_c")],
      });
      expect(tasks(state)).toEqual([
        ["u_b", "pending", "u_a"],
        ["u_c", "pending", null],
      ]);
      expect(audit.find((e) => e.type === "delegation.skipped")?.data).toMatchObject({
        userId: "u_b",
        toUserId: "u_c",
        reason: "target-already-approver",
      });
    });

    it("EC-48 someone whose vote is already in the step cannot receive another one", () => {
      const target = flow({}, [single("u_a", "u_d")]);
      const delegations = [rule("u_a", "u_c")];
      const state = run(null, submitCommand(), { flow: target, delegations }).state;
      expect(tasks(state)).toEqual([
        ["u_c", "pending", "u_a"],
        ["u_d", "pending", null],
      ]);
      // u_a holds no task, but u_a's vote is in the step (u_c acts for u_a).
      for (const command of [delegate("u_d", "r1.t2", "u_a"), reassignTask("r1.t2", "u_a")]) {
        const error = thrown(() => run(state, command, { flow: target, delegations }));
        expect(error).toBeInstanceOf(InvalidCommandError);
        expect((error as Error).message).toContain('"u_a" already has a vote in step "manager"');
      }
      // Handing u_a's own vote back stays allowed (EC-50).
      const back = run(state, reassignTask("r1.t1", "u_a"), { flow: target, delegations }).state;
      expect(tasks(back)?.at(-1)).toEqual(["u_a", "pending", null]);
    });

    it("EC-49 a delegation to someone who approved an earlier step is skipped", () => {
      const target = flow({}, [
        { id: "manager", approvers: users("u_m") },
        { id: "finance", approvers: users("u_a") },
      ]);
      const delegations = [rule("u_a", "u_m")];
      const { state, audit } = runAll([submitCommand(), approve("u_m")], {
        flow: target,
        delegations,
      });
      expect(tasks(state, 1)).toEqual([["u_a", "pending", null]]);
      expect(audit.find((e) => e.type === "delegation.skipped")?.data).toMatchObject({
        toUserId: "u_m",
        reason: "target-already-decided",
      });
    });
  });

  describe("manual delegation", () => {
    const parallel = flow({}, [{ ...single("u_a", "u_c"), mode: "all" }]);
    const start = () => run(null, submitCommand(), { flow: parallel }).state;

    it("EC-25 an approver hands a task to a delegate; both tasks are audited", () => {
      const ctx = { now: T1, flow: parallel };
      expect(decide(start(), delegate("u_a", "r1.t1", "u_b", "Travelling"), ctx)).toEqual({
        kind: "needs-resolution",
        needs: [{ key: "delegate:r1.t1", stepId: "manager", spec: users("u_b") }],
      });

      const { state, audit } = run(start(), delegate("u_a", "r1.t1", "u_b", "Travelling"), {
        flow: parallel,
        now: T1,
      });
      expect(state.steps[0]?.tasks).toEqual([
        { id: "r1.t1", assigneeId: "u_a", status: "delegated", assignedAt: T0, decidedAt: T1 },
        { id: "r1.t2", assigneeId: "u_c", status: "pending", assignedAt: T0 },
        { id: "r1.t3", assigneeId: "u_b", onBehalfOf: "u_a", status: "pending", assignedAt: T1 },
      ]);
      expect(audit.map((e) => [e.type, e.actorId, e.data])).toEqual([
        [
          "task.delegated",
          "u_a",
          {
            taskId: "r1.t1",
            stepId: "manager",
            toTaskId: "r1.t3",
            toUserId: "u_b",
            comment: "Travelling",
          },
        ],
        [
          "task.assigned",
          "u_a",
          { taskId: "r1.t3", stepId: "manager", assigneeId: "u_b", onBehalfOf: "u_a" },
        ],
      ]);

      // u_a's own task is retired; u_a can still decide the delegated one directly (EC-60).
      const afterDelegate = run(state, approve("u_b"), { flow: parallel }).state;
      expect(afterDelegate.steps[0]?.status).toBe("active");
      expect(run(afterDelegate, approve("u_c"), { flow: parallel }).state.status).toBe("approved");
    });

    it("EC-25 the delegate's own out-of-office rule applies to the new task", () => {
      const { state } = run(start(), delegate("u_a", "r1.t1", "u_b"), {
        flow: parallel,
        delegations: [rule("u_b", "u_e")],
      });
      expect(tasks(state)).toEqual([
        ["u_a", "delegated", null],
        ["u_c", "pending", null],
        ["u_e", "pending", "u_a"],
      ]);
    });

    it("EC-25 a delegated task can be delegated again and keeps the original approver", () => {
      const once = run(start(), delegate("u_a", "r1.t1", "u_b"), { flow: parallel }).state;
      const twice = run(once, delegate("u_b", "r1.t3", "u_e"), { flow: parallel }).state;
      expect(twice.steps[0]?.tasks.at(-1)).toMatchObject({ assigneeId: "u_e", onBehalfOf: "u_a" });
    });

    it("EC-25 only the assignee of a pending task can delegate it", () => {
      expect(
        thrown(() => run(start(), delegate("u_c", "r1.t1", "u_b"), { flow: parallel })),
      ).toBeInstanceOf(NotAssignedError);
      const decided = run(start(), approve("u_a"), { flow: parallel }).state;
      expect(
        thrown(() => run(decided, delegate("u_a", "r1.t1", "u_b"), { flow: parallel })),
      ).toBeInstanceOf(NotAssignedError);
      const unknown = thrown(() =>
        run(start(), delegate("u_a", "r1.t9", "u_b"), { flow: parallel }),
      );
      expect(unknown).toBeInstanceOf(InvalidCommandError);
    });

    it("EC-48 a manual delegation is refused for yourself, the requester, inactive users and current holders", () => {
      const cases: [string, string, string[]][] = [
        ["u_a", "cannot delegate a task to its own assignee", []],
        ["u_req", '"u_req" is the requester', []],
        ["u_old", '"u_old" is inactive', ["u_old"]],
        ["u_c", '"u_c" already holds a task in step "manager"', []],
      ];
      for (const [to, message, inactive] of cases) {
        const error = thrown(() =>
          run(start(), delegate("u_a", "r1.t1", to), { flow: parallel, inactive }),
        );
        expect(error).toBeInstanceOf(InvalidCommandError);
        expect((error as Error).message).toContain(message);
      }
    });

    it("EC-49 a manual delegation to someone who approved an earlier step is refused", () => {
      const target = flow({}, [
        { id: "manager", approvers: users("u_m") },
        { id: "finance", approvers: users("u_a") },
      ]);
      const { state } = runAll([submitCommand(), approve("u_m")], { flow: target });
      const error = thrown(() => run(state, delegate("u_a", "r1.t2", "u_m"), { flow: target }));
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect((error as Error).message).toContain('"u_m" already approved step "manager"');
    });
  });

  describe("the owner decides a delegated task", () => {
    const parallel = flow({}, [{ ...single("u_a", "u_c"), mode: "all" }]);
    /** u_a handed r1.t1 to u_b by hand: r1.t3 is held by u_b on behalf of u_a. */
    const delegated = () => {
      const submitted = run(null, submitCommand(), { flow: parallel }).state;
      return run(submitted, delegate("u_a", "r1.t1", "u_b"), { flow: parallel }).state;
    };
    const task = (state: RequestState, id: string) =>
      state.steps.flatMap((step) => step.tasks).find((t) => t.id === id);

    it("EC-60 the approver a task acts for can approve it directly; the audit names both", () => {
      const { state, audit, events } = run(delegated(), approve("u_a", "Back early"), {
        flow: parallel,
        now: T1,
      });
      expect(task(state, "r1.t3")).toEqual({
        id: "r1.t3",
        assigneeId: "u_b",
        onBehalfOf: "u_a",
        status: "approved",
        assignedAt: T0,
        decidedAt: T1,
        decidedBy: "u_a",
        comment: "Back early",
      });
      expect(audit[0]).toMatchObject({
        type: "task.approved",
        actorId: "u_a",
        data: {
          taskId: "r1.t3",
          stepId: "manager",
          comment: "Back early",
          onBehalfOf: "u_a",
          heldBy: "u_b",
        },
      });
      expect(events[0]).toMatchObject({
        type: "task.decided",
        data: { decision: "approved", onBehalfOf: "u_a", heldBy: "u_b" },
      });
      // One task, one vote: the delegate can no longer decide it, and u_c still has to.
      expect(state.steps[0]?.status).toBe("active");
      expect(thrown(() => run(state, approve("u_b"), { flow: parallel }))).toBeInstanceOf(
        NotAssignedError,
      );
      expect(run(state, approve("u_c"), { flow: parallel }).state.status).toBe("approved");
    });

    it("EC-60 when the delegate decides first, the owner can no longer; the audit names the owner", () => {
      const { state, audit } = run(delegated(), approve("u_b"), { flow: parallel });
      expect(audit[0]).toMatchObject({
        actorId: "u_b",
        data: { taskId: "r1.t3", onBehalfOf: "u_a" },
      });
      expect(audit[0]?.data).not.toHaveProperty("heldBy");
      expect(task(state, "r1.t3")).not.toHaveProperty("decidedBy");
      expect(thrown(() => run(state, approve("u_a"), { flow: parallel }))).toBeInstanceOf(
        NotAssignedError,
      );
    });

    it("EC-60 the owner can also reject or return, and it works for out-of-office delegation", () => {
      const rejected = run(delegated(), reject("u_a", "No"), { flow: parallel });
      expect(rejected.state.status).toBe("rejected");
      expect(rejected.audit[0]).toMatchObject({ type: "task.rejected", data: { heldBy: "u_b" } });

      const returned = run(delegated(), returnTo("u_a", "requester"), { flow: parallel });
      expect(returned.state.status).toBe("returned");
      expect(returned.audit[0]).toMatchObject({
        type: "task.returned",
        actorId: "u_a",
        data: { onBehalfOf: "u_a", heldBy: "u_b" },
      });

      const delegations = [rule("u_a", "u_b")];
      const byRule = run(null, submitCommand(), { flow: flow(), delegations }).state;
      const decided = run(byRule, approve("u_a"), { flow: flow(), delegations });
      expect(decided.state.status).toBe("approved");
      expect(task(decided.state, "r1.t1")).toMatchObject({ assigneeId: "u_b", decidedBy: "u_a" });
    });

    it("EC-60 only the owner: someone in the middle of a chain, or after a reassign, cannot", () => {
      const twice = run(delegated(), delegate("u_b", "r1.t3", "u_e"), { flow: parallel }).state;
      expect(thrown(() => run(twice, approve("u_b"), { flow: parallel }))).toBeInstanceOf(
        NotAssignedError,
      );
      expect(task(run(twice, approve("u_a"), { flow: parallel }).state, "r1.t4")).toMatchObject({
        assigneeId: "u_e",
        decidedBy: "u_a",
      });

      const reassigned = run(delegated(), reassignTask("r1.t3", "u_x"), { flow: parallel }).state;
      expect(thrown(() => run(reassigned, approve("u_a"), { flow: parallel }))).toBeInstanceOf(
        NotAssignedError,
      );
    });

    it("EC-60 the owner cannot delegate the task further; only its holder can", () => {
      expect(
        thrown(() => run(delegated(), delegate("u_a", "r1.t3", "u_e"), { flow: parallel })),
      ).toBeInstanceOf(NotAssignedError);
    });
  });

  describe("returning a vote to its owner", () => {
    const parallel = flow({}, [{ ...single("u_a", "u_c"), mode: "all" }]);
    /** u_a is away: their task r1.t1 went to u_b by hand (r1.t3, on behalf of u_a). */
    const delegated = () => {
      const submitted = run(null, submitCommand(), { flow: parallel }).state;
      return run(submitted, delegate("u_a", "r1.t1", "u_b"), { flow: parallel }).state;
    };

    it("EC-50 a delegate can hand the task back to the approver it represents", () => {
      const { state, audit } = run(delegated(), delegate("u_b", "r1.t3", "u_a"), {
        flow: parallel,
        now: T1,
      });
      expect(tasks(state)).toEqual([
        ["u_a", "delegated", null],
        ["u_c", "pending", null],
        ["u_b", "delegated", "u_a"],
        ["u_a", "pending", null],
      ]);
      expect(audit.map((e) => [e.type, e.data])).toEqual([
        [
          "task.delegated",
          {
            taskId: "r1.t3",
            stepId: "manager",
            toTaskId: "r1.t4",
            toUserId: "u_a",
            returnedToOriginal: true,
          },
        ],
        ["task.assigned", { taskId: "r1.t4", stepId: "manager", assigneeId: "u_a" }],
      ]);
      const after = run(state, approve("u_a"), { flow: parallel }).state;
      expect(after.steps[0]?.tasks.at(-1)?.status).toBe("approved");
    });

    it("EC-50 an admin can reassign a delegated task back to the approver it represents", () => {
      const { state, audit } = run(delegated(), reassignTask("r1.t3", "u_a", "Back early"), {
        flow: parallel,
      });
      expect(tasks(state)?.at(-2)).toEqual(["u_b", "reassigned", "u_a"]);
      expect(tasks(state)?.at(-1)).toEqual(["u_a", "pending", null]);
      expect(audit[0]?.data).toMatchObject({ toUserId: "u_a", returnedToOriginal: true });
    });

    it("EC-50 also works for a task delegated by an out-of-office rule", () => {
      const delegations = [rule("u_a", "u_b")];
      const byRule = run(null, submitCommand(), { flow: flow(), delegations }).state;
      const { state } = run(byRule, delegate("u_b", "r1.t1", "u_a"), {
        flow: flow(),
        delegations,
      });
      expect(tasks(state)).toEqual([
        ["u_b", "delegated", "u_a"],
        ["u_a", "pending", null],
      ]);
    });

    it("EC-50 the owner must still be active and the vote never goes back to anyone else", () => {
      const inactive = thrown(() =>
        run(delegated(), delegate("u_b", "r1.t3", "u_a"), { flow: parallel, inactive: ["u_a"] }),
      );
      expect((inactive as Error).message).toContain('"u_a" is inactive');

      const returned = run(delegated(), delegate("u_b", "r1.t3", "u_a"), { flow: parallel }).state;
      const pingPong = thrown(() =>
        run(returned, delegate("u_a", "r1.t4", "u_b"), { flow: parallel }),
      );
      expect((pingPong as Error).message).toContain('"u_b" already holds a task');
    });
  });

  describe("reassigning a task", () => {
    const parallel = flow({}, [{ ...single("u_a", "u_c"), mode: "all" }]);
    const start = () => run(null, submitCommand(), { flow: parallel }).state;

    it("an admin moves a pending task to another user; the old task is reassigned", () => {
      const { state, audit } = run(start(), reassignTask("r1.t1", "u_x"), {
        flow: parallel,
        now: T1,
      });
      expect(tasks(state)).toEqual([
        ["u_a", "reassigned", null],
        ["u_c", "pending", null],
        ["u_x", "pending", null],
      ]);
      expect(state.steps[0]?.tasks[0]?.decidedAt).toBe(T1);
      expect(audit.map((e) => [e.type, e.actorId])).toEqual([
        ["task.reassigned", "u_admin"],
        ["task.assigned", "u_admin"],
      ]);
      expect(audit[0]?.data).toEqual({
        taskId: "r1.t1",
        stepId: "manager",
        toTaskId: "r1.t3",
        toUserId: "u_x",
        comment: "Approver left",
      });
    });

    it("EC-48 the out-of-office delegate of the chosen user is checked; the task stays with that user", () => {
      const holder = run(start(), reassignTask("r1.t1", "u_x"), {
        flow: parallel,
        delegations: [rule("u_x", "u_c")],
      });
      expect(tasks(holder.state)?.at(-1)).toEqual(["u_x", "pending", null]);
      expect(holder.audit.find((e) => e.type === "delegation.skipped")?.data).toMatchObject({
        reason: "target-already-approver",
      });

      const target = flow({}, [
        { id: "manager", approvers: users("u_m") },
        { id: "finance", approvers: users("u_a") },
      ]);
      const { state } = runAll([submitCommand(), approve("u_m")], { flow: target });
      const decided = run(state, reassignTask("r1.t2", "u_x"), {
        flow: target,
        delegations: [rule("u_x", "u_m")],
      });
      expect(tasks(decided.state, 1)?.at(-1)).toEqual(["u_x", "pending", null]);
      expect(decided.audit.find((e) => e.type === "delegation.skipped")?.data).toMatchObject({
        reason: "target-already-decided",
      });

      const away = run(start(), reassignTask("r1.t1", "u_x"), {
        flow: parallel,
        delegations: [rule("u_x", "u_y")],
      });
      expect(tasks(away.state)?.at(-1)).toEqual(["u_y", "pending", "u_x"]);
    });

    it("a reassigned delegated task no longer acts on behalf of anyone", () => {
      const delegated = run(start(), delegate("u_a", "r1.t1", "u_b"), { flow: parallel }).state;
      const { state } = run(delegated, reassignTask("r1.t3", "u_x"), { flow: parallel });
      expect(state.steps[0]?.tasks.at(-1)).toEqual({
        id: "r1.t4",
        assigneeId: "u_x",
        status: "pending",
        assignedAt: T0,
      });
    });

    it("EC-48 reassigning a task is refused for the requester, inactive users and current holders", () => {
      const cases: [string, string, string[]][] = [
        ["u_req", '"u_req" is the requester', []],
        ["u_old", '"u_old" is inactive', ["u_old"]],
        ["u_c", '"u_c" already holds a task in step "manager"', []],
        ["u_a", '"u_a" already holds a task in step "manager"', []],
      ];
      for (const [to, message, inactive] of cases) {
        const error = thrown(() =>
          run(start(), reassignTask("r1.t1", to), { flow: parallel, inactive }),
        );
        expect(error).toBeInstanceOf(InvalidCommandError);
        expect((error as Error).message).toContain(message);
      }
    });

    it("EC-49 reassigning a task to someone who approved an earlier step is refused", () => {
      const target = flow({}, [
        { id: "manager", approvers: users("u_m") },
        { id: "finance", approvers: users("u_a") },
      ]);
      const { state } = runAll([submitCommand(), approve("u_m")], { flow: target });
      const error = thrown(() => run(state, reassignTask("r1.t2", "u_m"), { flow: target }));
      expect((error as Error).message).toContain('"u_m" already approved step "manager"');
    });

    it("only a pending task can be reassigned, and a command names a task or a step, not both", () => {
      const decided = run(start(), approve("u_a"), { flow: parallel }).state;
      expect(
        thrown(() => run(decided, reassignTask("r1.t1", "u_x"), { flow: parallel })),
      ).toBeInstanceOf(InvalidCommandError);
      const both = { ...reassignTask("r1.t1", "u_x"), stepId: "manager", toUserIds: ["u_x"] };
      const error = thrown(() => run(start(), both as never, { flow: parallel }));
      expect((error as Error).message).toContain("either stepId or taskId");
    });
  });
});
