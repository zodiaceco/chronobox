// The alert service on Vercel: every Chronobox on each network, with the Telegram bot. No process stays on.
//
//   poll      Vercel Cron calls it every minute. It reads every network once (in parallel), sends the alerts,
//             and makes sure that Telegram sends new messages to the webhook.
//   telegram  Telegram calls it with each message that somebody sends to the bot.
//   health    When the last poll ran. For an uptime monitor: it answers 503 when the polls stopped.
//
// State in Upstash Redis. A poll and a question of the bot can run at the same time, in different
// places: they take the lock of the network (AllWatcher) and of the list of chats (Telegram).
//
// The handlers take and give plain objects, so that tests call them without a server. vercel.ts turns
// them into Vercel functions.
import * as crypto from 'node:crypto';
import { AllWatcher } from './all.ts';
import { type Config, parseConfig } from './config.ts';
import { DEFAULT_POLL_BUDGET_SECONDS, LOCK_TTL_MS } from './limits.ts';
import { RedisStore } from './redis.ts';
import { BusyError, type Store } from './store.ts';
import { Telegram } from './telegram.ts';
import { ConfigError, type FetchFn, type Log, defaultLog, errText } from './util.ts';

export type Env = Record<string, string | undefined>;
export type Request = { method: string; headers: Record<string, string | undefined>; body: string };
export type Reply = { status: number; body: unknown };
export type Deps = { fetch?: FetchFn; log?: Log };

/** Settings that the service passes on to the watcher. RPC_URL and START_BLOCK are per network. */
const PASSED = [
  'WEBHOOK_URL', 'HEARTBEAT_HOURS', 'FAIL_POLLS', 'LOG_CHUNK', 'MAX_SCAN_BLOCKS', 'TELEGRAM_TOKEN', 'TELEGRAM_KEY', 'TELEGRAM_API',
  'RPC_SERVICE_KEY', 'RPC_SERVICE_HOST',
];

/** Where the chain id goes in RPC_URL. The RPC of Zodiac takes it as the path. */
const CHAIN_ID = '{chainId}';
const ZODIAC_RPC = `https://rpc.zodiac.eco/${CHAIN_ID}`;
const ZODIAC_PUBLIC_RPC = `https://public-rpc.zodiac.eco/${CHAIN_ID}`;

export type ServiceConfig = {
  /** The settings that all networks share. */
  base: Config;
  networks: { chainId: number; cfg: Config }[];
  redis: { url: string; token: string; prefix: string };
  cronSecret: string;
  /** Where Telegram sends the messages to the bot. */
  webhookUrl?: string;
  /** After this many seconds, a poll reads no further vault. Keep it well below the maxDuration of the function. */
  pollBudgetSeconds: number;
  /** /api/health answers 503 when the last poll is older than this. */
  healthMaxAgeSeconds: number;
};

