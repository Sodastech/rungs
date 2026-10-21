# 04 — Public API design (draft)

Draft for Phase 1. Shapes may change until `1.0`; every change is recorded here.

## Two layers

1. **Pure engine** — `decide(state, command, context) => Decision`.
   No I/O. Used internally and available for advanced users and tests (see below).
2. **Service** — `createRungs(options)` wires the engine to a store, resolvers, clock and event hooks.
   This is what most applications use.

`@rungsjs/core` has three entry points, one per audience:

| Import | For | Contents |
|---|---|---|
| `@rungsjs/core` | Applications | `createRungs`, `defineFlow`, flow, request, event and query types, errors, `RungsStore` |
| `@rungsjs/core/store` | Store adapter authors | `StoreTx` and its query types, `taskViews`, `requestSummary`, `blockedStepView` |
| `@rungsjs/core/engine` | Building your own service | `decide`, the command types, `Decision`, `EngineContext` |

## Creating an instance

```ts
import { createRungs } from "@rungsjs/core";
import { postgresStore } from "@rungsjs/store-postgres";

const rungs = createRungs({
  store: postgresStore({ pool }),
  clock: () => new Date(),            // required: the core never reads a clock; tests pass a fake
  ids: () => crypto.randomUUID(),     // required: generates request IDs
  roles: async (role, ctx) => getUserIdsWithRole(role, ctx.tenantId),
  resolvers: {
    // host-defined named resolvers (Pro adds org-aware ones)
    projectOwner: async ({ request }) => [await getProjectOwner(request.subject.id)],
  },
  isActiveUser: async (userId) => isEmployeeActive(userId), // optional
  calendar,                                                 // optional, synchronous (EC-30)
  onEvent: async (event) => notify(event),                  // notifications, webhooks
  onEventError: (error, event, attempts) => log(error),     // optional; delivery is retried
  dispatchRetry: { baseDelay: "PT30S", maxDelay: "PT1H" },  // optional; these are the defaults
  events: "outbox",                                         // default; "discard" writes no outbox
});
```

Each command runs in one store transaction: load the request (locked for update), decide,
resolve what the engine asks for, decide again, then save state, audit and outbox together.
**Keep `roles`, `resolvers` and `isActiveUser` fast**: in 0.x they run inside that transaction,
so a slow callback holds the request's lock. A failing callback rolls the whole command back
(`ResolutionError`, EC-05).

**Do not use the command's database connection inside a callback.** While a callback runs, Rungs
holds that connection in an open transaction. A callback that reads from the same database must
get another connection from a pool, so the pool needs more than one connection. A database with a
single connection, such as PGlite, waits for the transaction to finish and the command never
completes: keep what the callbacks need in memory instead (the Next.js example does this for
`isActiveUser`). The public API does not depend on this choice (see
`docs/06-architecture.md`).

Every command method returns the new `RequestState` and accepts `idempotencyKey` and
`expectedVersion` (`submit` accepts only `idempotencyKey`):

- `expectedVersion` refuses the command with `ConflictError` when the request has moved on
  (EC-15). Commands are never retried automatically, because the actor may have been superseded.
- `idempotencyKey` is scoped per tenant (EC-57). A repeat with the same command returns the first
  result without recording anything (EC-16); the same key with a different command is refused with
  `InvalidCommandError`.

`rungs.tick({ limit })` runs `tick` on every due request, each in its own transaction, and returns
`{ processed, changed, skipped, failed }`; a request another worker changed meanwhile is skipped
(EC-27). `rungs.dispatchPending({ limit })` returns `{ delivered, failed }`.

## Flows

```ts
import { defineFlow } from "@rungsjs/core";

const leave = defineFlow({
  key: "leave",
  allowSelfApproval: false,
  dedupeApprovers: "consecutive",
  steps: [
    { id: "manager", approvers: { type: "resolver", name: "directManager" }, deadline: "P1D", onTimeout: "escalate",
      escalateTo: { type: "role", role: "hr" } },
    { id: "hr", approvers: { type: "role", role: "hr" }, mode: "any",
      when: { field: "days", op: "gt", value: 3 } },
  ],
});

await rungs.flows.register(leave);   // validates; returns { key, version, created }
await rungs.flows.register(acmeLeave, { tenantId: "acme" }); // a tenant's own flow
await rungs.flows.get("leave", { tenantId: "acme" });        // what a submit would use
```

