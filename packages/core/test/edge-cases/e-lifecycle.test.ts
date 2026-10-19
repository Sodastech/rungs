import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/flow/condition.js";
import { ConditionError, RungsError } from "../../src/index.js";

function conditionError(run: () => unknown): ConditionError {
  try {
    run();
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
});
