import { ConditionError, type FlowIssue, type ReceivedType } from "../model/errors.js";
import type { Condition, ConditionOperator, Primitive } from "../model/flow.js";
import { isRecord, rejectUnknownKeys } from "./issues.js";

const MISSING = Symbol("missing");

const EQUALITY = new Set<ConditionOperator>(["eq", "neq"]);
const COMPARISON = new Set<ConditionOperator>(["gt", "gte", "lt", "lte"]);
const MEMBERSHIP = new Set<ConditionOperator>(["in", "nin"]);
const OPERATORS = [...EQUALITY, ...COMPARISON, ...MEMBERSHIP];

/**
 * Evaluates a condition against a payload snapshot.
 *
 * Fail closed: a comparison (`gt`/`gte`/`lt`/`lte`) on a missing field or a field whose type does
 * not match the value throws `ConditionError` (EC-40). Every branch of `all`/`any` is evaluated,
 * so an invalid comparison is never hidden by short-circuiting.
 */
export function evaluateCondition(condition: Condition, payload: unknown): boolean {
  if ("all" in condition)
    return condition.all.map((c) => evaluateCondition(c, payload)).every(Boolean);
  if ("any" in condition)
    return condition.any.map((c) => evaluateCondition(c, payload)).some(Boolean);
  if ("not" in condition) return !evaluateCondition(condition.not, payload);

  const found = readPath(payload, condition.field);
  const actual = found === MISSING ? undefined : found;

  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "in":
      return condition.value.some((v) => v === actual);
    case "nin":
      return !condition.value.some((v) => v === actual);
    default: {
      const { op, value, field } = condition;
      const expected = typeof value === "number" ? "number" : "string";
      const received = describe(found);
      if (received !== expected) throw new ConditionError({ field, op, expected, received });
      const left = found as number | string;
      if (op === "gt") return left > value;
      if (op === "gte") return left >= value;
      if (op === "lt") return left < value;
      return left <= value;
    }
  }
}

/** Reads a dot path using own properties only; array elements are addressed by index. */
function readPath(payload: unknown, field: string): unknown {
  let current: unknown = payload;
  for (const segment of field.split(".")) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return MISSING;
      const index = Number(segment);
      if (index >= current.length) return MISSING;
      current = current[index];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return MISSING;
    }
  }
  return current === undefined ? MISSING : current;
}

function describe(value: unknown): ReceivedType {
  if (value === MISSING) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isNaN(value) ? "NaN" : "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "object";
  return "other";
}

/** Structural validation used by `defineFlow`. Appends issues; never throws. */
export function validateCondition(input: unknown, path: string, issues: FlowIssue[]): void {
  if (!isRecord(input)) {
    issues.push({ path, message: "must be a condition object" });
    return;
  }
  const groups = ["all", "any", "not"].filter((key) => key in input);
  if (groups.length > 1 || (groups.length === 1 && "field" in input)) {
    issues.push({ path, message: 'must have exactly one of "field", "all", "any" or "not"' });
    return;
  }

  const group = groups[0];
  if (group === "not") {
    rejectUnknownKeys(input, ["not"], path, issues);
    validateCondition(input.not, `${path}.not`, issues);
    return;
  }
  if (group === "all" || group === "any") {
    rejectUnknownKeys(input, [group], path, issues);
    const list = input[group];
    if (!Array.isArray(list) || list.length === 0) {
      issues.push({
        path: `${path}.${group}`,
        message: "must be an array with at least one condition",
      });
      return;
    }
    for (const [i, c] of list.entries()) validateCondition(c, `${path}.${group}[${i}]`, issues);
    return;
  }

  rejectUnknownKeys(input, ["field", "op", "value"], path, issues);
  const { field, op, value } = input;
  if (typeof field !== "string" || field.split(".").some((segment) => segment === "")) {
    issues.push({
      path: `${path}.field`,
      message: 'must be a non-empty dot path, e.g. "cost.amount"',
    });
  }
  if (typeof op !== "string" || !OPERATORS.includes(op as ConditionOperator)) {
    issues.push({ path: `${path}.op`, message: `must be one of ${OPERATORS.join(", ")}` });
    return;
  }
  if (COMPARISON.has(op as ConditionOperator)) {
    if (!((typeof value === "number" && Number.isFinite(value)) || typeof value === "string")) {
      issues.push({
        path: `${path}.value`,
        message: `must be a finite number or a string for "${op}"`,
      });
    }
  } else if (EQUALITY.has(op as ConditionOperator)) {
    if (!isPrimitive(value)) {
      issues.push({
        path: `${path}.value`,
        message: `must be a primitive (string, number, boolean or null) for "${op}"`,
      });
    }
  } else if (!Array.isArray(value)) {
    issues.push({ path: `${path}.value`, message: `must be an array of primitives for "${op}"` });
  } else {
    value.forEach((v, i) => {
      if (!isPrimitive(v)) {
        issues.push({
          path: `${path}.value[${i}]`,
          message: "must be a primitive (string, number, boolean or null)",
        });
      }
    });
  }
}

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
