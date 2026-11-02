import { person } from "./directory";
import type { ExpenseDetails } from "./expenses";
import { categories } from "./flow";

export const MAX_COMMENT = 500;
const MAX_AWAY_DAYS = 366;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXPENSE_ID = /^exp_[0-9a-f]{8}$/;

/** What the expense form may hold; a string is the message for the person who filled it in. */
export function checkExpense(input: {
  title: string;
  category: string;
  amount: string;
}): ExpenseDetails | string {
  const amount = Number(input.amount);
  if (input.title.length < 3 || input.title.length > 80) {
    return "Give the expense a title (3 to 80 characters).";
  }
  if (!(categories as readonly string[]).includes(input.category)) return "Choose a category.";
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return "Enter an amount between 0.01 and 1,000,000.";
  }
  return { title: input.title, category: input.category, amount: Math.round(amount * 100) / 100 };
}

export const isExpenseId = (value: string) => EXPENSE_ID.test(value);

export const commentTooLong = (value: string) =>
  value.length > MAX_COMMENT ? `Keep the comment under ${MAX_COMMENT} characters.` : undefined;

export const arePeople = (ids: readonly string[]) =>
  ids.length > 0 && ids.length <= 10 && ids.every((id) => person(id) !== undefined);

/** A first and last day for "out of office": real dates, in order, at most about a year apart. */
export function checkAwayDates(from: string, until: string): string | undefined {
  const invalid = "Choose a first and a last day; the last day cannot be before the first.";
  if (!DATE.test(from) || !DATE.test(until)) return invalid;
  const first = Date.parse(`${from}T00:00:00.000Z`);
  const last = Date.parse(`${until}T00:00:00.000Z`);
  if (Number.isNaN(first) || Number.isNaN(last) || last < first) return invalid;
  if (last - first > MAX_AWAY_DAYS * DAY) return "Choose a period of at most a year.";
  return undefined;
}
