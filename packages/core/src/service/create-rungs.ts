import { decide } from "../engine/decide.js";
import { canonicalJson } from "../engine/draft.js";
import { durationToMilliseconds, parseDuration } from "../flow/duration.js";
import type {
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
  WithdrawCommand,
} from "../model/command.js";
import type { Calendar, StepResolution } from "../model/decision.js";
import {
  ConfigurationError,
  ConflictError,
  InvalidCommandError,
  RequestNotFoundError,
} from "../model/errors.js";
import type { DomainEvent } from "../model/event.js";
import type { Duration } from "../model/flow.js";
import type { RegisteredFlow, RequestState } from "../model/state.js";
import type { EventKey, OutboxEntry, RungsStore, StoreTx } from "../model/store.js";
import type { ResolutionHooks, ResolveRequest } from "../resolution/collect.js";
import { type FlowRegistry, findFlow, flowRegistry, pinnedFlow } from "./flows.js";
import { gatherResolution } from "./gather.js";
import { type Queries, queries } from "./queries.js";

export interface RungsOptions extends ResolutionHooks {
  readonly store: RungsStore;
  /** Required: the core never reads a clock. */
  readonly clock: () => Date;
  /** Required: generates request ids. */
  readonly ids: () => string;
  readonly calendar?: Calendar;
  /**
   * Called after each commit, in `seq` order, at least once. A throw never fails the command.
   * Without it, events stay in the outbox for a process that has it, e.g. a worker running
   * `dispatchPending` (EC-58).
   */
  readonly onEvent?: (event: DomainEvent) => void | Promise<void>;
  /** `"discard"` writes no outbox entries, for hosts that never consume events. Default `"outbox"`. */
  readonly events?: "outbox" | "discard";
  /** Called for each failed delivery; the event stays in the outbox and is retried later. */
  readonly onEventError?: (error: unknown, event: DomainEvent, attempts: number) => void;
  /** Backoff for failed deliveries. Default `{ baseDelay: "PT30S", maxDelay: "PT1H" }`. */
  readonly dispatchRetry?: { readonly baseDelay?: Duration; readonly maxDelay?: Duration };
}

export interface CommandOptions {
  /** Repeats with the same key return the first result (EC-16), scoped per tenant (EC-57). */
  readonly idempotencyKey?: string;
  /** Refuses the command with `ConflictError` when the request has moved on (EC-15). */
  readonly expectedVersion?: number;
}

type Input<C extends Command> = Omit<C, "type"> & CommandOptions;

export type SubmitInput = Omit<SubmitCommand, "type" | "requestId"> & {
  /** Flow key; the tenant's own flow is used first, then the global one (EC-56). */
  readonly flow: string;
  readonly idempotencyKey?: string;
};

export interface TickSummary {
  readonly processed: number;
  readonly changed: string[];
  /** Changed by another worker meanwhile (EC-27). */
  readonly skipped: string[];
  readonly failed: { requestId: string; error: unknown }[];
}

export interface DispatchSummary {
  readonly delivered: number;
  readonly failed: number;
}

export interface Rungs extends Queries {
  readonly flows: FlowRegistry;
  submit(input: SubmitInput): Promise<RequestState>;
  approve(input: Input<ApproveCommand>): Promise<RequestState>;
  reject(input: Input<RejectCommand>): Promise<RequestState>;
  return(input: Input<ReturnCommand>): Promise<RequestState>;
  resubmit(input: Input<ResubmitCommand>): Promise<RequestState>;
  withdraw(input: Input<WithdrawCommand>): Promise<RequestState>;
  delegate(input: Input<DelegateCommand>): Promise<RequestState>;
  reassign(input: Input<ReassignStepCommand> | Input<ReassignTaskCommand>): Promise<RequestState>;
  retry(input: Input<RetryStepCommand>): Promise<RequestState>;
  override(input: Input<OverrideCommand>): Promise<RequestState>;
  /** Applies what is due on every due request, each in its own transaction (EC-26, EC-27). */
  tick(options?: { limit?: number }): Promise<TickSummary>;
  /** Delivers outbox events that are due, e.g. from a scheduled job or after a crash. */
  dispatchPending(options?: { limit?: number }): Promise<DispatchSummary>;
}

interface Outcome {
  readonly state: RequestState;
  readonly changed: boolean;
}

const MAX_RESOLUTION_ROUNDS = 50;

