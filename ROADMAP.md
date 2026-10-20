# Roadmap

Assumes a side-project pace of roughly **8–10 hours per week** with Claude Code doing most of the typing.
Durations are estimates, not commitments. Each phase ends with a gate: if the gate fails, stop and
rethink before investing in the next phase.

## Phase 0 — Repository setup (≈ 1 week)

- pnpm + Turborepo monorepo, TypeScript strict, Biome, Vitest, tsup, Changesets
- GitHub repo, CI (lint, typecheck, test on Node 22 and 24)
- Empty packages: `core`, `store-memory`
- Reserve names: the `@rungsjs` npm scope, GitHub org, domain. The `@rungs` scope was taken, and npm
  rejected the unscoped name `rungs` as too similar to the existing package `runjs`; do not try it
  again. The official install name is `@rungsjs/core`.

**Gate:** `pnpm build && pnpm test` passes in CI.

## Phase 1 — Core engine (≈ 4–6 weeks)

- Flow definitions with validation (`defineFlow`), versioning and pinning
- Sequential steps; parallel steps with `any`, `all` and quorum modes
- Conditions on steps (`when`) evaluated against the payload snapshot
- Commands: submit, approve, reject, return, resubmit, withdraw, delegate, reassign, tick
- Static approvers (`users`, `role` via host callback) and named resolver interface
- Self-approval prevention and duplicate-approver collapsing
- Deadlines and timeout actions driven by `tick(now)`
- Out-of-office delegation rules with chain and cycle handling
- Append-only audit events; domain events for notifications
- Optimistic concurrency and idempotency keys
- `store-memory` package
- Every `EC-xx` in `docs/05-edge-cases.md` marked "Core" has a passing test

**Gate:** an end-to-end example (expense approval, 3 steps) runs against the memory store.

## Phase 2 — Real persistence + example app (≈ 3–4 weeks)

- `store-postgres` with SQL migrations
- Example Next.js app: submit a request, approval inbox, timeline, approve/reject
- Documentation site (getting started, concepts, recipes, edge cases)

**Gate:** someone other than the owner can follow the docs and run the example in under 15 minutes.

## Phase 3 — Public launch of the free version (≈ 2 weeks)

- Publish `0.1.0` to npm (`@rungsjs/core`, `@rungsjs/store-memory`, `@rungsjs/store-postgres`),
  with all changesets combined into one "Initial release" note; README with a short demo GIF
- Launch posts: Show HN, r/node, r/typescript, r/nextjs, dev.to article on approval edge cases
- Free Claude Code skill that teaches agents how to add flows with Rungs

**Gate (measure for 4–8 weeks):** real usage signals — npm downloads trending up, GitHub stars,
issues or questions from real users, and at least a few requests for org-aware approvers.
If there is no pull, do not build Pro yet; fix positioning or distribution first.

## Phase 4 — Pro: org-aware resolvers (≈ 4–6 weeks)

- `@rungsjs/org`: org graph interface, `directManager`, `managerChain(n)`, `departmentHead(level)`,
  acting/interim holders, vacancy fallback, mid-flight reorganization policies, cycle detection
- All `EC-xx` marked "Pro" have passing tests
- Commercial license, private repo access delivered on purchase (Polar), launch pricing

**Gate:** first paying customers.

## Phase 5 — Pro: UI (≈ 4 weeks)

- `@rungsjs/react`: approval inbox, request timeline, action bar, delegation settings
- Headless hooks + unstyled components with a default theme

## Later (only if demand shows up)

- Visual flow builder for admins
- Drizzle and Prisma store adapters
- Business-day calendars with holiday sets
- Hosted version
