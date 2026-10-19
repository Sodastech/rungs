---
"@rungs/core": minor
---

Add `FlowNotApplicableError` (`FLOW_NOT_APPLICABLE`) for submits refused by `onAllSkipped: "fail"`,
replacing `InvalidCommandError` there. Non-JSON payload errors now name every offending path and its
type, e.g. `payload.submittedAt is a Date; send an ISO 8601 string`.
