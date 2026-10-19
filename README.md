# Rungs

**Org-aware approval workflows for TypeScript.**

Rungs moves any record through a chain of approval steps — sequential or parallel, with delegation,
deadlines, escalation, return/resubmit and a full audit trail — and gets the hard part right:
*who* should approve, resolved from your organization structure.

> Status: design phase. Nothing is published yet. See `ROADMAP.md`.

```ts
import { createRungs, defineFlow } from "@rungs/core";

const expense = defineFlow({
  key: "expense",
  steps: [
    // "directManager" comes from @rungs/org (Pro) or your own resolver
    { id: "manager", approvers: { type: "resolver", name: "directManager" } },
    {
      id: "finance",
      when: { field: "amount", op: "gt", value: 5_000_000 },
      approvers: { type: "role", role: "finance" },
      mode: "any",
      deadline: "P2D",
      onTimeout: "escalate",
      escalateTo: { type: "role", role: "finance-lead" },
    },
  ],
});
```

## Packages (planned)

| Package | License | Purpose |
| --- | --- | --- |
| `@rungs/core` | MIT | Pure approval engine: flows, steps, decisions, delegation, deadlines, audit |
| `@rungs/store-memory` | MIT | In-memory store for tests and prototypes |
| `@rungs/store-postgres` | MIT | PostgreSQL store |
| `@rungs/org` | Commercial (Pro) | Org-aware approver resolvers and org edge cases |
| `@rungs/react` | Commercial (Pro) | Approval inbox, timeline and action components |

## Docs

- `docs/01-vision.md` — what and why
- `docs/02-free-vs-pro.md` — open-core boundary
- `docs/03-domain-model.md` — data model
- `docs/04-api-design.md` — public API
- `docs/05-edge-cases.md` — edge case catalog
- `docs/06-architecture.md` — packages and internals
