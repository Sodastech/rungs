import { afterEach, describe, expect, it, vi } from "vitest";

// Each snippet module runs its code when imported; these tests check that what the snippets
// say in their comments is what actually happens.

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = () => {
  const lines: unknown[][] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args);
  });
  return lines;
};

describe("documentation snippets", () => {
  it("quick start: approved", async () => {
    const lines = logged();
    await import("../src/quick-start.js");
    expect(lines).toEqual([["approved"]]);
  });

  it("concepts/flows: a valid flow and every problem of a broken one", async () => {
    logged();
    const { purchase, issues } = await import("../src/concepts/flows.js");
    expect(purchase.steps.map((s) => s.id)).toEqual(["manager", "committee", "legal", "board"]);
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(["steps[0].approvers.ids", "steps[0].deadline"]),
    );
  });

  it("concepts/approvers: union, dedupe and inactive users", async () => {
    const lines = logged();
    const { preview } = await import("../src/concepts/approvers.js");
    expect(preview.steps[0]?.approvers).toEqual(["u_ben", "u_dan"]);
    expect(lines).toEqual([[["u_ben", "u_dan"]], [[{ userId: "u_cat", reason: "inactive" }]]]);
  });

  it("concepts/conditions: a type mismatch refuses the submit", async () => {
    const lines = logged();
    const { refused } = await import("../src/concepts/conditions.js");
    expect(refused).toBeDefined();
    expect(lines).toEqual([["amount", "number", "string"]]);
  });

  it("concepts/delegation: out of office, then a manual hand-over", async () => {
    const lines = logged();
    const { handed } = await import("../src/concepts/delegation.js");
    expect(lines).toEqual([["u_omar", "u_maria"]]);
    expect(handed.steps[0]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
      ["u_maria", "delegated"],
      ["u_lena", "pending"],
    ]);
  });

  it("concepts/deadlines: a reminder, then escalation", async () => {
    const lines = logged();
    const { escalated, ticks } = await import("../src/concepts/deadlines.js");
    expect(lines).toEqual([["remind", "u_mgr"]]);
    expect(ticks.map((t) => t.changed.length)).toEqual([1, 1]);
    const pending = escalated?.steps[0]?.tasks.filter((t) => t.status === "pending");
    expect(pending?.map((t) => t.assigneeId)).toEqual(["u_dir"]);
  });

  it("concepts/return: returned, then pending at the first step again", async () => {
    const lines = logged();
    const { resubmitted } = await import("../src/concepts/return.js");
    expect(lines).toEqual([["returned"], ["pending"]]);
    expect(resubmitted.steps.at(-1)?.stepId).toBe("manager");
    expect(resubmitted.payload).toEqual({ amount: 320 });
  });

  it("concepts/audit: events reach onEvent, and the history lists them in order", async () => {
    const lines = logged();
    const { history, sent } = await import("../src/concepts/audit.js");
    expect(sent.map((e) => e.type)).toEqual(["task.assigned"]);
    expect(history.map((e) => e.seq)).toEqual(history.map((_, i) => i + 1));
    expect(lines.slice(0, 4).map((l) => [l[2], l[3]])).toEqual([
      ["u_req", "request.submitted"],
      ["u_req", "step.activated"],
      ["u_req", "task.assigned"],
      ["u_mgr", "task.approved"],
    ]);
  });

  it("concepts/host-data: the record stays in the app, linked by subject", async () => {
    logged();
    const { page, rows } = await import("../src/concepts/host-data.js");
    expect(page.requests[0]).toMatchObject({
      subject: { type: "expense", id: "EXP-42" },
      payload: { amount: 890 },
    });
    expect(rows[0]).toMatchObject({ id: "EXP-42", title: "Conference hotel" });
  });
});
