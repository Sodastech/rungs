import { describe, expect, it } from "vitest";
import { ResolutionError } from "../../src/index.js";
import { approve, registeredFlow, run, submitCommand, thrown } from "../helpers/engine.js";

const flow = (onEmptyStep?: "fail" | "skip") =>
  registeredFlow({
    key: "expense",
    ...(onEmptyStep ? { onEmptyStep } : {}),
    steps: [
      { id: "manager", approvers: { type: "role", role: "manager" } },
      { id: "finance", approvers: { type: "role", role: "finance" } },
    ],
  });

describe("A. Approver resolution", () => {
  it("EC-04 an empty resolution fails the command by default and nothing is created", () => {
    const error = thrown(() =>
      run(null, submitCommand(), { flow: flow(), approvers: { manager: [] } }),
    );
    expect(error).toBeInstanceOf(ResolutionError);
    expect(error).toMatchObject({
      code: "RESOLUTION_FAILED",
      stepId: "manager",
      reason: "no-approvers",
    });
  });

  it("EC-04 an empty resolution of a later step fails the approval that would activate it", () => {
    const approvers = { manager: ["u_mgr"], finance: [] };
    const { state } = run(null, submitCommand(), { flow: flow(), approvers });
    const error = thrown(() => run(state, approve("u_mgr"), { flow: flow(), approvers }));
    expect(error).toMatchObject({ code: "RESOLUTION_FAILED", stepId: "finance" });
  });

  it("EC-04 with onEmptyStep skip the step is skipped with the reason recorded", () => {
    const { state, audit } = run(null, submitCommand(), {
      flow: flow("skip"),
      approvers: { manager: [], finance: ["u_fin"] },
    });
    expect(state.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["manager", "skipped"],
      ["finance", "active"],
    ]);
    expect(state.steps[0]?.skipReason).toEqual({ type: "no-approvers" });
    expect(audit.find((e) => e.type === "step.skipped")?.data).toEqual({
      stepId: "manager",
      stepIndex: 0,
      reason: { type: "no-approvers" },
    });
  });
});
