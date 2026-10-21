# 05 — Edge case catalog

This catalog is the specification. Each case has an ID, a default behavior, the configuration that
changes it, and the tier that implements it. Every case gets a test named after its ID
(e.g. `it("EC-01 requester is an approver in the step", ...)`).

Tier: **Core** = MIT `@rungsjs/core`; **Pro** = `@rungsjs/org`.

## A. Approver resolution

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-01 | Requester is one of the approvers of a step | Requester is removed from that step's approvers; `removed` records `{ userId, reason: "requester" }` on the step and in its audit event | `allowSelfApproval` | Core |
| EC-02 | After EC-01 removal the step has no approvers | Apply `onEmptyStep`. Default `fail`: at submit the submit is refused with `NoApproversError` and nothing is created (EC-43); mid-flow the step is blocked (EC-42). `skip` must be chosen explicitly; it records `step.skipped` with the reason | `onEmptyStep: fail \| skip` (Pro: `escalate-up`) | Core / Pro |
| EC-03 | Same person resolves in consecutive steps | Second occurrence gets a `skipped-duplicate` task that counts as their vote; the first decision carries over (`task.deduplicated`). Only an actual approval carries over, and skipped steps in between do not break the sequence. A carried-over vote never closes a step on its own while other approvers can decide (EC-47) | `dedupeApprovers: consecutive \| all \| none` | Core |
| EC-04 | Resolver returns an empty list (e.g. vacant position) | Same as EC-02 (default `fail`) | `onEmptyStep` | Core |
| EC-05 | Resolver throws | Command fails with `ResolutionError` (`RESOLUTION_FAILED`) carrying the original error as `cause`; the service rolls the transaction back, so nothing is stored and retrying is safe. Also used for a role lookup or `isActiveUser` that throws, and an invalid result. A resolver name that is not configured is refused when the flow is registered | — | Core |
| EC-06 | Resolved approver is inactive (left company) | Treated as absent: removed with `reason: "inactive"`; may trigger EC-02 | `isActiveUser` hook | Core |
| EC-07 | Position is vacant | Walk up the hierarchy to the next filled position | `vacancy: walk-up \| empty` | Pro |
| EC-08 | Position held by an acting/interim person | Acting holder approves; audit records "acting for position X" | — | Pro |
| EC-09 | `managerChain(n)` goes beyond the top of the hierarchy (requester is CEO) | Chain is truncated at the root; if empty → EC-02 | `beyondRoot: truncate \| fail` | Pro |
| EC-10 | Org data contains a reporting cycle | Resolution stops at the first repeat and fails with `ResolutionError` describing the cycle | — | Pro |
| EC-11 | Requester changes unit while the request is in progress | Already-activated steps keep their snapshot; future steps resolve against the org at activation time | `reorgPolicy: resolve-at-activation \| snapshot-at-submit` | Pro |
| EC-42 | A step resolves to too few approvers when it activates mid-flow (data changed since submit) | The command that activated it still succeeds. The step becomes `blocked` (no tasks, request stays `pending`) and `step.blocked` is emitted with the reason and removed users. Nobody can approve or reject it until an admin acts (EC-46). With `onEmptyStep: skip` an empty step is skipped instead | `onEmptyStep` | Core |
| EC-43 | A later step would have no approvers, or could not reach its quorum | Submit resolves every applicable step up front and is refused with `NoApproversError` naming the step; no request is created. The dry run is not stored: each step is resolved again when it activates | — | Core |
| EC-44 | The same user is reached twice in one step (e.g. through a `union`) | Merged into one approver and one task, always | — | Core |
| EC-45 | A quorum step resolves to fewer approvers than its quorum | Never lowered silently. At submit: `NoApproversError` with `reason: quorum-unreachable`. Mid-flow: the step is blocked with that reason, even with `onEmptyStep: skip` | — | Core |
| EC-46 | An admin unblocks a blocked step | `reassign` to chosen users (inactive users, the requester without `allowSelfApproval`, or too few for the mode refuse the command), `retry` (resolve again; if still too few the step stays blocked and only `step.retried` is recorded), or `override` the request (EC-18). All audited with the admin as actor | — | Core |
| EC-47 | Carried-over approvals (EC-03) would be enough to close a step that also has other approvers | Separation of duties: at least one other approver must approve. Mode `any`: the others get tasks and the first fresh decision decides. Mode `all`: the carried-over vote counts, everyone else still decides. Quorum: each carried-over vote counts once, the rest must come from fresh decisions, and the step rejects when no fresh approval is possible any more. Only when every approver is carried over is the step approved at once. Same rule for `reassign` | — | Core |

