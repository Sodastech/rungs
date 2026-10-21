"use server";

// Every Server Action here is one Rungs command. The pattern is the same each time: take the
// actor from the session (never from the form), call Rungs, turn a RungsError into a message.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { advanceTime, getDemo, resetDemo, resubmitExpense, submitExpense } from "../rungs/demo";
import { person, setActive } from "../rungs/directory";
import { describeError } from "../rungs/errors";
import type { ExpenseDetails } from "../rungs/expenses";
import { categories } from "../rungs/flow";
import { homeFor, requireAdmin, requireUser, signIn, signOut } from "./session";

export type ActionState = { error?: string; success?: string } | undefined;

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const comment = (form: FormData) => {
  const value = text(form, "comment");
  return value === "" ? {} : { comment: value };
};

/** Runs a command; a RungsError becomes a message for the form, anything else stays an error. */
async function attempt(command: () => Promise<unknown>, success?: string): Promise<ActionState> {
  try {
    await command();
  } catch (error) {
    revalidatePath("/", "layout"); // show the latest state next to the message
    return { error: describeError(error) };
  }
  revalidatePath("/", "layout");
  return success === undefined ? undefined : { success };
}

function readExpense(form: FormData): ExpenseDetails | string {
  const title = text(form, "title");
  const category = text(form, "category");
  const amount = Number(text(form, "amount"));
  if (title.length < 3 || title.length > 80)
    return "Give the expense a title (3 to 80 characters).";
  if (!(categories as readonly string[]).includes(category)) return "Choose a category.";
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    return "Enter an amount between 0.01 and 1,000,000.";
  }
  return { title, category, amount: Math.round(amount * 100) / 100 };
}

// ---------- Sign in ----------

export async function signInAction(userId: string): Promise<void> {
  await signIn(userId);
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
  const demo = await getDemo();
  let requestId: string | undefined;
  const result = await attempt(async () => {
    const request = await submitExpense(demo, {
      requesterId: user.id,
      details,
      expenseId: text(form, "expenseId"), // rendered once per form: a double submit is harmless
    });
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
  const { rungs } = await getDemo();
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
  const demo = await getDemo();
  return attempt(
    () => resubmitExpense(demo, { requestId, actorId: user.id, details, expectedVersion: version }),
    "Resubmitted. The approval starts again from the first step.",
  );
}

// ---------- Approver ----------

export async function decideAction(
  requestId: string,
  version: number,
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const { rungs } = await getDemo();
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
  const { rungs } = await getDemo();
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || until < from) {
    return { error: "Choose a first and a last day; the last day cannot be before the first." };
  }
  const endsAt = new Date(`${until}T00:00:00.000Z`);
  endsAt.setUTCDate(endsAt.getUTCDate() + 1); // the rule covers the whole last day
  const { rungs } = await getDemo();
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
  const { rungs } = await getDemo();
  const rules = await rungs.delegations.list({ userId: user.id });
  if (!rules.some((r) => r.id === ruleId && r.fromUserId === user.id)) return;
  await rungs.delegations.end({ id: ruleId });
  revalidatePath("/", "layout");
}

// ---------- Admin ----------

export async function setActiveAction(userId: string, active: boolean): Promise<void> {
  await requireAdmin();
  const demo = await getDemo();
  await setActive(demo.db, demo.inactive, userId, active);
  revalidatePath("/", "layout");
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
  if (toUserIds.length === 0) return { error: "Choose at least one person." };
  const reason = text(form, "comment");
  if (reason === "") return { error: "Say why, for the audit trail." };
  const { rungs } = await getDemo();
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
  const { rungs } = await getDemo();
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
  const { rungs } = await getDemo();
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
  const demo = await getDemo();
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
  await resetDemo();
  revalidatePath("/", "layout");
  redirect("/");
}
