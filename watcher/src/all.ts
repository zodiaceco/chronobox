// --all: every Chronobox on one network.
//
// Everything a Chronobox does goes through its Delay, and the chain is public. So one watcher can watch every
// Chronobox without being told about each one: it finds new Chronoboxes by the Delay they deploy and by the
// transactions they queue. The alerts of a vault go to the Telegram chats that follow it, and to the webhook.
//
// What it knows is in the store, under "all" (the network) and under the address of each vault. Every poll and
// every question of the bot reads it again under the lock "all", because on Vercel a cron run and the webhook
// work at the same time, in different places.
import { MASTER_COPY, MODULE_PROXY_FACTORY, RevertError, TOPIC_MODULE_PROXY_CREATION, TOPIC_TRANSACTION_ADDED, hex, strip, toAddr } from './chain.ts';
import type { Config } from './config.ts';
import { itemStatus, waitLine } from './status.ts';
import { DryRunStore, FileStore, type Store } from './store.ts';
import type { Telegram } from './telegram.ts';
import { ConfigError, type FetchFn, type Log, errText } from './util.ts';
import { Watcher, parseState } from './watcher.ts';

type Known = {
  delay: string;
  active: boolean;
  heartbeatAt?: number;
  /** When the last read of this vault began (ms). The poll reads the vaults that waited longest first. */
  lookedAt?: number;
  /** Since when this vault is due and was skipped because the poll ran out of time (ms). */
  waitingSince?: number;
};

export type AllState = {
  version: 1;
  chainId?: number;
  lastBlock?: number;
  vaults: Record<string, Known>;
};

export type AllOptions = {
  fetch?: FetchFn;
  log?: Log;
  telegram?: Telegram;
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
};

export type PollOptions = {
  /** A time (ms since 1970). After it, the poll reads no further vault. They are read on the next poll. */
  deadline?: number;
};

/** How long a question of the bot waits for a poll that holds the lock. */
const ADOPT_WAIT_MS = 30_000;

export class AllWatcher {
  cfg: Config;
  state: AllState = { version: 1, vaults: {} };
  log: Log;
  /** Set by each poll. */
  report: PollReport = { late: 0, overdueSeconds: 0 };
  private opts: AllOptions;
  private probe: Watcher;
  private store: Store;
  private clock: () => number;

  constructor(cfg: Config, opts: AllOptions = {}) {
    this.cfg = cfg;
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    this.store = opts.store ?? (cfg.dryRun ? new DryRunStore(new FileStore(cfg.stateDir)) : new FileStore(cfg.stateDir));
    // Reads the chain only. It never loads or saves a state.
    this.probe = new Watcher({ ...cfg, dryRun: true }, { fetch: opts.fetch, log: opts.log });
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
        await this.save();
      }
      const known = s.vaults[vault];
      if (known.active) {
        await this.look(vault, known);
        await this.save();
      }
      return true;
    }, ADOPT_WAIT_MS);
  }

  /** What waits in a vault, from the last read: one line per item. */
  async pending(vault: string): Promise<string[]> {
    let st;
    try { st = parseState(await this.store.get(vault), vault); } catch { return []; }
    if (!st.settings) return [];
    const now = BigInt(Math.floor(Date.now() / 1000));
    return Object.values(st.items).sort((a, b) => a.nonce - b.nonce).map((it) =>
      waitLine(it.summary, itemStatus(BigInt(it.createdAt), BigInt(st.settings!.cooldown), BigInt(st.settings!.expiration), now)));
  }

  redact(msg: string): string { return this.probe.redact(msg); }

  /** The watcher of one vault: the same code as for a single vault. */
  private watcherOf(vault: string, known: Known): Watcher {
    return new Watcher({ ...this.cfg, chronobox: vault, delay: known.delay }, {
      fetch: this.opts.fetch, telegram: this.opts.telegram, store: this.store, key: vault, where: `The state of ${vault}`,
      log: (m) => this.log(`${vault.slice(0, 10)}: ${m}`),
    });
  }

  /** Reads one vault and sends its alerts. False if the chain could not be read. */
  private async look(vault: string, known: Known): Promise<boolean> {
    // Saved before the read: if the function is killed during it, this vault goes to the back of the line, and it
    // cannot block every poll after this one.
    known.lookedAt = this.clock();
    delete known.waitingSince;
    await this.save();
    const w = this.watcherOf(vault, known);
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
    const tag = hex(head);
    const touched = new Set<string>();
    const from = s.lastBlock !== undefined ? s.lastBlock + 1 : this.cfg.startBlock ?? head + 1;
    // A long way behind (the first start with START_BLOCK, or after an outage): one part per poll.
    const to = this.cfg.maxScanBlocks > 0 ? Math.min(head, from + this.cfg.maxScanBlocks - 1) : head;
    if (from <= to) {
      const logs = await this.probe.getLogs(from, to, [[TOPIC_MODULE_PROXY_CREATION, TOPIC_TRANSACTION_ADDED]]);
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
      if (to < head) this.log(`searched up to block ${to}, ${head - to} blocks to go`);
    }
    s.chainId = chainId;
    s.lastBlock = to;
    this.announce();
    return { chainId, now, touched };
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
    try {
      const r = await this.scan();
      now = r.now;
      for (const vault of r.touched) s.vaults[vault].active = true;
      await this.save();
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      ok = false;
      this.log(`search for Chronoboxes failed: ${errText(e)}`);
    }
    if (s.chainId === undefined) return false;
    await this.opts.telegram?.ready();
    const beat = this.cfg.heartbeatHours * 3600;
    const chainId = s.chainId;
    const due = Object.entries(s.vaults).filter(([vault, known]) => {
      // An "all quiet" message makes sense only where somebody can hear it.
      const heard = Boolean(this.cfg.webhookUrl || this.cfg.dryRun) || (this.opts.telegram?.subscribers(chainId, vault).length ?? 0) > 0;
      return known.active || (heard && beat > 0 && now - (known.heartbeatAt ?? 0) >= beat);
    });
    // The vaults that waited longest first. A poll that runs out of time goes on there the next time, so vaults
    // that are always busy cannot keep the others from being read.
    due.sort(([, a], [, b]) => (a.lookedAt ?? 0) - (b.lookedAt ?? 0));
    let late = 0;
    let oldest = this.clock();
    for (const [vault, known] of due) {
      if (opts.deadline !== undefined && this.clock() > opts.deadline) {
        late++;
        known.waitingSince ??= this.clock();
        oldest = Math.min(oldest, known.waitingSince);
        continue;
      }
      try {
        if (!(await this.look(vault, known))) ok = false;
      } catch (e) {
        if (e instanceof ConfigError) throw e;
        ok = false;
        this.log(`${vault}: ${errText(e)}`);
      }
    }
    this.report = { late, overdueSeconds: late ? Math.round((this.clock() - oldest) / 1000) : 0 };
    if (late) this.log(`out of time: ${late} Chronobox${late === 1 ? '' : 'es'} will be read on the next poll (the oldest waits ${this.report.overdueSeconds}s)`);
    await this.save();
    return ok;
  }
}
