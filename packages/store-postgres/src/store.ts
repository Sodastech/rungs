import {
  type BlockedStepView,
  blockedStepView,
  ConfigurationError,
  ConflictError,
  type DelegationRule,
  type IdempotentRecord,
  type OutboxEntry,
  type RegisteredFlow,
  type RequestState,
  type RungsStore,
  requestSummary,
  type StoreTx,
  type TaskView,
  taskViews,
} from "@rungsjs/core";
import type { PgClient, PgQueryable } from "./client.js";
import { SCHEMA_VERSION } from "./migrations.js";
import { iso, type Names, type NamingOptions, names, tenant } from "./naming.js";

export interface PostgresStoreOptions extends NamingOptions {
  /** How long `tick` and event delivery hold what they claim. Default 60 seconds. */
  readonly leaseSeconds?: number;
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * A `RungsStore` on PostgreSQL 15+. Run `migrate()` first; the store refuses an older schema.
 * Request state is stored as JSONB; the columns and tables that `findDue`, `findInbox`,
 * `findRequests`, `findBlocked` and `pendingEvents` need are written in the same transaction.
 */
export function postgresStore(client: PgClient, options: PostgresStoreOptions = {}): RungsStore {
  const n = names(options);
  const leaseMs = (options.leaseSeconds ?? 60) * 1000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new ConfigurationError("leaseSeconds must be a positive number");
  }
  let ready: Promise<void> | undefined;

  const checkSchema = async () => {
    let version = 0;
    try {
      const result = await client.query<{ version: number | null }>(
        `SELECT max(version) AS version FROM ${n.table.schema_migrations}`,
      );
      version = Number(result.rows[0]?.version ?? 0);
    } catch {
      version = 0;
    }
    if (version < SCHEMA_VERSION) {
      throw new ConfigurationError(
        `The Rungs tables in schema "${n.schema}" (prefix "${n.prefix}") are at version ${version}, this release needs ${SCHEMA_VERSION}. Run migrate() from @rungsjs/store-postgres first.`,
      );
    }
  };

  return {
    async transaction(fn) {
      ready ??= checkSchema().catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
      await ready;
      return client.transaction((q) => fn(transactionOn(q, n, leaseMs)));
    },
  };
}

