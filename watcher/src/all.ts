// --all: every Chronobox on one network.
//
// Everything a Chronobox does goes through its Delay, and the chain is public. So one watcher can watch every
// Chronobox without being told about each one: it finds new Chronoboxes by the Delay that they deploy through the
// Zodiac factory, and older ones when somebody asks for their alerts. The alerts of a vault go to the Telegram
// chats and the email addresses that follow it, and to the webhook.
//
// The watcher reads logs only from contracts it chose: the factory, and the Delays of the Chronoboxes it knows (the
// Delay for withdrawals, and the Recovery Delay at its fixed address).
// Anybody can deploy contracts that emit any event, so logs from every contract would let anybody fill a poll.
//
// What it knows is in the store, under "all" (the network) and under the address of each vault. Every poll and
// every question of the bot reads it again under the lock "all", because on Vercel a cron run and the webhook
// work at the same time, in different places.
import {
  MASTER_COPY, MODULE_PROXY_FACTORY, RevertError, TOPIC_DISABLED_MODULE, TOPIC_ENABLED_MODULE, TOPIC_MODULE_PROXY_CREATION, TOPIC_TRANSACTION_ADDED,
  type RpcCounts, callsByMethod, encAddr, hex, strip, toAddr, totalCalls,
} from './chain.ts';
import { predictRecoveryDelay } from './guardian.ts';
import type { Config } from './config.ts';
import { itemStatus, waitLine } from './status.ts';
import { BusyError, DryRunStore, FileStore, type Store } from './store.ts';
import type { Email } from './email.ts';
import type { Network, Telegram } from './telegram.ts';
import { ConfigError, type FetchFn, type Log, errText } from './util.ts';
import { type ChainNow, type ProxyKinds, Watcher, parseState } from './watcher.ts';

type Known = {
  delay: string;
  active: boolean;
  heartbeatAt?: number;
  /** When the last read of this vault began (ms). The poll reads the vaults that waited longest first. */
  lookedAt?: number;
  /** Since when this vault is due and was skipped because the poll ran out of time (ms). */
  waitingSince?: number;
  /** Reads in a row that failed while the chain could be read, and when to try again (ms). */
  failures?: number;
  retryAt?: number;
};

export type AllState = {
  version: 1;
  chainId?: number;
  lastBlock?: number;
  vaults: Record<string, Known>;
  /** Delays from the factory that were not checked yet. Saved with lastBlock, so no search is done twice. */
  queue?: string[];
  /** Checks of a Delay in the queue that failed while the chain could be read. */
  tries?: Record<string, number>;
};

/** The most Delays that wait to be checked. More is a flood; the rest is dropped (see `scan`). */
export const MAX_QUEUE = 1000;
/** Delays checked at the same time. */
const CHECK_PARALLEL = 8;
/** A Delay whose check fails this often, while the chain can be read, is dropped. */
const CHECK_TRIES = 3;
/** A vault whose read fails while the chain can be read waits 1, 2, 4 ... minutes before the next read, an hour at most. */
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;
/** Delays per eth_getLogs request for the requests of known Chronoboxes. */
const ADDRESSES_PER_QUERY = 100;

export type AllOptions = {
  fetch?: FetchFn;
  log?: Log;
  telegram?: Telegram;
  email?: Email;
  /** Where the state of this network is kept. Default: the folder STATE_DIR (in memory only with --dry-run). */
  store?: Store;
  /** The time in ms, for the deadline of a poll and the order of the vaults. Tests set it. */
  clock?: () => number;
};

/** What the last poll could not do in time. */
export type PollReport = {
  /** Vaults that were due and were not read, for lack of time. */
  late: number;
  /** How long the vault that has waited longest has been due without being read. */
  overdueSeconds: number;
  /** Delays from the factory that still wait to be checked. */
  queued: number;
  /** Vaults whose read failed in this poll while the chain could be read. They wait longer each time. */
  failing: number;
};

/** The requests to the RPC in the last poll: for the search and the new Delays, and for the reads of the vaults. */
export type PollCalls = {
  scan: RpcCounts;
  vaults: RpcCounts;
  /** Vaults that the poll read. */
  read: number;
};

export type PollOptions = {
  /** A time (ms since 1970). After it, the poll reads no further vault. They are read on the next poll. */
  deadline?: number;
};

