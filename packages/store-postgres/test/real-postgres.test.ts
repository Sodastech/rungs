import { createRungs, type FlowInput, type RungsStore } from "@rungsjs/core";
import { serviceSuite, storeContract } from "@rungsjs/store-contract";
import pg from "pg";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { fromPg, fromPostgresJs, migrate, type PgClient, postgresStore } from "../src/index.js";

// Runs against a real PostgreSQL server when RUNGS_TEST_DATABASE_URL is set (CI does, for
// PostgreSQL 15 to 18). Covers both drivers and what PGlite cannot: several connections at once.
const url = process.env.RUNGS_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

// The PostgreSQL CI job sets RUNGS_REQUIRE_REAL_POSTGRES, so a missing URL fails instead of skipping.
it("has a database when one is required", () => {
  expect(process.env.RUNGS_REQUIRE_REAL_POSTGRES === undefined || url !== undefined).toBe(true);
});

const pool = url ? new pg.Pool({ connectionString: url, max: 10 }) : undefined;
const sql = url ? postgres(url, { max: 10, onnotice: () => undefined }) : undefined;
const schemas: string[] = [];
let next = 0;

async function fresh(
  client: PgClient,
  label: string,
): Promise<{ client: PgClient; schema: string }> {
  const schema = `rt_${label}_${process.pid}_${++next}`;
  schemas.push(schema);
  await migrate(client, { schema });
  return { client, schema };
}

afterAll(async () => {
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
  await sql?.end();
});

if (pool && sql) {
  const viaPg = async (): Promise<RungsStore> => {
    const { client, schema } = await fresh(fromPg(pool), "pg");
    return postgresStore(client, { schema });
  };
  const viaPostgresJs = async (): Promise<RungsStore> => {
    const { client, schema } = await fresh(fromPostgresJs(sql), "pjs");
    return postgresStore(client, { schema });
  };
  storeContract("postgresStore via node-postgres", viaPg);
  serviceSuite("postgresStore via node-postgres", viaPg);
  storeContract("postgresStore via postgres.js", viaPostgresJs);
  serviceSuite("postgresStore via postgres.js", viaPostgresJs);
}

const T0 = "2026-01-05T09:00:00.000Z";
const flow: FlowInput = {
  key: "expense",
  steps: [{ id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b"] }, deadline: "P1D" }],
};

run("concurrency on a real server", () => {
  const client = () => fromPg(pool as pg.Pool);

  async function workers(count: number, now: () => Date) {
    const { schema } = await fresh(client(), "conc");
    let id = 0;
    const make = () =>
      createRungs({
        store: postgresStore(client(), { schema }),
        clock: now,
        ids: () => `r${++id}`,
        events: "discard",
      });
    const instances = Array.from({ length: count }, make);
    await instances[0]?.flows.register(flow);
    return { schema, instances };
  }

  it("EC-27 workers claiming due requests at the same moment get disjoint sets (SKIP LOCKED)", async () => {
    const { schema } = await fresh(client(), "claim");
    const store = postgresStore(client(), { schema });
    const rungs = createRungs({
      store,
      clock: () => new Date(T0),
      ids: (() => {
        let n = 0;
        return () => `r${++n}`;
      })(),
      events: "discard",
    });
    await rungs.flows.register(flow);
    for (let i = 0; i < 6; i++) {
      await rungs.submit({
        flow: "expense",
        requesterId: "u_req",
        subject: { type: "e", id: `${i}` },
        payload: {},
      });
    }
    const due = "2026-01-06T09:00:00.000Z";
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstClaimed: string[] = [];
    const first = store.transaction(async (tx) => {
      firstClaimed = await tx.findDue(due, 3, { claim: true });
      await hold; // keep the rows locked while the second worker claims
    });
    while (firstClaimed.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await store.transaction((tx) => tx.findDue(due, 10, { claim: true }));
    release();
    await first;
    expect(firstClaimed).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(new Set([...firstClaimed, ...second]).size).toBe(6);
  });

  it("EC-27 three ticking workers remind each overdue task exactly once", async () => {
    let now = new Date(T0);
    const { instances } = await workers(3, () => now);
    const [first] = instances;
    for (let i = 0; i < 5; i++) {
      await first?.submit({
        flow: "expense",
        requesterId: "u_req",
        subject: { type: "e", id: `${i}` },
        payload: {},
      });
    }
    now = new Date("2026-01-06T09:00:00.000Z");
    const results = await Promise.all(instances.map((w) => w.tick()));
    expect(results.flatMap((r) => r.failed)).toEqual([]);
    let reminders = 0;
    for (let i = 1; i <= 5; i++) {
      const history = (await first?.history(`r${i}`)) ?? [];
      reminders += history.filter((e) => e.type === "task.reminder").length;
    }
    expect(reminders).toBe(5 * 2);
  });

  it("EC-15 two approvers deciding at once on separate connections: exactly one decision lands", async () => {
    const { instances } = await workers(2, () => new Date(T0));
    const [a, b] = instances;
    const request = await a?.submit({
      flow: "expense",
      requesterId: "u_req",
      subject: { type: "e", id: "1" },
      payload: {},
    });
    const results = await Promise.allSettled([
      a?.approve({ requestId: request?.id ?? "", actorId: "u_a" }),
      b?.approve({ requestId: request?.id ?? "", actorId: "u_b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const state = await a?.get(request?.id ?? "");
    expect(state?.steps[0]?.tasks.filter((t) => t.status === "approved")).toHaveLength(1);
    expect(state?.status).toBe("approved");
  });

  it("several processes migrating at once apply each migration once", async () => {
    const schema = `rt_migrate_${process.pid}`;
    schemas.push(schema);
    const results = await Promise.all([1, 2, 3].map(() => migrate(client(), { schema })));
    expect(results.flatMap((r) => r.applied)).toEqual([1, 2]);
  });
});
