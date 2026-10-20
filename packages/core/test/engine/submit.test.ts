import { describe, expect, it } from "vitest";
import {
  decide,
  InvalidCommandError,
  InvalidTransitionError,
  RequestNotFoundError,
} from "../../src/index.js";
import {
  approve,
  deepFreeze,
  expenseFlow,
  registeredFlow,
  run,
  submitCommand,
  T0,
  thrown,
} from "../helpers/engine.js";

describe("submit", () => {
  it("creates a pending request pinned to the flow version with the first step active", () => {
    const { state } = run(null, submitCommand({ tenantId: "acme" }));
    expect(state).toEqual({
      id: "r1",
      tenantId: "acme",
      flowKey: "expense",
      flowVersion: 1,
      subject: { type: "expense", id: "EXP-1" },
      requesterId: "u_req",
      payload: { amount: 5000 },
      status: "pending",
      currentStepIndex: 0,
      version: 1,
      submittedAt: T0,
      lastAuditSeq: 3,
      lastTaskNumber: 1,
      nextDueAt: null,
      steps: [
        {
          stepId: "manager",
          index: 0,
          status: "active",
          activatedAt: T0,
          approvers: ["u_mgr"],
          tasks: [{ id: "r1.t1", assigneeId: "u_mgr", status: "pending", assignedAt: T0 }],
        },
      ],
    });
  });

  it("records audit events with increasing seq and derives domain events from them", () => {
    const { audit, events } = run(null, submitCommand({ tenantId: "acme" }));
    expect(audit).toEqual([
      {
        requestId: "r1",
        seq: 1,
        type: "request.submitted",
        actorId: "u_req",
        at: T0,
        data: { flowKey: "expense", flowVersion: 1, subject: { type: "expense", id: "EXP-1" } },
      },
      {
        requestId: "r1",
        seq: 2,
        type: "step.activated",
        actorId: "u_req",
        at: T0,
        data: { stepId: "manager", stepIndex: 0, approvers: ["u_mgr"] },
      },
      {
        requestId: "r1",
        seq: 3,
        type: "task.assigned",
        actorId: "u_req",
        at: T0,
        data: { taskId: "r1.t1", stepId: "manager", assigneeId: "u_mgr" },
      },
    ]);
    expect(events.map((e) => [e.type, e.seq, e.tenantId])).toEqual([
      ["request.submitted", 1, "acme"],
      ["step.activated", 2, "acme"],
      ["task.assigned", 3, "acme"],
    ]);
  });

  it("asks for approvers before deciding and changes nothing until they arrive", () => {
    const decision = decide(null, submitCommand(), { now: T0, flow: expenseFlow });
    expect(decision.kind).toBe("needs-resolution");
  });

  it("creates one task per distinct approver", () => {
    const { state } = run(null, submitCommand(), { approvers: { manager: ["a", "b", "a"] } });
    expect(state.steps[0]?.approvers).toEqual(["a", "b"]);
    expect(state.steps[0]?.tasks.map((t) => [t.id, t.assigneeId])).toEqual([
      ["r1.t1", "a"],
      ["r1.t2", "b"],
    ]);
  });

  it("is deterministic and never mutates its inputs", () => {
    const first = run(null, submitCommand());
    const frozen = deepFreeze(JSON.parse(JSON.stringify(first.state)));
    const a = run(frozen, approve("u_mgr"));
    const b = run(frozen, approve("u_mgr"));
    expect(a).toEqual(b);
    expect(frozen).toEqual(first.state);
  });

  it("rejects malformed commands with InvalidCommandError", () => {
    const invalid = [
      submitCommand({ requestId: "" }),
      submitCommand({ requesterId: "" }),
      submitCommand({ subject: { type: "expense", id: "" } }),
      submitCommand({ tenantId: "" }),
      submitCommand({ payload: { when: new Date() } as never }),
      submitCommand({ payload: { amount: Number.NaN } }),
      submitCommand({ payload: { fn: () => 1 } as never }),
      submitCommand({ payload: { nested: [1, undefined] } as never }),
    ];
    for (const command of invalid) {
      const error = thrown(() => run(null, command));
      expect(error).toBeInstanceOf(InvalidCommandError);
      expect((error as InvalidCommandError).code).toBe("COMMAND_INVALID");
    }
  });

  it.each<[string, unknown, string]>([
    [
      "Date",
      { submittedAt: new Date(0) },
      "payload.submittedAt is a Date; send an ISO 8601 string",
    ],
    [
      "undefined",
      { lines: [1, undefined] },
      "payload.lines[1] is undefined; omit the field or send null",
    ],
    ["NaN", { cost: { amount: Number.NaN } }, "payload.cost.amount is NaN; send a finite number"],
    [
      "Infinity",
      { amount: Number.POSITIVE_INFINITY },
      "payload.amount is Infinity; send a finite number",
    ],
    ["function", { fn: () => 1 }, "payload.fn is a function; send plain JSON data"],
    ["bigint", { big: 10n }, "payload.big is a bigint; send a number or a string"],
    ["Map", { tags: new Map() }, "payload.tags is a Map; send a plain object or array"],
    [
      "odd key",
      { "line items": [new Date(0)] },
      'payload["line items"][0] is a Date; send an ISO 8601 string',
    ],
    ["root", undefined, "payload is undefined; omit the field or send null"],
  ])("names the path and type of a non-JSON payload value (%s)", (_, payload, message) => {
    const error = thrown(() => run(null, submitCommand({ payload: payload as never })));
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as Error).message).toContain(message);
  });

  it("lists every non-JSON payload value, not only the first", () => {
    const error = thrown(() =>
      run(null, submitCommand({ payload: { a: new Date(0), b: Number.NaN } as never })),
    );
    expect((error as Error).message).toContain("payload.a is a Date");
    expect((error as Error).message).toContain("payload.b is NaN");
  });

  it("rejects a non-UTC or malformed clock value", () => {
    for (const now of ["2026-01-05T09:00:00+07:00", "yesterday", "2026-01-05"]) {
      expect(thrown(() => run(null, submitCommand(), { now }))).toBeInstanceOf(InvalidCommandError);
    }
  });

  it("refuses to submit over an existing request", () => {
    const { state } = run(null, submitCommand());
    expect(thrown(() => run(state, submitCommand()))).toBeInstanceOf(InvalidTransitionError);
  });

  it("fails with RequestNotFoundError when deciding on a request that does not exist", () => {
    const error = thrown(() => run(null, approve("u_mgr")));
    expect(error).toBeInstanceOf(RequestNotFoundError);
    expect((error as RequestNotFoundError).code).toBe("REQUEST_NOT_FOUND");
  });

  it("EC-56 pins a tenant's flow by recording flowTenantId, and refuses another scope later", () => {
    const tenantFlow = { ...expenseFlow, tenantId: "acme" };
    const { state } = run(null, submitCommand({ tenantId: "acme" }), { flow: tenantFlow });
    expect(state.flowTenantId).toBe("acme");
    expect(run(null, submitCommand({ tenantId: "acme" })).state.flowTenantId).toBeUndefined();
    expect(thrown(() => run(state, approve("u_mgr")))).toBeInstanceOf(InvalidCommandError);
    expect(run(state, approve("u_mgr"), { flow: tenantFlow }).state.version).toBe(2);
  });

  it("EC-56 a tenant's flow cannot serve a request of another tenant", () => {
    const tenantFlow = { ...expenseFlow, tenantId: "acme" };
    for (const tenantId of ["globex", undefined]) {
      const command = submitCommand(tenantId ? { tenantId } : {});
      expect(thrown(() => run(null, command, { flow: tenantFlow }))).toBeInstanceOf(
        InvalidCommandError,
      );
    }
  });

  it("refuses a command addressed to a different request or with a different flow version", () => {
    const { state } = run(null, submitCommand());
    expect(thrown(() => run(state, { ...approve("u_mgr"), requestId: "r2" }))).toBeInstanceOf(
      InvalidCommandError,
    );
    const v2 = registeredFlow({ key: "expense", steps: expenseFlow.steps }, 2);
    expect(thrown(() => run(state, approve("u_mgr"), { flow: v2 }))).toBeInstanceOf(
      InvalidCommandError,
    );
  });
});
