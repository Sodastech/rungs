// Packs every published package the way a release does (`pnpm pack`, which replaces `workspace:`
// ranges) and checks the tarball before anything reaches npm:
//   - only the expected files, with README.md and the repository's LICENSE;
//   - no `workspace:` range left in package.json;
//   - packed size within the budget below (raise a budget deliberately, in the same change);
//   - publint (strict) and Are the Types Wrong? (ESM only) report no problem.
// Usage: pnpm build && node scripts/check-pack.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = [
  { dir: "core", budget: 120_000, allowed: ["dist/"] },
  { dir: "store-memory", budget: 15_000, allowed: ["dist/"] },
  { dir: "store-postgres", budget: 40_000, allowed: ["dist/", "migrations/"] },
];
const always = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
const license = readFileSync(join(root, "LICENSE"), "utf8");

/** Files of a .tgz as { path: content }, from the ustar headers (npm tarballs need nothing else). */
function untar(file) {
  const data = gunzipSync(readFileSync(file));
  const files = {};
  for (let at = 0; at + 512 <= data.length; ) {
    const header = data.subarray(at, at + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").trim() || "0", 8);
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^package\//, "");
    if (header[156] === 48 || header[156] === 0) {
      files[path] = data.subarray(at + 512, at + 512 + size).toString("utf8");
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    shell: process.platform === "win32",
  });

const out = mkdtempSync(join(tmpdir(), "rungs-pack-"));
const problems = [];
try {
  for (const pkg of packages) {
    const cwd = join(root, "packages", pkg.dir);
    const name = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name;
    const before = new Set(readdirSync(out));
    run("pnpm", ["pack", "--pack-destination", out], cwd);
    const tarball = readdirSync(out).find((f) => !before.has(f));
    if (tarball === undefined) throw new Error(`${name}: pnpm pack wrote no tarball`);
    const path = join(out, tarball);
    const files = untar(path);
    const size = readFileSync(path).length;
    const fail = (message) => problems.push(`${name}: ${message}`);

    for (const file of Object.keys(files)) {
      if (!always.includes(file) && !pkg.allowed.some((prefix) => file.startsWith(prefix))) {
        fail(`unexpected file ${file}`);
      }
    }
    if (!("README.md" in files)) fail("README.md is missing");
    if (files.LICENSE?.replaceAll("\r\n", "\n") !== license.replaceAll("\r\n", "\n")) {
      fail("LICENSE is missing or differs from the repository's");
    }
    if (files["package.json"]?.includes("workspace:"))
      fail("package.json still has a workspace: range");
    if (size > pkg.budget) fail(`packed size ${size} B is over the budget of ${pkg.budget} B`);

    for (const [tool, args] of [
      ["publint", ["run", path, "--strict"]],
      ["attw", [path, "--profile", "esm-only", "--format", "ascii", "--no-emoji", "--no-color"]],
    ]) {
      try {
        run("pnpm", ["exec", tool, ...args]);
      } catch (error) {
        fail(`${tool} reported problems:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
      }
    }
    console.log(
      `${name}: ${Object.keys(files).length} files, ${size} B packed (budget ${pkg.budget} B)`,
    );
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("Packages are ready to publish.");
