---
"@rungs/core": minor
---

Add queries and delegation rules to the service: `get` (null when unknown), `history`, `inbox`
with tenant matching and cursor paging, `preview` of the approval chain without storing anything,
and `delegations.set / list / end` (a rule ended before it starts is cancelled with
`cancelledAt`). `RungsStore` gains `getAudit`, `findInbox`, `saveDelegation`, `getDelegation` and
`listDelegations`.
