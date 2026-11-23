// Zodiac Chronobox watcher. One file, no dependencies.
// Run: node watch.ts --help   (Node 22.18+; TypeScript by type stripping)
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Constants (selectors are keccak256 prefixes, computed offline and pinned)

const SENTINEL = '0x0000000000000000000000000000000000000001';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const TOPIC_TRANSACTION_ADDED = '0x4c8a9c748e976c17c2eb2c2bc50da76eac9cd90ff529f0fe900e0c10a179f031';
export const TOPIC_TX_NONCE_SET = '0xb80aa44b2e3f25cf4fbdf2a6c561d9a3d961528ccfc2097da3741fdf941d6d13'; // TxNonceSet(uint256)
// SafeModuleTransaction(address module, address to, uint256 value, bytes data, uint8 operation), from a SafeL2.
// The Delay 1.0.1 that Chronobox pins has no TxNonceSet event, so a cancel is read from the vault: it shows
// every call a module made, and a cancel is the call setTxNonce on the Delay.
export const TOPIC_SAFE_MODULE_TRANSACTION = '0xb648d3644f584ed1c2232d53c46d87e693586486ad0d1175f8656013110b714e';
const SET_TX_NONCE = '0x46ba2307';
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';
// ModuleProxyCreation(address indexed proxy, address indexed masterCopy), from the Zodiac ModuleProxyFactory.
export const TOPIC_MODULE_PROXY_CREATION = '0x2150ada912bf189ed721c44211199e270903fc88008c2a1e1e889ef30fe67c5f';
export const MODULE_PROXY_FACTORY = '0x000000000000addb49795b0f9ba5bc298cdda236';

// Both modules are EIP-1167 minimal proxies; the master copy tells them apart.
export const MASTER_COPY = {
  delay: '0xd54895b1121a2ee3f37b502f507631fa1331bed6',
  roles: '0xf2964ce6161ce0e75964fe7927ce114cb0b283d5', // Roles modifier 2.1.1 (2.1.0 is on Zodiac's list of faulty contracts)
} as const;
export const proxyCode = (masterCopy: string) =>
  '0x363d3d373d3d3d363d73' + masterCopy.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';

export const SEL = {
  txCooldown: '0xdcafac09',
  txExpiration: '0x605df59c',
  txNonce: '0xc66323e5',
  queueNonce: '0xde8dd91d',
  getTxCreatedAt: '0x3aa76906',
  getTxHash: '0x6b0a4cf6',
  owner: '0x8da5cb5b',
  avatar: '0x5aef7de6',
  target: '0xd4b83992',
  getModulesPaginated: '0xcc2f8452',
  getOwners: '0xa0e67e2b',
  transfer: '0xa9059cbb',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
} as const;

// Calls on the Delay modifier that change how the vault is protected.
export const DELAY_FUNCTIONS: Record<string, string> = {
  '0xebb2b4a2': 'setTxCooldown(uint256)',
  '0x9b56d5be': 'setTxExpiration(uint256)',
  '0x46ba2307': 'setTxNonce(uint256)',
  '0x610b5925': 'enableModule(address)',
  '0xe009cfde': 'disableModule(address,address)',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  '0x776d1a01': 'setTarget(address)',
  '0x086cfca8': 'setAvatar(address)',
};

// Calls on the Roles modifier (the cancel module) that every Zodiac modifier has.
export const ROLES_FUNCTIONS: Record<string, string> = {
  '0x610b5925': 'enableModule(address)',
  '0xe009cfde': 'disableModule(address,address)',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  '0x776d1a01': 'setTarget(address)',
  '0x086cfca8': 'setAvatar(address)',
};

// Calls on the Safe (the vault itself).
export const SAFE_FUNCTIONS: Record<string, string> = {
  '0x610b5925': 'enableModule(address)',
  '0xe009cfde': 'disableModule(address,address)',
  '0xe318b52b': 'swapOwner(address,address,address)',
  '0x0d582f13': 'addOwnerWithThreshold(address,uint256)',
  '0xf8dc5dd9': 'removeOwner(address,address,uint256)',
  '0x694e80c3': 'changeThreshold(uint256)',
  '0xe19a9dd9': 'setGuard(address)',
  '0xf08a0323': 'setFallbackHandler(address)',
};

const APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256) on any token

const NATIVE_SYMBOLS: Record<number, string> = {
  1: 'ETH', 10: 'ETH', 8453: 'ETH', 42161: 'ETH', 11155111: 'ETH', 17000: 'ETH', 560048: 'ETH',
  100: 'xDAI', 137: 'POL', 56: 'BNB', 43114: 'AVAX',
};

const NETWORK_NAMES: Record<number, string> = {
  1: 'Ethereum', 10: 'OP Mainnet', 100: 'Gnosis', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum One', 11155111: 'Sepolia',
};
export const networkName = (chainId: number) => NETWORK_NAMES[chainId] ?? `network ${chainId}`;
const FIRST_START_LOOKUP_LIMIT = 50;

// ---------------------------------------------------------------------------
// Types

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
  // --all: one list of RPC URLs per network. `rpcUrls` is the list of the network that a watcher reads.
  networks: string[][];
  // --all: a Telegram bot that sends the alerts of a Chronobox to every chat that asked for them.
  telegramToken?: string;
  telegramApi: string;
  // The secret that encrypts the list of chats on disk. It is not stored with the list.
  telegramKey?: string;
};

export type Settings = {
  cooldown: string;
  expiration: string;
  controllers: string[];
  safeModules: string[];
  owner: string;
  avatar: string;
  target: string;
  // Only set when CHRONOBOX is known. '' / [] when the vault has no Roles modifier (no cancel).
  roles?: string;
  rolesOwner?: string;
  cancellers?: string[];
};

export type Kind = 'withdrawal' | 'transfer_other' | 'delay' | 'handover' | 'guardian_add' | 'guardian_remove' | 'call' | 'unknown';

export type Item = {
  nonce: number;
  createdAt: string;
  block?: number;
  to?: string;
  value?: string;
  data?: string;
  operation?: number;
  kind: Kind;
  summary: string;
  detail: string;
  priority: number;
  sentReady?: boolean;
  sentExpiring?: boolean;
  sentExpired?: boolean;
};

export type Alert = {
  id: string;
  event: string;
  title: string;
  message: string;
  priority: number;
  nonce?: number;
  at: number;
  done: string[];
};

export type State = {
  version: 1;
  chainId?: number;
  delay?: string;
  vault?: string;
  lastBlock?: number;
  txNonce?: number;
  queueNonce?: number;
  settings?: Settings;
  items: Record<string, Item>;
  outbox: Alert[];
  failCount: number;
  problemOpen: boolean;
  problemSince?: number;
  lastHeartbeat?: number;
  seq: number;
};

export class ConfigError extends Error {}
class RevertError extends Error {}

// ---------------------------------------------------------------------------
// Config

