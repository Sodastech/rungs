---
"@rungs/core": minor
---

Add time: deadlines, reminders, timeouts and escalation, driven by a new `tick` command.

- Steps with a `deadline` get `deadline` timers at activation; `tick` sends `remindBefore` and
  overdue reminders, then repeats them every `remindOverdueEvery` (default `P1D`, EC-55).
- `onTimeout`: `remind`, `auto-approve`, `auto-reject` and `escalate` (EC-26, EC-28). Escalation
  targets never vote twice (EC-54) and failures keep the tasks pending with an alert.
- Blocked steps repeat `step.still_blocked` every `remindBlockedEvery` (default `P1D`, EC-53).
- Returned requests can have a `resubmitDeadline` with `remind` or `auto-withdraw` (EC-52).
- Injected synchronous `calendar` (EC-30). New `Decision` kind `unchanged` and `nextDueAt` on
  the request state.
