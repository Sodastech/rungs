# 04 — Public API design (draft)

Draft for Phase 1. Shapes may change until `1.0`; every change is recorded here.

## Two layers

1. **Pure engine** — `decide(state, command, context) => { state, events }`.
   No I/O. Used internally and available for advanced users and tests.
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

`defineFlow` validates statically (unique step IDs, valid durations, valid conditions, quorum ≤ possible).
Validation errors are `FlowDefinitionError` with a list of issues.

## Commands

Every command accepts an optional `idempotencyKey` and `expectedVersion`.

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
task.assigned       task.decided       task.delegated     task.reminder      task.expired
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
| `RequestNotFoundError` | `REQUEST_NOT_FOUND` | Unknown request |
| `NotAssignedError` | `NOT_ASSIGNED` | Actor has no pending task on this request |
| `InvalidTransitionError` | `INVALID_TRANSITION` | e.g. approving a closed request |
| `ConflictError` | `VERSION_CONFLICT` | `expectedVersion` mismatch or concurrent write |
| `ResolutionError` | `RESOLUTION_FAILED` | Resolver threw, or a step is empty with `onEmptyStep: "fail"` |

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
