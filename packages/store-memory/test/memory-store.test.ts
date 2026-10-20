import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/index.js";

// The shared contract runs in contract.test.ts; this file covers what only the memory store has.
describe("memoryStore", () => {
  it("snapshot() returns copies of everything, starting with the given delegation rules", async () => {
    const rule = {
      id: "d1",
      fromUserId: "u_a",
      toUserId: "u_b",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-02-01T00:00:00.000Z",
    };
    const store = memoryStore({ delegations: [rule] });
    const snapshot = store.snapshot();
    expect(snapshot).toEqual({
      flows: [],
      requests: [],
      audit: [],
      outbox: [],
      idempotency: [],
      delegations: [rule],
    });
    snapshot.delegations.pop();
    expect(store.snapshot().delegations).toEqual([rule]);
    expect(await store.transaction((tx) => tx.findDelegations(["u_a"]))).toEqual([rule]);
  });
});
