import { evaluateCondition } from "../flow/condition.js";
import type { EngineContext, ResolutionNeed } from "../model/decision.js";
import type { StepMode } from "../model/flow.js";
import type {
  ApproverShortfall,
  JsonValue,
  RemovedApprover,
  SkipReason,
  Subject,
} from "../model/state.js";
import { followDelegations } from "../resolution/delegation.js";
import { eligibleApprovers, shortfall } from "../resolution/pipeline.js";

export interface PreviewInput {
  readonly requesterId: string;
  readonly payload: JsonValue;
  readonly tenantId?: string;
  /** Required, as on submit: resolvers may look up data by subject. */
  readonly subject: Subject;
}

export interface PreviewStep {
  readonly stepId: string;
  readonly name?: string;
  readonly mode: StepMode;
  /** `cannot-run`: too few approvers, so a submit would be refused (EC-43, EC-45). */
  readonly status: "will-run" | "skipped" | "cannot-run";
  readonly skipReason?: SkipReason;
  readonly shortfall?: ApproverShortfall;
  /** Who would get a task, after removals and delegation. */
  readonly approvers: readonly string[];
  readonly removed: readonly RemovedApprover[];
  /** Out-of-office rules that would apply: the approver and who would act for them. */
  readonly delegations: readonly { readonly userId: string; readonly toUserId: string }[];
}

export interface PreviewResult {
  readonly flowKey: string;
  readonly flowVersion: number;
  readonly flowTenantId?: string;
  readonly steps: readonly PreviewStep[];
  /** False when a submit would be refused now (a step cannot run, or EC-39 with `fail`). */
  readonly submittable: boolean;
}

export type PreviewDecision =
  | { readonly kind: "needs-resolution"; readonly needs: readonly ResolutionNeed[] }
  | { readonly kind: "preview"; readonly result: PreviewResult };

/**
 * Who would approve each step if the request were submitted now, without storing anything. It
 * reflects the data at this moment: approvers are resolved again when each step activates. Dedupe
 * is not applied because it depends on who actually approves earlier steps.
 */
export function previewRequest(input: PreviewInput, ctx: EngineContext): PreviewDecision {
  const { flow, resolutions } = ctx;
  const runs = flow.steps.map(
    (step) => step.when === undefined || evaluateCondition(step.when, input.payload),
  );
  const needs = flow.steps
    .filter((step, i) => runs[i] && resolutions?.[step.id] === undefined)
    .map((step): ResolutionNeed => ({ key: step.id, stepId: step.id, spec: step.approvers }));
  if (needs.length > 0) return { kind: "needs-resolution", needs };

  const steps = flow.steps.map((step, i): PreviewStep => {
    const base = {
      stepId: step.id,
      ...(step.name === undefined ? {} : { name: step.name }),
      mode: step.mode,
    };
    if (!runs[i] && step.when !== undefined) {
      return {
        ...base,
        status: "skipped",
        skipReason: { type: "condition-false", condition: step.when },
        approvers: [],
        removed: [],
        delegations: [],
      };
    }
    const resolution = resolutions?.[step.id] ?? { userIds: [] };
    const { approvers, removed } = eligibleApprovers(
      resolution,
      input.requesterId,
      flow.allowSelfApproval,
    );
    const missing = shortfall(step.mode, approvers.length);
    if (missing !== null) {
      const skip = missing.type === "no-approvers" && flow.onEmptyStep === "skip";
      return {
        ...base,
        status: skip ? "skipped" : "cannot-run",
        ...(skip ? { skipReason: { type: "no-approvers" } } : { shortfall: missing }),
        approvers: [],
        removed,
        delegations: [],
      };
    }

    const holders = new Set(approvers);
    const assignees: string[] = [];
    const delegations: { userId: string; toUserId: string }[] = [];
    for (const userId of approvers) {
      const delegated = followDelegations(userId, {
        now: ctx.now,
        flowKey: flow.key,
        ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
        requesterId: input.requesterId,
        allowSelfApproval: flow.allowSelfApproval,
        maxDepth: flow.maxDelegationDepth,
        rules: resolution.delegations ?? [],
        inactive: new Set(resolution.inactiveUserIds ?? []),
        holders,
        decided: new Map(),
      });
      holders.add(delegated.assigneeId);
      assignees.push(delegated.assigneeId);
      if (delegated.assigneeId !== userId) {
        delegations.push({ userId, toUserId: delegated.assigneeId });
      }
    }
    return { ...base, status: "will-run", approvers: assignees, removed, delegations };
  });

  const allSkipped = steps.every((s) => s.status === "skipped");
  const submittable =
    steps.every((s) => s.status !== "cannot-run") && !(allSkipped && flow.onAllSkipped === "fail");
  return {
    kind: "preview",
    result: {
      flowKey: flow.key,
      flowVersion: flow.version,
      ...(flow.tenantId === undefined ? {} : { flowTenantId: flow.tenantId }),
      steps,
      submittable,
    },
  };
}
