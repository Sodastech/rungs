import { scenario } from "../src/scenario.js";

// All names and data are fictional.
export default scenario({
  name: "Manager on leave",
  description:
    "Bob is out of office and Dina covers for him: the manager task goes to Dina on his behalf, so Bob himself cannot approve it. In finance, Farah hands her task to Gina by hand.",
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
  delegations: [
    {
      from: "u_bob",
      to: "u_dina",
      startsAt: "2026-03-01T00:00:00.000Z",
      endsAt: "2026-03-15T00:00:00.000Z",
    },
  ],
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
    { do: "submit", by: "u_alice", payload: { amount: 2400, purpose: "New laptop" } },
    { do: "approve", by: "u_bob", expectError: "NOT_ASSIGNED" },
    { do: "approve", by: "u_dina", comment: "Covering for Bob", wait: "PT2H" },
    { do: "delegate", by: "u_farah", to: "u_gina", comment: "Travelling this week" },
    { do: "approve", by: "u_gina", wait: "PT3H" },
    { do: "approve", by: "u_dan", wait: "PT1H" },
  ],
  expectStatus: "approved",
});
