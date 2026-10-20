import { describe, expect, it } from "vitest";
import { createExpenseApp } from "../src/expense.js";

const T0 = "2026-01-05T09:00:00.000Z";

const expense = (payload: { amount: number; receipt?: string }) => ({
  flow: "expense",
  requesterId: "u_alice",
  subject: { type: "expense", id: "EXP-1042" },
  payload,
});

// The Phase 1 gate: a three-step expense approval runs end to end against the memory store.
describe("expense approval, end to end", () => {
  it("runs a large expense through delegation, return, resubmit, reminders and approval", async () => {
    const { rungs, notifications, setTime } = await createExpenseApp(T0);

    // The requester sees the chain before submitting.
    const preview = await rungs.preview({
      flow: "expense",
      requesterId: "u_alice",
      payload: { amount: 5000 },
    });
    expect(preview.submittable).toBe(true);
    expect(preview.steps.map((s) => [s.stepId, s.status, s.approvers])).toEqual([
      ["manager", "will-run", ["u_bob"]],
      ["finance", "will-run", ["u_fin1", "u_fin2"]],
      ["director", "will-run", ["u_dan"]],
    ]);

    // u_fin1 is on leave this month; u_fin3 covers.
    await rungs.delegations.set({
      fromUserId: "u_fin1",
      toUserId: "u_fin3",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-02-01T00:00:00.000Z",
    });

    const submitted = await rungs.submit(expense({ amount: 5000 }));
    const id = submitted.id;
    expect((await rungs.inbox({ userId: "u_bob" })).tasks.map((t) => t.stepId)).toEqual([
      "manager",
    ]);

    setTime("2026-01-05T10:00:00.000Z");
    await rungs.approve({ requestId: id, actorId: "u_bob", comment: "Fine by me" });
    const covering = await rungs.inbox({ userId: "u_fin3" });
    expect(covering.tasks).toMatchObject([
      { requestId: id, stepId: "finance", onBehalfOf: "u_fin1" },
    ]);

    // Finance sends it back for the receipt; the requester resubmits and it starts over.
    setTime("2026-01-05T11:00:00.000Z");
    const returned = await rungs.return({
      requestId: id,
      actorId: "u_fin2",
      to: "requester",
      comment: "Please attach the receipt",
    });
    expect(returned.status).toBe("returned");
    setTime("2026-01-05T12:00:00.000Z");
    await rungs.resubmit({
      requestId: id,
      actorId: "u_alice",
      payload: { amount: 5000, receipt: "R-1" },
    });
    setTime("2026-01-05T13:00:00.000Z");
    await rungs.approve({ requestId: id, actorId: "u_bob" });

    // Nobody in finance acts; the tick sends the reminder four hours before the deadline.
    setTime("2026-01-07T09:30:00.000Z");
    expect(await rungs.tick()).toMatchObject({ changed: [id], failed: [] });
    const reminders = notifications.filter((e) => e.type === "task.reminder");
    expect(reminders.map((e) => e.type === "task.reminder" && e.data.assigneeId)).toEqual([
      "u_fin3",
      "u_fin2",
    ]);
    expect((await rungs.inbox({ userId: "u_fin2" })).tasks[0]?.overdue).toBe(false);

    setTime("2026-01-07T10:00:00.000Z");
    await rungs.approve({ requestId: id, actorId: "u_fin3" });
    const done = await rungs.approve({ requestId: id, actorId: "u_dan" });
    expect(done.status).toBe("approved");

    const history = await rungs.history(id);
    expect(history.at(-1)).toMatchObject({
      type: "request.approved",
      data: { reason: "steps-approved" },
    });
    expect(history.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        "task.returned",
        "request.returned",
        "request.resubmitted",
        "task.reminder",
        "task.superseded",
      ]),
    );
    expect(notifications.filter((e) => e.requestId === id).map((e) => e.seq)).toEqual(
      history.map((e) => e.seq),
    );
    for (const userId of ["u_bob", "u_fin2", "u_fin3", "u_dan"]) {
      expect((await rungs.inbox({ userId })).tasks).toEqual([]);
    }
  });

  it("skips finance for a small expense and records why", async () => {
    const { rungs } = await createExpenseApp(T0);
    const { id } = await rungs.submit(expense({ amount: 200 }));
    await rungs.approve({ requestId: id, actorId: "u_bob" });
    const done = await rungs.approve({ requestId: id, actorId: "u_dan" });
    expect(done.status).toBe("approved");
    expect(done.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["manager", "approved"],
      ["finance", "skipped"],
      ["director", "approved"],
    ]);
    const skipped = (await rungs.history(id)).find((e) => e.type === "step.skipped");
    expect(skipped?.data).toMatchObject({ stepId: "finance", reason: { type: "condition-false" } });
  });

  it("refuses an expense from someone without a manager before anything is stored", async () => {
    const { rungs } = await createExpenseApp(T0);
    const preview = await rungs.preview({
      flow: "expense",
      requesterId: "u_carol",
      payload: { amount: 10 },
    });
    expect(preview.submittable).toBe(false);
    await expect(
      rungs.submit({ ...expense({ amount: 10 }), requesterId: "u_carol" }),
    ).rejects.toMatchObject({ code: "NO_APPROVERS", stepId: "manager" });
  });
});
