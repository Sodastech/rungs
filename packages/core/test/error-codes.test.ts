import { expect, it } from "vitest";
import * as core from "../src/index.js";

// Error codes are part of the public API: hosts map them to HTTP statuses and messages.
// Changing one is a breaking change and needs docs/04-api-design.md and a changeset.
const errors: core.RungsError[] = [
  new core.FlowDefinitionError([]),
  new core.ConditionError({ field: "amount", op: "gt", expected: "number", received: "string" }),
  new core.ConfigurationError("x"),
  new core.InvalidCommandError("x"),
  new core.RequestNotFoundError("r1"),
  new core.NotAssignedError({ requestId: "r1", actorId: "u1" }),
  new core.InvalidTransitionError({ requestId: "r1", status: "approved", command: "approve" }),
  new core.ResolutionError({ stepId: "s1", cause: new Error("x") }),
  new core.NoApproversError({ stepId: "s1", reason: { type: "no-approvers" }, removed: [] }),
  new core.ConflictError({ requestId: "r1", expectedVersion: 1, actualVersion: 2 }),
  new core.FlowNotFoundError({ flowKey: "f" }),
  new core.FlowNotApplicableError({ flowKey: "f", skippedStepIds: [] }),
];

it("keeps every error code stable", () => {
  expect(Object.fromEntries(errors.map((e) => [e.name, e.code]))).toEqual({
    ConditionError: "CONDITION_INVALID",
    ConfigurationError: "CONFIG_INVALID",
    ConflictError: "VERSION_CONFLICT",
    FlowDefinitionError: "FLOW_INVALID",
    FlowNotApplicableError: "FLOW_NOT_APPLICABLE",
    FlowNotFoundError: "FLOW_NOT_FOUND",
    InvalidCommandError: "COMMAND_INVALID",
    InvalidTransitionError: "INVALID_TRANSITION",
    NoApproversError: "NO_APPROVERS",
    NotAssignedError: "NOT_ASSIGNED",
    RequestNotFoundError: "REQUEST_NOT_FOUND",
    ResolutionError: "RESOLUTION_FAILED",
  });
});

it("covers every exported error class", () => {
  const classes = Object.entries(core)
    .filter(([name, value]) => typeof value === "function" && name.endsWith("Error"))
    .map(([name]) => name)
    .filter((name) => name !== "RungsError");
  expect(errors.map((e) => e.name).sort()).toEqual(classes.sort());
  for (const error of errors) expect(error).toBeInstanceOf(core.RungsError);
});
