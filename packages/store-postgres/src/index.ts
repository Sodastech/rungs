/**
 * A store for PostgreSQL 15+, with migrations and data retention functions.
 *
 * @packageDocumentation
 * @module @rungsjs/store-postgres
 */

// Public entry point: everything exported here is public API.

export {
  fromPg,
  fromPglite,
  fromPostgresJs,
  type PgClient,
  type PgliteLike,
  type PgPoolLike,
  type PgQueryable,
  type PostgresJsLike,
  type PostgresJsQueryLike,
} from "./client.js";
export { migrate, migrationSql, SCHEMA_VERSION } from "./migrations.js";
export type { NamingOptions } from "./naming.js";
export {
  type PurgeRequestsOptions,
  type PurgeResult,
  purgeDispatchedEvents,
  purgeIdempotency,
  purgeRequest,
  purgeRequests,
} from "./purge.js";
export { type PostgresStoreOptions, postgresStore } from "./store.js";
