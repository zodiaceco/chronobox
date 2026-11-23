// Lets Node run the .tsx files of the watcher as they are, like its .ts files (type stripping does not read JSX):
// esbuild compiles each one as it loads. The .tsx files are the emails (src/mail.tsx) and the email pages (src/pages.tsx). The bundles do not need
// this, esbuild builds them. Used with `node --import ./jsx.mjs …` (npm test, npm start, the fork test).
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.tsx')) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, 'utf8'), {
      loader: 'tsx', jsx: 'automatic', jsxImportSource: 'react', format: 'esm', sourcefile: file, sourcemap: 'inline',
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
