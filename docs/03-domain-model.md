# 03 — Domain model

Plain data, no classes. All types live in `@rungs/core`. Field names are indicative; final names are
settled during Phase 1 and then recorded here.

## Overview

```
FlowDefinition (key, version) ──1:N── StepDefinition
        │ pinned by
        ▼
Request ──1:N── StepInstance ──1:N── Task
   │
   └──1:N── AuditEvent (append-only)

DelegationRule (independent, per user)
```

## FlowDefinition

Created with `defineFlow(input)`, which validates the input, applies defaults and returns a deeply
frozen copy. Immutable once registered; a change creates a new `version` (assigned by `flows.register`).
Defaults fail closed: nothing silently bypasses an approval step.

| Field | Type | Notes |
| --- | --- | --- |
| `key` | string | Stable identifier, e.g. `"expense"` |
| `version` | number | Assigned at registration; incremented on every change |
| `steps` | StepDefinition[] | Ordered; at least one |
| `onEmptyStep` | `"fail" \| "skip"` | When a step resolves to no approvers. Default `"fail"` (Pro adds `"escalate-up"`) |
| `dedupeApprovers` | `"none" \| "consecutive" \| "all"` | Collapse repeated approvers. Default `"consecutive"` |
| `allowSelfApproval` | boolean | Default `false` |
| `returnPolicy` | `"restart" \| "from-returned-step"` | What runs again after resubmit. Default `"restart"` |
| `onAllSkipped` | `"approve" \| "fail"` | When every step is skipped (EC-39). Default `"approve"` |
| `maxEscalationDepth` | number | Positive integer. Default `3` (EC-28) |
| `maxDelegationDepth` | number | Positive integer. Default `3`. Most out-of-office hops followed from one approver (EC-21). A flow setting so each flow can be stricter |
| `resubmitDeadline` | Duration? | How long a returned request waits for the requester (EC-52). Default: no limit, so nothing is closed silently |
| `onResubmitTimeout` | `"remind" \| "auto-withdraw"` | Requires `resubmitDeadline`; present exactly when it is set (default `"remind"`) |
| `remindBlockedEvery` | Duration \| `"never"` | Repeats `step.still_blocked` while a step is blocked (EC-53). Default `"P1D"` |
| `remindOverdueEvery` | Duration \| `"never"` | Repeats `task.reminder` while a task is overdue (EC-55). Default `"P1D"` |

Unknown keys are rejected so a typo cannot silently disable a setting.

## StepDefinition

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the flow |
| `name` | string? | Display name |
| `approvers` | ApproverSpec | Who decides |
| `mode` | `"any" \| "all" \| { quorum: number }` | Default `"any"`: the first decision, approve or reject, decides the step and supersedes the other tasks (EC-12). `all` and quorum: approved once enough approvals arrive, rejected as soon as approval can no longer be reached (EC-13, EC-14). A quorum larger than a static `users` list is rejected |
| `when` | Condition? | Step runs only if true; evaluated on the payload snapshot |
| `deadline` | Duration? | e.g. `"P2D"`, `"PT8H"` |
| `remindBefore` | Duration? | Emit one reminder per pending task before the deadline. Requires `deadline`; must be shorter |
| `onTimeout` | `"remind" \| "escalate" \| "auto-approve" \| "auto-reject"` | Requires `deadline`; present exactly when `deadline` is set (default `"remind"`) |
| `escalateTo` | ApproverSpec? | Required for `"escalate"`, not allowed otherwise (Pro allows org-relative targets) |

Not supported yet: a *veto* rule where one rejection immediately rejects a quorum step. It will be
added if users ask for it.

## Duration

ISO 8601 durations restricted to fixed-length units: `PnW`, or `PnDTnHnMnS` with any subset of
D/H/M/S (e.g. `"P2D"`, `"PT8H"`, `"P1DT12H"`). Years and months are rejected because their length
varies (EC-31: durations are absolute unless a calendar is supplied). Fractions, negative and
zero-length durations are rejected.

## ApproverSpec

```ts
type ApproverSpec =
  | { type: "users"; ids: string[] }                     // at least one id
  | { type: "role"; role: string }                       // host resolves role -> users
  | { type: "resolver"; name: string; params?: unknown } // named resolver (host or Pro); params are plain JSON
  | { type: "union"; of: ApproverSpec[] };               // at least one spec
```

## Condition (JSON rule language, no code execution)

