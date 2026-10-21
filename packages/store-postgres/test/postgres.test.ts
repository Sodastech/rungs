import { readFileSync } from "node:fs";
import {
  ConfigurationError,
  createRungs,
  type DomainEvent,
  type FlowInput,
  InvalidCommandError,
  InvalidTransitionError,
  type RequestState,
} from "@rungsjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrate,
  migrationSql,
  postgresStore,
  purgeDispatchedEvents,
  purgeIdempotency,
  purgeRequest,
  purgeRequests,
  SCHEMA_VERSION,
} from "../src/index.js";
import { migrationFiles } from "../src/migrations.js";
import { pgliteHarness } from "./helpers.js";

const harness = pgliteHarness();
beforeAll(() => harness.start(), 60_000);
afterAll(() => harness.close());

const T0 = "2026-01-05T09:00:00.000Z";
const flow: FlowInput = {
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] }, deadline: "P1D" }],
};

async function service(tenantId?: string) {
  const { client, schema } = await harness.freshSchema();
  let now = new Date(T0);
  let n = 0;
  const delivered: DomainEvent[] = [];
  const rungs = createRungs({
    store: postgresStore(client, { schema }),
    clock: () => now,
    ids: () => `r${++n}`,
    onEvent: (event) => {
      delivered.push(event);
    },
  });
  await rungs.flows.register(flow);
  const submit = (idempotencyKey?: string) =>
    rungs.submit({
      flow: "expense",
      requesterId: "u_req",
      subject: { type: "expense", id: "EXP-1" },
      payload: { amount: 10 },
      ...(tenantId ? { tenantId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  const count = async (table: string, where = "true", params: unknown[] = []) => {
    const r = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM "${schema}"."rungs_${table}" WHERE ${where}`,
      params,
    );
    return r.rows[0]?.c ?? 0;
  };
  return { rungs, client, schema, submit, at, count, delivered };
}

describe("migrations", () => {
  it("migrate is idempotent and records the schema version", async () => {
    const client = harness.client();
    expect(await migrate(client, { schema: "m1" })).toEqual({
      applied: [1],
      version: SCHEMA_VERSION,
    });
    expect(await migrate(client, { schema: "m1" })).toEqual({
      applied: [],
      version: SCHEMA_VERSION,
    });
  });

  it("the store refuses a schema that has not been migrated (fail closed)", async () => {
    const store = postgresStore(harness.client(), { schema: "never_migrated" });
    const error = await store.transaction(async () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain("Run migrate()");
  });

  it("schema and table prefix are configurable and validated", async () => {
    const client = harness.client();
    await migrate(client, { schema: "custom", tablePrefix: "wf_" });
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'custom' ORDER BY 1",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "wf_audit",
      "wf_delegations",
      "wf_flows",
      "wf_idempotency",
      "wf_inbox",
      "wf_outbox",
      "wf_requests",
      "wf_schema_migrations",
    ]);
    for (const bad of [{ schema: "Bad-Name" }, { tablePrefix: "x;drop" }, { schema: "" }]) {
      expect(() => postgresStore(client, bad)).toThrow(ConfigurationError);
    }
  });

  it("the shipped migration files match migrationSql()", () => {
    for (const { file, sql } of migrationFiles()) {
      expect(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).toBe(sql);
    }
    expect(migrationSql({ schema: "x", tablePrefix: "p_" })).toContain('"x"."p_requests"');
  });

  it("a script from migrationSql() leaves a schema the store accepts", async () => {
    const client = harness.client();
    await client.execute(migrationSql({ schema: "external" }));
    expect(await migrate(client, { schema: "external" })).toEqual({
      applied: [],
      version: SCHEMA_VERSION,
    });
    const store = postgresStore(client, { schema: "external" });
    await expect(store.transaction(async () => "ok")).resolves.toBe("ok");
  });
});

describe("leases", () => {
  it("findDue with claim leases what it returns; without claim nothing is hidden", async () => {
    const { rungs, at, client, schema } = await service();
    await rungs.submit({
      flow: "expense",
      requesterId: "u_req",
      subject: { type: "e", id: "1" },
      payload: {},
    });
    const store = postgresStore(client, { schema, leaseSeconds: 60 });
    const due = "2026-01-06T09:00:00.000Z";
    expect(await store.transaction((tx) => tx.findDue(due, 10, { claim: true }))).toEqual(["r1"]);
    expect(await store.transaction((tx) => tx.findDue(due, 10, { claim: true }))).toEqual([]);
    expect(await store.transaction((tx) => tx.findDue(due, 10))).toEqual(["r1"]);
    expect(
      await store.transaction((tx) => tx.findDue("2026-01-06T09:01:01.000Z", 10, { claim: true })),
    ).toEqual(["r1"]);
    at(due);
    expect((await rungs.tick()).changed).toEqual([]);
    at("2026-01-06T09:02:02.000Z");
    expect((await rungs.tick()).changed).toEqual(["r1"]);
  });

  it("pendingEvents with claim leases whole chains; delivery clears the lease", async () => {
    const { client, schema } = await service();
    const store = postgresStore(client, { schema });
    const event = (requestId: string, seq: number): DomainEvent => ({
      requestId,
      seq,
      actorId: "u_req",
      at: T0,
      type: "request.submitted",
      data: { flowKey: "expense", flowVersion: 1, subject: { type: "e", id: "1" } },
    });
    await store.transaction((tx) =>
      tx.enqueueEvents([event("a", 1), event("a", 2), event("b", 1)], T0),
    );
    const first = await store.transaction((tx) =>
      tx.pendingEvents({ now: T0, limit: 10, claim: true }),
    );
    expect(first.map((e) => `${e.event.requestId}#${e.event.seq}`)).toEqual(["a#1", "a#2", "b#1"]);
    expect(
      await store.transaction((tx) => tx.pendingEvents({ now: T0, limit: 10, claim: true })),
    ).toEqual([]);
    expect(await store.transaction((tx) => tx.pendingEvents({ now: T0, limit: 10 }))).toHaveLength(
      3,
    );
    await store.transaction((tx) => tx.markDispatched([{ requestId: "a", seq: 1 }], T0));
    await store.transaction((tx) =>
      tx.markFailed({ requestId: "a", seq: 2 }, { attempts: 1, nextAttemptAt: T0, error: "x" }),
    );
    const again = await store.transaction((tx) =>
      tx.pendingEvents({ now: T0, limit: 10, claim: true }),
    );
    expect(again.map((e) => `${e.event.requestId}#${e.event.seq}`)).toEqual(["a#2"]);
  });
});

describe("EC-61 purging closed requests", () => {
  async function closedAndOpen() {
    const s = await service();
    await s.rungs.flows.register(flow);
    const closed = await s.submit("k1");
    await s.rungs.approve({ requestId: closed.id, actorId: "u_mgr" });
    const open = await s.submit("k2");
    return { ...s, closed: closed.id, open: open.id };
  }

  it("EC-61 purgeRequest deletes a closed request with its audit, outbox, inbox and idempotency rows", async () => {
    const { client, schema, closed, open, rungs, count } = await closedAndOpen();
    const before = (await rungs.history(closed)).length;
    const result = await purgeRequest(client, closed, { schema });
    expect(result).toEqual({
      requests: 1,
      auditEvents: before,
      outboxEvents: before,
      idempotencyKeys: 1,
    });
    expect(await rungs.get(closed)).toBeNull();
    expect(await rungs.history(closed)).toEqual([]);
    expect(await count("outbox", "request_id = $1", [closed])).toBe(0);
    expect(await count("idempotency", "request_id = $1", [closed])).toBe(0);
    expect((await rungs.get(open))?.status).toBe("pending");
    expect(await purgeRequest(client, "unknown", { schema })).toEqual({
      requests: 0,
      auditEvents: 0,
      outboxEvents: 0,
      idempotencyKeys: 0,
    });
  });

  it("EC-61 a request that is still open cannot be purged; nothing is deleted", async () => {
    const { client, schema, open, rungs, count } = await closedAndOpen();
    const error = await purgeRequest(client, open, { schema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidTransitionError);
    expect(error).toMatchObject({ status: "pending", command: "purge" });
    expect(await rungs.get(open)).not.toBeNull();
    expect(await count("audit", "request_id = $1", [open])).toBeGreaterThan(0);
    expect(await count("inbox", "request_id = $1", [open])).toBe(1);
  });

  it("EC-61 audit rows cannot be updated, deleted or truncated outside a purge", async () => {
    const { client, schema, closed } = await closedAndOpen();
    const table = `"${schema}"."rungs_audit"`;
    for (const sql of [
      `UPDATE ${table} SET type = 'x' WHERE request_id = '${closed}'`,
      `DELETE FROM ${table} WHERE request_id = '${closed}'`,
      `TRUNCATE ${table}`,
    ]) {
      await expect(client.query(sql)).rejects.toThrow("append-only");
    }
    // Even inside a purge transaction, rows can be deleted but never changed.
    await expect(
      client.transaction(async (tx) => {
        await tx.query("SELECT set_config('rungs.purge', 'on', true)");
        await tx.query(`UPDATE ${table} SET type = 'x' WHERE request_id = '${closed}'`);
      }),
    ).rejects.toThrow("append-only");
  });

  it("EC-61 purgeRequests removes requests closed before a time, per tenant or for all tenants", async () => {
    const acme = await service("acme");
    const a1 = await acme.submit();
    await acme.rungs.withdraw({ requestId: a1.id, actorId: "u_req" });
    acme.at("2026-02-01T00:00:00.000Z");
    const a2 = await acme.submit();
    await acme.rungs.withdraw({ requestId: a2.id, actorId: "u_req" });
    const opts = { schema: acme.schema };
    expect(
      await purgeRequests(acme.client, {
        ...opts,
        closedBefore: "2026-01-10T00:00:00.000Z",
        tenantId: "globex",
      }),
    ).toMatchObject({ requests: 0 });
    expect(
      await purgeRequests(acme.client, {
        ...opts,
        closedBefore: "2026-01-10T00:00:00.000Z",
        tenantId: "acme",
      }),
    ).toMatchObject({ requests: 1 });
    expect(await acme.rungs.get(a1.id)).toBeNull();
    expect(await acme.rungs.get(a2.id)).not.toBeNull();
    expect(
      await purgeRequests(acme.client, {
        ...opts,
        closedBefore: "2026-03-01T00:00:00.000Z",
        allTenants: true,
      }),
    ).toMatchObject({
      requests: 1,
    });
    await expect(
      purgeRequests(acme.client, { ...opts, closedBefore: "yesterday", allTenants: true }),
    ).rejects.toBeInstanceOf(InvalidCommandError);
  });

  it("EC-61 purgeRequests refuses to run without an explicit tenant scope; nothing is deleted", async () => {
    const acme = await service("acme");
    const closed = await acme.submit();
    await acme.rungs.withdraw({ requestId: closed.id, actorId: "u_req" });
    const base = { schema: acme.schema, closedBefore: "2026-03-01T00:00:00.000Z" };
    for (const options of [
      base,
      { ...base, allTenants: false },
      { ...base, tenantId: "acme", allTenants: true },
    ]) {
      await expect(
        purgeRequests(acme.client, options as unknown as Parameters<typeof purgeRequests>[1]),
      ).rejects.toBeInstanceOf(InvalidCommandError);
    }
    expect(await acme.rungs.get(closed.id)).not.toBeNull();
  });

  it("EC-61 a cancelled request counts as closed and can be purged", async () => {
    const { client, schema, rungs, count, open } = await closedAndOpen();
    // The engine does not produce request status "cancelled" yet; a host-written row stands in.
    await client.query(
      `UPDATE "${schema}"."rungs_requests" SET status = 'cancelled', closed_at = '2026-01-05T09:00:00Z' WHERE id = $1`,
      [open],
    );
    expect(await purgeRequest(client, open, { schema })).toMatchObject({ requests: 1 });
    expect(await rungs.get(open)).toBeNull();
    expect(await count("inbox", "request_id = $1", [open])).toBe(0);
  });
});

describe("maintenance", () => {
  it("purgeIdempotency removes records older than a time; the command then runs again", async () => {
    const { client, schema, submit, at } = await service();
    const first: RequestState = await submit("k1");
    expect((await submit("k1")).id).toBe(first.id);
    expect(
      await purgeIdempotency(client, { schema, olderThan: "2026-01-05T09:00:01.000Z" }),
    ).toEqual({
      idempotencyKeys: 1,
    });
    at("2026-01-05T10:00:00.000Z");
    expect((await submit("k1")).id).not.toBe(first.id);
  });

  it("purgeDispatchedEvents removes delivered events only", async () => {
    const { client, schema, submit, count, delivered } = await service();
    await submit();
    expect(delivered.length).toBeGreaterThan(0);
    await client.query(
      `INSERT INTO "${schema}"."rungs_outbox" (request_id, seq, event, next_attempt_at) VALUES ('zz', 1, '{}'::jsonb, $1::timestamptz)`,
      [T0],
    );
    const result = await purgeDispatchedEvents(client, {
      schema,
      olderThan: "2026-01-06T00:00:00.000Z",
    });
    expect(result).toEqual({ events: delivered.length });
    expect(await count("outbox")).toBe(1);
  });
});
