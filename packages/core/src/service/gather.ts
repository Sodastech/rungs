import type { ResolutionNeed, StepResolution } from "../model/decision.js";
import type { DelegationRule } from "../model/delegation.js";
import type { RegisteredFlow } from "../model/state.js";
import type { StoreTx } from "../model/store.js";
import {
  collectResolution,
  inactiveUsers,
  type ResolutionHooks,
  type ResolveRequest,
} from "../resolution/collect.js";

/**
 * Answers one need: the users the spec resolves to, the out-of-office rules along their chains
 * (at most `maxDelegationDepth` hops), and which of all those users are inactive. The engine
 * then filters everything purely.
 */
export async function gatherResolution(
  need: ResolutionNeed,
  hooks: ResolutionHooks,
  request: ResolveRequest,
  tx: StoreTx,
  flow: RegisteredFlow,
): Promise<StepResolution> {
  const base = await collectResolution(need, hooks, request);
  const rules: DelegationRule[] = [];
  const seen = new Set(base.userIds);
  let frontier = [...base.userIds];
  for (let hop = 0; hop < flow.maxDelegationDepth && frontier.length > 0; hop++) {
    const found = await tx.findDelegations(frontier, request.tenantId);
    const fresh = found.filter((rule) => !rules.some((known) => known.id === rule.id));
    rules.push(...fresh);
    frontier = [...new Set(fresh.map((rule) => rule.toUserId))].filter((id) => !seen.has(id));
    for (const id of frontier) seen.add(id);
  }

  const delegates = [...seen].filter((id) => !base.userIds.includes(id));
  const inactive = [
    ...(base.inactiveUserIds ?? []),
    ...(await inactiveUsers(delegates, hooks, need.stepId, request)),
  ];
  return {
    userIds: base.userIds,
    ...(inactive.length > 0 ? { inactiveUserIds: inactive } : {}),
    ...(rules.length > 0 ? { delegations: rules } : {}),
  };
}
