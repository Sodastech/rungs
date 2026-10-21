import { randomUUID } from "node:crypto";
import { createRungs, type RequestState, type Rungs, type TickSummary } from "@rungsjs/core";
import { type PgClient, postgresStore } from "@rungsjs/store-postgres";
import { type DemoClock, demoClock } from "./clock";
import { dropSchema, openDatabase, prepareSchema, SCHEMA } from "./db";
import { loadInactiveUsers, resolutionHooks } from "./directory";
import { deleteExpense, type ExpenseDetails, insertExpense, updateExpense } from "./expenses";
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

// #region create-rungs
/** One Rungs instance for the app. `clock` is injectable so the seed can replay the past. */
export function rungsFor(db: PgClient, inactive: Set<string>, clock: () => Date): Rungs {
  const rungs: Rungs = createRungs({
    store: postgresStore(db, { schema: SCHEMA }),
    clock,
    ids: () => newId("r"),
    ...resolutionHooks(inactive),
    // After every command commits: tell the people involved.
    onEvent: async (event) => {
      const request = await rungs.get(event.requestId);
      if (request !== null) await notify(db, event, request);
    },
  });
  return rungs;
}
// #endregion create-rungs

export async function createDemo(db: PgClient): Promise<Demo> {
  await prepareSchema(db);
  const clock = await demoClock(db);
  const inactive = await loadInactiveUsers(db);
  const rungs = rungsFor(db, inactive, clock.now);
  await rungs.flows.register(expenseFlow); // a no-op when this version is already registered
  return { db, rungs, clock, inactive };
}

/** The payload of an expense's request: only what the flow's conditions read. */
const payloadOf = (details: ExpenseDetails): ExpensePayload => ({ amount: details.amount });

/**
 * Saves the expense, then sends it for approval. The form renders a fresh `expenseId`: it is the
 * record's id, the subject Rungs points back to, and the idempotency key, so a double click or a
 * retried request submits once. If Rungs refuses the submit, the record is removed again.
 */
export async function submitExpense(
  demo: Pick<Demo, "db" | "rungs" | "clock">,
  input: { requesterId: string; details: ExpenseDetails; expenseId?: string },
): Promise<RequestState> {
  const expenseId = input.expenseId ?? newId("exp");
  await insertExpense(demo.db, {
    id: expenseId,
    requesterId: input.requesterId,
    ...input.details,
    createdAt: demo.clock.now().toISOString(),
  });
  try {
    return await demo.rungs.submit({
      flow: expenseFlow.key,
      requesterId: input.requesterId,
      subject: { type: "expense", id: expenseId },
      payload: { ...payloadOf(input.details) },
      idempotencyKey: `submit:${expenseId}`,
    });
  } catch (error) {
    await deleteExpense(demo.db, expenseId);
    throw error;
  }
}

/** Resubmits a returned expense with changed details: the record and the payload change. */
export async function resubmitExpense(
  demo: Pick<Demo, "db" | "rungs">,
  input: { requestId: string; actorId: string; details: ExpenseDetails; expectedVersion?: number },
): Promise<RequestState> {
  const request = await demo.rungs.resubmit({
    requestId: input.requestId,
    actorId: input.actorId,
    payload: { ...payloadOf(input.details) },
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
  });
  await updateExpense(demo.db, request.subject.id, input.details);
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

// #region singleton
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
// #endregion singleton
