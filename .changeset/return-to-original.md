---
"@rungs/core": minor
---

A delegated task can be handed back to the approver it acts for, by the delegate or an admin
(EC-50). The new task has no `onBehalfOf`; `task.delegated` and `task.reassigned` carry
`returnedToOriginal: true`.
