// The watcher of one Chronobox: one poll reads the chain, turns what changed into alerts, and sends them.
// The CLI runs it for one vault. --all and the service run one for each vault that something waits in.
import * as path from 'node:path';
import {
  BURN_ADDRESS, MASTER_COPY, RevertError, Rpc, SAFE_GUARD_SLOT, SENTINEL, SEL, TOPIC_SAFE_MODULE_TRANSACTION, TOPIC_TRANSACTION_ADDED,
  TOPIC_MODULE_FAILURE, TOPIC_MODULE_SUCCESS, ZERO_ADDRESS, addressWord, cleanSymbol, decodeAbiString, decodeAddressArray, decodeAddresses, decodeModuleTransaction, strip,
  decodeAddress, decodeTransactionAdded, decodeUint, encAddr, encUint, hex, proxyCode, toAddr, toBig, word,
} from './chain.ts';
import type { Config } from './config.ts';
import { type DescribeCtx, type TokenMeta, describeTx } from './describe.ts';
import { fmtDuration, fmtWhen, lowerFirst, networkName, shortAddr } from './format.ts';
import { DEFAULT_RECOVERY_WAIT, predictRecoveryDelay, readGuard, recoveryWallet } from './guardian.ts';
import { type CloseReason, type VaultEvent, expiryLead, itemStatus, replayQueue, waitLine } from './status.ts';
import { DryRunStore, FileStore, type Store } from './store.ts';
import type { Email } from './email.ts';
import type { Telegram } from './telegram.ts';
import type { Alert, Item, RecoverySettings, Settings, State } from './types.ts';
import { ConfigError, type FetchFn, type Log, defaultLog, errText } from './util.ts';

const FIRST_START_LOOKUP_LIMIT = 50;
/**
 * Gas for each call that reads a token's symbol or decimals. A real token needs a few thousand, a proxy a few ten
 * thousand. A contract that wants more is not a token worth waiting for.
 */
export const TOKEN_META_GAS = 200_000;

/** True when the guardian alone can start a recovery: the recovery Delay acts on the shared Safe, and somebody can use it. */
export function recoveryOn(x: Settings): boolean {
  return Boolean(x.guardian && x.council && x.recovery?.made && x.recovery.modules.length > 0 && x.recovery.target === x.council);
}

/** The line of the recovery Delay can act on something: it is made, and it does not point at the vault, where it can do nothing. */
function recoveryLive(x: Settings, vault: string): boolean {
  return Boolean(x.recovery?.made && x.recovery.target !== vault);
}

/**
 * What can hand a vault with a guardian to a new wallet besides the wallet and the guardian, or tamper with
 * its recovery: a hijacked recovery owner, a guard on the recovery Delay or shared Safe, a second address on
 * the recovery Delay, zero recovery wait, a module of the shared Safe that is not the recovery Delay, or a
 * shared Safe whose owners/threshold do not require both the wallet and the guardian.
 */
export function guardWarnings(x: Settings, vault: string): string[] {
  const out: string[] = [];
  if (x.recovery?.made) {
    if (x.recovery.owner && x.recovery.owner !== vault && x.recovery.owner !== BURN_ADDRESS) {
      out.push(`Warning: ${x.recovery.owner} controls the recovery settings of this Chronobox.`);
    }
    if (x.recovery.guard && x.recovery.guard !== ZERO_ADDRESS) {
      out.push(`Warning: ${x.recovery.guard} is attached to the recovery and can block it.`);
    }
    if (recoveryLive(x, vault)) {
      for (const m of x.recovery.modules) if (m !== x.guardian) out.push(`Warning: ${m} can start a recovery.`);
      if (x.council && x.recovery.target === x.council && x.recovery.avatar && x.recovery.avatar !== x.council) {
        out.push(`Warning: the recovery does not point cleanly at the shared Safe ${x.council}.`);
      }
    }
    if (recoveryOn(x) && x.recovery.cooldown === '0') {
      out.push('Warning: a recovery has no wait and can be carried out at once.');
    }
  }
  if (x.guardian && x.council) {
    for (const m of x.councilModules ?? []) if (m !== x.recovery?.delay) out.push(`Warning: ${m} can hand this Chronobox to a new wallet at once.`);
    if (x.councilGuard && x.councilGuard !== ZERO_ADDRESS) {
      out.push(`Warning: ${x.councilGuard} is attached to the shared Safe ${x.council}.`);
    }
    if ((x.councilOwners ?? []).length) {
      const owners = x.councilOwners!;
      const rightPair = x.controllers.length === 1
        ? owners.length === 2 && owners.includes(x.controllers[0]) && owners.includes(x.guardian)
        : owners.length === 2;
      if (x.councilThreshold !== '2' || !rightPair) {
        out.push(`Warning: the Safe ${x.council} that the wallet and the guardian share does not need both of them.`);
      }
    }
  }
  return out;
}

