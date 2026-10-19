import { describe, expect, it } from "vitest";
import { approve, reject, runAll, submitCommand, T1, T2, T3 } from "../helpers/engine.js";

describe("sequential approval", () => {
  it("moves through every step in order and approves the request after the last one", () => {
    const afterManager = runAll([submitCommand(), approve("u_mgr", "OK")]);
    expect(afterManager.state.status).toBe("pending");
    expect(afterManager.state.currentStepIndex).toBe(1);
    expect(afterManager.state.version).toBe(2);
    expect(afterManager.state.steps[0]).toMatchObject({
      stepId: "manager",
      status: "approved",
      closedAt: T1,
      tasks: [{ status: "approved", decidedAt: T1, comment: "OK" }],
    });
    expect(afterManager.state.steps[1]).toMatchObject({ stepId: "finance", status: "active" });
    expect(afterManager.audit.map((e) => [e.seq, e.type, e.actorId])).toEqual([
      [4, "task.approved", "u_mgr"],
      [5, "step.completed", "u_mgr"],
      [6, "step.activated", "u_mgr"],
      [7, "task.assigned", "u_mgr"],
    ]);

    const done = runAll([submitCommand(), approve("u_mgr"), approve("u_fin"), approve("u_dir")]);
    expect(done.state).toMatchObject({
      status: "approved",
      currentStepIndex: null,
      closedAt: T3,
      version: 4,
    });
    expect(done.state.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["manager", "approved"],
      ["finance", "approved"],
      ["director", "approved"],
    ]);
    expect(done.audit.map((e) => e.type)).toEqual([
      "task.approved",
      "step.completed",
      "request.approved",
    ]);
    expect(done.audit.at(-1)?.data).toEqual({ reason: "steps-approved" });
  });

  it("rejects the request when a step is rejected and stops there", () => {
    const { state, audit, events } = runAll([
      submitCommand(),
      approve("u_mgr"),
      reject("u_fin", "Over budget"),
    ]);
    expect(state).toMatchObject({ status: "rejected", currentStepIndex: null, closedAt: T2 });
    expect(state.steps).toHaveLength(2);
    expect(state.steps[1]).toMatchObject({
      stepId: "finance",
      status: "rejected",
      tasks: [{ status: "rejected", comment: "Over budget", decidedAt: T2 }],
    });
    expect(audit.map((e) => e.type)).toEqual([
      "task.rejected",
      "step.completed",
      "request.rejected",
    ]);
    expect(audit[1]?.data).toEqual({ stepId: "finance", stepIndex: 1, outcome: "rejected" });
    expect(events.map((e) => e.type)).toEqual([
      "task.decided",
      "step.completed",
      "request.rejected",
    ]);
    expect(events[0]?.data).toMatchObject({ decision: "rejected", comment: "Over budget" });
  });
});
