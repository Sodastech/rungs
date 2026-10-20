import { scenario } from "../src/scenario.js";

// All names and data are fictional.
export default scenario({
  name: "Resubmit with a changed amount",
  description:
    "Finance returns a 5000 claim. Alice resubmits 800 instead. Although the flow resumes at the returning step by default, a changed payload restarts from the first step, and finance is now skipped.",
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
    returnPolicy: "from-returned-step",
    steps: [
      { id: "manager", approvers: { type: "resolver", name: "directManager" } },
      {
        id: "finance",
        approvers: { type: "role", role: "finance" },
        when: { field: "amount", op: "gt", value: 1000 },
      },
      { id: "director", approvers: { type: "role", role: "director" } },
    ],
  },
  actions: [
    { do: "submit", by: "u_alice", payload: { amount: 5000, purpose: "Client dinner" } },
    { do: "approve", by: "u_bob", wait: "PT1H" },
    { do: "return", by: "u_felix", comment: "Please claim only your own share", wait: "PT1H" },
    { do: "resubmit", payload: { amount: 800, purpose: "Client dinner, own share" }, wait: "P1D" },
    { do: "approve", by: "u_bob", wait: "PT1H" },
    { do: "approve", by: "u_dan", wait: "PT1H" },
  ],
  expectStatus: "approved",
});
