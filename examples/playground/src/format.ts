import type {
  AuditEvent,
  Condition,
  PreviewResult,
  RemovedApprover,
  RequestState,
} from "@rungsjs/core";

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  good(text: string): string;
  bad(text: string): string;
  warn(text: string): string;
  info(text: string): string;
}

export function style(color: boolean): Style {
  const wrap = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    good: wrap("32"),
    bad: wrap("31"),
    warn: wrap("33"),
    info: wrap("36"),
  };
}

export type Names = (userId: string) => string;

/** "2026-03-02T09:00:00.000Z" → "2026-03-02 09:00". */
export function time(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

const REMOVAL: Record<RemovedApprover["reason"], string> = {
  requester: "is the requester",
  inactive: "is inactive",
  "already-voted": "already voted",
};

const DELEGATION_SKIP: Record<string, string> = {
  requester: "the delegate is the requester",
  inactive: "the delegate is inactive",
  "target-already-approver": "the delegate already has a vote in this step",
  "target-already-decided": "the delegate approved an earlier step",
};

function removed(list: RemovedApprover[] | undefined, name: Names): string[] {
  return (list ?? []).map((r) => `removed ${name(r.userId)}: ${REMOVAL[r.reason]}`);
}

function condition(c: Condition): string {
  if ("field" in c) return `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
  if ("all" in c) return `all(${c.all.map(condition).join(", ")})`;
  if ("any" in c) return `any(${c.any.map(condition).join(", ")})`;
  return `not(${condition(c.not)})`;
}

function shortfall(reason: { type: string; required?: number; available?: number }): string {
  return reason.type === "no-approvers"
    ? "nobody left to approve"
    : `needs ${reason.required} approvers, has ${reason.available}`;
}

/** One audit event as indented, human-readable lines. */
export function describe(
  event: AuditEvent,
  name: Names,
  s: Style,
  taskOwner: (taskId: string) => string,
): string[] {
  const d = event.data as Record<string, unknown>;
  const step = typeof d.stepId === "string" ? s.bold(d.stepId) : "";
  switch (event.type) {
    case "request.submitted":
      return [`request submitted on flow ${event.data.flowKey} v${event.data.flowVersion}`];
    case "request.resubmitted":
      return [
        `resubmitted: ${event.data.applied === "restart" ? "starts over from the first step" : "resumes at the step that returned it"}` +
          (event.data.payloadChanged ? s.warn(" (payload changed)") : " (same payload)") +
          (event.data.applied !== event.data.returnPolicy
            ? s.dim(` — returnPolicy is ${event.data.returnPolicy}, but a changed payload restarts`)
            : ""),
      ];
    case "request.approved":
      return [s.good(`request APPROVED (${event.data.reason})`)];
    case "request.rejected":
      return [s.bad(`request REJECTED (${event.data.reason})`)];
    case "request.returned":
      return [s.warn(`request returned to the requester from ${step}`)];
    case "request.withdrawn":
      return [s.warn("request withdrawn")];
    case "step.activated": {
      const lines = [
        `step ${step} is active · approvers: ${event.data.approvers.map(name).join(", ")}`,
      ];
      return [...lines, ...removed(event.data.removed, name).map((l) => `  ${s.dim(l)}`)];
    }
    case "step.skipped": {
      const why =
        event.data.reason.type === "condition-false"
          ? `condition is false (${condition(event.data.reason.condition)})`
          : "nobody to approve and onEmptyStep is skip";
      return [
        s.dim(`step ${step} skipped: ${why}`),
        ...removed(event.data.removed, name).map((l) => `  ${s.dim(l)}`),
      ];
    }
    case "step.blocked":
      return [
        s.warn(
          `step ${step} BLOCKED: ${shortfall(event.data.reason)}; an admin must reassign or retry`,
        ),
        ...removed(event.data.removed, name).map((l) => `  ${s.dim(l)}`),
      ];
    case "step.completed":
      return [`step ${step} ${event.data.outcome}`];
    case "task.assigned": {
      const behalf = event.data.onBehalfOf ? ` on behalf of ${name(event.data.onBehalfOf)}` : "";
      const chain = event.data.chain
        ? s.dim(` (out-of-office: ${event.data.chain.map(name).join(" → ")})`)
        : "";
      return [`task for ${name(event.data.assigneeId)}${behalf}${chain}`];
    }
    case "task.deduplicated":
      return [
        s.info(
          `${name(event.data.assigneeId)}: earlier approval carries over as one vote (skipped-duplicate)`,
        ),
      ];
    case "task.approved":
    case "task.rejected": {
      const verb = event.type === "task.approved" ? s.good("approved") : s.bad("rejected");
      const comment = event.data.comment ? s.dim(` — "${event.data.comment}"`) : "";
      return [`${name(event.actorId ?? "")} ${verb}${acting(event.data, name)}${comment}`];
    }
    case "task.returned": {
      const to = event.data.to === "requester" ? "the requester" : `step ${event.data.to.stepId}`;
      const comment = event.data.comment ? s.dim(` — "${event.data.comment}"`) : "";
      return [
        s.warn(`${name(event.actorId ?? "")} returned it to ${to}${acting(event.data, name)}`) +
          comment,
      ];
    }
    case "task.delegated":
      return [
        `${name(event.actorId ?? "")} handed the task to ${name(event.data.toUserId)}` +
          (event.data.returnedToOriginal ? " (back to its owner)" : ""),
      ];
    case "task.reassigned":
      return [`admin moved the task to ${name(event.data.toUserId)}`];
    case "task.superseded":
      return [s.dim(`${taskOwner(event.data.taskId)}: task no longer needed (step decided)`)];
    case "task.cancelled":
      return [s.dim(`${taskOwner(event.data.taskId)}: task cancelled`)];
    case "task.expired":
      return [s.dim(`${taskOwner(event.data.taskId)}: task expired`)];
    case "task.reminder":
      return [
        s.warn(
          `reminder to ${name(event.data.assigneeId)}: ${event.data.overdue ? `overdue (#${event.data.count})` : "deadline coming up"}, due ${time(event.data.deadlineAt)}`,
        ),
      ];
    case "delegation.skipped":
      return [
        s.dim(
          `out-of-office ${name(event.data.userId)} → ${name(event.data.toUserId)} not used: ${DELEGATION_SKIP[event.data.reason] ?? event.data.reason}`,
        ),
      ];
    case "delegation.cycle_detected":
      return [
        s.warn(
          `delegation cycle ${event.data.chain.join(" → ")}; task stays with ${name(event.data.userId)}`,
        ),
      ];
    default:
      return [s.dim(`${event.type} ${JSON.stringify(event.data)}`)];
  }
}

/** EC-60: a decision by the owner of a delegated vote, or by the delegate on their behalf. */
function acting(data: { onBehalfOf?: string; heldBy?: string }, name: Names): string {
  if (data.heldBy) return ` directly (task held by ${name(data.heldBy)})`;
  if (data.onBehalfOf) return ` on behalf of ${name(data.onBehalfOf)}`;
  return "";
}

/** Where the request stands after an action. */
export function standing(state: RequestState, name: Names, s: Style): string {
  if (state.status !== "pending") {
    const label = `status: ${state.status.toUpperCase()}`;
    return state.status === "approved"
      ? s.good(label)
      : state.status === "returned"
        ? s.warn(label)
        : s.bad(label);
  }
  const open = state.steps.findLast(
    (step) => step.status === "active" || step.status === "blocked",
  );
  if (open === undefined) return "status: pending";
  if (open.status === "blocked") return s.warn(`status: pending · step ${open.stepId} is blocked`);
  const waiting = open.tasks
    .filter((t) => t.status === "pending")
    .map((t) =>
      t.onBehalfOf ? `${name(t.assigneeId)} for ${name(t.onBehalfOf)}` : name(t.assigneeId),
    );
  const due = open.deadline ? s.dim(` · due ${time(open.deadline.deadlineAt)}`) : "";
  return `status: pending · waiting on ${s.bold(open.stepId)}: ${waiting.join(", ")}${due}`;
}

export function previewLines(result: PreviewResult, name: Names, s: Style): string[] {
  const lines = result.steps.map((step) => {
    if (step.status === "skipped") return s.dim(`  ${step.stepId}: skipped`);
    if (step.status === "cannot-run")
      return s.bad(
        `  ${step.stepId}: cannot run (${shortfall(step.shortfall ?? { type: "no-approvers" })})`,
      );
    const via = step.delegations.map((d) => `${name(d.toUserId)} for ${name(d.userId)}`);
    return `  ${step.stepId}: ${step.approvers.map(name).join(", ")}${via.length > 0 ? s.dim(` (out-of-office: ${via.join(", ")})`) : ""}`;
  });
  return [
    `preview: ${result.submittable ? s.good("submittable") : s.bad("would be refused")}`,
    ...lines,
  ];
}