export function emptyState(): State {
  return { version: 1, items: {}, outbox: [], failCount: 0, problemOpen: false, seq: 0 };
}

/** The state of one vault from its stored text. `where` names it in the error. */
export function parseState(text: string | null, where: string): State {
  if (text === null) return emptyState();
  try {
    const s = JSON.parse(text);
    if (s?.version !== 1 || typeof s.items !== 'object' || !Array.isArray(s.outbox)) throw new Error('unknown format');
    return s as State;
  } catch (e) {
    throw new ConfigError(`${where} is not a valid watcher state (${errText(e)}). Fix or remove it; removing it starts over with a "Watching" message.`);
  }
}

/** The store of the CLI for one vault: the file STATE_FILE. */
export function stateFileStore(file: string): Store {
  return new FileStore(path.dirname(file), () => file);
}

export type WatcherOptions = {
  fetch?: FetchFn;
  log?: Log;
  telegram?: Telegram;
  email?: Email;
  /** Where the state is kept, under `key`. Default: the file STATE_FILE (in memory only with --dry-run). */
  store?: Store;
  key?: string;
  /** Names the state in an error message. */
  where?: string;
};

export class Watcher {
  cfg: Config;
  rpc: Rpc;
  state: State = emptyState();
  log: Log;
  fetchFn: FetchFn;
  private blockTs = new Map<number, bigint>();
  private proxyKinds = new Map<string, 'delay' | 'roles'>();
  private telegram?: Telegram;
  private email?: Email;
  private store: Store;
  private key: string;
  private where: string;
  private loaded = false;

  constructor(cfg: Config, opts: WatcherOptions = {}) {
    this.cfg = cfg;
    this.telegram = opts.telegram;
    this.email = opts.email;
    this.fetchFn = opts.fetch ?? fetch;
    this.rpc = new Rpc(cfg.rpcUrls, this.fetchFn, 20000,
      cfg.rpcServiceKey ? { host: cfg.rpcServiceHost, key: cfg.rpcServiceKey } : undefined);
    const out = opts.log ?? defaultLog;
    this.log = (m: string) => out(this.redact(m));
    this.store = opts.store ?? (cfg.dryRun ? new DryRunStore(stateFileStore(cfg.stateFile)) : stateFileStore(cfg.stateFile));
    this.key = opts.key ?? 'state';
    this.where = opts.where ?? `STATE_FILE ${cfg.stateFile}`;
  }

  /** Reads the state. `poll` does this the first time. */
  async load(): Promise<void> {
    const s = parseState(await this.store.get(this.key), this.where);
    if (s.delay && this.cfg.delay && s.delay !== this.cfg.delay) {
      throw new ConfigError(`${this.where} belongs to Delay ${s.delay}, not ${this.cfg.delay}. Use another one.`);
    }
    if (s.vault && this.cfg.chronobox && s.vault !== this.cfg.chronobox) {
      throw new ConfigError(`${this.where} belongs to vault ${s.vault}, not ${this.cfg.chronobox}. Use another one.`);
    }
    this.state = s;
    this.loaded = true;
  }