`flows.register` also checks the flow against the configured callbacks: every named resolver
(also in `escalateTo` and inside `union`) must exist, and a `role` spec needs the `roles`
callback. Unknown role names are fine; they resolve to nobody (`NO_APPROVERS`). Registering
content equal to the latest version returns that version with `created: false` (D23). Versions are
numbered per tenant and key.

On submit the tenant's own flow is used when it exists, otherwise the global flow; with neither,
`FlowNotFoundError` (EC-56). The request is pinned to that exact flow (`flowKey`, `flowVersion`
and `flowTenantId`), so a flow registered later, even the tenant's own, never changes it.

`defineFlow` validates statically (unique step IDs, valid durations, valid conditions, quorum ≤ possible
for static `users` lists, timeout settings, unknown keys) and returns a deeply frozen `FlowDefinition`
with defaults applied (see `docs/03-domain-model.md`). Validation errors are `FlowDefinitionError`
with `issues: { path, message }[]` listing every problem, e.g. `{ path: "steps[1].deadline", ... }`.

Limits that shape a flow's behavior are flow settings, not `createRungs` options, so a flow carries
everything needed to replay it: `maxEscalationDepth` and `maxDelegationDepth` (both default `3`).

## Commands

Every command accepts an optional `idempotencyKey` and `expectedVersion`.

Each method's input has a named type, for handlers and wrappers in the host: `SubmitInput`,
`ApproveInput`, `RejectInput`, `ReturnInput`, `ResubmitInput`, `WithdrawInput`, `DelegateInput`,
`ReassignInput` (a blocked step or a single task), `RetryInput` and `OverrideInput`. `tick` takes
`TickOptions` and `dispatchPending` takes `DispatchOptions` (`{ limit? }`).

**The payload is not where your business data lives.** Keep the record itself (an expense with its
lines and receipts, a leave request, a purchase order) in your own tables, and point Rungs at it with
`subject: { type, id }`. Put in the payload only what the flow's conditions read (for example
`amount`) and what you want to show in lists. The payload is a snapshot taken at submit (EC-36): it
does not follow later changes to your record, it is copied into list results, and it can contain
personal data.

The `payload` must be plain JSON, because it is persisted and conditions are evaluated against it.
Anything else is rejected with `InvalidCommandError`, naming every offending path and its type:

```ts
await rungs.submit({ ..., payload: { amount: 1200, submittedAt: new Date(), lines: [1, undefined] } });
// InvalidCommandError (COMMAND_INVALID):
//   Invalid command: payload.submittedAt is a Date; send an ISO 8601 string;
//   payload.lines[1] is undefined; omit the field or send null
```

Also rejected: `NaN` and `Infinity` ("send a finite number"), functions, `bigint`, and class
instances such as `Map` ("send a plain object or array").

```ts
const req = await rungs.submit({
  flow: "leave",
  subject: { type: "leave_request", id: "LR-1042" },
  requesterId: "u_17",
  payload: { days: 5 },
  tenantId: "acme",
});

await rungs.approve({ requestId: req.id, actorId: "u_08", comment: "Enjoy" });
await rungs.reject({ requestId: req.id, actorId: "u_08", comment: "Overlaps release week" });
await rungs.return({ requestId: req.id, actorId: "u_08", to: "requester", comment: "Attach doctor's note" });
await rungs.resubmit({ requestId: req.id, actorId: "u_17", payload: { days: 4 } });
await rungs.withdraw({ requestId: req.id, actorId: "u_17" });
await rungs.delegate({ requestId: req.id, taskId, actorId: "u_08", toUserId: "u_09", comment: "Travelling" });
await rungs.reassign({ requestId: req.id, taskId, adminId: "u_admin", toUserId: "u_11", comment: "Approver left company" });
await rungs.override({ requestId: req.id, adminId: "u_admin", decision: "approve", comment: "Board decision" });

// A blocked step (EC-42): no approvers were left when it activated
await rungs.reassign({ requestId: req.id, stepId: "hr", adminId: "u_admin", toUserIds: ["u_12"], comment: "HR lead on leave" });
await rungs.retry({ requestId: req.id, stepId: "hr", adminId: "u_admin" }); // after fixing org/role data

await rungs.tick();   // process deadlines, reminders, timeouts; safe to run on a schedule
```