export function serviceConfig(env: Env): ServiceConfig {
  const str = (k: string) => { const v = env[k]?.trim(); return v ? v : undefined; };
  const list = str('CHAINS');
  if (!list) throw new ConfigError('Set CHAINS to the chain ids to watch, for example CHAINS=1,100,8453,42161.');
  const ids = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d{1,12}$/.test(id))) throw new ConfigError('CHAINS must be chain ids with commas between them, for example 1,100,8453.');
  const chainIds = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  for (const k of Object.keys(env)) {
    const id = /^RPC_URL_(\d+)$/.exec(k)?.[1];
    if (id !== undefined && str(k) && !chainIds.includes(Number(id))) throw new ConfigError(`${k} is set, but ${id} is not in CHAINS.`);
  }
  // One template for every chain, or the RPC of Zodiac. RPC_URL_<chain id> is for a provider with a host per chain.
  const template = str('RPC_URL') ?? (str('RPC_SERVICE_KEY') ? `${ZODIAC_RPC},${ZODIAC_PUBLIC_RPC}` : ZODIAC_PUBLIC_RPC);
  if (!template.includes(CHAIN_ID)) throw new ConfigError(`RPC_URL must have ${CHAIN_ID} in it, where the chain id goes, for example ${ZODIAC_PUBLIC_RPC}.`);
  const rpcOf = (id: number) => str(`RPC_URL_${id}`) ?? template.split(CHAIN_ID).join(String(id));
  if (!str('TELEGRAM_TOKEN') && !str('WEBHOOK_URL')) throw new ConfigError('Set TELEGRAM_TOKEN and TELEGRAM_KEY for the bot, WEBHOOK_URL, or both: the alerts must go somewhere.');
  const passed: Env = {};
  for (const k of PASSED) passed[k] = env[k];
  const base = parseConfig(['--all'], { ...passed, RPC_URL: chainIds.map(rpcOf).join(';') });
  const networks = chainIds.map((chainId, i) => {
    const start = str(`START_BLOCK_${chainId}`);
    const cfg: Config = { ...base, rpcUrls: base.networks[i], chainId };
    if (start !== undefined) {
      if (!/^\d+$/.test(start)) throw new ConfigError(`START_BLOCK_${chainId} must be a whole number.`);
      cfg.startBlock = Number(start);
    }
    return { chainId, cfg };
  });

  const url = str('UPSTASH_REDIS_REST_URL') ?? str('KV_REST_API_URL');
  const token = str('UPSTASH_REDIS_REST_TOKEN') ?? str('KV_REST_API_TOKEN');
  if (!url || !token) throw new ConfigError('Connect an Upstash Redis database: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN).');
  if (!/^https?:\/\//i.test(url)) throw new ConfigError('UPSTASH_REDIS_REST_URL must start with https://.');

  const cronSecret = str('CRON_SECRET');
  if (!cronSecret || cronSecret.length < 16) throw new ConfigError('CRON_SECRET must be a secret of 16 characters or more. Vercel Cron sends it with each call.');

  // The address of this deployment that does not change: the production domain.
  const host = str('PUBLIC_URL') ?? (str('VERCEL_PROJECT_PRODUCTION_URL') ? `https://${str('VERCEL_PROJECT_PRODUCTION_URL')}` : undefined);
  if (host && !/^https:\/\//i.test(host) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(host)) throw new ConfigError('PUBLIC_URL must start with https://.');
  const num = (k: string, def: number) => {
    const v = str(k);
    if (v === undefined) return def;
    if (!/^\d+$/.test(v) || Number(v) < 1) throw new ConfigError(`${k} must be a whole number of 1 or more.`);
    return Number(v);
  };
  return {
    base,
    networks,
    redis: { url, token, prefix: str('REDIS_PREFIX') ?? 'chronobox:' },
    cronSecret,
    webhookUrl: host ? `${host.replace(/\/+$/, '')}/api/telegram` : undefined,
    pollBudgetSeconds: num('POLL_BUDGET_SECONDS', DEFAULT_POLL_BUDGET_SECONDS),
    healthMaxAgeSeconds: num('HEALTH_MAX_AGE_SECONDS', 300),
  };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

type Setup = { sc: ServiceConfig; store: Store; telegram?: Telegram; log: Log; fetch?: FetchFn };

async function setup(env: Env, deps: Deps): Promise<Setup> {
  const sc = serviceConfig(env);
  const store = new RedisStore({ ...sc.redis, lockTtlMs: LOCK_TTL_MS, fetch: deps.fetch });
  const out = deps.log ?? defaultLog;
  // The secrets of the watcher never reach the log.
  const secrets = [sc.redis.token, sc.cronSecret, sc.base.telegramToken, sc.base.telegramKey, sc.base.rpcServiceKey, sc.base.webhookUrl, ...sc.base.networks.flat()]
    .filter((s): s is string => Boolean(s));
  const log: Log = (m) => out(secrets.reduce((t, s) => t.split(s).join('[secret]'), m));
  const telegram = sc.base.telegramToken ? await Telegram.open(sc.base, { store, fetch: deps.fetch, log }) : undefined;
  return { sc, store, telegram, log, fetch: deps.fetch };
}

function watchers(s: Setup): { chainId: number; w: AllWatcher }[] {
  return s.sc.networks.map(({ chainId, cfg }) => ({
    chainId,
    w: new AllWatcher(cfg, { store: s.store.scope(`${chainId}:`), telegram: s.telegram, fetch: s.fetch, log: (m) => s.log(`chain ${chainId}: ${m}`) }),
  }));
}

function failure(e: unknown, log: Log): Reply {
  if (e instanceof ConfigError) {
    log(`configuration error: ${e.message}`);
    return { status: 500, body: { error: 'configuration', message: e.message } };
  }
  log(`unexpected error: ${errText(e)}`);
  return { status: 500, body: { error: 'unexpected' } };
}

/**
 * Telegram must send the messages of the bot to this deployment. That is set one time, and again when the
 * address, the token or the key changes. A note in the store says what was set last.
 */
async function ensureWebhook(s: Setup): Promise<void> {
  const t = s.telegram;
  if (!t) return;
  const url = s.sc.webhookUrl;
  if (!url) { s.log('telegram: the address of this deployment is not known (PUBLIC_URL), so the bot gets no messages'); return; }
  const note = crypto.createHash('sha256').update(`${url}\n${t.webhookSecret()}\n${s.sc.base.telegramToken}`).digest('base64url');
  if ((await s.store.get('telegram-webhook')) === note) return;
  try {
    await t.start();
    await t.setWebhook(url);
    await s.store.set('telegram-webhook', note);
    s.log(`telegram: the bot @${t.username} gets its messages at ${url}`);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    s.log(`telegram: could not set the webhook, tried again on the next poll: ${errText(e)}`);
  }
}

export type NetworkResult = {
  chainId: number;
  /** The chain could be read. */
  ok: boolean;
  skipped?: true;
  error?: string;
  /** Vaults that were due and were not read, for lack of time, and how long the oldest of them waits. */
  late?: number;
  overdueSeconds?: number;
  /** New Delays that still wait to be checked. */
  queued?: number;
  /** Vaults that could not be read while the chain could. A problem of those vaults; their readers are told. */
  failing?: number;
};

/** Vercel Cron, every minute. */
export async function poll(env: Env, req: Request, deps: Deps = {}): Promise<Reply> {
  const started = Date.now();
  const log = deps.log ?? defaultLog;
  let s: Setup;
  try {
    // Before anything else: only Vercel Cron may start a poll.
    const secret = env.CRON_SECRET?.trim() ?? '';
    if (!secret || !same(req.headers.authorization ?? '', `Bearer ${secret}`)) return { status: 401, body: { error: 'unauthorized' } };
    s = await setup(env, deps);
    await ensureWebhook(s);
  } catch (e) {
    return failure(e, log);
  }
  const deadline = started + s.sc.pollBudgetSeconds * 1000;
  const results: NetworkResult[] = await Promise.all(watchers(s).map(async ({ chainId, w }) => {
    try {
      const ok = await w.poll({ deadline });
      const { late, overdueSeconds, queued, failing } = w.report;
      return { chainId, ok, ...(late ? { late, overdueSeconds } : {}), ...(queued ? { queued } : {}), ...(failing ? { failing } : {}) };
    } catch (e) {
      // The poll before this one still runs. It does this work.
      if (e instanceof BusyError) return { chainId, ok: true, skipped: true as const };
      s.log(`chain ${chainId}: ${e instanceof ConfigError ? 'configuration error: ' : 'unexpected error: '}${errText(e)}`);
      return { chainId, ok: false, error: e instanceof ConfigError ? e.message : 'unexpected' };
    }
  }));
  const body = { at: new Date().toISOString(), ms: Date.now() - started, networks: results };
  await s.store.set('last-poll', JSON.stringify(body)).catch((e) => s.log(`could not note the poll: ${errText(e)}`));
  return { status: results.some((r) => r.error) ? 500 : 200, body };
}

/** Telegram, with each message to the bot. */
export async function telegramWebhook(env: Env, req: Request, deps: Deps = {}): Promise<Reply> {
  const log = deps.log ?? defaultLog;
  let s: Setup;
  try {
    s = await setup(env, deps);
  } catch (e) {
    return failure(e, log);
  }
  const t = s.telegram;
  if (!t) return { status: 404, body: { error: 'no bot' } };
  if (req.method !== 'POST' || !t.isFromTelegram(req.headers['x-telegram-bot-api-secret-token'])) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  let update: any;
  try { update = JSON.parse(req.body); } catch { return { status: 200, body: { ignored: 'not JSON' } }; }
  // Telegram sends an update again when the answer was slow. It is answered one time.
  if (typeof update?.update_id === 'number' && !(await s.store.claim(`telegram-update:${update.update_id}`, 86400))) {
    return { status: 200, body: { duplicate: true } };
  }
  try {
    // The bot learns the networks from the watchers that have read their chain.
    await Promise.all(watchers(s).map(({ w }) => w.load()));
    await t.handleUpdate(update);
  } catch (e) {
    // Every message is answered one time, also when the answer failed. The person can send it again.
    if (e instanceof ConfigError) return failure(e, s.log);
    s.log(`telegram: could not answer a message: ${errText(e)}`);
  }
  return { status: 200, body: { ok: true } };
}

/** For an uptime monitor. It says only when the last poll ran and how it went: no address, no chat. */
export async function health(env: Env, _req: Request, deps: Deps = {}): Promise<Reply> {
  const log = deps.log ?? defaultLog;
  let sc: ServiceConfig;
  let last: any = null;
  try {
    sc = serviceConfig(env);
    const store = new RedisStore({ ...sc.redis, fetch: deps.fetch });
    const text = await store.get('last-poll');
    last = text ? JSON.parse(text) : null;
  } catch (e) {
    return failure(e, log);
  }
  const age = last?.at ? Math.round((Date.now() - Date.parse(last.at)) / 1000) : null;
  const fresh = age !== null && age <= sc.healthMaxAgeSeconds;
  // A network is behind when a vault waits to be read for longer than a poll may be missing.
  const behind = (n: NetworkResult) => (n.overdueSeconds ?? 0) > sc.healthMaxAgeSeconds;
  const healthy = fresh && Array.isArray(last.networks) && last.networks.every((n: NetworkResult) => n.ok && !behind(n));
  const networks = Array.isArray(last?.networks)
    ? last.networks.map((n: NetworkResult) => ({ chainId: n.chainId, ok: n.ok, ...(n.late ? { late: n.late, overdueSeconds: n.overdueSeconds } : {}) }))
    : [];
  return { status: healthy ? 200 : 503, body: { healthy, lastPoll: last?.at ?? null, ageSeconds: age, networks } };
}