  redact(msg: string): string {
    let out = msg;
    const secrets: [string, string][] = [];
    this.cfg.rpcUrls.forEach((u, i) => secrets.push([u, `[RPC #${i + 1}]`]));
    if (this.cfg.webhookUrl) secrets.push([this.cfg.webhookUrl, '[webhook]']);
    if (this.cfg.telegramToken) out = out.split(this.cfg.telegramToken).join('[telegram token]');
    if (this.cfg.alertsKey) out = out.split(this.cfg.alertsKey).join('[alerts key]');
    if (this.cfg.resendKey) out = out.split(this.cfg.resendKey).join('[resend key]');
    if (this.cfg.rpcServiceKey) out = out.split(this.cfg.rpcServiceKey).join('[rpc service key]');
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
    return decodeUint(await this.call(to, data, tag));
  }
  private async callAddr(to: string, data: string, tag: string): Promise<string> {
    return decodeAddress(await this.call(to, data, tag));
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

  /** Logs of one contract, or of a list of contracts. */
  async getLogs(from: number, to: number, topics: (string | string[] | null)[], address?: string | string[]): Promise<any[]> {
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

  /**
   * The symbol and decimals of a token, only to word an alert. Strictly best effort: the address comes from a queued
   * request, so whoever controls the wallet chooses it, and it can be a contract made to fail. Each call gets a fixed
   * amount of gas, so a contract that burns gas fails at once instead of running into the limits of the network.
   * Any failure of the token is "not known" (null), and the alert goes out without it. Only a network that does not
   * answer at all stops the poll: after a failure, the Delay is asked again at the same block, and if that fails
   * too, the problem is the network, not the token.
   */
  private async tokenMeta(token: string, delay: string, tag: string): Promise<TokenMeta> {
    const ask = (data: string): Promise<string> => this.rpc.call('eth_call', [{ to: token, data, gas: hex(TOKEN_META_GAS) }, tag]);
    try {
      const [sym, dec] = await Promise.all([ask(SEL.symbol), ask(SEL.decimals)]);
      const decimals = Number(decodeUint(dec));
      if (!Number.isInteger(decimals) || decimals > 36) return null;
      return { symbol: cleanSymbol(decodeAbiString(sym)), decimals };
    } catch (e) {
      if (e instanceof RevertError) return null;
      // Throws when the network is down: then the poll fails and runs again, as with any other read.
      await this.call(delay, SEL.txNonce, tag);
      this.log(`token ${token}: no symbol or decimals (${errText(e)}); the alert goes out without them`);
      return null;
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
      tokenMeta = await this.tokenMeta(tx.to, ctx.delay, tag);
    }
    const d = describeTx(tx, { ...ctx, tokenMeta });
    return {
      nonce, createdAt: createdAt.toString(), block: tx.block, to: tx.to, value: tx.value.toString(),
      data: tx.data, operation: tx.operation, ...d,
    };
  }

  /** A step in the line of the recovery. `roles` and `delay` are the cancel contract and the Delay of the vault. */
  private buildRecoveryItem(nonce: number, createdAt: bigint, log: any | undefined, delay: string, roles: string, council?: string): Item {
    const tx = log ? decodeTransactionAdded(log) : undefined;
    const wallet = tx ? recoveryWallet(tx, delay, roles, council) ?? '' : '';
    return {
      nonce, createdAt: createdAt.toString(), kind: 'recovery', priority: 5, wallet,
      ...(tx ? { block: tx.block, to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation } : {}),
      summary: wallet ? `Recovery to ${shortAddr(wallet)}` : 'A step in the line of the recovery that the app does not make',
      detail: '',
    };
  }

  /** The guardian, the shared Safe and the recovery Delay of a vault with a cancel contract. */
  private async guardSettings(vault: string, controllers: string[], members: string[], tag: string): Promise<Partial<Settings>> {
    const out: Partial<Settings> = { guardian: '' };
    const slotAddr = async (addr: string, slot: string) => toAddr(strip(String(await this.rpc.call('eth_getStorageAt', [addr, slot, tag]))));
    if (controllers.length === 1) {
      const g = await readGuard({
        code: async (a) => String(await this.rpc.call('eth_getCode', [a, tag])).toLowerCase(),
        singleton: (a) => slotAddr(a, '0x0'),
        guard: (a) => slotAddr(a, SAFE_GUARD_SLOT),
        owners: async (a) => decodeAddresses(await this.call(a, SEL.getOwners, tag)),
        threshold: (a) => this.callUint(a, SEL.getThreshold, tag),
        modules: (a) => this.modules(a, tag),
      }, vault, controllers[0], members);
      if (g) Object.assign(out, { guardian: g.guardian, council: g.council, councilOwners: g.owners, councilThreshold: g.threshold, councilModules: g.modules, councilGuard: g.guard });
    }
    const rd = predictRecoveryDelay(vault);
    const recovery: RecoverySettings = { delay: rd, made: false, owner: '', avatar: '', target: '', guard: ZERO_ADDRESS, modules: [], cooldown: '0', expiration: '0' };
    if ((await this.moduleKind(rd, tag)) === 'delay') {
      const [owner, avatar, target, guard, modules, cooldown, expiration] = await Promise.all([
        this.callAddr(rd, SEL.owner, tag), this.callAddr(rd, SEL.avatar, tag), this.callAddr(rd, SEL.target, tag),
        this.callAddr(rd, SEL.getGuard, tag), this.modules(rd, tag),
        this.callUint(rd, SEL.txCooldown, tag), this.callUint(rd, SEL.txExpiration, tag),
      ]);
      Object.assign(recovery, { made: true, owner, avatar, target, guard, modules, cooldown: cooldown.toString(), expiration: expiration.toString() });
    }
    out.recovery = recovery;
    return out;
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
    if (!this.loaded) await this.load();
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
      // With --all, a vault that does not answer like a Chronobox is a problem of that vault only: its readers
      // are told, as when the chain cannot be read. Anybody can deploy a contract that answers anything.
      if (e instanceof ConfigError && !this.cfg.all) { await this.persist(); throw e; }
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
    await this.persist();
    return ok;
  }

  private async persist(): Promise<void> {
    await this.store.set(this.key, JSON.stringify(this.state, null, 2) + '\n');
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
      if (roles) Object.assign(settings, await this.guardSettings(vault, controllers, cancellers, tag));
    }
    const roles = settings.roles ?? '';
    const txNonce = Number(txNonceB);
    const queueNonce = Number(queueNonceB);
    const rec = settings.recovery;
    const ctx: DescribeCtx = {
      chainId, delay, vault, controllers, roles: roles || undefined, cooldown,
      recoveryDelay: rec?.delay, recoveryWait: rec?.made ? BigInt(rec.cooldown) : rec ? DEFAULT_RECOVERY_WAIT : undefined,
    };
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

    // The line of the recovery, while it can act. A line the watcher did not follow before (a first start, a recovery
    // that was turned on, a state from before the watcher knew of it) is read from its head.
    const live = Boolean(rec && roles && recoveryLive(settings, vault));
    const followed = !first && live && s.recoveryQueueNonce !== undefined && s.recoveryItems !== undefined && recoveryLive(s.settings!, vault);
    let rTx = 0, rQueue = 0;
    const rNew: Item[] = [];
    if (live) {
      const rd = rec!.delay;
      [rTx, rQueue] = (await Promise.all([this.callUint(rd, SEL.txNonce, tag), this.callUint(rd, SEL.queueNonce, tag)])).map(Number);
      const start = followed ? s.recoveryQueueNonce! : rTx;
      const byNonce = new Map<number, any>();
      if (followed && rQueue > start && head > s.lastBlock!) {
        for (const l of await this.getLogs(s.lastBlock! + 1, head, [TOPIC_TRANSACTION_ADDED], rd)) byNonce.set(Number(BigInt(l.topics[1])), l);
      }
      for (let n = start; n < rQueue; n++) {
        if (n >= start + FIRST_START_LOOKUP_LIMIT) {
          rNew.push(this.buildRecoveryItem(n, await this.callUint(rd, SEL.getTxCreatedAt + encUint(n), tag), undefined, delay, roles, settings.council));
          continue;
        }
        let log = byNonce.get(n);
        let createdAt: bigint;
        if (log) createdAt = await this.callUint(rd, SEL.getTxCreatedAt + encUint(n), tag);
        else ({ createdAt, log } = await this.locate(n, rd, head, tag));
        rNew.push(this.buildRecoveryItem(n, createdAt, log, delay, roles, settings.council));
      }
    }
    const rClosing = followed ? [...Object.values(s.recoveryItems!), ...rNew].filter((it) => it.nonce < rTx) : [];

    // Items that left the queue since the last poll: carried out, cancelled, or removed because their time ran out.
    // The Safe of the vault logs each call of a module and its result, in order; the replay reads them.
    const closing = [...Object.values(s.items), ...newItems].filter((it) => it.nonce < txNonce);
    let reasons = new Map<number, CloseReason>();
    let rReasons = new Map<number, CloseReason>();
    if (!first && (closing.length || rClosing.length)) {
      const events: VaultEvent[] = [];
      // A recovery is carried out by the recovery Delay, as a call of the shared Safe. That Safe can be the one of
      // the last poll or the one of now.
      const councils = rClosing.length ? [...new Set([s.settings!.council, settings.council].filter((c): c is string => Boolean(c)))] : [];
      const sources = [vault, ...councils];
      if (head > s.lastBlock!) {
        const logs = await this.getLogs(s.lastBlock! + 1, head, [[TOPIC_SAFE_MODULE_TRANSACTION, TOPIC_MODULE_SUCCESS, TOPIC_MODULE_FAILURE]], sources.length === 1 ? vault : sources);
        logs.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex ?? 0) - BigInt(y.logIndex ?? 0)));
        for (const l of logs) {
          const safe = String(l.address).toLowerCase();
          if (!sources.includes(safe)) continue;
          const block = Number(BigInt(l.blockNumber));
          const index = Number(BigInt(l.logIndex ?? 0));
          if (l.topics[0] === TOPIC_SAFE_MODULE_TRANSACTION) {
            const call = decodeModuleTransaction(l);
            // A call that cannot be read still opens a call, so that its result is not taken for another one.
            events.push(call ? { kind: 'call', block, index, safe, ...call } : { kind: 'call', block, index, safe, module: '', to: '', value: 0n, data: '0x', operation: 0 });
          } else {
            let module = '';
            try { module = addressWord(strip(l.topics[1] ?? '')); } catch { /* not the ABI: matches no call */ }
            events.push({ kind: 'result', block, index, safe, module, success: l.topics[0] === TOPIC_MODULE_SUCCESS });
          }
        }
      }
      const times = new Map<number, bigint>();
      for (const e of events) if (e.kind === 'result' && e.success && !times.has(e.block)) times.set(e.block, await this.timestampOf(e.block));
      const asTx = (list: Item[]) => new Map(list.map((it) => [it.nonce, { createdAt: BigInt(it.createdAt), to: it.to, value: it.value, data: it.data, operation: it.operation }]));
      if (closing.length) {
        reasons = replayQueue({
          from: s.txNonce ?? txNonce, to: txNonce, events: events.filter((e) => e.safe === vault), delay, execSafes: [vault], ownerSafe: vault, now,
          before: { cooldown: BigInt(s.settings!.cooldown), expiration: BigInt(s.settings!.expiration) },
          after: { cooldown, expiration },
          items: asTx(closing),
          timeOf: (block) => times.get(block) ?? now,
        });
      }
      if (rClosing.length) {
        const pr = s.settings!.recovery!;
        rReasons = replayQueue({
          from: s.recoveryTxNonce ?? rTx, to: rTx, events, delay: rec!.delay, execSafes: councils, ownerSafe: vault, now,
          before: { cooldown: BigInt(pr.cooldown), expiration: BigInt(pr.expiration) },
          after: { cooldown: BigInt(rec!.cooldown), expiration: BigInt(rec!.expiration) },
          items: asTx(rClosing),
          timeOf: (block) => times.get(block) ?? now,
        });
      }
    }

    // Commit phase.
    const times = (it: Item) => itemStatus(BigInt(it.createdAt), cooldown, expiration, now);
    const rTimes = (it: Item) => itemStatus(BigInt(it.createdAt), BigInt(rec!.cooldown), BigInt(rec!.expiration), now);
    /** What the "Watching" message tells already of an item: no alert for it follows. */
    const markSeen = (it: Item, st: ReturnType<typeof times>, exp: bigint) => {
      if (st.status === 'ready') it.sentReady = true;
      if (st.status === 'expired') { it.sentReady = true; it.sentExpiring = true; it.sentExpired = true; }
      if (st.expiresAt !== null && st.status === 'ready' && now >= st.expiresAt - expiryLead(exp)) it.sentExpiring = true;
    };
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
        markSeen(it, st, expiration);
        s.items[it.nonce] = it;
        lines.push(waitLine(it.summary, st));
      }
      const rLines: string[] = [];
      for (const it of rNew) {
        const st = rTimes(it);
        markSeen(it, st, BigInt(rec!.expiration));
        rLines.push(waitLine(it.summary, st));
      }
      s.recoveryItems = live ? Object.fromEntries(rNew.map((it) => [it.nonce, it])) : undefined;
      const worst = Math.max(3, ...newItems.map((i) => i.priority), ...rNew.map((i) => i.priority));
      const helpers = (settings.cancellers ?? []).filter((a) => !controllers.includes(a));
      const g = settings.guardian;
      const cancel = !rolesKnown ? ' The watcher does not know who can cancel a request. Set CHRONOBOX to check it.'
        : !roles ? ' This Chronobox cannot cancel a request.'
        : !(settings.cancellers ?? []).length ? ' Nobody can cancel a request right now.'
        : !helpers.length ? ' Only the wallet can cancel a request.'
        : g ? ` Guardian: ${g}. The wallet and the guardian can cancel a request, and together they can hand this Chronobox to a new wallet at once.` +
          (recoveryOn(settings) ? ` The guardian can start a recovery to a new wallet. A recovery waits ${fmtDuration(BigInt(rec!.cooldown))}, and the wallet and the guardian can stop it in that time.` : '')
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
          (newItems.length === 0 ? ' Nothing waits.' : ` ${newItems.length === 1 ? 'One request waits' : `${newItems.length} requests wait`}:\n${lines.join('\n')}`) +
          (rNew.length === 0 ? '' : `\n${rNew.length === 1 ? 'In the line of the recovery, one step waits' : `In the line of the recovery, ${rNew.length} steps wait`}:\n${rLines.join('\n')}`) +
          guardWarnings(settings, vault).map((w) => ` ${w}`).join(''),
      });
      s.lastHeartbeat = Number(now);
    } else {
      // The recovery line first: a recovery that was carried out explains the new wallet below.
      let recoveredTo: string | undefined;
      for (const it of rClosing.sort((a, b) => a.nonce - b.nonce)) {
        const r: CloseReason = rReasons.get(it.nonce) ?? { how: 'executed_or_cancelled' };
        const what = it.wallet ? `The recovery to ${it.wallet}` : 'The step in the line of the recovery';
        const [event, title, message] =
          r.how === 'executed' ? ['recovery_done', `Recovery done: ${it.summary}`,
            it.wallet ? `The recovery was carried out on ${fmtWhen(r.ts)}. The wallet ${it.wallet} now holds this Chronobox. ${(s.settings!.controllers).join(', ')} cannot withdraw or cancel any more. No money moved.`
              : `${what} was carried out on ${fmtWhen(r.ts)}. Open your Chronobox to see what changed.`]
          : r.how === 'cancelled' ? ['recovery_stopped', `Recovery stopped: ${it.summary}`, `${what} was stopped on ${fmtWhen(r.ts)}. The wallet of this Chronobox did not change.`]
          : r.how === 'expired' ? ['recovery_expired', `Recovery void: ${it.summary}`, `${what} was not carried out in time. It is void, and the wallet of this Chronobox did not change.`]
          : ['recovery_closed', `Recovery closed: ${it.summary}`, `${what} left the line. It was carried out, stopped, or void. The alert service could not see which. Open your Chronobox to see who holds it.`];
        if (r.how === 'executed' && it.wallet) recoveredTo = it.wallet;
        this.push({ event, nonce: it.nonce, priority: r.how === 'executed_or_cancelled' ? 5 : 3, at: Number(now), title, message });
        delete s.recoveryItems![it.nonce];
      }
      this.settingsAlert(s.settings!, settings, delay, vault, Number(now), { recoveredTo, recoveryWaited: Object.keys(s.recoveryItems ?? {}).length + rNew.filter((it) => it.nonce >= rTx).length > 0 });
      if (live) {
        s.recoveryItems = followed ? s.recoveryItems! : {};
        for (const it of rNew) {
          if (it.nonce < rTx) continue;
          const st = rTimes(it);
          s.recoveryItems[it.nonce] = it;
          if (st.status === 'expired') {
            it.sentReady = true; it.sentExpiring = true; it.sentExpired = true;
            const what = it.wallet ? `The recovery to ${it.wallet}` : 'The step in the line of the recovery';
            this.push({
              event: 'recovery_expired', nonce: it.nonce, priority: 3, at: Number(now),
              title: `Recovery void: ${it.summary}`,
              message: `${what} was not carried out before ${fmtWhen(st.expiresAt!)}. It is void now, and the wallet of this Chronobox did not change.`,
            });
            continue;
          }
          if (st.status === 'ready') it.sentReady = true;
          const wait = st.status === 'ready'
            ? `The wait ended on ${fmtWhen(st.readyAt)}. Anybody can carry it out now${st.expiresAt === null ? '' : `, until ${fmtWhen(st.expiresAt)}`}.`
            : `The wait ends on ${fmtWhen(st.readyAt)}${st.readyAt > now ? ` (in ${fmtDuration(st.readyAt - now)})` : ''}. After that, anybody can carry it out.`;
          this.push({
            event: 'recovery_started', nonce: it.nonce, priority: it.priority, at: Number(now),
            title: it.wallet ? `Recovery started: ${it.summary}` : 'Recovery line: a step that the app does not make',
            message: (it.wallet
              ? `The guardian started a recovery of this Chronobox on ${fmtWhen(BigInt(it.createdAt))}. It hands this Chronobox to the wallet ${it.wallet}. After that, ${controllers.join(', ')} cannot withdraw or cancel any more. No money moves.`
              : `The guardian put a step into the line of the recovery on ${fmtWhen(BigInt(it.createdAt))}. The Chronobox app does not make such a step. After the wait, it can change who holds this Chronobox. No money can move through it.`) +
              `\n\n${wait}\n\nIf you did not ask for this, open your Chronobox and stop it.`,
          });
        }
      }
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
      const r: CloseReason = reasons.get(it.nonce) ?? { how: 'executed_or_cancelled' };
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
          executed_or_cancelled: [`Closed: ${it.summary}`, `${Request(it)} is closed. It was carried out, or it was cancelled. The alert service could not see which.${money ? ' If nobody cancelled it, the money left this Chronobox.' : ''} Open your Chronobox to see it.`],
        }[r.how];
        this.push({
          // Money that may have left is told as loud as money that goes to another address.
          event: 'closed', nonce: it.nonce, priority: r.how === 'executed_or_cancelled' && money ? 4 : 3, at: Number(now),
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

    // The recovery: wait over, ends soon, void.
    if (!live) s.recoveryItems = undefined;
    for (const it of Object.values(s.recoveryItems ?? {}).sort((a, b) => a.nonce - b.nonce)) {
      const st = rTimes(it);
      const what = it.wallet ? `The recovery to ${it.wallet}` : 'The step in the line of the recovery';
      if (st.status === 'ready' && !it.sentReady) {
        it.sentReady = true;
        this.push({
          event: 'recovery_ready', nonce: it.nonce, priority: it.priority, at: Number(now),
          title: `Recovery wait over: ${it.summary}`,
          message: `The wait is over for ${lowerFirst(what)}. Anybody can carry it out now${st.expiresAt === null ? '' : `, until ${fmtWhen(st.expiresAt)}`}. ` +
            'Until then, the wallet and the guardian can still stop it.\n\nIf you did not ask for this, open your Chronobox and stop it now.',
        });
      }
      if (st.status === 'ready' && st.expiresAt !== null && !it.sentExpiring && now >= st.expiresAt - expiryLead(BigInt(rec!.expiration))) {
        it.sentExpiring = true;
        this.push({
          event: 'recovery_expires_soon', nonce: it.nonce, priority: 3, at: Number(now),
          title: `Recovery ends soon: ${it.summary}`,
          message: `${what} must be carried out before ${fmtWhen(st.expiresAt)}. That is in ${fmtDuration(st.expiresAt - now)}. After that it is void.`,
        });
      }
      if (st.status === 'expired' && !it.sentExpired) {
        it.sentReady = true; it.sentExpiring = true; it.sentExpired = true;
        this.push({
          event: 'recovery_expired', nonce: it.nonce, priority: 3, at: Number(now),
          title: `Recovery void: ${it.summary}`,
          message: `${what} was not carried out before ${fmtWhen(st.expiresAt!)}. It is void now, and the wallet of this Chronobox did not change.`,
        });
      }
    }

    // Heartbeat.
    const pending = Object.keys(s.items).length;
    const recoveries = Object.keys(s.recoveryItems ?? {}).length;
    if (!first && this.cfg.heartbeatHours > 0 && Number(now) - (s.lastHeartbeat ?? 0) >= this.cfg.heartbeatHours * 3600) {
      s.lastHeartbeat = Number(now);
      this.push({
        event: 'heartbeat', title: 'All quiet', priority: 2, at: Number(now),
        message: `${pending === 0 ? 'Nothing waits in this Chronobox.' : pending === 1 ? 'One request waits in this Chronobox.' : `${pending} requests wait in this Chronobox.`} ` +
          (recoveries === 0 ? '' : recoveries === 1 ? 'A recovery waits in its line. ' : `${recoveries} steps wait in the line of the recovery. `) +
          `The alert service looked on ${fmtWhen(now)}.`,
      });
    }

    s.settings = settings;
    s.txNonce = txNonce;
    s.queueNonce = queueNonce;
    s.recoveryTxNonce = live ? rTx : undefined;
    s.recoveryQueueNonce = live ? rQueue : undefined;
    s.lastBlock = head;
  }

  private settingsAlert(
    prev: Settings, next: Settings, delay: string, vault: string, at: number,
    opts: { recoveredTo?: string; recoveryWaited?: boolean } = {},
  ): void {
    const changes: string[] = [];
    const list = (a: string[]) => (a.length ? a.join(', ') : 'none');
    // A recovery that was carried out has said already who holds the Chronobox now.
    const recovered = opts.recoveredTo !== undefined && list(next.controllers) === opts.recoveredTo;
    if (prev.cooldown !== next.cooldown) changes.push(`The delay changed from ${fmtDuration(BigInt(prev.cooldown))} to ${fmtDuration(BigInt(next.cooldown))}.`);
    if (prev.expiration !== next.expiration) {
      const f = (v: string) => (v === '0' ? 'no limit' : fmtDuration(BigInt(v)));
      changes.push(`How long a request stays open after its wait changed from ${f(prev.expiration)} to ${f(next.expiration)}.`);
    }
    // One wallet for another: the line says who can cancel too, when both can cancel as they did before.
    const swapped = list(prev.controllers) !== list(next.controllers) && prev.controllers.length === 1 && next.controllers.length === 1;
    const cancelMoved = swapped && Boolean(next.roles) && (prev.cancellers ?? []).includes(prev.controllers[0]) &&
      (next.cancellers ?? []).includes(next.controllers[0]) && !(next.cancellers ?? []).includes(prev.controllers[0]);
    if (list(prev.controllers) !== list(next.controllers) && !recovered) {
      changes.push(swapped
        ? `The wallet of this Chronobox changed from ${prev.controllers[0]} to ${next.controllers[0]}. Only the new wallet can withdraw${cancelMoved ? ' and cancel' : ''}.`
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
    // The guardian and the recovery. A state from before the watcher knew of them has no such fields: this poll learns
    // them and tells nothing of them.
    const known = prev.guardian !== undefined && next.guardian !== undefined;
    // Members of the cancel contract that the lines of the guardian explain.
    const explained = new Set<string>();
    if (known) {
      const pg = prev.guardian!, ng = next.guardian!;
      if (pg !== ng) {
        if (!pg) changes.push(`${ng} is now the guardian of this Chronobox. The guardian can cancel every request. Together with the wallet, the guardian can hand this Chronobox to a new wallet at once.`);
        else if (!ng) changes.push(`This Chronobox has no guardian any more. ${pg} cannot cancel a request any more.`);
        else changes.push(`The guardian of this Chronobox changed from ${pg} to ${ng}.`);
      }
      for (const a of [pg, ng, prev.council ?? '', next.council ?? '']) if (a) explained.add(a);
      if (recovered || cancelMoved) for (const a of [...prev.controllers, ...next.controllers]) explained.add(a);
      const wait = (x: Settings) => BigInt(x.recovery?.cooldown ?? '0');
      const pOn = recoveryOn(prev), nOn = recoveryOn(next);
      if (!pOn && nOn) {
        changes.push(`The recovery is on. The guardian can start a recovery to a new wallet that the guardian chooses. A recovery waits ${fmtDuration(wait(next))}, and the wallet and the guardian can stop it in that time.`);
      } else if (pOn && !nOn) {
        changes.push(`The recovery is off. The guardian cannot start a recovery any more.${opts.recoveryWaited ? ' A recovery that waited can never be carried out now.' : ''}`);
      } else if (pOn && nOn && wait(prev) !== wait(next)) {
        changes.push(`A recovery now waits ${fmtDuration(wait(next))}. Before, it waited ${fmtDuration(wait(prev))}.`);
      }
    }
    const pc = prev.cancellers ?? [], nc = next.cancellers ?? [];
    const and = (a: string[]) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
    const gained = nc.filter((a) => !pc.includes(a) && !explained.has(a));
    // Without the cancel contract nobody can cancel, and the line above has said so.
    const lost = nr ? pc.filter((a) => !nc.includes(a) && !explained.has(a)) : [];
    if (gained.length) changes.push(`${and(gained)} can now cancel a request.`);
    if (lost.length) changes.push(`${and(lost)} cannot cancel a request any more.`);
    // What a new guardian looks like: two new addresses beside the wallet.
    if (!known && gained.filter((a) => !next.controllers.includes(a)).length === 2) {
      changes.push('With a guardian, these are the guardian and the Safe that the guardian shares with the wallet. That Safe can hand the Chronobox to a new wallet at once.');
    }
    // Who else can change the wallet: what is new is told now, what stays is told with every other change.
    const before = new Set(known ? guardWarnings(prev, vault) : []);
    const warnings = known ? guardWarnings(next, vault) : [];
    for (const w of warnings) if (!before.has(w)) changes.push(w);
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
    for (const w of warnings) if (before.has(w)) changes.push(w);
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
      if (this.email) channels.push('email');
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
    if (channel === 'email') {
      // The same for the email addresses.
      await this.email!.deliver(this.state.chainId ?? 0, vault, a);
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