## Pure engine (advanced)

```ts
import { decide } from "@rungsjs/core/engine";

const decision = decide(state /* RequestState | null */, command, {
  now: "2026-01-05T09:00:00.000Z", // ISO 8601 UTC, injected
  flow,                            // RegisteredFlow: defineFlow(...) plus its version
  resolutions,                     // answers to earlier needs, keyed by need.key
  calendar,                        // optional: { addDuration, subtractDuration }, sync (EC-30)
});

if (decision.kind === "needs-resolution") {
  // decision.needs: [{ key, stepId, spec, escalationDepth? }] — collect approvers, then call
  // decide again with the same state and command plus resolutions: { [need.key]: { userIds } }.
} else if (decision.kind === "unchanged") {
  // a tick found nothing due: nothing to store
} else {
  // decision.state, decision.audit, decision.events
}
```

Commands:

- `{ type: "submit", requestId, requesterId, subject, payload, tenantId? }`
- `{ type: "approve" | "reject", requestId, actorId, comment? }`
- `{ type: "delegate", requestId, taskId, actorId, toUserId, comment? }`: the assignee hands a
  pending task to someone else (EC-25). The old task becomes `delegated`; the new one carries the
  same vote (`onBehalfOf`) and follows the delegate's own out-of-office rules.
- `{ type: "reassign", requestId, adminId, taskId, toUserId, comment }`: an admin moves one pending
  task. The old task becomes `reassigned`; the new one has no `onBehalfOf`.

  Both refuse, with `InvalidCommandError` naming each problem, a target who is the requester
  (without `allowSelfApproval`), inactive, already holds a task in the step or has a vote in it through a delegate (EC-48), or approved an
  earlier step of the request (EC-49). Delegating to yourself is refused too. The exception is
  the approver the task acts for (`onBehalfOf`): it can always be handed back to them (EC-50).

**Deciding a delegated task.** `approve`, `reject` and `return` accept the task's assignee and also
the approver it acts for (`onBehalfOf`), who does not need to take it back first (EC-60). Whoever
decides first closes the task; the other gets `NotAssignedError`. The decision event names everyone:
`actorId` is who acted, `onBehalfOf` whose vote it was, and `heldBy` the delegate when the owner
decided. `delegate` stays with the assignee.

**Active users.** Rungs checks whether users are active only while resolving approvers (EC-06). It
does not check it when someone decides, for an assignee or for the approver a task acts for. The
host application is responsible for blocking users who are no longer active, for example by
refusing their sign-in or not offering the action.
- `{ type: "reassign", requestId, adminId, stepId, toUserIds, comment }`: gives a blocked step to
  users the admin chose. They pass the same checks as resolved approvers; a chosen user who is
  inactive or the requester (without `allowSelfApproval`), or too few users for the step's mode,
  refuses the command with `InvalidCommandError` naming each problem.
- `{ type: "retry", requestId, adminId, stepId }`: resolves a blocked step's spec again.
- `{ type: "override", requestId, adminId, decision: "approve" | "reject", comment }`: closes the
  request; open tasks and the open step are cancelled (EC-18).
- `{ type: "return", requestId, actorId, to: "requester" | { stepId }, comment? }`: the actor
  needs a pending task; `stepId` must be an earlier step that ran (EC-32, EC-33).
- `{ type: "resubmit", requestId, actorId, payload? }`: requester only; see `returnPolicy` in
  `docs/03-domain-model.md` (EC-34, EC-51).
- `{ type: "withdraw", requestId, actorId, comment? }`: requester only (EC-35).

Free text is always `comment` (required for `override` and `reassign`); `reason` is reserved
for machine-readable causes. `{ type: "tick", requestId }` applies whatever is due at `now` as a system action (EC-26): it
returns `unchanged` when nothing is due or the request is closed, so concurrent or repeated ticks
are harmless (EC-27). Due requests are found by `nextDueAt`. An escalation asks for its targets
with the key `escalate:<stepId>`. Escalation targets must cover every vote the step still needs: in an
`all` or quorum step that still needs more than one vote, escalating to a single person ends in
`request.escalation_failed`, by design, because one person must not replace several votes
(separation of duties). For example, an `all` step with A, B and C where only A approved needs
two targets. Letting one escalation target decide the whole step is not supported yet.

