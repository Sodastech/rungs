import { describe, expect, it } from "vitest";
import {
  type Calendar,
  type DecidedResult,
  decide,
  type FlowInput,
  InvalidCommandError,
  type RequestState,
  type StepInput,
  type Unchanged,
} from "../../src/index.js";
import {
  approve,
  registeredFlow,
  reject,
  resubmit,
  retryStep,
  returnTo,
  rule,
  run,
  submitCommand,
  T0,
  T1,
  thrown,
  tick,
} from "../helpers/engine.js";

const users = (...ids: string[]) => ({ type: "users" as const, ids });

/** Midnight-free helpers: `day(1)` is T0 plus one day, `day(1, 5)` is that day at 05:00 UTC. */
const day = (n: number, hour = 9) =>
  `2026-01-${String(5 + n).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

/** manager [u_a, u_b] with a one-day deadline, then finance [u_fin]. */
const timed = (step: Partial<StepInput> = {}, flow: Partial<FlowInput> = {}) =>
  registeredFlow({
    key: "expense",
    ...flow,
    steps: [
      { id: "manager", approvers: users("u_a", "u_b"), deadline: "P1D", ...step },
      { id: "finance", approvers: users("u_fin") },
    ],
  });

const submitted = (flow = timed()) => run(null, submitCommand(), { flow }).state;

function decided(result: DecidedResult | Unchanged): DecidedResult {
  if (result.kind !== "decided") throw new Error("expected the tick to change the request");
  return result;
}

const types = (result: DecidedResult) => result.audit.map((e) => e.type);

describe("D. Time", () => {
  describe("deadlines and reminders", () => {
    it("EC-26 activation sets the deadline and the reminder time; the request is due then", () => {
      const state = submitted(timed({ remindBefore: "PT4H" }));
      expect(state.steps[0]?.deadline).toEqual({
        deadlineAt: day(1),
        remindAt: day(1, 5),
        escalationDepth: 0,
        reminders: 0,
      });
      expect(state.nextDueAt).toBe(day(1, 5));
      const plain = run(null, submitCommand()).state;
      expect(plain.steps[0]?.deadline).toBeUndefined();
      expect(plain.nextDueAt).toBeNull();
    });

    it("EC-26 remindBefore sends one reminder per pending task before the deadline", () => {
      const flow = timed({ remindBefore: "PT4H" });
      const result = decided(tick(submitted(flow), day(1, 5), { flow }));
      expect(result.audit.map((e) => [e.type, e.actorId, e.data])).toEqual([
        [
          "task.reminder",
          null,
          {
            taskId: "r1.t1",
            stepId: "manager",
            assigneeId: "u_a",
            deadlineAt: day(1),
            overdue: false,
          },
        ],
        [
          "task.reminder",
          null,
          {
            taskId: "r1.t2",
            stepId: "manager",
            assigneeId: "u_b",
            deadlineAt: day(1),
            overdue: false,
          },
        ],
      ]);
      expect(result.state.steps[0]?.deadline?.remindedAt).toBe(day(1, 5));
      expect(result.state.nextDueAt).toBe(day(1));
    });

    it("EC-26 at the deadline onTimeout remind (default) reminds again and keeps the tasks", () => {
      const flow = timed();
      const result = decided(tick(submitted(flow), day(1), { flow }));
      expect(result.audit.map((e) => [e.type, e.data])).toEqual([
        [
          "task.reminder",
          {
            taskId: "r1.t1",
            stepId: "manager",
            assigneeId: "u_a",
            deadlineAt: day(1),
            overdue: true,
            count: 1,
          },
        ],
        [
          "task.reminder",
          {
            taskId: "r1.t2",
            stepId: "manager",
            assigneeId: "u_b",
            deadlineAt: day(1),
            overdue: true,
            count: 1,
          },
        ],
      ]);
      expect(result.state.steps[0]?.tasks.map((t) => t.status)).toEqual(["pending", "pending"]);
      expect(result.state.steps[0]?.deadline).toMatchObject({
        timedOutAt: day(1),
        reminders: 1,
        nextReminderAt: day(2),
      });
      expect(result.state.nextDueAt).toBe(day(2));
    });

    it("EC-26 a tick after the deadline skips the reminder that was due before it", () => {
      const flow = timed({ remindBefore: "PT4H" });
      const result = decided(tick(submitted(flow), day(1, 10), { flow }));
      expect(result.audit.every((e) => e.type === "task.reminder")).toBe(true);
      expect(result.audit.map((e) => e.data)).toEqual([
        expect.objectContaining({ overdue: true, count: 1 }),
        expect.objectContaining({ overdue: true, count: 1 }),
      ]);
    });

    it("EC-55 an overdue task is reminded again every remindOverdueEvery (default P1D)", () => {
      const flow = timed();
      const first = decided(tick(submitted(flow), day(1), { flow })).state;
      const second = decided(tick(first, day(2), { flow }));
      expect(second.audit.map((e) => e.data)).toEqual([
        expect.objectContaining({ assigneeId: "u_a", overdue: true, count: 2 }),
        expect.objectContaining({ assigneeId: "u_b", overdue: true, count: 2 }),
      ]);
      expect(second.state.nextDueAt).toBe(day(3));
    });

    it("EC-55 a late tick sends one reminder, not one per missed interval", () => {
      const flow = timed();
      const first = decided(tick(submitted(flow), day(1), { flow })).state;
      const late = decided(tick(first, day(4, 12), { flow }));
      expect(late.audit).toHaveLength(2);
      expect(late.audit[0]?.data).toMatchObject({ count: 2 });
      expect(late.state.steps[0]?.deadline?.nextReminderAt).toBe(day(5));
    });

    it("EC-55 remindOverdueEvery never stops after the reminder at the deadline", () => {
      const flow = timed({}, { remindOverdueEvery: "never" });
      const first = decided(tick(submitted(flow), day(1), { flow })).state;
      expect(first.nextDueAt).toBeNull();
      expect(tick(first, day(9), { flow }).kind).toBe("unchanged");
    });

    it("EC-26 onTimeout auto-approve expires the tasks and moves on, as a system action", () => {
      const flow = timed({ onTimeout: "auto-approve" });
      const result = decided(tick(submitted(flow), day(1), { flow }));
      expect(result.audit.map((e) => [e.type, e.actorId])).toEqual([
        ["task.expired", null],
        ["task.expired", null],
        ["step.timed_out", null],
        ["step.completed", null],
        ["step.activated", null],
        ["task.assigned", null],
      ]);
      expect(result.audit[2]?.data).toEqual({
        stepId: "manager",
        stepIndex: 0,
        action: "auto-approve",
      });
      expect(result.state.steps[0]?.tasks.map((t) => t.status)).toEqual(["expired", "expired"]);
      expect(result.state.steps[1]).toMatchObject({ stepId: "finance", status: "active" });
    });

    it("EC-26 onTimeout auto-reject expires the tasks and rejects the request", () => {
      const flow = timed({ onTimeout: "auto-reject" });
      const result = decided(tick(submitted(flow), day(1), { flow }));
      expect(types(result)).toEqual([
        "task.expired",
        "task.expired",
        "step.timed_out",
        "step.completed",
        "request.rejected",
      ]);
      expect(result.state.status).toBe("rejected");
      expect(result.audit.at(-1)?.data).toEqual({ reason: "timeout", stepId: "manager" });
    });

    it("EC-27 a tick applies each action once: repeated or early ticks change nothing", () => {
      const flow = timed({ onTimeout: "auto-approve" });
      const state = submitted(flow);
      expect(tick(state, day(0, 23), { flow })).toEqual({ kind: "unchanged" });
      const once = decided(tick(state, day(1), { flow })).state;
      expect(tick(once, day(1), { flow })).toEqual({ kind: "unchanged" });
      const closed = run(null, submitCommand(), { flow }).state;
      const rejected = run(closed, reject("u_a"), { flow }).state;
      expect(tick(rejected, day(5), { flow })).toEqual({ kind: "unchanged" });
    });
  });

  describe("escalation", () => {
    const escalating = (step: Partial<StepInput> = {}, flow: Partial<FlowInput> = {}) =>
      timed({ onTimeout: "escalate", escalateTo: { type: "role", role: "lead" }, ...step }, flow);

    it("EC-28 a timed-out step escalates: old tasks expire and the target gets a new deadline", () => {
      const flow = escalating();
      const state = submitted(flow);
      expect(decide(state, { type: "tick", requestId: "r1" }, { now: day(1), flow })).toEqual({
        kind: "needs-resolution",
        needs: [
          {
            key: "escalate:manager",
            stepId: "manager",
            spec: { type: "role", role: "lead" },
            escalationDepth: 1,
          },
        ],
      });
      const result = decided(
        tick(state, day(1), { flow, approvers: { "escalate:manager": ["u_lead"] } }),
      );
      expect(types(result)).toEqual([
        "task.expired",
        "task.expired",
        "request.escalated",
        "task.assigned",
      ]);
      expect(result.audit[2]?.data).toEqual({
        stepId: "manager",
        stepIndex: 0,
        depth: 1,
        toUserIds: ["u_lead"],
      });
      expect(result.state.steps[0]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
        ["u_a", "expired"],
        ["u_b", "expired"],
        ["u_lead", "pending"],
      ]);
      expect(result.state.steps[0]?.deadline).toEqual({
        deadlineAt: day(2),
        escalationDepth: 1,
        reminders: 0,
      });
      const approved = run(result.state, approve("u_lead"), { flow });
      expect(approved.state.steps[1]?.status).toBe("active");
    });

    it("EC-28 it escalates again until maxEscalationDepth, then keeps the task and alerts", () => {
      const flow = escalating({}, { maxEscalationDepth: 2 });
      const approvers = { "escalate:manager": ["u_lead"] };
      const first = decided(tick(submitted(flow), day(1), { flow, approvers })).state;
      const second = decided(
        tick(first, day(2), { flow, approvers: { "escalate:manager": ["u_head"] } }),
      ).state;
      expect(second.steps[0]?.deadline?.escalationDepth).toBe(2);
      const failed = decided(tick(second, day(3), { flow, approvers }));
      expect(types(failed)).toEqual(["request.escalation_failed"]);
      expect(failed.audit[0]).toMatchObject({
        actorId: null,
        data: { stepId: "manager", stepIndex: 0, depth: 2, reason: "max-depth" },
      });
      expect(failed.state.steps[0]?.tasks.at(-1)).toMatchObject({
        assigneeId: "u_head",
        status: "pending",
      });
      expect(failed.state.nextDueAt).toBe(day(4));
      const reminded = decided(tick(failed.state, day(4), { flow }));
      expect(reminded.audit[0]).toMatchObject({
        type: "task.reminder",
        data: { assigneeId: "u_head", overdue: true, count: 1 },
      });
    });

    it("EC-28 an empty escalation target keeps the tasks pending and alerts", () => {
      const flow = escalating();
      const result = decided(
        tick(submitted(flow), day(1), { flow, approvers: { "escalate:manager": [] } }),
      );
      expect(result.audit.map((e) => [e.type, e.data])).toEqual([
        [
          "request.escalation_failed",
          {
            stepId: "manager",
            stepIndex: 0,
            depth: 0,
            reason: "too-few-targets",
            required: 1,
            available: 0,
          },
        ],
      ]);
      expect(result.state.steps[0]?.tasks.map((t) => t.status)).toEqual(["pending", "pending"]);
    });

    it("EC-54 a target who already voted in the step is removed; too few left fails safe", () => {
      const flow = escalating({ approvers: users("u_a", "u_b", "u_c"), mode: "all" });
      const afterA = run(submitted(flow), approve("u_a"), { flow, now: T1 }).state;
      const failed = decided(
        tick(afterA, day(1), { flow, approvers: { "escalate:manager": ["u_a", "u_x"] } }),
      );
      expect(failed.audit[0]).toMatchObject({
        type: "request.escalation_failed",
        data: {
          reason: "too-few-targets",
          required: 2,
          available: 1,
          removed: [{ userId: "u_a", reason: "already-voted" }],
        },
      });

      const escalated = decided(
        tick(afterA, day(1), { flow, approvers: { "escalate:manager": ["u_a", "u_x", "u_y"] } }),
      );
      expect(escalated.audit.find((e) => e.type === "request.escalated")?.data).toMatchObject({
        toUserIds: ["u_x", "u_y"],
        removed: [{ userId: "u_a", reason: "already-voted" }],
      });
      const x = run(escalated.state, approve("u_x"), { flow }).state;
      expect(x.steps[0]?.status).toBe("active");
      const y = run(x, approve("u_y"), { flow }).state;
      expect(y.steps[0]?.status).toBe("approved");
    });

    it("EC-54 a target who approved an earlier step is removed", () => {
      const flow = registeredFlow({
        key: "expense",
        steps: [
          { id: "manager", approvers: users("u_m") },
          {
            id: "board",
            approvers: users("u_a"),
            deadline: "P1D",
            onTimeout: "escalate",
            escalateTo: { type: "role", role: "lead" },
          },
        ],
      });
      const state = run(run(null, submitCommand(), { flow }).state, approve("u_m"), {
        flow,
        now: T1,
      }).state;
      const result = decided(
        tick(state, day(1, 10), { flow, approvers: { "escalate:board": ["u_m", "u_x"] } }),
      );
      expect(result.audit.find((e) => e.type === "request.escalated")?.data).toMatchObject({
        toUserIds: ["u_x"],
        removed: [{ userId: "u_m", reason: "already-voted" }],
      });
    });

    it("EC-54 targets pass the usual pipeline: requester and inactive removed, delegation applied", () => {
      const flow = escalating();
      const result = decided(
        tick(submitted(flow), day(1), {
          flow,
          approvers: { "escalate:manager": ["u_req", "u_old", "u_x"] },
          inactive: ["u_old"],
          delegations: [rule("u_x", "u_y")],
        }),
      );
      expect(result.audit.find((e) => e.type === "request.escalated")?.data).toMatchObject({
        toUserIds: ["u_x"],
        removed: [
          { userId: "u_req", reason: "requester" },
          { userId: "u_old", reason: "inactive" },
        ],
      });
      expect(result.state.steps[0]?.tasks.at(-1)).toMatchObject({
        assigneeId: "u_y",
        onBehalfOf: "u_x",
      });
    });
  });

  describe("calendar and time zones", () => {
    it("EC-30 deadlines and reminders are computed by the injected calendar", () => {
      const calls: string[] = [];
      const calendar: Calendar = {
        addDuration: (start, duration) => {
          calls.push(`add ${start} ${duration}`);
          return "2026-01-07T09:00:00.000Z";
        },
        subtractDuration: (end, duration) => {
          calls.push(`subtract ${end} ${duration}`);
          return "2026-01-07T05:00:00.000Z";
        },
      };
      const flow = timed({ remindBefore: "PT4H" });
      const { state } = run(null, submitCommand(), { flow, calendar });
      expect(state.steps[0]?.deadline).toMatchObject({
        deadlineAt: "2026-01-07T09:00:00.000Z",
        remindAt: "2026-01-07T05:00:00.000Z",
      });
      expect(calls).toEqual([`add ${T0} P1D`, "subtract 2026-01-07T09:00:00.000Z PT4H"]);
    });

    it("EC-30 a calendar that returns something other than an ISO 8601 UTC time is refused", () => {
      const calendar: Calendar = {
        addDuration: () => "next tuesday",
        subtractDuration: () => "2026-01-07T05:00:00.000Z",
      };
      const error = thrown(() => run(null, submitCommand(), { flow: timed(), calendar }));
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect((error as Error).message).toContain("calendar.addDuration");
    });

    it("EC-31 durations are absolute and every stored time is UTC", () => {
      const { state } = run(null, submitCommand(), {
        flow: timed({ deadline: "PT36H" }),
        now: "2026-01-05T09:00:00Z",
      });
      expect(state.steps[0]?.deadline?.deadlineAt).toBe("2026-01-06T21:00:00.000Z");
    });
  });

  describe("waiting for the requester", () => {
    const returnable = (flow: Partial<FlowInput>) =>
      registeredFlow({
        key: "expense",
        ...flow,
        steps: [{ id: "manager", approvers: users("u_a") }],
      });
    const returned = (flow: ReturnType<typeof returnable>) =>
      run(submitted(flow), returnTo("u_a", "requester"), { flow, now: T1 }).state;

    it("EC-52 by default a returned request waits without a time limit", () => {
      const flow = returnable({});
      const state = returned(flow);
      expect(state.resubmit).toBeUndefined();
      expect(state.nextDueAt).toBeNull();
    });

    it("EC-52 resubmitDeadline with remind alerts once and leaves the request returned", () => {
      const flow = returnable({ resubmitDeadline: "P2D" });
      const state = returned(flow);
      expect(state.resubmit).toEqual({ dueAt: day(2, 10) });
      expect(state.nextDueAt).toBe(day(2, 10));
      const result = decided(tick(state, day(2, 10), { flow }));
      expect(result.audit.map((e) => [e.type, e.actorId, e.data])).toEqual([
        ["request.resubmit_overdue", null, { stepId: "manager", dueAt: day(2, 10) }],
      ]);
      expect(result.state.status).toBe("returned");
      expect(tick(result.state, day(6), { flow }).kind).toBe("unchanged");
      const again = run(result.state, resubmit(), { flow }).state;
      expect(again.resubmit).toBeUndefined();
    });

    it("EC-52 with auto-withdraw the request is withdrawn by the system, with the reason", () => {
      const flow = returnable({ resubmitDeadline: "P2D", onResubmitTimeout: "auto-withdraw" });
      const result = decided(tick(returned(flow), day(2, 10), { flow }));
      expect(result.state).toMatchObject({ status: "withdrawn", closedAt: day(2, 10) });
      expect(result.audit.map((e) => [e.type, e.actorId, e.data])).toEqual([
        ["request.withdrawn", null, { reason: "resubmit-timeout" }],
      ]);
    });
  });

  describe("blocked steps", () => {
    const blockable = (flow: Partial<FlowInput> = {}) =>
      registeredFlow({
        key: "expense",
        ...flow,
        steps: [
          { id: "manager", approvers: users("u_mgr") },
          { id: "finance", approvers: { type: "role", role: "finance" }, deadline: "P1D" },
        ],
      });
    const blocked = (flow: ReturnType<typeof blockable>): RequestState => {
      const state = run(null, submitCommand(), { flow, approvers: { finance: ["u_fin"] } }).state;
      return run(state, approve("u_mgr"), { flow, now: T1, approvers: { finance: [] } }).state;
    };

    it("EC-53 a blocked step reminds the admin every remindBlockedEvery (default P1D)", () => {
      const flow = blockable();
      const state = blocked(flow);
      expect(state.steps[1]?.blockedReminder).toEqual({ nextAt: day(1, 10), count: 0 });
      expect(state.steps[1]?.deadline).toBeUndefined();
      expect(state.nextDueAt).toBe(day(1, 10));
      const result = decided(tick(state, day(1, 10), { flow }));
      expect(result.audit.map((e) => [e.type, e.actorId, e.data])).toEqual([
        [
          "step.still_blocked",
          null,
          {
            stepId: "finance",
            stepIndex: 1,
            blockedSince: T1,
            reason: { type: "no-approvers" },
            count: 1,
          },
        ],
      ]);
      expect(result.state.nextDueAt).toBe(day(2, 10));
    });

    it("EC-53 a late tick sends one reminder and schedules the next one after now", () => {
      const flow = blockable();
      const result = decided(tick(blocked(flow), day(4, 12), { flow }));
      expect(result.audit).toHaveLength(1);
      expect(result.state.steps[1]?.blockedReminder).toEqual({ nextAt: day(5, 10), count: 1 });
    });

    it("EC-53 never turns the reminder off; unblocking clears it and starts the deadline", () => {
      const off = blockable({ remindBlockedEvery: "never" });
      const quiet = blocked(off);
      expect(quiet.nextDueAt).toBeNull();
      expect(tick(quiet, day(9), { flow: off }).kind).toBe("unchanged");

      const flow = blockable();
      const unblocked = run(blocked(flow), retryStep("finance"), {
        flow,
        now: day(1),
        approvers: { finance: ["u_fin"] },
      }).state;
      expect(unblocked.steps[1]?.blockedReminder).toBeUndefined();
      expect(unblocked.steps[1]?.deadline?.deadlineAt).toBe(day(2));
    });
  });
});
