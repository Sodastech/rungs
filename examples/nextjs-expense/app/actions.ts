"use server";

// Every Server Action here is one Rungs command. The pattern is the same each time: take the
// actor from the session (never from the form), call Rungs, turn a RungsError into a message.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { advanceTime, resubmitExpense, submitExpense } from "../rungs/demo";
import { person, setActive } from "../rungs/directory";
import { describeError } from "../rungs/errors";
import { countExpenses, type ExpenseDetails } from "../rungs/expenses";
import {
  arePeople,
  checkAwayDates,
  checkExpense,
  commentTooLong,
  isExpenseId,
} from "../rungs/input";
import { DemoLimitError, LIMITS } from "../rungs/limits";
import {
  checkWriteLimit,
  homeFor,
  isPublicDemo,
  requireAdmin,
  requireDemo,
  requireUser,
  resetCurrentDemo,
  signIn,
  signOut,
} from "./session";

export type ActionState = { error?: string; success?: string } | undefined;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const comment = (form: FormData) => {
  const value = text(form, "comment");
  return value === "" ? {} : { comment: value };
};

/**
 * Runs a command; a RungsError becomes a message for the form, anything else stays an error.
 * Online, being over a limit is also a message, and the command does not run.
 */
async function attempt(command: () => Promise<unknown>, success?: string): Promise<ActionState> {
  try {
    await checkWriteLimit();
    await command();
  } catch (error) {
    if (error instanceof DemoLimitError) return { error: error.message };
    revalidatePath("/", "layout"); // show the latest state next to the message
    return { error: describeError(error) };
  }
  revalidatePath("/", "layout");
  return success === undefined ? undefined : { success };
}

function readExpense(form: FormData): ExpenseDetails | string {
  return checkExpense({
    title: text(form, "title"),
    category: text(form, "category"),
    amount: text(form, "amount"),
  });
}

// ---------- Sign in ----------

