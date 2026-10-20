---
"@rungsjs/core": minor
---

Add the service: `createRungs` wires the engine to a store, the host's resolvers, a clock and
event hooks.

- `flows.register` with versioning per tenant and key, identical content returning the existing
  version, and checks that named resolvers exist. Tenant flows fall back to global ones (EC-56).
- Commands with `expectedVersion` (`ConflictError`, EC-15) and tenant-scoped `idempotencyKey`
  (EC-16, EC-57). `tick` and `dispatchPending` for scheduled jobs.
- Outbox delivery after commit with per-request ordering and exponential backoff.
- New `RungsStore` interface for adapters, `ConflictError`, `FlowNotFoundError`, and
  `flowTenantId` on pinned requests.
