import { durationToMilliseconds, parseDuration } from "../flow/duration.js";
import type { Calendar } from "../model/decision.js";
import { InvalidCommandError } from "../model/errors.js";
import type { Duration, StepDefinition } from "../model/flow.js";
import type { StepInstance } from "../model/state.js";
import type { Draft } from "./draft.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** EC-31: durations are absolute; every result is an ISO 8601 UTC timestamp. */
const absolute: Calendar = {
  addDuration: (start, duration) => shift(start, milliseconds(duration)),
  subtractDuration: (end, duration) => shift(end, -milliseconds(duration)),
};

export function addDuration(draft: Draft, startIso: string, duration: Duration): string {
  const calendar = draft.ctx.calendar ?? absolute;
  return checked(calendar.addDuration(startIso, duration), "calendar.addDuration");
}

export function subtractDuration(draft: Draft, endIso: string, duration: Duration): string {
  const calendar = draft.ctx.calendar ?? absolute;
  return checked(calendar.subtractDuration(endIso, duration), "calendar.subtractDuration");
}

export function isDue(atIso: string, nowIso: string): boolean {
  return Date.parse(atIso) <= Date.parse(nowIso);
}

/** EC-26: sets the deadline (and the `remindBefore` time) of a step that just became active. */
export function startDeadline(
  draft: Draft,
  instance: StepInstance,
  step: StepDefinition,
  escalationDepth = 0,
): void {
  delete instance.deadline;
  if (step.deadline === undefined) return;
  const deadlineAt = addDuration(draft, draft.ctx.now, step.deadline);
  instance.deadline = {
    deadlineAt,
    ...(step.remindBefore === undefined
      ? {}
      : { remindAt: subtractDuration(draft, deadlineAt, step.remindBefore) }),
    escalationDepth,
    reminders: 0,
  };
}

/** EC-53: schedules the first `step.still_blocked` reminder, unless the flow says never. */
export function startBlockedReminder(draft: Draft, instance: StepInstance): void {
  delete instance.blockedReminder;
  const every = draft.ctx.flow.remindBlockedEvery;
  if (every === "never") return;
  instance.blockedReminder = { nextAt: addDuration(draft, draft.ctx.now, every), count: 0 };
}

/**
 * The first time after now in the series `from + every`, `from + 2 * every`, ... A late tick
 * therefore sends one reminder and resumes the schedule instead of catching up (EC-53, EC-55).
 */
export function nextAfter(draft: Draft, fromIso: string, every: Duration): string {
  const { now } = draft.ctx;
  let next = addDuration(draft, fromIso, every);
  for (let i = 0; i < 1000 && isDue(next, now); i++) next = addDuration(draft, next, every);
  return isDue(next, now) ? addDuration(draft, now, every) : next;
}

function milliseconds(duration: Duration): number {
  const parsed = parseDuration(duration);
  if (!parsed.ok) throw new InvalidCommandError(`Invalid duration "${duration}": ${parsed.reason}`);
  return durationToMilliseconds(parsed.value);
}

function shift(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

function checked(value: unknown, source: string): string {
  if (typeof value !== "string" || !ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidCommandError(
      `${source} must return an ISO 8601 UTC timestamp, got ${JSON.stringify(value)}`,
    );
  }
  return new Date(Date.parse(value)).toISOString();
}
