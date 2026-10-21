# @rungsjs/store-memory

An in-memory store for [Rungs](https://www.npmjs.com/package/@rungsjs/core), for tests and
prototypes. Transactions run one at a time on a copy of the data, so a failed command changes
nothing. Data is lost when the process exits: use
[`@rungsjs/store-postgres`](https://www.npmjs.com/package/@rungsjs/store-postgres) in production.

Rungs is `0.x`: the API can still change in minor versions, and every change is in the changelog.

## Install

```bash
npm install @rungsjs/core @rungsjs/store-memory
```

## Example

A flow under test, with a clock the test moves:

```ts
// Your flow, on the memory store, with a clock the test moves. No database, no waiting.
async function setup() {
  let now = new Date("2026-03-02T09:00:00.000Z");
  const rungs = createRungs({
    store: memoryStore(),
    clock: () => now,
    ids: (() => {
      let n = 0;
      return () => `r${++n}`; // predictable ids
    })(),
    events: "discard",
  });
  await rungs.flows.register(expenseFlow);
  return { rungs, advance: (hours: number) => (now = new Date(+now + hours * 3_600_000)) };
}

// Inside your test runner's it(...):
const { rungs, advance } = await setup();
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 10 },
});
advance(49);
await rungs.tick();
const { tasks } = await rungs.inbox({ userId: "u_dir" });
assert.deepEqual(
  tasks.map((t) => t.requestId),
  [request.id],
);
```

## Links

- [Documentation](https://sodastech.github.io/rungs/): [testing guide](https://sodastech.github.io/rungs/guides/testing/)
- [Edge case catalog](https://sodastech.github.io/rungs/edge-cases/): every case Rungs handles, each with a test
- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/Sodastech/rungs/issues)

## License

MIT
