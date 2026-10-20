# 02 — Free vs Pro (open-core boundary)

The free version must be genuinely useful on its own — that is what earns trust and distribution.
Pro sells the parts that take the most experience to get right and that the free alternatives leave to
the host application.

## Free — MIT (`@rungsjs/core`, `@rungsjs/store-*`)

- Flow definitions, validation, versioning, version pinning for in-flight requests
- Sequential steps; parallel steps (`any`, `all`, quorum)
- Step conditions (`when`) using a small JSON rule language
- Commands: submit, approve, reject, return, resubmit, withdraw, delegate, reassign, admin override, tick
- Approvers: explicit user IDs, roles (via host callback), and the **resolver interface** so hosts can
  plug in their own logic
- Self-approval prevention, duplicate-approver collapsing
- Out-of-office delegation rules (with chain and cycle handling)
- Deadlines, reminders, timeout actions (escalate to a configured fallback, auto-approve, auto-reject)
- Optimistic concurrency, idempotency keys
- Append-only audit trail and domain events
- In-memory and PostgreSQL stores

## Pro — commercial license (`@rungsjs/org`, `@rungsjs/react`, later the flow builder)

### `@rungsjs/org` — org-aware approver resolution
- Org graph interface the host implements once (people, positions, units, reporting lines)
- Built-in resolvers: `directManager`, `managerChain(n)`, `departmentHead({ levelsUp })`,
  `unitHeadOfType(type)`, `positionHolder(positionId)`
- Acting / interim holders with validity periods
- Vacancy handling: walk up the hierarchy to the next filled position
- Escalation that follows the org chart instead of a fixed fallback user
- Reorganization policies for in-flight requests (keep snapshot vs re-resolve future steps)
- Requester-at-the-top handling (CEO, board) and cycle detection in bad org data

### `@rungsjs/react` — UI
- Approval inbox, request timeline, decision action bar, delegation settings
- Headless hooks plus unstyled components with an optional default theme

### Included with Pro
- Claude Code skill tuned for Pro APIs
- Priority issue handling (best effort, async — no live support; this is a side project)

## Rules of thumb for deciding where a feature goes

- **Generic mechanics** that only depend on user IDs → Free.
- **Anything that needs to understand the org structure** → Pro.
- **UI** → Pro.
- If a free competitor already offers a feature, it must stay free in Rungs.

## Licensing and delivery

- Free packages: MIT, public GitHub repo, published to npm under the `@rungsjs` scope (the `@rungs`
  scope was taken).
- Pro packages: commercial license (per company, unlimited developers, includes 12 months of updates),
  source delivered through private GitHub repo access granted automatically after purchase via Polar.
- Pricing is decided at Phase 4 based on Phase 3 signals. Do not hard-code prices in the docs.
