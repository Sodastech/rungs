import { describe, expect, it } from "vitest";
import { durationToMilliseconds, parseDuration } from "../../src/flow/duration.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ms(input: string): number {
  const result = parseDuration(input);
  if (!result.ok) throw new Error(result.reason);
  return durationToMilliseconds(result.value);
}

function reason(input: unknown): string {
  const result = parseDuration(input);
  if (result.ok) throw new Error(`expected "${String(input)}" to be rejected`);
  return result.reason;
}

describe("parseDuration", () => {
  it.each([
    ["P2D", 2 * DAY],
    ["PT8H", 8 * HOUR],
    ["P1DT12H", 36 * HOUR],
    ["PT90M", 90 * 60_000],
    ["PT1H30M15S", HOUR + 30 * 60_000 + 15_000],
    ["P2W", 14 * DAY],
    ["PT36H", 36 * HOUR],
  ])("parses %s", (input, expected) => {
    expect(ms(input)).toBe(expected);
  });

  it.each(["P1Y", "P1M", "P1Y2M", "P1M2D", "P1Y2M3DT4H"])(
    "rejects %s because years and months have variable length",
    (input) => {
      expect(reason(input)).toMatch(/years and months are not supported/);
    },
  );

  it.each([
    "",
    "P",
    "PT",
    "P1DT",
    "2D",
    "p2d",
    "PT1.5H",
    "PT1,5H",
    "-P1D",
    "P1W2D",
    "P 2D",
    "PT8H ",
  ])("rejects malformed duration %j", (input) => {
    expect(reason(input)).toMatch(/not a supported ISO 8601 duration/);
  });

  it.each(["P0D", "PT0S", "P0W", "P0DT0H"])("rejects zero-length duration %s", (input) => {
    expect(reason(input)).toMatch(/greater than zero/);
  });

  it("rejects non-string input", () => {
    expect(reason(48)).toMatch(/must be a string/);
  });

  it("rejects values too large to represent safely", () => {
    expect(reason("PT99999999999999999999S")).toMatch(/too large/);
  });
});
