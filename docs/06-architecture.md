# 06 — Architecture

## Repository layout

```
rungs/
├── CLAUDE.md
├── README.md
├── ROADMAP.md
├── docs/
├── packages/
│   ├── core/              # @rungs/core — MIT, zero runtime dependencies
│   │   ├── src/
│   │   │   ├── model/        # types: flows, requests, tasks, events, errors
│   │   │   ├── flow/         # defineFlow, validation, conditions, durations
│   │   │   ├── engine/       # pure decide(state, command, ctx)
│   │   │   ├── resolution/   # approver resolution pipeline
│   │   │   ├── service/      # createRungs: store + resolvers + clock + events
│   │   │   └── index.ts
│   │   └── test/
│   │       ├── edge-cases/   # one file per catalog section, tests named EC-xx
│   │       └── helpers/      # fake clock, fake ids, fixture builders
│   ├── store-memory/      # @rungs/store-memory — MIT
│   ├── store-postgres/    # @rungs/store-postgres — MIT (Phase 2)
│   ├── pro-org/           # @rungs/org — commercial (Phase 4, private repo)
│   └── pro-react/         # @rungs/react — commercial (Phase 5, private repo)
├── examples/
│   └── nextjs-expenses/   # Phase 2
└── skills/
    └── rungs/SKILL.md     # Claude Code skill (Phase 3)
```

Pro packages are developed in a separate private repository that depends on the public packages.
The public repo never contains Pro source.

## Engine design

The engine is a pure reducer:

```ts
decide(state: RequestState | null, command: Command, ctx: EngineContext): Decision
// Decision =
//   | { kind: "needs-resolution"; needs: ResolutionNeed[] }
//   | { kind: "decided"; state: RequestState; audit: AuditEvent[]; events: DomainEvent[] }
```

Approver resolution is async (it calls host code), but the engine must stay pure. The service layer
therefore runs a small loop:

1. Load request state from the store (inside a transaction, locked for update).
2. Call `decide`. If it needs approvers resolved for a step that is activating, it returns
   `kind: "needs-resolution"` with `needs` and nothing has changed yet.
3. The service resolves those approvers (roles, resolvers, delegation rules, active-user checks),
   then calls `decide` again with the resolved data in `ctx`.
4. Persist state, audit events and domain events in the same transaction (outbox).
5. After commit, dispatch domain events to `onEvent`.

This keeps all branching logic in the pure engine, testable without mocks, while I/O stays at the edges.

## Resolution pipeline (per step activation)

```
ApproverSpec
  → raw user IDs           (users / role callback / named resolver / union)
  → remove inactive users  (EC-06)
  → remove requester       (EC-01, unless allowSelfApproval)
  → apply delegation rules (EC-20..EC-23)
  → dedupe                 (EC-03)
  → empty? → onEmptyStep   (EC-02, EC-04)
```

Each stage records a reason entry so the UI and audit can explain why a person is (or is not) an approver.
Pro's `@rungs/org` plugs in as named resolvers plus an extra stage for vacancy and acting holders.

## Concurrency and idempotency

- Each request row has a `version`. Writes use compare-and-set; a mismatch throws `ConflictError`.
- The Postgres store uses `SELECT ... FOR UPDATE` inside the transaction for command handling.
- Idempotency keys are stored with the command result; repeats return the stored result.
- `tick` processes due requests in small batches, each in its own transaction, so concurrent tick
  workers cannot apply the same deadline twice (EC-27).

## Multi-tenancy

Optional `tenantId` on requests, flows and delegation rules. Stores filter by tenant on every query.
Rungs does not enforce tenant isolation beyond that; the host remains responsible for authorization.

## Testing strategy

- Unit tests on the pure engine using fixture builders and a fake clock.
- Edge-case suites mirror `docs/05-edge-cases.md` one-to-one.
- Store adapters run a shared contract test suite (same tests for memory and Postgres).
- Property-based tests (fast-check) for invariants, e.g. "a closed request never has pending tasks",
  "audit `seq` is strictly increasing", "every task belongs to an activated step".

## Non-goals (for now)

- BPMN import/export, arbitrary graph flows with loops, sub-processes.
- Running as a separate server or hosted service.
- Sending emails or notifications directly.
