---
"@rungs/core": minor
---

`onTimeout: "auto-approve"` no longer approves a step in which a vote already rejected: the step
stays active and gets overdue reminders, and `step.timed_out` records the reason (EC-59).
