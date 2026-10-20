import type { DelegationSkipReason } from "./delegation.js";
import type { ReturnPolicy } from "./flow.js";
import type { ApproverShortfall, RemovedApprover, SkipReason, Subject } from "./state.js";

interface TaskData {
  taskId: string;
  stepId: string;
}

interface DecisionData extends TaskData {
  comment?: string;
}

interface StepData {
  stepId: string;
  stepIndex: number;
}

/** `returnedToOriginal`: the task went back to the approver it acted for (EC-50). */
interface HandoverData extends TaskData {
  toTaskId: string;
  toUserId: string;
  returnedToOriginal?: true;
}

/** Present only when the resolution removed someone (EC-01, EC-06). */
interface RemovedData {
  removed?: RemovedApprover[];
}

/** Type and data of every audit event, discriminated by `type`. */
export type AuditEventBody =
  | { type: "request.submitted"; data: { flowKey: string; flowVersion: number; subject: Subject } }
  | {
      type: "request.approved";
      data:
        | { reason: "steps-approved" }
        | { reason: "all-steps-skipped"; skippedStepIds: string[] }
        | { reason: "override"; comment: string };
    }
  | {
      type: "request.rejected";
      data: { reason: "step-rejected"; stepId: string } | { reason: "override"; comment: string };
    }
  | { type: "request.returned"; data: { stepId: string; comment?: string } }
  | {
      type: "request.resubmitted";
      /** `applied` differs from `returnPolicy` when a changed payload forced a restart (EC-51). */
      data: { returnPolicy: ReturnPolicy; applied: ReturnPolicy; payloadChanged: boolean };
    }
  | { type: "request.withdrawn"; data: { comment?: string } }
  | { type: "step.activated"; data: StepData & RemovedData & { approvers: string[] } }
  | { type: "step.skipped"; data: StepData & RemovedData & { reason: SkipReason } }
  | { type: "step.blocked"; data: StepData & RemovedData & { reason: ApproverShortfall } }
  | { type: "step.reassigned"; data: StepData & { toUserIds: string[]; reason: string } }
  | {
      type: "step.retried";
      data: StepData &
        (
          | { result: "unblocked" }
          | ({ result: "still-blocked"; reason: ApproverShortfall } & RemovedData)
        );
    }
  | { type: "step.completed"; data: StepData & { outcome: "approved" | "rejected" | "returned" } }
  | { type: "step.cancelled"; data: StepData }
  | {
      type: "task.assigned";
      /** `chain`: the out-of-office hops followed, from the first user to the assignee. */
      data: TaskData & { assigneeId: string; onBehalfOf?: string; chain?: string[] };
    }
  | { type: "task.delegated"; data: HandoverData & { reason?: string } }
  | { type: "task.reassigned"; data: HandoverData & { reason: string } }
  | {
      type: "delegation.skipped";
      data: { stepId: string; userId: string; toUserId: string; reason: DelegationSkipReason };
    }
  | { type: "delegation.cycle_detected"; data: { stepId: string; userId: string; chain: string[] } }
  | { type: "task.deduplicated"; data: TaskData & { assigneeId: string; ofTaskId: string } }
  | { type: "task.approved"; data: DecisionData }
  | { type: "task.rejected"; data: DecisionData }
  | {
      type: "task.returned";
      data: DecisionData & { to: "requester" | { stepId: string } };
    }
  | { type: "task.superseded"; data: TaskData & { byTaskId: string } }
  | { type: "task.cancelled"; data: TaskData };

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
