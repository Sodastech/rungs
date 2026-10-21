import type { AuditEvent } from "@rungsjs/core";
import { formatDateTime } from "../app/format";
import { nameOf } from "../rungs/directory";
import { stepName } from "../rungs/flow";

type Tone = "ok" | "bad" | "warn" | "";

const names = (ids: readonly string[]) => ids.map(nameOf).join(", ");

/** One sentence per audit event. The audit trail is the record of who did what, and why. */
function describe(e: AuditEvent): { text: string; tone: Tone; comment?: string } | null {
  const actor = nameOf(e.actorId);
  switch (e.type) {
    case "request.submitted":
      return { text: `${actor} submitted the expense`, tone: "" };
    case "request.approved":
      return e.data.reason === "override"
        ? { text: `${actor} approved it by override`, tone: "ok", comment: e.data.comment }
        : { text: "Expense approved", tone: "ok" };
    case "request.rejected":
      if (e.data.reason === "override") {
        return { text: `${actor} rejected it by override`, tone: "bad", comment: e.data.comment };
      }
      return {
        text: e.data.reason === "timeout" ? "Rejected: the deadline passed" : "Expense rejected",
        tone: "bad",
      };
    case "request.returned":
      return { text: "Returned to the requester", tone: "warn" };
    case "request.resubmitted":
      return { text: `${actor} resubmitted it; the approval starts again`, tone: "" };
    case "request.withdrawn":
      return {
        text: `${actor} withdrew the expense`,
        tone: "",
        ...("comment" in e.data && e.data.comment !== undefined ? { comment: e.data.comment } : {}),
      };
    case "request.escalated":
      return {
        text: `Escalated to ${names(e.data.toUserIds)}: nobody decided in time`,
        tone: "warn",
      };
    case "request.escalation_failed":
      return { text: "Escalation failed; an administrator is needed", tone: "bad" };
    case "step.activated":
      return {
        text: `${stepName(e.data.stepId)} step: sent to ${names(e.data.approvers)}`,
        tone: "",
      };
    case "step.skipped":
      return { text: `${stepName(e.data.stepId)} step not needed for this amount`, tone: "" };
    case "step.blocked": {
      const inactive = (e.data.removed ?? []).filter((r) => r.reason === "inactive");
      const why = inactive.length > 0 ? ` (${names(inactive.map((r) => r.userId))} inactive)` : "";
      return {
        text: `${stepName(e.data.stepId)} step blocked: nobody can approve${why}`,
        tone: "bad",
      };
    }
    case "step.still_blocked":
      return {
        text: `${stepName(e.data.stepId)} step still blocked (reminder ${e.data.count})`,
        tone: "warn",
      };
    case "step.reassigned":
      return {
        text: `${actor} gave the ${stepName(e.data.stepId)} step to ${names(e.data.toUserIds)}`,
        tone: "",
        comment: e.data.comment,
      };
    case "step.retried":
      return {
        text:
          e.data.result === "unblocked"
            ? `${actor} retried the ${stepName(e.data.stepId)} step: unblocked`
            : `${actor} retried the ${stepName(e.data.stepId)} step: still blocked`,
        tone: e.data.result === "unblocked" ? "" : "warn",
      };
    case "step.completed":
      return null; // the request or task events already say it
    case "step.timed_out":
      return { text: `${stepName(e.data.stepId)} step timed out`, tone: "warn" };
    case "step.cancelled":
      return null;
    case "task.assigned":
      // Shown only when out-of-office rules redirected the task; step.activated covers the rest.
      return e.data.onBehalfOf === undefined
        ? null
        : {
            text: `${nameOf(e.data.assigneeId)} covers for ${nameOf(e.data.onBehalfOf)}`,
            tone: "",
          };
    case "task.approved":
    case "task.rejected": {
      const verb = e.type === "task.approved" ? "approved" : "rejected";
      const forWhom =
        e.data.onBehalfOf !== undefined && e.data.onBehalfOf !== e.actorId
          ? ` for ${nameOf(e.data.onBehalfOf)}`
          : "";
      return {
        text: `${actor} ${verb}${forWhom}`,
        tone: verb === "approved" ? "ok" : "bad",
        ...(e.data.comment === undefined ? {} : { comment: e.data.comment }),
      };
    }
    case "task.returned":
      return {
        text: `${actor} sent it back for changes`,
        tone: "warn",
        ...(e.data.comment === undefined ? {} : { comment: e.data.comment }),
      };
    case "task.delegated":
      return {
        text: `${actor} handed the task to ${nameOf(e.data.toUserId)}`,
        tone: "",
        ...(e.data.comment === undefined ? {} : { comment: e.data.comment }),
      };
    case "task.reassigned":
      return {
        text: `${actor} moved the task to ${nameOf(e.data.toUserId)}`,
        tone: "",
        comment: e.data.comment,
      };
    case "task.reminder":
      return {
        text: e.data.overdue
          ? `Overdue reminder sent to ${nameOf(e.data.assigneeId)}`
          : `Reminder sent to ${nameOf(e.data.assigneeId)}: due soon`,
        tone: e.data.overdue ? "warn" : "",
      };
    case "task.expired":
      return null;
    case "task.superseded":
      return null;
    case "task.deduplicated":
      return {
        text: `${nameOf(e.data.assigneeId)} already approved earlier; counted again`,
        tone: "ok",
      };
    case "task.cancelled":
      return null;
    case "delegation.skipped":
      return {
        text: `${nameOf(e.data.userId)} is away, but ${nameOf(e.data.toUserId)} could not cover (${e.data.reason})`,
        tone: "",
      };
    case "delegation.cycle_detected":
      return {
        text: "Out-of-office rules point in a circle; kept with the original approver",
        tone: "warn",
      };
    case "request.resubmit_overdue":
      return { text: "The requester has not resubmitted in time", tone: "warn" };
    default:
      return null;
  }
}

export function Timeline({ events }: { events: readonly AuditEvent[] }) {
  return (
    <ol className="timeline">
      {[...events].reverse().flatMap((e) => {
        const d = describe(e);
        if (d === null) return [];
        const classes = [d.tone, e.actorId === null ? "system" : ""].filter(Boolean).join(" ");
        return [
          <li key={e.seq} className={classes}>
            <p className="event-text">{d.text}</p>
            <div className="event-meta">
              <time dateTime={e.at}>{formatDateTime(e.at)}</time>
              {e.actorId === null ? " · automatic" : ""}
            </div>
            {d.comment !== undefined && <p className="event-comment">“{d.comment}”</p>}
          </li>,
        ];
      })}
    </ol>
  );
}
