import {
  type ApproveInput,
  ConflictError,
  createRungs,
  InvalidCommandError,
  InvalidTransitionError,
  NotAssignedError,
  RequestNotFoundError,
  RungsError,
} from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";
import express, { type NextFunction, type Request, type Response } from "express";

const rungs = createRungs({
  store: memoryStore(),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
});
await rungs.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});

// Stands in for your authentication: in a real app, a session or a verified token.
const userId = (req: Request): string => String(req.header("x-user") ?? "");

// #region input
// Each command method has a named input type (`ApproveInput`, `RejectInput`, ...), so the code
// that turns an HTTP request into a command can be typed and tested on its own.
function approveInput(req: Request): ApproveInput {
  return {
    requestId: String(req.params.id),
    actorId: userId(req),
    expectedVersion: req.body.version, // the version the approver was looking at
    comment: req.body.comment,
  };
}
// #endregion input

// #region routes
const app = express();
app.use(express.json());

app.post("/expenses/:id/submit", async (req, res, next) => {
  try {
    const request = await rungs.submit({
      flow: "expense",
      requesterId: userId(req), // the actor comes from the session, never from the body
      subject: { type: "expense", id: req.params.id },
      payload: { amount: Number(req.body.amount) },
      idempotencyKey: req.header("idempotency-key"), // a retried POST submits once
    });
    res.status(201).json(request);
  } catch (error) {
    next(error);
  }
});

app.post("/requests/:id/approve", async (req, res, next) => {
  try {
    res.json(await rungs.approve(approveInput(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/inbox", async (req, res, next) => {
  try {
    res.json(await rungs.inbox({ userId: userId(req), after: req.query.after as string }));
  } catch (error) {
    next(error);
  }
});
// #endregion routes

// #region errors
// Map Rungs errors to HTTP by class (or by their stable `code`), never by message text.
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!(error instanceof RungsError)) return next(error);
  const status =
    error instanceof RequestNotFoundError
      ? 404
      : error instanceof NotAssignedError
        ? 403
        : error instanceof ConflictError || error instanceof InvalidTransitionError
          ? 409
          : error instanceof InvalidCommandError
            ? 400
            : 422;
  res.status(status).json({ code: error.code, message: error.message });
});

// #endregion errors

export { app };