/**
 * How long a question of the bot waits for the lock of one vault, or of the list of adopted vaults. Neither is held
 * for a whole poll: the network-wide lock is the poll's alone, so a question cannot keep a poll from running.
 */
const ADOPT_WAIT_MS = 30_000;
/** A vault that somebody asked for is read for the answer at most once in this time, however often they ask (s). */
const ADOPT_READ_EVERY_S = 300;
/** At most this many vaults wait in the list of adopted vaults until a poll takes them in. */
const MAX_ADOPTED = 1000;

export class AllWatcher {
  cfg: Config;
  state: AllState = { version: 1, vaults: {} };
  log: Log;
  /** Set by each poll. */
  report: PollReport = { late: 0, overdueSeconds: 0, queued: 0, failing: 0 };
  /** Set by each poll. A question of the bot that reads a vault is not in it. */
  calls: PollCalls = { scan: {}, vaults: {}, read: 0 };
  private opts: AllOptions;
  private probe: Watcher;
  /** Shared by every read of this network, across polls: proxy code does not change. */
  private proxyKinds: ProxyKinds = new Map();
  private store: Store;
  private clock: () => number;

  constructor(cfg: Config, opts: AllOptions = {}) {
    this.cfg = cfg;
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    this.store = opts.store ?? (cfg.dryRun ? new DryRunStore(new FileStore(cfg.stateDir)) : new FileStore(cfg.stateDir));
    // Reads the chain only. It never loads or saves a state.
    this.probe = new Watcher({ ...cfg, dryRun: true }, { fetch: opts.fetch, log: opts.log, proxyKinds: this.proxyKinds });
    this.log = this.probe.log;
  }

  /** A watcher that has read its state, so that the bot knows its network at once. */
  static async open(cfg: Config, opts: AllOptions = {}): Promise<AllWatcher> {
    const w = new AllWatcher(cfg, opts);
    await w.load();
    return w;
  }

  /** Runs `fn` alone, on the newest state. */
  private once<T>(fn: () => Promise<T>, waitMs: number): Promise<T> {
    return this.store.lock('all', async () => {
      await this.load();
      return fn();
    }, { waitMs });
  }

  /** Reads the state. Then the bot knows the network, if the watcher has read its chain before. */
  async load(): Promise<void> {
    const text = await this.store.get('all');
    if (text === null) {
      this.state = { version: 1, vaults: {} };
    } else {
      try {
        const s = JSON.parse(text);
        if (s?.version !== 1 || typeof s.vaults !== 'object') throw new Error('unknown format');
        this.state = s as AllState;
      } catch (e) {
        throw new ConfigError(`The state of --all is not valid (${errText(e)}). Fix or remove it.`);
      }
    }
    this.announce();
  }

  private async save(): Promise<void> {
    await this.store.set('all', JSON.stringify(this.state, null, 2) + '\n');
  }

  /** Tells the Telegram bot and the email pages which network this watcher reads, as soon as it knows. */
  private announce(): void {
    const chainId = this.state.chainId;
    if (chainId === undefined) return;
    const network: Network = { chainId, adopt: (vault) => this.adopt(vault), pending: (vault) => this.pending(vault) };
    this.opts.telegram?.addNetwork(network);
    this.opts.email?.addNetwork(network);
  }

