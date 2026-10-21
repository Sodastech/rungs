import { createRungs, defineFlow } from "@rungsjs/core";
import { postgresStore } from "@rungsjs/store-postgres";
import { revalidatePath } from "next/cache";
import { db } from "../rungs/db";

export const dynamic = "force-dynamic";

async function rungs() {
  const r = createRungs({
    store: postgresStore(await db()),
    clock: () => new Date(),
    ids: () => crypto.randomUUID(),
    events: "discard",
  });
  await r.flows.register(
    defineFlow({
      key: "spike",
      steps: [{ id: "a", approvers: { type: "users", ids: ["u_mgr"] } }],
    }),
  );
  return r;
}

async function submit() {
  "use server";
  await (await rungs()).submit({
    flow: "spike",
    requesterId: "u_req",
    subject: { type: "expense", id: crypto.randomUUID() },
    payload: { amount: 10 },
  });
  revalidatePath("/");
}

export default async function Page() {
  const inbox = await (await rungs()).inbox({ userId: "u_mgr", limit: 100 });
  return (
    <main>
      <p>Inbox: {inbox.tasks.length}</p>
      <form action={submit}>
        <button type="submit">submit</button>
      </form>
    </main>
  );
}
