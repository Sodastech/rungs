import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Command,
  type DecidedResult,
  type DelegationRule,
  decide,
  type FlowInput,
  type RegisteredFlow,
  type RequestState,
  RungsError,
  type StepInput,
  type StepResolution,
  type Unchanged,
} from "../src/index.js";
import { deepFreeze, registeredFlow } from "./helpers/engine.js";

// Invariants from docs/06 ("Testing strategy"), checked after every command of random scenarios.

const PEOPLE = ["u_a", "u_b", "u_c", "u_d", "u_req"] as const;
const person = fc.constantFrom(...PEOPLE);
const people = (max: number) => fc.uniqueArray(person, { minLength: 1, maxLength: max });

const stepArb = fc.record({
  ids: people(4),
  mode: fc.constantFrom("any", "all", "quorum"),
  quorum: fc.integer({ min: 1, max: 4 }),
  conditional: fc.boolean(),
  threshold: fc.integer({ min: 0, max: 2000 }),
  timeout: fc.constantFrom("none", "remind", "auto-approve", "auto-reject", "escalate"),
  escalateTo: people(3),
});

const flowArb = fc.record({
  steps: fc.array(stepArb, { minLength: 1, maxLength: 3 }),
  dedupeApprovers: fc.constantFrom("none", "consecutive", "all"),
  allowSelfApproval: fc.boolean(),
  onEmptyStep: fc.constantFrom("fail", "skip"),
  returnPolicy: fc.constantFrom("restart", "from-returned-step"),
  maxEscalationDepth: fc.integer({ min: 1, max: 2 }),
});

// `pick` chooses among the pending tasks at run time, so most commands hit a real task;
// `stranger` sends it from someone else instead, to exercise refusals.
const target = { pick: fc.nat(5), stranger: fc.boolean() };
const commandArb = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant("approve"), ...target }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reject"), ...target }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("return"), ...target }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("return-step"), ...target, step: fc.nat(2) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("resubmit"),
      amount: fc.integer({ min: 0, max: 2000 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("withdraw") }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("delegate"), ...target, to: person }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("reassign-task"), ...target, to: person }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("reassign-step"), step: fc.nat(2), to: people(3) }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("retry"), step: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("override"), approve: fc.boolean() }) },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("tick"), hours: fc.integer({ min: 0, max: 30 }) }),
  },
);

const scenarioArb = fc.record({
  flow: flowArb,
  amount: fc.integer({ min: 0, max: 2000 }),
  inactive: fc.uniqueArray(person, { maxLength: 2 }),
  // These users become inactive from command `leaveAt` on, so steps can block mid-flow.
  leavers: fc.uniqueArray(person, { minLength: 1, maxLength: 3 }),
  leaveAt: fc.integer({ min: 1, max: 3 }),
  rules: fc.array(fc.record({ from: person, to: person }), { maxLength: 4 }),
  commands: fc.array(commandArb, { maxLength: 14 }),
});

type Scenario = typeof scenarioArb extends fc.Arbitrary<infer T> ? T : never;
type Cmd = Scenario["commands"][number];

function buildFlow(input: Scenario["flow"]): RegisteredFlow {
  const steps = input.steps.map((s, i): StepInput => {
    const mode =
      s.mode === "quorum"
        ? { quorum: Math.min(s.quorum, s.ids.length) }
        : (s.mode as "any" | "all");
    return {
      id: `s${i}`,
      approvers: { type: "users", ids: s.ids },
      mode,
      ...(s.conditional ? { when: { field: "amount", op: "gt", value: s.threshold } } : {}),
      ...(s.timeout === "none"
        ? {}
        : {
            deadline: "PT2H",
            onTimeout: s.timeout as "remind",
            ...(s.timeout === "escalate"
              ? { escalateTo: { type: "users", ids: s.escalateTo } as const }
              : {}),
          }),
    };
  });
  const flow: FlowInput = {
    key: "random",
    steps,
    dedupeApprovers: input.dedupeApprovers as "none",
    allowSelfApproval: input.allowSelfApproval,
    onEmptyStep: input.onEmptyStep as "fail",
    returnPolicy: input.returnPolicy as "restart",
    maxEscalationDepth: input.maxEscalationDepth,
    remindOverdueEvery: "PT1H",
  };
  return registeredFlow(flow);
}

