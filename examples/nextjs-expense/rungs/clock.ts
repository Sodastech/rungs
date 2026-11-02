import type { AppDb } from "./db";

/**
 * The demo's clock: real time plus an offset that "advance time" increases. Rungs never reads a
 * clock itself; the app decides what "now" is. The offset only grows, so time never runs
 * backwards. Rungs needs `now` to be synchronous, which is why the offset is kept in memory.
 */
export interface DemoClock {
  now(): Date;
  advance(ms: number): Promise<void>;
}

export async function demoClock(db: AppDb): Promise<DemoClock> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM ${db.schema}.settings WHERE key = 'clock_offset_ms'`,
  );
  let offset = Number(rows[0]?.value ?? 0);
  return {
    now: () => new Date(Date.now() + offset),
    async advance(ms) {
      if (!(ms > 0)) throw new Error("Time only moves forward");
      offset += ms;
      await db.query(
        `INSERT INTO ${db.schema}.settings (key, value) VALUES ('clock_offset_ms', $1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [String(offset)],
      );
    },
  };
}
