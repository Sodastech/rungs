import type { DecidedResult, EngineContext } from "../model/decision.js";
import type { AuditEvent, AuditEventBody, DomainEvent } from "../model/event.js";
import type { RequestState } from "../model/state.js";

/** Mutable working copy of a request while one command is being decided. */
export interface Draft {
  readonly state: RequestState;
  readonly ctx: EngineContext;
  readonly actorId: string | null;
  readonly audit: AuditEvent[];
}

export function startDraft(state: RequestState, actorId: string | null, ctx: EngineContext): Draft {
  return { state: clone(state), ctx, actorId, audit: [] };
}

export function record<T extends AuditEventBody["type"]>(
  draft: Draft,
  type: T,
  data: Extract<AuditEventBody, { type: T }>["data"],
): void {
  draft.state.lastAuditSeq += 1;
  draft.audit.push({
    requestId: draft.state.id,
    seq: draft.state.lastAuditSeq,
    actorId: draft.actorId,
    at: draft.ctx.now,
    type,
    data: clone(data),
  } as AuditEvent);
}

export function finish(draft: Draft): DecidedResult {
  draft.state.version += 1;
  const tenant = draft.state.tenantId === undefined ? {} : { tenantId: draft.state.tenantId };
  const events = draft.audit.map((event): DomainEvent => {
    const base = {
      requestId: event.requestId,
      ...tenant,
      seq: event.seq,
      actorId: event.actorId,
      at: event.at,
    };
    if (event.type === "task.approved" || event.type === "task.rejected") {
      const decision = event.type === "task.approved" ? "approved" : "rejected";
      return { ...base, type: "task.decided", data: { ...clone(event.data), decision } };
    }
    return { ...base, type: event.type, data: clone(event.data) } as DomainEvent;
  });
  return { kind: "decided", state: draft.state, audit: draft.audit, events };
}

/** Deep copy of plain JSON data. State and payloads are validated to be JSON. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Lists every value that is not plain JSON, naming its path and type with a hint, e.g.
 * `payload.submittedAt is a Date; send an ISO 8601 string`. Empty when `value` is a `JsonValue`.
 */
export function jsonIssues(value: unknown, path: string): string[] {
  if (value === null || typeof value === "string" || typeof value === "boolean") return [];
  if (typeof value === "number") {
    return Number.isFinite(value) ? [] : [`${path} is ${String(value)}; send a finite number`];
  }
  if (value === undefined) return [`${path} is undefined; omit the field or send null`];
  if (typeof value === "function") return [`${path} is a function; send plain JSON data`];
  if (typeof value === "bigint") return [`${path} is a bigint; send a number or a string`];
  if (typeof value !== "object") return [`${path} is a ${typeof value}; send plain JSON data`];

  if (Array.isArray(value)) return value.flatMap((item, i) => jsonIssues(item, `${path}[${i}]`));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = (value.constructor as { name?: string } | undefined)?.name || "class instance";
    if (value instanceof Date) return [`${path} is a Date; send an ISO 8601 string`];
    return [`${path} is a ${name}; send a plain object or array`];
  }
  return Object.entries(value).flatMap(([key, item]) => jsonIssues(item, childPath(path, key)));
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}