/**
 * Wires the pure engine to a store, the host's resolvers, a clock and event hooks. Each command
 * runs in one store transaction: load, decide, resolve what the engine asks for, decide again,
 * then save the state, audit and outbox together. Events are delivered after the commit.
 */
export function createRungs(options: RungsOptions): Rungs {
  const { store, clock, ids } = options;
  if (typeof store?.transaction !== "function") {
    throw new ConfigurationError("createRungs: store must be a RungsStore");
  }
  if (typeof clock !== "function" || typeof ids !== "function") {
    throw new ConfigurationError("createRungs: clock and ids are required");
  }
  const events = options.events ?? "outbox";
  if (events !== "outbox" && events !== "discard") {
    throw new ConfigurationError('createRungs: events must be "outbox" or "discard"');
  }
  if (events === "discard" && options.onEvent !== undefined) {
    throw new ConfigurationError('createRungs: events "discard" cannot be combined with onEvent');
  }
  const hooks: ResolutionHooks = {
    ...(options.roles === undefined ? {} : { roles: options.roles }),
    ...(options.resolvers === undefined ? {} : { resolvers: options.resolvers }),
    ...(options.isActiveUser === undefined ? {} : { isActiveUser: options.isActiveUser }),
  };
  const baseDelay = delayOption(options.dispatchRetry?.baseDelay ?? "PT30S", "baseDelay");
  const maxDelay = delayOption(options.dispatchRetry?.maxDelay ?? "PT1H", "maxDelay");

  const now = (): string => {
    const date = clock();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new ConfigurationError("clock must return a valid Date");
    }
    return date.toISOString();
  };

  const nextId = (): string => {
    const id = ids();
    if (typeof id !== "string" || id.length === 0) {
      throw new ConfigurationError("ids must return a non-empty string");
    }
    return id;
  };

  async function execute(
    command: Command,
    commandOptions: CommandOptions,
    at: string,
    flowKey?: string,
  ): Promise<Outcome> {
    const outcome = await store.transaction(async (tx) => {
      let state: RequestState | null = null;
      if (command.type !== "submit") {
        state = await tx.getRequest(command.requestId, { forUpdate: true });
        if (state === null) throw new RequestNotFoundError(command.requestId);
      }
      const tenantId = command.type === "submit" ? command.tenantId : state?.tenantId;

      const key = commandOptions.idempotencyKey;
      const ref =
        key === undefined ? undefined : { key, ...(tenantId === undefined ? {} : { tenantId }) };
      const fingerprint = canonicalJson(
        command.type === "submit" ? { ...command, requestId: undefined, flow: flowKey } : command,
      );
      if (ref !== undefined) {
        const record = await tx.getIdempotent(ref);
        if (record !== null) {
          if (record.fingerprint !== fingerprint) {
            throw new InvalidCommandError(
              `The idempotency key "${ref.key}" was already used for a different command`,
            );
          }
          return { state: record.result, changed: false };
        }
      }
      if (
        state !== null &&
        commandOptions.expectedVersion !== undefined &&
        state.version !== commandOptions.expectedVersion
      ) {
        throw new ConflictError({
          requestId: state.id,
          expectedVersion: commandOptions.expectedVersion,
          actualVersion: state.version,
        });
      }

      const flow =
        state === null
          ? await findFlow(tx, flowKey as string, tenantId)
          : await pinnedFlow(tx, state);
      const decision = await decideResolved(tx, state, command, flow, at);
      if (decision.kind === "unchanged") return { state: state as RequestState, changed: false };

      await tx.saveRequest(decision.state, state === null ? null : state.version);
      await tx.appendAudit(decision.audit);
      if (events === "outbox") await tx.enqueueEvents(decision.events, at);
      if (ref !== undefined) {
        await tx.putIdempotent(ref, { fingerprint, result: decision.state, at });
      }
      return { state: decision.state, changed: true };
    });
    if (outcome.changed && options.onEvent !== undefined) {
      // Delivery problems never fail a committed command; the outbox keeps the events.
      await deliver({ requestId: outcome.state.id, limit: 1000 }, at).catch(() => undefined);
    }
    return outcome;
  }

  async function decideResolved(
    tx: StoreTx,
    state: RequestState | null,
    command: Command,
    flow: RegisteredFlow,
    at: string,
  ) {
    const resolutions: Record<string, StepResolution> = {};
    const request = resolveRequest(state, command, flow);
    for (let round = 0; round < MAX_RESOLUTION_ROUNDS; round++) {
      const decision = decide(state, command, {
        now: at,
        flow,
        resolutions,
        ...(options.calendar === undefined ? {} : { calendar: options.calendar }),
      });
      if (decision.kind !== "needs-resolution") return decision;
      for (const need of decision.needs) {
        resolutions[need.key] = await gatherResolution(need, hooks, request, tx, flow);
      }
    }
    throw new InvalidCommandError("Approver resolution did not settle");
  }

  async function deliver(
    filter: { requestId?: string; limit: number },
    at: string,
  ): Promise<DispatchSummary> {
    const onEvent = options.onEvent;
    if (onEvent === undefined) throw new ConfigurationError("dispatchPending needs onEvent");
    const entries = await store.transaction((tx) => tx.pendingEvents({ now: at, ...filter }));

    const held = new Set<string>();
    const delivered: EventKey[] = [];
    let failed = 0;
    for (const entry of entries) {
      if (held.has(entry.event.requestId)) continue;
      try {
        await onEvent(entry.event);
        delivered.push(keyOf(entry));
      } catch (error) {
        // Order is kept per request: the rest of this request waits for the failed event.
        held.add(entry.event.requestId);
        failed += 1;
        const attempts = entry.attempts + 1;
        const delay = Math.min(baseDelay * 2 ** (attempts - 1), maxDelay);
        const nextAttemptAt = new Date(Date.parse(at) + delay).toISOString();
        const message = error instanceof Error ? error.message : String(error);
        await store.transaction((tx) =>
          tx.markFailed(keyOf(entry), { attempts, nextAttemptAt, error: message }),
        );
        try {
          options.onEventError?.(error, entry.event, attempts);
        } catch {
          // A failing error hook must not break delivery of other requests.
        }
      }
    }
    if (delivered.length > 0) await store.transaction((tx) => tx.markDispatched(delivered));
    return { delivered: delivered.length, failed };
  }

  const command =
    <T extends Exclude<Command, SubmitCommand>["type"]>(type: T) =>
    async (input: object): Promise<RequestState> => {
      const { idempotencyKey, expectedVersion, ...fields } = input as CommandOptions &
        Record<string, unknown>;
      const commandOptions = {
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      };
      const outcome = await execute({ type, ...fields } as Command, commandOptions, now());
      return outcome.state;
    };

  return {
    ...queries(store, hooks, now, nextId, options.calendar),
    flows: flowRegistry(store, hooks),
    async submit(input) {
      const { flow, idempotencyKey, ...fields } = input;
      const at = now();
      const requestId = nextId();
      const outcome = await execute(
        { type: "submit", requestId, ...fields },
        idempotencyKey === undefined ? {} : { idempotencyKey },
        at,
        flow,
      );
      return outcome.state;
    },
    approve: command("approve"),
    reject: command("reject"),
    return: command("return"),
    resubmit: command("resubmit"),
    withdraw: command("withdraw"),
    delegate: command("delegate"),
    reassign: command("reassign"),
    retry: command("retry"),
    override: command("override"),
    async tick(tickOptions = {}) {
      const at = now();
      const due = await store.transaction((tx) => tx.findDue(at, tickOptions.limit ?? 100));
      const changed: string[] = [];
      const skipped: string[] = [];
      const failed: { requestId: string; error: unknown }[] = [];
      for (const requestId of due) {
        try {
          const outcome = await execute({ type: "tick", requestId }, {}, at);
          if (outcome.changed) changed.push(requestId);
        } catch (error) {
          if (error instanceof ConflictError) skipped.push(requestId);
          else failed.push({ requestId, error });
        }
      }
      return { processed: due.length, changed, skipped, failed };
    },
    dispatchPending(dispatchOptions = {}) {
      return deliver({ limit: dispatchOptions.limit ?? 100 }, now());
    },
  };
}

function resolveRequest(
  state: RequestState | null,
  command: Command,
  flow: RegisteredFlow,
): ResolveRequest {
  // Only a submit runs without a stored request.
  const source = state ?? (command as SubmitCommand);
  const { tenantId } = source;
  return {
    requesterId: source.requesterId,
    subject: source.subject,
    payload: source.payload,
    flowKey: flow.key,
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}

function keyOf(entry: OutboxEntry): EventKey {
  return { requestId: entry.event.requestId, seq: entry.event.seq };
}

function delayOption(value: Duration, name: string): number {
  const parsed = parseDuration(value);
  if (!parsed.ok) {
    throw new ConfigurationError(`createRungs: dispatchRetry.${name} ${parsed.reason}`);
  }
  return durationToMilliseconds(parsed.value);
}
