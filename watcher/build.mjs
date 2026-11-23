// Builds the watcher two ways:
//
//   .vercel/output/   the service, in the Build Output format of Vercel: one bundled file per function, and
//                     the cron job that calls /api/poll. Vercel deploys this folder as it is.
//   dist/watch.mjs    the CLI as one file without dependencies, for a machine that stays on.
//
// Node runs the sources as they are (type stripping, imports with ".ts"). A function on Vercel gets one
// bundled file instead, so that no compiler between here and there has to understand those imports.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FUNCTIONS, POLL_SCHEDULE } from './src/limits.ts';

const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, '.vercel', 'output');
const dist = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(dist, { recursive: true, force: true });

// React (for the HTML of the emails) is CommonJS and requires Node modules. An ES module has no `require`, so each
// bundle gets one. NODE_ENV picks the production build of React, which is smaller and faster.
const REQUIRE = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
const common = {
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: REQUIRE },
};

for (const [name, { maxDuration }] of Object.entries(FUNCTIONS)) {
  const dir = path.join(out, 'functions', 'api', `${name}.func`);
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src', 'api', `${name}.ts`)], outfile: path.join(dir, 'index.mjs') });
  fs.writeFileSync(path.join(dir, '.vc-config.json'), JSON.stringify({
    runtime: 'nodejs22.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    maxDuration,
  }, null, 2) + '\n');
}

fs.mkdirSync(path.join(out, 'static'), { recursive: true });
fs.writeFileSync(path.join(out, 'static', 'robots.txt'), 'User-agent: *\nDisallow: /\n');
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify({
  version: 3,
  crons: [{ path: '/api/poll', schedule: POLL_SCHEDULE }],
}, null, 2) + '\n');

await esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'src', 'cli.ts')],
  outfile: path.join(dist, 'watch.mjs'),
  banner: { js: `#!/usr/bin/env node\n// Chronobox watcher, built from watcher/src by build.mjs. Run: node watch.mjs --help\n${REQUIRE}` },
});
fs.chmodSync(path.join(dist, 'watch.mjs'), 0o755);

// The tests run the sources, not the bundles. So the build renders one email from a bundle made the same way: a
// bundle that cannot render fails here, not with the first alert.
const check = path.join(dist, 'mail-check.mjs');
await esbuild.build({ ...common, entryPoints: [path.join(root, 'src', 'mail.tsx')], outfile: check });
const { alertHtml } = await import(check);
const html = await alertHtml({ title: 'Check <1>', message: 'One\n\nTwo', box: 'Chronobox', stop: 'https://example.org/stop' });
fs.rmSync(check);
if (!html.includes('Check &lt;1&gt;') || !html.includes('href="https://example.org/stop"')) throw new Error('the bundled email does not render');

console.log(`built ${Object.keys(FUNCTIONS).map((n) => `/api/${n}`).join(', ')} (cron ${POLL_SCHEDULE}) and dist/watch.mjs`);
