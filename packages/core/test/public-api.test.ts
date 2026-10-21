import { expect, it } from "vitest";
import * as engine from "../src/engine.js";
import * as core from "../src/index.js";
import * as store from "../src/store.js";

// Everything exported from an entry point is public API (CLAUDE.md rule 4).
// Changing these lists requires updating docs/04-api-design.md and adding a changeset.
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
    "createRungs",
    "defineFlow",
  ]);
});

it("exports the adapter helpers from @rungsjs/core/store", () => {
  expect(Object.keys(store).sort()).toEqual(["blockedStepView", "requestSummary", "taskViews"]);
});

it("exports the pure engine from @rungsjs/core/engine", () => {
  expect(Object.keys(engine).sort()).toEqual(["decide"]);
});
