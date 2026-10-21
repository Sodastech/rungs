// Shared by the release scripts: the published packages and the npm registry lookups.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

/** Published packages in publish order: dependencies first. */
export const published = ["core", "store-memory", "store-postgres"].map((dir) => {
  const manifest = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  if (manifest.private) throw new Error(`packages/${dir} is private and cannot be published`);
  return { dir, name: manifest.name, version: manifest.version };
});

/** The version every published package has; they are released together (fixed versioning). */
export function releaseVersion() {
  const versions = new Set(published.map((p) => p.version));
  if (versions.size !== 1) {
    throw new Error(
      `Published packages must share one version, found ${published.map((p) => `${p.name}@${p.version}`).join(", ")}`,
    );
  }
  return [...versions][0];
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    ...options,
  });
}

/**
 * Whether `name@version` is on npm. Fails closed: anything other than a clear answer (for
 * example a network error) throws instead of reporting "not published".
 */
export function isPublished(name, version) {
  try {
    return run("npm", ["view", `${name}@${version}`, "version", "--json"]).trim() !== "";
  } catch (error) {
    if (/E404/.test(`${error.stdout ?? ""}${error.stderr ?? ""}`)) return false;
    throw error;
  }
}
