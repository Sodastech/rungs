import type { DomainEvent, RequestState } from "@rungsjs/core";
import type { PgClient } from "@rungsjs/store-postgres";
import { SCHEMA } from "./db";
import { nameOf, people } from "./directory";
import { stepName } from "./flow";

export interface Notification {
  readonly requestId: string;
  readonly message: string;
  readonly at: string;
}

const admins = () => people.filter((p) => p.roles.includes("admin")).map((p) => p.id);

/** Who hears about an event, and what they read. A real app would send email or chat here. */
function recipients(event: DomainEvent, request: RequestState): [string[], string] | null {
  const title = (request.payload as { title?: string }).title ?? "an expense";
  const requester = nameOf(request.requesterId);
  switch (event.type) {
    case "task.assigned": {
      const covering =
        event.data.onBehalfOf === undefined
          ? ""
          : ` (covering for ${nameOf(event.data.onBehalfOf)})`;
      return [
        [event.data.assigneeId],
        `${requester} needs your approval for "${title}"${covering}.`,
      ];
    }
    case "task.reminder":
      return [
        [event.data.assigneeId],
        event.data.overdue
          ? `Overdue: "${title}" from ${requester} is waiting for your decision.`
          : `Reminder: "${title}" from ${requester} is due soon.`,
      ];
    case "request.approved":
      return [[request.requesterId], `"${title}" was approved.`];
    case "request.rejected":
      return [[request.requesterId], `"${title}" was rejected.`];
    case "request.returned":
      return [[request.requesterId], `"${title}" was returned to you for changes.`];
    case "request.escalated":
      return [[request.requesterId], `"${title}" was escalated: your manager did not respond.`];
    case "step.blocked":
    case "step.still_blocked":
      return [
        admins(),
        `"${title}" is blocked at ${stepName(event.data.stepId)}: nobody can approve it.`,
      ];
    case "request.escalation_failed":
      return [admins(), `Escalating "${title}" failed. It needs an administrator.`];
    default:
      return null;
  }
}

/**
 * `onEvent` handler: Rungs calls it after each command commits, at least once per event. The
 * primary key (request, seq, user) makes a repeated delivery harmless.
 */
export async function notify(db: PgClient, event: DomainEvent, request: RequestState) {
  const found = recipients(event, request);
  if (found === null) return;
  const [userIds, message] = found;
  for (const userId of userIds) {
    await db.query(
      `INSERT INTO ${SCHEMA}.notifications (request_id, seq, user_id, message, at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [event.requestId, event.seq, userId, message, event.at],
    );
  }
}

export async function notificationsFor(
  db: PgClient,
  userId: string,
  limit = 50,
): Promise<Notification[]> {
  const { rows } = await db.query<{ request_id: string; message: string; at: Date | string }>(
    `SELECT request_id, message, at FROM ${SCHEMA}.notifications
     WHERE user_id = $1 ORDER BY at DESC, seq DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    requestId: r.request_id,
    message: r.message,
    at: new Date(r.at).toISOString(),
  }));
}