```ts
type Primitive = string | number | boolean | null;

type Condition =
  | { field: string; op: "eq" | "neq"; value: Primitive }
  | { field: string; op: "gt" | "gte" | "lt" | "lte"; value: number | string }
  | { field: string; op: "in" | "nin"; value: Primitive[] }
  | { all: Condition[] }   // at least one
  | { any: Condition[] }   // at least one
  | { not: Condition };
```

`field` is a dot path into the request payload snapshot. Only own properties are read; array
elements are addressed by index (`"lines.0.amount"`).

Evaluation fails closed:

- `eq`, `neq`, `in`, `nin` use strict equality. A missing field evaluates as `undefined`.
- `gt`, `gte`, `lt`, `lte` compare number with number or string with string (ISO 8601 timestamps
  compare correctly as strings). A missing field, a type mismatch or `NaN` throws `ConditionError`
  (`CONDITION_INVALID`) naming the field, the expected type and the received type (EC-40).
- Every branch of `all` and `any` is evaluated, so an invalid comparison is never masked by
  short-circuiting.

## Request (`RequestState`)

Plain JSON. The engine never mutates it; every command returns a new state.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Generated by the service with the injected ID generator and passed in `submit` |
| `tenantId` | string? | Optional multi-tenant scoping |
| `flowKey`, `flowVersion` | string, number | Pinned at submit |
| `subject` | `{ type: string; id: string }` | The host record being approved |
| `requesterId` | string | |
| `payload` | JSON | Snapshot at submit; used by conditions (EC-36). Must be plain JSON: no `undefined`, `NaN`, `Date` or class instances |
| `status` | `"pending" \| "approved" \| "rejected" \| "returned" \| "withdrawn" \| "cancelled"` | `returned` is open, not closed: the requester can resubmit or withdraw it, and an admin can override it. `closedAt` is set only for approved, rejected and withdrawn |
| `currentStepIndex` | number \| null | Index of the active step; `null` when none is active |
| `version` | number | Optimistic concurrency; `1` after submit, incremented by every command |
| `submittedAt`, `closedAt` | ISO string | UTC |
| `steps` | StepInstance[] | Every activation or skip, in order |
| `lastAuditSeq` | number | Highest audit `seq` written for this request |
| `lastTaskNumber` | number | Counter for deriving task IDs |
| `resubmit` | `{ dueAt; remindedAt? }`? | While returned with a `resubmitDeadline` (EC-52) |
| `nextDueAt` | ISO string \| null | Earliest moment `tick` has something to do; lets a store find due requests |

## StepInstance

Created when a step **activates** or is **skipped** (not at submit). Approvers are resolved at
activation and stored as a snapshot. A step can have several instances after a return.

| Field | Type | Notes |
| --- | --- | --- |
| `stepId` | string | From the definition |
| `index` | number | Position of the step in the pinned flow |
| `status` | `"skipped" \| "active" \| "blocked" \| "approved" \| "rejected" \| "returned" \| "cancelled"` | `blocked`: see below |
| `approvers` | string[] | Snapshot of the users holding the step's tasks at activation: after removing inactive users and the requester, and after delegation. Empty when skipped or blocked |
| `removed` | `{ userId; reason: "inactive" \| "requester" \| "already-voted" }[]`? | Resolved users who are not approvers, with the reason (EC-01, EC-06, EC-54). Absent when nobody was removed |
| `skipReason` | `{ type: "condition-false"; condition } \| { type: "no-approvers" }`? | Why the step was skipped (EC-38, EC-02, EC-04) |
| `blockReason` | `{ type: "no-approvers" } \| { type: "quorum-unreachable"; required; available }`? | Why the step is blocked (EC-42, EC-45) |
| `activatedAt`, `skippedAt`, `blockedAt`, `closedAt` | ISO string? | `blockedAt` stays after the step is unblocked |
| `invalidatedAt` | ISO string? | Set when the instance stops counting after a return or resubmit, because its step runs again (see below) |
| `tasks` | Task[] | One per approver; none while blocked |
| `deadline` | `{ deadlineAt; remindAt?; remindedAt?; timedOutAt?; escalationDepth; reminders; nextReminderAt? }`? | Set when a step with a `deadline` activates (not while blocked). The markers make `tick` idempotent (EC-27) |
| `blockedReminder` | `{ nextAt; count }`? | While blocked, unless `remindBlockedEvery: "never"` (EC-53) |

### Resolution pipeline