A calendar is synchronous so the engine stays pure: a host that needs holidays loads them first.
Both functions must return ISO 8601 UTC timestamps; anything else is an `InvalidCommandError`.

A returned request accepts only `resubmit`, `withdraw` and `override`; anything else is an
`InvalidTransitionError`. `decide` throws a `RungsError` when a command is not
allowed and never changes its input. Task IDs are derived from the request ID, so the engine needs
no ID generator. Rungs does not check that `adminId` is an admin; that is the host's job.

A resolution is `{ userIds, inactiveUserIds?, delegations? }`: the raw users the spec resolved
to, which users the host's `isActiveUser` reported inactive, and the out-of-office rules of those
users and of the delegates their rules lead to (`inactiveUserIds` covers those delegates too).
The engine removes inactive users and the requester, applies only the rules active at `now`, in
scope and in the tenant, and records why. Needs for chosen users have their own keys
(`reassign:<stepId>`, `reassign:<taskId>`, `delegate:<taskId>`) and a `users` spec with those users,
so the service only checks whether they are active and loads their rules.

On submit the engine evaluates every step condition once against the payload, so an invalid
condition fails the requester's submit instead of blocking an approver later (EC-41). It then asks
for the approvers of every applicable step at once and refuses the submit with `NoApproversError`
when one of them could never run (EC-43). Mid-flow, such a step is blocked instead (EC-42).

## Queries

```ts
await rungs.get(requestId);        // RequestState, or null when it does not exist
await rungs.history(requestId);    // audit events, ordered by seq ([] when unknown)
await rungs.inbox({ userId: "u_08", tenantId: "acme", limit: 50, after });
// { tasks: [{ requestId, tenantId?, flowKey, flowVersion, subject, requesterId, stepId,
//             taskId, assigneeId, onBehalfOf?, heldBy?, assignedAt, deadlineAt?, payload,
//             overdue }], next? }
await rungs.requests({ tenantId: "acme", requesterId: "u_17", status: ["pending", "returned"],
  subject: { type: "leave_request", id: "LR-1042" }, flowKey: "leave", limit: 50, after });
// { requests: [{ id, tenantId?, flowKey, flowVersion, subject, requesterId, status,
//                submittedAt, closedAt?, version, payload, openStep }], next? }
await rungs.blocked({ tenantId: "acme", limit: 50, after });
// { steps: [{ requestId, tenantId?, flowKey, flowVersion, subject, requesterId, payload,
//             stepId, blockedAt, reason, removed, version }], next? }
await rungs.preview({
  flow: "leave", requesterId: "u_17", subject: { type: "leave_request", id: "LR-1042" },
  payload: { days: 5 }, tenantId: "acme",
});
```

**`inbox`** lists the pending tasks on active steps that the user can decide, oldest first: tasks
assigned to them, tasks they hold as a delegate (with `onBehalfOf`, the approver they act for), and
tasks a delegate holds on their behalf (with `heldBy`, the delegate). The last kind lets an approver
who is back from leave see what waits for them and decide it directly (EC-60). Pass `next` back as `after` for the next page. Without
`tenantId` it returns only requests without a tenant, never other tenants' tasks.

**`requests`** lists requests, newest first (by `submittedAt`, then `id`). Every filter is
optional and they combine: `requesterId`, `status` (one status or a list), `subject` (`type` and
`id` for the requests about one record of yours, or `type` alone), and `flowKey`. Use it for "my
requests" pages and to find the approval of one of your records. Each item has the request's
`version`, to pass as `expectedVersion`, and `openStep`: the step waiting for a decision
(`status: "active"`) or for an admin (`"blocked"`), or `null` when nothing is open.

**`blocked`** lists blocked steps (EC-42), the longest blocked first, with why they are blocked
(`reason`, `removed`) and the request `version` for `reassign` or `retry`. A step leaves the list
when an admin reassigns it, a retry finds approvers, or the request is overridden or withdrawn.

