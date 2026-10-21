import { InvalidCommandError, InvalidTransitionError } from "@rungsjs/core";
import type { PgClient, PgQueryable } from "./client.js";
import { type Names, type NamingOptions, names, tenant } from "./naming.js";

/** Statuses after which a request never changes again; only these can be purged (EC-61). */
const CLOSED = ["approved", "rejected", "withdrawn"];

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Which requests `purgeRequests` may delete. The tenant scope must be chosen explicitly. */
export type PurgeRequestsOptions = {
  readonly closedBefore: string;
  readonly limit?: number;
} & (
  | { readonly tenantId: string; readonly allTenants?: never }
  | { readonly allTenants: true; readonly tenantId?: never }
);

export interface PurgeResult {
  readonly requests: number;
  readonly auditEvents: number;
  readonly outboxEvents: number;
  readonly idempotencyKeys: number;
}

function checkTime(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new InvalidCommandError(`${name} must be an ISO 8601 UTC timestamp`);
  }
  return value;
}

/** Deletes the given closed requests with everything that belongs to them, in the caller's tx. */
async function purgeIds(tx: PgQueryable, n: Names, ids: string[]): Promise<PurgeResult> {
  if (ids.length === 0) return { requests: 0, auditEvents: 0, outboxEvents: 0, idempotencyKeys: 0 };
  const t = n.table;
  // The audit trigger allows DELETE only while this transaction-local setting is on.
  await tx.query("SELECT set_config('rungs.purge', 'on', true)");
  const deleted = async (table: string, column: string) =>
    (await tx.query(`DELETE FROM ${table} WHERE ${column} = ANY($1::text[])`, [ids])).rowCount;
  const idempotencyKeys = await deleted(t.idempotency, "request_id");
  const auditEvents = await deleted(t.audit, "request_id");
  const outboxEvents = await deleted(t.outbox, "request_id");
  await deleted(t.inbox, "request_id");
  const requests = await deleted(t.requests, "id");
  await tx.query("SELECT set_config('rungs.purge', 'off', true)");
  return { requests, auditEvents, outboxEvents, idempotencyKeys };
}

/**
 * EC-61: deletes one closed request with its audit trail, outbox events, inbox rows and
 * idempotency records, in one transaction. A pending or returned request is refused with
 * `InvalidTransitionError`. An unknown id deletes nothing. Retention is the host's policy:
 * log the result in your own records.
 */
export async function purgeRequest(
  client: PgClient,
  requestId: string,
  options: NamingOptions = {},
): Promise<PurgeResult> {
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new InvalidCommandError("requestId must be a non-empty string");
  }
  const n = names(options);
  return client.transaction(async (tx) => {
    const found = await tx.query<{ status: string }>(
      `SELECT status FROM ${n.table.requests} WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const status = found.rows[0]?.status;
    if (status === undefined) return purgeIds(tx, n, []);
    if (!CLOSED.includes(status)) {
      throw new InvalidTransitionError({ requestId, status, command: "purge" });
    }
    return purgeIds(tx, n, [requestId]);
  });
}

/**
 * EC-61: deletes closed requests whose `closedAt` is before `closedBefore`, with everything that
 * belongs to them, in one transaction; at most `limit` (default 1000) per call, so run it until
 * `requests` is below the limit. The scope is always explicit: one `tenantId`, or
 * `allTenants: true`; neither or both is an `InvalidCommandError`.
 */
export async function purgeRequests(
  client: PgClient,
  options: NamingOptions & PurgeRequestsOptions,
): Promise<PurgeResult> {
  const closedBefore = checkTime(options.closedBefore, "closedBefore");
  const scoped = options.tenantId !== undefined;
  const all = (options as { allTenants?: unknown }).allTenants;
  if (all !== undefined && all !== true) {
    throw new InvalidCommandError("allTenants must be true when given");
  }
  if (scoped === (all === true)) {
    throw new InvalidCommandError("purgeRequests needs either tenantId or allTenants: true");
  }
  if (scoped && typeof options.tenantId !== "string") {
    throw new InvalidCommandError("tenantId must be a string");
  }
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidCommandError("limit must be a positive integer");
  }
  const n = names(options);
  return client.transaction(async (tx) => {
    const params: unknown[] = [closedBefore, CLOSED, limit];
    if (options.tenantId !== undefined) params.push(tenant(options.tenantId));
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM ${n.table.requests}
       WHERE closed_at < $1::timestamptz AND status = ANY($2::text[])
         ${options.tenantId === undefined ? "" : "AND tenant = $4"}
       ORDER BY closed_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      params,
    );
    return purgeIds(
      tx,
      n,
      found.rows.map((r) => r.id),
    );
  });
}

/**
 * Deletes idempotency records written before `olderThan`. After that, repeating one of those
 * commands runs it again, so keep them at least as long as clients may retry.
 */
export async function purgeIdempotency(
  client: PgClient,
  options: NamingOptions & { olderThan: string; tenantId?: string },
): Promise<{ idempotencyKeys: number }> {
  const olderThan = checkTime(options.olderThan, "olderThan");
  const n = names(options);
  const params: unknown[] = [olderThan];
  if (options.tenantId !== undefined) params.push(tenant(options.tenantId));
  const result = await client.query(
    `DELETE FROM ${n.table.idempotency} WHERE at < $1::timestamptz${options.tenantId === undefined ? "" : " AND tenant = $2"}`,
    params,
  );
  return { idempotencyKeys: result.rowCount };
}

/** Deletes outbox events delivered before `olderThan`. Undelivered events are never touched. */
export async function purgeDispatchedEvents(
  client: PgClient,
  options: NamingOptions & { olderThan: string },
): Promise<{ events: number }> {
  const olderThan = checkTime(options.olderThan, "olderThan");
  const n = names(options);
  const result = await client.query(
    `DELETE FROM ${n.table.outbox} WHERE dispatched_at IS NOT NULL AND dispatched_at < $1::timestamptz`,
    [olderThan],
  );
  return { events: result.rowCount };
}