  /**
   * Somebody asked for the alerts of this vault. If it is a Chronobox, the watcher knows it from now on, also when it
   * is older than the first block that the watcher searched. False if the address is not a Chronobox.
   *
   * Anybody can ask, as often as they like, so nothing here holds the lock of the network: that is the poll's, and a
   * poll that cannot get it does not run. The check reads the chain without a lock. A new vault goes into its own
   * small list ("adopted"), which the next poll takes in. Its first read, for the answer, holds the lock of that one
   * vault only, which the poll also takes before it reads the vault. A vault the watcher knows is not read here at all.
   */
  async adopt(vault: string): Promise<boolean> {
    if (this.state.chainId === undefined) throw new Error('the network is not known yet');
    if (this.state.vaults[vault]) return true;
    const adopted = await this.adopted();
    let delay: string | null = adopted[vault] ?? null;
    if (!delay) {
      let mods: string[];
      try { mods = await this.probe.modules(vault, 'latest'); } catch (e) {
        if (e instanceof RevertError) return false;
        throw e;
      }
      // A Chronobox has two modules at most.
      for (const m of mods.slice(0, 2)) {
        if ((await this.probe.chronoboxOf(m, 'latest')) === vault) { delay = m; break; }
      }
      if (!delay) return false;
      const found = delay;
      const added = await this.store.lock('adopted', async () => {
        const list = await this.adopted();
        if (list[vault]) return true;
        if (Object.keys(list).length >= MAX_ADOPTED) return false;
        list[vault] = found;
        await this.store.set('adopted', JSON.stringify(list));
        return true;
      }, { waitMs: ADOPT_WAIT_MS });
      if (!added) throw new Error(`${MAX_ADOPTED} adopted Chronoboxes wait for a poll already`);
      this.log(`new Chronobox ${vault} (Delay ${delay}), found because somebody asked for its alerts`);
    }
    // The first read, so that the answer can say what waits. Every question waits for it, under the lock of this vault:
    // one that came a moment after another must not answer from a read that has not ended. Once the vault was read and
    // its state saved, a new read is done once in a while at most: the poll reads it anyway.
    const known: Known = { delay, active: true };
    await this.store.lock(`vault:${vault}`, async () => {
      if ((await this.readState(vault)) && !(await this.store.claim(`adopt-read:${vault}`, ADOPT_READ_EVERY_S))) return;
      await this.watcherOf(vault, known).poll();
      // The window starts when there is a saved read to answer from, not before.
      if (await this.readState(vault)) await this.store.claim(`adopt-read:${vault}`, ADOPT_READ_EVERY_S);
    }, { waitMs: ADOPT_WAIT_MS });
    return true;
  }

  /** The saved state of a vault, if it was read to the end once. Null if not. */
  private async readState(vault: string) {
    try {
      const st = parseState(await this.store.get(vault), vault);
      return st.settings ? st : null;
    } catch {
      return null;
    }
  }

  /** The vaults that somebody asked for, and that no poll has taken in yet: vault to Delay. */
  private async adopted(): Promise<Record<string, string>> {
    const text = await this.store.get('adopted');
    if (!text) return {};
    try {
      const list = JSON.parse(text);
      return list && typeof list === 'object' ? list : {};
    } catch {
      return {};
    }
  }

  /** Takes the adopted vaults into the state of the network. Only a poll calls this, with the network's lock. */
  private async takeAdopted(): Promise<void> {
    const s = this.state;
    const taken = await this.store.lock('adopted', async () => {
      const list = await this.adopted();
      if (Object.keys(list).length === 0) return false;
      for (const [vault, delay] of Object.entries(list)) s.vaults[vault] ??= { delay, active: true };
      await this.store.set('adopted', '{}');
      return true;
    }, { waitMs: 5_000 }).catch((e) => {
      // A question that holds the list a moment too long: the next poll takes the vaults in.
      this.log(`the adopted Chronoboxes wait for the next poll: ${errText(e)}`);
      return false;
    });
    if (taken) await this.save();
  }

  /**
   * What waits in a vault, from the last read: one line per item. Null if the vault was never read to the end: that is
   * "not known", never "nothing waits".
   */
  async pending(vault: string): Promise<string[] | null> {
    const st = await this.readState(vault);
    if (!st?.settings) return null;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const rec = st.settings.recovery;
    const read = Object.keys(st.recoveryItems ?? {}).length;
    const behind = st.recoveryQueueNonce !== undefined && st.recoveryTxNonce !== undefined ? st.recoveryQueueNonce - st.recoveryTxNonce - read : 0;
    return [
      ...Object.values(st.items).sort((a, b) => a.nonce - b.nonce).map((it) =>
        waitLine(it.summary, itemStatus(BigInt(it.createdAt), BigInt(st.settings!.cooldown), BigInt(st.settings!.expiration), now))),
      ...(rec ? Object.values(st.recoveryItems ?? {}).sort((a, b) => a.nonce - b.nonce).map((it) =>
        waitLine(it.summary, itemStatus(BigInt(it.createdAt), BigInt(rec.cooldown), BigInt(rec.expiration), now))) : []),
      ...(behind > 0 ? [`${behind} more step${behind === 1 ? '' : 's'} in the line of the recovery. One stop removes all of them.`] : []),
    ];
  }

  redact(msg: string): string { return this.probe.redact(msg); }

