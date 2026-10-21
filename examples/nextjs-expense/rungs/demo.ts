import { randomUUID } from "node:crypto";
import { createRungs, type RequestState, type Rungs, type TickSummary } from "@rungsjs/core";
import { type PgClient, postgresStore } from "@rungsjs/store-postgres";
import { type DemoClock, demoClock } from "./clock";
import { dropSchema, openDatabase, prepareSchema, SCHEMA } from "./db";
import { loadInactiveUsers, resolutionHooks } from "./directory";
import { insertExpense, syncExpense } from "./expenses";
import { type ExpensePayload, expenseFlow } from "./flow";
import { notify } from "./notifications";

export interface Demo {
  readonly db: PgClient;
  readonly rungs: Rungs;
  readonly clock: DemoClock;
  /** Users marked inactive on the admin page; read by `isActiveUser`. */
  readonly inactive: Set<string>;
}

/** Short random ids such as `r_3f9c2a1b`; easier to read in a URL than a full UUID. */
export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

/** One Rungs instance for the app. `clock` is injectable so the seed can replay the past. */
export function rungsFor(db: PgClient, inactive: Set<string>, clock: () => Date): Rungs {
  const rungs: Rungs = createRungs({
    store: postgresStore(db, { schema: SCHEMA }),
    clock,
    ids: () => newId("r"),
    ...resolutionHooks(inactive),
    // After every command commits: keep the app's expense record in step and notify people.
    onEvent: async (event) => {
      const request = await rungs.get(event.requestId);
      if (request === null) return;
      if (event.type.startsWith("request.")) await syncExpense(db, request);
      await notify(db, event, request);
    },
  });
  return rungs;
}

export async function createDemo(db: PgClient): Promise<Demo> {
  await prepareSchema(db);
  const clock = await demoClock(db);
  const inactive = await loadInactiveUsers(db);
  const rungs = rungsFor(db, inactive, clock.now);
  await rungs.flows.register(expenseFlow); // a no-op when this version is already registered
  return { db, rungs, clock, inactive };
}

/**
 * Submits an expense. The form renders a fresh `expenseId`, which is both the subject Rungs points
 * back to and the idempotency key: a double click or a retried request submits it only once.
 */
export async function submitExpense(
  demo: Pick<Demo, "db" | "rungs">,
  input: { requesterId: string; payload: ExpensePayload; expenseId?: string },
): Promise<RequestState> {
  const expenseId = input.expenseId ?? newId("exp");
  const request = await demo.rungs.submit({
    flow: expenseFlow.key,
    requesterId: input.requesterId,
    subject: { type: "expense", id: expenseId },
    payload: { ...input.payload },
    idempotencyKey: `submit:${expenseId}`,
  });
  await insertExpense(demo.db, {
    id: expenseId,
    requestId: request.id,
    requesterId: input.requesterId,
    ...input.payload,
    status: request.status,
    submittedAt: request.submittedAt,
  });
  return request;
}

/**
 * Moves the demo clock forward and lets Rungs catch up: `tick` applies every reminder,
 * escalation and timeout that became due. A real app runs `tick` on a schedule instead.
 */
export async function advanceTime(demo: Demo, ms: number): Promise<TickSummary> {
  await demo.clock.advance(ms);
  return demo.rungs.tick({ limit: 1000 });
}

/** Deletes everything in the demo schema. The next `getDemo()` starts fresh. */
export async function resetDemo(): Promise<void> {
  const { db } = await getDemo();
  await dropSchema(db);
  state.demo = undefined;
}

// One instance per server process. Kept on globalThis so hot reload in `next dev` does not open
// the PGlite database a second time.
const state = globalThis as unknown as {
  rungsDemoDb?: Promise<PgClient>;
  demo?: Promise<Demo>;
};

export function getDemo(): Promise<Demo> {
  state.demo ??= (async () => {
    state.rungsDemoDb ??= openDatabase();
    const db = await state.rungsDemoDb;
    const demo = await createDemo(db);
    const { seedIfEmpty } = await import("./seed");
    await seedIfEmpty(demo);
    return demo;
  })().catch((error: unknown) => {
    state.demo = undefined;
    throw error;
  });
  return state.demo;
}
