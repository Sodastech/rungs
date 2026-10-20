---
"@rungsjs/store-postgres": minor
---

Add `@rungsjs/store-postgres`, a `RungsStore` on PostgreSQL 15+ with no runtime dependencies:
adapters for node-postgres, postgres.js and PGlite; `migrate()` and `migrationSql()` with shipped
SQL files; JSONB state with indexed projections for due requests, the inbox and the outbox; row
locks, compare-and-set and `SKIP LOCKED` leases for parallel workers; an append-only audit table;
and `purgeRequest`, `purgeRequests`, `purgeIdempotency` and `purgeDispatchedEvents` for data
retention (EC-61).
