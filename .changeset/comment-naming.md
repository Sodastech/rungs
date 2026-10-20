---
"@rungs/core": minor
---

Breaking: free text is always `comment`. `delegate`, `reassign`, `override` and `withdraw` take
`comment` instead of `reason`, and `step.reassigned`, `task.delegated` and `task.reassigned` store
it as `comment`. `reason` is reserved for machine-readable causes.
