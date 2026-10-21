import type { RequestStatus } from "@rungsjs/core";
import { initials } from "../app/format";
import { nameOf, people } from "../rungs/directory";

export type Tone = "ok" | "warn" | "bad" | "info" | "idle";

const requestTones: Record<RequestStatus, [Tone, string]> = {
  pending: ["warn", "Pending"],
  approved: ["ok", "Approved"],
  rejected: ["bad", "Rejected"],
  returned: ["info", "Returned"],
  withdrawn: ["idle", "Withdrawn"],
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${tone === "idle" ? "" : tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  const [tone, label] = requestTones[status];
  return <Badge tone={tone}>{label}</Badge>;
}

const avatarColors = ["#3a4560", "#047857", "#3730a3", "#9a3412", "#0e7490", "#7e22ce"];

export function Avatar({ userId, small }: { userId: string; small?: boolean }) {
  const index =
    Math.max(
      0,
      people.findIndex((p) => p.id === userId),
    ) % avatarColors.length;
  return (
    <span
      className={small === true ? "avatar small" : "avatar"}
      style={{ background: avatarColors[index] }}
      aria-hidden="true"
    >
      {initials(nameOf(userId))}
    </span>
  );
}
