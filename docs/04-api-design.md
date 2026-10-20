# 04 — Public API design (draft)

Draft for Phase 1. Shapes may change until `1.0`; every change is recorded here.

## Two layers

1. **Pure engine** — `decide(state, command, context) => Decision`.
   No I/O. Used internally and available for advanced users and tests (see below).
2. **Service** — `createRungs(options)` wires the engine to a store, resolvers, clock and event hooks.
   This is what most applications use.

## Creating an instance

```ts
import { createRungs } from "@rungs/core";
import { postgresStore } from "@rungs/store-postgres";

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
});
```

Each command runs in one store transaction: load the request (locked for update), decide,
resolve what the engine asks for, decide again, then save state, audit and outbox together.
**Keep `roles`, `resolvers` and `isActiveUser` fast**: in 0.x they run inside that transaction,
so a slow callback holds the request's lock. A failing callback rolls the whole command back
(`ResolutionError`, EC-05). The public API does not depend on this choice (see
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
import { defineFlow } from "@rungs/core";

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
import { decide } from "@rungs/core";

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
  (without `allowSelfApproval`), inactive, already holds a task in the step (EC-48) or approved an
  earlier step of the request (EC-49). Delegating to yourself is refused too. The exception is
  the approver the task acts for (`onBehalfOf`): it can always be handed back to them (EC-50).
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
await rungs.get(requestId);                       // request + steps + tasks
await rungs.inbox({ userId: "u_08", tenantId });  // pending tasks assigned to the user (incl. delegated)
await rungs.history(requestId);                   // audit events, ordered
await rungs.preview({ flow: "leave", requesterId: "u_17", payload: { days: 5 } }); // who would approve, without submitting
```

`preview` is important for UX: it shows the requester the expected approval chain before submitting.

## Delegation rules (out of office)

```ts
await rungs.delegations.set({ fromUserId: "u_08", toUserId: "u_09", startsAt, endsAt, scope: { flowKeys: ["leave"] } });
await rungs.delegations.list({ userId: "u_08" });
await rungs.delegations.end({ id });
```

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

## Store interface (for adapter authors)

Fixed for 1.8. Everything the store returns is plain JSON; the service never shares objects with it.

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
  findDue(now: string, limit: number): Promise<string[]>; // ids with nextDueAt <= now

  // Outbox (see "Event delivery").
  enqueueEvents(events: DomainEvent[], now: string): Promise<void>; // attempts 0, due now
  pendingEvents(q: { now: string; limit: number; requestId?: string }): Promise<OutboxEntry[]>;
  markDispatched(keys: EventKey[]): Promise<void>;
  markFailed(
    key: EventKey,
    failure: { attempts: number; nextAttemptAt: string; error: string },
  ): Promise<void>;

  // Idempotency (EC-16), written in the same transaction as the command.
  getIdempotent(ref: IdempotencyRef): Promise<IdempotentRecord | null>;
  putIdempotent(ref: IdempotencyRef, record: IdempotentRecord): Promise<void>;

  // Delegation rules of these users; the engine filters by time, scope and tenant.
  findDelegations(fromUserIds: string[], tenantId?: string): Promise<DelegationRule[]>;
}
```

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
  from a scheduled job or after a crash.
- `createRungs({ dispatchRetry: { baseDelay: "PT30S", maxDelay: "PT1H" } })` sets the backoff
  (these are the defaults).
