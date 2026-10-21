import { ConflictError, NoApproversError } from "@rungsjs/core";
import { describe, expect, it } from "vitest";
import { openDatabase, SCHEMA } from "../rungs/db";
import { advanceTime, createDemo, type Demo, resubmitExpense, submitExpense } from "../rungs/demo";
import { setActive } from "../rungs/directory";
import { describeError } from "../rungs/errors";
import { expenseById, expensesByIds } from "../rungs/expenses";
import { notificationsFor } from "../rungs/notifications";
import { seedIfEmpty } from "../rungs/seed";

const DAY = 86_400_000;

async function fresh(seed = false): Promise<Demo> {
  const demo = await createDemo(await openDatabase({ dataDir: "memory" }));
  if (seed) await seedIfEmpty(demo);
  return demo;
}

const inboxOf = async (demo: Demo, userId: string) =>
  (await demo.rungs.inbox({ userId })).tasks.map((t) => t.stepId);

/** What the pages do: approval status from Rungs, details from the app's table. */
async function statusByTitle(demo: Demo, requesterId?: string) {
  const { requests } = await demo.rungs.requests({
    limit: 200,
    ...(requesterId === undefined ? {} : { requesterId }),
  });
  const expenses = await expensesByIds(
    demo.db,
    requests.map((r) => r.subject.id),
  );
  return Object.fromEntries(requests.map((r) => [expenses.get(r.subject.id)?.title, r.status]));
}

const expenseCount = async (demo: Demo) =>
  (await demo.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${SCHEMA}.expenses`)).rows[0]
    ?.n;

describe("the Next.js example's integration", { timeout: 60_000 }, () => {
  it("seeds a week of expenses once, each waiting where the story left it", async () => {
    const demo = await fresh(true);
    await seedIfEmpty(demo);
    expect(await expenseCount(demo)).toBe(8);
    expect(await statusByTitle(demo)).toMatchObject({
      "Second monitor": "rejected",
      "Taxi to the airport": "approved",
      "Online TypeScript course": "returned",
      "Standing desk": "pending",
    });
    expect(await inboxOf(demo, "marco")).toEqual(["manager", "manager"]);
    expect((await inboxOf(demo, "diego")).sort()).toEqual(["director", "manager"]);
    expect(await inboxOf(demo, "fatima")).toEqual(["finance"]);
  });

  it("keeps the expense in the app and only the amount in the request payload", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Taxi", category: "Travel", amount: 40 },
    });
    expect(request.payload).toEqual({ amount: 40 });
    expect(request.subject).toEqual({ type: "expense", id: expect.any(String) });
    expect(await expenseById(demo.db, request.subject.id)).toMatchObject({
      title: "Taxi",
      category: "Travel",
      amount: 40,
      requesterId: "alice",
    });
  });

  it("routes by amount: a small expense needs the manager only, and the requester hears back", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Taxi", category: "Travel", amount: 40 },
    });
    const approved = await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    expect(approved.steps.map((s) => `${s.stepId}:${s.status}`)).toEqual([
      "manager:approved",
      "finance:skipped",
      "director:skipped",
    ]);
    expect(await statusByTitle(demo, "alice")).toEqual({ Taxi: "approved" });
    const messages = (await notificationsFor(demo.db, "alice")).map((n) => n.message);
    expect(messages).toContain('"Taxi" was approved.');
  });

  it("a resubmit with new details updates the record and the payload", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Course", category: "Training", amount: 300 },
    });
    await demo.rungs.return({ requestId: request.id, actorId: "marco", to: "requester" });
    const resubmitted = await resubmitExpense(demo, {
      requestId: request.id,
      actorId: "alice",
      details: { title: "Course with invoice", category: "Training", amount: 320 },
    });
    expect(resubmitted.payload).toEqual({ amount: 320 });
    expect(await expenseById(demo.db, request.subject.id)).toMatchObject({
      title: "Course with invoice",
      amount: 320,
    });
  });

  it("submitting the same form twice creates one expense", async () => {
    const demo = await fresh();
    const input = {
      requesterId: "alice",
      details: { title: "Lunch", category: "Meals", amount: 20 },
      expenseId: "exp_form1",
    };
    const first = await submitExpense(demo, input);
    const again = await submitExpense(demo, input);
    expect(again.id).toBe(first.id);
    expect(await expenseCount(demo)).toBe(1);
  });

  it("a submit Rungs refuses leaves no expense behind", async () => {
    const demo = await fresh();
    await setActive(demo.db, demo.inactive, "fatima", false);
    await setActive(demo.db, demo.inactive, "kenji", false);
    const error = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Monitor", category: "Equipment", amount: 700 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoApproversError);
    expect(await expenseCount(demo)).toBe(0);
  });

  it("advancing time reminds the manager, then escalates to the director", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Book", category: "Training", amount: 30 },
    });
    await advanceTime(demo, 1.5 * DAY);
    expect((await notificationsFor(demo.db, "marco")).map((n) => n.message)).toContain(
      'Reminder: "Book" from Alice Moreau is due soon.',
    );
    const summary = await advanceTime(demo, DAY);
    expect(summary.changed).toEqual([request.id]);
    expect(await inboxOf(demo, "marco")).toEqual([]);
    expect(await inboxOf(demo, "diego")).toEqual(["manager"]);
  });

  it("a step with nobody active is blocked and listed until an admin acts", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Laptop", category: "Equipment", amount: 900 },
    });
    await setActive(demo.db, demo.inactive, "fatima", false);
    await setActive(demo.db, demo.inactive, "kenji", false);
    await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    const { steps } = await demo.rungs.blocked();
    expect(steps.map((s) => [s.requestId, s.stepId])).toEqual([[request.id, "finance"]]);
    expect((await notificationsFor(demo.db, "ada"))[0]?.message).toContain("blocked at Finance");

    await setActive(demo.db, demo.inactive, "kenji", true);
    await demo.rungs.retry({
      requestId: request.id,
      stepId: "finance",
      adminId: "ada",
      expectedVersion: steps[0]?.version as number,
    });
    expect((await demo.rungs.blocked()).steps).toEqual([]);
    expect(await inboxOf(demo, "kenji")).toEqual(["finance"]);
  });

  it("a stale form gets a friendly conflict message", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      details: { title: "Cab", category: "Travel", amount: 25 },
    });
    await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    const error = await demo.rungs
      .withdraw({ requestId: request.id, actorId: "alice", expectedVersion: request.version })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(describeError(error)).toMatch(/Someone else acted/);
  });
});