const HELP = `Zodiac Chronobox watcher

Watches a Chronobox vault (a Safe whose only exit is a Zodiac Delay, optionally
with a Roles modifier that lets a few addresses cancel) and sends an alert when
a transaction is queued, becomes ready, expires soon, is cancelled, leaves the
queue, or when the vault settings change. Needs only public data, no keys.

Usage: node watch.ts [flags]          watch one vault
       node watch.ts --all [flags]    watch every Chronobox on the chain

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

With --all (instead of CHRONOBOX, DELAY and STATE_FILE):
  STATE_DIR        --state-dir        folder for the state files (default ./chronobox-watch-state)
  START_BLOCK      --start-block      first block to search for Chronoboxes (default: the newest block at the first start)
  TELEGRAM_TOKEN   --telegram-token   token of a Telegram bot. A person opens https://t.me/<bot>?start=<chain id>-<vault address>
                                      and presses Start. From then on the bot sends the alerts of that Chronobox to that chat.
  TELEGRAM_KEY     --telegram-key     a secret of 32 characters or more. It encrypts the list of chats in STATE_DIR.
                                      Required with TELEGRAM_TOKEN. Keep it away from STATE_DIR and its backups.

Flags:
  --all       watch every Chronobox on the chain; the alerts of a vault go to the Telegram chats that follow it
  --once      poll one time and exit (for cron); exit code 1 if the chain could not be read
  --dry-run   print alerts instead of sending them; the state file is not written
  --help      show this text

Exit codes: 0 ok, 1 chain read failed (--once only), 2 configuration error.
`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
    failPolls: 3, logChunk: 2000, stateDir: './chronobox-watch-state', networks: [], telegramApi: 'https://api.telegram.org', ...bools,
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
  if (cfg.all) {
    cfg.telegramToken = str('TELEGRAM_TOKEN');
    // The token is a secret, so the message does not repeat it.
    if (cfg.telegramToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(cfg.telegramToken)) throw new ConfigError('TELEGRAM_TOKEN does not look like a bot token (<number>:<letters>).');
    cfg.telegramKey = str('TELEGRAM_KEY');
    if (cfg.telegramToken && (!cfg.telegramKey || cfg.telegramKey.length < 32)) {
      throw new ConfigError(
        'TELEGRAM_KEY is required with TELEGRAM_TOKEN: a secret of 32 characters or more that encrypts the list of chats. ' +
        'Make one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"',
      );
    }
    cfg.telegramApi = str('TELEGRAM_API')?.replace(/\/+$/, '') ?? cfg.telegramApi;
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
  if (!cfg.webhookUrl && !cfg.telegramToken && !cfg.dryRun) {
    throw new ConfigError(`Set ${cfg.all ? 'TELEGRAM_TOKEN and/or WEBHOOK_URL' : 'WEBHOOK_URL'}, or use --dry-run.`);
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
  cfg.stateFile = str('STATE_FILE') ?? cfg.stateFile;
  if (cfg.all && str('START_BLOCK') !== undefined) cfg.startBlock = num('START_BLOCK', 0, 0, true);
  return cfg;
}

const KNOWN_KEYS = [
  'RPC_URL', 'CHRONOBOX', 'DELAY', 'WEBHOOK_URL', 'POLL_SECONDS',
  'HEARTBEAT_HOURS', 'STATE_FILE', 'FAIL_POLLS', 'LOG_CHUNK', 'STATE_DIR', 'START_BLOCK',
  'TELEGRAM_TOKEN', 'TELEGRAM_API', 'TELEGRAM_KEY',
];

// ---------------------------------------------------------------------------
// Formatting

export function fmtTime(sec: bigint | number): string {
  const s = BigInt(sec);
  if (s > 8_000_000_000_000n) return 'never (date out of range)';
  return new Date(Number(s) * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A time as a person reads it: "21 Nov 2026, 20:34 UTC". The watcher does not know where the reader lives. */
export function fmtWhen(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return String(sec);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export function fmtDuration(sec: bigint | number): string {
  let s = BigInt(sec);
  if (s <= 0n) return '0 seconds';
  if (s > 3_153_600_000n) return `${s} seconds (more than 100 years)`;
  const units: [string, bigint][] = [['day', 86400n], ['hour', 3600n], ['minute', 60n], ['second', 1n]];
  const parts: string[] = [];
  for (const [name, size] of units) {
    const n = s / size;
    if (n > 0n) { parts.push(`${n} ${name}${n === 1n ? '' : 's'}`); s -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

export function fmtUnits(v: bigint, decimals: number): string {
  if (decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------------------
// ABI helpers

const hex = (n: number | bigint) => '0x' + n.toString(16);
const strip = (h: string) => (h.startsWith('0x') ? h.slice(2) : h);
export const encUint = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
export const encAddr = (a: string) => strip(a).toLowerCase().padStart(64, '0');
const word = (data: string, i: number) => strip(data).slice(i * 64, (i + 1) * 64);
const wordAtByte = (data: string, byte: number) => strip(data).slice(byte * 2, byte * 2 + 64);
const toBig = (w: string) => (w ? BigInt('0x' + w) : 0n);
const toAddr = (w: string) => '0x' + w.slice(-40).toLowerCase();

export function decodeAddressArray(ret: string): { array: string[]; next: string } {
  const off = Number(toBig(word(ret, 0)));
  const next = toAddr(word(ret, 1));
  const len = Number(toBig(wordAtByte(ret, off)));
  const array: string[] = [];
  // The watcher asks for 100 at most. A longer list is not the answer of a Safe.
  if (!(len <= 100)) return { array, next: ZERO_ADDRESS };
  for (let i = 0; i < len; i++) array.push(toAddr(wordAtByte(ret, off + 32 + i * 32)));
  return { array, next };
}

/** A returned address[] (for example Safe.getOwners). */
export function decodeAddresses(ret: string): string[] {
  const off = Number(toBig(word(ret, 0)));
  const len = Number(toBig(wordAtByte(ret, off)));
  const out: string[] = [];
  if (!(len <= 1000)) return out;
  for (let i = 0; i < len; i++) out.push(toAddr(wordAtByte(ret, off + 32 + i * 32)));
  return out;
}

/** The new nonce if this SafeModuleTransaction log is the call setTxNonce on the Delay, else null. */
export function decodeCancel(log: { data: string }, delay: string): number | null {
  const d = log.data;
  if (toAddr(word(d, 1)) !== delay) return null;
  const off = Number(toBig(word(d, 3)));
  const len = Number(toBig(wordAtByte(d, off)));
  const data = '0x' + strip(d).slice((off + 32) * 2, (off + 32 + len) * 2);
  if (len !== 36 || !data.toLowerCase().startsWith(SET_TX_NONCE)) return null;
  return Number(toBig(data.slice(10)));
}

export function decodeTransactionAdded(log: { topics: string[]; data: string; blockNumber: string }) {
  const d = log.data;
  const nonce = Number(BigInt(log.topics[1]));
  const to = toAddr(word(d, 0));
  const value = toBig(word(d, 1));
  const off = Number(toBig(word(d, 2)));
  const operation = Number(toBig(word(d, 3)));
  const len = Number(toBig(wordAtByte(d, off)));
  const data = '0x' + strip(d).slice((off + 32) * 2, (off + 32 + len) * 2);
  return { nonce, txHash: log.topics[2], to, value, data, operation, block: Number(BigInt(log.blockNumber)) };
}

function decodeAbiString(ret: string): string {
  const r = strip(ret);
  if (r.length === 64) {
    // bytes32 symbol (older tokens)
    return utf8(r).replace(/\0+$/, '');
  }
  const off = Number(toBig(r.slice(0, 64)));
  const len = Number(toBig(wordAtByte(r, off)));
  return utf8(r.slice((off + 32) * 2, (off + 32 + len) * 2));
}

function utf8(h: string): string {
  const bytes = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

function cleanSymbol(s: string): string {
  return /^[A-Za-z0-9.$_+-]{1,16}$/.test(s) ? s : 'tokens';
}

// ---------------------------------------------------------------------------
// Queue item status and description

export type Status = { status: 'waiting' | 'ready' | 'expired'; readyAt: bigint; expiresAt: bigint | null };

export function itemStatus(createdAt: bigint, cooldown: bigint, expiration: bigint, now: bigint): Status {
  const readyAt = createdAt + cooldown;
  const expiresAt = expiration === 0n ? null : readyAt + expiration;
  if (now < readyAt) return { status: 'waiting', readyAt, expiresAt };
  if (expiresAt !== null && now > expiresAt) return { status: 'expired', readyAt, expiresAt };
  return { status: 'ready', readyAt, expiresAt };
}

export function expiryLead(expiration: bigint): bigint {
  return expiration < 172800n ? expiration / 2n : 86400n;
}

/** A TxNonceSet log: the new nonce, where it happened, and txNonce one block before (null if the RPC has no such old state). */
export type NonceSet = { nonce: number; block: number; ts: bigint; before: number | null };

export type CloseReason =
  | { how: 'cancelled'; block: number; ts: bigint }
  | { how: 'executed_or_cancelled'; block: number }
  | { how: 'executed' | 'expired' | 'executed_or_expired' };

/**
 * Why a queue item that was pending at the last poll is gone now.
 * An execution and skipExpired emit no Delay event. A cancel (setTxNonce) is read from the vault's module calls,
 * and from TxNonceSet on a Delay that has that event.
 */
export function closeReason(
  nonce: number, createdAt: bigint, sets: NonceSet[], cooldown: bigint, expiration: bigint, lastTs: bigint, now: bigint,
): CloseReason {
  const set = sets.find((l) => nonce < l.nonce);
  if (set && (set.before === null || nonce >= set.before)) {
    // Without the old txNonce, only an item that could not execute at that time is surely cancelled.
    if (set.before === null && itemStatus(createdAt, cooldown, expiration, set.ts).status === 'ready') {
      return { how: 'executed_or_cancelled', block: set.block };
    }
    return { how: 'cancelled', block: set.block, ts: set.ts };
  }
  if (itemStatus(createdAt, cooldown, expiration, lastTs).status === 'expired') return { how: 'expired' };
  if (itemStatus(createdAt, cooldown, expiration, now).status === 'expired') return { how: 'executed_or_expired' };
  return { how: 'executed' };
}

type TokenMeta = { symbol: string; decimals: number } | null;
type DescribeCtx = {
  chainId: number;
  delay: string;
  vault: string;
  controllers: string[];
  roles?: string;
  /** The delay of the vault now, in seconds. */
  cooldown?: bigint;
  tokenMeta?: TokenMeta;
};

function argsText(sig: string, data: string): string {
  const types = sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean);
  const body = strip(data).slice(8);
  const out: string[] = [];
  types.forEach((t, i) => {
    const w = body.slice(i * 64, (i + 1) * 64);
    if (w.length < 64) return;
    if (t === 'address') out.push(toAddr(w));
    else out.push(toBig(w).toString());
  });
  return out.join(', ');
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// The contract that the Chronobox app uses to make several changes in one step, and what the app puts in it.
const MULTI_SEND = '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526';
const MULTI_SEND_SELECTOR = '8d80ff0a'; // multiSend(bytes)
const ENABLE_MODULE = '0x610b5925';
const DISABLE_MODULE = '0xe009cfde';
const SET_TX_COOLDOWN = '0xebb2b4a2';
const ASSIGN_ROLES = '0x957ed2b3'; // assignRoles(address,bytes32[],bool[])
const CANCEL_ROLE = '63616e63656c'.padEnd(64, '0'); // bytes32("cancel")

/** The calls of a MultiSend batch. Null when the transaction is not a batch of plain calls that send no coin. */
export function batchCalls(tx: { to: string; value: bigint; data: string; operation: number }): { to: string; data: string }[] | null {
  if (tx.operation !== 1 || tx.to.toLowerCase() !== MULTI_SEND || tx.value !== 0n) return null;
  const d = strip(tx.data.toLowerCase());
  if (d.slice(0, 8) !== MULTI_SEND_SELECTOR) return null;
  const body = d.slice(8);
  const off = Number(toBig(body.slice(0, 64))) * 2;
  const len = Number(toBig(body.slice(off, off + 64)));
  if (!(len > 0 && len <= 100000)) return null;
  const bytes = body.slice(off + 64, off + 64 + len * 2);
  if (bytes.length !== len * 2) return null;
  const calls: { to: string; data: string }[] = [];
  for (let at = 0; at < bytes.length; ) {
    if (bytes.length - at < 170 || calls.length >= 50) return null;
    const length = Number(toBig(bytes.slice(at + 106, at + 170)));
    // Each item: operation (1 byte, 0 = call), to (20), value (32), length (32), data.
    if (bytes.slice(at, at + 2) !== '00' || toBig(bytes.slice(at + 42, at + 106)) !== 0n) return null;
    if (!(length <= 100000) || bytes.length < at + 170 + length * 2) return null;
    calls.push({ to: '0x' + bytes.slice(at + 2, at + 42), data: '0x' + bytes.slice(at + 170, at + 170 + length * 2) });
    at += 170 + length * 2;
  }
  return calls;
}

/** assignRoles(module, roleKeys, memberOf): who gets or loses which role. */
function decodeAssign(data: string): { module: string; grants: { key: string; on: boolean }[] } | null {
  const b = strip(data).slice(8);
  const keysAt = Number(toBig(b.slice(64, 128))) * 2;
  const boolsAt = Number(toBig(b.slice(128, 192))) * 2;
  const n = Number(toBig(b.slice(keysAt, keysAt + 64)));
  if (!(n >= 1 && n <= 10) || Number(toBig(b.slice(boolsAt, boolsAt + 64))) !== n) return null;
  const grants: { key: string; on: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const key = b.slice(keysAt + 64 + i * 64, keysAt + 128 + i * 64);
    const on = b.slice(boolsAt + 64 + i * 64, boolsAt + 128 + i * 64);
    if (key.length !== 64 || on.length !== 64) return null;
    grants.push({ key, on: toBig(on) !== 0n });
  }
  return { module: toAddr(b.slice(0, 64)), grants };
}

// A change that is read from its shape, not proved. The app checks it byte for byte.
const LOOKS = 'Open your Chronobox to check that the request is what it looks like.';
const NOT_THE_APP = 'The Chronobox app does not make such a request.';

/** What a call on a part of the Chronobox does, in one plain sentence. `a`: its first address, `b`: its second. */
function meaning(part: 'delay' | 'vault' | 'roles', fn: string | undefined, a: string, b: string, data: string): string {
  const name = fn ? fn.slice(0, fn.indexOf('(')) : '';
  if (part === 'roles') return 'It changes who can cancel, or what they can do.';
  if (part === 'delay') {
    if (name === 'disableModule') return `It takes this Chronobox away from the wallet ${b}.`;
    if (name === 'setTxExpiration') {
      const v = toBig(strip(data).slice(8, 72));
      return `It changes how long a request stays open after its wait: ${v === 0n ? 'no limit' : fmtDuration(v)}.`;
    }
    if (name === 'setTxNonce') return 'It removes requests that wait.';
    return 'It changes what the delay protects.';
  }
  if (name === 'enableModule') return `It lets ${a} move the money without the wait.`;
  if (name === 'swapOwner' || name === 'addOwnerWithThreshold') return 'It gives the Chronobox an owner who can move the money without the wait.';
  if (name === 'setGuard') return `It lets ${a} block everything that this Chronobox does.`;
  return 'It changes how this Chronobox is built.';
}

/**
 * What a request does, in the words of the Chronobox app. `summary` starts with a verb ("Withdraw 1 ETH"),
 * so that it reads after "Somebody asked this Chronobox to ...". `detail` is one or more whole sentences.
 */
export function describeTx(
  tx: { to: string; value: bigint; data: string; operation: number },
  ctx: DescribeCtx,
): { kind: Kind; summary: string; detail: string; priority: number } {
  const native = NATIVE_SYMBOLS[ctx.chainId] ?? 'native coin';
  const to = tx.to.toLowerCase();
  const data = tx.data.toLowerCase();
  const toController = ctx.controllers.includes(to);
  const selector = data.length >= 10 ? data.slice(0, 10) : '';
  const elsewhere = (recipient: string) => `The money goes to ${recipient}. That is not the wallet of this Chronobox. ${NOT_THE_APP}`;

  if (tx.operation === 0 && data === '0x' && tx.value > 0n) {
    const amount = `${fmtUnits(tx.value, 18)} ${native}`;
    if (toController) {
      return { kind: 'withdrawal', summary: `Withdraw ${amount}`, detail: `The money goes to the wallet of this Chronobox, ${to}.`, priority: 3 };
    }
    return { kind: 'transfer_other', summary: `Send ${amount} to ${shortAddr(to)}`, detail: elsewhere(to), priority: 4 };
  }
  if (tx.operation === 0 && selector === SEL.transfer && strip(data).length === 8 + 128 && tx.value === 0n) {
    const recipient = toAddr(word('0x' + strip(data).slice(8), 0));
    const raw = toBig(word('0x' + strip(data).slice(8), 1));
    const meta = ctx.tokenMeta;
    const amount = meta ? `${fmtUnits(raw, meta.decimals)} ${meta.symbol}` : `${raw} units of the token ${shortAddr(to)}`;
    const token = ` The token is ${to}.`;
    if (ctx.controllers.includes(recipient)) {
      return { kind: 'withdrawal', summary: `Withdraw ${amount}`, detail: `The money goes to the wallet of this Chronobox, ${recipient}.${token}`, priority: 3 };
    }
    return { kind: 'transfer_other', summary: `Send ${amount} to ${shortAddr(recipient)}`, detail: `${elsewhere(recipient)}${token}`, priority: 4 };
  }

  // The delay: one call, and the request says all of it.
  if (tx.operation === 0 && to === ctx.delay && tx.value === 0n && selector === SET_TX_COOLDOWN && strip(data).length === 72) {
    const next = toBig(strip(data).slice(8));
    const now = ctx.cooldown;
    const note = now === undefined || next === now ? ''
      : next < now ? ` It is ${fmtDuration(now)} now. A shorter delay gives you less time to stop a thief.`
      : ` It is ${fmtDuration(now)} now. A longer delay makes every withdrawal wait longer.`;
    if (next === 0n) {
      return { kind: 'delay', summary: 'Remove the delay', detail: 'After this, a withdrawal does not wait at all. A person who has your wallet can take the money at once.', priority: 5 };
    }
    return { kind: 'delay', summary: `Change the delay to ${fmtDuration(next)}`, detail: `After this, every withdrawal waits ${fmtDuration(next)}.${note}`, priority: 5 };
  }

  // A new wallet. Alone, or as the first part of a batch.
  const handover = (next: string, removes: boolean) => ({
    kind: 'handover' as const, summary: `Hand over to ${shortAddr(next)}`, priority: 5,
    detail: `After this, the wallet ${next} holds this Chronobox${removes ? ', and the wallet of today does not' : ' too'}. It can withdraw all the money. ${LOOKS}`,
  });
  if (tx.operation === 0 && to === ctx.delay && tx.value === 0n && selector === ENABLE_MODULE && strip(data).length === 72) {
    return handover(toAddr(strip(data).slice(8)), false);
  }
  const calls = batchCalls(tx);
  if (calls) {
    const onDelay = calls.filter((c) => c.to === ctx.delay);
    const onRoles = ctx.roles ? calls.filter((c) => c.to === ctx.roles) : [];
    const enable = onDelay.find((c) => c.data.startsWith(ENABLE_MODULE) && strip(c.data).length === 72);
    if (enable) {
      const removes = onDelay.some((c) => c.data.startsWith(DISABLE_MODULE) && ctx.controllers.includes(toAddr(strip(c.data).slice(72, 136))));
      return handover(toAddr(strip(enable.data).slice(8)), removes);
    }
    if (onRoles.length === calls.length && calls.length > 0) {
      const assigns = onRoles.filter((c) => c.data.startsWith(ASSIGN_ROLES)).map((c) => decodeAssign(c.data)).filter((a) => a !== null);
      const added = assigns.find((a) => a.grants.some((g) => g.on && g.key === CANCEL_ROLE));
      if (added) {
        return {
          kind: 'guardian_add', summary: `Add the guardian ${shortAddr(added.module)}`, priority: 5,
          detail: `After this, ${added.module} can stop every withdrawal. Together with the wallet of this Chronobox, it can hand the Chronobox to a new wallet at once. ${LOOKS}`,
        };
      }
      const removed = assigns.find((a) => !ctx.controllers.includes(a.module) && a.grants.some((g) => !g.on && g.key === CANCEL_ROLE));
      if (removed) {
        return {
          kind: 'guardian_remove', summary: 'Remove the guardian', priority: 5,
          detail: `After this, ${removed.module} cannot stop a withdrawal any more. Only the wallet of this Chronobox can cancel. ${LOOKS}`,
        };
      }
    }
    const targets = [...new Set(calls.map((c) => c.to))].join(', ');
    return {
      kind: 'call', summary: 'Change this Chronobox in a way that the app does not know', priority: 5,
      detail: `It makes ${calls.length} change${calls.length === 1 ? '' : 's'} in one step. ${NOT_THE_APP} Technical detail: a batch of calls to ${targets}.`,
    };
  }

  // Anything else is a call that the app does not make.
  let part: 'delay' | 'vault' | 'roles' | null = null;
  let where = `the contract ${to}`;
  let fn: string | undefined;
  if (to === ctx.delay) { part = 'delay'; where = `the delay contract ${to}`; fn = DELAY_FUNCTIONS[selector]; }
  else if (to === ctx.vault) { part = 'vault'; where = `the Safe of the Chronobox ${to}`; fn = SAFE_FUNCTIONS[selector]; }
  else if (ctx.roles && to === ctx.roles) { part = 'roles'; where = `the cancel contract ${to}`; fn = ROLES_FUNCTIONS[selector]; }
  const approve = !fn && selector === APPROVE_SELECTOR;
  if (approve) fn = 'approve(address,uint256)';
  const name = fn ? fn.slice(0, fn.indexOf('(')) : selector ? `the function ${selector}` : 'no function';
  const call = fn ? `${name}(${argsText(fn, data)})` : name;
  const a = toAddr(strip(data).slice(8, 72));
  const b = toAddr(strip(data).slice(72, 136));
  const parts: string[] = [];
  let summary: string;
  if (part) {
    summary = 'Change this Chronobox in a way that the app does not know';
    parts.push(meaning(part, fn, a, b, data));
  } else if (approve) {
    summary = `Let ${shortAddr(a)} take tokens`;
    parts.push(`It lets ${a} take the token ${to} out of this Chronobox later, without the wait.`);
  } else {
    summary = 'Do something that the app does not know';
    parts.push(`It uses ${where}.`);
  }
  if (tx.value > 0n) parts.push(`It sends ${fmtUnits(tx.value, 18)} ${native} with it.`);
  if (tx.operation === 1) parts.push('It runs the code of another contract with full control of this Chronobox.');
  parts.push(NOT_THE_APP);
  parts.push(`Technical detail: ${tx.operation === 1 ? 'a delegate call of' : 'a call of'} ${call} on ${where}.`);
  return { kind: 'call', summary, detail: parts.join(' '), priority: 5 };
}

/** One request that waits, as a line: what it is, and where its wait stands. */
export function waitLine(summary: string, st: Status): string {
  const when = st.status === 'waiting' ? `Its wait ends on ${fmtWhen(st.readyAt)}.`
    : st.status === 'ready' ? 'Its wait is over.'
    : 'It was not finished in time and is void.';
  return `${summary}. ${when}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC client with fallbacks

type FetchFn = typeof fetch;

export class Rpc {
  urls: string[];
  idx = 0;
  id = 0;
  timeoutMs: number;
  fetchFn: FetchFn;
  constructor(urls: string[], fetchFn: FetchFn = fetch, timeoutMs = 20000) {
    this.urls = urls;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }
  async call(method: string, params: unknown[] = []): Promise<any> {
    let lastErr = 'no RPC configured';
    for (let i = 0; i < this.urls.length; i++) {
      const k = (this.idx + i) % this.urls.length;
      try {
        const res = await this.fetchFn(this.urls[k], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        if (j.error) {
          const msg = String(j.error.message ?? 'error');
          if (j.error.code === 3 || /revert/i.test(msg)) { this.idx = k; throw new RevertError(msg); }
          throw new Error(`RPC error ${j.error.code}: ${msg}`);
        }
        if (!('result' in j)) throw new Error('response without result');
        this.idx = k;
        return j.result;
      } catch (e) {
        if (e instanceof RevertError) throw e;
        lastErr = `RPC #${k + 1}: ${errText(e)}`;
      }
    }
    throw new Error(`all RPC endpoints failed (${method}); last: ${lastErr}`);
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as any).cause;
    return cause?.code ? `${e.message} (${cause.code})` : e.message;
  }
  return String(e);
}

// ---------------------------------------------------------------------------
// State file

export function emptyState(): State {
  return { version: 1, items: {}, outbox: [], failCount: 0, problemOpen: false, seq: 0 };
}

export function loadState(file: string): State {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) {
    if (e?.code === 'ENOENT') return emptyState();
    throw new ConfigError(`Cannot read STATE_FILE: ${e?.message ?? e}`);
  }
  try {
    const s = JSON.parse(text);
    if (s?.version !== 1 || typeof s.items !== 'object' || !Array.isArray(s.outbox)) throw new Error('unknown format');
    return s as State;
  } catch (e) {
    throw new ConfigError(`STATE_FILE ${file} is not a valid watcher state (${errText(e)}). Fix or remove it; removing it starts over with a "Watching" message.`);
  }
}

export function saveState(file: string, state: State): void {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(state, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Watcher

type Log = (msg: string) => void;

export class Watcher {
  cfg: Config;
  rpc: Rpc;
  state: State;
  log: Log;
  fetchFn: FetchFn;
  private blockTs = new Map<number, bigint>();
  private proxyKinds = new Map<string, 'delay' | 'roles'>();
  private telegram?: Telegram;

  constructor(cfg: Config, opts: { fetch?: FetchFn; log?: Log; telegram?: Telegram } = {}) {
    this.cfg = cfg;
    this.telegram = opts.telegram;
    this.fetchFn = opts.fetch ?? fetch;
    this.rpc = new Rpc(cfg.rpcUrls, this.fetchFn);
    const out = opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
    this.log = (m: string) => out(this.redact(m));
    this.state = loadState(cfg.stateFile);
    const s = this.state;
    if (s.delay && cfg.delay && s.delay !== cfg.delay) {
      throw new ConfigError(`STATE_FILE belongs to Delay ${s.delay}, not ${cfg.delay}. Use another STATE_FILE.`);
    }
    if (s.vault && cfg.chronobox && s.vault !== cfg.chronobox) {
      throw new ConfigError(`STATE_FILE belongs to vault ${s.vault}, not ${cfg.chronobox}. Use another STATE_FILE.`);
    }
  }

  redact(msg: string): string {
    let out = msg;
    const secrets: [string, string][] = [];
    this.cfg.rpcUrls.forEach((u, i) => secrets.push([u, `[RPC #${i + 1}]`]));
    if (this.cfg.webhookUrl) secrets.push([this.cfg.webhookUrl, '[webhook]']);
    if (this.cfg.telegramToken) out = out.split(this.cfg.telegramToken).join('[telegram token]');
    if (this.cfg.telegramKey) out = out.split(this.cfg.telegramKey).join('[telegram key]');
    for (const [secret, label] of secrets) {
      out = out.split(secret).join(label);
      try {
        const u = new URL(secret);
        if (u.pathname.length > 1) out = out.split(u.pathname).join('/[redacted]');
        out = out.split(u.host).join(label);
      } catch { /* not a URL */ }
    }
    return out;
  }

  private call(to: string, data: string, tag: string): Promise<string> {
    return this.rpc.call('eth_call', [{ to, data }, tag]);
  }
  private async callUint(to: string, data: string, tag: string): Promise<bigint> {
    return toBig(word(await this.call(to, data, tag), 0));
  }
  private async callAddr(to: string, data: string, tag: string): Promise<string> {
    return toAddr(word(await this.call(to, data, tag), 0));
  }
  async modules(of: string, tag: string): Promise<string[]> {
    const all: string[] = [];
    let start = SENTINEL;
    for (let page = 0; page < 20; page++) {
      const ret = await this.call(of, SEL.getModulesPaginated + encAddr(start) + encUint(100), tag);
      const { array, next } = decodeAddressArray(ret);
      all.push(...array);
      if (next === SENTINEL || next === ZERO_ADDRESS || array.length === 0) break;
      start = next;
    }
    return all;
  }
  private async timestampOf(n: number): Promise<bigint> {
    const cached = this.blockTs.get(n);
    if (cached !== undefined) return cached;
    const b = await this.rpc.call('eth_getBlockByNumber', [hex(n), false]);
    if (!b) throw new Error(`block ${n} not found`);
    const ts = BigInt(b.timestamp);
    this.blockTs.set(n, ts);
    return ts;
  }

  // First block whose timestamp is >= ts (or > ts when strict).
  private async firstBlockAt(ts: bigint, head: number, strict: boolean, lo = 0): Promise<number> {
    let hi = head + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const t = await this.timestampOf(mid);
      if (strict ? t > ts : t >= ts) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  /** Logs of one contract, or of every contract when no address is given. */
  async getLogs(from: number, to: number, topics: (string | string[] | null)[], address?: string): Promise<any[]> {
    const out: any[] = [];
    let chunk = this.cfg.logChunk;
    let start = from;
    while (start <= to) {
      const end = Math.min(to, start + chunk - 1);
      try {
        const logs = await this.rpc.call('eth_getLogs', [{ address, topics, fromBlock: hex(start), toBlock: hex(end) }]);
        out.push(...logs);
        start = end + 1;
      } catch (e) {
        if (chunk === 1) throw e;
        chunk = Math.max(1, Math.floor(chunk / 2));
        this.log(`eth_getLogs failed for ${end - start + 1} blocks, retrying with ${chunk}`);
      }
    }
    return out;
  }

  private async tokenMeta(token: string, tag: string): Promise<TokenMeta> {
    try {
      const [sym, dec] = await Promise.all([this.call(token, SEL.symbol, tag), this.call(token, SEL.decimals, tag)]);
      const decimals = Number(toBig(word(dec, 0)));
      if (!Number.isInteger(decimals) || decimals > 36) return null;
      return { symbol: cleanSymbol(decodeAbiString(sym)), decimals };
    } catch (e) {
      if (e instanceof RevertError) return null;
      throw e;
    }
  }

  // Find the TransactionAdded log for one nonce through its creation time.
  private async locate(nonce: number, delay: string, head: number, tag: string): Promise<{ createdAt: bigint; log?: any }> {
    const createdAt = await this.callUint(delay, SEL.getTxCreatedAt + encUint(nonce), tag);
    if (createdAt === 0n) return { createdAt };
    const first = await this.firstBlockAt(createdAt, head, false);
    if (first > head || (await this.timestampOf(first)) !== createdAt) return { createdAt };
    let last = first;
    if (first < head && (await this.timestampOf(first + 1)) === createdAt) {
      last = (await this.firstBlockAt(createdAt, head, true, first)) - 1;
    }
    const logs = await this.getLogs(first, last, [TOPIC_TRANSACTION_ADDED, '0x' + encUint(nonce)], delay);
    return { createdAt, log: logs[0] };
  }

  private async buildItem(
    nonce: number, createdAt: bigint, log: any | undefined, ctx: DescribeCtx, tag: string,
  ): Promise<Item> {
    if (!log) {
      return {
        nonce, createdAt: createdAt.toString(), kind: 'unknown', priority: 5,
        summary: 'Do something that the alert service could not read',
        detail: 'Its details were not on the network connection of the alert service. Open your Chronobox to see what it is.',
      };
    }
    const tx = decodeTransactionAdded(log);
    let tokenMeta: TokenMeta = null;
    if (tx.operation === 0 && tx.data.toLowerCase().startsWith(SEL.transfer) && tx.value === 0n) {
      tokenMeta = await this.tokenMeta(tx.to, tag);
    }
    const d = describeTx(tx, { ...ctx, tokenMeta });
    return {
      nonce, createdAt: createdAt.toString(), block: tx.block, to: tx.to, value: tx.value.toString(),
      data: tx.data, operation: tx.operation, ...d,
    };
  }

  /** 'delay' or 'roles' when the address is a minimal proxy of that master copy, else 'other'. */
  private async moduleKind(addr: string, tag: string): Promise<'delay' | 'roles' | 'other'> {
    const cached = this.proxyKinds.get(addr);
    if (cached) return cached;
    const code = String(await this.rpc.call('eth_getCode', [addr, tag])).toLowerCase();
    const kind = code === proxyCode(MASTER_COPY.delay) ? 'delay' : code === proxyCode(MASTER_COPY.roles) ? 'roles' : 'other';
    if (kind !== 'other') this.proxyKinds.set(addr, kind); // proxy code does not change; "other" might be deployed later
    return kind;
  }

  private async resolveDelay(tag: string): Promise<string> {
    if (this.cfg.delay) return this.cfg.delay;
    const vault = this.cfg.chronobox!;
    let mods: string[];
    try {
      mods = await this.modules(vault, tag);
    } catch (e) {
      if (e instanceof RevertError) throw new ConfigError(`CHRONOBOX ${vault} is not a Safe on this chain (getModulesPaginated reverted).`);
      throw e;
    }
    const kinds = await Promise.all(mods.map((m) => this.moduleKind(m, tag)));
    const delays = mods.filter((_, i) => kinds[i] === 'delay');
    const roles = mods.filter((_, i) => kinds[i] === 'roles');
    if ((mods.length === 1 && delays.length === 1) || (mods.length === 2 && delays.length === 1 && roles.length === 1)) {
      return delays[0];
    }
    const label = { delay: 'a Delay', roles: 'a Roles modifier', other: 'not a Delay or Roles modifier' };
    const found = mods.map((m, i) => `${m}: ${label[kinds[i]]}`).join(', ');
    throw new ConfigError(
      `CHRONOBOX ${vault} has ${mods.length} enabled module${mods.length === 1 ? '' : 's'}${mods.length ? ` (${found})` : ''}. ` +
      'A Chronobox has the Delay as its only module, or the Delay and a Roles modifier. Set DELAY to watch a specific Delay.',
    );
  }

  /**
   * The vault of a Delay that is set up as a Chronobox, or null. A Chronobox is a Safe whose only owner is the
   * burn address and whose modules are this Delay, or this Delay and a Roles modifier.
   */
  async chronoboxOf(delay: string, tag: string): Promise<string | null> {
    try {
      if ((await this.moduleKind(delay, tag)) !== 'delay') return null;
      const [avatar, owner, target] = await Promise.all([
        this.callAddr(delay, SEL.avatar, tag), this.callAddr(delay, SEL.owner, tag), this.callAddr(delay, SEL.target, tag),
      ]);
      if (owner !== avatar || target !== avatar) return null;
      const owners = decodeAddresses(await this.call(avatar, SEL.getOwners, tag));
      if (owners.length !== 1 || owners[0] !== BURN_ADDRESS) return null;
      const mods = await this.modules(avatar, tag);
      if (!mods.includes(delay) || mods.length > 2) return null;
      for (const m of mods) {
        if (m !== delay && (await this.moduleKind(m, tag)) !== 'roles') return null;
      }
      return avatar;
    } catch (e) {
      if (e instanceof RevertError) return null;
      throw e;
    }
  }

  /** One poll: read the chain, queue alerts, deliver the outbox, save state. Returns false if the chain could not be read. */
  async poll(): Promise<boolean> {
    let ok = true;
    try {
      await this.observe();
      if (this.state.problemOpen) {
        this.push({
          event: 'watcher_recovered', title: 'Alerts work again', priority: 3,
          message: 'The alert service can read the blockchain again. Alerts for what happened in between follow now.',
          at: Math.floor(Date.now() / 1000),
        });
      }
      this.state.failCount = 0;
      this.state.problemOpen = false;
      this.state.problemSince = undefined;
    } catch (e) {
      if (e instanceof ConfigError) { this.persist(); throw e; }
      ok = false;
      const s = this.state;
      s.failCount++;
      s.problemSince ??= Math.floor(Date.now() / 1000);
      this.log(`poll failed (${s.failCount} in a row): ${errText(e)}`);
      if (s.failCount >= this.cfg.failPolls && !s.problemOpen) {
        s.problemOpen = true;
        this.push({
          event: 'watcher_problem', title: 'Alerts can be late', priority: 4,
          message: `The alert service cannot read the blockchain since ${fmtWhen(s.problemSince)}. Until that works again, alerts can be late or missing. Look at your Chronobox yourself.`,
          at: Math.floor(Date.now() / 1000),
        });
      }
    }
    await this.flush();
    this.persist();
    return ok;
  }

  private persist(): void {
    if (!this.cfg.dryRun) saveState(this.cfg.stateFile, this.state);
  }

  private push(a: Omit<Alert, 'id' | 'done'>): void {
    const s = this.state;
    s.seq++;
    s.outbox.push({ ...a, id: `${s.seq}-${a.event}${a.nonce !== undefined ? '-' + a.nonce : ''}`, done: [] });
  }

  private async observe(): Promise<void> {
    this.blockTs.clear();
    const s = this.state;
    const chainId = Number(await this.rpc.call('eth_chainId'));
    if (s.chainId !== undefined && s.chainId !== chainId) {
      throw new ConfigError(`The RPC is on chain ${chainId}, but this watcher watches chain ${s.chainId}. Check RPC_URL.`);
    }
    const head = Number(await this.rpc.call('eth_blockNumber'));
    const now = await this.timestampOf(head);
    const tag = hex(head);
    const delay = s.delay ?? (await this.resolveDelay(tag));

    const [cooldown, expiration, txNonceB, queueNonceB, owner, avatar, target, controllers] = await Promise.all([
      this.callUint(delay, SEL.txCooldown, tag),
      this.callUint(delay, SEL.txExpiration, tag),
      this.callUint(delay, SEL.txNonce, tag),
      this.callUint(delay, SEL.queueNonce, tag),
      this.callAddr(delay, SEL.owner, tag),
      this.callAddr(delay, SEL.avatar, tag),
      this.callAddr(delay, SEL.target, tag),
      this.modules(delay, tag),
    ]).catch((e) => {
      if (e instanceof RevertError) throw new ConfigError(`${delay} does not look like a Zodiac Delay modifier on chain ${chainId} (a view call reverted).`);
      throw e;
    });
    const vault = this.cfg.chronobox ?? avatar;
    let safeModules: string[] = [];
    try { safeModules = await this.modules(vault, tag); } catch (e) { if (!(e instanceof RevertError)) throw e; }
    const settings: Settings = {
      cooldown: cooldown.toString(), expiration: expiration.toString(), controllers, safeModules, owner, avatar, target,
    };
    // The Roles modifier (cancel) is only looked for when CHRONOBOX is given.
    const rolesKnown = this.cfg.chronobox !== undefined;
    if (rolesKnown) {
      let roles = '';
      for (const m of safeModules) {
        if (m !== delay && (await this.moduleKind(m, tag)) === 'roles') { roles = m; break; }
      }
      const [rolesOwner, cancellers] = roles
        ? await Promise.all([this.callAddr(roles, SEL.owner, tag), this.modules(roles, tag)])
        : ['', []];
      Object.assign(settings, { roles, rolesOwner, cancellers });
    }
    const roles = settings.roles ?? '';
    const txNonce = Number(txNonceB);
    const queueNonce = Number(queueNonceB);
    const ctx: DescribeCtx = { chainId, delay, vault, controllers, roles: roles || undefined, cooldown };
    const first = s.lastBlock === undefined;

    // Read phase: collect new queue items. No state changes until all reads succeed.
    const newItems: Item[] = [];
    if (first) {
      const end = Math.min(queueNonce, txNonce + FIRST_START_LOOKUP_LIMIT);
      for (let n = txNonce; n < queueNonce; n++) {
        if (n < end) {
          const { createdAt, log } = await this.locate(n, delay, head, tag);
          newItems.push(await this.buildItem(n, createdAt, log, ctx, tag));
        } else {
          const createdAt = await this.callUint(delay, SEL.getTxCreatedAt + encUint(n), tag);
          newItems.push(await this.buildItem(n, createdAt, undefined, ctx, tag));
        }
      }
    } else if (queueNonce > (s.queueNonce ?? 0)) {
      const byNonce = new Map<number, any>();
      if (head > s.lastBlock!) {
        const logs = await this.getLogs(s.lastBlock! + 1, head, [TOPIC_TRANSACTION_ADDED], delay);
        for (const l of logs) byNonce.set(Number(BigInt(l.topics[1])), l);
      }
      for (let n = s.queueNonce ?? 0; n < queueNonce; n++) {
        let log = byNonce.get(n);
        let createdAt: bigint;
        if (log) {
          createdAt = await this.callUint(delay, SEL.getTxCreatedAt + encUint(n), tag);
        } else {
          const found = await this.locate(n, delay, head, tag);
          createdAt = found.createdAt;
          log = found.log;
        }
        newItems.push(await this.buildItem(n, createdAt, log, ctx, tag));
      }
    }

    // Items that left the queue since the last poll: cancelled (TxNonceSet) or executed/skipped (no event).
    const closing = [...Object.values(s.items), ...newItems].filter((it) => it.nonce < txNonce);
    const reasons = new Map<number, CloseReason>();
    if (!first && closing.length) {
      const sets: NonceSet[] = [];
      if (head > s.lastBlock!) {
        // A cancel shows as TxNonceSet on a Delay that has the event, and always as a module call in the vault.
        const found = new Map<string, { blockNumber: string; logIndex?: string; nonce: number }>();
        for (const l of await this.getLogs(s.lastBlock! + 1, head, [TOPIC_TX_NONCE_SET], delay)) {
          const nonce = Number(toBig(word(l.data, 0)));
          found.set(`${l.blockNumber}:${nonce}`, { blockNumber: l.blockNumber, logIndex: l.logIndex, nonce });
        }
        for (const l of await this.getLogs(s.lastBlock! + 1, head, [TOPIC_SAFE_MODULE_TRANSACTION], vault)) {
          const nonce = decodeCancel(l, delay);
          if (nonce === null || found.has(`${l.blockNumber}:${nonce}`)) continue;
          found.set(`${l.blockNumber}:${nonce}`, { blockNumber: l.blockNumber, logIndex: l.logIndex, nonce });
        }
        const logs = [...found.values()];
        logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex ?? 0) - BigInt(b.logIndex ?? 0)));
        for (const l of logs) {
          const block = Number(BigInt(l.blockNumber));
          let before: number | null = null;
          try {
            before = Number(await this.callUint(delay, SEL.txNonce, hex(block - 1)));
          } catch (e) {
            this.log(`could not read txNonce at block ${block - 1} (${errText(e)}); cancel detection is less precise`);
          }
          sets.push({ nonce: l.nonce, block, ts: await this.timestampOf(block), before });
        }
      }
      const lastTs = await this.timestampOf(Math.min(s.lastBlock!, head));
      for (const it of closing) {
        reasons.set(it.nonce, closeReason(it.nonce, BigInt(it.createdAt), sets, cooldown, expiration, lastTs, now));
      }
    }

    // Commit phase.
    const times = (it: Item) => itemStatus(BigInt(it.createdAt), cooldown, expiration, now);
    const request = (it: Item) => `the request to ${lowerFirst(it.summary)}`;
    const Request = (it: Item) => `The request to ${lowerFirst(it.summary)}`;
    const others = safeModules.filter((m) => m !== delay && m !== roles);
    // The Safe of the Chronobox owns its cancel contract, and the Safe acts only through the delay. An older Chronobox gave it to the burn address.
    const rolesLoose = Boolean(roles) && settings.rolesOwner !== vault && settings.rolesOwner !== BURN_ADDRESS;

    if (first) {
      s.chainId = chainId;
      s.delay = delay;
      s.vault = vault;
      const lines: string[] = [];
      for (const it of newItems) {
        const st = times(it);
        if (st.status === 'ready') it.sentReady = true;
        if (st.status === 'expired') { it.sentReady = true; it.sentExpiring = true; it.sentExpired = true; }
        if (st.expiresAt !== null && st.status === 'ready' && now >= st.expiresAt - expiryLead(expiration)) it.sentExpiring = true;
        s.items[it.nonce] = it;
        lines.push(waitLine(it.summary, st));
      }
      const worst = Math.max(3, ...newItems.map((i) => i.priority));
      const helpers = (settings.cancellers ?? []).filter((a) => !controllers.includes(a));
      const cancel = !rolesKnown ? ' The watcher does not know who can cancel a request. Set CHRONOBOX to check it.'
        : !roles ? ' This Chronobox cannot cancel a request.'
        : !(settings.cancellers ?? []).length ? ' Nobody can cancel a request right now.'
        : !helpers.length ? ' Only the wallet can cancel a request.'
        : ` The wallet can cancel a request, and so can ${helpers.join(' and ')}. With a guardian, these are the guardian and the Safe that the guardian shares with the wallet.`;
      this.push({
        event: 'watching', title: 'Watching this Chronobox', priority: worst, at: Number(now),
        message:
          `The alert service now watches the Chronobox ${vault} on ${networkName(chainId)}. ` +
          `Every withdrawal waits ${fmtDuration(cooldown)}` +
          `${expiration === 0n ? '' : `, and a request stays open for ${fmtDuration(expiration)} after its wait`}. ` +
          `Wallet: ${controllers.join(', ') || 'none'}.` +
          cancel +
          (rolesLoose ? ` Warning: the address ${settings.rolesOwner} can change who can cancel and what they can do.` : '') +
          (others.length ? ` Warning: ${others.join(' and ')} can move the money without the wait.` : '') +
          (newItems.length === 0 ? ' Nothing waits.' : ` ${newItems.length === 1 ? 'One request waits' : `${newItems.length} requests wait`}:\n${lines.join('\n')}`),
      });
      s.lastHeartbeat = Number(now);
    } else {
      this.settingsAlert(s.settings!, settings, delay, vault, Number(now));
      for (const it of newItems) {
        const st = times(it);
        const wait = `The wait ends on ${fmtWhen(st.readyAt)}${st.readyAt > now ? ` (in ${fmtDuration(st.readyAt - now)})` : ''}.`;
        // What to do when it was not you. A request that takes money to the wallet means that somebody has the wallet.
        const stolen = it.kind === 'withdrawal' ? ' Somebody else may have your wallet.' : '';
        const act = !rolesKnown ? `If not, look at your Chronobox now.${stolen}`
          : roles ? `If not, open your Chronobox and cancel it.${stolen}`
          : `If not, look at your Chronobox now. It cannot cancel a request.${stolen}`;
        this.push({
          event: 'queued', nonce: it.nonce, priority: it.priority, at: Number(now),
          title: `New request: ${it.summary}`,
          message: `Somebody asked this Chronobox to ${lowerFirst(it.summary)}. ${it.detail}\n\n${wait}\n\nWas it you? Then you need to do nothing. ${act}`,
        });
        s.items[it.nonce] = it;
      }
    }

    // Closed items.
    for (const it of Object.values(s.items).sort((a, b) => a.nonce - b.nonce)) {
      if (it.nonce >= txNonce) continue;
      const r = reasons.get(it.nonce) ?? { how: 'executed_or_expired' };
      const money = it.kind === 'withdrawal' || it.kind === 'transfer_other';
      if (r.how === 'cancelled') {
        this.push({
          event: 'cancelled', nonce: it.nonce, priority: 3, at: Number(now),
          title: `Cancelled: ${it.summary}`,
          message: `${Request(it)} was cancelled on ${fmtWhen(r.ts)}. ${money ? 'No money moved.' : 'Nothing changed.'}`,
        });
      } else {
        const text = {
          executed: [`Done: ${it.summary}`, `${Request(it)} was carried out. ${money ? 'The money left this Chronobox.' : 'The change is in force.'}`],
          expired: [`Removed: ${it.summary}`, `${Request(it)} was not finished in time and was removed. ${money ? 'No money moved.' : 'Nothing changed.'}`],
          executed_or_expired: [`Closed: ${it.summary}`, `${Request(it)} is closed. It was carried out just before its time ran out, or its time ran out and it was removed. Open your Chronobox to see which.`],
          executed_or_cancelled: [`Closed: ${it.summary}`, `${Request(it)} is closed. It was carried out, or it was cancelled. The alert service could not see which. Open your Chronobox to see it.`],
        }[r.how];
        this.push({
          event: 'closed', nonce: it.nonce, priority: 3, at: Number(now),
          title: text[0], message: text[1],
        });
      }
      delete s.items[it.nonce];
    }

    // Ready, expires soon, expired.
    for (const it of Object.values(s.items).sort((a, b) => a.nonce - b.nonce)) {
      const st = times(it);
      const ahead = it.nonce - txNonce;
      if (st.status === 'ready' && !it.sentReady) {
        it.sentReady = true;
        this.push({
          event: 'ready', nonce: it.nonce, priority: it.priority, at: Number(now),
          title: `Wait over: ${it.summary}`,
          message: `The wait is over for ${request(it)}. Anybody can finish it now, and it does only what the request says.` +
            `${st.expiresAt === null ? '' : ` It must be finished before ${fmtWhen(st.expiresAt)}.`}` +
            (roles ? ' Until it is finished, it can still be cancelled.' : '') +
            (ahead > 0 ? ` ${ahead === 1 ? 'One earlier request' : `${ahead} earlier requests`} must be finished or removed first.` : ''),
        });
      }
      if (st.status === 'ready' && st.expiresAt !== null && !it.sentExpiring && now >= st.expiresAt - expiryLead(expiration)) {
        it.sentExpiring = true;
        this.push({
          event: 'expires_soon', nonce: it.nonce, priority: 3, at: Number(now),
          title: `Ends soon: ${it.summary}`,
          message: `${Request(it)} must be finished before ${fmtWhen(st.expiresAt)}. That is in ${fmtDuration(st.expiresAt - now)}. After that it is void.`,
        });
      }
      if (st.status === 'expired' && !it.sentExpired) {
        it.sentReady = true; it.sentExpiring = true; it.sentExpired = true;
        this.push({
          event: 'expired', nonce: it.nonce, priority: 3, at: Number(now),
          title: `Too late: ${it.summary}`,
          message: `${Request(it)} was not finished before ${fmtWhen(st.expiresAt!)}. It is void now. ` +
            'It must be removed in the Chronobox before a later request can be finished.',
        });
      }
    }

    // Heartbeat.
    const pending = Object.keys(s.items).length;
    if (!first && this.cfg.heartbeatHours > 0 && Number(now) - (s.lastHeartbeat ?? 0) >= this.cfg.heartbeatHours * 3600) {
      s.lastHeartbeat = Number(now);
      this.push({
        event: 'heartbeat', title: 'All quiet', priority: 2, at: Number(now),
        message: `${pending === 0 ? 'Nothing waits in this Chronobox.' : pending === 1 ? 'One request waits in this Chronobox.' : `${pending} requests wait in this Chronobox.`} ` +
          `The alert service looked on ${fmtWhen(now)}.`,
      });
    }

    s.settings = settings;
    s.txNonce = txNonce;
    s.queueNonce = queueNonce;
    s.lastBlock = head;
  }

  private settingsAlert(prev: Settings, next: Settings, delay: string, vault: string, at: number): void {
    const changes: string[] = [];
    const list = (a: string[]) => (a.length ? a.join(', ') : 'none');
    if (prev.cooldown !== next.cooldown) changes.push(`The delay changed from ${fmtDuration(BigInt(prev.cooldown))} to ${fmtDuration(BigInt(next.cooldown))}.`);
    if (prev.expiration !== next.expiration) {
      const f = (v: string) => (v === '0' ? 'no limit' : fmtDuration(BigInt(v)));
      changes.push(`How long a request stays open after its wait changed from ${f(prev.expiration)} to ${f(next.expiration)}.`);
    }
    if (list(prev.controllers) !== list(next.controllers)) {
      changes.push(prev.controllers.length === 1 && next.controllers.length === 1
        ? `The wallet of this Chronobox changed from ${prev.controllers[0]} to ${next.controllers[0]}. Only the new wallet can withdraw.`
        : `The wallets that can withdraw changed. Before: ${list(prev.controllers)}. Now: ${list(next.controllers)}.`);
    }
    for (const k of ['owner', 'avatar', 'target'] as const) {
      if (prev[k] !== next[k]) changes.push(`What the delay protects changed (technical detail: its ${k} was ${prev[k]} and is ${next[k]}).`);
    }
    // The cancel contract. Old state files have no such fields: treat them as "no cancel".
    const pr = prev.roles ?? '', nr = next.roles ?? '';
    if (pr !== nr) {
      if (!pr) changes.push('This Chronobox can now cancel a request.');
      else if (!nr) changes.push('This Chronobox cannot cancel a request any more.');
      else changes.push(`The contract that decides who can cancel changed from ${pr} to ${nr}.`);
    }
    if (pr && nr && (prev.rolesOwner ?? '') !== (next.rolesOwner ?? '')) {
      changes.push(`The address that decides who can cancel changed from ${prev.rolesOwner} to ${next.rolesOwner}.`);
    }
    const pc = prev.cancellers ?? [], nc = next.cancellers ?? [];
    const and = (a: string[]) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    const gained = nc.filter((a) => !pc.includes(a));
    // Without the cancel contract nobody can cancel, and the line above has said so.
    const lost = nr ? pc.filter((a) => !nc.includes(a)) : [];
    if (gained.length) changes.push(`${and(gained)} can now cancel a request.`);
    if (lost.length) changes.push(`${and(lost)} cannot cancel a request any more.`);
    // What a new guardian looks like: two new addresses beside the wallet.
    if (gained.filter((a) => !next.controllers.includes(a)).length === 2) {
      changes.push('With a guardian, these are the guardian and the Safe that the guardian shares with the wallet. That Safe can hand the Chronobox to a new wallet at once.');
    }
    // A part of the Safe that is not the delay or the cancel contract can move the money at once. Nothing is worse.
    const strangers = next.safeModules.filter((m) => m !== delay && m !== nr);
    const arrived = strangers.filter((m) => !prev.safeModules.includes(m));
    for (const m of arrived) changes.push(`Warning: ${m} can now move the money without the wait.`);
    if (list(prev.safeModules) !== list(next.safeModules) && !arrived.length && pr === nr) changes.push('The parts of this Chronobox changed.');
    if (!changes.length) return;
    if (nr && next.rolesOwner !== vault && next.rolesOwner !== BURN_ADDRESS) {
      changes.push(`Warning: the address ${next.rolesOwner} can change who can cancel and what they can do.`);
    }
    const stayed = strangers.filter((m) => !arrived.includes(m));
    if (stayed.length) changes.push(`Warning: ${stayed.join(' and ')} can move the money without the wait.`);
    this.push({
      event: 'settings_changed', title: 'This Chronobox changed', priority: 5, at,
      message: `${changes.join('\n')}\n\nIf you did not want this, look at your Chronobox now.`,
    });
  }

  /** Try to deliver every alert in the outbox. Failed channels stay pending for the next poll. */
  async flush(): Promise<void> {
    const s = this.state;
    const channels: string[] = [];
    if (this.cfg.dryRun) channels.push('dry-run');
    else {
      if (this.cfg.webhookUrl) channels.push('webhook');
      if (this.telegram) channels.push('telegram');
    }
    for (const alert of [...s.outbox]) {
      for (const ch of channels) {
        if (alert.done.includes(ch)) continue;
        try {
          await this.send(ch, alert);
          alert.done.push(ch);
        } catch (e) {
          this.log(`delivery of "${alert.title}" via ${ch} failed, will retry next poll: ${errText(e)}`);
        }
      }
      if (channels.every((c) => alert.done.includes(c))) {
        s.outbox = s.outbox.filter((a) => a !== alert);
        if (!this.cfg.dryRun) this.log(`sent: ${alert.title}`);
      }
    }
  }

  private async send(channel: string, a: Alert): Promise<void> {
    const vault = this.state.vault ?? this.cfg.chronobox ?? '';
    const delay = this.state.delay ?? this.cfg.delay ?? '';
    if (channel === 'dry-run') {
      console.log(`[dry-run] ${a.event} (priority ${a.priority}) ${a.title}\n${a.message}\n`);
      return;
    }
    if (channel === 'telegram') {
      // Throws when a chat could not be reached. The chats that got the alert are marked in `a.done`.
      await this.telegram!.deliver(this.state.chainId ?? 0, vault, a);
      return;
    }
    const body: Record<string, unknown> = {
      event: a.event, title: a.title, message: a.message, priority: a.priority, vault, delay, chainId: this.state.chainId ?? null,
    };
    if (a.nonce !== undefined) body.nonce = a.nonce;
    body.at = new Date(a.at * 1000).toISOString();
    const res = await this.fetchFn(this.cfg.webhookUrl!, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.arrayBuffer().catch(() => undefined);
  }
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Telegram
//
// A second way to get the alerts of --all, for people who do not want another app. A person opens
// https://t.me/<bot>?start=<chain id>-<vault address> and presses Start. From then on the bot sends the
// alerts of that vault to that chat. The bot keeps one pair per chat: the number of the chat and the
// vault. That pair is all this watcher stores about a person. It keeps no name, no username and no
// message, and it does not write the number of a chat to the log.
//
// On disk the list of chats is encrypted with TELEGRAM_KEY (AES-256-GCM). The key is a setting and is
// not in the file, so the file, a copy of it or the disk alone show nobody who follows what. This does
// not protect against a person who controls the running watcher: it holds the list and the key.

/** The text after "start=" in the link to the bot. The same rule is in the app (src/lib/alerts.ts). */
export function telegramStart(chainId: number, vault: string): string {
  return `${chainId}-${vault.toLowerCase()}`;
}

export class TelegramError extends Error {
  code: number;
  retryAfter?: number;
  migrateTo?: number;
  constructor(method: string, code: number, description: string, parameters?: { retry_after?: number; migrate_to_chat_id?: number }) {
    super(`Telegram ${method}: ${code} ${description}`);
    this.code = code;
    this.retryAfter = parameters?.retry_after;
    this.migrateTo = parameters?.migrate_to_chat_id;
  }
}

/** What the bot needs from the watcher of one network. */
export type Network = {
  chainId: number;
  /** Starts to watch the vault if it is a Chronobox. False if it is not one. Throws if the chain cannot be read. */
  adopt(vault: string): Promise<boolean>;
  /** What waits in the vault now, one line per item. */
  pending(vault: string): string[];
};

type TelegramState = { offset?: number; chats: Record<string, string[]> };
/** The file: the list of chats as one sealed block (base64 of nonce, tag and ciphertext). The offset is no secret. */
type TelegramFile = { version: 2; offset?: number; sealed: string };
const SEAL_LABEL = 'chronobox-telegram-chats-v2';

/** One chat cannot follow more Chronoboxes than this. */
export const TELEGRAM_MAX_PER_CHAT = 20;

const TG_HOW = 'To get alerts, open your Chronobox, tap "Get told" and then "Telegram". That brings you back here with the right address.';
const TG_HELP = `${TG_HOW}\n\n/list shows what this chat follows.\n/stop ends the alerts.\n/privacy says what I keep.`;
const TG_NEVER = 'I never send links, and I never ask for a key, a password or money. A message that does is not from me.';
const TG_KEEP = 'I keep the number of this chat and the address of the Chronobox. I keep nothing else. /stop deletes it.';
const TG_PRIVACY =
  'I keep two things: the number of this chat, and the addresses of the Chronoboxes that it follows. ' +
  'I do not keep your name, your username or your messages.\n\n' +
  'The list is stored encrypted. /stop deletes everything about this chat.\n\n' +
  'Telegram can read the messages that I send you. What they say is public on the blockchain. That this chat follows a Chronobox is not.';
const TG_LATER = 'I cannot read the network right now. Try again in a few minutes.';

/** An alert as a Telegram message: plain text, no links. */
export function telegramText(a: Alert, chainId: number, vault: string): string {
  const mark = a.priority >= 5 ? '\u{1F6A8} ' : a.priority >= 4 ? '⚠️ ' : '';
  const text = `${mark}${a.title}\n\n${a.message}\n\nChronobox ${shortAddr(vault)} on ${networkName(chainId)}`;
  return text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
}

export class Telegram {
  /** The name of the bot, from Telegram. Empty until `start` worked. */
  username = '';
  state: TelegramState;
  private token: string;
  private secret: string;
  private key: Buffer;
  private api: string;
  private file: string;
  private dryRun: boolean;
  private expected: number;
  private fetchFn: FetchFn;
  private log: Log;
  private networks = new Map<number, Network>();

  constructor(cfg: Config, opts: { fetch?: FetchFn; log?: Log } = {}) {
    if (!cfg.telegramToken) throw new ConfigError('TELEGRAM_TOKEN is not set.');
    this.token = cfg.telegramToken;
    if (!cfg.telegramKey || cfg.telegramKey.length < 32) throw new ConfigError('TELEGRAM_KEY must be a secret of 32 characters or more.');
    this.secret = cfg.telegramKey;
    // A slow step, one time, so that a short secret is not guessed from a stolen file by trying.
    this.key = crypto.scryptSync(cfg.telegramKey, SEAL_LABEL, 32);
    this.api = cfg.telegramApi;
    this.dryRun = cfg.dryRun;
    this.expected = cfg.networks.length;
    this.fetchFn = opts.fetch ?? fetch;
    const out = opts.log ?? ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
    this.log = (m: string) => out(this.redact(m));
    try { fs.mkdirSync(cfg.stateDir, { recursive: true }); } catch (e) {
      throw new ConfigError(`Cannot create STATE_DIR: ${errText(e)}`);
    }
    this.file = path.join(cfg.stateDir, 'telegram.json');
    this.state = this.load();
  }

  redact(msg: string): string { return msg.split(this.token).join('[telegram token]').split(this.secret).join('[telegram key]'); }

  private seal(chats: Record<string, string[]>): string {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(SEAL_LABEL));
    const body = Buffer.concat([cipher.update(JSON.stringify(chats), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  /** Throws when the key is not the one that sealed the block, or when the block was changed. */
  private open(sealed: string): Record<string, string[]> {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(SEAL_LABEL));
    decipher.setAuthTag(raw.subarray(12, 28));
    const chats = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (typeof chats !== 'object' || chats === null) throw new Error('unknown format');
    return chats;
  }

  private load(): TelegramState {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e: any) {
      if (e?.code === 'ENOENT') return { chats: {} };
      throw new ConfigError(`Cannot read ${this.file}: ${e?.message ?? e}`);
    }
    let f: any;
    try { f = JSON.parse(text); } catch (e) {
      throw new ConfigError(`${this.file} is not a valid list of Telegram chats (${errText(e)}). Fix or remove it; removing it ends every subscription.`);
    }
    if (f?.version === 1 && typeof f.chats === 'object' && f.chats !== null) {
      // A list from before the encryption. It is written again, sealed, with the next change or right now.
      const state: TelegramState = { offset: f.offset, chats: f.chats };
      this.state = state;
      this.save();
      this.log('telegram: the list of chats was in plain form and is encrypted now');
      return state;
    }
    if (f?.version !== 2 || typeof f.sealed !== 'string') {
      throw new ConfigError(`${this.file} is not a valid list of Telegram chats (unknown format). Fix or remove it; removing it ends every subscription.`);
    }
    try {
      return { offset: f.offset, chats: this.open(f.sealed) };
    } catch {
      throw new ConfigError(
        `TELEGRAM_KEY does not open ${this.file}. Use the key that the list was written with. ` +
        'Without that key the list is lost: remove the file, and every person must press Start again.',
      );
    }
  }

  private save(): void {
    if (this.dryRun) return;
    const out: TelegramFile = { version: 2, offset: this.state.offset, sealed: this.seal(this.state.chats) };
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(out) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The watcher of a network says that it is there. Before that, the bot cannot check a vault on that network. */
  addNetwork(n: Network): void { this.networks.set(n.chainId, n); }

  /** The chats that follow a vault. */
  subscribers(chainId: number, vault: string): string[] {
    const key = telegramStart(chainId, vault);
    return Object.keys(this.state.chats).filter((chat) => this.state.chats[chat].includes(key));
  }

  private async call(method: string, body: unknown, timeoutMs = 20000): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.api}/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(this.redact(`Telegram ${method}: ${errText(e)}`));
    }
    let j: any = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !j?.ok) throw new TelegramError(method, Number(j?.error_code ?? res.status), String(j?.description ?? `HTTP ${res.status}`), j?.parameters);
    return j.result;
  }

  private say(chat: string | number, text: string, silent = false): Promise<unknown> {
    return this.call('sendMessage', { chat_id: Number(chat), text, disable_notification: silent, link_preview_options: { is_disabled: true } });
  }

  /** Checks the token and learns the name of the bot. A token that Telegram does not accept is a configuration error. */
  async start(): Promise<void> {
    try {
      const me = await this.call('getMe', {});
      this.username = String(me?.username ?? '');
    } catch (e) {
      if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) throw new ConfigError('Telegram does not accept TELEGRAM_TOKEN.');
      throw e;
    }
    await this.call('setMyCommands', {
      commands: [
        { command: 'list', description: 'What this chat follows' },
        { command: 'stop', description: 'End the alerts and delete this chat' },
        { command: 'privacy', description: 'What I keep' },
      ],
    }).catch((e) => this.log(`telegram: could not set the command list: ${errText(e)}`));
  }

  /**
   * Sends an alert to every chat that follows the vault. A chat that got it is marked in `a.done`, so a
   * second try does not send it twice. Throws if a chat could not be reached and should be tried again.
   */
  async deliver(chainId: number, vault: string, a: Alert): Promise<void> {
    // "Watching" is for the person who runs the watcher. A chat gets the state of the vault when it subscribes.
    if (a.event === 'watching') return;
    const text = telegramText(a, chainId, vault);
    let failed: string | null = null;
    for (const chat of this.subscribers(chainId, vault)) {
      const mark = `tg:${chat}`;
      if (a.done.includes(mark)) continue;
      try {
        await this.say(chat, text, a.priority <= 2);
        a.done.push(mark);
      } catch (e) {
        if (!(e instanceof TelegramError)) { failed = errText(e); continue; }
        if (e.migrateTo !== undefined) {
          // A group became a supergroup and has a new number. The next poll sends to it.
          this.state.chats[String(e.migrateTo)] = this.state.chats[chat];
          delete this.state.chats[chat];
          this.save();
          failed = 'a group has a new number';
        } else if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
          // The person blocked the bot or deleted the chat. That is a /stop.
          this.forget(chat);
        } else if (e.code === 400) {
          // Telegram does not take this message, and will not take it later.
          this.log(`telegram: "${a.title}" was refused: ${e.message}`);
          a.done.push(mark);
        } else {
          failed = e.message;
          // Too many messages: stop here, the next poll goes on.
          if (e.code === 429) break;
        }
      }
    }
    if (failed) throw new Error(failed);
  }

  private forget(chat: string): void {
    if (!(chat in this.state.chats)) return;
    delete this.state.chats[chat];
    this.save();
    this.log('telegram: a chat was removed');
  }

  /** Reads the new messages one time and answers them. `waitSeconds`: how long Telegram holds the request open. */
  async pump(waitSeconds = 0): Promise<number> {
    const updates: any[] = await this.call(
      'getUpdates', { offset: this.state.offset, timeout: waitSeconds, allowed_updates: ['message'] }, (waitSeconds + 15) * 1000,
    );
    for (const u of updates) {
      try {
        await this.handle(u);
      } catch (e) {
        this.log(`telegram: could not answer a message: ${errText(e)}`);
      }
      // Every message is read one time, also when the answer failed. The person can send it again.
      if (typeof u?.update_id === 'number') this.state.offset = u.update_id + 1;
    }
    if (updates.length) this.save();
    return updates.length;
  }

  /** Reads messages until `stopped` says so. A failed request waits longer each time, up to a minute. */
  async run(stopped: () => boolean = () => false): Promise<void> {
    let wait = 1;
    while (!stopped()) {
      try {
        await this.pump(50);
        wait = 1;
      } catch (e) {
        this.log(e instanceof TelegramError && e.code === 409
          ? 'telegram: another program reads the messages of this bot, or the bot has a webhook. Only one reader works.'
          : `telegram: cannot get messages: ${errText(e)}`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        wait = Math.min(wait * 2, 60);
      }
    }
  }

  private async handle(update: any): Promise<void> {
    const m = update?.message;
    const chat = m?.chat?.id;
    if (typeof chat !== 'number' || typeof m?.text !== 'string') return;
    const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s+(\S+))?/i.exec(m.text.trim());
    if (!cmd) {
      // In a group, the bot answers commands only.
      if (m.chat.type === 'private') await this.say(chat, TG_HELP);
      return;
    }
    const name = cmd[1].toLowerCase();
    const arg = cmd[2] ?? '';
    if (name === 'start' && arg) return this.subscribe(chat, arg);
    if (name === 'stop') return this.unsubscribe(chat, arg);
    if (name === 'list') {
      const mine = this.state.chats[chat] ?? [];
      const lines = mine.map((key) => { const [id, vault] = key.split('-'); return `${vault} on ${networkName(Number(id))}`; });
      await this.say(chat, lines.length ? `This chat follows:\n${lines.join('\n')}\n\n/stop ends all of them. /stop and an address ends one.` : `This chat follows no Chronobox.\n\n${TG_HOW}`);
      return;
    }
    if (name === 'privacy') { await this.say(chat, TG_PRIVACY); return; }
    await this.say(chat, TG_HELP);
  }

  private async subscribe(chat: number, arg: string): Promise<void> {
    const p = /^(\d{1,12})-(0x[0-9a-fA-F]{40})$/.exec(arg);
    if (!p) { await this.say(chat, TG_HELP); return; }
    const chainId = Number(p[1]);
    const vault = p[2].toLowerCase();
    const net = this.networks.get(chainId);
    if (!net) {
      // A watcher that could not read its chain yet has not said which network it is.
      await this.say(chat, this.networks.size < this.expected ? TG_LATER : `I do not watch ${networkName(chainId)}.`);
      return;
    }
    const key = telegramStart(chainId, vault);
    const mine = this.state.chats[chat] ?? [];
    if (!mine.includes(key) && mine.length >= TELEGRAM_MAX_PER_CHAT) {
      await this.say(chat, `This chat follows ${mine.length} Chronoboxes already. That is the limit. /list shows them.`);
      return;
    }
    let found: boolean;
    try {
      found = await net.adopt(vault);
    } catch (e) {
      this.log(`telegram: could not check ${vault} on chain ${chainId}: ${errText(e)}`);
      await this.say(chat, TG_LATER);
      return;
    }
    if (!found) {
      await this.say(chat, `${vault} is not a Chronobox on ${networkName(chainId)}.\n\n${TG_HOW}`);
      return;
    }
    if (!mine.includes(key)) {
      this.state.chats[chat] = [...mine, key];
      this.save();
      this.log(`telegram: a chat follows ${vault} on chain ${chainId}`);
    }
    const waits = net.pending(vault);
    const now = waits.length === 0 ? 'Nothing waits there right now.'
      : `Right now ${waits.length === 1 ? 'one request waits' : `${waits.length} requests wait`} there:\n${waits.join('\n')}`;
    await this.say(chat, `You now get the alerts of the Chronobox ${shortAddr(vault)} on ${networkName(chainId)}.\n\n${now}\n\n${TG_KEEP}\n\n${TG_NEVER}`);
  }

  private async unsubscribe(chat: number, arg: string): Promise<void> {
    const mine = this.state.chats[chat] ?? [];
    const one = ADDRESS_RE.test(arg) ? arg.toLowerCase() : null;
    const left = one ? mine.filter((key) => !key.endsWith(`-${one}`)) : [];
    if (left.length === mine.length) {
      await this.say(chat, mine.length ? `This chat does not follow ${one}. /list shows what it follows.` : 'This chat follows no Chronobox.');
      return;
    }
    if (left.length) this.state.chats[chat] = left; else delete this.state.chats[chat];
    this.save();
    this.log('telegram: a chat stopped');
    // Alerts must not go off in silence: a person who is forced to stop them has others who still listen.
    for (const key of mine.filter((k) => !left.includes(k))) {
      const [id, vault] = key.split('-');
      for (const other of this.subscribers(Number(id), vault)) {
        await this.say(other, `A chat that got the alerts of the Chronobox ${shortAddr(vault)} on ${networkName(Number(id))} has stopped them. You still get them here.`)
          .catch((e) => this.log(`telegram: could not tell a chat that another one stopped: ${errText(e)}`));
      }
    }
    await this.say(chat, left.length
      ? `Done. No more alerts for ${one} here. /list shows what this chat still follows.`
      : 'Done. You get no more alerts here, and I deleted this chat from my list.');
  }
}

// ---------------------------------------------------------------------------
// --all: every Chronobox on the chain
//
// Everything a Chronobox does goes through its Delay, and the chain is public. So one watcher can
// watch every Chronobox without being told about each one: it finds new Chronoboxes by the Delay they
// deploy and by the transactions they queue. The alerts of a vault go to the Telegram chats that
// follow it, and to the webhook.

type Known = { delay: string; active: boolean; heartbeatAt?: number };

export type AllState = {
  version: 1;
  chainId?: number;
  lastBlock?: number;
  vaults: Record<string, Known>;
};

export class AllWatcher {
  cfg: Config;
  state: AllState;
  log: Log;
  private opts: { fetch?: FetchFn; log?: Log; telegram?: Telegram };
  private probe: Watcher;
  private file: string;
  // A poll and a question from the Telegram bot do not read the same vault at the same time.
  private turn: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config, opts: { fetch?: FetchFn; log?: Log; telegram?: Telegram } = {}) {
    this.cfg = cfg;
    this.opts = opts;
    try { fs.mkdirSync(cfg.stateDir, { recursive: true }); } catch (e) {
      throw new ConfigError(`Cannot create STATE_DIR: ${errText(e)}`);
    }
    this.file = path.join(cfg.stateDir, 'all.json');
    // Reads the chain only. Its state file never exists and is never written.
    this.probe = new Watcher({ ...cfg, dryRun: true, stateFile: path.join(cfg.stateDir, 'probe.none') }, opts);
    this.log = this.probe.log;
    this.state = this.load();
    this.announce();
  }

  private once<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(fn, fn);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** Tells the Telegram bot which network this watcher reads, as soon as it knows. */
  private announce(): void {
    const chainId = this.state.chainId;
    if (chainId === undefined) return;
    this.opts.telegram?.addNetwork({ chainId, adopt: (vault) => this.adopt(vault), pending: (vault) => this.pending(vault) });
  }

  /**
   * Somebody asked for the alerts of this vault. If it is a Chronobox, the watcher knows it from now on,
   * also when it is older than the first block that the watcher searched. Then the vault is read, so
   * that the answer can say what waits. False if the address is not a Chronobox.
   */
  adopt(vault: string): Promise<boolean> {
    return this.once(async () => {
      const s = this.state;
      if (s.chainId === undefined) throw new Error('the network is not known yet');
      if (!s.vaults[vault]) {
        let mods: string[];
        try { mods = await this.probe.modules(vault, 'latest'); } catch (e) {
          if (e instanceof RevertError) return false;
          throw e;
        }
        let delay: string | null = null;
        // A Chronobox has two modules at most.
        for (const m of mods.slice(0, 2)) {
          if ((await this.probe.chronoboxOf(m, 'latest')) === vault) { delay = m; break; }
        }
        if (!delay) return false;
        s.vaults[vault] = { delay, active: true };
        this.log(`new Chronobox ${vault} (Delay ${delay}), found by a question in Telegram`);
        this.save();
      }
      const known = s.vaults[vault];
      if (known.active) {
        await this.look(vault, known, s.chainId);
        this.save();
      }
      return true;
    });
  }

  /** What waits in a vault, from the last read: one line per item. */
  pending(vault: string): string[] {
    let st: State;
    try { st = loadState(path.join(this.cfg.stateDir, `${vault}.json`)); } catch { return []; }
    if (!st.settings) return [];
    const now = BigInt(Math.floor(Date.now() / 1000));
    return Object.values(st.items).sort((a, b) => a.nonce - b.nonce).map((it) =>
      waitLine(it.summary, itemStatus(BigInt(it.createdAt), BigInt(st.settings!.cooldown), BigInt(st.settings!.expiration), now)));
  }

  redact(msg: string): string { return this.probe.redact(msg); }

  private load(): AllState {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e: any) {
      if (e?.code === 'ENOENT') return { version: 1, vaults: {} };
      throw new ConfigError(`Cannot read ${this.file}: ${e?.message ?? e}`);
    }
    try {
      const s = JSON.parse(text);
      if (s?.version !== 1 || typeof s.vaults !== 'object') throw new Error('unknown format');
      return s as AllState;
    } catch (e) {
      throw new ConfigError(`${this.file} is not a valid watcher state (${errText(e)}). Fix or remove it.`);
    }
  }

  private save(): void {
    if (this.cfg.dryRun) return;
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The watcher of one vault: the same code as for a single vault. */
  private watcherOf(vault: string, known: Known, chainId: number): Watcher {
    return new Watcher({
      ...this.cfg,
      chronobox: vault,
      delay: known.delay,
      stateFile: path.join(this.cfg.stateDir, `${vault}.json`),
    }, { fetch: this.opts.fetch, telegram: this.opts.telegram, log: (m) => this.log(`${vault.slice(0, 10)}: ${m}`) });
  }

  /** Reads one vault and sends its alerts. False if the chain could not be read. */
  private async look(vault: string, known: Known, chainId: number): Promise<boolean> {
    const w = this.watcherOf(vault, known, chainId);
    const ok = await w.poll();
    const ws = w.state;
    known.active = Object.keys(ws.items).length > 0 || ws.outbox.length > 0 || ws.failCount > 0 || ws.lastBlock === undefined;
    known.heartbeatAt = ws.lastHeartbeat;
    return ok;
  }

  /** Find new Chronoboxes and see which known ones queued something. Returns the vaults to look at now. */
  private async scan(): Promise<{ chainId: number; now: number; touched: Set<string> }> {
    const s = this.state;
    const rpc = this.probe.rpc;
    const chainId = Number(await rpc.call('eth_chainId'));
    if (s.chainId !== undefined && s.chainId !== chainId) {
      throw new ConfigError(`The RPC is on chain ${chainId}, but STATE_DIR belongs to chain ${s.chainId}. Check RPC_URL.`);
    }
    const head = Number(await rpc.call('eth_blockNumber'));
    const block = await rpc.call('eth_getBlockByNumber', [hex(head), false]);
    if (!block) throw new Error(`block ${head} not found`);
    const now = Number(BigInt(block.timestamp));
    const tag = hex(head);
    const touched = new Set<string>();
    const from = s.lastBlock !== undefined ? s.lastBlock + 1 : this.cfg.startBlock ?? head + 1;
    if (from <= head) {
      const logs = await this.probe.getLogs(from, head, [[TOPIC_MODULE_PROXY_CREATION, TOPIC_TRANSACTION_ADDED]]);
      const byDelay = new Map(Object.entries(s.vaults).map(([vault, k]) => [k.delay, vault]));
      const candidates = new Set<string>();
      for (const l of logs) {
        const emitter = String(l.address).toLowerCase();
        if (l.topics[0] === TOPIC_MODULE_PROXY_CREATION) {
          if (emitter !== MODULE_PROXY_FACTORY || toAddr(strip(l.topics[2] ?? '')) !== MASTER_COPY.delay) continue;
          const delay = toAddr(strip(l.topics[1]));
          if (!byDelay.has(delay)) candidates.add(delay);
        } else {
          const vault = byDelay.get(emitter);
          if (vault) touched.add(vault); else candidates.add(emitter);
        }
      }
      for (const delay of candidates) {
        const vault = await this.probe.chronoboxOf(delay, tag);
        if (!vault || s.vaults[vault]) continue;
        s.vaults[vault] = { delay, active: true };
        touched.add(vault);
        this.log(`new Chronobox ${vault} (Delay ${delay})`);
      }
    }
    s.chainId = chainId;
    s.lastBlock = head;
    this.announce();
    return { chainId, now, touched };
  }

  /**
   * One poll. A vault with an empty queue cannot change until it queues something, so only vaults
   * with something pending, with a new queued transaction or with a heartbeat due are read.
   */
  poll(): Promise<boolean> {
    return this.once(() => this.pollNow());
  }

  private async pollNow(): Promise<boolean> {
    const s = this.state;
    let ok = true;
    let now = Math.floor(Date.now() / 1000);
    try {
      const r = await this.scan();
      now = r.now;
      for (const vault of r.touched) s.vaults[vault].active = true;
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      ok = false;
      this.log(`search for Chronoboxes failed: ${errText(e)}`);
    }
    if (s.chainId === undefined) return false;
    const beat = this.cfg.heartbeatHours * 3600;
    for (const [vault, known] of Object.entries(s.vaults)) {
      // An "all quiet" message makes sense only where somebody can hear it.
      const heard = Boolean(this.cfg.webhookUrl || this.cfg.dryRun) || (this.opts.telegram?.subscribers(s.chainId, vault).length ?? 0) > 0;
      if (!known.active && !(heard && beat > 0 && now - (known.heartbeatAt ?? 0) >= beat)) continue;
      try {
        if (!(await this.look(vault, known, s.chainId))) ok = false;
      } catch (e) {
        ok = false;
        this.log(`${vault}: ${errText(e)}`);
      }
    }
    this.save();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Main

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
      telegram = cfg.telegramToken && !cfg.dryRun ? new Telegram(cfg) : undefined;
      // More than one network: each one keeps its state in its own folder, in the order of RPC_URL.
      watchers = cfg.networks.map((rpcUrls, i) => new AllWatcher(
        { ...cfg, rpcUrls, stateDir: cfg.networks.length > 1 ? path.join(cfg.stateDir, `network-${i + 1}`) : cfg.stateDir },
        { telegram },
      ));
    } else {
      watchers = [new Watcher(cfg)];
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
    return fs.realpathSync(self) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