  /** The watcher of one vault: the same code as for a single vault. */
  private watcherOf(vault: string, known: Known, rpcCounts?: RpcCounts, chain?: ChainNow): Watcher {
    return new Watcher({ ...this.cfg, chronobox: vault, delay: known.delay }, {
      fetch: this.opts.fetch, telegram: this.opts.telegram, email: this.opts.email, store: this.store, key: vault, where: `The state of ${vault}`,
      log: (m) => this.log(`${vault.slice(0, 10)}: ${m}`), rpcCounts, chain, proxyKinds: this.proxyKinds,
    });
  }

  /**
   * Reads one vault and sends its alerts. False if the chain could not be read. Null if a question of the bot reads
   * this vault right now: that read sends its alerts, and this poll goes on with the next vault.
   */
  private async look(vault: string, known: Known, calls: PollCalls, chain: ChainNow | undefined): Promise<boolean | null> {
    // Saved before the read: if the function is killed during it, this vault goes to the back of the line, and it
    // cannot block every poll after this one.
    known.lookedAt = this.clock();
    delete known.waitingSince;
    await this.save();
    const w = this.watcherOf(vault, known, calls.vaults, chain);
    let ok: boolean;
    try {
      ok = await this.store.lock(`vault:${vault}`, () => { calls.read++; return w.poll(); }, { waitMs: 0 });
    } catch (e) {
      if (e instanceof BusyError) return null;
      throw e;
    }
    const ws = w.state;
    known.active = Object.keys(ws.items).length > 0 || Object.keys(ws.recoveryItems ?? {}).length > 0 ||
      ws.outbox.length > 0 || ws.failCount > 0 || ws.lastBlock === undefined;
    known.heartbeatAt = ws.lastHeartbeat;
    return ok;
  }

  /**
   * Which known Chronoboxes queued something, and which Delays the factory made. The new Delays go into the queue,
   * and the queue is saved with the new lastBlock before any of them is checked: a search is never done twice, also
   * when the function is killed afterwards. Returns the vaults to look at now.
   */
  private async scan(probe: Watcher): Promise<{ chain: ChainNow; now: number; touched: Set<string> }> {
    const s = this.state;
    const rpc = probe.rpc;
    const chainId = Number(await rpc.call('eth_chainId'));
    if (this.cfg.chainId !== undefined && chainId !== this.cfg.chainId) {
      throw new ConfigError(`The RPC of chain ${this.cfg.chainId} is on chain ${chainId}. Check RPC_URL_${this.cfg.chainId}.`);
    }
    if (s.chainId !== undefined && s.chainId !== chainId) {
      throw new ConfigError(`The RPC is on chain ${chainId}, but STATE_DIR belongs to chain ${s.chainId}. Check RPC_URL.`);
    }
    const head = Number(await rpc.call('eth_blockNumber'));
    const block = await rpc.call('eth_getBlockByNumber', [hex(head), false]);
    if (!block) throw new Error(`block ${head} not found`);
    const now = Number(BigInt(block.timestamp));
    const touched = new Set<string>();
    const from = s.lastBlock !== undefined ? s.lastBlock + 1 : this.cfg.startBlock ?? head + 1;
    // A long way behind (the first start with START_BLOCK, or after an outage): one part per poll.
    const to = this.cfg.maxScanBlocks > 0 ? Math.min(head, from + this.cfg.maxScanBlocks - 1) : head;
    if (from <= to) {
      const byDelay = new Map(Object.entries(s.vaults).map(([vault, k]) => [k.delay, vault]));
      // The requests of the Chronoboxes it knows, and a wallet that comes or goes without a request: wallet and
      // guardian together, or a recovery. Only their Delays can emit these logs. The Recovery Delay of a vault may
      // not be made: then it has no logs.
      const watched = new Map(byDelay);
      for (const vault of Object.keys(s.vaults)) watched.set(predictRecoveryDelay(vault), vault);
      const all = [...watched.keys()];
      for (let i = 0; i < all.length; i += ADDRESSES_PER_QUERY) {
        for (const l of await probe.getLogs(from, to, [[TOPIC_TRANSACTION_ADDED, TOPIC_ENABLED_MODULE, TOPIC_DISABLED_MODULE]], all.slice(i, i + ADDRESSES_PER_QUERY))) {
          const vault = watched.get(String(l.address).toLowerCase());
          if (vault) touched.add(vault);
        }
      }
      // New Delays, from the factory. Every Chronobox deploys its Delay there.
      const queue = s.queue ?? [];
      const waiting = new Set(queue);
      let dropped = 0;
      const created = await probe.getLogs(from, to, [TOPIC_MODULE_PROXY_CREATION, null, '0x' + encAddr(MASTER_COPY.delay)], MODULE_PROXY_FACTORY);
      for (const l of created) {
        if (String(l.address).toLowerCase() !== MODULE_PROXY_FACTORY || toAddr(strip(l.topics[2] ?? '')) !== MASTER_COPY.delay) continue;
        const delay = toAddr(strip(l.topics[1]));
        if (watched.has(delay) || waiting.has(delay)) continue;
        // A flood of Delays is dropped. A Chronobox in it is still found when somebody presses Start for it.
        if (queue.length >= MAX_QUEUE) { dropped++; continue; }
        queue.push(delay);
        waiting.add(delay);
      }
      if (dropped) this.log(`${dropped} new Delays were not queued: ${MAX_QUEUE} wait to be checked already`);
      s.queue = queue;
      if (to < head) this.log(`searched up to block ${to}, ${head - to} blocks to go`);
    }
    s.chainId = chainId;
    s.lastBlock = to;
    this.announce();
    return { chain: { chainId, head, timestamp: BigInt(block.timestamp) }, now, touched };
  }

