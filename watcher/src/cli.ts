// The watcher as a program on a machine that stays on: for one Chronobox, or with --all for every Chronobox
// and a Telegram bot that asks Telegram for its messages (long polling). State in files.
//
// Run: node src/cli.ts --help   (Node 22.18+), or the bundle: node dist/watch.mjs --help
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { AllWatcher } from './all.ts';
import { type Config, HELP, parseConfig } from './config.ts';
import { DryRunStore, FileStore, type Store } from './store.ts';
import { Telegram } from './telegram.ts';
import { ConfigError, errText } from './util.ts';
import { Watcher } from './watcher.ts';

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  let cfg: Config;
  try {
    cfg = parseConfig(argv, env);
  } catch (e) {
    console.error(`Configuration error: ${errText(e)}\nRun with --help for the list of settings.`);
    return 2;
  }
  if (cfg.help) { process.stdout.write(HELP); return 0; }
  let watchers: (Watcher | AllWatcher)[];
  let telegram: Telegram | undefined;
  try {
    if (cfg.all) {
      const root: Store = cfg.dryRun ? new DryRunStore(new FileStore(cfg.stateDir)) : new FileStore(cfg.stateDir);
      telegram = cfg.telegramToken && !cfg.dryRun ? await Telegram.open(cfg, { store: root }) : undefined;
      // More than one network: each one keeps its state in its own folder, in the order of RPC_URL.
      watchers = await Promise.all(cfg.networks.map((rpcUrls, i) => AllWatcher.open(
        { ...cfg, rpcUrls },
        { telegram, store: cfg.networks.length > 1 ? root.scope(`network-${i + 1}`) : root },
      )));
    } else {
      const w = new Watcher(cfg);
      await w.load();
      watchers = [w];
    }
  } catch (e) {
    console.error(`Configuration error: ${errText(e)}`);
    return 2;
  }
  const w = watchers[0];
  const what = cfg.all
    ? `every Chronobox on ${cfg.networks.length === 1 ? 'the chain' : `${cfg.networks.length} networks`}`
    : `${cfg.chronobox ?? ''}${cfg.chronobox && cfg.delay ? ' / ' : ''}${cfg.delay ?? ''}`;
  w.log(`watching ${what} every ${cfg.pollSeconds}s${cfg.dryRun ? ' (dry run)' : ''}`);
  if (telegram) {
    try {
      await telegram.start();
      w.log(`telegram: the bot is @${telegram.username}`);
    } catch (e) {
      if (e instanceof ConfigError) { console.error(`Configuration error: ${e.message}`); return 2; }
      w.log(`telegram: cannot reach Telegram yet: ${errText(e)}`);
    }
    // The bot answers at once, also while the watcher waits for its next poll.
    if (!cfg.once) void telegram.run();
  }
  for (;;) {
    let ok = true;
    for (const one of watchers) {
      try {
        if (!(await one.poll())) ok = false;
      } catch (e) {
        if (e instanceof ConfigError) { console.error(`Configuration error: ${one.redact(e.message)}`); return 2; }
        one.log(`unexpected error: ${errText(e)}`);
        ok = false;
      }
    }
    if (cfg.once) {
      // With --once there is no loop for the bot: it reads its messages one time per run.
      if (telegram) await telegram.pump(0).catch((e) => w.log(`telegram: cannot get messages: ${errText(e)}`));
      return ok ? 0 : 1;
    }
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}

function isEntryPoint(): boolean {
  const meta = import.meta as any;
  if (typeof meta.main === 'boolean') return meta.main;
  if (!process.argv[1]) return false;
  try {
    const self = decodeURIComponent(new URL(import.meta.url).pathname);
    return fs.realpathSync(self) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
