# @rungsjs/store-memory

## 0.1.0

### Minor Changes

- 964127b: Initial release.
  
  `memoryStore()`, an in-memory store for tests and prototypes. Transactions run one at a time on a
  copy of the data, which replaces the data on success and is dropped when the command throws.
  `snapshot()` returns everything the store holds, for assertions and debugging. It passes the same
  store contract and service suites as the PostgreSQL store.

### Patch Changes

- Updated dependencies [964127b]
  - @rungsjs/core@0.1.0
