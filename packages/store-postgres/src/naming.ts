import { ConfigurationError } from "@rungsjs/core";

/** Where the tables live. Defaults: schema `public`, table prefix `rungs_`. */
export interface NamingOptions {
  readonly schema?: string;
  readonly tablePrefix?: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const TABLES = [
  "requests",
  "inbox",
  "audit",
  "outbox",
  "flows",
  "idempotency",
  "delegations",
  "schema_migrations",
] as const;

export type TableName = (typeof TABLES)[number];

export interface Names {
  readonly schema: string;
  readonly prefix: string;
  /** Quoted, schema-qualified table name, e.g. `"public"."rungs_requests"`. */
  readonly table: Record<TableName, string>;
  /** Unquoted name for indexes, triggers and functions in the same schema. */
  readonly local: (suffix: string) => string;
  readonly quotedLocal: (suffix: string) => string;
  /** Key for the migration advisory lock, unique per schema and prefix. */
  readonly lockKey: string;
}

export function names(options: NamingOptions = {}): Names {
  const schema = options.schema ?? "public";
  const prefix = options.tablePrefix ?? "rungs_";
  if (!IDENTIFIER.test(schema) || schema.length > 40) {
    throw new ConfigurationError(
      `schema must be lower-case letters, digits and _ (at most 40), got "${schema}"`,
    );
  }
  if (!(prefix === "" || IDENTIFIER.test(prefix)) || prefix.length > 20) {
    throw new ConfigurationError(
      `tablePrefix must be lower-case letters, digits and _ (at most 20), got "${prefix}"`,
    );
  }
  const quote = (identifier: string) => `"${identifier}"`;
  const table = Object.fromEntries(
    TABLES.map((name) => [name, `${quote(schema)}.${quote(prefix + name)}`]),
  ) as Record<TableName, string>;
  return {
    schema,
    prefix,
    table,
    local: (suffix) => prefix + suffix,
    quotedLocal: (suffix) => `${quote(schema)}.${quote(prefix + suffix)}`,
    lockKey: `rungs:${schema}:${prefix}`,
  };
}

/** Stored in place of a missing `tenantId`, so tenant matching can use plain indexes. */
export const NO_TENANT = "";

export function tenant(tenantId: string | undefined): string {
  return tenantId ?? NO_TENANT;
}

/** timestamptz values come back as Date (or a string for some drivers); hand out ISO strings. */
export function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}
