import {
  ConflictError,
  InvalidCommandError,
  InvalidTransitionError,
  NoApproversError,
  NotAssignedError,
  RequestNotFoundError,
  RungsError,
} from "@rungsjs/core";
import { stepName } from "./flow";

/**
 * Turns a Rungs error into a sentence for the person who clicked. Branch on the class (or its
 * stable `code`), never on the message text. Anything else is a bug and is rethrown.
 */
export function describeError(error: unknown): string {
  if (error instanceof ConflictError) {
    return "Someone else acted on this request a moment ago. The page now shows the latest state.";
  }
  if (error instanceof NotAssignedError) {
    return "You have no pending task on this request any more.";
  }
  if (error instanceof InvalidTransitionError) {
    return `This request is ${error.status}, so that action is not possible now.`;
  }
  if (error instanceof NoApproversError) {
    const removed = error.removed.length > 0 ? " Everyone who could approve it is inactive." : "";
    return `Nobody can approve the ${stepName(error.stepId)} step for this expense.${removed}`;
  }
  if (error instanceof RequestNotFoundError) return "This request does not exist.";
  if (error instanceof InvalidCommandError) return error.message;
  if (error instanceof RungsError) return error.message;
  throw error;
}
