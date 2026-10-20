---
"@rungs/core": minor
---

Add the request lifecycle commands.

- `return` to the requester or to an earlier step that ran (EC-32, EC-33).
- `resubmit` by the requester with `returnPolicy`; `from-returned-step` restarts when the payload
  changed (EC-34, EC-51). Conditions and approvers are checked up front (EC-41, EC-43).
- `withdraw` by the requester (EC-35). `override` also works on a returned request.
- Step instances that run again keep their history and get `invalidatedAt`.
- New events `task.returned`, `request.returned`, `request.resubmitted`, `request.withdrawn`;
  `step.completed` can have outcome `returned`.
