// Publishes every package whose version is not on npm yet, dependencies first. Each package is
// packed with pnpm (which replaces `workspace:` ranges) and published with npm, which handles
// trusted publishing (OIDC) and provenance. Safe to run again after a partial failure: what is
// already on npm is skipped.
// Usage: node scripts/publish.mjs [--dry-run]   (after pnpm build)
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPublished, published, releaseVersion, root, run } from "./release-lib.mjs";

const dryRun = process.argv.includes("--dry-run");
const inWorkflow = process.env.GITHUB_ACTIONS === "true";
if (!dryRun && !inWorkflow) {
  throw new Error("Releases are published by the release workflow only; use --dry-run locally.");
}
const version = releaseVersion();
const out = mkdtempSync(join(tmpdir(), "rungs-publish-"));

try {
  for (const pkg of published) {
    if (isPublished(pkg.name, pkg.version)) {
      console.log(`${pkg.name}@${pkg.version} is on npm already; skipped.`);
      continue;
    }
    const before = new Set(readdirSync(out));
    run("pnpm", ["pack", "--pack-destination", out], { cwd: join(root, "packages", pkg.dir) });
    const tarball = readdirSync(out).find((f) => !before.has(f));
    if (tarball === undefined) throw new Error(`${pkg.name}: pnpm pack wrote no tarball`);

    // Provenance is automatic with trusted publishing; the flag also covers the first release,
    // which uses a short-lived token instead (RELEASING.md). It needs the workflow's identity.
    const args = ["publish", join(out, tarball), "--access", "public"];
    if (inWorkflow) args.push("--provenance");
    if (dryRun) args.push("--dry-run");
    run("npm", args, { stdio: "inherit" });
    console.log(`${dryRun ? "Checked" : "Published"} ${pkg.name}@${pkg.version}`);
  }
  console.log(`Release ${version}: ${dryRun ? "dry run done" : "published"}.`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
