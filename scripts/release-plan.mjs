// Decides whether the release workflow publishes: when the versions in the repository are not on
// npm yet. Writes `publish` and `version` to $GITHUB_OUTPUT when it is set.
// Usage: node scripts/release-plan.mjs
import { appendFileSync } from "node:fs";
import { isPublished, published, releaseVersion } from "./release-lib.mjs";

const version = releaseVersion();
// 0.0.0 is the placeholder version of a package that was never released.
const missing = version === "0.0.0" ? [] : published.filter((p) => !isPublished(p.name, p.version));
const publish = missing.length > 0;

console.log(
  publish
    ? `To publish: ${missing.map((p) => `${p.name}@${p.version}`).join(", ")}`
    : version === "0.0.0"
      ? "0.0.0 is the placeholder of an unreleased package; nothing to publish."
      : `Everything at ${version} is on npm already.`,
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\nversion=${version}\n`);
}