function toCommand(cmd: Cmd, state: RequestState, flow: RegisteredFlow): Command {
  const requestId = state.id;
  const stepId = (n: number) => flow.steps[n % flow.steps.length]?.id ?? "s0";
  const pending = state.steps.flatMap((s) => s.tasks).filter((t) => t.status === "pending");
  const chosen = "pick" in cmd ? pending[cmd.pick % Math.max(pending.length, 1)] : undefined;
  const actor = (c: { stranger: boolean; pick: number }) =>
    c.stranger || chosen === undefined
      ? (PEOPLE[c.pick % PEOPLE.length] as string)
      : chosen.assigneeId;
  const taskId = chosen?.id ?? `${requestId}.t1`;
  switch (cmd.kind) {
    case "approve":
    case "reject":
      return { type: cmd.kind, requestId, actorId: actor(cmd) };
    case "return":
      return { type: "return", requestId, actorId: actor(cmd), to: "requester" };
    case "return-step":
      return { type: "return", requestId, actorId: actor(cmd), to: { stepId: stepId(cmd.step) } };
    case "resubmit":
      return { type: "resubmit", requestId, actorId: "u_req", payload: { amount: cmd.amount } };
    case "withdraw":
      return { type: "withdraw", requestId, actorId: "u_req" };
    case "delegate":
      return { type: "delegate", requestId, actorId: actor(cmd), taskId, toUserId: cmd.to };
    case "reassign-task":
      return {
        type: "reassign",
        requestId,
        adminId: "u_admin",
        taskId,
        toUserId: cmd.to,
        comment: "x",
      };
    case "reassign-step":
      return {
        type: "reassign",
        requestId,
        adminId: "u_admin",
        stepId: stepId(cmd.step),
        toUserIds: cmd.to,
        comment: "x",
      };
    case "retry":
      return { type: "retry", requestId, adminId: "u_admin", stepId: stepId(cmd.step) };
    case "override":
      return {
        type: "override",
        requestId,
        adminId: "u_admin",
        decision: cmd.approve ? "approve" : "reject",
        comment: "x",
      };
    case "tick":
      return { type: "tick", requestId };
  }
}

/** Plays the service: answers every need from the `users` specs, the inactive set and the rules. */
function resolve(
  state: RequestState | null,
  command: Command,
  flow: RegisteredFlow,
  now: string,
  scenario: Scenario,
  inactive: readonly string[],
): DecidedResult | Unchanged {
  const rules: DelegationRule[] = scenario.rules
    .filter((r) => r.from !== r.to)
    .map((r, i) => ({
      id: `d${i}`,
      fromUserId: r.from,
      toUserId: r.to,
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-03-01T00:00:00.000Z",
    }));
  const resolutions: Record<string, StepResolution> = {};
  for (let round = 0; round < 10; round++) {
    const decision = decide(state, command, { now, flow, resolutions });
    if (decision.kind !== "needs-resolution") return decision;
    for (const need of decision.needs) {
      const userIds = need.spec.type === "users" ? need.spec.ids : [];
      resolutions[need.key] = {
        userIds,
        ...(inactive.length > 0 ? { inactiveUserIds: [...inactive] } : {}),
        ...(rules.length > 0 ? { delegations: rules } : {}),
      };
    }
  }
  throw new Error("resolution did not settle");
}

const VOTES = new Set(["pending", "approved", "rejected", "returned", "skipped-duplicate"]);
const RETIRED = new Set(["delegated", "reassigned"]);

