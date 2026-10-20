import { createRungs, type RequestState, RungsError } from "@rungsjs/core";
import { memoryStore } from "@rungsjs/store-memory";
import { describe, previewLines, standing, style, time } from "./format.js";
import type { Action, Scenario } from "./scenario.js";

export interface RunResult {
  /** False when an action failed unexpectedly or the final status differs from `expectStatus`. */
  readonly ok: boolean;
  readonly problems: string[];
  readonly status: RequestState["status"] | "not submitted";
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

function wait(duration: string): number {
  const m = DURATION.exec(duration);
  if (!m || duration === "P" || duration.endsWith("T")) {
    throw new Error(`wait must look like "PT2H", "P1D" or "P1DT30M", got "${duration}"`);
  }
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60_000;
}

/** Plays a scenario against `createRungs` with `memoryStore` and writes a timeline. */
export async function runScenario(
  scenario: Scenario,
  write: (line: string) => void,
  options: { color?: boolean } = {},
): Promise<RunResult> {
  const s = style(options.color ?? false);
  const name = (id: string) =>
    scenario.users[id] ? `${scenario.users[id]} (${id})` : `${id} ${s.warn("[not in users]")}`;
  const problems: string[] = [];
  let clock = Date.parse(scenario.start);
  if (Number.isNaN(clock)) throw new Error(`start is not an ISO 8601 time: "${scenario.start}"`);
  let next = 0;

  const rungs = createRungs({
    store: memoryStore(),
    clock: () => new Date(clock),
    ids: () => `r${++next}`,
    events: "discard",
    roles: async (role) => [...(scenario.roles?.[role] ?? [])],
    resolvers: {
      directManager: async ({ request }) => {
        const manager = scenario.managers?.[request.requesterId];
        return manager ? [manager] : [];
      },
    },
    isActiveUser: async (userId) => !(scenario.inactive ?? []).includes(userId),
  });

  write(s.bold(`━━ ${scenario.name} ━━`));
  if (scenario.description) write(s.dim(scenario.description));
  const { version } = await rungs.flows.register(scenario.flow);
  write(
    s.dim(
      `flow ${scenario.flow.key} v${version} · steps: ${scenario.flow.steps.map((st) => st.id).join(" → ")}`,
    ),
  );
  for (const rule of scenario.delegations ?? []) {
    await rungs.delegations.set({
      fromUserId: rule.from,
      toUserId: rule.to,
      startsAt: rule.startsAt,
      endsAt: rule.endsAt,
      ...(rule.flowKeys ? { scope: { flowKeys: rule.flowKeys } } : {}),
    });
    write(
      s.dim(
        `out-of-office: ${name(rule.from)} → ${name(rule.to)}, ${time(rule.startsAt)} to ${time(rule.endsAt)}`,
      ),
    );
  }

  let requestId: string | undefined;
  let seen = 0;
  for (const [index, action] of scenario.actions.entries()) {
    if (action.at) clock = Date.parse(action.at);
    else if (action.wait) clock += wait(action.wait);
    else if (index > 0) clock += 60_000;
    const at = new Date(clock).toISOString();
    write("");
    write(`${s.info(`[${time(at)}]`)} ${s.bold(label(action, name))}`);

    try {
      requestId = await perform(action, requestId);
      if (action.expectError) {
        problems.push(
          `action ${index + 1} (${action.do}) was expected to fail with ${action.expectError}`,
        );
        write(`  ${s.bad(`✗ expected ${action.expectError}, but it succeeded`)}`);
      }
    } catch (error) {
      if (!(error instanceof RungsError)) throw error;
      const expected = action.expectError === error.code;
      write(
        `  ${expected ? s.warn("✗ refused (expected)") : s.bad("✗ refused")} ${error.code}: ${error.message}`,
      );
      if (!expected)
        problems.push(`action ${index + 1} (${action.do}) failed: ${error.code}: ${error.message}`);
    }

    if (requestId !== undefined && action.do !== "preview") {
      const history = await rungs.history(requestId);
      const owners = new Map<string, string>();
      for (const event of history) {
        if (event.type === "task.assigned" || event.type === "task.deduplicated") {
          owners.set(event.data.taskId, event.data.assigneeId);
        }
      }
      const taskOwner = (taskId: string) => {
        const owner = owners.get(taskId);
        return owner ? name(owner) : taskId;
      };
      for (const event of history.slice(seen)) {
        for (const line of describe(event, name, s, taskOwner)) write(`  ${line}`);
      }
      seen = history.length;
      const state = await rungs.get(requestId);
      if (state) write(`  → ${standing(state, name, s)}`);
    }
  }

  const final = requestId === undefined ? null : await rungs.get(requestId);
  const status = final?.status ?? "not submitted";
  if (scenario.expectStatus && scenario.expectStatus !== status) {
    problems.push(`expected the request to end ${scenario.expectStatus}, but it is ${status}`);
  }
  write("");
  write(
    problems.length === 0
      ? s.good(`✔ done · final status: ${status}`)
      : s.bad(`✘ ${problems.join("\n✘ ")}`),
  );
  return { ok: problems.length === 0, problems, status };

  async function perform(action: Action, id: string | undefined): Promise<string | undefined> {
    const flow = scenario.flow.key;
    if (action.do === "preview") {
      const result = await rungs.preview({
        flow,
        requesterId: action.by,
        subject: { type: flow, id: "preview" },
        payload: action.payload,
      });
      for (const line of previewLines(result, name, s)) write(`  ${line}`);
      return id;
    }
    if (action.do === "submit") {
      const state = await rungs.submit({
        flow,
        requesterId: action.by,
        subject: action.subject ?? { type: flow, id: `${flow.toUpperCase()}-1` },
        payload: action.payload,
      });
      write(s.dim(`  request ${state.id} · payload ${JSON.stringify(state.payload)}`));
      return state.id;
    }
    if (id === undefined) throw new Error(`"${action.do}" needs a submitted request; submit first`);
    const requesterId = (await rungs.get(id))?.requesterId ?? "";
    switch (action.do) {
      case "approve":
      case "reject":
        await rungs[action.do]({
          requestId: id,
          actorId: action.by,
          ...(action.comment ? { comment: action.comment } : {}),
        });
        return id;
      case "delegate": {
        const state = await rungs.get(id);
        const task = state?.steps
          .flatMap((st) => st.tasks)
          .find((t) => t.status === "pending" && t.assigneeId === action.by);
        await rungs.delegate({
          requestId: id,
          taskId: task?.id ?? "none",
          actorId: action.by,
          toUserId: action.to,
          ...(action.comment ? { comment: action.comment } : {}),
        });
        return id;
      }
      case "return":
        await rungs.return({
          requestId: id,
          actorId: action.by,
          to: action.to ? { stepId: action.to } : "requester",
          ...(action.comment ? { comment: action.comment } : {}),
        });
        return id;
      case "resubmit":
        await rungs.resubmit({
          requestId: id,
          actorId: requesterId,
          ...(action.payload === undefined ? {} : { payload: action.payload }),
        });
        write(s.dim(`  payload ${JSON.stringify((await rungs.get(id))?.payload)}`));
        return id;
      case "withdraw":
        await rungs.withdraw({
          requestId: id,
          actorId: requesterId,
          ...(action.comment ? { comment: action.comment } : {}),
        });
        return id;
      case "tick": {
        const summary = await rungs.tick();
        if (summary.changed.length === 0) write(s.dim("  nothing was due"));
        return id;
      }
    }
  }
}

function label(action: Action, name: (id: string) => string): string {
  switch (action.do) {
    case "preview":
      return `preview for ${name(action.by)}`;
    case "submit":
      return `submit by ${name(action.by)}`;
    case "approve":
    case "reject":
    case "return":
      return `${action.do} by ${name(action.by)}${action.do === "return" && action.to ? ` to step ${action.to}` : ""}`;
    case "delegate":
      return `delegate by ${name(action.by)} to ${name(action.to)}`;
    case "resubmit":
      return "resubmit by the requester";
    case "withdraw":
      return "withdraw by the requester";
    case "tick":
      return "tick (the scheduler checks deadlines)";
  }
}
