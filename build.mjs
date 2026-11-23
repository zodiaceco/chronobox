// Build pipeline for Zodiac Chronobox. Plain Node + esbuild, no other dependencies.
//
//   node build.mjs          production build into out/ (reproducible)
//   node build.mjs --dev    watch + rebuild into out/, serve on PORT (default 3130)
//
// Production options: --sourcemap adds linked sourcemaps (off by default).
//
// The build hash:
//   One hash names the whole build. The page shows its first 8 characters in
//   the footer, so the page must contain the hash, so the hash cannot cover
//   the final index.html. It is defined like this:
//     sha256 over the sorted lines "<path> <sha256>\n" of every file in out/
//     except build.json, where index.html is hashed with the placeholder
//     __BUILD_HASH__ in the place where the hash goes.
//   To check a deployed copy: put the placeholder back into index.html and
//   compute the same thing, or build the same commit and compare.
//   build.json lists the final sha256 of every file, index.html included.

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const STATIC = path.join(ROOT, "static");
const args = new Set(process.argv.slice(2));
const DEV = args.has("--dev");
/** A short tag of the film's content, in both of its sizes. It goes into the film's address, so that a new film is never taken from a cache. */
function filmTag() {
  const files = ["chronobox-film.mp4", "chronobox-film-1440.mp4"].map((name) => path.join(STATIC, name)).filter((file) => existsSync(file));
  if (files.length === 0) return "none";
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex").slice(0, 10);
}

// The dev server writes to its own folder, so a production build never mixes with it.
const OUT = path.join(ROOT, DEV ? "out-dev" : "out");
const SOURCEMAP = DEV || args.has("--sourcemap");

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));

const PROD_CONNECT = "connect-src 'none'";
const DEV_CONNECT = "connect-src 'self' http://127.0.0.1:8545 http://localhost:8545 http://127.0.0.1:8546";
const HASH_PLACEHOLDER = "__BUILD_HASH__";

/** Shared esbuild options for app code. */
function appOptions() {
  return {
    absWorkingDir: ROOT,
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    jsxImportSource: "preact",
    charset: "utf8",
    minify: !DEV,
    sourcemap: SOURCEMAP ? "linked" : false,
    sourcesContent: DEV,
    define: {
      __DEV__: JSON.stringify(DEV),
      __VERSION__: JSON.stringify(pkg.version),
      __FILM__: JSON.stringify(filmTag()),
    },
    loader: {
      ".svg": "file",
      ".png": "file",
      ".woff2": "file",
      ".woff": "file",
    },
    assetNames: "assets/[name]-[hash]",
    logLevel: "warning",
  };
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function clean() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
}

async function copyStatic() {
  if (!existsSync(STATIC)) return;
  await fs.cp(STATIC, OUT, { recursive: true });
}

/** Fill src/index.html: hashed asset names, dev CSP and dev wallet script. */
async function writeIndex({ js, css }) {
  let html = await fs.readFile(path.join(SRC, "index.html"), "utf8");
  const replace = (from, to) => {
    if (!html.includes(from)) throw new Error(`src/index.html: expected to find ${from}`);
    html = html.replace(from, to);
  };
  replace('href="./assets/app.css"', `href="./${css}"`);
  replace('src="./assets/app.js"', `src="./${js}"`);
  if (!html.includes(HASH_PLACEHOLDER)) throw new Error(`src/index.html: expected to find ${HASH_PLACEHOLDER}`);
  if (DEV) {
    html = html.replace(HASH_PLACEHOLDER, "dev");
    replace(PROD_CONNECT, DEV_CONNECT);
    // Classic script without defer: runs before the module app script.
    replace(
      `<script type="module" src="./${js}"></script>`,
      `<script src="./dev-wallet.js"></script>\n    <script type="module" src="./${js}"></script>`,
    );
  }
  assertNoInline(html);
  await fs.writeFile(path.join(OUT, "index.html"), html);
}

function assertNoInline(html) {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=/.test(m[1]) || m[2].trim() !== "") throw new Error("index.html: inline script not allowed");
  }
  if (/<style\b/i.test(html) || /\sstyle=/i.test(html)) throw new Error("index.html: inline style not allowed");
  if (/\son[a-z]+=/i.test(html)) throw new Error("index.html: inline event handler not allowed");
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Production

