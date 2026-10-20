import type { DelegationRule } from "./delegation.js";
import type { AuditEvent, DomainEvent } from "./event.js";
import type { ApproverSpec } from "./flow.js";
import type { RegisteredFlow, RequestState } from "./state.js";

/** Approvers collected by the service for one need, before the engine filters them. */
export interface StepResolution {
  readonly userIds: readonly string[];
  /** Users the host reports as inactive (EC-06), including delegates the rules lead to. */
  readonly inactiveUserIds?: readonly string[];
  /**
   * Out-of-office rules of these users and of the delegates their rules lead to. The engine
   * applies only those active at `ctx.now`, in scope and in the tenant (EC-20).
   */
  readonly delegations?: readonly DelegationRule[];
}

export interface EngineContext {
  /** Current time, ISO 8601 UTC (e.g. `"2026-01-05T09:00:00.000Z"`). Injected; never read from a clock. */
  readonly now: string;
  /** The flow version the request is pinned to (or will be pinned to, on submit). */
  readonly flow: RegisteredFlow;
  /** Answers to earlier `needs`, keyed by `ResolutionNeed.key`. */
  readonly resolutions?: Readonly<Record<string, StepResolution>>;
}

/** Approvers the engine needs before it can activate a step. */
export interface ResolutionNeed {
  readonly key: string;
  readonly stepId: string;
  readonly spec: ApproverSpec;
}

export interface NeedsResolution {
  readonly kind: "needs-resolution";
  readonly needs: readonly ResolutionNeed[];
}

export interface DecidedResult {
  readonly kind: "decided";
  readonly state: RequestState;
  readonly audit: AuditEvent[];
  readonly events: DomainEvent[];
}

/**
 * Result of `decide`. On `needs-resolution`, resolve the needs and call `decide` again with the
 * same state and command plus `ctx.resolutions`; nothing has changed yet.
 */
export type Decision = NeedsResolution | DecidedResult;
