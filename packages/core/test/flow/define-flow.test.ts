import { describe, expect, it } from "vitest";
import type { FlowIssue } from "../../src/index.js";
import { defineFlow, FlowDefinitionError, RungsError } from "../../src/index.js";
import { flowInput, step } from "../helpers/fixtures.js";

function issues(input: unknown): FlowIssue[] {
  try {
    defineFlow(input as never);
  } catch (error) {
    if (error instanceof FlowDefinitionError) return [...error.issues];
    throw error;
  }
  throw new Error("expected a FlowDefinitionError");
}

function expectIssue(input: unknown, path: string, message: RegExp) {
  expect(issues(input)).toContainEqual({ path, message: expect.stringMatching(message) });
}

describe("defineFlow", () => {
  it("applies fail-closed defaults to the flow and its steps", () => {
    const flow = defineFlow(flowInput());
    expect(flow).toEqual({
      key: "expense",
      onEmptyStep: "fail",
      dedupeApprovers: "consecutive",
      allowSelfApproval: false,
      returnPolicy: "restart",
      onAllSkipped: "approve",
      maxEscalationDepth: 3,
      steps: [
        {
          id: "manager",
          approvers: { type: "users", ids: ["u_manager"] },
          mode: "any",
          onTimeout: "remind",
        },
      ],
    });
  });

  it("keeps explicit settings", () => {
    const flow = defineFlow(
      flowInput({
        onEmptyStep: "skip",
        dedupeApprovers: "none",
        allowSelfApproval: true,
        returnPolicy: "from-returned-step",
        onAllSkipped: "fail",
        maxEscalationDepth: 1,
        steps: [
          step({
            name: "Finance",
            mode: { quorum: 1 },
            when: { field: "amount", op: "gt", value: 5_000_000 },
            deadline: "P2D",
            remindBefore: "PT4H",
            onTimeout: "escalate",
            escalateTo: { type: "role", role: "finance-lead" },
          }),
        ],
      }),
    );
    expect(flow.onEmptyStep).toBe("skip");
    expect(flow.maxEscalationDepth).toBe(1);
    expect(flow.steps[0]).toMatchObject({
      name: "Finance",
      mode: { quorum: 1 },
      deadline: "P2D",
      remindBefore: "PT4H",
      onTimeout: "escalate",
      escalateTo: { type: "role", role: "finance-lead" },
    });
  });

  it("returns a deeply frozen copy that does not share arrays with the input", () => {
    const input = flowInput();
    const flow = defineFlow(input);
    expect(Object.isFrozen(flow)).toBe(true);
    expect(Object.isFrozen(flow.steps)).toBe(true);
    expect(Object.isFrozen(flow.steps[0]?.approvers)).toBe(true);
    (input.steps as unknown as unknown[]).push(step({ id: "extra" }));
    expect(flow.steps).toHaveLength(1);
  });

  it("throws FlowDefinitionError listing every issue with its path", () => {
    let caught: unknown;
    try {
      defineFlow({ key: "", steps: [step({ id: "a" }), step({ id: "a", deadline: "P1M" })] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlowDefinitionError);
    expect(caught).toBeInstanceOf(RungsError);
    const error = caught as FlowDefinitionError;
    expect(error.code).toBe("FLOW_INVALID");
    expect(error.issues.map((issue) => issue.path)).toEqual([
      "key",
      "steps[1].id",
      "steps[1].deadline",
    ]);
    expect(error.message).toContain("3 issues");
    expect(error.message).toContain("steps[1].deadline");
  });

  describe("flow-level validation", () => {
    it("requires an input object", () => {
      expectIssue(null, "", /must be an object/);
    });

    it("requires at least one step", () => {
      expectIssue(flowInput({ steps: [] }), "steps", /at least one step/);
    });

    it("rejects unknown keys so typos do not silently disable settings", () => {
      expectIssue({ ...flowInput(), onEmptySteps: "skip" }, "onEmptySteps", /unknown/);
      expectIssue(
        flowInput({ steps: [{ ...step(), deadine: "P1D" } as never] }),
        "steps[0].deadine",
        /unknown/,
      );
    });

    it.each([
      ["onEmptyStep", "escalate-up"],
      ["dedupeApprovers", "always"],
      ["returnPolicy", "resume"],
      ["onAllSkipped", "skip"],
      ["allowSelfApproval", "no"],
    ])("rejects invalid %s", (key, value) => {
      expectIssue({ ...flowInput(), [key]: value }, key, /must be/);
    });

    it.each([0, -1, 1.5])("rejects maxEscalationDepth %s", (value) => {
      expectIssue(
        flowInput({ maxEscalationDepth: value }),
        "maxEscalationDepth",
        /positive integer/,
      );
    });
  });

  describe("step validation", () => {
    const at = (s: unknown) => flowInput({ steps: [s as never] });

    it("requires unique, non-empty step ids", () => {
      expectIssue(
        flowInput({ steps: [step({ id: "x" }), step({ id: "x" })] }),
        "steps[1].id",
        /duplicate/,
      );
      expectIssue(at(step({ id: "" })), "steps[0].id", /non-empty string/);
    });

    it("validates approver specs recursively", () => {
      expectIssue(
        at(step({ approvers: { type: "users", ids: [] } })),
        "steps[0].approvers.ids",
        /at least one/,
      );
      expectIssue(
        at(step({ approvers: { type: "users", ids: [""] } })),
        "steps[0].approvers.ids[0]",
        /non-empty/,
      );
      expectIssue(
        at(step({ approvers: { type: "role", role: "" } })),
        "steps[0].approvers.role",
        /non-empty/,
      );
      expectIssue(
        at(step({ approvers: { type: "resolver", name: "" } })),
        "steps[0].approvers.name",
        /non-empty/,
      );
      expectIssue(
        at(step({ approvers: { type: "union", of: [] } })),
        "steps[0].approvers.of",
        /at least one/,
      );
      expectIssue(
        at(step({ approvers: { type: "union", of: [{ type: "role", role: "" }] } })),
        "steps[0].approvers.of[0].role",
        /non-empty/,
      );
      expectIssue(
        at(step({ approvers: { type: "group" } as never })),
        "steps[0].approvers.type",
        /must be/,
      );
    });

    it("validates the mode and a statically impossible quorum", () => {
      expectIssue(at(step({ mode: "some" as never })), "steps[0].mode", /must be/);
      expectIssue(at(step({ mode: { quorum: 0 } })), "steps[0].mode.quorum", /positive integer/);
      expectIssue(
        at(step({ approvers: { type: "users", ids: ["a", "b", "a"] }, mode: { quorum: 3 } })),
        "steps[0].mode.quorum",
        /2 distinct approvers/,
      );
      expect(() =>
        defineFlow(at(step({ approvers: { type: "role", role: "finance" }, mode: { quorum: 5 } }))),
      ).not.toThrow();
    });

    it("validates deadlines and reminders", () => {
      expectIssue(at(step({ deadline: "P1M" })), "steps[0].deadline", /years and months/);
      expectIssue(at(step({ deadline: "PT0S" })), "steps[0].deadline", /greater than zero/);
      expectIssue(
        at(step({ remindBefore: "PT1H" })),
        "steps[0].remindBefore",
        /requires a deadline/,
      );
      expectIssue(
        at(step({ deadline: "PT8H", remindBefore: "PT8H" })),
        "steps[0].remindBefore",
        /shorter than/,
      );
    });

    it("validates timeout settings", () => {
      expectIssue(at(step({ onTimeout: "escalate" })), "steps[0].onTimeout", /requires a deadline/);
      expectIssue(
        at(step({ deadline: "P1D", onTimeout: "escalate" })),
        "steps[0].escalateTo",
        /required/,
      );
      expectIssue(
        at(step({ deadline: "P1D", escalateTo: { type: "role", role: "hr" } })),
        "steps[0].escalateTo",
        /only allowed when onTimeout is "escalate"/,
      );
      expectIssue(
        at(step({ deadline: "P1D", onTimeout: "ignore" as never })),
        "steps[0].onTimeout",
        /must be/,
      );
    });

    it("validates conditions", () => {
      const when = (condition: unknown) => at(step({ when: condition as never }));
      expectIssue(when({ field: "", op: "eq", value: 1 }), "steps[0].when.field", /dot path/);
      expectIssue(when({ field: "a..b", op: "eq", value: 1 }), "steps[0].when.field", /dot path/);
      expectIssue(when({ field: "a", op: "like", value: 1 }), "steps[0].when.op", /must be/);
      expectIssue(
        when({ field: "a", op: "gt", value: true }),
        "steps[0].when.value",
        /finite number or a string/,
      );
      expectIssue(
        when({ field: "a", op: "gt", value: Number.NaN }),
        "steps[0].when.value",
        /finite number/,
      );
      expectIssue(
        when({ field: "a", op: "eq", value: { x: 1 } }),
        "steps[0].when.value",
        /primitive/,
      );
      expectIssue(when({ field: "a", op: "in", value: "x" }), "steps[0].when.value", /array/);
      expectIssue(
        when({ field: "a", op: "nin", value: [{}] }),
        "steps[0].when.value[0]",
        /primitive/,
      );
      expectIssue(when({ all: [] }), "steps[0].when.all", /at least one/);
      expectIssue(
        when({ any: [{ field: "a", op: "gt" }] }),
        "steps[0].when.any[0].value",
        /finite number/,
      );
      expectIssue(
        when({ not: { field: "a", op: "zz", value: 1 } }),
        "steps[0].when.not.op",
        /must be/,
      );
      expectIssue(when({ all: [], any: [] }), "steps[0].when", /exactly one of/);
      expectIssue(
        when({ field: "a", op: "eq", value: 1, extra: 1 }),
        "steps[0].when.extra",
        /unknown/,
      );
    });
  });
});
