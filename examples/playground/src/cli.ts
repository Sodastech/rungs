// Usage: pnpm playground scenarios/<name>.ts   (from the repository root or examples/playground)
//        pnpm playground --all                  (every scenario; exits 1 if one fails)

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runScenario } from "./run.js";
import type { Scenario } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(here, "..", "scenarios");
const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function locate(arg: string): string {
  const candidates = [
    resolve(process.cwd(), arg),
    resolve(process.env.INIT_CWD ?? process.cwd(), arg),
    resolve(here, "..", arg),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`scenario not found: ${arg} (looked in ${candidates.join(", ")})`);
  return found;
}

async function load(path: string): Promise<Scenario> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: Scenario };
  if (!mod.default) throw new Error(`${path} must export default scenario({ ... })`);
  return mod.default;
}

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.length === 0) {
  console.error("usage: pnpm playground scenarios/<name>.ts   or   pnpm playground --all");
  console.error(`scenarios: ${readdirSync(scenariosDir).join(", ")}`);
  process.exit(2);
}
const files =
  args[0] === "--all"
    ? readdirSync(scenariosDir)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => join(scenariosDir, f))
    : args.map(locate);

let failed = 0;
for (const [i, file] of files.entries()) {
  if (i > 0) console.log("\n");
  const result = await runScenario(await load(file), (line) => console.log(line), { color });
  if (!result.ok) failed += 1;
}
process.exitCode = failed > 0 ? 1 : 0;