Approvers are resolved when a step activates, in this order: merge duplicates (a user reached twice
through a `union` gets one task, EC-44), remove inactive users (EC-06), remove the requester unless
`allowSelfApproval` (EC-01), then dedupe against earlier steps (EC-03). With `dedupeApprovers:
"consecutive"` (default) a user who approved the previous step that ran (skipped steps do not count)
gets a `skipped-duplicate` task that counts as an approval; `"all"` looks at every earlier step,
`"none"` turns this off. Only real approvals carry over: a superseded approver is asked again.

A carried-over vote never closes a step on its own while the step has other approvers (EC-47). The
reason is separation of duties (the four-eyes principle): dedupe exists so nobody has to approve the
same thing twice, not so that one person can push a request through two levels alone. So the other
approvers always get tasks and at least one of them must approve; in a quorum step each
carried-over vote counts once and the rest come from fresh decisions. Only when every approver of
the step is carried over (nobody else could decide) is the step approved at once. The same rule
applies to users chosen by `reassign`.

The step then needs enough approvers for its mode: at least one, and at least `quorum` for a quorum
step. When it has too few:

- **At submit**, every applicable step is resolved up front (a dry run; the results are not stored).
  A step with no approvers under `onEmptyStep: "fail"`, or whose quorum cannot be reached, refuses
  the submit with `NoApproversError` and no request is created (EC-43).
- **Mid-flow**, the command that activates the step still succeeds. The step becomes `blocked`, the
  request stays `pending`, and `step.blocked` is emitted for an admin (EC-42).
- An empty step under `onEmptyStep: "skip"` is skipped instead. An unreachable quorum is never
  skipped.

A blocked step has no tasks, so nobody can approve or reject it. An admin resolves it with
`reassign` (users the admin chooses; they pass the same checks and must satisfy the mode), `retry`
(resolve the step's spec again; when it still has too few approvers the step stays blocked and only
`step.retried` is recorded) or `override` (close the whole request).

### Return and resubmit

An approver with a pending task can `return` the request:

- **To the requester** (EC-32). The task becomes `returned`, the other pending tasks of the step are
  superseded, the step closes with outcome `returned` and the request becomes `returned`.
- **To an earlier step that ran** (EC-33): `to: { stepId }`, a step with an approved instance that
  still counts. That step activates again with freshly resolved approvers, and every later step
  runs again after it. The request stays `pending`.

The requester then `resubmit`s, optionally with a new payload (the flow version stays pinned,
EC-37). Like submit, resubmit evaluates every condition against the payload and dry-runs the
resolution of every step that will run (EC-41, EC-43). `returnPolicy` decides where it resumes:

- `restart` (default): from the first step (EC-34).
- `from-returned-step`: at the step that returned it; earlier approvals stand. This applies only
  when the payload is unchanged (compared as JSON, ignoring key order). A changed payload restarts
  from the first step, because earlier conditional steps must be evaluated again; the audit records
  `applied: "restart"` with `payloadChanged: true` (EC-51).

History is never rewritten. Instances of steps that run again keep their status and get
`invalidatedAt`: they no longer carry approvals over (dedupe), no longer block delegation (EC-49)
and are not part of the current run when deciding whether every step was skipped (EC-39).

The requester can `withdraw` a pending or returned request at any time (EC-35): pending tasks and
the open step become `cancelled` and the request becomes `withdrawn`.

### Time: deadlines, reminders and escalation

Time only moves when the host calls `tick` with an injected `now`; Rungs never reads a clock. A
`tick` is a system action (`actorId: null`) and applies each due action once (EC-27); when nothing
is due it returns `unchanged`. Durations are absolute UTC time unless a `calendar` is injected
(EC-30, EC-31).

- **Reminders (D22, updated).** With `remindBefore`, every pending task gets one `task.reminder`
  (`overdue: false`) before the deadline; a tick that arrives after the deadline skips it. At the
  deadline, `onTimeout` applies. With `remind` (default) every pending task gets `task.reminder`
  with `overdue: true, count: 1`, and then again every `remindOverdueEvery` (default `P1D`, EC-55)
  with an increasing `count`, so an overdue task is never forgotten. A late tick sends one
  reminder, not one per missed interval, and the schedule resumes from the missed slot.
- **`auto-approve` / `auto-reject`.** Pending tasks become `expired`, `step.timed_out` is recorded
  and the step closes. These are explicit opt-ins and count as nobody's vote: nothing carries over
  by dedupe. An auto-rejected request records `request.rejected` with `reason: "timeout"`.