function transactionOn(q: PgQueryable, n: Names, leaseMs: number): StoreTx {
  const t = n.table;
  const leaseUntil = (now: string) => new Date(Date.parse(now) + leaseMs).toISOString();

  return {
    async getFlow(ref) {
      const params: unknown[] = [tenant(ref.tenantId), ref.key];
      if (ref.version !== undefined) params.push(ref.version);
      const result = await q.query<{ flow: RegisteredFlow }>(
        `SELECT flow FROM ${t.flows} WHERE tenant = $1 AND key = $2${ref.version === undefined ? "" : " AND version = $3"} ORDER BY version DESC LIMIT 1`,
        params,
      );
      return result.rows[0]?.flow ?? null;
    },

    async saveFlow(flow) {
      await q.query(
        `INSERT INTO ${t.flows} (tenant, key, version, flow) VALUES ($1, $2, $3, $4::text::jsonb)`,
        [tenant(flow.tenantId), flow.key, flow.version, json(flow)],
      );
    },

    async getRequest(id, opts) {
      const result = await q.query<{ state: RequestState }>(
        `SELECT state FROM ${t.requests} WHERE id = $1${opts?.forUpdate ? " FOR UPDATE" : ""}`,
        [id],
      );
      return result.rows[0]?.state ?? null;
    },

    async saveRequest(state, expectedVersion) {
      const columns = [
        state.id,
        tenant(state.tenantId),
        state.status,
        state.version,
        state.closedAt ?? null,
        state.nextDueAt,
        json(state),
        state.requesterId,
        state.subject.type,
        state.subject.id,
        state.flowKey,
        state.submittedAt,
        blockedStepView(state)?.blockedAt ?? null,
      ];
      const result =
        expectedVersion === null
          ? await q.query(
              `INSERT INTO ${t.requests} (id, tenant, status, version, closed_at, next_due_at, state,
                 requester_id, subject_type, subject_id, flow_key, submitted_at, blocked_at)
               VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::text::jsonb,
                 $8, $9, $10, $11, $12::timestamptz, $13::timestamptz)
               ON CONFLICT (id) DO NOTHING`,
              columns,
            )
          : await q.query(
              `UPDATE ${t.requests}
               SET tenant = $2, status = $3, version = $4, closed_at = $5::timestamptz,
                   next_due_at = $6::timestamptz, claimed_until = NULL, state = $7::text::jsonb,
                   requester_id = $8, subject_type = $9, subject_id = $10, flow_key = $11,
                   submitted_at = $12::timestamptz, blocked_at = $13::timestamptz
               WHERE id = $1 AND version = $14`,
              [...columns, expectedVersion],
            );
      if (result.rowCount !== 1) {
        const actual = await q.query<{ version: number }>(
          `SELECT version FROM ${t.requests} WHERE id = $1`,
          [state.id],
        );
        const version = actual.rows[0]?.version;
        throw new ConflictError({
          requestId: state.id,
          expectedVersion,
          actualVersion: version === undefined ? null : Number(version),
        });
      }
      await q.query(`DELETE FROM ${t.inbox} WHERE request_id = $1`, [state.id]);
      for (const view of taskViews(state)) {
        await q.query(
          `INSERT INTO ${t.inbox} (task_id, request_id, tenant, assignee_id, on_behalf_of, assigned_at, view)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::text::jsonb)`,
          [
            view.taskId,
            state.id,
            tenant(state.tenantId),
            view.assigneeId,
            view.onBehalfOf ?? null,
            view.assignedAt,
            json(view),
          ],
        );
      }
    },

    async appendAudit(events) {
      for (const event of events) {
        await q.query(
          `INSERT INTO ${t.audit} (request_id, seq, tenant, type, at, event)
           VALUES ($1, $2, coalesce((SELECT tenant FROM ${t.requests} WHERE id = $1), ''), $3,
                   $4::timestamptz, $5::text::jsonb)`,
          [event.requestId, event.seq, event.type, event.at, json(event)],
        );
      }
    },

    async findDue(now, limit, options) {
      if (!options?.claim) {
        const result = await q.query<{ id: string }>(
          `SELECT id FROM ${t.requests} WHERE next_due_at <= $1::timestamptz
           ORDER BY next_due_at, id LIMIT $2`,
          [now, limit],
        );
        return result.rows.map((r) => r.id);
      }
      // Claim with a short lease; workers running at the same moment skip each other's rows.
      const result = await q.query<{ id: string; next_due_at: unknown }>(
        `WITH due AS (
           SELECT id FROM ${t.requests}
           WHERE next_due_at <= $1::timestamptz
             AND (claimed_until IS NULL OR claimed_until <= $1::timestamptz)
           ORDER BY next_due_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE ${t.requests} r SET claimed_until = $3::timestamptz
         FROM due WHERE r.id = due.id
         RETURNING r.id, r.next_due_at`,
        [now, limit, leaseUntil(now)],
      );
      return result.rows
        .map((r) => ({ id: r.id, at: Date.parse(iso(r.next_due_at)) }))
        .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
        .map((r) => r.id);
    },

    async enqueueEvents(events, now) {
      for (const event of events) {
        await q.query(
          `INSERT INTO ${t.outbox} (request_id, seq, event, next_attempt_at)
           VALUES ($1, $2, $3::text::jsonb, $4::timestamptz)`,
          [event.requestId, event.seq, json(event), now],
        );
      }
    },

    async pendingEvents({ now, limit, requestId, claim }) {
      // The oldest undelivered event of each request, when it is due: the head of its chain.
      const params: unknown[] = [now, limit];
      if (requestId !== undefined) params.push(requestId);
      const heads = await q.query<{ request_id: string }>(
        `SELECT o.request_id FROM ${t.outbox} o
         WHERE o.dispatched_at IS NULL
           ${requestId === undefined ? "" : "AND o.request_id = $3"}
           AND NOT EXISTS (
             SELECT 1 FROM ${t.outbox} p
             WHERE p.request_id = o.request_id AND p.dispatched_at IS NULL AND p.seq < o.seq
           )
           AND o.next_attempt_at <= $1::timestamptz
           ${claim ? "AND (o.claimed_until IS NULL OR o.claimed_until <= $1::timestamptz)" : ""}
         ORDER BY o.next_attempt_at, o.request_id
         LIMIT $2
         ${claim ? "FOR UPDATE OF o SKIP LOCKED" : ""}`,
        params,
      );
      const ids = heads.rows.map((r) => r.request_id);
      if (ids.length === 0) return [];

      const rows = await q.query<{
        request_id: string;
        seq: number;
        event: OutboxEntry["event"];
        attempts: number;
        next_attempt_at: unknown;
        last_error: string | null;
        claimed_until: unknown;
      }>(
        `SELECT request_id, seq, event, attempts, next_attempt_at, last_error, claimed_until
         FROM ${t.outbox} WHERE request_id = ANY($1::text[]) AND dispatched_at IS NULL
         ORDER BY request_id, seq`,
        [ids],
      );
      const nowMs = Date.parse(now);
      const entries: OutboxEntry[] = [];
      for (const id of ids) {
        for (const row of rows.rows.filter((r) => r.request_id === id)) {
          const due = Date.parse(iso(row.next_attempt_at)) <= nowMs;
          const free = row.claimed_until === null || Date.parse(iso(row.claimed_until)) <= nowMs;
          if (!due || (claim && !free)) break;
          entries.push({
            event: row.event,
            attempts: Number(row.attempts),
            nextAttemptAt: iso(row.next_attempt_at),
            ...(row.last_error === null ? {} : { lastError: row.last_error }),
          });
        }
      }
      const result = entries.slice(0, limit);
      if (claim && result.length > 0) {
        await q.query(
          `UPDATE ${t.outbox} SET claimed_until = $3::timestamptz
           FROM unnest($1::text[], $2::int[]) AS k(request_id, seq)
           WHERE ${t.outbox}.request_id = k.request_id AND ${t.outbox}.seq = k.seq`,
          [result.map((e) => e.event.requestId), result.map((e) => e.event.seq), leaseUntil(now)],
        );
      }
      return result;
    },

    async markDispatched(keys, now) {
      if (keys.length === 0) return;
      await q.query(
        `UPDATE ${t.outbox} SET dispatched_at = coalesce($3::timestamptz, now()), claimed_until = NULL
         FROM unnest($1::text[], $2::int[]) AS k(request_id, seq)
         WHERE ${t.outbox}.request_id = k.request_id AND ${t.outbox}.seq = k.seq`,
        [keys.map((k) => k.requestId), keys.map((k) => k.seq), now ?? null],
      );
    },

    async markFailed(key, failure) {
      await q.query(
        `UPDATE ${t.outbox}
         SET attempts = $3, next_attempt_at = $4::timestamptz, last_error = $5, claimed_until = NULL
         WHERE request_id = $1 AND seq = $2`,
        [key.requestId, key.seq, failure.attempts, failure.nextAttemptAt, failure.error],
      );
    },

    async getIdempotent(ref) {
      const result = await q.query<{ record: IdempotentRecord }>(
        `SELECT record FROM ${t.idempotency} WHERE tenant = $1 AND key = $2`,
        [tenant(ref.tenantId), ref.key],
      );
      return result.rows[0]?.record ?? null;
    },

    async putIdempotent(ref, record) {
      await q.query(
        `INSERT INTO ${t.idempotency} (tenant, key, request_id, at, record)
         VALUES ($1, $2, $3, $4::timestamptz, $5::text::jsonb)`,
        [tenant(ref.tenantId), ref.key, record.result.id, record.at, json(record)],
      );
    },

    async getAudit(requestId) {
      const result = await q.query<{ event: Awaited<ReturnType<StoreTx["getAudit"]>>[number] }>(
        `SELECT event FROM ${t.audit} WHERE request_id = $1 ORDER BY seq`,
        [requestId],
      );
      return result.rows.map((r) => r.event);
    },

    async findRequests({ tenantId, requesterId, statuses, subject, flowKey, limit, after }) {
      const params: unknown[] = [tenant(tenantId)];
      const where = ["tenant = $1"];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (requesterId !== undefined) add("requester_id = ?", requesterId);
      if (statuses !== undefined) add("status = ANY(?::text[])", [...statuses]);
      if (subject !== undefined) add("subject_type = ?", subject.type);
      if (subject?.id !== undefined) add("subject_id = ?", subject.id);
      if (flowKey !== undefined) add("flow_key = ?", flowKey);
      if (after !== undefined) {
        params.push(after.submittedAt, after.id);
        where.push(`(submitted_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
      }
      params.push(limit);
      const result = await q.query<{ state: RequestState }>(
        `SELECT state FROM ${t.requests}
         WHERE ${where.join(" AND ")}
         ORDER BY submitted_at DESC, id DESC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((r) => requestSummary(r.state));
    },

    async findBlocked({ tenantId, limit, after }) {
      const params: unknown[] = [tenant(tenantId), limit];
      if (after) params.push(after.blockedAt, after.requestId);
      const result = await q.query<{ state: RequestState }>(
        `SELECT state FROM ${t.requests}
         WHERE tenant = $1 AND blocked_at IS NOT NULL
           ${after ? "AND (blocked_at, id) > ($3::timestamptz, $4)" : ""}
         ORDER BY blocked_at, id
         LIMIT $2`,
        params,
      );
      return result.rows
        .map((r) => blockedStepView(r.state))
        .filter((view): view is BlockedStepView => view !== null);
    },

    async findInbox({ userId, tenantId, limit, after }) {
      const params: unknown[] = [tenant(tenantId), userId, limit];
      if (after) params.push(after.assignedAt, after.taskId);
      const result = await q.query<{ view: TaskView }>(
        `SELECT view FROM ${t.inbox}
         WHERE tenant = $1 AND (assignee_id = $2 OR on_behalf_of = $2)
           ${after ? "AND (assigned_at, task_id) > ($4::timestamptz, $5)" : ""}
         ORDER BY assigned_at, task_id
         LIMIT $3`,
        params,
      );
      return result.rows.map((r) => r.view);
    },

    async findDelegations(fromUserIds, tenantId) {
      if (fromUserIds.length === 0) return [];
      const result = await q.query<{ rule: DelegationRule }>(
        `SELECT rule FROM ${t.delegations}
         WHERE from_user_id = ANY($1::text[]) AND (tenant = '' OR tenant = $2)
         ORDER BY id`,
        [[...fromUserIds], tenant(tenantId)],
      );
      return result.rows.map((r) => r.rule);
    },

    async saveDelegation(rule) {
      await q.query(
        `INSERT INTO ${t.delegations} (id, tenant, from_user_id, to_user_id, rule)
         VALUES ($1, $2, $3, $4, $5::text::jsonb)
         ON CONFLICT (id) DO UPDATE SET tenant = EXCLUDED.tenant, from_user_id = EXCLUDED.from_user_id,
           to_user_id = EXCLUDED.to_user_id, rule = EXCLUDED.rule`,
        [rule.id, tenant(rule.tenantId), rule.fromUserId, rule.toUserId, json(rule)],
      );
    },

    async getDelegation(id) {
      const result = await q.query<{ rule: DelegationRule }>(
        `SELECT rule FROM ${t.delegations} WHERE id = $1`,
        [id],
      );
      return result.rows[0]?.rule ?? null;
    },

    async listDelegations({ userId, tenantId }) {
      const result = await q.query<{ rule: DelegationRule }>(
        `SELECT rule FROM ${t.delegations}
         WHERE (from_user_id = $1 OR to_user_id = $1) AND (tenant = '' OR tenant = $2)
         ORDER BY id`,
        [userId, tenant(tenantId)],
      );
      return result.rows.map((r) => r.rule);
    },
  };
}
