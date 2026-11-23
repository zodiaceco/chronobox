/**
 * A picture of every scenario, as every wallet of it, for looking through in one place.
 *
 *   npm run fork && npm run scenarios && npm run dev     (first)
 *   npm run scenarios:shots                             (then this)
 *   npm run scenarios:shots -- --fault slow             (the same, with a fault of the test wallet)
 *
 * It drives a headless Google Chrome over the DevTools protocol. No package is needed: Node has
 * WebSocket, and Chrome is found where macOS and Linux put it, or in CHROME. The pictures and
 * an index.html to look at them go to .scenarios/shots/<fault or "plain">/.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.DEV_URL ?? "http://localhost:3130";
const args = process.argv.slice(2);
const fault = args.includes("--fault") ? (args[args.indexOf("--fault") + 1] ?? "") : "";
const WIDTH = Number(process.env.WIDTH ?? 430);
/** How long a page may take to settle, and how long it must stay unchanged to count as settled. */
const MAX_MS = fault === "slow" ? 60_000 : 25_000;
const QUIET_MS = fault === "slow" ? 4_000 : 1_500;

type Scenario = { id: string; title: string; about: string; safe: string; roles: Record<string, string | undefined>; fault?: string };
const list = JSON.parse(readFileSync(path.join(ROOT, ".scenarios", "scenarios.json"), "utf8")) as { chain: string; scenarios: Scenario[] };
const out = path.join(ROOT, ".scenarios", "shots", fault || "plain");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const chrome =
  process.env.CHROME ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
if (!chrome) throw new Error("No Google Chrome found. Set CHROME to its path.");

const profile = mkdtempSync(path.join(os.tmpdir(), "chronobox-shots-"));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

/** One DevTools connection to the page target. */
async function connect() {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = targets.find((t) => t.type === "page");
    } catch {
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  if (!target) throw new Error("Chrome did not start");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  let next = 0;
  const waiting = new Map<number, { done: (v: any) => void; fail: (e: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.error) entry.fail(new Error(message.error.message));
    else entry.done(message.result);
  };
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((done, fail) => {
      const id = ++next;
      waiting.set(id, { done, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const page = await connect();
await page.send("Page.enable");
await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: WIDTH < 600 });
const text = async () => (await page.send("Runtime.evaluate", { expression: "document.querySelector('main')?.innerText ?? ''", returnByValue: true })).result.value as string;

/** Opens a link and waits until the page stops changing, then takes the whole page. */
async function shot(name: string, url: string) {
  await page.send("Page.navigate", { url: "about:blank" });
  await page.send("Page.navigate", { url });
  const start = Date.now();
  let last = "";
  let since = Date.now();
  while (Date.now() - start < MAX_MS) {
    await sleep(250);
    const now = await text().catch(() => "");
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (now && !now.includes("Opening your Chronobox") && Date.now() - since >= QUIET_MS) break;
  }
  const { cssContentSize } = await page.send("Page.getLayoutMetrics");
  const height = Math.ceil(cssContentSize.height);
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 2, mobile: WIDTH < 600 });
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: WIDTH < 600 });
  writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`  ok  ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

const shots: { scenario: Scenario; role: string; file: string; fault: string }[] = [];
try {
  console.log(`Pictures of ${list.scenarios.length} scenarios${fault ? `, with the fault "${fault}"` : ""}, into ${path.relative(ROOT, out)}`);
  for (const scenario of list.scenarios) {
    const use = scenario.fault ?? fault;
    for (const [role, as] of Object.entries(scenario.roles)) {
      if (!as) continue;
      const query = new URLSearchParams({ as });
      if (use) query.set("fault", use);
      const file = `${scenario.id}-${role}`;
      await shot(file, `${BASE}/?${query}#/v/${list.chain}:${scenario.safe}`);
      shots.push({ scenario, role, file, fault: use });
    }
  }
} finally {
  page.close();
  // Chrome writes to its profile while it shuts down: remove it only once Chrome is gone.
  const gone = new Promise((done) => browser.once("exit", done));
  browser.kill();
  await Promise.race([gone, sleep(5_000)]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover folder in the system's temp directory is not worth failing for.
  }
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
writeFileSync(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chronobox states</title>
<style>body{font:14px system-ui;margin:16px;background:#f4f4f5;color:#18181b}h2{margin:32px 0 4px}p{margin:0 0 12px;color:#52525b}
.row{display:flex;gap:16px;overflow-x:auto}figure{margin:0}figcaption{font-weight:600;margin-bottom:6px}img{width:${WIDTH}px;border:1px solid #d4d4d8;border-radius:8px;background:#fff}</style>
<h1>Chronobox states${fault ? ` with the fault "${escape(fault)}"` : ""}</h1>
${list.scenarios
  .map((s) => {
    const own = shots.filter((x) => x.scenario.id === s.id);
    return `<h2>${escape(s.title)}</h2><p>${escape(s.about)}${own[0]?.fault ? ` Fault: ${escape(own[0].fault)}.` : ""}</p><div class="row">${own
      .map((x) => `<figure><figcaption>${escape(x.role)}</figcaption><img src="${x.file}.png" loading="lazy"></figure>`)
      .join("")}</div>`;
  })
  .join("\n")}
`,
);
console.log(`\nOpen ${path.relative(ROOT, path.join(out, "index.html"))}`);
