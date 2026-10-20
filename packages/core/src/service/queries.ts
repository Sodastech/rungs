import { type PreviewInput, type PreviewResult, previewRequest } from "../engine/preview.js";
import type { Calendar, StepResolution } from "../model/decision.js";
import type { DelegationRule } from "../model/delegation.js";
import { InvalidCommandError } from "../model/errors.js";
import type { AuditEvent } from "../model/event.js";
import type { RequestState } from "../model/state.js";
import type { RungsStore, TaskView } from "../model/store.js";
import type { ResolutionHooks } from "../resolution/collect.js";
import { findFlow } from "./flows.js";
import { gatherResolution } from "./gather.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface InboxEntry extends TaskView {
  /** The step's deadline has passed. */
  readonly overdue: boolean;
}

export interface InboxPage {
  readonly tasks: InboxEntry[];
  /** Pass as `after` for the next page; absent on the last page. */
  readonly next?: string;
}

export interface InboxInput {
  readonly userId: string;
  /** Omitted: only requests without a tenant. */
  readonly tenantId?: string;
  /** Default 50. */
  readonly limit?: number;
  readonly after?: string;
}

export type PreviewRequestInput = PreviewInput & { readonly flow: string };

export interface DelegationInput {
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly scope?: { readonly flowKeys?: readonly string[] };
  readonly tenantId?: string;
}

export interface Delegations {
  /** Adds an out-of-office rule. Rungs does not check who may do this; the host must. */
  set(input: DelegationInput): Promise<DelegationRule>;
  /** Rules from or to the user. */
  list(query: { userId: string; tenantId?: string }): Promise<DelegationRule[]>;
  /**
   * Ends a rule now. A rule that has not started is cancelled (`cancelledAt`) instead, so
   * `endsAt` never precedes `startsAt`. Tasks already delegated stay with the delegate (EC-24).
   */
  end(query: { id: string }): Promise<DelegationRule>;
}

export interface Queries {
  get(requestId: string): Promise<RequestState | null>;
  inbox(input: InboxInput): Promise<InboxPage>;
  history(requestId: string): Promise<AuditEvent[]>;
  preview(input: PreviewRequestInput): Promise<PreviewResult>;
  readonly delegations: Delegations;
}

export function queries(
  store: RungsStore,
  hooks: ResolutionHooks,
  now: () => string,
  ids: () => string,
  calendar: Calendar | undefined,
): Queries {
  return {
    get: (requestId) => store.transaction((tx) => tx.getRequest(requestId)),

    async inbox(input) {
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new InvalidCommandError("limit must be a positive integer");
      }
      const at = now();
      const after = input.after === undefined ? undefined : parseCursor(input.after);
      const tasks = await store.transaction((tx) =>
        tx.findInbox({
          userId: input.userId,
          ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
          limit: limit + 1,
          ...(after === undefined ? {} : { after }),
        }),
      );
      const page = tasks.slice(0, limit).map((task) => ({
        ...task,
        overdue: task.deadlineAt !== undefined && Date.parse(task.deadlineAt) <= Date.parse(at),
      }));
      const last = page.at(-1);
      return tasks.length > limit && last !== undefined
        ? { tasks: page, next: `${last.assignedAt}~${last.taskId}` }
        : { tasks: page };
    },

    history: (requestId) => store.transaction((tx) => tx.getAudit(requestId)),

    async preview(input) {
      const { flow: flowKey, ...request } = input;
      const at = now();
      return store.transaction(async (tx) => {
        const flow = await findFlow(tx, flowKey, request.tenantId);
        const resolutions: Record<string, StepResolution> = {};
        const resolveRequest = {
          requesterId: request.requesterId,
          subject: request.subject ?? { type: "preview", id: "preview" },
          payload: request.payload,
          flowKey: flow.key,
          ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
        };
        for (;;) {
          const decision = previewRequest(request, {
            now: at,
            flow,
            resolutions,
            ...(calendar === undefined ? {} : { calendar }),
          });
          if (decision.kind === "preview") return decision.result;
          for (const need of decision.needs) {
            resolutions[need.key] = await gatherResolution(need, hooks, resolveRequest, tx, flow);
          }
        }
      });
    },

    delegations: {
      async set(input) {
        const problems = delegationProblems(input);
        if (problems.length > 0) {
          throw new InvalidCommandError(`Invalid delegation rule: ${problems.join("; ")}`);
        }
        const rule: DelegationRule = {
          id: ids(),
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          startsAt: normalize(input.startsAt),
          endsAt: normalize(input.endsAt),
          ...(input.scope === undefined
            ? {}
            : { scope: input.scope.flowKeys ? { flowKeys: [...input.scope.flowKeys] } : {} }),
          ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
        };
        await store.transaction((tx) => tx.saveDelegation(rule));
        return rule;
      },
      list: (query) => store.transaction((tx) => tx.listDelegations(query)),
      async end({ id }) {
        const at = now();
        return store.transaction(async (tx) => {
          const rule = await tx.getDelegation(id);
          if (rule === null)
            throw new InvalidCommandError(`Delegation rule "${id}" does not exist`);
          let ended = rule;
          if (rule.cancelledAt !== undefined) return rule;
          if (Date.parse(at) < Date.parse(rule.startsAt)) ended = { ...rule, cancelledAt: at };
          else if (Date.parse(at) < Date.parse(rule.endsAt)) ended = { ...rule, endsAt: at };
          if (ended !== rule) await tx.saveDelegation(ended);
          return ended;
        });
      },
    },
  };
}

function delegationProblems(input: DelegationInput): string[] {
  const problems: string[] = [];
  for (const key of ["fromUserId", "toUserId"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      problems.push(`${key} must be a non-empty string`);
    }
  }
  if (input.fromUserId === input.toUserId) problems.push("a user cannot delegate to themselves");
  for (const key of ["startsAt", "endsAt"] as const) {
    if (typeof input[key] !== "string" || !ISO_UTC.test(input[key])) {
      problems.push(`${key} must be an ISO 8601 UTC timestamp`);
    }
  }
  if (problems.length === 0 && Date.parse(input.startsAt) >= Date.parse(input.endsAt)) {
    problems.push("startsAt must be before endsAt");
  }
  const flowKeys = input.scope?.flowKeys;
  if (
    flowKeys !== undefined &&
    (!Array.isArray(flowKeys) || flowKeys.some((k) => typeof k !== "string"))
  ) {
    problems.push("scope.flowKeys must be an array of flow keys");
  }
  if (
    input.tenantId !== undefined &&
    (typeof input.tenantId !== "string" || input.tenantId === "")
  ) {
    problems.push("tenantId must be a non-empty string");
  }
  return problems;
}

function normalize(iso: string): string {
  return new Date(Date.parse(iso)).toISOString();
}

function parseCursor(cursor: string): { assignedAt: string; taskId: string } {
  const at = cursor.indexOf("~");
  if (at <= 0) throw new InvalidCommandError("after is not a cursor returned by inbox");
  return { assignedAt: cursor.slice(0, at), taskId: cursor.slice(at + 1) };
}
