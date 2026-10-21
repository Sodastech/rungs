import { jsonIssues } from "../engine/draft.js";
import { type PreviewInput, type PreviewResult, previewRequest } from "../engine/preview.js";
import type { Calendar, StepResolution } from "../model/decision.js";
import type { DelegationRule } from "../model/delegation.js";
import { InvalidCommandError } from "../model/errors.js";
import type { AuditEvent } from "../model/event.js";
import type { RequestState, RequestStatus } from "../model/state.js";
import type {
  BlockedStepView,
  RequestQuery,
  RequestSummary,
  RungsStore,
  TaskView,
} from "../model/store.js";
import type { ResolutionHooks } from "../resolution/collect.js";
import { findFlow } from "./flows.js";
import { gatherResolution } from "./gather.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface InboxEntry extends TaskView {
  /** The step's deadline has passed. */
  readonly overdue: boolean;
}

export interface InboxPage {
  readonly tasks: readonly InboxEntry[];
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

export interface RequestsInput {
  /** Omitted: only requests without a tenant. */
  readonly tenantId?: string;
  readonly requesterId?: string;
  /** One status or any of several; omitted: every status. */
  readonly status?: RequestStatus | readonly RequestStatus[];
  /** Requests about one host record (`type` and `id`), or one kind of record (`type` only). */
  readonly subject?: { readonly type: string; readonly id?: string };
  readonly flowKey?: string;
  /** Default 50, at most 200. */
  readonly limit?: number;
  readonly after?: string;
}

export interface RequestsPage {
  /** Newest first. */
  readonly requests: readonly RequestSummary[];
  /** Pass as `after` for the next page; absent on the last page. */
  readonly next?: string;
}

export interface BlockedInput {
  /** Omitted: only requests without a tenant. */
  readonly tenantId?: string;
  /** Default 50, at most 200. */
  readonly limit?: number;
  readonly after?: string;
}

export interface BlockedPage {
  /** Blocked longest first. */
  readonly steps: readonly BlockedStepView[];
  /** Pass as `after` for the next page; absent on the last page. */
  readonly next?: string;
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
  list(query: {
    readonly userId: string;
    readonly tenantId?: string;
  }): Promise<readonly DelegationRule[]>;
  /**
   * Ends a rule now. A rule that has not started is cancelled (`cancelledAt`) instead, so
   * `endsAt` never precedes `startsAt`. Tasks already delegated stay with the delegate (EC-24).
   */
  end(query: { readonly id: string }): Promise<DelegationRule>;
}

export interface Queries {
  get(requestId: string): Promise<RequestState | null>;
  inbox(input: InboxInput): Promise<InboxPage>;
  /** Requests matching every filter, newest first. Rungs does not check who may see them. */
  requests(input?: RequestsInput): Promise<RequestsPage>;
  /** Blocked steps waiting for an admin (EC-42), blocked longest first. */
  blocked(input?: BlockedInput): Promise<BlockedPage>;
  history(requestId: string): Promise<readonly AuditEvent[]>;
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
        // EC-60: a task a delegate holds for this user is theirs to decide too.
        ...(task.assigneeId === input.userId ? {} : { heldBy: task.assigneeId }),
        overdue: task.deadlineAt !== undefined && Date.parse(task.deadlineAt) <= Date.parse(at),
      }));
      const last = page.at(-1);
      return tasks.length > limit && last !== undefined
        ? { tasks: page, next: `${last.assignedAt}~${last.taskId}` }
        : { tasks: page };
    },

    async requests(input = {}) {
      const limit = listLimit(input.limit);
      const query: RequestQuery = {
        ...requestFilters(input),
        limit: limit + 1,
        ...(input.after === undefined
          ? {}
          : { after: cursor(input.after, "requests", (submittedAt, id) => ({ submittedAt, id })) }),
      };
      const found = await store.transaction((tx) => tx.findRequests(query));
      const page = found.slice(0, limit);
      const last = page.at(-1);
      return found.length > limit && last !== undefined
        ? { requests: page, next: `${last.submittedAt}~${last.id}` }
        : { requests: page };
    },

    async blocked(input = {}) {
      const limit = listLimit(input.limit);
      if (input.tenantId !== undefined) nonEmpty(input.tenantId, "tenantId");
      const after =
        input.after === undefined
          ? undefined
          : cursor(input.after, "blocked", (blockedAt, requestId) => ({ blockedAt, requestId }));
      const found = await store.transaction((tx) =>
        tx.findBlocked({
          ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
          limit: limit + 1,
          ...(after === undefined ? {} : { after }),
        }),
      );
      const page = found.slice(0, limit);
      const last = page.at(-1);
      return found.length > limit && last !== undefined
        ? { steps: page, next: `${last.blockedAt}~${last.requestId}` }
        : { steps: page };
    },

    history: (requestId) => store.transaction((tx) => tx.getAudit(requestId)),

    async preview(input) {
      const { flow: flowKey, ...request } = input;
      const problems = previewProblems(input);
      if (problems.length > 0) {
        throw new InvalidCommandError(`Invalid preview: ${problems.join("; ")}`);
      }
      const at = now();
      return store.transaction(async (tx) => {
        const flow = await findFlow(tx, flowKey, request.tenantId);
        const resolutions: Record<string, StepResolution> = {};
        const resolveRequest = {
          requesterId: request.requesterId,
          subject: { type: request.subject.type, id: request.subject.id },
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

/** Same rules as a submit: a resolver that looks data up by subject must never get a stand-in. */
function previewProblems(input: PreviewRequestInput): string[] {
  const problems: string[] = [];
  const text = (value: unknown, name: string) => {
    if (typeof value !== "string" || value.length === 0) {
      problems.push(`${name} must be a non-empty string`);
    }
  };
  text(input.flow, "flow");
  text(input.requesterId, "requesterId");
  text(input.subject?.type, "subject.type");
  text(input.subject?.id, "subject.id");
  if (input.tenantId !== undefined) text(input.tenantId, "tenantId");
  problems.push(...jsonIssues(input.payload, "payload"));
  return problems;
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

const STATUSES: readonly RequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "returned",
  "withdrawn",
];

function listLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new InvalidCommandError("limit must be an integer from 1 to 200");
  }
  return value;
}

function nonEmpty(value: unknown, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidCommandError(`${name} must be a non-empty string`);
  }
}

/** Validates the filters of `rungs.requests` and turns them into a store query. */
function requestFilters(input: RequestsInput): Omit<RequestQuery, "limit" | "after"> {
  if (input.tenantId !== undefined) nonEmpty(input.tenantId, "tenantId");
  if (input.requesterId !== undefined) nonEmpty(input.requesterId, "requesterId");
  if (input.flowKey !== undefined) nonEmpty(input.flowKey, "flowKey");
  let statuses: RequestStatus[] | undefined;
  if (input.status !== undefined) {
    statuses = typeof input.status === "string" ? [input.status] : [...input.status];
    const unknown = statuses.filter((s) => !STATUSES.includes(s));
    if (statuses.length === 0 || unknown.length > 0) {
      throw new InvalidCommandError(`status must be one or more of: ${STATUSES.join(", ")}`);
    }
  }
  if (input.subject !== undefined) {
    nonEmpty(input.subject?.type, "subject.type");
    if (input.subject.id !== undefined) nonEmpty(input.subject.id, "subject.id");
  }
  return {
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.requesterId === undefined ? {} : { requesterId: input.requesterId }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(input.subject === undefined
      ? {}
      : {
          subject: {
            type: input.subject.type,
            ...(input.subject.id === undefined ? {} : { id: input.subject.id }),
          },
        }),
    ...(input.flowKey === undefined ? {} : { flowKey: input.flowKey }),
  };
}

/** Cursors are `<ISO timestamp>~<id>`, as the previous page's `next` returned them. */
function cursor<T>(value: string, query: string, make: (at: string, id: string) => T): T {
  const at = typeof value === "string" ? value.indexOf("~") : -1;
  const time = at > 0 ? value.slice(0, at) : "";
  if (!ISO_UTC.test(time) || at === value.length - 1) {
    throw new InvalidCommandError(`after is not a cursor returned by ${query}`);
  }
  return make(time, value.slice(at + 1));
}

function parseCursor(cursor: string): { assignedAt: string; taskId: string } {
  const at = cursor.indexOf("~");
  if (at <= 0) throw new InvalidCommandError("after is not a cursor returned by inbox");
  return { assignedAt: cursor.slice(0, at), taskId: cursor.slice(at + 1) };
}