function checkInvariants(
  before: RequestState | null,
  result: DecidedResult,
  flow: RegisteredFlow,
): void {
  const { state, audit, events } = result;

  // Version and audit seq move forward by exactly one command, without gaps.
  expect(state.version).toBe((before?.version ?? 0) + 1);
  const from = before?.lastAuditSeq ?? 0;
  expect(audit.map((e) => e.seq)).toEqual(
    Array.from({ length: state.lastAuditSeq - from }, (_, i) => from + i + 1),
  );
  expect(events.map((e) => e.seq)).toEqual(audit.map((e) => e.seq));

  // A closed or returned request has no pending tasks; an open one has at most one open step.
  const open = state.steps.filter((s) => s.status === "active" || s.status === "blocked");
  if (state.status !== "pending") {
    expect(state.steps.flatMap((s) => s.tasks).some((t) => t.status === "pending")).toBe(false);
    expect(open).toEqual([]);
  } else {
    expect(open.length).toBeLessThanOrEqual(1);
    if (open[0]) expect(state.currentStepIndex).toBe(open[0].index);
  }

  for (const instance of state.steps) {
    // Every task belongs to a step that was activated.
    if (instance.tasks.length > 0) expect(instance.activatedAt).toBeDefined();

    // One person, one vote per step instance (EC-48).
    const voters = instance.tasks.filter((t) => VOTES.has(t.status)).map((t) => t.assigneeId);
    expect(new Set(voters).size).toBe(voters.length);

    // The requester never gets a task unless self-approval is allowed (EC-01, EC-23).
    if (!flow.allowSelfApproval) {
      expect(instance.tasks.some((t) => t.assigneeId === state.requesterId)).toBe(false);
    }

    // Four-eyes: carried-over votes alone never approve a step others could decide (EC-03, EC-47).
    // A step closed by `onTimeout: "auto-approve"` is a separate, explicit opt-in (EC-26).
    const autoApproved =
      instance.deadline?.timedOutAt !== undefined &&
      flow.steps[instance.index]?.onTimeout === "auto-approve";
    if (
      instance.status === "approved" &&
      !autoApproved &&
      !instance.tasks.some((t) => t.status === "approved")
    ) {
      for (const task of instance.tasks) {
        expect(task.status === "skipped-duplicate" || RETIRED.has(task.status)).toBe(true);
      }
    }
  }
}

describe("engine invariants (property-based)", () => {
  it("hold after every command of random scenarios", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const flow = buildFlow(scenario.flow);
        let clock = Date.parse("2026-01-05T09:00:00.000Z");
        const now = () => new Date(clock).toISOString();
        let state: RequestState | null = null;

        const submit: Command = {
          type: "submit",
          requestId: "r1",
          requesterId: "u_req",
          subject: { type: "expense", id: "EXP-1" },
          payload: { amount: scenario.amount },
        };
        for (const [index, cmd] of [undefined, ...scenario.commands].entries()) {
          if (index > 0) {
            if (state === null) return;
            clock += cmd?.kind === "tick" ? cmd.hours * 3_600_000 : 600_000;
          }
          const command = index === 0 ? submit : toCommand(cmd as Cmd, state as RequestState, flow);
          const before: RequestState | null =
            state === null ? null : deepFreeze(structuredCopy(state));
          const inactive =
            index >= scenario.leaveAt
              ? [...scenario.inactive, ...scenario.leavers]
              : scenario.inactive;
          let result: DecidedResult | Unchanged;
          try {
            result = resolve(before, command, flow, now(), scenario, inactive);
          } catch (error) {
            // Refusals are fine; anything that is not a RungsError is a bug.
            if (!(error instanceof RungsError)) throw error;
            continue;
          }
          // Deterministic: the same input gives the same output.
          expect(resolve(before, command, flow, now(), scenario, inactive)).toEqual(result);
          if (result.kind === "unchanged") continue;
          checkInvariants(before, result, flow);
          state = result.state;
        }
      }),
      { numRuns: 400 },
    );
  });
});

function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