All three lists match the tenant exactly: without `tenantId` they return only requests without a
tenant, never other tenants' requests (EC-62). `limit` defaults to 50; for `requests` and `blocked`
it is at most 200. Pass `next` back as `after` for the next page; paging never repeats or skips an
item when new requests arrive in between. An invalid `limit`, `status`, `subject` or `after` is an
`InvalidCommandError`.

Results are read-only: list pages, `history`, `delegations.list`, `preview` and the `tick` summary
are typed with `readonly` arrays. Copy one (`[...page.requests]`) to sort or change it.

**Who may see a list is the host's decision.** Rungs does not check it, and every item carries the
request payload, which can contain personal data. Show a requester only their own requests, an
approver their own inbox, and the blocked list only to admins.

**`preview`** shows the requester the expected approval chain before submitting, without storing
anything. For each step: `status` (`"will-run"`, `"skipped"` with `skipReason`, or `"cannot-run"`
with `shortfall`), the `approvers` who would get a task after removals and delegation, `removed`
with reasons, and `delegations` (who would act for whom). `submittable` is false when a submit would
be refused now (a step cannot run, or every step is skipped under `onAllSkipped: "fail"`). An
invalid payload throws `ConditionError`, as a submit would.

The input is validated like a submit's: `subject` is required, because resolvers may look data up
by subject (`InvalidCommandError` when it is missing or empty). Rungs never passes resolvers a
stand-in subject, which could silently produce the wrong approvers.

- The preview reflects the moment it runs. The actual approvers can differ if the org data, roles
  or delegation rules change before a step activates; each step is resolved again then. Dedupe is
  not applied, because it depends on who actually approves the earlier steps.
- A preview can show other people's out-of-office rules to the requester (who covers for whom).
  The host decides whether to display that information.

## Delegation rules (out of office)

```ts
await rungs.delegations.set({
  fromUserId: "u_08", toUserId: "u_09", startsAt, endsAt, scope: { flowKeys: ["leave"] }, tenantId,
}); // returns the rule with a generated id
await rungs.delegations.list({ userId: "u_08", tenantId }); // rules from or to the user
await rungs.delegations.end({ id });
```

- `set` refuses delegating to oneself, timestamps that are not ISO 8601 UTC and an empty period
  (`InvalidCommandError`). Overlapping rules are allowed; the most recently started one applies.
- `end` ends an active rule now (`endsAt = now`). A rule that has not started yet is cancelled
  instead (`cancelledAt = now`, kept for history), so `endsAt` never precedes `startsAt`; a
  cancelled rule never applies. Ending a rule never moves tasks already delegated (EC-24).
- Rules without a `tenantId` apply to every tenant; rules with one apply only to that tenant.
- **Rungs does not check who may manage a rule.** The host must make sure `fromUserId` is the
  signed-in user, or that the caller is an admin, before calling `set` or `end`.

## Events

Emitted after a command commits (outbox-style; the store persists them in the same transaction).

```
request.submitted   request.approved   request.rejected   request.returned   request.withdrawn
request.resubmitted
step.activated      step.skipped       step.completed     step.blocked       step.reassigned
step.retried        step.cancelled
delegation.skipped  delegation.cycle_detected
task.assigned       task.decided       task.returned      task.superseded    task.deduplicated
task.cancelled
task.delegated      task.reassigned    task.reminder      task.expired
request.escalated   request.escalation_failed   request.resubmit_overdue
step.timed_out      step.still_blocked
```

Each event carries `requestId`, `tenantId`, `at`, and event-specific data (for example the assignee for
`task.assigned`, so the host can send an email).

## Errors

All extend `RungsError` and expose a stable `code`.

