import { expect, it } from "vitest";
import * as core from "../src/index.js";

// Everything exported from the entry point is public API (CLAUDE.md rule 4).
// Changing this list requires updating docs/04-api-design.md and adding a changeset.
it("exports exactly the documented runtime API", () => {
  expect(Object.keys(core).sort()).toEqual([
    "ConditionError",
    "ConfigurationError",
    "ConflictError",
    "FlowDefinitionError",
    "FlowNotApplicableError",
    "FlowNotFoundError",
    "InvalidCommandError",
    "InvalidTransitionError",
    "NoApproversError",
    "NotAssignedError",
    "RequestNotFoundError",
    "ResolutionError",
    "RungsError",
    "blockedStepView",
    "createRungs",
    "decide",
    "defineFlow",
    "requestSummary",
    "taskViews",
  ]);
});
