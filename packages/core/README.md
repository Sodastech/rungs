# @rungsjs/core

An approval workflow engine for TypeScript: sequential and parallel steps, delegation, deadlines,
escalation, return and resubmit, and an append-only audit trail, with the edge cases handled and
defaults that fail closed. Pure and deterministic, with no runtime dependencies.

Rungs is `0.x`: the API can still change in minor versions, and every change is in the changelog.

## Install

```bash
npm install @rungsjs/core @rungsjs/store-memory
```

Node.js 22+, ESM only. Use [`@rungsjs/store-postgres`](https://www.npmjs.com/package/@rungsjs/store-postgres)
in production.

## Example

```ts
import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const managers: Record<string, string> = { u_alice: "u_bob" };

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
  roles: async (role) => (role === "finance" ? ["u_fin1", "u_fin2"] : []),
  resolvers: {
    directManager: async ({ request }) => {
      const manager = managers[request.requesterId];
      return manager ? [manager] : [];
    },
  },
});

await rungs.flows.register({
  key: "expense",
  steps: [
    { id: "manager", approvers: { type: "resolver", name: "directManager" } },
    {
      id: "finance",
      approvers: { type: "role", role: "finance" }, // either finance user may decide
      when: { field: "amount", op: "gt", value: 1000 },
      deadline: "P2D",
    },
  ],
});

const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_alice",
  subject: { type: "expense", id: "EXP-1042" },
  payload: { amount: 2500 },
});

await rungs.approve({ requestId: request.id, actorId: "u_bob", comment: "Looks fine" });
const done = await rungs.approve({ requestId: request.id, actorId: "u_fin2" });

console.log(done.status); // "approved"
```

## Entry points

| Import | For |
| --- | --- |
| `@rungsjs/core` | Applications: `createRungs`, `defineFlow`, types, errors |
| `@rungsjs/core/store` | Store adapter authors |
| `@rungsjs/core/engine` | The pure `decide` function, to build your own service |

## Links

- [Documentation](https://sodastech.github.io/rungs/): [getting started](https://sodastech.github.io/rungs/getting-started/) and [API reference](https://sodastech.github.io/rungs/reference/api/rungsjs/core/)
- [Edge case catalog](https://sodastech.github.io/rungs/edge-cases/): every case Rungs handles, each with a test
- [Changelog](./CHANGELOG.md)
- [Issues](https://github.com/Sodastech/rungs/issues)

## License

MIT
