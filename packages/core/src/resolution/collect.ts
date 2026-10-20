import type { ResolutionNeed, StepResolution } from "../model/decision.js";
import { ResolutionError } from "../model/errors.js";
import type { ApproverSpec } from "../model/flow.js";
import type { JsonValue, Subject } from "../model/state.js";

/** The request approvers are collected for. At submit it does not exist yet, so no state. */
export interface ResolveRequest {
  readonly requesterId: string;
  readonly subject: Subject;
  readonly payload: JsonValue;
  readonly flowKey: string;
  readonly tenantId?: string;
}

export interface ResolveContext {
  readonly stepId: string;
  readonly request: ResolveRequest;
  readonly tenantId?: string;
}

export interface ResolverArgs extends ResolveContext {
  readonly params?: unknown;
}

type UserIds = readonly string[] | Promise<readonly string[]>;

/** Host callbacks the service passes in. They may be sync or async. */
export interface ResolutionHooks {
  readonly roles?: (role: string, ctx: ResolveContext) => UserIds;
  readonly resolvers?: Readonly<Record<string, (args: ResolverArgs) => UserIds>>;
  /** Omitted: every user is active. */
  readonly isActiveUser?: (userId: string, ctx: ResolveContext) => boolean | Promise<boolean>;
}

/**
 * The async part of resolution (EC-05): turns a need into raw user ids by calling the host, and
 * asks `isActiveUser` about each distinct user. Any failure becomes a `ResolutionError` with the
 * original error as `cause`; the engine filters the result purely (see `pipeline.ts`).
 */
export async function collectResolution(
  need: ResolutionNeed,
  hooks: ResolutionHooks,
  request: ResolveRequest,
): Promise<StepResolution> {
  const ctx: ResolveContext = {
    stepId: need.stepId,
    request,
    ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
  };
  let userIds: string[];
  try {
    userIds = [...new Set(await collect(need.spec, hooks, ctx))];
  } catch (cause) {
    throw new ResolutionError({ stepId: need.stepId, cause });
  }
  const inactiveUserIds = await inactiveUsers(userIds, hooks, need.stepId, request);
  return inactiveUserIds.length > 0 ? { userIds, inactiveUserIds } : { userIds };
}

/** The users `isActiveUser` reports inactive, e.g. delegates; failures become `ResolutionError`. */
export async function inactiveUsers(
  userIds: readonly string[],
  hooks: ResolutionHooks,
  stepId: string,
  request: ResolveRequest,
): Promise<string[]> {
  const isActive = hooks.isActiveUser;
  if (isActive === undefined || userIds.length === 0) return [];
  const ctx: ResolveContext = {
    stepId,
    request,
    ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
  };
  try {
    const active = await Promise.all(userIds.map((id) => isActive(id, ctx)));
    return userIds.filter((_, i) => active[i] !== true);
  } catch (cause) {
    throw new ResolutionError({ stepId, cause });
  }
}

async function collect(
  spec: ApproverSpec,
  hooks: ResolutionHooks,
  ctx: ResolveContext,
): Promise<string[]> {
  switch (spec.type) {
    case "users":
      return [...spec.ids];
    case "role": {
      if (!hooks.roles) throw new Error(`no roles callback is configured for role "${spec.role}"`);
      return checked(await hooks.roles(spec.role, ctx), `role "${spec.role}"`);
    }
    case "resolver": {
      const resolver = hooks.resolvers?.[spec.name];
      if (!resolver) throw new Error(`no resolver named "${spec.name}" is configured`);
      const args = spec.params === undefined ? ctx : { ...ctx, params: spec.params };
      return checked(await resolver(args), `resolver "${spec.name}"`);
    }
    case "union": {
      const parts: string[] = [];
      for (const part of spec.of) parts.push(...(await collect(part, hooks, ctx)));
      return parts;
    }
  }
}

function checked(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${source} must return an array of user ids, got ${typeof value}`);
  }
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`${source} must return user ids as non-empty strings`);
    }
  }
  return value as string[];
}
