import type { SkipReason, Subject } from "./state.js";

interface TaskData {
  taskId: string;
  stepId: string;
}

interface DecisionData extends TaskData {
  comment?: string;
}

/** Type and data of every audit event, discriminated by `type`. */
export type AuditEventBody =
  | { type: "request.submitted"; data: { flowKey: string; flowVersion: number; subject: Subject } }
  | {
      type: "request.approved";
      data:
        | { reason: "steps-approved" }
        | { reason: "all-steps-skipped"; skippedStepIds: string[] };
    }
  | { type: "request.rejected"; data: { stepId: string } }
  | { type: "step.activated"; data: { stepId: string; stepIndex: number; approvers: string[] } }
  | { type: "step.skipped"; data: { stepId: string; stepIndex: number; reason: SkipReason } }
  | {
      type: "step.completed";
      data: { stepId: string; stepIndex: number; outcome: "approved" | "rejected" };
    }
  | { type: "task.assigned"; data: TaskData & { assigneeId: string } }
  | { type: "task.approved"; data: DecisionData }
  | { type: "task.rejected"; data: DecisionData }
  | { type: "task.superseded"; data: TaskData & { byTaskId: string } };

export type AuditEventType = AuditEventBody["type"];

/** Append-only record of what happened and why. The source of truth for history. */
export type AuditEvent = {
  requestId: string;
  /** Strictly increasing per request, starting at 1. */
  seq: number;
  /** `null` for system actions. */
  actorId: string | null;
  at: string;
} & AuditEventBody;

/** Type and data of every domain event. Derived from audit events; `task.decided` merges decisions. */
export type DomainEventBody =
  | Exclude<AuditEventBody, { type: "task.approved" | "task.rejected" }>
  | { type: "task.decided"; data: DecisionData & { decision: "approved" | "rejected" } };

export type DomainEventType = DomainEventBody["type"];

/** Emitted to the host after a command commits, e.g. to send notifications. */
export type DomainEvent = {
  requestId: string;
  tenantId?: string;
  /** `seq` of the audit event this was derived from. */
  seq: number;
  actorId: string | null;
  at: string;
} & DomainEventBody;
