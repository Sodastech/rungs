---
"@rungsjs/core": minor
---

`StoreTx.findDue` and `StoreTx.pendingEvents` take an optional `claim` flag, passed by `tick` and
event delivery so adapters can lease rows for concurrent workers, and `markDispatched` receives the
delivery time. Existing adapters keep working unchanged.
