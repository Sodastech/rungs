import { fromPg, type PgClient } from "@rungsjs/store-postgres";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../rungs/db";
import { createDemo, type Demo, submitExpense } from "../rungs/demo";
import {
  cleanupSandboxes,
  createSandbox,
  isSandboxId,
  openSandbox,
  resetSandbox,
  sandboxExists,
} from "../rungs/sandbox";
import { replayStory } from "../rungs/seed";
import { buildSeedSnapshot } from "./seed-snapshot";

const DAY = 86_400_000;
const url = process.env.RUNGS_TEST_DATABASE_URL;

// With RUNGS_TEST_DATABASE_URL, as in CI, this runs on a real server through `pg`.
const pools: { end(): Promise<void> }[] = [];
async function database(): Promise<PgClient> {
  if (url === undefined) return openDatabase({ dataDir: "memory" });
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pools.push(pool);
  return fromPg(pool);
}
afterAll(() => Promise.all(pools.map((p) => p.end())));

/** Counts round trips to the database. */
function counted(client: PgClient) {
  const count = { trips: 0 };
  return {
    count,
    client: {
      ...client,
      query: ((text: string, params?: readonly unknown[]) => {
        count.trips += 1;
        return client.query(text, params);
      }) as PgClient["query"],
      execute: (script: string) => {
        count.trips += 1;
        return client.execute(script);
      },
    } satisfies PgClient,
  };
}

async function open(client: PgClient, id: string): Promise<Demo> {
  const demo = await openSandbox(client, id);
  if (demo === null) throw new Error("sandbox not found");
  return demo;
}

const statuses = async (demo: Demo) => {
  const { requests } = await demo.rungs.requests({ limit: 200 });
  return Object.fromEntries(requests.map((r) => [r.subject.id, r.status]));
};

const auditSize = async (demo: Demo, requestId: string) =>
  (await demo.rungs.history(requestId)).length;

