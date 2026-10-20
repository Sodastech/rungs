// The quick-start in README.md must be the code that examples/expense-basic/test/readme.test.ts
// runs (between its README:start / README:end markers), so the README never shows code that fails.
// Usage: node scripts/check-readme.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8").replaceAll("\r\n", "\n");
const test = readFileSync(
  join(root, "examples", "expense-basic", "test", "readme.test.ts"),
  "utf8",
).replaceAll("\r\n", "\n");

const block = /```ts\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";
const tested = (test.split("// README:start\n")[1] ?? "").split("// README:end")[0] ?? "";
const dedented = tested
  .split("\n")
  .map((line) => line.replace(/^ {2}/, ""))
  .join("\n")
  .replace(/^const \{ (\w+) \} = await import\(("[^"]+")\);$/gm, "import { $1 } from $2;");

if (block.trim() !== dedented.trim()) {
  console.error("README.md quick start differs from examples/expense-basic/test/readme.test.ts");
  process.exitCode = 1;
} else {
  console.log("README quick start matches the tested example.");
}
