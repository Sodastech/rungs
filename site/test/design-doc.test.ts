import { readFileSync } from "node:fs";
import * as core from "@rungsjs/core";
import { describe, expect, it } from "vitest";
import { sectionCode, sectionTable } from "../src/lib/design-doc";

const api = readFileSync(new URL("../../docs/04-api-design.md", import.meta.url), "utf8");

describe("reference pages read docs/04-api-design.md", () => {
  it("the errors table has every error class with its code", () => {
    const { header, rows } = sectionTable(api, "Errors");
    expect(header).toEqual(["Class", "Code", "When"]);
    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const [cls, code] of rows) {
      expect(cls).toMatch(/^`\w+Error`$/);
      expect(code).toMatch(/^`[A-Z_]+`$/);
    }
  });

  it("the errors table matches the codes the classes throw with", () => {
    const thrown: core.RungsError[] = [
      new core.FlowDefinitionError([]),
      new core.ConditionError({ field: "a", op: "gt", expected: "number", received: "string" }),
      new core.ConfigurationError("x"),
      new core.InvalidCommandError("x"),
      new core.RequestNotFoundError("r"),
      new core.NotAssignedError({ requestId: "r", actorId: "u" }),
      new core.InvalidTransitionError({ requestId: "r", status: "approved", command: "approve" }),
      new core.ResolutionError({ stepId: "s", cause: new Error("x") }),
      new core.NoApproversError({ stepId: "s", reason: { type: "no-approvers" }, removed: [] }),
      new core.ConflictError({ requestId: "r", expectedVersion: 1, actualVersion: 2 }),
      new core.FlowNotFoundError({ flowKey: "f" }),
      new core.FlowNotApplicableError({ flowKey: "f", skippedStepIds: [] }),
    ];
    const documented = Object.fromEntries(
      sectionTable(api, "Errors").rows.map(([cls, code]) => [
        String(cls).replaceAll("`", ""),
        String(code).replaceAll("`", ""),
      ]),
    );
    expect(documented).toEqual(Object.fromEntries(thrown.map((e) => [e.name, e.code])));
  });

  it("the store contract shows the StoreTx interface", () => {
    const { lang, code } = sectionCode(api, "Store interface (for adapter authors)");
    expect(lang).toBe("ts");
    expect(code).toContain("interface StoreTx");
    expect(code).toContain("findRequests");
  });

  it("names the missing section instead of rendering nothing", () => {
    expect(() => sectionTable(api, "No such section")).toThrow(/No such section/);
  });
});