| Class | Code | When |
| --- | --- | --- |
| `FlowDefinitionError` | `FLOW_INVALID` | Invalid flow definition |
| `FlowNotFoundError` | `FLOW_NOT_FOUND` | No flow with this key (and version) for the tenant or globally (EC-56). Exposes `flowKey`, `version?`, `tenantId?` |
| `ConfigurationError` | `CONFIG_INVALID` | `createRungs` was given unusable options (missing `store`, `clock` or `ids`, an invalid `dispatchRetry` duration, `events: "discard"` with `onEvent`), `clock` or `ids` returned unusable values, or `dispatchPending` was called without `onEvent` |
| `InvalidCommandError` | `COMMAND_INVALID` | Malformed command input (e.g. empty IDs, non-JSON payload, override without a comment). The message names each problem |
| `FlowNotApplicableError` | `FLOW_NOT_APPLICABLE` | Submit refused because every step was skipped and the flow uses `onAllSkipped: "fail"` (EC-39). Exposes `flowKey`, `skippedStepIds` |
| `RequestNotFoundError` | `REQUEST_NOT_FOUND` | Unknown request |
| `NotAssignedError` | `NOT_ASSIGNED` | Actor has no pending task on this request, or is not the requester for `resubmit` / `withdraw` |
| `InvalidTransitionError` | `INVALID_TRANSITION` | e.g. approving a closed request |
| `ConflictError` | `VERSION_CONFLICT` | `expectedVersion` mismatch or concurrent write (EC-15). Exposes `requestId`, `expectedVersion`, `actualVersion` |
| `ResolutionError` | `RESOLUTION_FAILED` | A host callback (role lookup, named resolver, `isActiveUser`) threw or returned invalid data (EC-05). Usually transient: nothing changed, so the command can be retried. The original error is in `cause`; exposes `stepId` |
| `NoApproversError` | `NO_APPROVERS` | Submit refused because a step has no approvers (`onEmptyStep: "fail"`) or cannot reach its quorum (EC-02, EC-04, EC-43, EC-45). A configuration or data problem: retrying will not help. Exposes `stepId`, `reason`, `removed` |
| `ConditionError` | `CONDITION_INVALID` | A `gt`/`gte`/`lt`/`lte` condition meets a missing field or a type mismatch (EC-40). Exposes `field`, `op`, `expected`, `received` |

Note: Rungs checks **workflow routing** (is this actor assigned?), not **authentication**.
The host must authenticate the actor before calling a command.

## PostgreSQL store (`@rungsjs/store-postgres`)

PostgreSQL 15 or newer. The package has no runtime dependencies: you pass the driver you already
use through a small adapter.

```ts
import pg from "pg";
import { fromPg, migrate, postgresStore } from "@rungsjs/store-postgres";

const db = fromPg(new pg.Pool({ connectionString }));  // or fromPostgresJs(sql), fromPglite(db)
await migrate(db);                                      // once per deploy; safe to run concurrently
const rungs = createRungs({ store: postgresStore(db), clock, ids });
```

- **Drivers.** `fromPg` (node-postgres `Pool`), `fromPostgresJs` (postgres.js `sql`) and
  `fromPglite` (PGlite, in-process PostgreSQL for tests and demos). Any other driver works by
  implementing `PgClient`: `query(text, params)`, `execute(script)` and `transaction(fn)`.
- **Schema.** Request state is stored as JSONB; the columns and the `inbox` table that `findDue`,
  `findInbox` and `pendingEvents` need are written in the same transaction and indexed. Tables live
  in schema `public` with prefix `rungs_` by default; pass `{ schema, tablePrefix }` to
  `migrate`, `postgresStore` and the purge functions to change that.
- **Migrations.** `migrate(db)` applies missing migrations in one transaction under an advisory
  lock. Hosts with their own migration tool use `migrationSql({ schema, tablePrefix, from })`, or
  the scripts shipped in `migrations/`. Migrations only go forward. The store refuses to work on an
  older schema (`ConfigurationError`), so a forgotten migration fails loudly.
- **Concurrency.** Commands lock the request row (`SELECT … FOR UPDATE`) and save with a
  compare-and-set on `version`. `tick` and event delivery claim rows with a short lease
  (`leaseSeconds`, default 60) using `FOR UPDATE SKIP LOCKED`, so workers running at the same time
  skip each other's rows. Correctness does not depend on the lease (EC-27).
- **Tenants.** Every tenant-scoped query matches `tenantId` exactly. Row Level Security is not
  supported yet.
- **Audit trail.** A trigger rejects every UPDATE, DELETE and TRUNCATE on the audit table, except
  DELETE inside the purge functions below. It guards against accidents, not against a database
  user who sets the purge flag deliberately.

### Data retention is the host's responsibility

