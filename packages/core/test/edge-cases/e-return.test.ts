import { describe, expect, it } from "vitest";
import {
  ConditionError,
  decide,
  InvalidCommandError,
  InvalidTransitionError,
  NoApproversError,
  NotAssignedError,
  type RequestState,
} from "../../src/index.js";
import {
  approve,
  expenseFlow,
  override,
  registeredFlow,
  reject,
  resubmit,
  returnTo,
  run,
  runAll,
  submitCommand,
  T2,
  T3,
  thrown,
  withdraw,
} from "../helpers/engine.js";

const fromReturned = registeredFlow({
  key: "expense",
  returnPolicy: "from-returned-step",
  steps: expenseFlow.steps,
});

/** manager approved, then finance returned the request to the requester at T2. */
const returnedByFinance = (flow = expenseFlow) =>
  runAll([submitCommand(), approve("u_mgr"), returnTo("u_fin", "requester", "Attach receipt")], {
    flow,
  });

const history = (state: RequestState) =>
  state.steps.map((s) => [s.stepId, s.status, s.invalidatedAt ?? null]);

describe("E. Lifecycle: return, resubmit, withdraw", () => {
  describe("return to the requester", () => {
    it("EC-32 an approver returns the request; the requester can edit and resubmit", () => {
      const { state, audit, events } = returnedByFinance();
      expect(state).toMatchObject({ status: "returned", currentStepIndex: null });
      expect(state.closedAt).toBeUndefined();
      expect(state.steps[1]).toMatchObject({
        stepId: "finance",
        status: "returned",
        closedAt: T2,
        tasks: [{ status: "returned", comment: "Attach receipt", decidedAt: T2 }],
      });
      expect(audit.map((e) => [e.type, e.data])).toEqual([
        [
          "task.returned",
          { taskId: "r1.t2", stepId: "finance", to: "requester", comment: "Attach receipt" },
        ],
        ["step.completed", { stepId: "finance", stepIndex: 1, outcome: "returned" }],
        ["request.returned", { stepId: "finance", comment: "Attach receipt" }],
      ]);
      expect(events.map((e) => e.type)).toEqual([
        "task.returned",
        "step.completed",
        "request.returned",
      ]);
    });

    it("EC-32 in a parallel step the other pending tasks are superseded", () => {
      const flow = registeredFlow({
        key: "review",
        steps: [
          { id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b"] }, mode: "all" },
        ],
      });
      const { state } = runAll([submitCommand(), returnTo("u_b", "requester")], { flow });
      expect(state.steps[0]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
        ["u_a", "superseded"],
        ["u_b", "returned"],
      ]);
    });

    it("EC-32 a returned request accepts no decisions, and only the requester resubmits", () => {
      const { state } = returnedByFinance();
      expect(thrown(() => run(state, approve("u_dir")))).toBeInstanceOf(InvalidTransitionError);
      const error = thrown(() => run(state, resubmit(undefined, "u_mgr")));
      expect(error).toBeInstanceOf(NotAssignedError);
      expect((error as Error).message).toContain("not the requester");
      expect(thrown(() => run(state, returnTo("u_fin", "requester")))).toBeInstanceOf(
        InvalidTransitionError,
      );
    });
  });

  describe("return to a previous step", () => {
    const returnedToManager = (options = {}) =>
      runAll(
        [
          submitCommand(),
          approve("u_mgr"),
          approve("u_fin"),
          returnTo("u_dir", { stepId: "manager" }, "Wrong cost centre"),
        ],
        options,
      );

    it("EC-33 that step re-activates and every step from it runs again", () => {
      const { state, audit } = returnedToManager();
      expect(state).toMatchObject({ status: "pending", currentStepIndex: 0 });
      expect(history(state)).toEqual([
        ["manager", "approved", T3],
        ["finance", "approved", T3],
        ["director", "returned", T3],
        ["manager", "active", null],
      ]);
      expect(audit.map((e) => e.type)).toEqual([
        "task.returned",
        "step.completed",
        "step.activated",
        "task.assigned",
      ]);
      expect(audit[0]?.data).toMatchObject({ to: { stepId: "manager" } });

      const again = run(state, approve("u_mgr"));
      expect(again.state.steps.at(-1)).toMatchObject({ stepId: "finance", status: "active" });
    });

    it("EC-33 the step is resolved afresh", () => {
      const before = runAll([submitCommand(), approve("u_mgr"), approve("u_fin")]).state;
      const ctx = { now: T3, flow: expenseFlow };
      expect(decide(before, returnTo("u_dir", { stepId: "manager" }), ctx)).toEqual({
        kind: "needs-resolution",
        needs: [{ key: "manager", stepId: "manager", spec: { type: "users", ids: ["u_mgr"] } }],
      });
      const { state } = run(before, returnTo("u_dir", { stepId: "manager" }), {
        now: T3,
        approvers: { manager: ["u_mgr2"] },
      });
      expect(state.steps.at(-1)?.approvers).toEqual(["u_mgr2"]);
    });

    it("EC-33 approvals that no longer count are not carried over by dedupe", () => {
      const flow = registeredFlow({
        key: "expense",
        dedupeApprovers: "all",
        steps: expenseFlow.steps,
      });
      const { state } = returnedToManager({ flow });
      expect(state.steps.at(-1)?.tasks.map((t) => t.status)).toEqual(["pending"]);
    });

    it("EC-33 the target must be an earlier step that ran", () => {
      const at = runAll([submitCommand({ payload: { amount: 10 } }), approve("u_mgr")]).state;
      for (const stepId of ["director", "finance", "nope"]) {
        const error = thrown(() => run(at, returnTo("u_dir", { stepId })));
        expect(error).toBeInstanceOf(InvalidCommandError);
      }
      expect(thrown(() => run(at, returnTo("u_mgr", "requester")))).toBeInstanceOf(
        NotAssignedError,
      );
    });
  });

  describe("resubmit", () => {
    it("EC-34 with restart (default) every step runs again from the beginning", () => {
      const { state } = returnedByFinance();
      const { state: next, audit } = run(state, resubmit({ amount: 4000 }), { now: T3 });
      expect(next).toMatchObject({
        status: "pending",
        payload: { amount: 4000 },
        currentStepIndex: 0,
      });
      expect(history(next)).toEqual([
        ["manager", "approved", T3],
        ["finance", "returned", T3],
        ["manager", "active", null],
      ]);
      expect(audit.map((e) => [e.type, e.actorId])).toEqual([
        ["request.resubmitted", "u_req"],
        ["step.activated", "u_req"],
        ["task.assigned", "u_req"],
      ]);
      expect(audit[0]?.data).toEqual({
        returnPolicy: "restart",
        applied: "restart",
        payloadChanged: true,
      });
    });

    it("EC-34 with from-returned-step and the same payload it resumes at the step that returned", () => {
      const { state } = returnedByFinance(fromReturned);
      const { state: next, audit } = run(state, resubmit(), { flow: fromReturned, now: T3 });
      expect(history(next)).toEqual([
        ["manager", "approved", null],
        ["finance", "returned", T3],
        ["finance", "active", null],
      ]);
      expect(audit[0]?.data).toEqual({
        returnPolicy: "from-returned-step",
        applied: "from-returned-step",
        payloadChanged: false,
      });
      const afterFinance = run(next, approve("u_fin"), { flow: fromReturned }).state;
      const done = run(afterFinance, approve("u_dir"), { flow: fromReturned }).state;
      expect(done.status).toBe("approved");
    });

    it("EC-34 resubmit asks for the approvers of every step that will run (EC-43)", () => {
      const restart = returnedByFinance().state;
      const a = decide(restart, resubmit(), { now: T3, flow: expenseFlow });
      expect(a.kind === "needs-resolution" && a.needs.map((n) => n.key)).toEqual([
        "manager",
        "finance",
        "director",
      ]);
      const resume = returnedByFinance(fromReturned).state;
      const b = decide(resume, resubmit(), { now: T3, flow: fromReturned });
      expect(b.kind === "needs-resolution" && b.needs.map((n) => n.key)).toEqual([
        "finance",
        "director",
      ]);
    });

    it("EC-51 from-returned-step restarts from the beginning when the payload changed", () => {
      const { state } = returnedByFinance(fromReturned);
      const { state: next, audit } = run(state, resubmit({ amount: 900 }), {
        flow: fromReturned,
        now: T3,
      });
      expect(history(next)).toEqual([
        ["manager", "approved", T3],
        ["finance", "returned", T3],
        ["manager", "active", null],
      ]);
      expect(audit[0]?.data).toEqual({
        returnPolicy: "from-returned-step",
        applied: "restart",
        payloadChanged: true,
      });
    });

    it("EC-51 the same data with keys in another order counts as unchanged", () => {
      const flow = fromReturned;
      const submitted = runAll(
        [
          submitCommand({ payload: { amount: 5000, cc: "A1" } }),
          approve("u_mgr"),
          returnTo("u_fin", "requester"),
        ],
        { flow },
      ).state;
      const { audit } = run(submitted, resubmit({ cc: "A1", amount: 5000 }), { flow });
      expect(audit[0]?.data).toMatchObject({
        applied: "from-returned-step",
        payloadChanged: false,
      });
    });

    it("EC-41 resubmit evaluates every condition against the new payload up front", () => {
      const { state } = returnedByFinance();
      const error = thrown(() => run(state, resubmit({ amount: "lots" })));
      expect(error).toBeInstanceOf(ConditionError);
    });

    it("EC-43 resubmit is refused when a step that will run has no approvers", () => {
      const { state } = returnedByFinance();
      const error = thrown(() => run(state, resubmit(), { approvers: { director: [] } }));
      expect(error).toBeInstanceOf(NoApproversError);
      expect(error).toMatchObject({ stepId: "director" });
    });

    it("EC-37 resubmit stays on the pinned flow version", () => {
      const { state } = returnedByFinance();
      const v2 = registeredFlow({ key: "expense", steps: expenseFlow.steps }, 2);
      expect(thrown(() => run(state, resubmit(), { flow: v2 }))).toBeInstanceOf(
        InvalidCommandError,
      );
      expect(run(state, resubmit()).state.flowVersion).toBe(1);
    });
  });

  describe("withdraw", () => {
    const parallel = registeredFlow({
      key: "review",
      steps: [{ id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b"] }, mode: "all" }],
    });

    it("EC-35 the requester withdraws; pending tasks are cancelled and events emitted", () => {
      const { state, audit, events } = runAll(
        [submitCommand(), approve("u_a"), withdraw("u_req", "No longer needed")],
        { flow: parallel },
      );
      expect(state).toMatchObject({ status: "withdrawn", closedAt: T2, currentStepIndex: null });
      expect(state.steps[0]?.status).toBe("cancelled");
      expect(state.steps[0]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
        ["u_a", "approved"],
        ["u_b", "cancelled"],
      ]);
      expect(audit.map((e) => [e.type, e.actorId])).toEqual([
        ["task.cancelled", "u_req"],
        ["step.cancelled", "u_req"],
        ["request.withdrawn", "u_req"],
      ]);
      expect(audit.at(-1)?.data).toEqual({ comment: "No longer needed" });
      expect(events.at(-1)?.type).toBe("request.withdrawn");
    });

    it("EC-35 a returned request can be withdrawn too", () => {
      const { state } = returnedByFinance();
      const { state: next, audit } = run(state, withdraw());
      expect(next.status).toBe("withdrawn");
      expect(audit.map((e) => e.type)).toEqual(["request.withdrawn"]);
    });

    it("EC-35 only the requester can withdraw, and only an open request", () => {
      const { state } = run(null, submitCommand());
      expect(thrown(() => run(state, withdraw("u_mgr")))).toBeInstanceOf(NotAssignedError);
      const closed = runAll([submitCommand(), reject("u_mgr")]).state;
      expect(thrown(() => run(closed, withdraw()))).toBeInstanceOf(InvalidTransitionError);
      const withdrawn = run(state, withdraw()).state;
      expect(thrown(() => run(withdrawn, withdraw()))).toBeInstanceOf(InvalidTransitionError);
      expect(thrown(() => run(withdrawn, resubmit()))).toBeInstanceOf(InvalidTransitionError);
    });
  });

  it("EC-18 an admin can override a returned request", () => {
    const { state } = returnedByFinance();
    const { state: next } = run(state, override("approve"), { now: T3 });
    expect(next.status).toBe("approved");
  });
});
