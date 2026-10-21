// After a publish: tags the release (`<package>@<version>` for each package and `v<version>`) and
// creates one GitHub Release, "Rungs <version>", from the packages' changelogs. Skips what exists.
// Usage: node scripts/github-release.mjs [--dry-run]   (needs gh and GH_TOKEN in CI)
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { published, releaseVersion, root, run } from "./release-lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const version = releaseVersion();
const site = "https://sodastech.github.io/rungs";

/** The changelog section of one version, with "Updated dependencies" entries left out. */
function changes(dir) {
  const log = readFileSync(join(root, "packages", dir, "CHANGELOG.md"), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const start = log.indexOf(`\n## ${version}\n`);
  if (start === -1) throw new Error(`packages/${dir}/CHANGELOG.md has no section for ${version}`);
  const rest = log.slice(start + `\n## ${version}\n`.length);
  const end = rest.search(/\n## /);
  const section = (end === -1 ? rest : rest.slice(0, end))
    .replace(/- Updated dependencies[\s\S]*?(?=\n- |\n### |$)/g, "")
    .replace(/### Patch Changes\s*(?=### |$)/g, "")
    .replace(/^### /gm, "#### ")
    .trim();
  return section;
}

const notes = [
  "```bash",
  `npm install ${published.map((p) => `${p.name}@${version}`).join(" ")}`,
  "```",
  "",
  `Documentation: ${site}/ · Edge case catalog: ${site}/edge-cases/`,
  "",
  ...published.flatMap((p) => [`## ${p.name}`, "", changes(p.dir), ""]),
  "Every package is published from this repository's release workflow with npm provenance.",
  "",
].join("\n");

const tags = [...published.map((p) => `${p.name}@${version}`), `v${version}`];
if (dryRun) {
  console.log(`Tags: ${tags.join(", ")}\n\n# Rungs ${version}\n\n${notes}`);
  process.exit(0);
}

for (const tag of tags) {
  if (run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "") {
    console.log(`Tag ${tag} exists; skipped.`);
    continue;
  }
  run("git", ["tag", tag]);
  run("git", ["push", "origin", `refs/tags/${tag}`]);
  console.log(`Tagged ${tag}`);
}

let exists = true;
try {
  run("gh", ["release", "view", `v${version}`]);
} catch {
  exists = false;
}
if (exists) {
  console.log(`Release v${version} exists; skipped.`);
} else {
  const file = join(tmpdir(), `rungs-release-${version}.md`);
  writeFileSync(file, notes);
  run("gh", [
    "release",
    "create",
    `v${version}`,
    "--title",
    `Rungs ${version}`,
    "--notes-file",
    file,
    "--verify-tag",
    "--latest",
  ]);
  console.log(`Created release v${version}`);
}
