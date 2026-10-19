import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../../src/flow/condition.js";
import type { Condition } from "../../src/index.js";

const payload = {
  amount: 7_500_000,
  currency: "IDR",
  urgent: false,
  approvedAt: null,
  submittedOn: "2026-10-19T08:00:00Z",
  cost: { center: "ENG", lines: [{ amount: 100 }, { amount: 250 }] },
};

const evaluate = (condition: Condition) => evaluateCondition(condition, payload);

describe("evaluateCondition", () => {
  it.each<[Condition, boolean]>([
    [{ field: "amount", op: "gt", value: 5_000_000 }, true],
    [{ field: "amount", op: "gte", value: 7_500_000 }, true],
    [{ field: "amount", op: "lt", value: 7_500_000 }, false],
    [{ field: "amount", op: "lte", value: 7_500_000 }, true],
    [{ field: "currency", op: "eq", value: "IDR" }, true],
    [{ field: "currency", op: "neq", value: "IDR" }, false],
    [{ field: "urgent", op: "eq", value: false }, true],
    [{ field: "approvedAt", op: "eq", value: null }, true],
    [{ field: "currency", op: "in", value: ["IDR", "USD"] }, true],
    [{ field: "currency", op: "nin", value: ["IDR", "USD"] }, false],
  ])("evaluates %j to %s", (condition, expected) => {
    expect(evaluate(condition)).toBe(expected);
  });

  it("compares ISO 8601 strings in chronological order", () => {
    expect(evaluate({ field: "submittedOn", op: "lt", value: "2026-11-01T00:00:00Z" })).toBe(true);
    expect(evaluate({ field: "submittedOn", op: "gte", value: "2026-11-01T00:00:00Z" })).toBe(
      false,
    );
  });

  it("follows dot paths into nested objects and arrays", () => {
    expect(evaluate({ field: "cost.center", op: "eq", value: "ENG" })).toBe(true);
    expect(evaluate({ field: "cost.lines.1.amount", op: "gt", value: 200 })).toBe(true);
  });

  it("uses strict equality, so 1 and '1' are different", () => {
    expect(evaluateCondition({ field: "n", op: "eq", value: 1 }, { n: "1" })).toBe(false);
    expect(evaluateCondition({ field: "n", op: "in", value: [1, 2] }, { n: "1" })).toBe(false);
  });

  it("does not read inherited properties such as constructor or __proto__", () => {
    expect(evaluate({ field: "constructor", op: "eq", value: null })).toBe(false);
    expect(evaluate({ field: "cost.__proto__", op: "neq", value: null })).toBe(true);
    expect(evaluate({ field: "cost.lines.length", op: "eq", value: 2 })).toBe(false);
  });

  it("combines conditions with all, any and not", () => {
    const big = { field: "amount", op: "gt", value: 5_000_000 } as const;
    const usd = { field: "currency", op: "eq", value: "USD" } as const;
    expect(evaluate({ all: [big, usd] })).toBe(false);
    expect(evaluate({ any: [big, usd] })).toBe(true);
    expect(evaluate({ not: usd })).toBe(true);
    expect(evaluate({ all: [big, { not: usd }] })).toBe(true);
  });
});
