---
"@rungs/core": minor
---

Add the approver resolution pipeline and blocked steps.

- Remove inactive users (EC-06) and the requester (EC-01) with the reason recorded in `removed`;
  merge duplicates (EC-44); carry over earlier approvals as `skipped-duplicate` tasks (EC-03).
- Submit resolves every applicable step up front and fails with the new `NoApproversError`
  (`NO_APPROVERS`) when a step has no approvers or cannot reach its quorum (EC-43, EC-45).
- Mid-flow, such a step becomes `blocked` with a `step.blocked` event (EC-42). New commands
  `reassign` (step), `retry` and `override` resolve it (EC-46, EC-18).
- Breaking: `ResolutionError` (`RESOLUTION_FAILED`) now means a host callback failed; it carries
  the original error as `cause` and no longer has `reason`. `ResolutionFailure` is removed.
  `request.rejected` data now has `reason: "step-rejected" | "override"`.
