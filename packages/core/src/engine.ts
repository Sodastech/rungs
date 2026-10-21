/**
 * The pure engine: `decide(state, command, context)` returns the next state and its events,
 * with no store, clock or I/O. `createRungs` uses it; call it directly only to build your own
 * service around it.
 *
 * @packageDocumentation
 * @module @rungsjs/core/engine
 */

// Public entry point: everything exported here is public API (see docs/04-api-design.md).

export { decide } from "./engine/decide.js";
export type { PreviewInput } from "./engine/preview.js";
export type {
  ApproveCommand,
  Command,
  DelegateCommand,
  OverrideCommand,
  ReassignStepCommand,
  ReassignTaskCommand,
  RejectCommand,
  ResubmitCommand,
  RetryStepCommand,
  ReturnCommand,
  SubmitCommand,
  TickCommand,
  WithdrawCommand,
} from "./model/command.js";
export type {
  Calendar,
  DecidedResult,
  Decision,
  EngineContext,
  NeedsResolution,
  ResolutionNeed,
  StepResolution,
  Unchanged,
} from "./model/decision.js";
