import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runScenario } from "../src/run.js";
import type { Scenario } from "../src/scenario.js";

// Every example scenario must keep running as written, so CI catches drift between the engine and
// the playground (and the timeline keeps showing what each scenario is about).
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "scenarios");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts"))
  .sort();

const highlights: Record<string, string[]> = {
  "01-expense-three-steps.ts": ["reminder to Farah (u_farah)", "request APPROVED"],
  "02-manager-on-leave.ts": [
    "on behalf of Bob (u_bob)",
    "refused (expected) NOT_ASSIGNED",
    "handed the task to Gina",
  ],
  "03-four-eyes.ts": [
    "removed Alice (u_alice): is the requester",
    "carries over as one vote",
    "Eve (u_eve) approved",
  ],
  "04-resubmit-amount-changed.ts": [
    "starts over from the first step",
    "payload changed",
    "step finance skipped",
  ],
};

describe("playground scenarios", () => {
  it("has the four example scenarios", () => {
    expect(files).toEqual(Object.keys(highlights));
  });

  it("fails on an unexpected refusal, an unmet expectError or a different final status", async () => {
    const result = await runScenario(
      {
        name: "broken on purpose",
        start: "2026-03-02T09:00:00.000Z",
        users: { u_a: "A", u_b: "B" },
        flow: { key: "x", steps: [{ id: "s", approvers: { type: "users", ids: ["u_b"] } }] },
        actions: [
          { do: "submit", by: "u_a", payload: {} },
          { do: "approve", by: "u_a" },
          { do: "approve", by: "u_b", expectError: "NOT_ASSIGNED" },
        ],
        expectStatus: "rejected",
      },
      () => undefined,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.stringContaining("action 2 (approve) failed: NOT_ASSIGNED"),
      "action 3 (approve) was expected to fail with NOT_ASSIGNED",
      "expected the request to end rejected, but it is approved",
    ]);
  });

  for (const file of files) {
    it(`${file} runs and ends as expected`, async () => {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default: Scenario };
      const lines: string[] = [];
      const result = await runScenario(mod.default, (line) => lines.push(line));
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      const timeline = lines.join("\n");
      for (const text of highlights[file] ?? []) expect(timeline).toContain(text);
    });
  }
});
