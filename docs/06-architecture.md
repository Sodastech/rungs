# 06 — Architecture

## Repository layout

```
rungs/
├── CLAUDE.md
├── README.md
├── ROADMAP.md
├── docs/
├── packages/
│   ├── core/              # @rungsjs/core — MIT, zero runtime dependencies
│   │   ├── src/
│   │   │   ├── model/        # types: flows, requests, tasks, events, errors
│   │   │   ├── flow/         # defineFlow, validation, conditions, durations
│   │   │   ├── engine/       # pure decide(state, command, ctx)
│   │   │   ├── resolution/   # approver resolution pipeline
│   │   │   ├── service/      # createRungs: store + resolvers + clock + events
│   │   │   ├── index.ts      # @rungsjs/core: the application API
│   │   │   ├── store.ts      # @rungsjs/core/store: for store adapter authors
│   │   │   └── engine.ts     # @rungsjs/core/engine: the pure engine
│   │   └── test/
│   │       ├── edge-cases/   # one file per catalog section, tests named EC-xx
│   │       └── helpers/      # fake clock, fake ids, fixture builders
│   ├── store-memory/      # @rungsjs/store-memory — MIT
│   ├── store-contract/    # private: shared suites every store adapter runs
│   ├── store-postgres/    # @rungsjs/store-postgres — MIT, PostgreSQL 15+, bring your own driver
│   ├── pro-org/           # @rungsjs/org — commercial (Phase 4, private repo)
│   └── pro-react/         # @rungsjs/react — commercial (Phase 5, private repo)
├── examples/
│   ├── expense-basic/     # private: the Phase 1 gate, three steps on the memory store
│   ├── playground/        # private: scenario files played as a readable timeline (pnpm playground)
│   ├── nextjs-expense/    # private: Next.js demo app on PGlite or PostgreSQL (pnpm demo)
│   └── docs-snippets/     # private: every code sample of the site and README, run by its tests
├── site/                  # private: the documentation site (Astro Starlight, GitHub Pages)
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
//   | { kind: "unchanged" }   // a tick with nothing due
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

**Resolution inside the transaction (0.x).** Steps 1 to 4 run in one store transaction, so host
callbacks run while the request is locked. That is the simplest correct choice, but a slow callback
holds the lock. The public surface (`createRungs`, `RungsStore`) deliberately does not lock this in:
nothing in it exposes when resolution happens relative to the transaction. A later version can
resolve outside the transaction (read without a lock, decide, resolve) and then, inside a short
transaction, re-read the request, decide again with the collected resolutions and save with the
compare-and-set on `version`, resolving again only if the engine asks for something new. Because
`decide` is pure and `saveRequest` already takes `expectedVersion`, this needs no breaking change.

## Resolution pipeline (per step activation)

```
ApproverSpec
  → raw user IDs           (users / role callback / named resolver / union)   ┐ async, service:
  → active check           (isActiveUser)                                     ┘ resolution/collect
  → merge duplicates       (EC-44)                                            ┐
  → remove inactive users  (EC-06)                                            │
  → remove requester       (EC-01, unless allowSelfApproval)                  │ pure, engine:
  → too few for the mode?  → submit: NoApproversError (EC-43, EC-45)          │ resolution/pipeline
                           → mid-flow: blocked, or skipped by onEmptyStep     │
  → dedupe                 (EC-03; carried-over votes are not delegated)      │
  → apply delegation rules (EC-20..EC-24, EC-48, EC-49; never merges votes)   ┘ resolution/delegation
```

The async part turns a need into `{ userIds, inactiveUserIds? }`; a host callback that throws becomes
`ResolutionError` with the original error as `cause` (EC-05). Each pure stage records why a person
was removed (`removed` on the step and in its audit event), so the UI and audit can explain why a
person is (or is not) an approver.
Pro's `@rungsjs/org` plugs in as named resolvers plus an extra stage for vacancy and acting holders.

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
- Edge-case suites mirror `docs/05-edge-cases.md` one-to-one. `pnpm check:ec`
  (`scripts/check-ec-coverage.mjs`, also in CI) fails when an edge case marked Core has no test whose
  name starts with its ID, or when a test names an ID that is not in the catalog.
- Store adapters run the shared suites of the private `packages/store-contract`:
  `storeContract(name, makeStore)` (transactions, compare-and-set, outbox order and backoff,
  idempotency and flow scopes, inbox, delegation rules) and `serviceSuite(name, makeStore)` (every
  `createRungs` behavior, through the public API only). `store-memory` and `store-postgres` run both.
  `store-postgres` runs them on PGlite (in-process PostgreSQL, no server needed) everywhere, and in
  CI also on real PostgreSQL 15 to 18 with node-postgres and postgres.js, plus concurrency tests
  (row locks, `SKIP LOCKED` leases, parallel ticks) that need several connections.
- Property-based tests (fast-check) play random flows and command sequences against the engine and
  check after every command: version and audit `seq` move by one command without gaps; a closed or
  returned request has no pending tasks; at most one step is open; every task belongs to an
  activated step; nobody holds two votes in one step instance; the requester never holds a task
  unless `allowSelfApproval`; carried-over votes never approve a step on their own while someone
  else could decide (four-eyes); refusals are always a `RungsError`; inputs are never changed; the
  same input always gives the same output. CI runs them with a fixed seed; the scheduled
  workflow `property-random.yml` runs them daily with a random seed and many more runs.
- `examples/expense-basic` runs a three-step expense approval end to end on the memory store
  (preview, delegation, return and resubmit, reminders, inbox, history): the Phase 1 gate.
- Documentation is tested too. Every code sample of the site and the README quick start is a region
  of a file in `examples/docs-snippets`, whose tests run it and check what its comments claim
  (`pnpm check:readme` compares the README). The site renders the edge case catalog from
  `docs/05-edge-cases.md` and the errors table and store interface from `docs/04-api-design.md`,
  generates the API reference from the types, and fails its build on a broken internal link.

## Non-goals (for now)

- BPMN import/export, arbitrary graph flows with loops, sub-processes.
- Running as a separate server or hosted service.
- Sending emails or notifications directly.