Rungs never deletes data on its own. Your retention policy, and requests to erase personal data
(for example under GDPR or Indonesia's UU PDP), are carried out by calling these functions, for
example from a scheduled job. Each returns what it deleted, so you can record it in your own logs.

```ts
await purgeRequest(db, requestId);                                   // one closed request (EC-61)
await purgeRequests(db, { closedBefore: "2025-01-01T00:00:00Z", tenantId: "acme", limit: 1000 });
await purgeRequests(db, { closedBefore: "2025-01-01T00:00:00Z", allTenants: true });
await purgeIdempotency(db, { olderThan: "2026-01-01T00:00:00Z" });   // { idempotencyKeys }
await purgeDispatchedEvents(db, { olderThan: "2026-01-01T00:00:00Z" }); // { events }
```

- `purgeRequest` and `purgeRequests` delete **closed** requests (approved, rejected, withdrawn)
  with their audit events, outbox events, inbox rows and idempotency records, in one transaction,
  and return `{ requests, auditEvents, outboxEvents, idempotencyKeys }`. A request that is still
  open is refused with `InvalidTransitionError`; nothing is deleted.
- `purgeRequests` handles at most `limit` (default 1000) requests per call; call it again until
  `requests` is below the limit. The tenant scope is always explicit: pass one `tenantId`, or
  `allTenants: true` to cover every tenant. Neither or both is an `InvalidCommandError`, so a
  forgotten option never deletes other tenants' data.
- `purgeIdempotency`: after it, repeating one of those commands runs it again, so keep records at
  least as long as clients may retry. `purgeDispatchedEvents` never touches undelivered events.
- Payloads may contain personal data. Purging a request removes its state and audit trail; data
  your application copied elsewhere (notifications, logs, your own tables) is yours to delete.

## Store interface (for adapter authors)

Fixed for 1.8. Everything the store returns is plain JSON; the service never shares objects with it.
Adapters import these types and the view helpers from `@rungsjs/core/store`.

```ts
interface RungsStore {
  /** Runs `fn` atomically: all writes commit together, or none do when `fn` throws. */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
}

/** A flow or idempotency key belongs to one tenant, or is global when `tenantId` is omitted. */
interface FlowRef { key: string; tenantId?: string; version?: number } // no version: the latest
interface IdempotencyRef { key: string; tenantId?: string }
interface EventKey { requestId: string; seq: number }

interface OutboxEntry {
  event: DomainEvent;
  attempts: number;      // failed deliveries so far
  nextAttemptAt: string; // ISO 8601 UTC
  lastError?: string;
}

interface IdempotentRecord {
  fingerprint: string;   // canonical form of the command, to refuse a reused key
  result: RequestState;  // what the first call returned
  at: string;
}

interface StoreTx {
  // Flows. Versions are numbered per (tenantId, key). getFlow matches the scope exactly;
  // the service looks up the tenant's flow first and then the global one.
  getFlow(ref: FlowRef): Promise<RegisteredFlow | null>;
  saveFlow(flow: RegisteredFlow): Promise<void>; // flow.tenantId sets the scope

  // Requests. saveRequest is a compare-and-set on `version`: expectedVersion null means
  // "must not exist yet". A mismatch throws ConflictError (EC-15).
  getRequest(id: string, opts?: { forUpdate?: boolean }): Promise<RequestState | null>;
  saveRequest(state: RequestState, expectedVersion: number | null): Promise<void>;
  appendAudit(events: AuditEvent[]): Promise<void>;
  findDue(now: string, limit: number, options?: { claim?: boolean }): Promise<string[]>; // nextDueAt <= now

  // Outbox (see "Event delivery").
  enqueueEvents(events: DomainEvent[], now: string): Promise<void>; // attempts 0, due now
  pendingEvents(q: { now: string; limit: number; requestId?: string; claim?: boolean }): Promise<OutboxEntry[]>;
  markDispatched(keys: EventKey[], now?: string): Promise<void>;
  markFailed(
    key: EventKey,
    failure: { attempts: number; nextAttemptAt: string; error: string },
  ): Promise<void>;

  // Idempotency (EC-16), written in the same transaction as the command.
  getIdempotent(ref: IdempotencyRef): Promise<IdempotentRecord | null>;
  putIdempotent(ref: IdempotencyRef, record: IdempotentRecord): Promise<void>;

  // Queries.
  getAudit(requestId: string): Promise<AuditEvent[]>;               // ordered by seq
  findInbox(query: InboxQuery): Promise<TaskView[]>;               // see below
  findRequests(query: RequestQuery): Promise<RequestSummary[]>;    // see below
  findBlocked(query: BlockedQuery): Promise<BlockedStepView[]>;    // see below

  // Delegation rules. With a tenantId: that tenant's rules and rules without one; without: only
  // rules without one. The engine filters by time, scope, tenant and cancelledAt.
  findDelegations(fromUserIds: string[], tenantId?: string): Promise<DelegationRule[]>;
  saveDelegation(rule: DelegationRule): Promise<void>;             // insert or replace by id
  getDelegation(id: string): Promise<DelegationRule | null>;
  listDelegations(query: { userId: string; tenantId?: string }): Promise<DelegationRule[]>; // from or to
}
```

`findInbox({ userId, tenantId?, limit, after? })` returns `TaskView`s for pending tasks on the active
step of pending requests that are assigned to the user or held by a delegate on the user's behalf
(`onBehalfOf`; the service adds `heldBy`) whose `tenantId` matches exactly (none matches
none), ordered by (`assignedAt`, `taskId`), starting after `after` when given.

`findRequests({ tenantId?, requesterId?, statuses?, subject?, flowKey?, limit, after? })` returns
requests matching every given filter, ordered by (`submittedAt` desc, `id` desc), starting after
`after` when given. `findBlocked({ tenantId?, limit, after? })` returns the blocked step of pending
requests, ordered by (`blockedAt`, `requestId`). Both match the tenant exactly, like `findInbox`.

Adapters build the items with `taskViews(state)`, `requestSummary(state)` and `blockedStepView(state)`
from `@rungsjs/core/store`, so every store returns the same shapes. A store that indexes these lists
writes what it needs in `saveRequest`, in the same transaction (the PostgreSQL store keeps
projection columns; its migration 2 adds them to existing data).

`tick` and event delivery pass `claim: true`. An adapter may then lease what it returns for a short
time so that concurrent workers skip it; without `claim` nothing is leased, so reads for inspection
never hide anything. `markDispatched` receives the delivery time for adapters that keep delivered
events.

Adapters prove they meet this contract by running the shared suites from the private
`@rungsjs/store-contract` package in their own tests: `storeContract(name, makeStore)` for the store
itself and `serviceSuite(name, makeStore)` for `createRungs` on top of it.

`RegisteredFlow` gains an optional `tenantId`, and a request pinned to a tenant's flow records it
as `flowTenantId`, so later commands load exactly the pinned flow (EC-37).

### Event delivery

Domain events are written to the outbox in the same transaction as the command and delivered to
`onEvent` after the commit, in `seq` order, at least once.

- `pendingEvents` returns only entries that are due (`nextAttemptAt <= now`) and never an entry
  while an earlier entry of the same request is still undelivered: each request contributes its
  due events in `seq` order, starting with its oldest undelivered one. Requests are ordered by the
  `nextAttemptAt` of that oldest event, then by `requestId`. Order is kept per request, and a
  failing event holds back only its own request.
- When `onEvent` throws, the command still succeeds. The service calls
  `onEventError(error, event, attempts)` and `markFailed` with
  `nextAttemptAt = now + min(baseDelay * 2^(attempts - 1), maxDelay)`. A failing event therefore
  sits out its backoff instead of taking a share of every `dispatchPending` call's `limit`.
- Events are never dropped. `rungs.dispatchPending({ limit })` delivers what is due, for example
  from a scheduled job or after a crash. It needs `onEvent`; without it, it throws
  `ConfigurationError`.
- Without `onEvent`, a process only writes events to the outbox; they stay pending (EC-58). This
  supports the common split between web processes (no `onEvent`) and a worker that runs
  `dispatchPending` with `onEvent`. **Without any consumer the outbox keeps growing.** A host that
  never needs events sets `events: "discard"`: nothing is written to the outbox (the audit trail
  is still kept). `"discard"` together with `onEvent` is a `ConfigurationError`.
- `createRungs({ dispatchRetry: { baseDelay: "PT30S", maxDelay: "PT1H" } })` sets the backoff
  (these are the defaults).
