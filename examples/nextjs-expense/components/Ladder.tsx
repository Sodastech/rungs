import type { PreviewResult, RequestState, StepInstance, Task } from "@rungsjs/core";
import { relative } from "../app/format";
import { nameOf } from "../rungs/directory";
import { expenseFlow } from "../rungs/flow";
import { Avatar, Badge, type Tone } from "./ui";

const stepLook: Record<StepInstance["status"], [Tone | "active", string]> = {
  active: ["active", "Waiting"],
  blocked: ["warn", "Blocked"],
  approved: ["ok", "Approved"],
  rejected: ["bad", "Rejected"],
  returned: ["info", "Returned"],
  skipped: ["idle", "Not needed"],
  cancelled: ["idle", "Cancelled"],
};

function taskText(task: Task): string {
  const forWhom = task.onBehalfOf === undefined ? "" : ` for ${nameOf(task.onBehalfOf)}`;
  switch (task.status) {
    case "pending":
      return `waiting${forWhom}`;
    case "approved":
    case "rejected":
    case "returned": {
      const by = task.decidedBy === undefined ? "" : ` by ${nameOf(task.decidedBy)}`;
      return `${task.status}${by}${forWhom}`;
    }
    case "delegated":
      return "handed over";
    case "reassigned":
      return "moved by an admin";
    case "superseded":
      return "not needed";
    case "skipped-duplicate":
      return "approved earlier";
    case "expired":
      return "did not respond in time";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * The approval chain, one rung per step of the flow: what happened, who holds it now, and for
 * steps that have not started, what the preview says will happen.
 */
export function Ladder({
  request,
  preview,
  now,
}: {
  request: RequestState;
  preview: PreviewResult | null;
  now: Date;
}) {
  const open = request.status === "pending" || request.status === "returned";
  return (
    <ol className="ladder">
      {expenseFlow.steps.map((step) => {
        // A step can run more than once after a return; show its latest run.
        const instance = request.steps.findLast((s) => s.stepId === step.id);
        const planned = preview?.steps.find((s) => s.stepId === step.id);
        let tone: string;
        let label: string;
        if (instance !== undefined && instance.invalidatedAt === undefined) {
          [tone, label] = stepLook[instance.status];
        } else if (open && planned?.status === "will-run") {
          [tone, label] = ["idle", "Upcoming"];
        } else {
          [tone, label] = ["idle", open ? "Not needed" : "Not reached"];
        }
        const current = instance !== undefined && instance.invalidatedAt === undefined;
        const tasks = current ? instance.tasks : [];
        return (
          <li key={step.id} className={`rung ${tone}`}>
            <div>
              <div className="rung-title">{step.name ?? step.id}</div>
              {tasks.length > 0 && (
                <ul className="people">
                  {tasks.map((task) => (
                    <li key={task.id}>
                      <Avatar userId={task.assigneeId} small />
                      <span>{nameOf(task.assigneeId)}</span>
                      <span className="muted small">{taskText(task)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {tasks.length === 0 && label === "Upcoming" && planned !== undefined && (
                <p className="muted small">
                  {planned.approvers.length > 1 ? "Any one of " : ""}
                  {planned.approvers.map(nameOf).join(", ")}
                </p>
              )}
              {current && instance.status === "blocked" && (
                <p className="small">
                  Nobody active can approve. An administrator can reassign it.
                </p>
              )}
              {current && instance.status === "active" && instance.deadline !== undefined && (
                <p className="muted small">Due {relative(instance.deadline.deadlineAt, now)}</p>
              )}
            </div>
            <Badge tone={tone === "active" ? "warn" : (tone as Tone)}>{label}</Badge>
          </li>
        );
      })}
    </ol>
  );
}
