import { describe, expect, it } from "vitest";
import {
  InvalidCommandError,
  InvalidTransitionError,
  NotAssignedError,
  type RequestState,
  type StepMode,
} from "../../src/index.js";
import {
  approve,
  override,
  registeredFlow,
  reject,
  run,
  runAll,
  submitCommand,
  thrown,
} from "../helpers/engine.js";

const parallelAny = registeredFlow({
  key: "review",
  steps: [
    { id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b", "u_c"] }, mode: "any" },
    { id: "final", approvers: { type: "users", ids: ["u_final"] } },
  ],
});

const parallel = (mode: StepMode, ids = ["u_a", "u_b", "u_c"]) =>
  registeredFlow({
    key: "review",
    steps: [
      { id: "reviewers", approvers: { type: "users", ids }, mode },
      { id: "final", approvers: { type: "users", ids: ["u_final"] } },
    ],
  });

const taskStatuses = (state: RequestState) =>
  state.steps[0]?.tasks.map((t) => [t.assigneeId, t.status]);

describe("B. Decisions", () => {
  it("EC-12 mode any: the first approval completes the step and supersedes the other tasks", () => {
    const { state, audit, events } = runAll([submitCommand(), approve("u_b")], {
      flow: parallelAny,
    });
    const step = state.steps[0];
    expect(step?.status).toBe("approved");
    expect(step?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
      ["u_a", "superseded"],
      ["u_b", "approved"],
      ["u_c", "superseded"],
    ]);
    expect(state.steps[1]?.stepId).toBe("final");
    expect(audit.filter((e) => e.type === "task.superseded").map((e) => e.data)).toEqual([
      { taskId: "r1.t1", stepId: "reviewers", byTaskId: "r1.t2" },
      { taskId: "r1.t3", stepId: "reviewers", byTaskId: "r1.t2" },
    ]);
    expect(events.filter((e) => e.type === "task.superseded")).toHaveLength(2);
  });

  it("EC-12 mode any: the first rejection rejects the step and supersedes the other tasks", () => {
    const { state } = runAll([submitCommand(), reject("u_c")], { flow: parallelAny });
    expect(state.status).toBe("rejected");
    expect(state.steps[0]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
      ["u_a", "superseded"],
      ["u_b", "superseded"],
      ["u_c", "rejected"],
    ]);
  });

  it("EC-17 a user without a pending task on the active step cannot decide", () => {
    const { state } = run(null, submitCommand());
    for (const actorId of ["u_stranger", "u_req", "u_fin", "u_dir"]) {
      for (const command of [approve(actorId), reject(actorId)]) {
        const error = thrown(() => run(state, command));
        expect(error).toBeInstanceOf(NotAssignedError);
        expect(error).toMatchObject({ code: "NOT_ASSIGNED", requestId: "r1", actorId });
      }
    }
  });

  it("EC-17 a superseded approver can no longer decide", () => {
    const { state } = runAll([submitCommand(), approve("u_a")], { flow: parallelAny });
    expect(thrown(() => run(state, approve("u_b"), { flow: parallelAny }))).toBeInstanceOf(
      NotAssignedError,
    );
  });

  it("EC-18 an admin override approves the request and cancels every open task", () => {
    const { state, audit, events } = runAll(
      [submitCommand(), approve("u_a"), override("approve")],
      { flow: parallel("all") },
    );
    expect(state).toMatchObject({ status: "approved", currentStepIndex: null });
    expect(state.steps[0]?.status).toBe("cancelled");
    expect(taskStatuses(state)).toEqual([
      ["u_a", "approved"],
      ["u_b", "cancelled"],
      ["u_c", "cancelled"],
    ]);
    expect(audit.map((e) => [e.type, e.actorId])).toEqual([
      ["task.cancelled", "u_admin"],
      ["task.cancelled", "u_admin"],
      ["step.cancelled", "u_admin"],
      ["request.approved", "u_admin"],
    ]);
    expect(audit.at(-1)?.data).toEqual({ reason: "override", comment: "Board decision" });
    expect(events.at(-1)?.type).toBe("request.approved");
  });

  it("EC-18 an admin override can reject the request", () => {
    const { state, audit } = runAll([submitCommand(), override("reject", "Fraud")], {
      flow: parallelAny,
    });
    expect(state.status).toBe("rejected");
    expect(audit.at(-1)).toMatchObject({
      type: "request.rejected",
      data: { reason: "override", comment: "Fraud" },
    });
  });

  it("EC-18 an override needs a reason and an open request", () => {
    const { state } = run(null, submitCommand());
    const error = thrown(() => run(state, override("approve", "  ")));
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as Error).message).toContain("reason");

    const closed = runAll([submitCommand(), reject("u_mgr")]).state;
    expect(thrown(() => run(closed, override("approve")))).toBeInstanceOf(InvalidTransitionError);
  });

  it("EC-19 deciding on an approved or rejected request fails with InvalidTransitionError", () => {
    const approved = runAll([
      submitCommand(),
      approve("u_mgr"),
      approve("u_fin"),
      approve("u_dir"),
    ]).state;
    const rejected = runAll([submitCommand(), reject("u_mgr")]).state;
    for (const state of [approved, rejected]) {
      for (const command of [approve("u_mgr"), reject("u_dir")]) {
        const error = thrown(() => run(state, command));
        expect(error).toBeInstanceOf(InvalidTransitionError);
        expect(error).toMatchObject({
          code: "INVALID_TRANSITION",
          requestId: "r1",
          status: state.status,
          command: command.type,
        });
      }
    }
  });

  describe("mode all", () => {
    const flow = parallel("all");

    it("EC-13 the step stays active until every approver has approved", () => {
      const partial = runAll([submitCommand(), approve("u_a"), approve("u_c")], { flow });
      expect(partial.state.steps[0]?.status).toBe("active");
      expect(partial.state.currentStepIndex).toBe(0);
      expect(taskStatuses(partial.state)).toEqual([
        ["u_a", "approved"],
        ["u_b", "pending"],
        ["u_c", "approved"],
      ]);
      expect(partial.audit.map((e) => e.type)).toEqual(["task.approved"]);

      const done = runAll([submitCommand(), approve("u_a"), approve("u_c"), approve("u_b")], {
        flow,
      });
      expect(done.state.steps[0]?.status).toBe("approved");
      expect(done.state.steps[1]).toMatchObject({ stepId: "final", status: "active" });
    });

    it("EC-13 one rejection rejects the step and the request immediately", () => {
      const { state, audit } = runAll([submitCommand(), approve("u_a"), reject("u_b")], { flow });
      expect(state.status).toBe("rejected");
      expect(state.steps[0]?.status).toBe("rejected");
      expect(taskStatuses(state)).toEqual([
        ["u_a", "approved"],
        ["u_b", "rejected"],
        ["u_c", "superseded"],
      ]);
      expect(audit.map((e) => e.type)).toEqual([
        "task.rejected",
        "task.superseded",
        "step.completed",
        "request.rejected",
      ]);
    });
  });

  describe("mode quorum", () => {
    it("EC-14 the step is approved as soon as the quorum is reached; the rest are superseded", () => {
      const flow = parallel({ quorum: 2 });
      const { state } = runAll([submitCommand(), approve("u_c"), approve("u_a")], { flow });
      expect(state.steps[0]?.status).toBe("approved");
      expect(taskStatuses(state)).toEqual([
        ["u_a", "approved"],
        ["u_b", "superseded"],
        ["u_c", "approved"],
      ]);
      expect(state.steps[1]?.stepId).toBe("final");
    });

    it("EC-14 a rejection that still leaves the quorum reachable keeps the step active", () => {
      const flow = parallel({ quorum: 2 });
      const { state } = runAll([submitCommand(), reject("u_a")], { flow });
      expect(state.status).toBe("pending");
      expect(state.steps[0]?.status).toBe("active");
      expect(taskStatuses(state)).toEqual([
        ["u_a", "rejected"],
        ["u_b", "pending"],
        ["u_c", "pending"],
      ]);

      const approved = runAll([submitCommand(), reject("u_a"), approve("u_b"), approve("u_c")], {
        flow,
      });
      expect(approved.state.steps[0]?.status).toBe("approved");
    });

    it("EC-14 the step is rejected as soon as the quorum becomes impossible", () => {
      const flow = parallel({ quorum: 3 }, ["u_a", "u_b", "u_c", "u_d"]);
      const afterOne = runAll([submitCommand(), approve("u_a"), reject("u_b")], { flow });
      expect(afterOne.state.steps[0]?.status).toBe("active");

      const { state } = runAll([submitCommand(), approve("u_a"), reject("u_b"), reject("u_d")], {
        flow,
      });
      expect(state.status).toBe("rejected");
      expect(taskStatuses(state)).toEqual([
        ["u_a", "approved"],
        ["u_b", "rejected"],
        ["u_c", "superseded"],
        ["u_d", "rejected"],
      ]);
    });

    it("EC-14 quorum 1 is not the same as any: a rejection waits for the other approvers", () => {
      const flow = parallel({ quorum: 1 }, ["u_a", "u_b"]);
      const afterReject = runAll([submitCommand(), reject("u_a")], { flow });
      expect(afterReject.state.steps[0]?.status).toBe("active");

      const rejected = runAll([submitCommand(), reject("u_a"), reject("u_b")], { flow });
      expect(rejected.state.status).toBe("rejected");

      const approved = runAll([submitCommand(), reject("u_a"), approve("u_b")], { flow });
      expect(approved.state.steps[0]?.status).toBe("approved");
    });

    it("EC-14 quorum equal to the number of approvers behaves like all", () => {
      const flow = parallel({ quorum: 3 });
      const { state } = runAll([submitCommand(), reject("u_b")], { flow });
      expect(state.status).toBe("rejected");
    });
  });
});