describe("visitor sandboxes", { timeout: 120_000 }, () => {
  it("the seed snapshot is what replaying the story produces", async () => {
    await expect(await buildSeedSnapshot()).toMatchFileSnapshot("../rungs/seed-snapshot.json");
  });

  it("a new sandbox takes one round trip and holds the sample data", async () => {
    const { client, count } = counted(await database());
    const first = await createSandbox(client); // may also create the control tables
    const before = count.trips;
    const id = await createSandbox(client);
    expect(count.trips - before).toBe(1);
    expect(isSandboxId(id)).toBe(true);
    expect(id).not.toBe(first);

    // The same result as replaying the story with the commands.
    const replayed = await createDemo(await openDatabase({ dataDir: "memory" }));
    await replayStory(replayed, Date.now());
    const demo = await open(client, id);
    expect(await statuses(demo)).toEqual(await statuses(replayed));
    expect((await demo.rungs.inbox({ userId: "marco" })).tasks.map((t) => t.stepId)).toEqual(
      (await replayed.rungs.inbox({ userId: "marco" })).tasks.map((t) => t.stepId),
    );
    const { requests } = await demo.rungs.requests({ limit: 200 });
    for (const request of requests) {
      expect(Date.parse(request.submittedAt)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(request.submittedAt)).toBeGreaterThan(Date.now() - 8 * DAY);
    }
  });

  it("commands work on a restored sandbox, through to approval", async () => {
    const client = await database();
    const demo = await open(client, await createSandbox(client));
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Monitor", category: "Equipment", amount: 900 },
    });
    await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    const done = await demo.rungs.approve({ requestId: request.id, actorId: "fatima" });
    expect(done.status).toBe("approved");
  });

  it("one visitor's data and requests are out of reach for another", async () => {
    const client = await database();
    const a = await open(client, await createSandbox(client));
    const b = await open(client, await createSandbox(client));
    const mine = await submitExpense(a, {
      requesterId: "alice",
      details: { title: "Only in A", category: "Travel", amount: 40 },
    });
    expect(await b.rungs.get(mine.id)).toBeNull();
    expect(await statuses(b)).not.toHaveProperty(mine.subject.id);
    await expect(b.rungs.approve({ requestId: mine.id, actorId: "marco" })).rejects.toThrow(
      /not found|does not exist/i,
    );
  });

  it("the clock and tick of one visitor do not touch another", async () => {
    const client = await database();
    const idA = await createSandbox(client);
    const idB = await createSandbox(client);
    const a = await open(client, idA);
    const b = await open(client, idB);
    const requestInB = (await b.rungs.inbox({ userId: "marco" })).tasks[0]?.requestId as string;
    const auditBefore = await auditSize(b, requestInB);
    const offsetBefore = b.clock.now().getTime() - Date.now();

    await a.clock.advance(30 * DAY);
    const summary = await a.rungs.tick({ limit: 1000 });

    expect(summary.changed.length).toBeGreaterThan(0);
    expect(await auditSize(b, requestInB)).toBe(auditBefore);
    const reopenedB = await open(client, idB);
    expect(Math.abs(reopenedB.clock.now().getTime() - Date.now() - offsetBefore)).toBeLessThan(
      5000,
    );
    const reopenedA = await open(client, idA);
    expect(reopenedA.clock.now().getTime() - Date.now()).toBeGreaterThan(29 * DAY);
  });

  it("a reset restores the sample data and the clock, and keeps the sandbox", async () => {
    const client = await database();
    const id = await createSandbox(client);
    const demo = await open(client, id);
    const extra = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Temporary", category: "Meals", amount: 10 },
    });
    await demo.clock.advance(10 * DAY);

    await resetSandbox(client, id);

    const fresh = await open(client, id);
    expect(await fresh.rungs.get(extra.id)).toBeNull();
    expect(fresh.clock.now().getTime() - Date.now()).toBeLessThan(5000);
    expect(Object.keys(await statuses(fresh))).toHaveLength(8);
  });

  it("the cleanup removes sandboxes left alone, open requests included, and no others", async () => {
    const client = await database();
    const stale = await createSandbox(client);
    const active = await createSandbox(client);
    await client.query(
      `UPDATE demo_control.sandboxes SET last_seen = now() - interval '25 hours' WHERE id = $1`,
      [stale],
    );

    await cleanupSandboxes(client, { olderThanHours: 24, limit: 1000 });

    expect(await sandboxExists(client, stale)).toBe(false);
    const left = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      [`sb_${stale}`],
    );
    expect(left.rows[0]?.n).toBe(0);
    expect(await sandboxExists(client, active)).toBe(true);
    expect(await statuses(await open(client, active))).toHaveProperty("exp_dock", "pending");
  });

  it("a visit counts as activity", async () => {
    const client = await database();
    const id = await createSandbox(client);
    await client.query(
      `UPDATE demo_control.sandboxes SET last_seen = now() - interval '25 hours' WHERE id = $1`,
      [id],
    );
    await open(client, id);
    await cleanupSandboxes(client, { olderThanHours: 24, limit: 1000 });
    expect(await sandboxExists(client, id)).toBe(true);
  });

  it("anything else than a sandbox id reaches no SQL", async () => {
    const { client, count } = counted(await database());
    for (const bad of ['x"; DROP SCHEMA public; --', "", "ABC", "a".repeat(33)]) {
      expect(isSandboxId(bad)).toBe(false);
      expect(await openSandbox(client, bad)).toBeNull();
    }
    expect(count.trips).toBe(0);
    await expect(resetSandbox(client, "nope")).rejects.toThrow(/Not a sandbox/);
  });

  it("an unknown id is not a sandbox", async () => {
    const client = await database();
    await createSandbox(client);
    expect(await openSandbox(client, "0".repeat(32))).toBeNull();
  });

  it("refuses to fall back to PGlite on Vercel", async () => {
    const before = { vercel: process.env.VERCEL, url: process.env.DATABASE_URL };
    process.env.VERCEL = "1";
    delete process.env.DATABASE_URL;
    try {
      await expect(openDatabase()).rejects.toThrow(/DATABASE_URL is required/);
    } finally {
      if (before.vercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = before.vercel;
      if (before.url !== undefined) process.env.DATABASE_URL = before.url;
    }
  });
});
