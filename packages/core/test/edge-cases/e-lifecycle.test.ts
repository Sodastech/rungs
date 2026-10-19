import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/flow/condition.js";
import { ConditionError, FlowNotApplicableError, RungsError } from "../../src/index.js";
import {
  approve,
  registeredFlow,
  run,
  runAll,
  submitCommand,
  T0,
  T1,
  thrown,
} from "../helpers/engine.js";

const conditional = (onAllSkipped?: "approve" | "fail") =>
  registeredFlow({
    key: "purchase",
    ...(onAllSkipped ? { onAllSkipped } : {}),
    steps: [
      {
        id: "manager",
        approvers: { type: "users", ids: ["u_mgr"] },
        when: { field: "amount", op: "gt", value: 100 },
      },
      {
        id: "legal",
        approvers: { type: "users", ids: ["u_legal"] },
        when: { field: "contract", op: "eq", value: true },
      },
    ],
  });

function conditionError(fn: () => unknown): ConditionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConditionError) return error;
    throw error;
  }
  throw new Error("expected a ConditionError");
}

describe("E. Lifecycle", () => {
  it("EC-40 comparison on a missing field fails with ConditionError naming the field", () => {
    const error = conditionError(() =>
      evaluateCondition({ field: "amount", op: "gt", value: 5_000_000 }, { total: 9_000_000 }),
    );
    expect(error).toBeInstanceOf(RungsError);
    expect(error.code).toBe("CONDITION_INVALID");
    expect(error.field).toBe("amount");
    expect(error.op).toBe("gt");
    expect(error.expected).toBe("number");
    expect(error.received).toBe("missing");
    expect(error.message).toContain('"amount"');
    expect(error.message).toContain("number");
    expect(error.message).toContain("missing");
  });

  it.each([
    ["string", "7500000"],
    ["boolean", true],
    ["null", null],
    ["object", { value: 1 }],
    ["array", [1]],
  ])(
    "EC-40 comparison on a field of type %s against a number fails with ConditionError",
    (received, value) => {
      const error = conditionError(() =>
        evaluateCondition({ field: "amount", op: "lte", value: 5_000_000 }, { amount: value }),
      );
      expect(error.expected).toBe("number");
      expect(error.received).toBe(received);
    },
  );

  it("EC-40 comparison of a number field against a string value fails with ConditionError", () => {
    const error = conditionError(() =>
      evaluateCondition({ field: "date", op: "lt", value: "2026-01-01" }, { date: 20260101 }),
    );
    expect(error.expected).toBe("string");
    expect(error.received).toBe("number");
  });

  it("EC-40 comparison on NaN fails with ConditionError", () => {
    const error = conditionError(() =>
      evaluateCondition({ field: "amount", op: "gt", value: 0 }, { amount: Number.NaN }),
    );
    expect(error.received).toBe("NaN");
  });

  it("EC-40 eq, neq, in and nin on a missing field evaluate against undefined", () => {
    const payload = {};
    expect(evaluateCondition({ field: "category", op: "eq", value: "travel" }, payload)).toBe(
      false,
    );
    expect(evaluateCondition({ field: "category", op: "neq", value: "travel" }, payload)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "category", op: "in", value: ["travel"] }, payload)).toBe(
      false,
    );
    expect(evaluateCondition({ field: "category", op: "nin", value: ["travel"] }, payload)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "category", op: "eq", value: null }, payload)).toBe(false);
  });

  it("EC-40 an invalid comparison inside all/any is never masked by short-circuiting", () => {
    const missing = { field: "amount", op: "gt", value: 0 } as const;
    const isFalse = { field: "currency", op: "eq", value: "USD" } as const;
    const isTrue = { field: "currency", op: "eq", value: "IDR" } as const;
    const payload = { currency: "IDR" };
    expect(() => evaluateCondition({ all: [isFalse, missing] }, payload)).toThrow(ConditionError);
    expect(() => evaluateCondition({ any: [isTrue, missing] }, payload)).toThrow(ConditionError);
    expect(() => evaluateCondition({ not: missing }, payload)).toThrow(ConditionError);
  });

  it("EC-36 conditions use the payload snapshot taken at submit, not later changes", () => {
    const payload = { amount: 5000 };
    const submitted = run(null, submitCommand({ payload }));
    payload.amount = 10;
    const { state } = run(submitted.state, approve("u_mgr"));
    expect(state.payload).toEqual({ amount: 5000 });
    expect(state.steps[1]).toMatchObject({ stepId: "finance", status: "active" });
  });

  it("EC-38 a step whose condition is false is skipped at activation with the reason recorded", () => {
    const { state, audit, events } = runAll([
      submitCommand({ payload: { amount: 500 } }),
      approve("u_mgr"),
    ]);
    expect(state.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["manager", "approved"],
      ["finance", "skipped"],
      ["director", "active"],
    ]);
    expect(state.steps[1]).toEqual({
      stepId: "finance",
      index: 1,
      status: "skipped",
      skippedAt: T1,
      skipReason: {
        type: "condition-false",
        condition: { field: "amount", op: "gt", value: 1000 },
      },
      approvers: [],
      tasks: [],
    });
    const skipped = audit.find((e) => e.type === "step.skipped");
    expect(skipped?.data).toEqual({
      stepId: "finance",
      stepIndex: 1,
      reason: { type: "condition-false", condition: { field: "amount", op: "gt", value: 1000 } },
    });
    expect(events.map((e) => e.type)).toContain("step.skipped");
  });

  it("EC-38 a step whose condition is true runs normally", () => {
    const { state } = runAll([submitCommand({ payload: { amount: 5000 } }), approve("u_mgr")]);
    expect(state.steps[1]).toMatchObject({ stepId: "finance", status: "active" });
  });

  it("EC-39 when every step is skipped the request is approved and the audit explains each skip", () => {
    const { state, audit } = run(
      null,
      submitCommand({ payload: { amount: 50, contract: false } }),
      {
        flow: conditional(),
      },
    );
    expect(state).toMatchObject({ status: "approved", currentStepIndex: null, closedAt: T0 });
    expect(audit.map((e) => e.type)).toEqual([
      "request.submitted",
      "step.skipped",
      "step.skipped",
      "request.approved",
    ]);
    expect(audit[1]?.data).toMatchObject({
      stepId: "manager",
      reason: { type: "condition-false", condition: { field: "amount", op: "gt", value: 100 } },
    });
    expect(audit[2]?.data).toMatchObject({
      stepId: "legal",
      reason: { type: "condition-false", condition: { field: "contract", op: "eq", value: true } },
    });
    expect(audit[3]?.data).toEqual({
      reason: "all-steps-skipped",
      skippedStepIds: ["manager", "legal"],
    });
  });

  it("EC-39 with onAllSkipped fail the submit is refused and no request is created", () => {
    const error = thrown(() =>
      run(null, submitCommand({ payload: { amount: 50, contract: false } }), {
        flow: conditional("fail"),
      }),
    );
    expect(error).toBeInstanceOf(FlowNotApplicableError);
    expect(error).toMatchObject({
      code: "FLOW_NOT_APPLICABLE",
      flowKey: "purchase",
      skippedStepIds: ["manager", "legal"],
    });
    expect((error as Error).message).toMatch(/every step was skipped/);
  });

  it("EC-39 a request where only some steps are skipped is approved normally", () => {
    const { state, audit } = runAll(
      [submitCommand({ payload: { amount: 500, contract: false } }), approve("u_mgr")],
      { flow: conditional() },
    );
    expect(state.status).toBe("approved");
    expect(audit.at(-1)?.data).toEqual({ reason: "steps-approved" });
  });

  it("EC-41 submit evaluates every step condition up front and fails with ConditionError", () => {
    // "finance" compares amount, but the payload has none. Without the up-front check the error
    // would surface only when the manager approves, blocking the approver instead of the requester.
    const error = thrown(() => run(null, submitCommand({ payload: { total: 5000 } })));
    expect(error).toBeInstanceOf(ConditionError);
    expect(error).toMatchObject({ field: "amount", received: "missing" });
  });

  it("EC-41 the up-front check also covers steps after a step that would be skipped", () => {
    const flow = registeredFlow({
      key: "check",
      steps: [
        {
          id: "a",
          approvers: { type: "users", ids: ["u_a"] },
          when: { field: "kind", op: "eq", value: "big" },
        },
        {
          id: "b",
          approvers: { type: "users", ids: ["u_b"] },
          when: { field: "amount", op: "gte", value: 1 },
        },
      ],
    });
    const error = thrown(() =>
      run(null, submitCommand({ payload: { kind: "small", amount: "12" } }), { flow }),
    );
    expect(error).toMatchObject({
      code: "CONDITION_INVALID",
      expected: "number",
      received: "string",
    });
  });
});
