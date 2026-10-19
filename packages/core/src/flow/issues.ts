import type { FlowIssue } from "../model/errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: FlowIssue[],
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      issues.push({ path: path ? `${path}.${key}` : key, message: "unknown key" });
    }
  }
}