async function buildProd() {
  await clean();
  await copyStatic();

  const result = await esbuild.build({
    ...appOptions(),
    entryPoints: [{ in: "src/main.tsx", out: "app" }],
    outdir: OUT,
    entryNames: "assets/[name]-[hash]",
    metafile: true,
    write: true,
  });
  const outputs = Object.keys(result.metafile.outputs).map((p) => path.relative(OUT, path.join(ROOT, p)).split(path.sep).join("/"));
  const js = outputs.find((p) => /^assets\/app-[^/]+\.js$/.test(p));
  const css = outputs.find((p) => /^assets\/app-[^/]+\.css$/.test(p));
  if (!js) throw new Error("build: no app JS output");
  if (!css) throw new Error("build: no app CSS output (src/main.tsx must import ./styles.css)");
  await writeIndex({ js, css });

  // The build hash (see the header comment). index.html still has the placeholder here.
  const files = {};
  for (const p of await listFiles(OUT)) files[p] = sha256(await fs.readFile(path.join(OUT, p)));
  const buildHash = sha256(Object.keys(files).sort().map((p) => `${p} ${files[p]}\n`).join(""));
  const indexPath = path.join(OUT, "index.html");
  await fs.writeFile(indexPath, (await fs.readFile(indexPath, "utf8")).replace(HASH_PLACEHOLDER, buildHash));

  // build.json: the final hash of every file except itself.
  const all = {};
  for (const p of await listFiles(OUT)) all[p] = sha256(await fs.readFile(path.join(OUT, p)));
  const manifest = { version: pkg.version, buildHash, files: all };
  await fs.writeFile(path.join(OUT, "build.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Guard: the dev wallet must never reach production.
  for (const p of await listFiles(OUT)) {
    const text = await fs.readFile(path.join(OUT, p), "latin1");
    if (text.includes("dev-wallet")) throw new Error(`build: "dev-wallet" found in out/${p}`);
  }

  // Report.
  const rows = [];
  for (const p of await listFiles(OUT)) {
    const buf = await fs.readFile(path.join(OUT, p));
    rows.push([p, String(buf.length), sha256(buf)]);
  }
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  for (const [p, size, hash] of rows) console.log(`${p.padEnd(w0)}  ${size.padStart(w1)}  ${hash}`);
  console.log(`\nversion     ${pkg.version}\nbuild hash  ${buildHash}`);
}

// ---------------------------------------------------------------------------
// Dev

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function serve(req, res) {
  const send = (status, body, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed\n");

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return send(400, "Bad request\n");
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  // The states that `npm run scenarios` put on the fork, for #/states. Not a file of the build.
  if (pathname === "/scenarios.json") {
    return fs.readFile(path.join(ROOT, ".scenarios", "scenarios.json")).then(
      (body) => send(200, body, "application/json; charset=utf-8"),
      () => send(404, "No scenarios yet: run npm run scenarios\n"),
    );
  }
  // The dev server also serves the files in brand/.
  const base = pathname.startsWith("/brand/") ? ROOT : OUT;
  const file = path.join(base, path.normalize(pathname));
  if (file !== base && !file.startsWith(base + path.sep)) return send(403, "Forbidden\n");

  fs.readFile(file)
    .then((body) => send(200, body, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"))
    .catch(async () => {
      // SPA fallback only for navigations without a file extension.
      if (path.extname(pathname) === "") {
        try {
          return send(200, await fs.readFile(path.join(OUT, "index.html")), MIME[".html"]);
        } catch {}
      }
      send(404, "Not found\n");
    });
}

async function dev() {
  const port = Number(process.env.PORT ?? 3130);
  const server = http.createServer(serve);
  try {
    await listen(server, port);
  } catch (err) {
    if (err.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Stop the other process or set PORT.`);
    else console.error(err);
    process.exit(1);
  }

  await clean();
  await copyStatic();
  const assets = { js: "assets/app.js", css: "assets/app.css" };
  await writeIndex(assets);

  const log = (label) => ({
    name: "log",
    setup(build) {
      build.onEnd((r) => {
        const t = new Date().toLocaleTimeString();
        if (r.errors.length) console.log(`[${t}] ${label}: build failed (${r.errors.length} errors)`);
        else console.log(`[${t}] ${label}: built`);
      });
    },
  });
  const appCtx = await esbuild.context({
    ...appOptions(),
    entryPoints: [{ in: "src/main.tsx", out: "app" }],
    outdir: path.join(OUT, "assets"),
    plugins: [log("app")],
  });
  // Classic script (IIFE) so it runs before the module app script and keeps its globals private.
  const walletCtx = await esbuild.context({
    ...appOptions(),
    format: "iife",
    entryPoints: [{ in: "src/dev-wallet.ts", out: "dev-wallet" }],
    outdir: OUT,
    plugins: [log("dev-wallet")],
  });
  await Promise.all([appCtx.watch(), walletCtx.watch()]);

  const rerun = (what, fn) => () =>
    fn().then(
      () => console.log(`[${new Date().toLocaleTimeString()}] ${what} updated`),
      (e) => console.error(`${what}: ${e.message}`),
    );
  if (existsSync(STATIC)) fsWatch(STATIC, { recursive: true }, rerun("static", copyStatic));
  fsWatch(path.join(SRC, "index.html"), rerun("index.html", () => writeIndex(assets)));

  console.log(`Dev server: http://localhost:${port}/  (anvil wallet: ?account=0|1|2, scenarios: #/states)`);

  const stop = async () => {
    await Promise.all([appCtx.dispose(), walletCtx.dispose()]);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

try {
  if (DEV) await dev();
  else await buildProd();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
