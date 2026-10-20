<p align="center">
  <img src="assets/brand/rungs-icon-rounded.svg" alt="Rungs logo" width="96" height="96">
</p>

# Rungs

**Rungs is an approval workflow engine for TypeScript that gets the hard part right: who approves,
and what happens when reality gets in the way.**

> **Status: pre-release.** Nothing is published to npm yet and the API can still change.
> Feedback is very welcome: open an issue, or tell us which edge case your app gets wrong today.

## The problem

Moving a record through "manager, then finance, then director" looks easy until real life shows up.
The requester is also an approver. The manager is on leave and delegated to someone who already
approved an earlier step. A step resolves to nobody because a position is vacant. A parallel step
needs two approvals but delegation would hand both votes to the same person. Most libraries leave
these cases to your application, which then approves things it should not.

Rungs is a small, deterministic engine that handles them by default and records why in an
append-only audit trail. Its defaults fail closed: nothing silently skips an approval.

## Quick start

Requires Node.js 22+ (ESM).

```ts
import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const managers: Record<string, string> = { u_alice: "u_bob" };

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
  roles: async (role) => (role === "finance" ? ["u_fin1", "u_fin2"] : []),
  resolvers: {
    directManager: async ({ request }) => {
      const manager = managers[request.requesterId];
      return manager ? [manager] : [];
    },
  },
});

await rungs.flows.register({
  key: "expense",
  steps: [
    { id: "manager", approvers: { type: "resolver", name: "directManager" } },
    {
      id: "finance",
      approvers: { type: "role", role: "finance" }, // either finance user may decide
      when: { field: "amount", op: "gt", value: 1000 },
      deadline: "P2D",
    },
  ],
});

const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_alice",
  subject: { type: "expense", id: "EXP-1042" },
  payload: { amount: 2500 },
});

await rungs.approve({ requestId: request.id, actorId: "u_bob", comment: "Looks fine" });
const done = await rungs.approve({ requestId: request.id, actorId: "u_fin2" });

console.log(done.status); // "approved"
```

This exact example runs in CI (`examples/expense-basic/test/readme.test.ts`). For a fuller tour
with delegation, return and resubmit, reminders, the inbox and the audit history, see
[`examples/expense-basic`](examples/expense-basic).

Beyond this: parallel steps (`any`, `all`, quorum), conditions, out-of-office delegation, deadlines
with reminders, escalation and timeouts driven by `tick`, return and resubmit, admin override,
previews of the approval chain, optimistic concurrency, idempotency keys, and an outbox for
notifications.

## Edge cases it handles

Every case has an ID in the [catalog](docs/05-edge-cases.md) and a test named after it.

- **EC-01: the requester is one of the approvers.** They are removed from that step, with the
  reason recorded.
- **EC-47: the same person approves two levels.** Their earlier approval counts as one vote, but
  someone else must still decide. Four eyes stay four eyes.
- **EC-48: delegation would give one person two votes.** That delegation is skipped; votes are
  never merged.
- **EC-22: delegation cycles (A→B→A).** Detected; the task stays with the original approver and a
  warning is recorded.
- **EC-43: a later step would have no approvers.** The submit is refused up front, so an approver
  is never stuck mid-flow.
- **EC-42: a step becomes empty mid-flow anyway** (someone left). The step is blocked, an admin is
  alerted, and reassign, retry or override resolve it.
- **EC-59: auto-approve on timeout after someone rejected.** Not applied: the step stays open and
  keeps reminding.

## Packages

| Package | License | Status |
| --- | --- | --- |
| `@rungsjs/core` | MIT | Engine and service: flows, decisions, delegation, deadlines, audit, queries |
| `@rungsjs/store-memory` | MIT | In-memory store for tests and prototypes |
| `@rungsjs/store-postgres` | MIT | Planned (Phase 2) |
| `@rungsjs/org` | Commercial (Pro) | Planned: org-aware resolvers (manager chains, vacancies, acting holders) |
| `@rungsjs/react` | Commercial (Pro) | Planned: inbox, timeline and action components |

The core is pure: no I/O, no clock, no randomness. Time, IDs and approver lookups are injected, so
the same input always gives the same result.

## Docs

- [Vision](docs/01-vision.md): what Rungs is and why
- [Free vs Pro](docs/02-free-vs-pro.md): the open-core boundary
- [Domain model](docs/03-domain-model.md): flows, requests, steps, tasks, audit events
- [API design](docs/04-api-design.md): `createRungs`, commands, queries, store interface
- [Edge cases](docs/05-edge-cases.md): the catalog, the heart of the project
- [Architecture](docs/06-architecture.md): packages and internals
- [Roadmap](ROADMAP.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The free packages are [MIT](LICENSE) licensed. Pro packages will be offered under a commercial
license.
