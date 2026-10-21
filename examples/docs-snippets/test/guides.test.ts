import type { AddressInfo } from "node:net";
import { InvalidTransitionError } from "@rungsjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

const quiet = () => {
  const lines: unknown[][] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });
  return lines;
};

describe("guide snippets", { timeout: 60_000 }, () => {
  it("express: submit, a conflict as 409, the inbox, and a retried POST", async () => {
    const { app } = await import("../src/guides/express.js");
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (path: string, user: string, body?: unknown, key?: string) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-user": user,
          ...(key ? { "idempotency-key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      const submitted = await call("/expenses/EXP-1/submit", "u_req", { amount: 40 }, "k1");
      expect(submitted.status).toBe(201);
      const request = (await submitted.json()) as { id: string; version: number };
      const again = await call("/expenses/EXP-1/submit", "u_req", { amount: 40 }, "k1");
      expect(((await again.json()) as { id: string }).id).toBe(request.id);

      const inbox = (await (await call("/inbox", "u_mgr")).json()) as { tasks: unknown[] };
      expect(inbox.tasks).toHaveLength(1);

      const stale = await call(`/requests/${request.id}/approve`, "u_mgr", { version: 99 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
      const notMine = await call(`/requests/${request.id}/approve`, "u_req", {});
      expect(notMine.status).toBe(403);
      const ok = await call(`/requests/${request.id}/approve`, "u_mgr", {
        version: request.version,
        comment: "Fine",
      });
      expect(((await ok.json()) as { status: string }).status).toBe("approved");
      const missing = await call("/requests/nope/approve", "u_mgr", {});
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("postgres: a custom schema and prefix, and the migrations as SQL", async () => {
    const { approvals, everything, upgradeFrom1, request } = await import(
      "../src/guides/postgres.js"
    );
    expect(request.status).toBe("pending");
    const tables = await approvals.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'approvals'",
    );
    expect(tables.rows.map((r) => r.table_name)).toContain("wf_requests");
    expect(everything).toContain("Migration 1: init");
    expect(upgradeFrom1).not.toContain("Migration 1: init");
    expect(upgradeFrom1).toContain("Migration 2");
  });

  it("multi-tenant: a tenant's own flow, the global one for others, separate lists", async () => {
    const m = await import("../src/guides/multi-tenant.js");
    expect(m.acme.flowTenantId).toBe("acme");
    expect(m.globex.flowTenantId).toBeUndefined();
    expect(m.acmeInbox.tasks.map((t) => t.requestId)).toEqual([m.acme.id]);
    expect(m.acmeRequests.requests.map((r) => r.id)).toEqual([m.acme.id]);
    expect(m.noTenant.requests).toEqual([]);
  });

  it("notifications: the web process leaves events; the worker sends each mail once", async () => {
    const { beforeWorker, delivered, outbox } = await import("../src/guides/notifications.js");
    expect(beforeWorker).toBe(0);
    expect(delivered.failed).toBe(0);
    expect(outbox.map((m) => [m.to, m.subject])).toEqual([
      ["maria@example.com", "To approve"],
      ["tom@example.com", "Your request was approved"],
    ]);
  });

  it("tick: the worker loop applies the timeout", async () => {
    const { rungs, request } = await import("../src/guides/tick.js");
    const { startWorker } = await import("../src/guides/tick.js");
    const stop = startWorker(rungs, 3_600_000);
    await vi.waitFor(async () => {
      expect((await rungs.get(request.id))?.status).toBe("rejected");
    });
    stop();
  });

  it("retention: purges what is closed and old, refuses what is open", async () => {
    const lines = quiet();
    const { refused, remaining, result } = await import("../src/guides/retention.js");
    expect(result).toMatchObject({ requests: 1, idempotencyKeys: 1 });
    expect(lines[0]?.[0]).toMatchObject({ requests: 1 });
    expect(refused).toBeInstanceOf(InvalidTransitionError);
    expect(remaining.requests.map((r) => r.status)).toEqual(["pending"]);
  });

  it("concurrency: one request per idempotency key, and a stale decision conflicts", async () => {
    const lines = quiet();
    const { misuse } = await import("../src/guides/concurrency.js");
    expect(misuse).toBe(true);
    expect(lines).toEqual([[true], ["Someone decided first; showing the latest state."]]);
  });

  it("testing: the example test passes", async () => {
    const { passed } = await import("../src/guides/testing.js");
    expect(passed).toBe(true);
  });
});
