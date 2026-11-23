// The watcher of one Chronobox: one poll reads the chain, turns what changed into alerts, and sends them.
// The CLI runs it for one vault. --all and the service run one for each vault that something waits in.
import * as path from 'node:path';
import {
  BURN_ADDRESS, MASTER_COPY, RevertError, Rpc, SENTINEL, SEL, TOPIC_SAFE_MODULE_TRANSACTION, TOPIC_TRANSACTION_ADDED,
  TOPIC_TX_NONCE_SET, ZERO_ADDRESS, cleanSymbol, decodeAbiString, decodeAddressArray, decodeAddresses, decodeCancel,
  decodeAddress, decodeTransactionAdded, decodeUint, encAddr, encUint, hex, proxyCode, toAddr, toBig, word,
} from './chain.ts';
import type { Config } from './config.ts';
import { type DescribeCtx, type TokenMeta, describeTx } from './describe.ts';
import { fmtDuration, fmtWhen, lowerFirst, networkName } from './format.ts';
import { type CloseReason, type NonceSet, closeReason, expiryLead, itemStatus, waitLine } from './status.ts';
import { DryRunStore, FileStore, type Store } from './store.ts';
import type { Telegram } from './telegram.ts';
import type { Alert, Item, Settings, State } from './types.ts';
import { ConfigError, type FetchFn, type Log, defaultLog, errText } from './util.ts';

const FIRST_START_LOOKUP_LIMIT = 50;

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
  private store: Store;
  private key: string;
  private where: string;
  private loaded = false;

  constructor(cfg: Config, opts: WatcherOptions = {}) {
    this.cfg = cfg;
    this.telegram = opts.telegram;
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
    if (this.cfg.telegramKey) out = out.split(this.cfg.telegramKey).join('[telegram key]');
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

  private async tokenMeta(token: string, tag: string): Promise<TokenMeta> {
    try {
      const [sym, dec] = await Promise.all([this.call(token, SEL.symbol, tag), this.call(token, SEL.decimals, tag)]);
      const decimals = Number(decodeUint(dec));
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
