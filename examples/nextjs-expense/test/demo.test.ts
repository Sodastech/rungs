import { ConflictError } from "@rungsjs/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../rungs/db";
import { advanceTime, createDemo, type Demo, submitExpense } from "../rungs/demo";
import { setActive } from "../rungs/directory";
import { describeError } from "../rungs/errors";
import { listExpenses } from "../rungs/expenses";
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

describe("the Next.js example's integration", { timeout: 60_000 }, () => {
  it("seeds a week of expenses once, each waiting where the story left it", async () => {
    const demo = await fresh(true);
    await seedIfEmpty(demo);
    const all = await listExpenses(demo.db);
    expect(all).toHaveLength(8);
    expect(Object.fromEntries(all.map((e) => [e.title, e.status]))).toMatchObject({
      "Second monitor": "rejected",
      "Taxi to the airport": "approved",
      "Online TypeScript course": "returned",
      "Standing desk": "pending",
    });
    expect(await inboxOf(demo, "marco")).toEqual(["manager", "manager"]);
    expect((await inboxOf(demo, "diego")).sort()).toEqual(["director", "manager"]);
    expect(await inboxOf(demo, "fatima")).toEqual(["finance"]);
  });

  it("routes by amount: a small expense needs the manager only, and the requester hears back", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      payload: { title: "Taxi", category: "Travel", amount: 40 },
    });
    const approved = await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    expect(approved.status).toBe("approved");
    expect(approved.steps.map((s) => `${s.stepId}:${s.status}`)).toEqual([
      "manager:approved",
      "finance:skipped",
      "director:skipped",
    ]);
    expect((await listExpenses(demo.db, { requesterId: "alice" }))[0]?.status).toBe("approved");
    const messages = (await notificationsFor(demo.db, "alice")).map((n) => n.message);
    expect(messages).toContain('"Taxi" was approved.');
  });

  it("a resubmit with new details updates the app's expense record", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      payload: { title: "Course", category: "Training", amount: 300 },
    });
    await demo.rungs.return({ requestId: request.id, actorId: "marco", to: "requester" });
    await demo.rungs.resubmit({
      requestId: request.id,
      actorId: "alice",
      payload: { title: "Course with invoice", category: "Training", amount: 320 },
    });
    expect(await listExpenses(demo.db)).toMatchObject([
      { title: "Course with invoice", amount: 320, status: "pending" },
    ]);
  });

  it("submitting the same form twice creates one expense", async () => {
    const demo = await fresh();
    const input = {
      requesterId: "alice",
      payload: { title: "Lunch", category: "Meals", amount: 20 },
      expenseId: "exp_form1",
    };
    const first = await submitExpense(demo, input);
    const again = await submitExpense(demo, input);
    expect(again.id).toBe(first.id);
    expect(await listExpenses(demo.db)).toHaveLength(1);
  });

  it("advancing time reminds the manager, then escalates to the director", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      payload: { title: "Book", category: "Training", amount: 30 },
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

  it("a step with nobody active is blocked until an admin acts", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      payload: { title: "Laptop", category: "Equipment", amount: 900 },
    });
    await setActive(demo.db, demo.inactive, "fatima", false);
    await setActive(demo.db, demo.inactive, "kenji", false);
    const blocked = await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    expect(blocked.steps[1]?.status).toBe("blocked");
    expect((await notificationsFor(demo.db, "ada"))[0]?.message).toContain("blocked at Finance");

    await setActive(demo.db, demo.inactive, "kenji", true);
    const retried = await demo.rungs.retry({
      requestId: request.id,
      stepId: "finance",
      adminId: "ada",
    });
    expect(retried.steps[1]?.status).toBe("active");
    expect(await inboxOf(demo, "kenji")).toEqual(["finance"]);
  });

  it("a stale form gets a friendly conflict message", async () => {
    const demo = await fresh();
    const request = await submitExpense(demo, {
      requesterId: "alice",
      payload: { title: "Cab", category: "Travel", amount: 25 },
    });
    await demo.rungs.approve({ requestId: request.id, actorId: "marco" });
    const error = await demo.rungs
      .withdraw({ requestId: request.id, actorId: "alice", expectedVersion: request.version })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(describeError(error)).toMatch(/Someone else acted/);
  });
});
