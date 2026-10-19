# 05 — Edge case catalog

This catalog is the specification. Each case has an ID, a default behavior, the configuration that
changes it, and the tier that implements it. Every case gets a test named after its ID
(e.g. `it("EC-01 requester is an approver in the step", ...)`).

Tier: **Core** = MIT `@rungs/core`; **Pro** = `@rungs/org`.

## A. Approver resolution

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-01 | Requester is one of the approvers of a step | Requester is removed from that step's approvers; reason recorded | `allowSelfApproval` | Core |
| EC-02 | After EC-01 removal the step has no approvers | Apply `onEmptyStep`. Default `fail`: the command fails with `ResolutionError` and nothing changes. `skip` must be chosen explicitly; it records `step.skipped` with the reason | `onEmptyStep: fail \| skip` (Pro: `escalate-up`) | Core / Pro |
| EC-03 | Same person resolves in consecutive steps | Second occurrence auto-approved as `skipped-duplicate`, first decision carries over | `dedupeApprovers` | Core |
| EC-04 | Resolver returns an empty list (e.g. vacant position) | Same as EC-02 (default `fail`) | `onEmptyStep` | Core |
| EC-05 | Resolver throws | Command fails with `ResolutionError`; no state change | — | Core |
| EC-06 | Resolved approver is inactive (left company) | Treated as absent: removed, reason recorded; may trigger EC-02 | `isActiveUser` hook | Core |
| EC-07 | Position is vacant | Walk up the hierarchy to the next filled position | `vacancy: walk-up \| empty` | Pro |
| EC-08 | Position held by an acting/interim person | Acting holder approves; audit records "acting for position X" | — | Pro |
| EC-09 | `managerChain(n)` goes beyond the top of the hierarchy (requester is CEO) | Chain is truncated at the root; if empty → EC-02 | `beyondRoot: truncate \| fail` | Pro |
| EC-10 | Org data contains a reporting cycle | Resolution stops at the first repeat and fails with `ResolutionError` describing the cycle | — | Pro |
| EC-11 | Requester changes unit while the request is in progress | Already-activated steps keep their snapshot; future steps resolve against the org at activation time | `reorgPolicy: resolve-at-activation \| snapshot-at-submit` | Pro |

## B. Decisions

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-12 | Parallel step, mode `any` | The first decision decides the step: an approval approves it, a rejection rejects it (and the request). Other pending tasks become `superseded` | — | Core |
| EC-13 | Parallel step, mode `all`, one approver rejects | Step and request are rejected immediately; other pending tasks become `superseded`. The step is approved only when every approver has approved | — | Core |
| EC-14 | Quorum step where approval can no longer reach the quorum | Step (and request) rejects as soon as approvals plus pending tasks fall below the quorum; it approves as soon as the quorum is reached. Other pending tasks become `superseded`. A veto (one rejection rejects) is not supported yet | — | Core |
| EC-15 | Two approvers act at the same moment | One commit wins; the other gets `ConflictError` and re-reads state (it may now be superseded) | — | Core |
| EC-16 | The same command is sent twice (double click, retry) | With the same `idempotencyKey`, the second call returns the first result | `idempotencyKey` | Core |
| EC-17 | A user who is not assigned tries to decide | `NotAssignedError`; nothing recorded except an optional security audit event | — | Core |
| EC-18 | Admin forces a decision | Allowed via `override` only, reason required, audited with the admin as actor | — | Core |
| EC-19 | Decision on a closed request (approved/rejected/withdrawn) | `InvalidTransitionError` | — | Core |

## C. Delegation

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-20 | Approver has an active out-of-office rule when the task is assigned | Task is assigned to the delegate with `onBehalfOf` set | rule `scope` | Core |
| EC-21 | Delegation chain A→B→C | Followed up to depth 3; deeper chains stop at the last valid delegate | `maxDelegationDepth` | Core |
| EC-22 | Delegation cycle A→B→A | Cycle detected; task stays with the original approver; warning event | — | Core |
| EC-23 | Delegate is the requester | Delegate skipped; task stays with original approver (or next in chain) | — | Core |
| EC-24 | Delegation rule ends while a delegated task is pending | Task stays with the delegate (no surprise reassignment) | `onDelegationEnd: keep \| revert` | Core |
| EC-25 | Approver delegates a single task manually | New task for the delegate; original task `delegated`; both audited | — | Core |

## D. Time

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-26 | Deadline passes | On next `tick(now)`, apply `onTimeout` (default `remind`) | `onTimeout` | Core |
| EC-27 | `tick` runs twice for the same moment, or concurrently | Idempotent: each deadline action is applied once | — | Core |
| EC-28 | Escalation target is also absent / empty | Escalate again up to `maxEscalationDepth` (default 3); then `fail-safe` (keep pending + alert event) | `maxEscalationDepth` | Core |
| EC-29 | Escalation should follow the org chart ("manager's manager") | Org-relative `escalateTo` | — | Pro |
| EC-30 | Deadlines should count business days only | Calendar interface injected by the host; default counts calendar time | `calendar` | Core (interface) |
| EC-31 | Users in different time zones | All persisted times UTC; durations are absolute unless a calendar is supplied | — | Core |

## E. Lifecycle

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-32 | Approver returns the request to the requester | Status `returned`; requester can edit payload and `resubmit` | — | Core |
| EC-33 | Approver returns to a previous step (not to the requester) | That step re-activates with freshly resolved approvers | — | Core |
| EC-34 | After resubmit, which steps run again? | `restart`: all steps from the beginning | `returnPolicy: restart \| from-returned-step` | Core |
| EC-35 | Requester withdraws while pending | Status `withdrawn`; all pending tasks `cancelled`; events emitted | — | Core |
| EC-36 | Payload changes after submit outside Rungs | Ignored; conditions use the snapshot. Changing data requires return + resubmit | — | Core |
| EC-37 | Flow definition changes while requests are in flight | In-flight requests keep their pinned `flowVersion` | — | Core |
| EC-38 | Conditional step (`when`) | Evaluated at step activation against the payload snapshot; false → `step.skipped` with reason | — | Core |
| EC-39 | Every step is skipped (all conditions false or all empty) | Request is approved automatically; audit explains each skip. With `fail`, the submit is refused with `FlowNotApplicableError` and no request is created | `onAllSkipped: approve \| fail` | Core |
| EC-40 | A comparison (`gt`, `gte`, `lt`, `lte`) in a condition meets a missing field or a value of the wrong type | Fail closed: `ConditionError` (`CONDITION_INVALID`) naming the field, expected and received type; no state change. `eq`/`neq`/`in`/`nin` on a missing field evaluate against `undefined`. All branches of `all`/`any` are evaluated so an error is never masked | — | Core |
| EC-41 | A condition would fail with `ConditionError` on a step that activates later | Submit (and resubmit) evaluate every step condition up front, so the requester's command fails and no request is created; the approver of an earlier step is never blocked. Conditions are still evaluated at activation (EC-38) | — | Core |

## Adding a new case

1. Give it the next free ID; never renumber existing cases.
2. Define the default behavior and how to configure it.
3. Decide the tier using `docs/02-free-vs-pro.md`.
4. Write the test first.
