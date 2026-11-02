import { createHmac } from "node:crypto";
import type { PgClient } from "@rungsjs/store-postgres";
import { CONTROL, cleanupSandboxes, createSandbox, withControl } from "./sandbox";

/** What keeps the online demo inside the free plans. Each one fails with a message, not an error. */
export const LIMITS = {
  sandboxes: 300,
  newSandboxesPerIp: { max: 5, seconds: 3600 },
  writesPerIp: { max: 60, seconds: 600 },
  writesPerSandbox: { max: 200, seconds: 86_400 },
  clockMovesPerSandbox: { max: 50, seconds: 86_400 },
  expensesPerSandbox: 30,
} as const;

/** `busy` means this visitor is going too fast; `full` means the whole demo is at its limit. */
export class DemoLimitError extends Error {
  constructor(
    readonly reason: "busy" | "full",
    message: string,
  ) {
    super(message);
    this.name = "DemoLimitError";
  }
}

const TOO_FAST = "You are going faster than this public demo allows. Try again in a few minutes.";

interface Counter {
  readonly key: string;
  readonly max: number;
  readonly seconds: number;
}

/**
 * Counts one more hit on each counter, in one statement, and returns whether all are within their
 * limit. Each counter is a fixed window that starts at its first hit.
 */
export async function hit(client: PgClient, counters: readonly Counter[]): Promise<boolean> {
  const values = counters.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}::int)`).join(", ");
  const { rows } = await withControl(client, () =>
    client.query<{ key: string; count: number }>(
      `INSERT INTO ${CONTROL}.rate_limits AS r (key, window_seconds)
       VALUES ${values}
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN r.started_at < now() - make_interval(secs => r.window_seconds)
                      THEN 1 ELSE r.count + 1 END,
         started_at = CASE WHEN r.started_at < now() - make_interval(secs => r.window_seconds)
                           THEN now() ELSE r.started_at END
       RETURNING key, count`,
      counters.flatMap((c) => [c.key, c.seconds]),
    ),
  );
  return rows.every((r) => r.count <= (counters.find((c) => c.key === r.key)?.max ?? 0));
}

/** Only a keyed hash of the address is stored, never the address. */
export const ipKey = (ip: string) =>
  createHmac("sha256", process.env.CRON_SECRET ?? "local")
    .update(ip)
    .digest("hex")
    .slice(0, 32);

/** A sandbox for a new visitor, unless they are making too many or the demo is full. */
export async function admitSandbox(client: PgClient, ip: string): Promise<string> {
  const allowed = await hit(client, [{ key: `new:${ipKey(ip)}`, ...LIMITS.newSandboxesPerIp }]);
  if (!allowed) throw new DemoLimitError("busy", TOO_FAST);

  if ((await countSandboxes(client)) >= LIMITS.sandboxes) {
    // The daily cleanup may be hours away, so first clear out what it would remove.
    await cleanupSandboxes(client, { olderThanHours: 24, limit: 20 });
    if ((await countSandboxes(client)) >= LIMITS.sandboxes) {
      throw new DemoLimitError("full", "The public demo is full right now. Try again later.");
    }
  }
  return createSandbox(client);
}

async function countSandboxes(client: PgClient): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${CONTROL}.sandboxes`,
  );
  return rows[0]?.n ?? 0;
}

/** Call before anything that writes. Throws `DemoLimitError` when over a limit. */
export async function checkWrite(
  client: PgClient,
  who: { ip: string; sandboxId: string; clock?: boolean },
): Promise<void> {
  const allowed = await hit(client, [
    { key: `write:${ipKey(who.ip)}`, ...LIMITS.writesPerIp },
    { key: `write:${who.sandboxId}`, ...LIMITS.writesPerSandbox },
    ...(who.clock ? [{ key: `clock:${who.sandboxId}`, ...LIMITS.clockMovesPerSandbox }] : []),
  ]);
  if (!allowed) throw new DemoLimitError("busy", TOO_FAST);
}
