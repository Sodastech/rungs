import { SCHEMA } from "./db";
import { type Demo, rungsFor, submitExpense } from "./demo";
import type { ExpenseDetails } from "./expenses";

const HOUR = 3_600_000;

type Step =
  | { at: number; submit: string; by: string; details: ExpenseDetails }
  | { at: number; act: "approve" | "reject" | "return"; on: string; by: string; comment?: string };

/**
 * A week of history, replayed with a clock that starts in the past so the timelines look real.
 * `at` is hours before now. The replay uses the same commands as the app.
 */
const story: Step[] = [
  {
    at: 170,
    submit: "monitor",
    by: "marco",
    details: { title: "Second monitor", category: "Equipment", amount: 640 },
  },
  { at: 160, act: "approve", on: "monitor", by: "diego" },
  {
    at: 150,
    act: "reject",
    on: "monitor",
    by: "kenji",
    comment: "Already ordered through IT last week.",
  },
  {
    at: 120,
    submit: "taxi",
    by: "alice",
    details: { title: "Taxi to the airport", category: "Travel", amount: 45 },
  },
  { at: 100, act: "approve", on: "taxi", by: "marco", comment: "Thanks for the receipt." },
  {
    at: 96,
    submit: "course",
    by: "alice",
    details: { title: "Online TypeScript course", category: "Training", amount: 300 },
  },
  { at: 74, act: "return", on: "course", by: "marco", comment: "Please attach the invoice." },
  {
    at: 72,
    submit: "flight",
    by: "alice",
    details: { title: "Flight to the Lisbon conference", category: "Travel", amount: 1450 },
  },
  { at: 68, act: "approve", on: "flight", by: "marco" },
  {
    at: 48,
    submit: "desk",
    by: "alice",
    details: { title: "Standing desk", category: "Equipment", amount: 6200 },
  },
  {
    at: 30,
    act: "approve",
    on: "desk",
    by: "marco",
    comment: "Recommended by the office ergonomics check.",
  },
  { at: 20, act: "approve", on: "desk", by: "fatima" },
  {
    at: 22,
    submit: "lunch",
    by: "alice",
    details: { title: "Team lunch after the release", category: "Meals", amount: 120 },
  },
  {
    at: 3,
    submit: "dock",
    by: "alice",
    details: { title: "Laptop docking station", category: "Equipment", amount: 780 },
  },
  {
    at: 6,
    submit: "dinner",
    by: "marco",
    details: { title: "Client dinner", category: "Meals", amount: 380 },
  },
];

/** Fills an empty demo with sample expenses. Does nothing once any expense exists. */
export async function seedIfEmpty(demo: Demo): Promise<void> {
  const { rows } = await demo.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${SCHEMA}.expenses`,
  );
  if ((rows[0]?.n ?? 0) > 0) return;

  const end = demo.clock.now().getTime();
  let now = end;
  const clock = { now: () => new Date(now), advance: async () => undefined };
  const rungs = rungsFor(demo.db, demo.inactive, clock.now);
  const requestIds = new Map<string, string>();
  for (const step of [...story].sort((a, b) => b.at - a.at)) {
    now = end - step.at * HOUR;
    if ("submit" in step) {
      const request = await submitExpense(
        { db: demo.db, rungs, clock },
        { requesterId: step.by, details: step.details },
      );
      requestIds.set(step.submit, request.id);
      continue;
    }
    const requestId = requestIds.get(step.on) as string;
    const comment = step.comment === undefined ? {} : { comment: step.comment };
    if (step.act === "return") {
      await rungs.return({ requestId, actorId: step.by, to: "requester", ...comment });
    } else {
      await rungs[step.act]({ requestId, actorId: step.by, ...comment });
    }
  }
}