- **`escalate` (EC-28, EC-54).** `escalateTo` is resolved afresh (the need carries
  `escalationDepth`, so a resolver can walk up). Targets pass the usual pipeline (inactive,
  requester, delegation) and anyone who already voted in this step or approved an earlier step is
  removed with `reason: "already-voted"`: nobody votes twice. There is no dedupe, so an escalation
  never closes a step by itself. The targets replace the pending tasks (which become `expired`) and
  must be enough for the votes still needed (one person never replaces several votes, so a single
target cannot carry an `all` or quorum step that still needs two or more; deciding the whole step
by escalation is not supported yet); the step gets a new deadline of the same length. After
  `maxEscalationDepth` escalations, or with too few targets, the current tasks stay pending,
  `request.escalation_failed` alerts and overdue reminders continue (fail-safe).
- **Blocked steps (EC-53).** A blocked step has no deadline. Instead `step.still_blocked` repeats
  every `remindBlockedEvery` (default `P1D`) until an admin acts. `"never"` turns it off.
- **Returned requests (EC-52).** By default they wait without a time limit. With
  `resubmitDeadline`, `remind` sends `request.resubmit_overdue` once; `auto-withdraw` withdraws
  the request as a system action with `reason: "resubmit-timeout"`.

## Task

One per approver per step instance.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Derived deterministically: `${requestId}.t${n}` |
| `assigneeId` | string | Who can act now |
| `onBehalfOf` | string? | The approver whose vote the task carries when it reached the assignee by delegation (EC-20, EC-25). Kept through further delegation; dropped by an admin reassign |
| `status` | `"pending" \| "approved" \| "rejected" \| "returned" \| "superseded" \| "delegated" \| "reassigned" \| "skipped-duplicate" \| "cancelled" \| "expired"` | `delegated`: handed to a delegate (EC-25). `reassigned`: moved to another user by an admin. `skipped-duplicate`: counted as approved by dedupe (EC-03). `cancelled` is used only for withdraw and override |
| `assignedAt`, `decidedAt` | ISO string | `decidedAt` is also set when a task is superseded |
| `comment` | string? | |

## DelegationRule

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `fromUserId`, `toUserId` | string | |
| `startsAt`, `endsAt` | ISO string | Active from `startsAt` (inclusive) until `endsAt` (exclusive) |
| `scope` | `{ flowKeys?: string[] }`? | Empty or missing = all flows |
| `tenantId` | string? | When set, applies only to requests of that tenant |

Rules are applied when a task is created and never re-evaluated afterwards: a task stays with the
delegate after the rule ends (EC-24). When one user has several active rules, the one that started
most recently wins (then the lowest `id`). For each approver the engine follows the chain of rules:

- At most `maxDelegationDepth` hops; the task goes to the last valid delegate (EC-21).
- A cycle keeps the task with the original approver and records `delegation.cycle_detected` (EC-22).
- A delegate who is the requester (without `allowSelfApproval`) or inactive is passed over; the
  chain continues with that delegate's own rule (EC-23).
- A delegate who already holds a vote in the step, directly or through another delegation, or who
  approved an earlier step of the request, ends the chain: the task stays with the last valid
  holder, usually the original approver (EC-48, EC-49).

Every hop not taken is recorded as `delegation.skipped` with the reason.

**Delegation never merges votes.** The reason is separation of duties: a step that needs two
approvals must get them from two people, and a person who approved one level must not approve the
next level on someone else's behalf. Because no two slots ever end up with the same person, the
number of votes in a step never shrinks through delegation and `onBehalfOf` names exactly one
approver. A manual delegation (EC-25) or an admin reassign of a task is refused outright for a
user who already holds a task in the step or approved an earlier step, instead of being passed
over, because someone chose that user explicitly.

The one exception is handing a task back to the approver it acts for (EC-50), for example when
they return early: the vote is theirs, so nothing is merged. The new task has no `onBehalfOf`, no
out-of-office rules are followed, and `task.delegated` / `task.reassigned` carry
`returnedToOriginal: true`. Anyone else who held a task in the step stays refused, so a task cannot
bounce back and forth.

## AuditEvent (append-only)

| Field | Type | Notes |
| --- | --- | --- |
| `requestId` | string | |
| `seq` | number | Strictly increasing per request, starting at 1 |
| `type` | string | See below |
| `actorId` | string \| null | The user whose command caused the event; `null` for system actions (tick) |
| `at` | ISO string | |
| `data` | JSON | Event-specific details, including reasons |

