---
"@rungsjs/core": minor
---

`RequestStatus` no longer includes `"cancelled"`: the engine never produced it. A closed request is
`approved`, `rejected` or `withdrawn`.
