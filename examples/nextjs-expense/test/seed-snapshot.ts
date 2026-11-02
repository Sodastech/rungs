import { inSchema, openDatabase, prepareSchema } from "../rungs/db";
import { rungsFor } from "../rungs/demo";
import { expenseFlow } from "../rungs/flow";
import { replayStory } from "../rungs/seed";

const END = "2026-01-15T00:00:00.000Z";

/** In the order they can be inserted: `inbox` refers to `requests`. */
const TABLES = [
  ["rungs_flows", "key, version"],
  ["rungs_requests", "id"],
  ["rungs_inbox", "task_id"],
  ["rungs_audit", "request_id, seq"],
  ["rungs_outbox", "request_id, seq"],
  ["rungs_idempotency", "key"],
  ["expenses", "id"],
  ["notifications", "request_id, seq, user_id"],
] as const;

/** The rows the seed story leaves behind, ending at a fixed time, with timestamps in one format. */
export async function buildSeedSnapshot(): Promise<string> {
  const db = inSchema(await openDatabase({ dataDir: "memory" }), "seed");
  await prepareSchema(db);
  const end = Date.parse(END);
  const inactive = new Set<string>();
  await rungsFor(db, inactive, () => new Date(end - 1000 * 3_600_000)).flows.register(expenseFlow);
  await replayStory({ db, inactive }, end);

  await db.execute("SET TIME ZONE 'UTC'");
  const tables: Record<string, unknown[]> = {};
  for (const [table, order] of TABLES) {
    const { rows } = await db.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM seed.${table} t ORDER BY ${order}`,
    );
    tables[table] = rows.map((r) => r.row);
  }
  const text = JSON.stringify({ end: END, tables }, null, 1).replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)\+00:00"/g,
    (_, at: string) => JSON.stringify(new Date(`${at}Z`).toISOString()),
  );
  return `${text}\n`;
}
