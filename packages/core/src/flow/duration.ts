export interface ParsedDuration {
  readonly weeks: number;
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

export type DurationParseResult =
  | { readonly ok: true; readonly value: ParsedDuration }
  | { readonly ok: false; readonly reason: string };

const WEEKS = /^P(\d+)W$/;
const DAY_TIME = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const YEARS_OR_MONTHS = /^P(?:\d+Y)?(?:\d+M)?(?:\d+[WD])?(?:T.*)?$/;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Parses the fixed-length subset of ISO 8601 durations supported by Rungs. */
export function parseDuration(input: unknown): DurationParseResult {
  if (typeof input !== "string") return fail("must be a string");

  const parts = matchParts(input);
  if (parts === null) {
    if (YEARS_OR_MONTHS.test(input) && /^P[^T]*[YM]/.test(input)) {
      return fail(
        `"${input}": years and months are not supported because their length varies; use weeks or days`,
      );
    }
    return fail(
      `"${input}" is not a supported ISO 8601 duration; use PnW or PnDTnHnMnS, e.g. "P2D" or "PT8H"`,
    );
  }

  if (!Object.values(parts).every(Number.isSafeInteger)) return fail(`"${input}" is too large`);
  const value: ParsedDuration = parts;
  const total = durationToMilliseconds(value);
  if (!Number.isSafeInteger(total)) return fail(`"${input}" is too large`);
  if (total === 0) return fail(`"${input}" must be greater than zero`);
  return { ok: true, value };
}

export function durationToMilliseconds(d: ParsedDuration): number {
  return d.weeks * WEEK + d.days * DAY + d.hours * HOUR + d.minutes * MINUTE + d.seconds * SECOND;
}

function matchParts(input: string): ParsedDuration | null {
  const weeks = WEEKS.exec(input);
  if (weeks) return { weeks: Number(weeks[1]), days: 0, hours: 0, minutes: 0, seconds: 0 };

  const dayTime = DAY_TIME.exec(input);
  if (!dayTime) return null;
  const [, days, hours, minutes, seconds] = dayTime;
  const hasTime = hours !== undefined || minutes !== undefined || seconds !== undefined;
  // "P" alone, and a "T" designator with nothing after it, are not valid durations.
  if (days === undefined && !hasTime) return null;
  if (input.includes("T") && !hasTime) return null;
  return {
    weeks: 0,
    days: Number(days ?? 0),
    hours: Number(hours ?? 0),
    minutes: Number(minutes ?? 0),
    seconds: Number(seconds ?? 0),
  };
}

function fail(reason: string): DurationParseResult {
  return { ok: false, reason };
}