Naming: `comment` is always free text written by a person, in commands and in audit data, required
for `override` and `reassign` and optional elsewhere. `reason` is always a machine-readable cause
(`skipReason`, `blockReason`, `request.approved.reason`, `delegation.skipped.reason`,
`removed[].reason`).

Types and data (discriminated union `AuditEvent` in `@rungs/core`):

| Type | Data |
| --- | --- |
| `request.submitted` | `flowKey`, `flowVersion`, `subject` |
| `request.approved` | `reason: "steps-approved"`, `reason: "all-steps-skipped"` with `skippedStepIds` (EC-39), or `reason: "override"` with `comment` (EC-18) |
| `request.rejected` | `reason: "step-rejected"` or `reason: "timeout"` with `stepId`, or `reason: "override"` with `comment` (EC-18, EC-26) |
| `request.returned` | `stepId` (the step that returned it), `comment?` (EC-32) |
| `request.resubmitted` | `returnPolicy`, `applied` (the policy actually used), `payloadChanged` (EC-34, EC-51) |
| `request.withdrawn` | `comment?` (EC-35), or `reason: "resubmit-timeout"` from a tick (EC-52) |
| `request.resubmit_overdue` | `stepId` (that returned it), `dueAt` (EC-52) |
| `request.escalated` | `stepId`, `stepIndex`, `depth`, `toUserIds`, `removed?` (EC-28, EC-54) |
| `request.escalation_failed` | `stepId`, `stepIndex`, `depth`, `reason: "max-depth"`, or `reason: "too-few-targets"` with `required`, `available`, `removed?` (EC-28) |
| `step.timed_out` | `stepId`, `stepIndex`, `action: "auto-approve" \| "auto-reject"` (EC-26) |
| `step.still_blocked` | `stepId`, `stepIndex`, `blockedSince`, `reason`, `count` (EC-53) |
| `step.activated` | `stepId`, `stepIndex`, `approvers`, `removed?` |
| `step.skipped` | `stepId`, `stepIndex`, `reason` (`condition-false` with the condition, or `no-approvers`), `removed?` |
| `step.blocked` | `stepId`, `stepIndex`, `reason` (`no-approvers` or `quorum-unreachable`), `removed?` (EC-42) |
| `step.reassigned` | `stepId`, `stepIndex`, `toUserIds`, `comment` (EC-46) |
| `step.retried` | `stepId`, `stepIndex`, `result: "unblocked"`, or `result: "still-blocked"` with `reason` and `removed?` (EC-46) |
| `step.completed` | `stepId`, `stepIndex`, `outcome: "approved" \| "rejected" \| "returned"` |
| `step.cancelled` | `stepId`, `stepIndex` (override) |
| `task.assigned` | `taskId`, `stepId`, `assigneeId`, `onBehalfOf?`, `chain?` (the out-of-office hops followed, from the first user to the assignee) |
| `task.delegated` | `taskId`, `stepId`, `toTaskId`, `toUserId`, `comment?`, `returnedToOriginal?` (EC-25, EC-50) |
| `task.reassigned` | `taskId`, `stepId`, `toTaskId`, `toUserId`, `comment`, `returnedToOriginal?` (EC-50) |
| `delegation.skipped` | `stepId`, `userId` (whose rule), `toUserId`, `reason: "requester" \| "inactive" \| "target-already-approver" \| "target-already-decided"` (EC-23, EC-48, EC-49) |
| `delegation.cycle_detected` | `stepId`, `userId` (the original approver), `chain` (EC-22) |
| `task.deduplicated` | `taskId`, `stepId`, `assigneeId`, `ofTaskId` (the earlier approval that carries over, EC-03) |
| `task.approved`, `task.rejected` | `taskId`, `stepId`, `comment?` |
| `task.returned` | `taskId`, `stepId`, `to: "requester" \| { stepId }`, `comment?` (EC-32, EC-33) |
| `task.superseded` | `taskId`, `stepId`, `byTaskId` |
| `task.cancelled` | `taskId`, `stepId` (override, withdraw) |
| `task.reminder` | `taskId`, `stepId`, `assigneeId`, `deadlineAt`, `overdue: false`, or `overdue: true` with `count` (EC-26, EC-55) |
| `task.expired` | `taskId`, `stepId` (timeout or escalation) |

Audit events are the source of truth for "what happened and why". Domain events emitted to the host for
notifications are derived from them one to one, except that `task.approved` and `task.rejected`
become `task.decided` with `decision: "approved" | "rejected"`.
