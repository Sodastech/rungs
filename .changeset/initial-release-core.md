---
"@rungsjs/core": minor
---

Initial release.

An approval workflow engine for TypeScript: pure, deterministic and without runtime dependencies.

- **Flows.** `defineFlow` with static validation and fail-closed defaults. Sequential steps,
  parallel steps (`any`, `all`, `{ quorum }`), conditional steps with a JSON condition language,
  and versioned flows per tenant with a global fallback.
- **Approvers.** Users, roles and named resolvers supplied by the application. The requester and
  inactive users are removed, duplicates are merged, and earlier approvals carry over without
  closing a step on their own (four eyes). A step with nobody left to approve is refused at
  submit, or blocked mid-flow for an admin to `reassign`, `retry` or `override`.
- **Delegation.** Out-of-office rules with chains, cycle detection and a depth limit, plus
  `delegate`, `reassign` and handing a task back. Delegation never gives anyone two votes in a
  step, and the approver a task acts for can still decide it directly.
- **Time.** Deadlines, reminders, `remind`, `auto-approve`, `auto-reject` and `escalate`
  timeouts, resubmit deadlines and business-day calendars, driven by `tick`.
- **Lifecycle.** `return` to the requester or an earlier step, `resubmit` with a return policy,
  `withdraw` and `override`.
- **Service.** `createRungs` with optimistic concurrency (`expectedVersion`), tenant-scoped
  idempotency keys, an append-only audit trail, domain events delivered from an outbox, and
  queries: `get`, `history`, `inbox`, `requests`, `blocked`, `preview` and delegation rules.
- **Entry points.** `@rungsjs/core` for applications, `@rungsjs/core/store` for store adapter
  authors and `@rungsjs/core/engine` for the pure `decide` function.
- Typed errors extending `RungsError`, each with a stable `code`.

Every behavior is described in the edge case catalog (EC-01 to EC-62), and every Core case has a
test named after it: https://sodastech.github.io/rungs/edge-cases/
