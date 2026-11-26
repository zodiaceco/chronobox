// The settings of the CLI, from flags and environment variables.
import { isIP } from 'node:net';
import { APP_URL } from './format.ts';
import { ConfigError } from './util.ts';

export type Config = {
  rpcUrls: string[];
  chronobox?: string;
  delay?: string;
  webhookUrl?: string;
  pollSeconds: number;
  heartbeatHours: number;
  stateFile: string;
  failPolls: number;
  logChunk: number;
  once: boolean;
  dryRun: boolean;
  help: boolean;
  // --all: watch every Chronobox on the chain.
  all: boolean;
  stateDir: string;
  startBlock?: number;
  // --all: the most blocks that one poll searches. A watcher that is far behind catches up over several polls. 0: no limit.
  maxScanBlocks: number;
  // The service: the chain that the RPC must be on. The CLI takes the chain that the RPC is on.
  chainId?: number;
  // --all: one list of RPC URLs per network. `rpcUrls` is the list of the network that a watcher reads.
  networks: string[][];
  // --all: a Telegram bot that sends the alerts of a Chronobox to every chat that asked for them.
  telegramToken?: string;
  telegramApi: string;
  // The secret that encrypts the lists of chats and of email addresses. It is not stored with them.
  alertsKey?: string;
  // --all: alerts by email, sent through Resend. People sign up on a page of this watcher (/api/email).
  resendKey?: string;
  resendApi: string;
  emailFrom?: string;
  // Where this watcher is on the web (no path). The links in the emails start with it.
  publicUrl?: string;
  // The Chronobox app (no path). An alert ends with a link to the page of its Chronobox there.
  appUrl: string;
  // The CLI: where the sign-up page listens, and which peers may name the visitor in X-Forwarded-For.
  port: number;
  bindAddress: string;
  trustedProxies: string[];
  // The service key of the watcher for the internal RPC of Zodiac, sent only to rpcServiceHost.
  rpcServiceKey?: string;
  rpcServiceHost: string;
};