export async function signInAction(userId: string): Promise<void> {
  try {
    await signIn(userId);
  } catch (error) {
    if (error instanceof DemoLimitError) redirect(`/login?notice=${error.reason}`);
    throw error;
  }
  const user = person(userId);
  redirect(user === undefined ? "/" : homeFor(user));
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

// ---------- Requester ----------

export async function submitAction(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const details = readExpense(form);
  if (typeof details === "string") return { error: details };
  const expenseId = text(form, "expenseId"); // rendered once per form: a double submit is harmless
  if (!isExpenseId(expenseId)) return { error: "This form is out of date. Reload the page." };
  const demo = await requireDemo();
  if (isPublicDemo() && (await countExpenses(demo.db)) >= LIMITS.expensesPerSandbox) {
    return { error: "This demo holds enough expenses. Use Reset demo to start over." };
  }
  let requestId: string | undefined;
  const result = await attempt(async () => {
    const request = await submitExpense(demo, { requesterId: user.id, details, expenseId });
    requestId = request.id;
  });
  if (requestId === undefined) return result;
  redirect(`/requests/${requestId}`);
}

export async function withdrawAction(
  requestId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const tooLong = commentTooLong(text(form, "comment"));
  if (tooLong !== undefined) return { error: tooLong };
  const { rungs } = await requireDemo();
  return attempt(
    () =>
      rungs.withdraw({ requestId, actorId: user.id, expectedVersion: version, ...comment(form) }),
    "You withdrew this expense.",
  );
}

export async function resubmitAction(
  requestId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const details = readExpense(form);
  if (typeof details === "string") return { error: details };
  const demo = await requireDemo();
  return attempt(
    () => resubmitExpense(demo, { requestId, actorId: user.id, details, expectedVersion: version }),
    "Resubmitted. The approval starts again from the first step.",
  );
}

// ---------- Approver ----------

// #region decide-action
export async function decideAction(
  requestId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const tooLong = commentTooLong(text(form, "comment"));
  if (tooLong !== undefined) return { error: tooLong };
  const { rungs } = await requireDemo();
  const input = { requestId, actorId: user.id, expectedVersion: version, ...comment(form) };
  switch (text(form, "decision")) {
    case "approve":
      return attempt(() => rungs.approve(input), "Approved.");
    case "reject":
      return attempt(() => rungs.reject(input), "Rejected.");
    case "return":
      return attempt(
        () => rungs.return({ ...input, to: "requester" }),
        "Returned to the requester.",
      );
    default:
      return { error: "Choose approve, reject or return." };
  }
}
// #endregion decide-action

export async function delegateAction(
  requestId: string,
  taskId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const toUserId = text(form, "toUserId");
  if (person(toUserId) === undefined) return { error: "Choose who should decide instead." };
  const tooLong = commentTooLong(text(form, "comment"));
  if (tooLong !== undefined) return { error: tooLong };
  const { rungs } = await requireDemo();
  return attempt(
    () =>
      rungs.delegate({
        requestId,
        taskId,
        actorId: user.id,
        toUserId,
        expectedVersion: version,
        ...comment(form),
      }),
    `Handed over to ${person(toUserId)?.name}.`,
  );
}

// ---------- Out of office ----------

export async function setAwayAction(_: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const toUserId = text(form, "toUserId");
  const from = text(form, "from");
  const until = text(form, "until");
  if (person(toUserId) === undefined) return { error: "Choose who covers for you." };
  const badDates = checkAwayDates(from, until);
  if (badDates !== undefined) return { error: badDates };
  const endsAt = new Date(`${until}T00:00:00.000Z`);
  endsAt.setUTCDate(endsAt.getUTCDate() + 1); // the rule covers the whole last day
  const { rungs } = await requireDemo();
  return attempt(
    () =>
      rungs.delegations.set({
        fromUserId: user.id, // Rungs does not check who may set a rule; the app does
        toUserId,
        startsAt: `${from}T00:00:00.000Z`,
        endsAt: endsAt.toISOString(),
      }),
    `${person(toUserId)?.name} covers for you from ${from} to ${until}.`,
  );
}

export async function endAwayAction(ruleId: string): Promise<void> {
  const user = await requireUser();
  const { rungs } = await requireDemo();
  const rules = await rungs.delegations.list({ userId: user.id });
  if (!rules.some((r) => r.id === ruleId && r.fromUserId === user.id)) return;
  await attempt(() => rungs.delegations.end({ id: ruleId }));
}

// ---------- Admin ----------

export async function setActiveAction(userId: string, active: boolean): Promise<void> {
  await requireAdmin();
  if (person(userId) === undefined) return;
  const demo = await requireDemo();
  await attempt(() => setActive(demo.db, demo.inactive, userId, active));
}

export async function reassignStepAction(
  requestId: string,
  stepId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const toUserIds = form.getAll("toUserIds").map(String);
  if (!arePeople(toUserIds)) return { error: "Choose at least one person." };
  const reason = text(form, "comment");
  if (reason === "") return { error: "Say why, for the audit trail." };
  const tooLong = commentTooLong(reason);
  if (tooLong !== undefined) return { error: tooLong };
  const { rungs } = await requireDemo();
  return attempt(
    () =>
      rungs.reassign({
        requestId,
        stepId,
        adminId: admin.id,
        toUserIds,
        comment: reason,
        expectedVersion: version,
      }),
    "The step is active again.",
  );
}

export async function retryStepAction(
  requestId: string,
  stepId: string,
  version: number,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const { rungs } = await requireDemo();
  let still = false;
  const result = await attempt(async () => {
    const state = await rungs.retry({
      requestId,
      stepId,
      adminId: admin.id,
      expectedVersion: version,
    });
    still = state.steps.some((s) => s.stepId === stepId && s.status === "blocked");
  });
  if (result?.error !== undefined) return result;
  return still
    ? { error: "Still blocked: nobody active can approve this step yet." }
    : { success: "Unblocked: the approvers have their tasks." };
}

export async function overrideAction(
  requestId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const admin = await requireAdmin();
  const decision = text(form, "decision");
  const reason = text(form, "comment");
  if (decision !== "approve" && decision !== "reject") return { error: "Choose a decision." };
  if (reason === "") return { error: "An override needs a reason, for the audit trail." };
  const tooLong = commentTooLong(reason);
  if (tooLong !== undefined) return { error: tooLong };
  const { rungs } = await requireDemo();
  return attempt(
    () =>
      rungs.override({
        requestId,
        adminId: admin.id,
        decision,
        comment: reason,
        expectedVersion: version,
      }),
    decision === "approve" ? "Approved by override." : "Rejected by override.",
  );
}

// ---------- Demo clock ----------

const HOUR = 3_600_000;

export async function advanceAction(_: ActionState, form: FormData): Promise<ActionState> {
  await requireUser();
  const hours = Number(form.get("hours"));
  if (![1, 24, 72].includes(hours)) return { error: "Unknown step." };
  try {
    await checkWriteLimit({ clock: true });
  } catch (error) {
    if (error instanceof DemoLimitError) return { error: error.message };
    throw error;
  }
  const demo = await requireDemo();
  const summary = await advanceTime(demo, hours * HOUR);
  revalidatePath("/", "layout");
  const moved = hours === 1 ? "1 hour" : `${hours / 24} day${hours === 24 ? "" : "s"}`;
  const changed = summary.changed.length;
  return {
    success:
      changed === 0
        ? `+${moved}. Nothing was due.`
        : `+${moved}. Rungs updated ${changed} request${changed === 1 ? "" : "s"}: reminders, escalations or timeouts.`,
  };
}

export async function resetAction(): Promise<void> {
  await requireUser();
  try {
    await checkWriteLimit();
  } catch (error) {
    if (error instanceof DemoLimitError) redirect("/");
    throw error;
  }
  await resetCurrentDemo();
  revalidatePath("/", "layout");
  redirect("/");
}
