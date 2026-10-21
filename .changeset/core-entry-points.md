---
"@rungsjs/core": minor
"@rungsjs/store-memory": minor
"@rungsjs/store-postgres": minor
---

Breaking: `@rungsjs/core` has three entry points. Applications keep using `@rungsjs/core`. Store
adapters import `StoreTx`, its query types, `taskViews`, `requestSummary` and `blockedStepView`
from `@rungsjs/core/store`. The pure engine (`decide`, the command types, `Decision`,
`EngineContext`) moved to `@rungsjs/core/engine`.
