import type { PgClient } from "@rungsjs/store-postgres";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../rungs/db";
import { submitExpense } from "../rungs/demo";
import {
  arePeople,
  checkAwayDates,
  checkExpense,
  commentTooLong,
  isExpenseId,
  MAX_COMMENT,
} from "../rungs/input";
import { admitSandbox, checkWrite, DemoLimitError, hit, ipKey, LIMITS } from "../rungs/limits";
import { cleanupSandboxes, createSandbox, sandboxExists } from "../rungs/sandbox";

const memory = (): Promise<PgClient> => openDatabase({ dataDir: "memory" });
const counter = (key: string, max = 2) => ({ key, max, seconds: 60 });

describe("limits of the online demo", { timeout: 60_000 }, () => {
  it("a counter allows its maximum and then refuses", async () => {
    const client = await memory();
    expect(await hit(client, [counter("a")])).toBe(true);
    expect(await hit(client, [counter("a")])).toBe(true);
    expect(await hit(client, [counter("a")])).toBe(false);
    expect(await hit(client, [counter("b")])).toBe(true);
  });

  it("a counter starts again after its window", async () => {
    const client = await memory();
    for (let i = 0; i < 3; i += 1) await hit(client, [counter("a")]);
    await client.query(
      "UPDATE demo_control.rate_limits SET started_at = now() - interval '2 minutes'",
    );
    expect(await hit(client, [counter("a")])).toBe(true);
  });

  it("several counters are refused when any one is over", async () => {
    const client = await memory();
    expect(await hit(client, [counter("a", 1), counter("b", 5)])).toBe(true);
    expect(await hit(client, [counter("a", 1), counter("b", 5)])).toBe(false);
  });

  it("stores no address, only a keyed hash", async () => {
    const client = await memory();
    await checkWrite(client, { ip: "203.0.113.9", sandboxId: "0".repeat(32) });
    const { rows } = await client.query<{ key: string }>(
      "SELECT key FROM demo_control.rate_limits",
    );
    expect(rows.map((r) => r.key)).toContain(`write:${ipKey("203.0.113.9")}`);
    expect(JSON.stringify(rows)).not.toContain("203.0.113");
  });

  it("one address cannot make more than its share of sandboxes", async () => {
    const client = await memory();
    for (let i = 0; i < LIMITS.newSandboxesPerIp.max; i += 1) {
      await admitSandbox(client, "203.0.113.1");
    }
    const error = await admitSandbox(client, "203.0.113.1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DemoLimitError);
    expect((error as DemoLimitError).reason).toBe("busy");
    expect(await admitSandbox(client, "203.0.113.2")).toMatch(/^[0-9a-f]{32}$/);
  });

  async function fill(client: PgClient, count: number, lastSeen: string) {
    await createSandbox(client); // creates the control tables
    await client.query(
      `INSERT INTO demo_control.sandboxes (id, version, last_seen)
       SELECT md5(n::text), 'old', now() - $1::interval FROM generate_series(1, $2::int) n`,
      [lastSeen, count],
    );
  }

  it("a full demo says so, and creates nothing", async () => {
    const client = await memory();
    await fill(client, LIMITS.sandboxes, "1 hour");
    const error = await admitSandbox(client, "203.0.113.1").catch((e: unknown) => e);
    expect((error as DemoLimitError).reason).toBe("full");
  });

  it("a full demo first clears out abandoned sandboxes", async () => {
    const client = await memory();
    await fill(client, LIMITS.sandboxes, "30 hours");
    const id = await admitSandbox(client, "203.0.113.1");
    expect(await sandboxExists(client, id)).toBe(true);
  });

  it("the cleanup also forgets expired counters", async () => {
    const client = await memory();
    await hit(client, [counter("old"), counter("new")]);
    await client.query(
      "UPDATE demo_control.rate_limits SET started_at = now() - interval '2 hours' WHERE key = 'old'",
    );
    await cleanupSandboxes(client, { olderThanHours: 24, limit: 10 });
    const { rows } = await client.query<{ key: string }>(
      "SELECT key FROM demo_control.rate_limits",
    );
    expect(rows.map((r) => r.key)).toEqual(["new"]);
  });
});

describe("input checks", () => {
  const expense = { title: "Taxi", category: "Travel", amount: "40.126" };

  it("accepts a valid expense and rounds the amount", () => {
    expect(checkExpense(expense)).toEqual({ title: "Taxi", category: "Travel", amount: 40.13 });
  });

  it.each([
    [{ ...expense, title: "ab" }],
    [{ ...expense, title: "x".repeat(81) }],
    [{ ...expense, category: "Yachts" }],
    [{ ...expense, amount: "0" }],
    [{ ...expense, amount: "-5" }],
    [{ ...expense, amount: "1000000.01" }],
    [{ ...expense, amount: "1e99" }],
    [{ ...expense, amount: "Infinity" }],
    [{ ...expense, amount: "abc" }],
  ])("refuses %j", (input) => {
    expect(typeof checkExpense(input)).toBe("string");
  });

  it("only an id the form could have rendered is an expense id", () => {
    expect(isExpenseId("exp_3f9c2a1b")).toBe(true);
    for (const bad of ["", "exp_seed", "exp_3f9c2a1b; DROP", `exp_${"a".repeat(500)}`]) {
      expect(isExpenseId(bad)).toBe(false);
    }
  });

  it("limits comments", () => {
    expect(commentTooLong("x".repeat(MAX_COMMENT))).toBeUndefined();
    expect(commentTooLong("x".repeat(MAX_COMMENT + 1))).toMatch(/under 500/);
  });

  it("only known people, and not too many, can be chosen", () => {
    expect(arePeople(["marco", "ada"])).toBe(true);
    expect(arePeople([])).toBe(false);
    expect(arePeople(["marco", "mallory"])).toBe(false);
    expect(arePeople(Array.from({ length: 11 }, () => "marco"))).toBe(false);
  });

  it("away dates must be real, in order, and at most a year apart", () => {
    expect(checkAwayDates("2026-11-02", "2026-11-05")).toBeUndefined();
    expect(checkAwayDates("2026-11-05", "2026-11-02")).toMatch(/first/);
    expect(checkAwayDates("2026-13-45", "2026-14-01")).toMatch(/first/);
    expect(checkAwayDates("today", "tomorrow")).toMatch(/first/);
    expect(checkAwayDates("2026-01-01", "2099-01-01")).toMatch(/at most a year/);
  });
});

describe("a limit on expenses", { timeout: 60_000 }, () => {
  it("the seed leaves room for a visitor's own", async () => {
    const client = await memory();
    const { openSandbox } = await import("../rungs/sandbox");
    const demo = await openSandbox(client, await createSandbox(client));
    if (demo === null) throw new Error("no sandbox");
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Own", category: "Meals", amount: 5 },
    });
    expect(request.status).toBe("pending");
    const { rows } = await demo.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${demo.db.schema}.expenses`,
    );
    expect(rows[0]?.n).toBeLessThan(LIMITS.expensesPerSandbox);
  });
});
