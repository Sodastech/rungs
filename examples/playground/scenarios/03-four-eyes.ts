import { scenario } from "../src/scenario.js";

// All names and data are fictional.
export default scenario({
  name: "Same approver on two steps (four eyes)",
  description:
    "Bob approves as Alice's manager and is also on the budget committee. His approval carries over as one vote, but someone else must still decide. Alice is on the committee too and is removed as the requester.",
  start: "2026-03-02T09:00:00.000Z",
  users: { u_alice: "Alice", u_bob: "Bob", u_eve: "Eve" },
  managers: { u_alice: "u_bob" },
  roles: { budget: ["u_alice", "u_bob", "u_eve"] },
  flow: {
    key: "purchase",
    steps: [
      { id: "manager", approvers: { type: "resolver", name: "directManager" } },
      { id: "budget", approvers: { type: "role", role: "budget" } },
    ],
  },
  actions: [
    { do: "submit", by: "u_alice", payload: { amount: 12000, item: "Team offsite" } },
    { do: "approve", by: "u_bob", wait: "PT1H" },
    { do: "approve", by: "u_bob", expectError: "NOT_ASSIGNED" },
    { do: "approve", by: "u_eve", comment: "Second pair of eyes", wait: "PT2H" },
  ],
  expectStatus: "approved",
});
