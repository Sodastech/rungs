// Every edge case marked "Core" in docs/05-edge-cases.md must have a test whose name starts with
// its ID (CLAUDE.md rule 3), and every ID a test names must exist in the catalog.
// Usage: node scripts/check-ec-coverage.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** @returns {Map<string, string>} ID → tier */
function catalog() {
  const rows = new Map();
  const doc = readFileSync(join(root, "docs", "05-edge-cases.md"), "utf8");
  for (const line of doc.split("\n")) {
    const match = /^\| (EC-\d+) \|/.exec(line);
    if (!match) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    rows.set(match[1], cells.at(-2) ?? "");
  }
  return rows;
}

/** Test files: *.test.ts anywhere, plus the shared suites in packages/store-contract/src. */
function testFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, found);
    else if (
      name.endsWith(".test.ts") ||
      (name.endsWith(".ts") &&
        relative(root, path).startsWith(join("packages", "store-contract", "src") + sep))
    ) {
      found.push(path);
    }
  }
  return found;
}

const rows = catalog();
const tested = new Map();
for (const dir of ["packages", "examples"]) {
  for (const file of testFiles(join(root, dir))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'`](EC-\d+) /g)) {
      const files = tested.get(match[1]) ?? new Set();
      files.add(relative(root, file));
      tested.set(match[1], files);
    }
  }
}

const core = [...rows].filter(([, tier]) => /\bCore\b/.test(tier)).map(([id]) => id);
const missing = core.filter((id) => !tested.has(id));
const unknown = [...tested.keys()].filter((id) => !rows.has(id));

console.log(
  `Edge cases: ${rows.size} in the catalog, ${core.length} Core, ${core.length - missing.length} covered.`,
);
if (missing.length > 0) console.error(`Core edge cases without a test: ${missing.join(", ")}`);
if (unknown.length > 0) {
  console.error(
    `Tests name edge cases that are not in the catalog: ${unknown
      .map((id) => `${id} (${[...(tested.get(id) ?? [])].join(", ")})`)
      .join(", ")}`,
  );
}
process.exitCode = missing.length > 0 || unknown.length > 0 ? 1 : 0;
