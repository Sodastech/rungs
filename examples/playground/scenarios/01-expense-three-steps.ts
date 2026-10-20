import { scenario } from "../src/scenario.js";

// All names and data are fictional.
export default scenario({
  name: "Expense: three steps",
  description:
    "Alice claims 5000. Her manager approves, finance gets a reminder before its two-day deadline, then finance and the director approve.",
  start: "2026-03-02T09:00:00.000Z",
  users: {
    u_alice: "Alice",
    u_bob: "Bob",
    u_carla: "Carla",
    u_dan: "Dan",
    u_dina: "Dina",
    u_eve: "Eve",
    u_farah: "Farah",
    u_felix: "Felix",
    u_gina: "Gina",
  },
  managers: { u_alice: "u_bob", u_bob: "u_carla" },
  roles: { finance: ["u_farah", "u_felix"], director: ["u_dan"] },
  flow: {
    key: "expense",
    steps: [
      { id: "manager", approvers: { type: "resolver", name: "directManager" } },
      {
        id: "finance",
        approvers: { type: "role", role: "finance" },
        when: { field: "amount", op: "gt", value: 1000 },
        deadline: "P2D",
        remindBefore: "PT4H",
      },
      { id: "director", approvers: { type: "role", role: "director" } },
    ],
  },
  actions: [
    { do: "preview", by: "u_alice", payload: { amount: 5000 } },
    { do: "submit", by: "u_alice", payload: { amount: 5000, purpose: "Conference travel" } },
    { do: "approve", by: "u_bob", comment: "Approved, within budget", wait: "PT1H" },
    { do: "tick", at: "2026-03-04T06:30:00.000Z" },
    { do: "approve", by: "u_felix", wait: "PT30M" },
    { do: "approve", by: "u_dan", wait: "PT2H" },
  ],
  expectStatus: "approved",
});
