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
  clock: () => new Date(),            // injected; tests pass a fake clock
  ids: () => crypto.randomUUID(),     // injected ID generator
  roles: async (role, ctx) => getUserIdsWithRole(role, ctx.tenantId),
  resolvers: {
    // host-defined named resolvers (Pro adds org-aware ones)
    projectOwner: async ({ request }) => [await getProjectOwner(request.subject.id)],
  },
  isActiveUser: async (userId) => isEmployeeActive(userId), // optional
  onEvent: async (event) => notify(event),                  // notifications, webhooks
});
```

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

await rungs.flows.register(leave);   // validates; returns { key, version }
```

`defineFlow` validates statically (unique step IDs, valid durations, valid conditions, quorum ≤ possible
for static `users` lists, timeout settings, unknown keys) and returns a deeply frozen `FlowDefinition`
with defaults applied (see `docs/03-domain-model.md`). Validation errors are `FlowDefinitionError`
with `issues: { path, message }[]` listing every problem, e.g. `{ path: "steps[1].deadline", ... }`.

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
await rungs.delegate({ taskId, actorId: "u_08", toUserId: "u_09", reason: "Travelling" });
await rungs.reassign({ taskId, adminId: "u_admin", toUserId: "u_11", reason: "Approver left company" });
await rungs.override({ requestId: req.id, adminId: "u_admin", decision: "approve", reason: "Board decision" });

await rungs.tick();   // process deadlines, reminders, timeouts; safe to run on a schedule
```

## Pure engine (advanced)

```ts
import { decide } from "@rungs/core";

const decision = decide(state /* RequestState | null */, command, {
  now: "2026-01-05T09:00:00.000Z", // ISO 8601 UTC, injected
  flow,                            // RegisteredFlow: defineFlow(...) plus its version
  resolutions,                     // answers to earlier needs, keyed by need.key
});

if (decision.kind === "needs-resolution") {
  // decision.needs: [{ key, stepId, spec }] — collect approvers, then call decide again
  // with the same state and command plus resolutions: { [need.key]: { userIds } }.
} else {
  // decision.state, decision.audit, decision.events
}
```

Commands: `{ type: "submit", requestId, requesterId, subject, payload, tenantId? }`,
`{ type: "approve" | "reject", requestId, actorId, comment? }` (more in later milestones).
`decide` throws a `RungsError` when a command is not allowed and never changes its input. Task IDs
are derived from the request ID, so the engine needs no ID generator.

On submit the engine evaluates every step condition once against the payload, so an invalid
condition fails the requester's submit instead of blocking an approver later (EC-41).

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
step.activated      step.skipped       step.completed
task.assigned       task.decided       task.superseded    task.delegated     task.reminder
task.expired
request.escalated
```

Each event carries `requestId`, `tenantId`, `at`, and event-specific data (for example the assignee for
`task.assigned`, so the host can send an email).

## Errors

All extend `RungsError` and expose a stable `code`.

| Class | Code | When |
| --- | --- | --- |
| `FlowDefinitionError` | `FLOW_INVALID` | Invalid flow definition |
| `FlowNotFoundError` | `FLOW_NOT_FOUND` | Unknown flow key |
| `InvalidCommandError` | `COMMAND_INVALID` | Malformed command input (e.g. empty IDs, non-JSON payload, override without reason). The message names each problem |
| `FlowNotApplicableError` | `FLOW_NOT_APPLICABLE` | Submit refused because every step was skipped and the flow uses `onAllSkipped: "fail"` (EC-39). Exposes `flowKey`, `skippedStepIds` |
| `RequestNotFoundError` | `REQUEST_NOT_FOUND` | Unknown request |
| `NotAssignedError` | `NOT_ASSIGNED` | Actor has no pending task on this request |
| `InvalidTransitionError` | `INVALID_TRANSITION` | e.g. approving a closed request |
| `ConflictError` | `VERSION_CONFLICT` | `expectedVersion` mismatch or concurrent write |
| `ResolutionError` | `RESOLUTION_FAILED` | Resolver threw, or a step is empty with `onEmptyStep: "fail"` |
| `ConditionError` | `CONDITION_INVALID` | A `gt`/`gte`/`lt`/`lte` condition meets a missing field or a type mismatch (EC-40). Exposes `field`, `op`, `expected`, `received` |

Note: Rungs checks **workflow routing** (is this actor assigned?), not **authentication**.
The host must authenticate the actor before calling a command.

## Store interface (for adapter authors)

```ts
interface RungsStore {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
}
interface StoreTx {
  getFlow(key: string, version?: number): Promise<FlowDefinition | null>;
  saveFlow(flow: FlowDefinition): Promise<void>;
  getRequest(id: string, opts?: { forUpdate?: boolean }): Promise<RequestState | null>;
  saveRequest(state: RequestState, expectedVersion: number | null): Promise<void>; // throws ConflictError
  appendAudit(events: AuditEvent[]): Promise<void>;
  enqueueEvents(events: DomainEvent[]): Promise<void>;
  findInbox(q: InboxQuery): Promise<TaskView[]>;
  findDue(now: string, limit: number): Promise<string[]>; // request IDs with due deadlines
  getIdempotent(key: string): Promise<unknown | null>;
  putIdempotent(key: string, result: unknown): Promise<void>;
  // delegation rules ...
}
```
