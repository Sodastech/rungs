import { describe, expect, it } from "vitest";

describe("package scaffold", () => {
  it("loads the entry point", async () => {
    const mod = await import("../src/index.js");
    expect(Object.keys(mod)).toEqual([]);
  });
});
