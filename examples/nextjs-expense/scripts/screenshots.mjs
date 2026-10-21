// Takes the README screenshots of the running demo with a local Chrome or Edge, through the
// DevTools protocol. No dependencies.
//
//   pnpm build && pnpm start          (in another terminal, on a freshly reset demo)
//   node scripts/screenshots.mjs [shots.json] [--base http://localhost:3000] [--out dir]
//
// A shot is { name, user, path | find, width?, height?, fullPage?, capture?, before?: [js...] }.
// `capture: false` only runs `before`, to set up state for the shots after it.
// `find: { on, link }` opens `on` and follows the first link whose text contains `link`.
// `before` runs in the page (after it loads) and may click buttons; the page reloads after each.
// Pages showing an error message (.alert.error) are reported.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args.splice(i, 2)[1];
};
const base = option("--base", "http://localhost:3000");
const out = resolve(option("--out", "../../assets/screenshots"));
const shots = JSON.parse(readFileSync(args[0] ?? "scripts/shots.json", "utf8"));

const browsers = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const executable = browsers.find((p) => existsSync(p));
if (!executable) throw new Error("No Chrome found; set CHROME_PATH");

const profile = mkdtempSync(join(tmpdir(), "rungs-shots-"));
const port = 9333;
const browser = spawn(executable, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--hide-scrollbars",
  "--force-color-profile=srgb",
  "about:blank",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path, init) {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}${path}`, init)).json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error("The browser did not start");
}

const target = await json("/json/new?about:blank", { method: "PUT" });
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 0;
const pending = new Map();
const waiters = [];
const problems = [];
ws.addEventListener("message", (message) => {
  const data = JSON.parse(message.data);
  if (data.id !== undefined) {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error.message));
    else p.resolve(data.result);
    return;
  }
  if (data.method === "Runtime.exceptionThrown") problems.push(data.params.exceptionDetails.text);
  if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
    problems.push(data.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  for (const w of [...waiters]) {
    if (w.method === data.method) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(data.params);
    }
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));

async function load(url) {
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await sleep(400);
}

await send("Page.enable");
await send("Runtime.enable");
mkdirSync(out, { recursive: true });

for (const shot of shots) {
  const width = shot.width ?? 1280;
  const height = shot.height ?? 860;
  const mobile = width < 600;
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile,
  });
  await send("Network.setCookie", { name: "demo_user", value: shot.user, url: base });
  let path = shot.path;
  if (shot.find) {
    await load(`${base}${shot.find.on}`);
    const { result } = await send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll("a")].find((a) => a.textContent.includes(${JSON.stringify(shot.find.link)}))?.getAttribute("href") ?? ""`,
    });
    if (!result.value)
      throw new Error(`${shot.name}: no link "${shot.find.link}" on ${shot.find.on}`);
    path = result.value;
  }
  await load(`${base}${path}`);
  for (const script of shot.before ?? []) {
    const done = once("Page.loadEventFired");
    await send("Runtime.evaluate", { expression: script, awaitPromise: true });
    await Promise.race([done, sleep(2500)]);
    const { result } = await send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll(".alert.error")].map((e) => e.textContent).join(" | ")`,
    });
    if (result.value) problems.push(`${shot.name}: ${result.value}`);
    await load(`${base}${path}`);
  }
  if (shot.capture === false) continue;
  let clip;
  if (shot.fullPage) {
    const { cssContentSize } = await send("Page.getLayoutMetrics");
    clip = { x: 0, y: 0, width, height: Math.ceil(cssContentSize.height), scale: 1 };
  }
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  });
  const file = join(out, `${shot.name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`saved ${file}`);
}

ws.close();
browser.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
if (problems.length > 0) {
  console.error(`Console errors:\n${problems.join("\n")}`);
  process.exitCode = 1;
}
