---
"@rungsjs/core": minor
"@rungsjs/store-memory": minor
"@rungsjs/store-postgres": minor
---

Add `rungs.requests()` (requests by requester, status, subject or flow, newest first, with cursor
paging) and `rungs.blocked()` (blocked steps waiting for an admin, EC-42). Inbox entries now carry
the request `payload`. Lists match the tenant exactly (EC-62).

Store adapters implement `findRequests` and `findBlocked` and build items with the new
`requestSummary`, `blockedStepView` and `taskViews` functions. The PostgreSQL store adds migration
2 (`list_queries`): run `migrate()` before using this release; the store refuses an older schema.
