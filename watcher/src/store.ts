// Where the watcher keeps what it knows. The CLI keeps files in a folder. The service on Vercel keeps keys in
// Upstash Redis (redis.ts). The watcher reads and writes whole JSON values, one per key:
//
//   all         what --all knows about one network: the last block it searched, and the Chronoboxes it found
//   <vault>     what the watcher knows about one Chronobox: what waits, and what it still has to send
//   telegram    the sealed list of the chats that follow a Chronobox
//   email       the sealed list of the email addresses that follow a Chronobox
//
// A lock keeps two writers apart. In the CLI there is one process, and a lock is a queue in memory. On Vercel a
// cron run and the Telegram webhook run at the same time, in different places, and a lock is a key in Redis.
import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { ConfigError, errText } from './util.ts';

/** The lock is held by somebody else, and did not come free in time. */
export class BusyError extends Error {
  constructor(name: string) { super(`${name} is busy`); }
}

export type LockOptions = {
  /** How long to wait for the lock. 0: do not wait, throw BusyError at once. */
  waitMs: number;
};

export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Runs `fn` while nobody else holds the lock `name`. Throws BusyError if it does not come free within `waitMs`. */
  lock<T>(name: string, fn: () => Promise<T>, opts: LockOptions): Promise<T>;
  /** True the first time a key is claimed within `ttlSeconds`, false after that. For updates that Telegram may send twice. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  /** Counts one more under `key` and returns the count. The count starts at 1 again `ttlSeconds` after its first hit. For limits per hour. */
  hit(key: string, ttlSeconds: number): Promise<number>;
  /** The same store, with every key and lock under `prefix`. */
  scope(prefix: string): Store;
}

/** Locks for one process: each name is a queue. Nothing else can take them, so they never time out. */
class LocalLocks {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.tails.set(name, tail);
    void tail.then(() => { if (this.tails.get(name) === tail) this.tails.delete(name); });
    return run;
  }
}

/** Counters for one process, as `hit` wants them. */
class LocalCounters {
  private counts = new Map<string, { n: number; until: number }>();
  hit(key: string, ttlSeconds: number): number {
    const now = Date.now();
    const c = this.counts.get(key);
    if (!c || c.until <= now) {
      // Old counters go, so that the map does not grow for ever.
      for (const [k, v] of this.counts) if (v.until <= now) this.counts.delete(k);
      this.counts.set(key, { n: 1, until: now + ttlSeconds * 1000 });
      return 1;
    }
    return ++c.n;
  }
}

/**
 * A folder. Key `k` is the file `k.json`, and `scope` is a subfolder. Each write goes to a new file that then
 * replaces the old one, so a crash leaves the old value or the new one, never half of it. Only one process may
 * use a folder at a time.
 */
export class FileStore implements Store {
  private dir: string;
  private fileOf: (key: string) => string;
  private locks: LocalLocks;
  private claimed: Map<string, number>;
  private counters: LocalCounters;

  /** `fileOf` puts a key somewhere else: the CLI for one Chronobox keeps its state in STATE_FILE. */
  constructor(dir: string, fileOf?: (key: string) => string, shared?: { locks: LocalLocks; claimed: Map<string, number>; counters: LocalCounters }) {
    this.dir = dir;
    this.fileOf = fileOf ?? ((key) => path.join(dir, `${key}.json`));
    this.locks = shared?.locks ?? new LocalLocks();
    this.claimed = shared?.claimed ?? new Map();
    this.counters = shared?.counters ?? new LocalCounters();
  }

  async get(key: string): Promise<string | null> {
    const file = this.fileOf(key);
    try { return fs.readFileSync(file, 'utf8'); } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw new ConfigError(`Cannot read ${file}: ${errText(e)}`);
    }
  }

  async set(key: string, value: string): Promise<void> {
    const file = this.fileOf(key);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) {
      throw new ConfigError(`Cannot create the folder of ${file}: ${errText(e)}`);
    }
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  lock<T>(name: string, fn: () => Promise<T>, _opts?: LockOptions): Promise<T> {
    return this.locks.run(`${this.dir}\0${name}`, fn);
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const k = `${this.dir}\0${key}`;
    if ((this.claimed.get(k) ?? 0) > now) return false;
    this.claimed.set(k, now + ttlSeconds * 1000);
    return true;
  }

  /** In memory: one process uses a folder, and a count for an hour may start again after a restart. */
  async hit(key: string, ttlSeconds: number): Promise<number> {
    return this.counters.hit(`${this.dir}\0${key}`, ttlSeconds);
  }

  scope(prefix: string): Store {
    const dir = path.join(this.dir, prefix);
    return new FileStore(dir, undefined, { locks: this.locks, claimed: this.claimed, counters: this.counters });
  }
}

/** Keys in memory. For tests, and under DryRunStore. */
export class MemoryStore implements Store {
  data: Map<string, string>;
  private prefix: string;
  private locks: LocalLocks;
  private claimed: Map<string, number>;
  private counters: LocalCounters;

  constructor(prefix = '', shared?: { data: Map<string, string>; locks: LocalLocks; claimed: Map<string, number>; counters: LocalCounters }) {
    this.prefix = prefix;
    this.data = shared?.data ?? new Map();
    this.locks = shared?.locks ?? new LocalLocks();
    this.claimed = shared?.claimed ?? new Map();
    this.counters = shared?.counters ?? new LocalCounters();
  }

  async get(key: string): Promise<string | null> { return this.data.get(this.prefix + key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.data.set(this.prefix + key, value); }
  lock<T>(name: string, fn: () => Promise<T>, _opts?: LockOptions): Promise<T> { return this.locks.run(this.prefix + name, fn); }
  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    if ((this.claimed.get(this.prefix + key) ?? 0) > now) return false;
    this.claimed.set(this.prefix + key, now + ttlSeconds * 1000);
    return true;
  }
  async hit(key: string, ttlSeconds: number): Promise<number> { return this.counters.hit(this.prefix + key, ttlSeconds); }
  scope(prefix: string): Store {
    return new MemoryStore(this.prefix + prefix, { data: this.data, locks: this.locks, claimed: this.claimed, counters: this.counters });
  }
}

/**
 * --dry-run: reads what is there, and keeps every write in memory. So a dry run behaves like the real one from
 * poll to poll, and leaves the real state as it was.
 */
export class DryRunStore implements Store {
  private inner: Store;
  private overlay: MemoryStore;
  constructor(inner: Store, overlay = new MemoryStore()) {
    this.inner = inner;
    this.overlay = overlay;
  }
  async get(key: string): Promise<string | null> { return (await this.overlay.get(key)) ?? this.inner.get(key); }
  set(key: string, value: string): Promise<void> { return this.overlay.set(key, value); }
  lock<T>(name: string, fn: () => Promise<T>, opts: LockOptions): Promise<T> { return this.overlay.lock(name, fn, opts); }
  claim(key: string, ttlSeconds: number): Promise<boolean> { return this.overlay.claim(key, ttlSeconds); }
  hit(key: string, ttlSeconds: number): Promise<number> { return this.overlay.hit(key, ttlSeconds); }
  scope(prefix: string): Store {
    return new DryRunStore(this.inner.scope(prefix), this.overlay.scope(prefix) as MemoryStore);
  }
}