## B. Decisions

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-12 | Parallel step, mode `any` | The first decision decides the step: an approval approves it, a rejection rejects it (and the request). Other pending tasks become `superseded` | — | Core |
| EC-13 | Parallel step, mode `all`, one approver rejects | Step and request are rejected immediately; other pending tasks become `superseded`. The step is approved only when every approver has approved | — | Core |
| EC-14 | Quorum step where approval can no longer reach the quorum | Step (and request) rejects as soon as approvals plus pending tasks fall below the quorum; it approves as soon as the quorum is reached. Other pending tasks become `superseded`. A veto (one rejection rejects) is not supported yet | — | Core |
| EC-15 | Two approvers act at the same moment | One commit wins; the other gets `ConflictError` (`VERSION_CONFLICT`, with `expectedVersion` and `actualVersion`) and re-reads state (it may now be superseded). Commands are not retried automatically | `expectedVersion` | Core |
| EC-16 | The same command is sent twice (double click, retry) | With the same `idempotencyKey`, the second call returns the first result and records nothing; the record is written in the same transaction as the command | `idempotencyKey` | Core |
| EC-57 | An `idempotencyKey` is reused | Keys are scoped per tenant: the same key in two tenants is two different commands. The same key with a different command (compared as canonical JSON) is refused with `InvalidCommandError` instead of returning an unrelated result | `idempotencyKey` | Core |
| EC-58 | A process has no `onEvent` (e.g. a web process, with a separate worker delivering events) | Events stay pending in the outbox until a process with `onEvent` runs `dispatchPending`; they are never marked delivered unseen. Without any consumer the outbox keeps growing. `events: "discard"` opts out and writes no outbox entries (the audit is kept); combining it with `onEvent` is a `ConfigurationError` | `events: outbox \| discard` | Core |
| EC-17 | A user who is not assigned tries to decide | `NotAssignedError`; nothing recorded except an optional security audit event. Allowed to decide: the task's assignee, and the approver it acts for (`onBehalfOf`, EC-60); not someone in the middle of a delegation chain | — | Core |
| EC-18 | Admin forces a decision | Allowed via `override` only, a `comment` is required, audited with the admin as actor. Closes the request; open tasks and the open (active or blocked) step become `cancelled` | — | Core |
| EC-19 | Decision on a closed request (approved/rejected/withdrawn) | `InvalidTransitionError` | — | Core |

## C. Delegation

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-20 | Approver has an active out-of-office rule when the task is assigned | Task is assigned to the delegate with `onBehalfOf` set; `task.assigned` records the chain. Only rules active at that moment, in scope and in the tenant apply; with several, the most recently started wins. The approver can still decide it directly (EC-60) | rule `scope` | Core |
| EC-21 | Delegation chain A→B→C | Followed up to depth 3; deeper chains stop at the last valid delegate | `maxDelegationDepth` (flow) | Core |
| EC-22 | Delegation cycle A→B→A | Cycle detected; task stays with the original approver; `delegation.cycle_detected` warning event | — | Core |
| EC-23 | Delegate is the requester (or inactive) | Delegate skipped with `delegation.skipped`; the chain continues with that delegate's rule, otherwise the task stays with the original approver. With `allowSelfApproval` the requester can be a delegate | — | Core |
| EC-24 | Delegation rule ends while a delegated task is pending | Task stays with the delegate (no surprise reassignment): rules are evaluated once, when the task is created. The approver can decide it directly anyway (EC-60), or have it handed back (EC-50). An automatic revert (the once planned `onDelegationEnd: revert`) is not supported | — | Core |
| EC-25 | Approver delegates a single task manually | New task for the delegate carrying the same vote (`onBehalfOf`); original task `delegated`; both audited. The delegate's own out-of-office rule applies. Refused for yourself, the requester, an inactive user, or a target covered by EC-48/EC-49. The approver can still decide the delegate's task directly (EC-60) | — | Core |
| EC-48 | A delegation would give one person two votes in a step (the delegate already approves there, directly or through another delegation) | Separation of duties: delegation never merges votes. An out-of-office hop to such a person is skipped with `delegation.skipped` (`target-already-approver`) and the task stays with the last valid holder, usually the original approver. Example: A and C both delegate to D; A's task goes to D, C keeps their own. A manual delegation or admin reassign to someone who already holds a task in the step, or whose own vote is in the step through a delegate (`onBehalfOf`), is refused | — | Core |
| EC-49 | The target of a delegation already approved an earlier step of the same request | Refused for a manual delegation and an admin task reassign, so one person cannot approve two levels. An out-of-office hop to that person is skipped (`target-already-decided`) | — | Core |
| EC-50 | The approver a task acts for (`onBehalfOf`) wants the task back as their own, e.g. returned early from leave | Optional since EC-60, which lets them decide it directly. The delegate (`delegate`) or an admin (`reassign` of the task) may hand it back to that approver even though they already held a task in the step: the vote is theirs, so nothing is merged. The new task has no `onBehalfOf`, out-of-office rules are not followed, and the event carries `returnedToOriginal: true`. The approver must be active and not the requester. Everyone else who held a task in the step stays refused (no ping-pong). This is the manual replacement for the planned `onDelegationEnd: revert` | — | Core |
| EC-60 | The approver a task acts for (`onBehalfOf`) decides it while a delegate holds it | Allowed without taking it back: approve, reject or return. It is one task and one vote, so the first decision, by the owner or the delegate, closes it and the other gets `NotAssignedError`. The audit records `actorId` (who acted), `onBehalfOf` (whose vote) and `heldBy` (the delegate, when the owner acted); the task records `decidedBy`. The task also shows in the owner's inbox, marked `heldBy`. Only the owner, not someone in the middle of a chain; the right ends when the task is reassigned or expires. Whether the owner is still active is not checked (the host blocks users who left). One person one vote, four-eyes and EC-49 are unchanged | — | Core |
| EC-61 | Closed requests must be deleted (retention policy, or a request to erase personal data) | Rungs never deletes on its own; the host calls `purgeRequest` / `purgeRequests` (`@rungsjs/store-postgres`). They delete only closed requests (approved, rejected, withdrawn), with their audit, outbox, inbox and idempotency rows, in one transaction, and return the counts. `purgeRequests` needs an explicit scope, one `tenantId` or `allTenants: true`; without one (or with both) it throws `InvalidCommandError` and deletes nothing. An open request is refused with `InvalidTransitionError` and nothing is deleted. Outside a purge, audit rows can never be updated, deleted or truncated | — | Core |

