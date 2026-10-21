import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine.js";
import {
  type FlowInput,
  InvalidCommandError,
  NoApproversError,
  NotAssignedError,
  type RegisteredFlow,
  type RequestState,
  ResolutionError,
  type StepInput,
} from "../../src/index.js";
import { collectResolution, type ResolutionHooks } from "../../src/resolution/collect.js";
import {
  approve,
  expenseFlow,
  override,
  reassignStep,
  registeredFlow,
  reject,
  retryStep,
  run,
  runAll,
  submitCommand,
  T0,
  T1,
  T2,
  thrown,
} from "../helpers/engine.js";

const managerStep: StepInput = { id: "manager", approvers: { type: "role", role: "manager" } };
const financeStep: StepInput = { id: "finance", approvers: { type: "role", role: "finance" } };

const flow = (overrides: Partial<FlowInput> = {}, steps = [managerStep, financeStep]) =>
  registeredFlow({ key: "expense", steps, ...overrides });

const ok = { manager: ["u_mgr"], finance: ["u_fin"] };

const users = (...ids: string[]) => ({ type: "users" as const, ids });

/** Submits with every step resolvable, then lets `approve("u_mgr")` meet `finance` approvers. */
function blockFinance(finance: string[], target: RegisteredFlow = flow()) {
  const submitted = run(null, submitCommand(), {
    flow: target,
    approvers: { ...ok, finance: ["u_fin", "u_fin2"] },
  });
  return run(submitted.state, approve("u_mgr"), {
    flow: target,
    now: T1,
    approvers: { finance },
  });
}

