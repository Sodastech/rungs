import type { FlowIssue } from "../model/errors.js";
import { validateCondition } from "./condition.js";
import { durationToMilliseconds, parseDuration } from "./duration.js";
import { isRecord, rejectUnknownKeys } from "./issues.js";

const FLOW_KEYS = [
  "key",
  "steps",
  "onEmptyStep",
  "dedupeApprovers",
  "allowSelfApproval",
  "returnPolicy",
  "onAllSkipped",
  "maxEscalationDepth",
  "maxDelegationDepth",
];
const STEP_KEYS = [
  "id",
  "name",
  "approvers",
  "mode",
  "when",
  "deadline",
  "remindBefore",
  "onTimeout",
  "escalateTo",
];
const FLOW_ENUMS: Record<string, readonly string[]> = {
  onEmptyStep: ["fail", "skip"],
  dedupeApprovers: ["none", "consecutive", "all"],
  returnPolicy: ["restart", "from-returned-step"],
  onAllSkipped: ["approve", "fail"],
};
const TIMEOUT_ACTIONS = ["remind", "escalate", "auto-approve", "auto-reject"];
const SPEC_TYPES = ["users", "role", "resolver", "union"];

/** Validates untrusted flow input. Returns every issue found; an empty list means valid. */
export function validateFlow(input: unknown): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (!isRecord(input)) {
    issues.push({ path: "", message: "flow definition must be an object" });
    return issues;
  }

  if (!isNonEmptyString(input.key))
    issues.push({ path: "key", message: "must be a non-empty string" });

  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    issues.push({ path: "steps", message: "must be an array with at least one step" });
  } else {
    const seen = new Set<string>();
    for (const [i, step] of input.steps.entries()) validateStep(step, `steps[${i}]`, seen, issues);
  }

  for (const [key, allowed] of Object.entries(FLOW_ENUMS)) {
    if (input[key] !== undefined && !allowed.includes(input[key] as string)) {
      issues.push({ path: key, message: `must be one of ${quoted(allowed)}` });
    }
  }
  if (input.allowSelfApproval !== undefined && typeof input.allowSelfApproval !== "boolean") {
    issues.push({ path: "allowSelfApproval", message: "must be a boolean" });
  }
  if (input.maxEscalationDepth !== undefined && !isPositiveInteger(input.maxEscalationDepth)) {
    issues.push({ path: "maxEscalationDepth", message: "must be a positive integer" });
  }
  if (input.maxDelegationDepth !== undefined && !isPositiveInteger(input.maxDelegationDepth)) {
    issues.push({ path: "maxDelegationDepth", message: "must be a positive integer" });
  }
  rejectUnknownKeys(input, FLOW_KEYS, "", issues);
  return issues;
}

function validateStep(step: unknown, path: string, seen: Set<string>, issues: FlowIssue[]): void {
  if (!isRecord(step)) {
    issues.push({ path, message: "step must be an object" });
    return;
  }

  if (!isNonEmptyString(step.id)) {
    issues.push({ path: `${path}.id`, message: "must be a non-empty string" });
  } else if (seen.has(step.id)) {
    issues.push({ path: `${path}.id`, message: `duplicate step id "${step.id}"` });
  } else {
    seen.add(step.id);
  }
  if (step.name !== undefined && typeof step.name !== "string") {
    issues.push({ path: `${path}.name`, message: "must be a string" });
  }

  validateSpec(step.approvers, `${path}.approvers`, issues);
  validateMode(step, path, issues);
  if (step.when !== undefined) validateCondition(step.when, `${path}.when`, issues);
  validateTiming(step, path, issues);
  rejectUnknownKeys(step, STEP_KEYS, path, issues);
}

