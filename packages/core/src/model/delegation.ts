/** An out-of-office rule: tasks for `fromUserId` go to `toUserId` while it is active. */
export interface DelegationRule {
  id: string;
  fromUserId: string;
  toUserId: string;
  /** Active from `startsAt` (inclusive) until `endsAt` (exclusive). ISO 8601 UTC. */
  startsAt: string;
  endsAt: string;
  /** Empty or missing `flowKeys` means every flow. */
  scope?: { flowKeys?: string[] };
  /** When set, the rule applies only to requests of this tenant. */
  tenantId?: string;
  /** Set when the rule was ended before it started; a cancelled rule never applies. */
  cancelledAt?: string;
}

/** Why one hop of a delegation chain was not taken (EC-23, EC-48, EC-49). */
export type DelegationSkipReason =
  | "requester"
  | "inactive"
  | "target-already-approver"
  | "target-already-decided";
