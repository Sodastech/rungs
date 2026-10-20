import { expect, it } from "vitest";

// Node 22+ provides crypto.randomUUID globally; the packages compile without DOM or Node types.
declare const crypto: { randomUUID(): string };

// The quick-start example from README.md, the same code between the markers except that the README
// imports statically at the top. Keep both in sync.
it("the README example runs as written", async () => {
  const log: string[] = [];
  const console = { log: (value: string) => log.push(value) };

  // README:start
  const { createRungs } = await import("@rungsjs/core");
  const { memoryStore } = await import("@rungsjs/store-memory");

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
  // README:end

  expect(log).toEqual(["approved"]);
});
