import { canonicalJson } from "../engine/draft.js";
import { defineFlow } from "../flow/define-flow.js";
import { FlowDefinitionError, type FlowIssue, FlowNotFoundError } from "../model/errors.js";
import type { ApproverSpec, FlowDefinition, FlowInput } from "../model/flow.js";
import type { RegisteredFlow } from "../model/state.js";
import type { RungsStore, StoreTx } from "../model/store.js";
import type { ResolutionHooks } from "../resolution/collect.js";

export interface FlowRegistration {
  readonly key: string;
  readonly version: number;
  /** Set for a tenant's own flow. */
  readonly tenantId?: string;
  /** False when the content equals the latest version, which is returned instead (D23). */
  readonly created: boolean;
}

export interface FlowRegistry {
  /** Validates the flow, also against the configured resolvers, and stores a new version. */
  register(input: FlowInput, options?: { tenantId?: string }): Promise<FlowRegistration>;
  /** The flow a submit would use: the tenant's own first, then the global one (EC-56). */
  get(key: string, options?: { tenantId?: string; version?: number }): Promise<RegisteredFlow>;
}

export function flowRegistry(store: RungsStore, hooks: ResolutionHooks): FlowRegistry {
  return {
    async register(input, options = {}) {
      const flow = defineFlow(input);
      const issues = hookIssues(flow, hooks);
      if (issues.length > 0) throw new FlowDefinitionError(issues);
      const { tenantId } = options;
      const scope = tenantId === undefined ? {} : { tenantId };

      return store.transaction(async (tx) => {
        const latest = await tx.getFlow({ key: flow.key, ...scope });
        if (latest !== null && canonicalJson(definitionOf(latest)) === canonicalJson(flow)) {
          return { key: flow.key, version: latest.version, ...scope, created: false };
        }
        const version = (latest?.version ?? 0) + 1;
        await tx.saveFlow({ ...flow, version, ...scope });
        return { key: flow.key, version, ...scope, created: true };
      });
    },
    get(key, options = {}) {
      return store.transaction((tx) => findFlow(tx, key, options.tenantId, options.version));
    },
  };
}

/** EC-56: the tenant's own flow, else the global one, else `FlowNotFoundError`. */
export async function findFlow(
  tx: StoreTx,
  key: string,
  tenantId: string | undefined,
  version?: number,
): Promise<RegisteredFlow> {
  const at = version === undefined ? {} : { version };
  const own = tenantId === undefined ? null : await tx.getFlow({ key, tenantId, ...at });
  const flow = own ?? (await tx.getFlow({ key, ...at }));
  if (flow === null) {
    throw new FlowNotFoundError({
      flowKey: key,
      ...at,
      ...(tenantId === undefined ? {} : { tenantId }),
    });
  }
  return flow;
}

/** Loads exactly the flow a request is pinned to (EC-37, EC-56). */
export async function pinnedFlow(
  tx: StoreTx,
  pin: { flowKey: string; flowVersion: number; flowTenantId?: string },
): Promise<RegisteredFlow> {
  const scope = pin.flowTenantId === undefined ? {} : { tenantId: pin.flowTenantId };
  const flow = await tx.getFlow({ key: pin.flowKey, version: pin.flowVersion, ...scope });
  if (flow === null) {
    throw new FlowNotFoundError({ flowKey: pin.flowKey, version: pin.flowVersion, ...scope });
  }
  return flow;
}

function definitionOf(flow: RegisteredFlow): FlowDefinition {
  const { version: _version, tenantId: _tenantId, ...definition } = flow;
  return definition;
}

/** Named resolvers must exist and role specs need the roles callback. Unknown roles are fine. */
function hookIssues(flow: FlowDefinition, hooks: ResolutionHooks): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const walk = (spec: ApproverSpec, path: string) => {
    if (spec.type === "role" && hooks.roles === undefined) {
      issues.push({ path, message: "a role spec needs the roles callback" });
    } else if (spec.type === "resolver" && hooks.resolvers?.[spec.name] === undefined) {
      issues.push({
        path: `${path}.name`,
        message: `no resolver named "${spec.name}" is configured`,
      });
    } else if (spec.type === "union") {
      spec.of.forEach((part, i) => {
        walk(part, `${path}.of[${i}]`);
      });
    }
  };
  flow.steps.forEach((step, i) => {
    walk(step.approvers, `steps[${i}].approvers`);
    if (step.escalateTo) walk(step.escalateTo, `steps[${i}].escalateTo`);
  });
  return issues;
}