  /**
   * Checks the Delays in the queue, a few at a time, until each one that was there has had its turn or `deadline` is
   * past. One batch always runs, so the queue goes down on every poll. Saved after each batch. Call it only when the
   * chain could be read in this poll: then a check that fails is a problem of that Delay (anybody can deploy a Delay
   * whose Safe answers anything). It goes to the back of the queue, and after CHECK_TRIES it is dropped.
   */
  private async check(probe: Watcher, deadline: number | undefined): Promise<number> {
    const s = this.state;
    let found = 0;
    let turns = (s.queue ?? []).length;
    let first = true;
    while (turns > 0) {
      if (!first && deadline !== undefined && this.clock() >= deadline) break;
      first = false;
      const batch = s.queue!.slice(0, Math.min(CHECK_PARALLEL, turns));
      turns -= batch.length;
      const results = await Promise.allSettled(batch.map((delay) => probe.chronoboxOf(delay, 'latest')));
      const again: string[] = [];
      results.forEach((r, i) => {
        const delay = batch[i];
        if (r.status === 'rejected') {
          const tries = ((s.tries ??= {})[delay] ?? 0) + 1;
          if (tries >= CHECK_TRIES) {
            delete s.tries[delay];
            this.log(`gave up on the new Delay ${delay} after ${tries} tries: ${errText(r.reason)}`);
          } else {
            s.tries[delay] = tries;
            again.push(delay);
          }
          return;
        }
        if (s.tries) delete s.tries[delay];
        const vault = r.value;
        if (!vault || s.vaults[vault]) return;
        s.vaults[vault] = { delay, active: true };
        found++;
        this.log(`new Chronobox ${vault} (Delay ${delay})`);
      });
      s.queue = [...s.queue!.slice(batch.length), ...again];
      if (s.tries && Object.keys(s.tries).length === 0) delete s.tries;
      await this.save();
    }
    return found;
  }

  /**
   * One poll. A vault with an empty queue cannot change until it queues something, so only vaults
   * with something pending, with a new queued transaction or with a heartbeat due are read.
   * Throws BusyError at once if another poll or a question of the bot holds the lock.
   */
  poll(opts: PollOptions = {}): Promise<boolean> {
    return this.once(() => this.pollNow(opts), 0);
  }