## D. Time

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-26 | Deadline passes | On next `tick(now)`, apply `onTimeout` (default `remind`: `task.reminder` with `overdue: true`, then EC-55). `auto-approve` / `auto-reject` expire the tasks and count as nobody's vote (auto-approve never over a rejection, EC-59); `escalate` see EC-28. An earlier `remindBefore` reminder is sent once | `onTimeout`, `remindBefore` | Core |
| EC-27 | `tick` runs twice for the same moment, or concurrently | Idempotent: each deadline action is applied once (markers in the state); a tick with nothing due returns `unchanged`. Concurrent writers are separated by the store's version check | — | Core |
| EC-28 | Escalation target is also absent / empty | Escalate again (fresh resolution, `escalationDepth` passed to the resolver) up to `maxEscalationDepth` (default 3); then fail-safe: the tasks stay pending, `request.escalation_failed` alerts, overdue reminders continue. Too few targets fails safe the same way | `maxEscalationDepth` | Core |
| EC-29 | Escalation should follow the org chart ("manager's manager") | Org-relative `escalateTo` | — | Pro |
| EC-30 | Deadlines should count business days only | Synchronous calendar interface (`addDuration`, `subtractDuration`) injected by the host; default counts absolute time. Results must be ISO 8601 UTC | `calendar` | Core (interface) |
| EC-31 | Users in different time zones | All persisted times UTC; durations are absolute unless a calendar is supplied | — | Core |
| EC-52 | A returned request is never resubmitted | Default: waits without a time limit, so nothing is closed silently. With `resubmitDeadline`: `remind` sends `request.resubmit_overdue` once; `auto-withdraw` withdraws it as a system action with `reason: "resubmit-timeout"` | `resubmitDeadline`, `onResubmitTimeout: remind \| auto-withdraw` | Core |
| EC-53 | A blocked step is forgotten | `step.still_blocked` (with `blockedSince`, `reason`, `count`) repeats every `remindBlockedEvery` until an admin acts. A late tick sends one reminder and resumes the schedule. Unblocking stops it | `remindBlockedEvery` (default `P1D`, or `never`) | Core |
| EC-54 | An escalation target already voted (in this step, or approved an earlier step) | Removed with `reason: "already-voted"`, like the requester and inactive users; delegation still applies. Nobody votes twice in a step, and escalation has no dedupe, so it never closes a step by itself. The targets must cover the votes still needed, otherwise EC-28 fail-safe. This is deliberate (separation of duties): one person never replaces several votes. Example: an `all` step with A, B, C where only A approved needs 2 more votes; escalating to one lead ends in `request.escalation_failed` (`required: 2, available: 1`) and B and C keep their tasks. Letting an escalation target decide the whole step is not supported yet | — | Core |
| EC-55 | A task stays overdue under `onTimeout: remind` | After the reminder at the deadline (D22), `task.reminder` with `overdue: true` and an increasing `count` repeats every `remindOverdueEvery`, also after a failed escalation. A late tick sends one reminder, not one per missed interval | `remindOverdueEvery` (default `P1D`, or `never`) | Core |
| EC-59 | `onTimeout: auto-approve` fires in a step where a vote already rejected (a quorum step that can still reach its quorum) | Fail closed: auto-approve is not applied. The step stays active, `step.timed_out` records `action: "remind"` with `reason: "auto-approve-skipped-rejection-present"`, and the pending approvers get overdue reminders (EC-55). Without a rejection auto-approve applies as usual | `onTimeout` | Core |

