import { FlowDefinitionError } from "../model/errors.js";
import type { FlowDefinition, FlowInput, StepDefinition, StepInput } from "../model/flow.js";
import { validateFlow } from "./validate.js";

/**
 * Validates a flow and applies defaults. Throws `FlowDefinitionError` listing every issue.
 * The result is a deeply frozen copy that shares nothing with the input.
 */
export function defineFlow(input: FlowInput): FlowDefinition {
  const issues = validateFlow(input);
  if (issues.length > 0) throw new FlowDefinitionError(issues);

  return frozenCopy({
    key: input.key,
    onEmptyStep: input.onEmptyStep ?? "fail",
    dedupeApprovers: input.dedupeApprovers ?? "consecutive",
    allowSelfApproval: input.allowSelfApproval ?? false,
    returnPolicy: input.returnPolicy ?? "restart",
    onAllSkipped: input.onAllSkipped ?? "approve",
    maxEscalationDepth: input.maxEscalationDepth ?? 3,
    steps: input.steps.map(normalizeStep),
  });
}

function normalizeStep(step: StepInput): StepDefinition {
  return withoutUndefined({
    id: step.id,
    name: step.name,
    approvers: step.approvers,
    mode: step.mode ?? "any",
    when: step.when,
    deadline: step.deadline,
    remindBefore: step.remindBefore,
    onTimeout: step.onTimeout ?? "remind",
    escalateTo: step.escalateTo,
  });
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Copies arrays and plain objects recursively and freezes the copies. */
function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy)) as T;
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const copy = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozenCopy(v)]));
    return Object.freeze(copy) as T;
  }
  return value;
}
