import type { FlowInput, JsonValue } from "@rungsjs/core";

/** A fictional organization and a list of actions, played against `createRungs` and `memoryStore`. */
export interface Scenario {
  readonly name: string;
  /** What the scenario shows, printed above the timeline. */
  readonly description?: string;
  /** ISO 8601 UTC start time of the fake clock. */
  readonly start: string;
  /** User id → display name. Every id used below should be listed here. */
  readonly users: Readonly<Record<string, string>>;
  /** Requester → direct manager, used by the `directManager` resolver. */
  readonly managers?: Readonly<Record<string, string>>;
  /** Role → user ids, used by `{ type: "role" }` approvers. */
  readonly roles?: Readonly<Record<string, readonly string[]>>;
  /** Users the host reports as inactive (left the company). */
  readonly inactive?: readonly string[];
  /** Out-of-office rules, set before the first action. */
  readonly delegations?: readonly DelegationInput[];
  readonly flow: FlowInput;
  readonly actions: readonly Action[];
  /** The request status expected at the end; the run fails when it differs. */
  readonly expectStatus?: "pending" | "approved" | "rejected" | "returned" | "withdrawn";
}

export interface DelegationInput {
  readonly from: string;
  readonly to: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly flowKeys?: readonly string[];
}

/** When an action happens: an absolute time, or a wait such as "PT2H", "P1D", "P1DT4H". */
interface Timing {
  readonly at?: string;
  readonly wait?: string;
  /** The error code this action is expected to fail with, e.g. "NOT_ASSIGNED". */
  readonly expectError?: string;
}

export type Action = Timing &
  (
    | { readonly do: "preview"; readonly by: string; readonly payload: JsonValue }
    | {
        readonly do: "submit";
        readonly by: string;
        readonly payload: JsonValue;
        readonly subject?: { readonly type: string; readonly id: string };
      }
    | { readonly do: "approve" | "reject"; readonly by: string; readonly comment?: string }
    | {
        readonly do: "delegate";
        readonly by: string;
        readonly to: string;
        readonly comment?: string;
      }
    | {
        readonly do: "return";
        readonly by: string;
        /** Default: the requester. Or the id of an earlier step. */
        readonly to?: string;
        readonly comment?: string;
      }
    | { readonly do: "resubmit"; readonly payload?: JsonValue }
    | { readonly do: "withdraw"; readonly comment?: string }
    | { readonly do: "tick" }
  );

/** Identity helper that gives scenario files type checking and autocompletion. */
export function scenario(definition: Scenario): Scenario {
  return definition;
}
