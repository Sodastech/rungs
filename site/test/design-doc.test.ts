import { readFileSync } from "node:fs";
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
