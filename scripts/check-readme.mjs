// The code in each README must be a region of a file in examples/docs-snippets, whose tests run it
// and which the documentation site shows. So no README shows code that fails.
// Usage: node scripts/check-readme.mjs   (Node 22+, which runs the TypeScript helper directly)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { region } from "../examples/docs-snippets/src/regions.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (...path) => readFileSync(join(root, ...path), "utf8").replaceAll("\r\n", "\n");

// The first ts block of each README, and the snippet region it must equal.
const readmes = [
  { readme: "README.md", file: "quick-start.ts", region: "quick-start" },
  { readme: "packages/core/README.md", file: "quick-start.ts", region: "quick-start" },
  { readme: "packages/store-memory/README.md", file: "guides/testing.ts", region: "test" },
  { readme: "packages/store-postgres/README.md", file: "guides/postgres.ts", region: "connect" },
];

let failed = 0;
for (const r of readmes) {
  const block = /```ts\n([\s\S]*?)```/.exec(read(r.readme))?.[1] ?? "";
  const snippet = read("examples", "docs-snippets", "src", r.file);
  if (block.trim() !== region(snippet, r.region).trim()) {
    console.error(
      `${r.readme}: the code differs from examples/docs-snippets/src/${r.file} (region ${r.region})`,
    );
    failed += 1;
  }
}
if (failed > 0) process.exitCode = 1;
else console.log(`README code matches the tested snippets (${readmes.length} files).`);
