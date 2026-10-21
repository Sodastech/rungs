# CLAUDE.md — Rungs

Context and working rules for Claude Code in this repository. Read this first, then the docs it points to.

## What Rungs is

Rungs is an **org-aware approval workflow engine for TypeScript**. It lets an application send any record
(expense, leave request, purchase order, document) through a chain of approval steps — sequential or
parallel — with delegation, deadlines, escalation, return/resubmit and a full audit trail.

Its differentiator is **who approves**: approvers can be resolved from the organization structure
("direct manager", "head of department two levels up", "acting holder of a vacant position") with the
real-world edge cases handled correctly. Most existing libraries leave that to the host application.

- Product vision and positioning: `docs/01-vision.md`
- What is free (MIT) vs Pro (commercial): `docs/02-free-vs-pro.md`
- Domain model: `docs/03-domain-model.md`
- Public API design: `docs/04-api-design.md`
- Edge case catalog (the heart of the product): `docs/05-edge-cases.md`
- Architecture and package layout: `docs/06-architecture.md`
- Plan and phases: `ROADMAP.md`

## Owner and communication

- The owner is a solo developer working on Rungs as a side project with limited time.
- Talk to the owner in **Bahasa Indonesia**. Write code, comments, commit messages, docs and
  everything user-facing in **English** (the market is global developers).
- Prefer small, reviewable steps. When a decision is ambiguous and expensive to undo
  (public API shape, data model, licensing), stop and ask instead of guessing.

## Hard rules

1. **Clean-room code.** Never copy, port or reconstruct code, schemas or documents from any
   proprietary or third-party system. Everything in Rungs is written from scratch.
   General domain knowledge is fine; copied artifacts are not.
2. **The core is pure.** `@rungsjs/core` has zero runtime dependencies and no I/O: no database, no
   network, no `Date.now()`, no `Math.random()`. Time, IDs and approver lookups are injected.
3. **Every edge case has a test.** Each entry in `docs/05-edge-cases.md` has an ID (`EC-01`…).
   Its behavior is covered by a test whose name starts with that ID. When behavior changes,
   update the doc and the test in the same change. `pnpm check:ec` enforces this.
   Property tests run with a fixed seed in CI and with random seeds in a scheduled workflow.
   **Every failure from a random seed must first become a deterministic regression test**
   (the shrunk counterexample, named after the edge case it breaks), and only then be fixed.
4. **Public API changes are deliberate.** Anything exported from a package entry point is public.
   Changing it requires updating `docs/04-api-design.md`, the documentation site pages that describe
   it (`site/src/content/docs`), and adding a changeset, all in the same change. The API reference
   on the site is generated from the types; code samples live in `examples/docs-snippets` and are
   tested, so a changed API breaks the snippet tests until the docs follow. `pnpm check:api`
   fails until the API reports (`packages/*/api`) are regenerated with `pnpm api:update`, so every
   change to the public API shows up in the diff.
5. **Free/Pro boundary is respected.** Org-aware resolvers, the React UI and the flow builder live in
   Pro packages (`packages/pro-*`). Do not move Pro functionality into MIT packages without the
   owner's explicit decision. See `docs/02-free-vs-pro.md`.
6. **No secrets in the repo.** Payment, npm and platform tokens stay in environment variables or CI secrets.

## Tech stack and conventions

- TypeScript (strict), ESM only, Node.js 22+.
- pnpm workspaces monorepo; Turborepo for task running.
- Build: `tsup` (ESM + `.d.ts`). Tests: `vitest`. Lint/format: Biome.
- Releases: Changesets. Semver; `0.x` until the API is stable.
- Errors are typed classes extending `RungsError` with a stable `code` string.
- Prefer discriminated unions over boolean flags; prefer plain data over classes in the domain model.
- All timestamps are ISO 8601 UTC strings in persisted data.

## Common commands (once scaffolded)

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # run all tests
pnpm test --filter @rungsjs/core
pnpm typecheck      # tsc --noEmit in every package
pnpm lint
pnpm check:ec       # every Core edge case in docs/05 has a test named after its ID
pnpm check:readme   # the README quick start is the tested snippet
pnpm check:api      # the API reports in packages/*/api match the source
pnpm api:update     # rewrite them after a deliberate public API change
pnpm check:pack     # pack the published packages and check them (after pnpm build)
pnpm --filter @rungsjs/site dev   # the documentation site at http://localhost:4321/rungs/
pnpm changeset      # record a release note for a public change
```

## How to work on a task

1. Find the relevant doc section and edge-case IDs before writing code.
2. Write or update tests first for behavior changes (edge-case tests are the spec).
3. Keep the engine deterministic: same state + same command + same injected clock = same result.
4. Run `pnpm test` and `pnpm lint` before saying a task is done.
5. If the docs and the code disagree, the docs describe intent: flag the mismatch to the owner.
