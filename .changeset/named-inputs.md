---
"@rungsjs/core": minor
---

Name every command input: `ApproveInput`, `RejectInput`, `ReturnInput`, `ResubmitInput`,
`WithdrawInput`, `DelegateInput`, `ReassignInput`, `RetryInput` and `OverrideInput`, plus
`TickOptions` and `DispatchOptions`. Results are read-only: list pages, `history`,
`delegations.list`, `preview` and the `tick` summary use `readonly` arrays.
