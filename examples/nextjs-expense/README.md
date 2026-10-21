# Expense approvals with Rungs and Next.js

A small Next.js app that sends expenses through an approval chain with
[Rungs](../../README.md). Use it to try Rungs by hand, or read it as an example of how an app
uses Rungs.

![The approval chain and audit timeline of an expense](../../assets/screenshots/request.png)

## Run it

From the repository root, with Node.js 22+ and pnpm:

```bash
pnpm install
pnpm demo
```

Open <http://localhost:3000>. You do not need to install a database: the demo uses
[PGlite](https://pglite.dev), PostgreSQL compiled to WebAssembly, and keeps its data in
`examples/nextjs-expense/.data/`. To use your own PostgreSQL server instead, set `DATABASE_URL`
(for example `DATABASE_URL=postgres://user:pass@localhost:5432/demo pnpm demo`). Everything is
stored in a schema named `rungs_demo`, and **Reset demo** drops only that schema.

## A short tour

You can sign in as any of six fictional people, with no password. Use **Switch person** to see
the same expense from each side.

| Person | Role |
| --- | --- |
| Alice Moreau | Software engineer. Submits expenses; reports to Marco |
| Marco Rossi | Engineering manager. First approver for Alice; reports to Diego |
| Fatima Khan, Kenji Sato | Finance. Either one checks expenses above $500 |
| Diego Alvarez | Director. Signs off above $5,000; overdue manager tasks escalate to him |
| Ada Okafor | Administrator. Unblocks steps, overrides decisions, marks people inactive |

1. **Submit.** As Alice, choose **New expense** and enter $1,890. The preview shows who will
   approve it before anything is stored. Submit it.
2. **Approve.** As Marco, open the expense from the **Inbox** and approve it. It moves to finance,
   where Fatima or Kenji can decide it. The **Timeline** records each step.
3. **Return.** As Fatima, choose **Return for changes**. As Alice, change the amount and resubmit;
   the approval starts again from the manager step.
4. **Deadlines.** Use **+1 day** and **+3 days** in the bar under the header. Rungs sends a
   reminder before a manager's deadline, then escalates to Diego. Watch **Notifications**.
5. **Blocked step.** As Ada, deactivate Fatima and Kenji. As Marco, approve "Laptop docking
   station" ($780). Nobody can approve the finance step, so it is blocked. As Ada, give the step to
   someone on the **Admin** page, or reactivate a finance officer and **Retry step**.
6. **Out of office.** As Marco, plan time away with Diego covering. New tasks for Marco now go to
   Diego, and Marco can still decide them himself.

## How it is built

Everything the app does with Rungs is in [`rungs/`](rungs). Read that folder first:

| File | What it shows |
| --- | --- |
| [`rungs/demo.ts`](rungs/demo.ts) | `createRungs` with the PostgreSQL store, the injected clock and ids, and `onEvent`; one instance per process |
| [`rungs/flow.ts`](rungs/flow.ts) | The flow: manager, then finance above $500, then the director above $5,000 |
| [`rungs/directory.ts`](rungs/directory.ts) | Roles, a `reportsTo` resolver and `isActiveUser`, from a fixed list of people |
| [`rungs/expenses.ts`](rungs/expenses.ts) | The app's own expense records. Rungs keeps the approval; the app keeps its data |
| [`rungs/notifications.ts`](rungs/notifications.ts) | Turns events into messages; repeated deliveries are harmless |
| [`rungs/clock.ts`](rungs/clock.ts) | The demo clock. "Advance time" moves it forward and runs `tick` |
| [`rungs/errors.ts`](rungs/errors.ts) | Turns `RungsError` classes into messages for people |

The pages in [`app/`](app) are ordinary Next.js App Router pages. Each Server Action in
[`app/actions.ts`](app/actions.ts) runs one Rungs command. A few patterns are worth copying:

- **The actor comes from the session**, never from a form field. Rungs does not check
  permissions such as "is this person an admin"; the app does.
- **Every form sends the version it was rendered with** (`expectedVersion`). If someone else acted
  first, the app shows a conflict message instead of overwriting their decision.
- **Submitting is idempotent.** The form carries a fresh expense id that is also the idempotency
  key, so a double click submits once.
- **`tick` runs on a schedule in a real app.** Here it runs when you move the demo clock.

This example does not show real authentication, email delivery or organization charts.
`reportsTo` reads a fixed table; resolvers that handle vacant positions and acting holders are
planned.

## Tests

`pnpm --filter @rungsjs/example-nextjs-expense test` runs the `rungs/` folder against an
in-memory PGlite database: routing by amount, idempotent submits, reminders and escalation,
blocked steps and conflicts.

To refresh the screenshots in `assets/screenshots/`, reset the demo, start it with `pnpm build &&
pnpm start` in this folder, and run `node scripts/screenshots.mjs` (it uses a local Chrome or
Edge).
