import { createRungs, type DomainEvent } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";

const store = memoryStore();
const outbox: { to: string; subject: string; key: string }[] = [];
const sentKeys = new Set<string>();
const users: Record<string, string> = { u_mgr: "maria@example.com", u_req: "tom@example.com" };
const mailer = {
  send: async (mail: { to: string; subject: string; key: string }) => {
    if (sentKeys.has(mail.key)) return; // the provider dedupes by key, as most do
    sentKeys.add(mail.key);
    outbox.push(mail);
  },
};

// #region handler
async function notify(event: DomainEvent): Promise<void> {
  // The same event can arrive twice; requestId and seq identify it.
  const key = `${event.requestId}:${event.seq}`;
  switch (event.type) {
    case "task.assigned":
      await mailer.send({ key, to: users[event.data.assigneeId] ?? "", subject: "To approve" });
      break;
    case "task.reminder":
      await mailer.send({ key, to: users[event.data.assigneeId] ?? "", subject: "Reminder" });
      break;
    case "request.approved":
    case "request.rejected": {
      const request = await worker.get(event.requestId);
      const to = users[request?.requesterId ?? ""] ?? "";
      await mailer.send({ key, to, subject: `Your request was ${event.type.split(".")[1]}` });
      break;
    }
  }
}
// #endregion handler

// #region processes
const options = { store, clock: () => new Date(), ids: () => crypto.randomUUID() };

// In the web process: no onEvent. Events wait in the outbox, in the same transaction.
const web = createRungs(options);

// In a worker process: delivers them, retrying failures with backoff.
const worker = createRungs({ ...options, onEvent: notify });
await worker.dispatchPending();
// #endregion processes

await web.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});
const request = await web.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 10 },
});
const beforeWorker = outbox.length;
await worker.dispatchPending();
await web.approve({ requestId: request.id, actorId: "u_mgr" });
const delivered = await worker.dispatchPending();

export { beforeWorker, delivered, notify, outbox };
