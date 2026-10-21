## What and why

<!-- What does this change, and which issue or edge case does it address? -->

## Checklist

- [ ] **Tests first.** Behavior changes have tests; edge-case tests are named after their ID
      (`it("EC-xx ...")`), and new or changed cases are updated in `docs/05-edge-cases.md`.
- [ ] **Changeset.** `pnpm changeset` was run if a published package changes, and
      `docs/04-api-design.md` is updated for any change to the public API.
- [ ] **Docs site.** Pages in `site/src/content/docs` that describe a changed behavior or API are
      updated, and new code samples are snippets in `examples/docs-snippets` (tested), not
      pasted code.
- [ ] **Clean-room.** I wrote this code myself; nothing is copied, ported or reconstructed from
      any proprietary or third-party system.
- [ ] **The core stays pure.** No runtime dependencies, I/O, `Date.now()` or `Math.random()` in
      `@rungsjs/core`.
- [ ] `pnpm lint`, `pnpm check:ec`, `pnpm check:readme`, `pnpm build`, `pnpm typecheck` and
      `pnpm test` pass.
