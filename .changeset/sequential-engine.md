---
"@rungs/core": minor
---

Add the pure engine `decide(state, command, ctx)` with submit, approve and reject for sequential
flows: conditional steps (EC-38), all-skipped handling (EC-39), up-front condition checks at submit
(EC-41), mode `any` (EC-12), append-only audit events and derived domain events. New errors:
`InvalidCommandError`, `InvalidTransitionError`, `NotAssignedError`, `RequestNotFoundError` and
`ResolutionError`. `StepDefinition.onTimeout` is now present only when the step has a deadline.
