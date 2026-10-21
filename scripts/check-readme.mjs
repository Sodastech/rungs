// The quick start in README.md must be the code in examples/docs-snippets/src/quick-start.ts
// (its `quick-start` region), which the snippet tests run and the documentation site shows. So
// the README never shows code that fails.
// Usage: node scripts/check-readme.mjs   (Node 22+, which runs the TypeScript helper directly)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { region } from "../examples/docs-snippets/src/regions.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8").replaceAll("\r\n", "\n");
const snippet = readFileSync(
  join(root, "examples", "docs-snippets", "src", "quick-start.ts"),
  "utf8",
);

const block = /```ts\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";

if (block.trim() !== region(snippet, "quick-start").trim()) {
  console.error(
    "README.md quick start differs from examples/docs-snippets/src/quick-start.ts (region quick-start)",
  );
  process.exitCode = 1;
} else {
  console.log("README quick start matches the tested snippet.");
}