function validateSpec(spec: unknown, path: string, issues: FlowIssue[]): void {
  if (!isRecord(spec)) {
    issues.push({ path, message: "must be an approver spec object" });
    return;
  }
  switch (spec.type) {
    case "users":
      rejectUnknownKeys(spec, ["type", "ids"], path, issues);
      if (!Array.isArray(spec.ids) || spec.ids.length === 0) {
        issues.push({ path: `${path}.ids`, message: "must be an array with at least one user id" });
        return;
      }
      spec.ids.forEach((id, i) => {
        if (!isNonEmptyString(id)) {
          issues.push({ path: `${path}.ids[${i}]`, message: "must be a non-empty string" });
        }
      });
      return;
    case "role":
      rejectUnknownKeys(spec, ["type", "role"], path, issues);
      if (!isNonEmptyString(spec.role)) {
        issues.push({ path: `${path}.role`, message: "must be a non-empty string" });
      }
      return;
    case "resolver":
      rejectUnknownKeys(spec, ["type", "name", "params"], path, issues);
      if (!isNonEmptyString(spec.name)) {
        issues.push({ path: `${path}.name`, message: "must be a non-empty string" });
      }
      return;
    case "union":
      rejectUnknownKeys(spec, ["type", "of"], path, issues);
      if (!Array.isArray(spec.of) || spec.of.length === 0) {
        issues.push({
          path: `${path}.of`,
          message: "must be an array with at least one approver spec",
        });
        return;
      }
      for (const [i, child] of spec.of.entries()) validateSpec(child, `${path}.of[${i}]`, issues);
      return;
    default:
      issues.push({ path: `${path}.type`, message: `must be one of ${quoted(SPEC_TYPES)}` });
  }
}

function validateMode(step: Record<string, unknown>, path: string, issues: FlowIssue[]): void {
  const mode = step.mode;
  if (mode === undefined || mode === "any" || mode === "all") return;
  if (!isRecord(mode) || !("quorum" in mode)) {
    issues.push({ path: `${path}.mode`, message: 'must be "any", "all" or { quorum: number }' });
    return;
  }
  rejectUnknownKeys(mode, ["quorum"], `${path}.mode`, issues);
  if (!isPositiveInteger(mode.quorum)) {
    issues.push({ path: `${path}.mode.quorum`, message: "must be a positive integer" });
    return;
  }
  const possible = staticApprovers(step.approvers);
  if (possible !== null && mode.quorum > possible.size) {
    issues.push({
      path: `${path}.mode.quorum`,
      message: `quorum ${mode.quorum} can never be reached: the step has only ${possible.size} distinct approvers`,
    });
  }
}

function validateTiming(step: Record<string, unknown>, path: string, issues: FlowIssue[]): void {
  const deadline = step.deadline === undefined ? undefined : parseDuration(step.deadline);
  if (deadline && !deadline.ok) issues.push({ path: `${path}.deadline`, message: deadline.reason });

  if (step.remindBefore !== undefined) {
    const remind = parseDuration(step.remindBefore);
    if (deadline === undefined) {
      issues.push({ path: `${path}.remindBefore`, message: "requires a deadline" });
    } else if (!remind.ok) {
      issues.push({ path: `${path}.remindBefore`, message: remind.reason });
    } else if (
      deadline.ok &&
      durationToMilliseconds(remind.value) >= durationToMilliseconds(deadline.value)
    ) {
      issues.push({ path: `${path}.remindBefore`, message: "must be shorter than the deadline" });
    }
  }

  if (step.onTimeout !== undefined) {
    if (!TIMEOUT_ACTIONS.includes(step.onTimeout as string)) {
      issues.push({
        path: `${path}.onTimeout`,
        message: `must be one of ${quoted(TIMEOUT_ACTIONS)}`,
      });
    } else if (deadline === undefined) {
      issues.push({ path: `${path}.onTimeout`, message: "requires a deadline" });
    }
  }

  if (step.onTimeout === "escalate" && step.escalateTo === undefined) {
    issues.push({
      path: `${path}.escalateTo`,
      message: 'is required when onTimeout is "escalate"',
    });
  } else if (step.escalateTo !== undefined) {
    if (step.onTimeout !== "escalate") {
      issues.push({
        path: `${path}.escalateTo`,
        message: 'is only allowed when onTimeout is "escalate"',
      });
    } else {
      validateSpec(step.escalateTo, `${path}.escalateTo`, issues);
    }
  }
}

/** Distinct user ids when the spec is fully static (users, or unions of users); otherwise null. */
function staticApprovers(spec: unknown): Set<string> | null {
  if (!isRecord(spec)) return null;
  if (spec.type === "users" && Array.isArray(spec.ids)) return new Set(spec.ids as string[]);
  if (spec.type === "union" && Array.isArray(spec.of)) {
    const all = new Set<string>();
    for (const child of spec.of) {
      const ids = staticApprovers(child);
      if (ids === null) return null;
      for (const id of ids) all.add(id);
    }
    return all;
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function quoted(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}
