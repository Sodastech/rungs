import { describe, expect, it } from "vitest";
import { InvalidTransitionError, NotAssignedError } from "../../src/index.js";
import {
  approve,
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
});
