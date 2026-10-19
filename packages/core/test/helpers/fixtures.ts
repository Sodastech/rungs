import type { FlowInput, StepInput } from "../../src/index.js";

export function step(overrides: Partial<StepInput> = {}): StepInput {
  return { id: "manager", approvers: { type: "users", ids: ["u_manager"] }, ...overrides };
}

export function flowInput(overrides: Partial<FlowInput> = {}): FlowInput {
  return { key: "expense", steps: [step()], ...overrides };
}