export const HELP = `Zodiac Chronobox watcher

Watches a Chronobox vault (a Safe whose only exit is a Zodiac Delay, optionally
with a Roles modifier that lets a few addresses cancel) and sends an alert when
a transaction is queued, becomes ready, expires soon, is cancelled, leaves the
queue, or when the vault settings change. Needs only public data, no keys.

Usage: node watch.mjs [flags]          watch one vault
       node watch.mjs --all [flags]    watch every Chronobox on the chain

Settings (environment variable or --flag value):
  RPC_URL          --rpc-url          RPC endpoint; comma-separated list for fallbacks (required).
                                      With --all: a semicolon between networks, to watch more than one
  CHRONOBOX          --chronobox          the vault (Safe) address; the Delay and the Roles modifier are found among its modules
  DELAY            --delay            the Delay modifier address (instead of, or with, CHRONOBOX)
  WEBHOOK_URL      --webhook-url      URL that receives a JSON POST per alert
  POLL_SECONDS     --poll-seconds     seconds between polls (default 60)
  HEARTBEAT_HOURS  --heartbeat-hours  "All quiet" message interval (default 24, 0 = off)
  STATE_FILE       --state-file       where the watcher remembers what it sent (default ./chronobox-watch-state.json)
  FAIL_POLLS       --fail-polls       failed polls in a row before a "watcher problem" alert (default 3)
  LOG_CHUNK        --log-chunk        blocks per eth_getLogs request (default 2000, halved on error)
  RPC_SERVICE_KEY  --rpc-service-key  the key of chronobox for the internal RPC of Zodiac (CHRONOBOX_SERVICE_KEY of the worker).
                                      Sent only to RPC_SERVICE_HOST (default rpc.zodiac.eco)

With --all (instead of CHRONOBOX, DELAY and STATE_FILE):
  STATE_DIR        --state-dir        folder for the state files (default ./chronobox-watch-state)
  START_BLOCK      --start-block      first block to search for Chronoboxes (default: the newest block at the first start)
  MAX_SCAN_BLOCKS  --max-scan-blocks  the most blocks that one poll searches (default 50000, 0 = no limit)
  TELEGRAM_TOKEN   --telegram-token   token of a Telegram bot. A person opens https://t.me/<bot>?start=<chain id>-<vault address>
                                      and presses Start. From then on the bot sends the alerts of that Chronobox to that chat.
  RESEND_KEY       --resend-key       API key of Resend. With it the watcher sends the alerts by email, and serves a page
                                      (/api/email) where a person gives an email address and confirms it (double opt-in).
  EMAIL_FROM       --email-from       the sender, for example "Chronobox alerts <alerts@example.org>", on a domain that Resend verified
  PUBLIC_URL       --public-url       where this watcher is on the web, for example https://alerts.example.org. The links in the
                                      emails start with it. Required with RESEND_KEY
  APP_URL          --app-url          the Chronobox app (default https://www.chrono.box). An alert in Telegram or by email
                                      ends with a link to the page of its Chronobox there
  PORT             --port             the port of the sign-up page (default 8787). Put a proxy with TLS in front of it
  BIND_ADDRESS     --bind-address     where the sign-up page listens (default 127.0.0.1: the proxy is on this machine)
  TRUSTED_PROXIES  --trusted-proxies  the addresses of the proxies, with commas, whose X-Forwarded-For names the visitor
                                      (default 127.0.0.1,::1). From any other address, the address itself is the visitor
  ALERTS_KEY       --alerts-key       a secret of 32 characters or more. It encrypts the lists of chats and of email addresses
                                      in STATE_DIR. Required with TELEGRAM_TOKEN or RESEND_KEY. Keep it away from STATE_DIR and
                                      its backups. TELEGRAM_KEY is its older name, and still works

Flags:
  --all       watch every Chronobox on the chain; the alerts of a vault go to the Telegram chats and email addresses that follow it
  --once      poll one time and exit (for cron); exit code 1 if the chain could not be read
  --dry-run   print alerts instead of sending them; the state file is not written
  --help      show this text

Exit codes: 0 ok, 1 chain read failed (--once only), 2 configuration error.
`;

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function parseConfig(argv: string[], env: Record<string, string | undefined>): Config {
  const vals: Record<string, string | undefined> = { ...env };
  const bools = { once: false, dryRun: false, help: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new ConfigError(`Unexpected argument: ${a}`);
    let name = a.slice(2);
    let value: string | undefined;
    const eq = name.indexOf('=');
    if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
    const key = name.toUpperCase().replace(/-/g, '_');
    if (key === 'ONCE') { bools.once = true; continue; }
    if (key === 'DRY_RUN') { bools.dryRun = true; continue; }
    if (key === 'ALL') { bools.all = true; continue; }
    if (key === 'HELP' || key === 'H') { bools.help = true; continue; }
    if (!KNOWN_KEYS.includes(key)) throw new ConfigError(`Unknown flag: --${name}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new ConfigError(`Missing value for --${name}`);
    }
    vals[key] = value;
  }
  const cfg: Config = {
    rpcUrls: [], pollSeconds: 60, heartbeatHours: 24, stateFile: './chronobox-watch-state.json',
    failPolls: 3, logChunk: 2000, maxScanBlocks: 50000, stateDir: './chronobox-watch-state', networks: [], telegramApi: 'https://api.telegram.org', rpcServiceHost: 'rpc.zodiac.eco',
    resendApi: 'https://api.resend.com', appUrl: APP_URL, port: 8787, bindAddress: '127.0.0.1', trustedProxies: ['127.0.0.1', '::1'], ...bools,
  };
  if (bools.help) return cfg;

  const str = (k: string) => { const v = vals[k]?.trim(); return v ? v : undefined; };
  cfg.networks = (str('RPC_URL') ?? '').split(';')
    .map((list) => list.split(',').map((s) => s.trim()).filter(Boolean))
    .filter((list) => list.length > 0);
  if (cfg.networks.length === 0) throw new ConfigError('RPC_URL is required.');
  for (const [i, u] of cfg.networks.flat().entries()) {
    if (!/^https?:\/\//i.test(u)) throw new ConfigError(`RPC_URL entry ${i + 1} must start with http:// or https://.`);
  }
  cfg.rpcUrls = cfg.networks[0];
  cfg.chronobox = str('CHRONOBOX')?.toLowerCase();
  cfg.delay = str('DELAY')?.toLowerCase();
  if (!cfg.all && /^(1|true|yes)$/i.test(str('ALL') ?? '')) cfg.all = true;
  if (!cfg.all && cfg.networks.length > 1) throw new ConfigError('More than one network in RPC_URL (a semicolon) works with --all only.');
  if (!cfg.all && str('TELEGRAM_TOKEN')) throw new ConfigError('TELEGRAM_TOKEN works with --all only.');
  if (!cfg.all && str('RESEND_KEY')) throw new ConfigError('RESEND_KEY works with --all only.');
  if (cfg.all) {
    cfg.telegramToken = str('TELEGRAM_TOKEN');
    // The token is a secret, so the message does not repeat it.
    if (cfg.telegramToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(cfg.telegramToken)) throw new ConfigError('TELEGRAM_TOKEN does not look like a bot token (<number>:<letters>).');
    cfg.resendKey = str('RESEND_KEY');
    // TELEGRAM_KEY is the older name of ALERTS_KEY.
    cfg.alertsKey = str('ALERTS_KEY') ?? str('TELEGRAM_KEY');
    if ((cfg.telegramToken || cfg.resendKey) && (!cfg.alertsKey || cfg.alertsKey.length < 32)) {
      throw new ConfigError(
        'ALERTS_KEY is required with TELEGRAM_TOKEN or RESEND_KEY: a secret of 32 characters or more that encrypts the lists of chats and of email addresses. ' +
        'Make one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"',
      );
    }
    if (cfg.resendKey) {
      cfg.emailFrom = str('EMAIL_FROM');
      if (!cfg.emailFrom || !/@/.test(cfg.emailFrom)) throw new ConfigError('EMAIL_FROM is required with RESEND_KEY: the sender of the emails, for example "Chronobox alerts <alerts@example.org>".');
      cfg.publicUrl = str('PUBLIC_URL')?.replace(/\/+$/, '');
      if (!cfg.publicUrl || !/^https?:\/\/[^/]+$/i.test(cfg.publicUrl)) {
        throw new ConfigError('PUBLIC_URL is required with RESEND_KEY: where this watcher is on the web, with http:// or https:// and no path, for example https://alerts.example.org.');
      }
      cfg.resendApi = str('RESEND_API')?.replace(/\/+$/, '') ?? cfg.resendApi;
      if (!/^https?:\/\//i.test(cfg.resendApi)) throw new ConfigError('RESEND_API must start with http:// or https://.');
    }
    cfg.telegramApi = str('TELEGRAM_API')?.replace(/\/+$/, '') ?? cfg.telegramApi;
    const rawApp = str('APP_URL')?.replace(/\/+$/, '');
    if (rawApp !== undefined) {
      let parsed: URL;
      try { parsed = new URL(rawApp); } catch {
        throw new ConfigError('APP_URL must be where the Chronobox app is, with http:// or https:// and no path, for example https://www.chrono.box.');
      }
      if (!/^https?:$/i.test(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || /[?#]/.test(rawApp)) {
        throw new ConfigError('APP_URL must be where the Chronobox app is, with http:// or https:// and no path, for example https://www.chrono.box.');
      }
      cfg.appUrl = parsed.origin;
    }
    if (!/^https?:\/\//i.test(cfg.telegramApi)) throw new ConfigError('TELEGRAM_API must start with http:// or https://.');
    for (const k of ['CHRONOBOX', 'DELAY', 'STATE_FILE']) {
      if (str(k)) throw new ConfigError(`${k} does not work with --all. --all watches every Chronobox and uses STATE_DIR.`);
    }
    cfg.stateDir = str('STATE_DIR') ?? cfg.stateDir;
  } else if (!cfg.chronobox && !cfg.delay) {
    throw new ConfigError('Set CHRONOBOX (the vault address) or DELAY, or use --all.');
  }
  if (cfg.chronobox && !ADDRESS_RE.test(cfg.chronobox)) throw new ConfigError('CHRONOBOX is not a valid address.');
  if (cfg.delay && !ADDRESS_RE.test(cfg.delay)) throw new ConfigError('DELAY is not a valid address.');
  cfg.webhookUrl = str('WEBHOOK_URL');
  if (cfg.webhookUrl && !/^https?:\/\//i.test(cfg.webhookUrl)) throw new ConfigError('WEBHOOK_URL must start with http:// or https://.');
  if (!cfg.webhookUrl && !cfg.telegramToken && !cfg.resendKey && !cfg.dryRun) {
    throw new ConfigError(`Set ${cfg.all ? 'TELEGRAM_TOKEN, RESEND_KEY and/or WEBHOOK_URL' : 'WEBHOOK_URL'}, or use --dry-run.`);
  }
  const num = (k: string, def: number, min: number, integer: boolean) => {
    const v = str(k);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
      throw new ConfigError(`${k} must be a number >= ${min}${integer ? ' (whole number)' : ''}.`);
    }
    return n;
  };
  cfg.pollSeconds = num('POLL_SECONDS', 60, 1, false);
  cfg.heartbeatHours = num('HEARTBEAT_HOURS', 24, 0, false);
  cfg.failPolls = num('FAIL_POLLS', 3, 1, true);
  cfg.logChunk = num('LOG_CHUNK', 2000, 1, true);
  cfg.port = num('PORT', 8787, 0, true);
  cfg.bindAddress = str('BIND_ADDRESS') ?? cfg.bindAddress;
  const proxies = str('TRUSTED_PROXIES');
  if (proxies !== undefined) {
    cfg.trustedProxies = proxies.split(',').map((s) => s.trim()).filter(Boolean);
    const bad = cfg.trustedProxies.find((ip) => !isIP(ip));
    if (bad) throw new ConfigError(`TRUSTED_PROXIES must be IP addresses with commas between them. "${bad}" is not one.`);
  }
  cfg.stateFile = str('STATE_FILE') ?? cfg.stateFile;
  if (cfg.all && str('START_BLOCK') !== undefined) cfg.startBlock = num('START_BLOCK', 0, 0, true);
  cfg.maxScanBlocks = num('MAX_SCAN_BLOCKS', 50000, 0, true);
  cfg.rpcServiceKey = str('RPC_SERVICE_KEY');
  cfg.rpcServiceHost = str('RPC_SERVICE_HOST')?.toLowerCase() ?? cfg.rpcServiceHost;
  // The key is a secret, so no message repeats it.
  if (cfg.rpcServiceKey && cfg.rpcServiceKey.length < 32) throw new ConfigError('RPC_SERVICE_KEY is too short to be the service key of the RPC (32 characters or more).');
  if (cfg.rpcServiceKey && !cfg.networks.flat().some((u) => { try { const h = new URL(u); return h.host === cfg.rpcServiceHost || h.hostname === cfg.rpcServiceHost; } catch { return false; } })) {
    throw new ConfigError(`RPC_SERVICE_KEY is set, but no RPC_URL is on ${cfg.rpcServiceHost} (RPC_SERVICE_HOST). The key goes to that host only.`);
  }
  return cfg;
}

const KNOWN_KEYS = [
  'RPC_URL', 'CHRONOBOX', 'DELAY', 'WEBHOOK_URL', 'POLL_SECONDS',
  'HEARTBEAT_HOURS', 'STATE_FILE', 'FAIL_POLLS', 'LOG_CHUNK', 'STATE_DIR', 'START_BLOCK', 'MAX_SCAN_BLOCKS',
  'TELEGRAM_TOKEN', 'TELEGRAM_API', 'TELEGRAM_KEY', 'ALERTS_KEY', 'RESEND_KEY', 'RESEND_API', 'EMAIL_FROM', 'PUBLIC_URL', 'APP_URL', 'PORT', 'BIND_ADDRESS', 'TRUSTED_PROXIES',
  'RPC_SERVICE_KEY', 'RPC_SERVICE_HOST',
];