describe("A. Approver resolution", () => {
  describe("requester and inactive users", () => {
    it("EC-01 the requester is removed from the step's approvers and the removal is recorded", () => {
      const { state, audit } = run(null, submitCommand(), {
        flow: flow(),
        approvers: { manager: ["u_req", "u_mgr"], finance: ["u_fin"] },
      });
      expect(state.steps[0]).toMatchObject({
        approvers: ["u_mgr"],
        removed: [{ userId: "u_req", reason: "requester" }],
      });
      expect(state.steps[0]?.tasks.map((t) => t.assigneeId)).toEqual(["u_mgr"]);
      expect(audit.find((e) => e.type === "step.activated")?.data).toEqual({
        stepId: "manager",
        stepIndex: 0,
        approvers: ["u_mgr"],
        removed: [{ userId: "u_req", reason: "requester" }],
      });
    });

    it("EC-01 with allowSelfApproval the requester keeps their task", () => {
      const { state } = run(null, submitCommand(), {
        flow: flow({ allowSelfApproval: true }),
        approvers: { manager: ["u_req", "u_mgr"], finance: ["u_fin"] },
      });
      expect(state.steps[0]?.approvers).toEqual(["u_req", "u_mgr"]);
      expect(state.steps[0]?.removed).toBeUndefined();
    });

    it("EC-02 a step emptied by removing the requester refuses the submit by default", () => {
      const error = thrown(() =>
        run(null, submitCommand(), { flow: flow(), approvers: { ...ok, manager: ["u_req"] } }),
      );
      expect(error).toBeInstanceOf(NoApproversError);
      expect(error).toMatchObject({
        code: "NO_APPROVERS",
        stepId: "manager",
        reason: { type: "no-approvers" },
        removed: [{ userId: "u_req", reason: "requester" }],
      });
    });

    it("EC-02 with onEmptyStep skip the emptied step is skipped and the removal recorded", () => {
      const { state, audit } = run(null, submitCommand(), {
        flow: flow({ onEmptyStep: "skip" }),
        approvers: { ...ok, manager: ["u_req"] },
      });
      expect(state.steps.map((s) => [s.stepId, s.status])).toEqual([
        ["manager", "skipped"],
        ["finance", "active"],
      ]);
      expect(audit.find((e) => e.type === "step.skipped")?.data).toEqual({
        stepId: "manager",
        stepIndex: 0,
        reason: { type: "no-approvers" },
        removed: [{ userId: "u_req", reason: "requester" }],
      });
    });

    it("EC-06 an inactive approver is removed with the reason recorded", () => {
      const { state } = run(null, submitCommand(), {
        flow: flow(),
        approvers: { ...ok, manager: ["u_old", "u_mgr"] },
        inactive: ["u_old"],
      });
      expect(state.steps[0]).toMatchObject({
        approvers: ["u_mgr"],
        removed: [{ userId: "u_old", reason: "inactive" }],
      });
    });

    it("EC-06 a step whose approvers are all inactive is treated as empty (EC-02)", () => {
      const error = thrown(() =>
        run(null, submitCommand(), {
          flow: flow(),
          approvers: { ...ok, finance: ["u_old"] },
          inactive: ["u_old", "u_req"],
        }),
      );
      expect(error).toMatchObject({
        code: "NO_APPROVERS",
        stepId: "finance",
        removed: [{ userId: "u_old", reason: "inactive" }],
      });
    });
  });

  describe("dedupe", () => {
    const steps = (finance: Partial<StepInput> = {}): StepInput[] => [
      { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
      { id: "finance", approvers: { type: "users", ids: ["u_mgr", "u_fin"] }, ...finance },
    ];

    it("EC-03 an approver of the previous step is auto-approved as skipped-duplicate", () => {
      const target = flow({}, [
        steps()[0] as StepInput,
        { id: "finance", approvers: users("u_mgr") },
      ]);
      const { state, audit } = runAll([submitCommand(), approve("u_mgr")], { flow: target });
      expect(state.status).toBe("approved");
      expect(state.steps[1]).toMatchObject({ status: "approved", approvers: ["u_mgr"] });
      expect(state.steps[1]?.tasks.map((t) => [t.id, t.assigneeId, t.status])).toEqual([
        ["r1.t2", "u_mgr", "skipped-duplicate"],
      ]);
      expect(audit.map((e) => e.type)).toEqual([
        "task.approved",
        "step.completed",
        "step.activated",
        "task.deduplicated",
        "step.completed",
        "request.approved",
      ]);
      expect(audit[3]?.data).toEqual({
        taskId: "r1.t2",
        stepId: "finance",
        assigneeId: "u_mgr",
        ofTaskId: "r1.t1",
      });
    });

    it("EC-03 the carried-over decision counts as one approval in mode all", () => {
      const target = flow({}, steps({ mode: "all" }));
      const partial = runAll([submitCommand(), approve("u_mgr")], { flow: target });
      expect(partial.state.steps[1]?.status).toBe("active");
      expect(partial.state.steps[1]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
        ["u_mgr", "skipped-duplicate"],
        ["u_fin", "pending"],
      ]);
      const done = runAll([submitCommand(), approve("u_mgr"), approve("u_fin")], { flow: target });
      expect(done.state.status).toBe("approved");
    });

    it("EC-03 with dedupeApprovers none the repeated approver decides again", () => {
      const target = flow({ dedupeApprovers: "none" }, steps());
      const { state } = runAll([submitCommand(), approve("u_mgr")], { flow: target });
      expect(state.steps[1]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
        ["u_mgr", "pending"],
        ["u_fin", "pending"],
      ]);
    });

    it("EC-03 consecutive looks only at the previous step that ran; all looks at every step", () => {
      const three = (dedupeApprovers: "consecutive" | "all") =>
        registeredFlow({
          key: "expense",
          dedupeApprovers,
          steps: [
            { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
            { id: "finance", approvers: { type: "users", ids: ["u_fin"] } },
            { id: "director", approvers: { type: "users", ids: ["u_mgr"] } },
          ],
        });
      const commands = [submitCommand(), approve("u_mgr"), approve("u_fin")];
      const consecutive = runAll(commands, { flow: three("consecutive") });
      expect(consecutive.state.steps[2]?.tasks[0]?.status).toBe("pending");
      const all = runAll(commands, { flow: three("all") });
      expect(all.state.status).toBe("approved");
      expect(all.state.steps[2]?.tasks[0]?.status).toBe("skipped-duplicate");
    });

    it("EC-03 a skipped step in between does not break consecutive dedupe", () => {
      const target = registeredFlow({
        key: "expense",
        steps: [
          { id: "manager", approvers: { type: "users", ids: ["u_mgr"] } },
          {
            id: "finance",
            approvers: { type: "users", ids: ["u_fin"] },
            when: { field: "amount", op: "gt", value: 1000 },
          },
          { id: "director", approvers: { type: "users", ids: ["u_mgr"] } },
        ],
      });
      const { state } = runAll([submitCommand({ payload: { amount: 10 } }), approve("u_mgr")], {
        flow: target,
      });
      expect(state.status).toBe("approved");
      expect(state.steps.map((s) => s.status)).toEqual(["approved", "skipped", "approved"]);
    });

    it("EC-03 an approver who was superseded made no decision and is asked again", () => {
      const target = registeredFlow({
        key: "expense",
        steps: [
          { id: "reviewers", approvers: { type: "users", ids: ["u_a", "u_b"] } },
          { id: "final", approvers: { type: "users", ids: ["u_b"] } },
        ],
      });
      const { state } = runAll([submitCommand(), approve("u_a")], { flow: target });
      expect(state.steps[1]?.tasks.map((t) => [t.assigneeId, t.status])).toEqual([
        ["u_b", "pending"],
      ]);
    });

    describe("separation of duties", () => {
      const twoSteps = (finance: StepInput) =>
        flow({}, [{ id: "manager", approvers: users("u_a", "u_b"), mode: "all" }, finance]);
      const approved = [submitCommand(), approve("u_a"), approve("u_b")];
      const statuses = (state: RequestState) =>
        state.steps[1]?.tasks.map((t) => [t.assigneeId, t.status]);

      it("EC-47 in mode any a carried-over approval does not close the step while others can decide", () => {
        const target = twoSteps({ id: "finance", approvers: users("u_a", "u_fin") });
        const { state } = runAll(approved, { flow: target });
        expect(state.steps[1]?.status).toBe("active");
        expect(statuses(state)).toEqual([
          ["u_a", "skipped-duplicate"],
          ["u_fin", "pending"],
        ]);
        expect(runAll([...approved, approve("u_fin")], { flow: target }).state.status).toBe(
          "approved",
        );
        expect(runAll([...approved, reject("u_fin")], { flow: target }).state.status).toBe(
          "rejected",
        );
      });

      it("EC-47 the only approvers left are all carried over: the step is approved at once", () => {
        const target = twoSteps({ id: "finance", approvers: users("u_a", "u_b"), mode: "all" });
        const { state } = runAll(approved, { flow: target });
        expect(state.status).toBe("approved");
        expect(statuses(state)).toEqual([
          ["u_a", "skipped-duplicate"],
          ["u_b", "skipped-duplicate"],
        ]);
      });

      it("EC-47 in a quorum step carried-over votes count but one fresh approval is required", () => {
        const target = twoSteps({
          id: "finance",
          approvers: users("u_a", "u_b", "u_c"),
          mode: { quorum: 2 },
        });
        const waiting = runAll(approved, { flow: target });
        expect(waiting.state.steps[1]?.status).toBe("active");
        expect(runAll([...approved, approve("u_c")], { flow: target }).state.status).toBe(
          "approved",
        );
        const rejected = runAll([...approved, reject("u_c")], { flow: target });
        expect(rejected.state.status).toBe("rejected");
        expect(rejected.state.steps[1]?.status).toBe("rejected");
      });

      it("EC-47 in a quorum step a carried-over vote is one vote; the rest come from fresh decisions", () => {
        const target = flow({}, [
          { id: "manager", approvers: users("u_a") },
          { id: "finance", approvers: users("u_a", "u_c", "u_d"), mode: { quorum: 3 } },
        ]);
        const start = [submitCommand(), approve("u_a"), approve("u_c")];
        expect(runAll(start, { flow: target }).state.steps[1]?.status).toBe("active");
        expect(runAll([...start, approve("u_d")], { flow: target }).state.status).toBe("approved");
      });

      it("EC-47 the same rule applies to users chosen by reassign", () => {
        const target = flow({}, [
          { id: "manager", approvers: users("u_mgr") },
          { id: "finance", approvers: { type: "role", role: "finance" } },
        ]);
        const submitted = run(null, submitCommand(), {
          flow: target,
          approvers: { finance: ["u_fin"] },
        });
        const blocked = run(submitted.state, approve("u_mgr"), {
          flow: target,
          approvers: { finance: [] },
        }).state;

        const withOther = run(blocked, reassignStep("finance", ["u_mgr", "u_x"]), { flow: target });
        expect(withOther.state.steps[1]?.status).toBe("active");
        expect(statuses(withOther.state)).toEqual([
          ["u_mgr", "skipped-duplicate"],
          ["u_x", "pending"],
        ]);

        const alone = run(blocked, reassignStep("finance", ["u_mgr"]), { flow: target });
        expect(alone.state.status).toBe("approved");
      });
    });

    it("EC-44 the same user reached twice through a union gets a single task", async () => {
      const target = registeredFlow({
        key: "expense",
        steps: [
          {
            id: "manager",
            approvers: {
              type: "union",
              of: [
                { type: "users", ids: ["u_a", "u_b"] },
                { type: "role", role: "finance" },
              ],
            },
          },
        ],
      });
      const need = {
        key: "manager",
        stepId: "manager",
        spec: target.steps[0]?.approvers ?? managerStep.approvers,
      };
      const resolution = await collectResolution(need, { roles: () => ["u_b", "u_c"] }, context);
      expect(resolution).toEqual({ userIds: ["u_a", "u_b", "u_c"] });

      const { state } = run(null, submitCommand(), {
        flow: target,
        approvers: { manager: ["u_a", "u_b", "u_b", "u_c"] },
      });
      expect(state.steps[0]?.tasks.map((t) => t.assigneeId)).toEqual(["u_a", "u_b", "u_c"]);
    });
  });

  describe("empty steps", () => {
    it("EC-04 an empty resolution refuses the submit by default and nothing is created", () => {
      const error = thrown(() =>
        run(null, submitCommand(), { flow: flow(), approvers: { ...ok, manager: [] } }),
      );
      expect(error).toBeInstanceOf(NoApproversError);
      expect(error).toMatchObject({
        code: "NO_APPROVERS",
        stepId: "manager",
        reason: { type: "no-approvers" },
        removed: [],
      });
    });

    it("EC-04 with onEmptyStep skip the step is skipped with the reason recorded", () => {
      const { state, audit } = run(null, submitCommand(), {
        flow: flow({ onEmptyStep: "skip" }),
        approvers: { manager: [], finance: ["u_fin"] },
      });
      expect(state.steps.map((s) => [s.stepId, s.status])).toEqual([
        ["manager", "skipped"],
        ["finance", "active"],
      ]);
      expect(state.steps[0]?.skipReason).toEqual({ type: "no-approvers" });
      expect(audit.find((e) => e.type === "step.skipped")?.data).toEqual({
        stepId: "manager",
        stepIndex: 0,
        reason: { type: "no-approvers" },
      });
    });

    it("EC-43 submit asks for the approvers of every applicable step at once", () => {
      const ctx = { now: T0, flow: expenseFlow };
      expect(decide(null, submitCommand(), ctx)).toEqual({
        kind: "needs-resolution",
        needs: [
          { key: "manager", stepId: "manager", spec: { type: "users", ids: ["u_mgr"] } },
          { key: "finance", stepId: "finance", spec: { type: "users", ids: ["u_fin"] } },
          { key: "director", stepId: "director", spec: { type: "users", ids: ["u_dir"] } },
        ],
      });
      const small = decide(null, submitCommand({ payload: { amount: 10 } }), ctx);
      expect(small.kind === "needs-resolution" && small.needs.map((n) => n.stepId)).toEqual([
        "manager",
        "director",
      ]);
    });

    it("EC-43 a later step with no approvers refuses the submit, naming the step", () => {
      const error = thrown(() =>
        run(null, submitCommand(), { flow: flow(), approvers: { ...ok, finance: [] } }),
      );
      expect(error).toBeInstanceOf(NoApproversError);
      expect(error).toMatchObject({ stepId: "finance", reason: { type: "no-approvers" } });
      expect((error as Error).message).toContain('"finance"');
    });

    it("EC-43 the dry run is not stored: later steps are resolved again when they activate", () => {
      const submitted = run(null, submitCommand(), { flow: flow(), approvers: ok });
      expect(submitted.state.steps).toHaveLength(1);
      const ctx = { now: T1, flow: flow() };
      const decision = decide(submitted.state, approve("u_mgr"), ctx);
      expect(decision).toEqual({
        kind: "needs-resolution",
        needs: [{ key: "finance", stepId: "finance", spec: financeStep.approvers }],
      });
      const { state } = run(submitted.state, approve("u_mgr"), {
        flow: flow(),
        approvers: { finance: ["u_fin2"] },
      });
      expect(state.steps[1]?.approvers).toEqual(["u_fin2"]);
    });

    it("EC-42 a step that resolves to nobody mid-flow is blocked; the approval still succeeds", () => {
      const { state, audit, events } = blockFinance([]);
      expect(state.status).toBe("pending");
      expect(state.currentStepIndex).toBe(1);
      expect(state.steps[0]?.status).toBe("approved");
      expect(state.steps[1]).toEqual({
        stepId: "finance",
        index: 1,
        status: "blocked",
        blockedAt: T1,
        blockReason: { type: "no-approvers" },
        blockedReminder: { nextAt: "2026-01-06T10:00:00.000Z", count: 0 },
        approvers: [],
        tasks: [],
      });
      expect(audit.map((e) => e.type)).toEqual(["task.approved", "step.completed", "step.blocked"]);
      expect(audit[2]).toMatchObject({
        actorId: "u_mgr",
        data: { stepId: "finance", stepIndex: 1, reason: { type: "no-approvers" } },
      });
      expect(events.map((e) => e.type)).toContain("step.blocked");
    });

    it("EC-42 the reason for a blocked step includes removed approvers", () => {
      const { state, audit } = blockFinance(["u_req"]);
      expect(state.steps[1]?.removed).toEqual([{ userId: "u_req", reason: "requester" }]);
      expect(audit.at(-1)?.data).toMatchObject({
        removed: [{ userId: "u_req", reason: "requester" }],
      });
    });

    it("EC-42 nobody can approve or reject a blocked step", () => {
      const { state } = blockFinance([]);
      for (const command of [approve("u_fin"), reject("u_fin"), approve("u_mgr")]) {
        expect(thrown(() => run(state, command, { flow: flow() }))).toBeInstanceOf(
          NotAssignedError,
        );
      }
    });

    it("EC-42 with onEmptyStep skip a step emptied mid-flow is skipped instead", () => {
      const { state } = blockFinance([], flow({ onEmptyStep: "skip" }));
      expect(state.status).toBe("approved");
      expect(state.steps[1]).toMatchObject({
        status: "skipped",
        skipReason: { type: "no-approvers" },
      });
    });
  });

  describe("quorum", () => {
    const quorumFlow = (overrides: Partial<FlowInput> = {}) =>
      flow(overrides, [managerStep, { ...financeStep, mode: { quorum: 2 } }]);

    it("EC-45 a quorum larger than the resolved approvers refuses the submit", () => {
      const error = thrown(() =>
        run(null, submitCommand(), {
          flow: quorumFlow(),
          approvers: { ...ok, finance: ["u_req", "u_f1"] },
        }),
      );
      expect(error).toBeInstanceOf(NoApproversError);
      expect(error).toMatchObject({
        stepId: "finance",
        reason: { type: "quorum-unreachable", required: 2, available: 1 },
        removed: [{ userId: "u_req", reason: "requester" }],
      });
    });

    it("EC-45 mid-flow the step is blocked as quorum-unreachable, even with onEmptyStep skip", () => {
      for (const target of [quorumFlow(), quorumFlow({ onEmptyStep: "skip" })]) {
        const submitted = run(null, submitCommand(), {
          flow: target,
          approvers: { ...ok, finance: ["u_f1", "u_f2"] },
        });
        const { state } = run(submitted.state, approve("u_mgr"), {
          flow: target,
          approvers: { finance: ["u_f1"] },
        });
        expect(state.steps[1]).toMatchObject({
          status: "blocked",
          blockReason: { type: "quorum-unreachable", required: 2, available: 1 },
        });
      }
    });
  });

  describe("unblocking", () => {
    it("EC-46 reassign gives the blocked step to the users the admin chose", () => {
      const blocked = blockFinance([]).state;
      const needs = decide(blocked, reassignStep("finance", ["u_fin2"]), { now: T2, flow: flow() });
      expect(needs).toEqual({
        kind: "needs-resolution",
        needs: [
          { key: "reassign:finance", stepId: "finance", spec: { type: "users", ids: ["u_fin2"] } },
        ],
      });

      const { state, audit } = run(blocked, reassignStep("finance", ["u_fin2"]), {
        flow: flow(),
        now: T2,
      });
      expect(state.steps).toHaveLength(2);
      expect(state.steps[1]).toMatchObject({
        status: "active",
        activatedAt: T2,
        approvers: ["u_fin2"],
        tasks: [{ id: "r1.t2", assigneeId: "u_fin2", status: "pending" }],
      });
      expect(audit.map((e) => [e.type, e.actorId])).toEqual([
        ["step.reassigned", "u_admin"],
        ["step.activated", "u_admin"],
        ["task.assigned", "u_admin"],
      ]);
      expect(audit[0]?.data).toEqual({
        stepId: "finance",
        stepIndex: 1,
        toUserIds: ["u_fin2"],
        comment: "Approver on leave",
      });
      const done = run(state, approve("u_fin2"), { flow: flow() });
      expect(done.state.status).toBe("approved");
    });

    it("EC-46 reassign refuses the requester, inactive users and too few users for the quorum", () => {
      const blocked = blockFinance([]).state;
      const requester = thrown(() =>
        run(blocked, reassignStep("finance", ["u_req"]), { flow: flow() }),
      );
      expect(requester).toBeInstanceOf(InvalidCommandError);
      expect((requester as Error).message).toContain('"u_req" is the requester');

      const inactive = thrown(() =>
        run(blocked, reassignStep("finance", ["u_old", "u_fin2"]), {
          flow: flow(),
          inactive: ["u_old"],
        }),
      );
      expect((inactive as Error).message).toContain('"u_old" is inactive');

      const target = flow({}, [managerStep, { ...financeStep, mode: { quorum: 2 } }]);
      const quorumBlocked = blockFinance([], target).state;
      const tooFew = thrown(() =>
        run(quorumBlocked, reassignStep("finance", ["u_fin2"]), { flow: target }),
      );
      expect((tooFew as Error).message).toContain("needs 2 approvers");

      const selfFlow = flow({ allowSelfApproval: true });
      const self = run(blockFinance([], selfFlow).state, reassignStep("finance", ["u_req"]), {
        flow: selfFlow,
      });
      expect(self.state.steps[1]?.status).toBe("active");
    });

    it("EC-46 reassign and retry only apply to the blocked step", () => {
      const active = run(null, submitCommand(), { flow: flow(), approvers: ok }).state;
      for (const command of [reassignStep("manager", ["u_x"]), retryStep("manager")]) {
        const error = thrown(() => run(active, command, { flow: flow() }));
        expect(error).toBeInstanceOf(InvalidCommandError);
        expect((error as Error).message).toContain("not blocked");
      }
      const blocked = blockFinance([]).state;
      expect(thrown(() => run(blocked, retryStep("manager"), { flow: flow() }))).toBeInstanceOf(
        InvalidCommandError,
      );
    });

    it("EC-46 retry resolves the step again and activates it once approvers exist", () => {
      const blocked = blockFinance([]).state;
      const { state, audit } = run(blocked, retryStep("finance"), {
        flow: flow(),
        now: T2,
        approvers: { finance: ["u_fin"] },
      });
      expect(state.steps[1]).toMatchObject({ status: "active", approvers: ["u_fin"] });
      expect(audit.map((e) => e.type)).toEqual(["step.retried", "step.activated", "task.assigned"]);
      expect(audit[0]?.data).toEqual({ stepId: "finance", stepIndex: 1, result: "unblocked" });
    });

    it("EC-46 a retry that still finds nobody keeps the step blocked and only records the attempt", () => {
      const blocked = blockFinance([]).state;
      const { state, audit } = run(blocked, retryStep("finance"), {
        flow: flow(),
        now: T2,
        approvers: { finance: ["u_req"] },
      });
      expect(state.version).toBe(blocked.version + 1);
      expect(state.steps).toHaveLength(2);
      expect(state.steps[1]).toMatchObject({
        status: "blocked",
        blockedAt: T1,
        removed: [{ userId: "u_req", reason: "requester" }],
      });
      expect(audit.map((e) => e.type)).toEqual(["step.retried"]);
      expect(audit[0]?.data).toEqual({
        stepId: "finance",
        stepIndex: 1,
        result: "still-blocked",
        reason: { type: "no-approvers" },
        removed: [{ userId: "u_req", reason: "requester" }],
      });
    });
  });

  it("EC-46 an override closes a blocked request and cancels the blocked step", () => {
    const blocked = blockFinance([]).state;
    const { state, audit } = run(blocked, override("approve"), { flow: flow(), now: T2 });
    expect(state.status).toBe("approved");
    expect(state.steps[1]).toMatchObject({ status: "cancelled", closedAt: T2 });
    expect(audit.map((e) => e.type)).toEqual(["step.cancelled", "request.approved"]);
  });

  describe("collecting approvers", () => {
    const need = (spec: StepInput["approvers"]) => ({ key: "manager", stepId: "manager", spec });

    it("calls the host roles and resolvers and reports inactive users", async () => {
      const hooks: ResolutionHooks = {
        roles: (role, ctx) => (role === "finance" && ctx.tenantId === "acme" ? ["u_fin"] : []),
        resolvers: { projectOwner: ({ params, request }) => [`${request.subject.id}:${params}`] },
        isActiveUser: (userId) => userId !== "u_old",
      };
      const spec = {
        type: "union" as const,
        of: [
          { type: "users" as const, ids: ["u_old"] },
          { type: "role" as const, role: "finance" },
          { type: "resolver" as const, name: "projectOwner", params: "lead" },
        ],
      };
      expect(await collectResolution(need(spec), hooks, context)).toEqual({
        userIds: ["u_old", "u_fin", "EXP-1:lead"],
        inactiveUserIds: ["u_old"],
      });
    });

    it.each<[string, ResolutionHooks]>([
      ["resolver", { resolvers: { boom: () => Promise.reject(new Error("db down")) } }],
      ["roles", { roles: () => Promise.reject(new Error("db down")) }],
      ["isActiveUser", { resolvers: { boom: () => ["u_a"] }, isActiveUser: () => fail() }],
    ])(
      "EC-05 a throwing %s fails with ResolutionError and keeps the original error",
      async (_, hooks) => {
        const spec = hooks.roles
          ? ({ type: "role", role: "finance" } as const)
          : ({ type: "resolver", name: "boom" } as const);
        const error = await collectResolution(need(spec), hooks, context).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResolutionError);
        expect(error).toMatchObject({ code: "RESOLUTION_FAILED", stepId: "manager" });
        expect((error as ResolutionError).cause).toEqual(new Error("db down"));
      },
    );

    it("EC-05 missing hooks and invalid results fail with ResolutionError", async () => {
      const cases: [StepInput["approvers"], ResolutionHooks, string][] = [
        [{ type: "role", role: "finance" }, {}, "no roles callback"],
        [{ type: "resolver", name: "nope" }, {}, 'no resolver named "nope"'],
        [{ type: "role", role: "finance" }, { roles: () => "u_a" as never }, "array"],
        [{ type: "role", role: "finance" }, { roles: () => ["u_a", ""] }, "non-empty string"],
      ];
      for (const [spec, hooks, message] of cases) {
        const error = await collectResolution(need(spec), hooks, context).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ResolutionError);
        expect(String((error as ResolutionError).cause)).toContain(message);
      }
    });
  });
});

/** The request the approvers are collected for. */
const context = {
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 5000 },
  flowKey: "expense",
  tenantId: "acme",
};

function fail(): never {
  throw new Error("db down");
}
