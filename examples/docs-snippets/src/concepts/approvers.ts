import { createRungs } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const store = memoryStore();

// #region hooks
const directory: Record<string, { manager?: string; roles: string[]; active: boolean }> = {
  u_ana: { manager: "u_ben", roles: [], active: true },
  u_ben: { roles: ["finance"], active: true },
  u_cat: { roles: ["finance"], active: false }, // left the company
  u_dan: { roles: ["finance"], active: true },
};

const rungs = createRungs({
  store,
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
  // A role name to the users who have it.
  roles: (role) => Object.keys(directory).filter((id) => directory[id]?.roles.includes(role)),
  // Named resolvers for anything else; `request` has the requester, subject and payload.
  resolvers: {
    directManager: ({ request }) => {
      const manager = directory[request.requesterId]?.manager;
      return manager ? [manager] : [];
    },
  },
  // Inactive users are removed when a step resolves its approvers, and the reason is recorded.
  isActiveUser: (userId) => directory[userId]?.active ?? false,
});
// #endregion hooks

await rungs.flows.register({
  key: "expense",
  steps: [
    // #region union
    {
      id: "review",
      approvers: {
        type: "union",
        of: [
          { type: "resolver", name: "directManager" },
          { type: "role", role: "finance" },
        ],
      },
    },
    // #endregion union
  ],
});

// #region preview
const preview = await rungs.preview({
  flow: "expense",
  requesterId: "u_ana",
  subject: { type: "expense", id: "EXP-7" },
  payload: { amount: 120 },
});
console.log(preview.steps[0]?.approvers); // ["u_ben", "u_dan"]: u_ben once, u_cat is inactive
console.log(preview.steps[0]?.removed); // [{ userId: "u_cat", reason: "inactive" }]

// #endregion preview

export { preview };
