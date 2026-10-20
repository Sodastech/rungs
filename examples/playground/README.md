# Playground

Try the engine by hand. A scenario is a small `.ts` file with a fictional organization, a flow and a
list of actions; the playground plays it against `createRungs` with `memoryStore` and prints a
timeline: every action, the active step, who approves and why (including people removed or
delegated), the request status, and any error.

```bash
pnpm playground scenarios/01-expense-three-steps.ts   # from the repository root
pnpm playground --all                                 # every scenario
```

The example scenarios run in CI (`test/scenarios.test.ts`), so they keep working.

| Scenario | Shows |
| --- | --- |
| `01-expense-three-steps.ts` | Preview, a three-step expense, a reminder before the finance deadline |
| `02-manager-on-leave.ts` | Out-of-office delegation, the owner deciding a delegated task directly, a manual hand-over |
| `03-four-eyes.ts` | The same person on two steps: one carried vote, someone else must decide |
| `04-resubmit-amount-changed.ts` | Return, then resubmit with a new amount: restart and a skipped step |

## Writing a scenario

Copy an example and change it. The `scenario()` helper gives type checking and autocompletion.

```ts
import { scenario } from "../src/scenario.js";

export default scenario({
  name: "My case",
  start: "2026-03-02T09:00:00.000Z",
  users: { u_alice: "Alice", u_bob: "Bob" },          // id → display name
  managers: { u_alice: "u_bob" },                      // for the directManager resolver
  roles: { finance: ["u_bob"] },                       // for { type: "role" } approvers
  inactive: [],                                        // users who left
  delegations: [],                                     // { from, to, startsAt, endsAt }
  flow: { key: "expense", steps: [/* any flow, see docs/04-api-design.md */] },
  actions: [
    { do: "submit", by: "u_alice", payload: { amount: 500 } },
    { do: "approve", by: "u_bob", wait: "PT2H" },
  ],
  expectStatus: "approved",                            // optional: fail if it ends differently
});
```

Actions: `preview`, `inbox`, `submit`, `approve`, `reject`, `delegate` (`to`), `return` (`to` an earlier step,
default the requester), `resubmit` (optional new `payload`), `withdraw` and `tick`. Each action can
set `at` (an ISO time) or `wait` (`"PT2H"`, `"P1D"`, `"P1DT30M"`); otherwise the clock moves one
minute. Add `expectError: "NOT_ASSIGNED"` to an action that should be refused. An unexpected error,
an unmet `expectError` or a different final status make the run exit with code 1.

All names and data in the examples are fictional.