  private async pollNow(opts: PollOptions): Promise<boolean> {
    const s = this.state;
    let ok = true;
    let now = Math.floor(Date.now() / 1000);
    // Counted apart from the bot's questions, which use this.probe at the same time.
    const calls: PollCalls = { scan: {}, vaults: {}, read: 0 };
    this.calls = calls;
    const probe = new Watcher({ ...this.cfg, dryRun: true }, { fetch: this.opts.fetch, log: this.opts.log, rpcCounts: calls.scan, proxyKinds: this.proxyKinds });
    // What the search read of the chain. The reads of the vaults use it: one head for the whole poll.
    let chain: ChainNow | undefined;
    try {
      const r = await this.scan(probe);
      now = r.now;
      chain = r.chain;
      for (const vault of r.touched) s.vaults[vault].active = true;
      await this.save();
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      ok = false;
      this.log(`search for Chronoboxes failed: ${errText(e)}`);
    }
    if (s.chainId === undefined) return false;
    await this.takeAdopted();
    // New Delays first, so that a new Chronobox is read in this poll. They get a quarter of the time at most (one
    // batch always), so that a flood of Delays cannot take the time of the Chronoboxes that are known.
    const started = this.clock();
    // Only when the chain could be read: else a failed check says nothing about the Delay.
    if (ok) await this.check(probe, opts.deadline === undefined ? undefined : started + Math.max(0, opts.deadline - started) / 4);
    await this.opts.telegram?.ready();
    const beat = this.cfg.heartbeatHours * 3600;
    const chainId = s.chainId;
    const due = Object.entries(s.vaults).filter(([vault, known]) => {
      // An "all quiet" message makes sense only where somebody can hear it. Email gets none, so an address is no reason.
      const heard = Boolean(this.cfg.webhookUrl || this.cfg.dryRun) || (this.opts.telegram?.subscribers(chainId, vault).length ?? 0) > 0;
      if (known.retryAt !== undefined && known.retryAt > this.clock()) return false;
      return known.active || (heard && beat > 0 && now - (known.heartbeatAt ?? 0) >= beat);
    });
    // The vaults that waited longest first. A poll that runs out of time goes on there the next time, so vaults
    // that are always busy cannot keep the others from being read.
    due.sort(([, a], [, b]) => (a.lookedAt ?? 0) - (b.lookedAt ?? 0));
    let late = 0;
    let failing = 0;
    let oldest = this.clock();
    for (const [vault, known] of due) {
      if (opts.deadline !== undefined && this.clock() > opts.deadline) {
        late++;
        known.waitingSince ??= this.clock();
        oldest = Math.min(oldest, known.waitingSince);
        continue;
      }
      // A vault that cannot be read is a problem of that vault, not of the network: anybody can deploy a Safe that
      // answers anything. Its readers are told (Watcher), and it waits longer each time, while the chain can be read.
      let read: boolean | null = false;
      try {
        read = await this.look(vault, known, calls, chain);
      } catch (e) {
        this.log(`${vault}: ${errText(e)}`);
      }
      if (read === null) continue;
      if (read) {
        delete known.failures;
        delete known.retryAt;
      } else {
        failing++;
        if (ok) {
          known.failures = (known.failures ?? 0) + 1;
          known.retryAt = this.clock() + Math.min(RETRY_FIRST_MS * 2 ** (known.failures - 1), RETRY_MAX_MS);
        }
      }
    }
    this.report = { late, overdueSeconds: late ? Math.round((this.clock() - oldest) / 1000) : 0, queued: 0, failing };
    if (failing) this.log(`${failing} Chronobox${failing === 1 ? '' : 'es'} could not be read`);
    if (late) this.log(`out of time: ${late} Chronobox${late === 1 ? '' : 'es'} will be read on the next poll (the oldest waits ${this.report.overdueSeconds}s)`);
    this.report.queued = (s.queue ?? []).length;
    this.logCalls(calls);
    await this.save();
    // Stops that the other followers were not told of yet, because one was told in the last hour.
    await this.opts.telegram?.sendNotices().catch((e) => this.log(`telegram: could not send the notices of stops: ${errText(e)}`));
    await this.opts.email?.sendNotices().catch((e) => this.log(`email: could not send the notices of stops: ${errText(e)}`));
    return ok;
  }

  /** One line per poll: how many requests went to the RPC, and for what. */
  private logCalls(calls: PollCalls): void {
    const scan = totalCalls(calls.scan);
    const vaults = totalCalls(calls.vaults);
    const by: RpcCounts = { ...calls.scan };
    for (const [m, n] of Object.entries(calls.vaults)) by[m] = (by[m] ?? 0) + n;
    this.log(`rpc: ${scan + vaults} requests (search ${scan}, ${calls.read} Chronobox${calls.read === 1 ? '' : 'es'} read ${vaults})` +
      (scan + vaults ? `: ${callsByMethod(by)}` : ''));
  }
}
