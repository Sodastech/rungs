---
"@rungsjs/store-postgres": minor
---

Initial release.

`postgresStore()`, a store for PostgreSQL 15 or newer with no runtime dependencies.

- Bring your own driver: `fromPg` (node-postgres), `fromPostgresJs` (postgres.js) and
  `fromPglite` (PGlite).
- `migrate()` creates or upgrades the tables and is safe to run from several processes;
  `migrationSql()` returns the same migrations as SQL for your own migration tool. Schema and
  table prefix are configurable.
- Request state in JSONB with indexed columns for due requests, the inbox, request lists, blocked
  steps and the outbox. Row locks, compare-and-set on the request version, and `SKIP LOCKED`
  leases so several workers can run `tick` and event delivery.
- An append-only audit table.
- Data retention: `purgeRequest`, `purgeRequests` (with an explicit `tenantId` or
  `allTenants: true`), `purgeIdempotency` and `purgeDispatchedEvents`.
