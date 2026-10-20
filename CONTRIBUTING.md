# Contributing to Rungs

Thanks for your interest! Rungs is pre-release and maintained on limited time, so small, focused
issues and pull requests are the easiest to review.

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md); report problems to
info@sodastech.com.

## Before you start

- **Bugs and edge cases:** open an issue first. A failing case described as "given this flow and
  these commands, I expected X but got Y" is the most useful report there is.
- **Features:** open a feature request to discuss it before writing code. Check
  [docs/02-free-vs-pro.md](docs/02-free-vs-pro.md): org-aware resolution and UI are planned as Pro
  features and are not accepted into the MIT packages.
- **Only contribute code you wrote yourself** and have the right to contribute under the MIT license.
  Do not copy code, schemas or documents from proprietary systems.

## Setup

Requires Node.js 22+ and pnpm (enabled through Corepack).

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

Before opening a pull request, run everything CI runs:

```bash
pnpm lint            # Biome; `pnpm format` fixes most issues
pnpm check:ec        # every Core edge case has a test named after its ID
pnpm check:readme    # the README quick start is the code that is tested
pnpm build && pnpm typecheck && pnpm test
```

## How we work

- **Tests first.** Edge cases are the spec: every entry in
  [docs/05-edge-cases.md](docs/05-edge-cases.md) has an ID, and its test name starts with that ID
  (`it("EC-01 ...")`). A new behavior gets a new ID and a test; a changed behavior updates both.
- **The core stays pure.** `@rungsjs/core` has no runtime dependencies and no I/O: no database,
  network, `Date.now()` or `Math.random()`. Time, IDs and approver lookups are injected.
- **Fail closed.** When in doubt, a request must stop and ask for a human, never slip through an
  approval step.
- **Public API changes are deliberate.** Anything exported from a package entry point is public.
  Update [docs/04-api-design.md](docs/04-api-design.md) and add a changeset (`pnpm changeset`).
- **Store adapters** run the shared suites in `packages/store-contract` (`storeContract` and
  `serviceSuite`) from their own tests.
- **Property tests** run with a fixed seed in CI and with random seeds every day. A failure from a
  random seed first becomes a deterministic regression test, then gets fixed.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(core): ...`, `fix(core): ...`, `docs: ...`).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
