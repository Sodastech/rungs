// Installs a release the way a user does, in an empty folder, and checks that it works:
//   - npm install of the three packages (with the registry's signatures and provenance checked);
//   - the README quick start runs, and so do the subpath entry points and the PostgreSQL store on
//     PGlite;
//   - TypeScript (strict) accepts all of it with `nodenext` and with `bundler` resolution.
// Usage: node scripts/verify-release.mjs <version>             (from npm, after a release)
//        node scripts/verify-release.mjs --tarballs <dir>      (from `pnpm pack` output, before)
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { region } from "../examples/docs-snippets/src/regions.ts";
import { published, root, run } from "./release-lib.mjs";

const args = process.argv.slice(2);
const tarballs = args[0] === "--tarballs" ? resolve(args[1] ?? "") : undefined;
const version = tarballs === undefined ? args[0] : undefined;
if (tarballs === undefined && !/^\d+\.\d+\.\d+/.test(version ?? "")) {
  console.error("Usage: node scripts/verify-release.mjs <version> | --tarballs <dir>");
  process.exit(2);
}

// The same versions the repository tests with.
const pglite = "@electric-sql/pglite@0.5.8";
const typescript = "typescript@5.9.3";
const typesNode = "@types/node@22.20.5";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A new version can take a few minutes to appear on every registry mirror. */
async function waitForRegistry() {
  for (let attempt = 1; ; attempt += 1) {
    const missing = published.filter((p) => {
      try {
        return run("npm", ["view", `${p.name}@${version}`, "version"]).trim() !== version;
      } catch {
        return true;
      }
    });
    if (missing.length === 0) return;
    if (attempt === 40)
      throw new Error(`Not on npm after 10 minutes: ${missing.map((p) => p.name)}`);
    await sleep(15_000);
  }
}

function provenance() {
  for (const p of published) {
    const attestations = JSON.parse(
      run("npm", ["view", `${p.name}@${version}`, "dist.attestations", "--json"]) || "null",
    );
    const type = attestations?.provenance?.predicateType ?? "";
    if (!type.includes("slsa.dev/provenance")) {
      throw new Error(`${p.name}@${version} has no provenance attestation`);
    }
  }
  console.log("Provenance: every package has a provenance attestation.");
}

const quickStart = region(
  readFileSync(join(root, "examples", "docs-snippets", "src", "quick-start.ts"), "utf8"),
  "quick-start",
);

const entryPoints = `import { type ApproveInput, createRungs, RungsError } from "@rungsjs/core";
import { type Command, decide } from "@rungsjs/core/engine";
import { requestSummary, type StoreTx } from "@rungsjs/core/store";
import { memoryStore } from "@rungsjs/store-memory";
import { fromPg, migrationSql, postgresStore } from "@rungsjs/store-postgres";

const input: ApproveInput = { requestId: "r1", actorId: "u1" };
const command: Command = { type: "approve", ...input };
const methods: (keyof StoreTx)[] = ["getRequest", "saveRequest"];
for (const value of [createRungs, decide, requestSummary, memoryStore, RungsError, fromPg, postgresStore]) {
  if (typeof value !== "function") throw new Error("an entry point export is missing");
}
if (!migrationSql().includes("CREATE TABLE")) throw new Error("migrationSql returned no tables");
console.log("entry points:", command.type, methods.length);
`;

const postgres = `import { PGlite } from "@electric-sql/pglite";
import { createRungs } from "@rungsjs/core";
import { fromPglite, migrate, postgresStore, SCHEMA_VERSION } from "@rungsjs/store-postgres";

const db = fromPglite(await PGlite.create());
await migrate(db);
const rungs = createRungs({
  store: postgresStore(db),
  clock: () => new Date(),
  ids: () => crypto.randomUUID(),
  events: "discard",
});
await rungs.flows.register({
  key: "expense",
  steps: [{ id: "manager", approvers: { type: "users", ids: ["u_mgr"] } }],
});
const request = await rungs.submit({
  flow: "expense",
  requesterId: "u_req",
  subject: { type: "expense", id: "EXP-1" },
  payload: { amount: 5 },
});
const approved = await rungs.approve({ requestId: request.id, actorId: "u_mgr" });
if (approved.status !== "approved") throw new Error(\`expected approved, got \${approved.status}\`);
console.log(\`store-postgres: schema \${SCHEMA_VERSION}, request \${approved.status}\`);
`;

// Our declarations are checked in full (skipLibCheck false). PGlite's own declarations need DOM
// and Emscripten types, so the file that uses it is checked with skipLibCheck, as users do.
const tsconfig = (module, moduleResolution, files, skipLibCheck) =>
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "es2023",
      lib: ["es2023"],
      module,
      moduleResolution,
      types: ["node"],
      noEmit: true,
      skipLibCheck,
    },
    files,
  });

const dir = mkdtempSync(join(tmpdir(), "rungs-verify-"));
const inDir = (command, commandArgs) => run(command, commandArgs, { cwd: dir });
try {
  if (version !== undefined) await waitForRegistry();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "rungs-verify", private: true, type: "module" }),
  );
  const specs =
    tarballs === undefined
      ? published.map((p) => `${p.name}@${version}`)
      : published.map((p) => {
          const prefix = `${p.name.replace("@", "").replace("/", "-")}-`;
          const file = readdirSync(tarballs).find(
            (f) => f.startsWith(prefix) && f.endsWith(".tgz"),
          );
          if (file === undefined) throw new Error(`No tarball for ${p.name} in ${tarballs}`);
          return join(tarballs, file);
        });
  inDir("npm", [
    "install",
    "--no-fund",
    "--no-audit",
    "--ignore-scripts",
    ...specs,
    pglite,
    typescript,
    typesNode,
  ]);
  console.log(`Installed ${published.map((p) => p.name).join(", ")}`);

  if (version !== undefined) {
    console.log(inDir("npm", ["audit", "signatures"]).trim());
    provenance();
  }

  writeFileSync(join(dir, "quick-start.ts"), quickStart);
  writeFileSync(join(dir, "entry-points.ts"), entryPoints);
  writeFileSync(join(dir, "postgres.ts"), postgres);
  for (const file of ["quick-start.ts", "entry-points.ts", "postgres.ts"]) {
    inDir("node", [file]);
    console.log(`Ran ${file}`);
  }

  for (const [module, resolution] of [
    ["nodenext", "nodenext"],
    ["esnext", "bundler"],
  ]) {
    writeFileSync(
      join(dir, "tsconfig.json"),
      tsconfig(module, resolution, ["quick-start.ts", "entry-points.ts"], false),
    );
    inDir("npx", ["--no-install", "tsc", "-p", "tsconfig.json"]);
    writeFileSync(join(dir, "tsconfig.json"), tsconfig(module, resolution, ["postgres.ts"], true));
    inDir("npx", ["--no-install", "tsc", "-p", "tsconfig.json"]);
    console.log(`TypeScript strict, moduleResolution ${resolution}: no errors`);
  }
  console.log(`Verified ${version ?? "the packed tarballs"} from a clean install.`);
} catch (error) {
  console.error(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  throw error;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
