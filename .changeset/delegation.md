---
"@rungsjs/core": minor
---

Add delegation.

- Out-of-office rules arrive with each resolution (`delegations`) and are applied when a task is
  created: chains up to `maxDelegationDepth` (new flow setting, default 3), cycle detection,
  requester and inactive delegates passed over (EC-20..EC-24).
- Delegation never merges votes: a hop to someone who already holds a vote in the step or approved
  an earlier step is skipped with `delegation.skipped` (EC-48, EC-49).
- New commands: `delegate` (EC-25) and `reassign` for a single task. New task status `reassigned`.
  New events `task.delegated`, `task.reassigned`, `delegation.skipped`, `delegation.cycle_detected`.