## E. Lifecycle

| ID | Situation | Default behavior | Config | Tier |
| --- | --- | --- | --- | --- |
| EC-32 | Approver returns the request to the requester | Status `returned`; the task is `returned`, other pending tasks of the step are superseded. Only the requester can then `resubmit` (with an edited payload) or `withdraw`; an admin can override | — | Core |
| EC-33 | Approver returns to a previous step (not to the requester) | That step re-activates with freshly resolved approvers and every later step runs again. The target must be an earlier step that ran; the replaced instances keep their history and get `invalidatedAt`, so their approvals no longer carry over | — | Core |
| EC-34 | After resubmit, which steps run again? | `restart`: all steps from the beginning. `from-returned-step`: from the step that returned it, earlier approvals stand (only with an unchanged payload, EC-51). Resubmit checks conditions and approvers of every step that will run up front (EC-41, EC-43) | `returnPolicy: restart \| from-returned-step` | Core |
| EC-35 | Requester withdraws while pending (or returned) | Status `withdrawn`; all pending tasks and the open step `cancelled`; events emitted. Only the requester can withdraw | — | Core |
| EC-36 | Payload changes after submit outside Rungs | Ignored; conditions use the snapshot. Changing data requires return + resubmit | — | Core |
| EC-37 | Flow definition changes while requests are in flight | In-flight requests keep their pinned `flowVersion`, also across resubmit; a command with another version is refused | — | Core |
| EC-56 | A tenant registers its own version of a flow | Submit uses the tenant's own flow first, then the global one, else `FlowNotFoundError`. A tenant's flow never serves another tenant. Requests are pinned to the exact flow (`flowTenantId` included), so a flow the tenant registers later never changes requests already in flight | — | Core |
| EC-38 | Conditional step (`when`) | Evaluated at step activation against the payload snapshot; false → `step.skipped` with reason | — | Core |
| EC-39 | Every step is skipped (all conditions false or all empty) | Request is approved automatically; audit explains each skip. With `fail`, the submit is refused with `FlowNotApplicableError` and no request is created | `onAllSkipped: approve \| fail` | Core |
| EC-40 | A comparison (`gt`, `gte`, `lt`, `lte`) in a condition meets a missing field or a value of the wrong type | Fail closed: `ConditionError` (`CONDITION_INVALID`) naming the field, expected and received type; no state change. `eq`/`neq`/`in`/`nin` on a missing field evaluate against `undefined`. All branches of `all`/`any` are evaluated so an error is never masked | — | Core |
| EC-41 | A condition would fail with `ConditionError` on a step that activates later | Submit and resubmit evaluate every step condition up front, so the requester's command fails and nothing changes; the approver of an earlier step is never blocked. Conditions are still evaluated at activation (EC-38) | — | Core |
| EC-51 | Resubmit under `from-returned-step` with a changed payload | Restarts from the first step instead, because earlier conditional steps must be evaluated again against the new data. The audit (`request.resubmitted`) records `applied: restart` and `payloadChanged: true`. Payloads are compared as JSON, ignoring key order | `returnPolicy` | Core |
| EC-62 | A list query (`requests`, `blocked`, `inbox`) is made without a tenant, or for another tenant | Lists match the tenant exactly: without `tenantId` only requests without a tenant are returned, and a tenant never sees another tenant's requests, tasks or blocked steps. Who may see a list within a tenant is the host's decision | — | Core |

## Adding a new case

1. Give it the next free ID; never renumber existing cases.
2. Define the default behavior and how to configure it.
3. Decide the tier using `docs/02-free-vs-pro.md`.
4. Write the test first.
