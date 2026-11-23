// The store of the service on Vercel: Upstash Redis, through its REST API. Plain fetch, no package.
//
// A lock is a key with a random value and an expiry (SET NX PX). Only the holder deletes it: a script compares
// the value first. The expiry must be longer than the longest run of a function (its maxDuration), so that a
// lock never runs out while its holder still works. A function that was killed leaves its lock behind, and the
// expiry frees it.
import * as crypto from 'node:crypto';
import { BusyError, type LockOptions, type Store } from './store.ts';
import { type FetchFn, errText } from './util.ts';

const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
/** One more on a counter, which runs out ARGV[1] seconds after its first hit. In one step, so that no counter is left without an expiry. */
const HIT = "local n = redis.call('incr', KEYS[1]) if n == 1 then redis.call('expire', KEYS[1], ARGV[1]) end return n";

export type RedisOptions = {
  url: string;
  token: string;
  /** Every key and lock starts with this. */
  prefix?: string;
  /** How long a lock lives if its holder does not free it. */
  lockTtlMs?: number;
  fetch?: FetchFn;
};

export class RedisStore implements Store {
  private url: string;
  private token: string;
  private prefix: string;
  private lockTtlMs: number;
  private fetchFn: FetchFn;

  constructor(opts: RedisOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.prefix = opts.prefix ?? '';
    this.lockTtlMs = opts.lockTtlMs ?? 130_000;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** One Redis command. The token never appears in an error. */
  async cmd(...args: (string | number)[]): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args.map(String)),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(`Redis ${args[0]}: ${errText(e)}`.split(this.token).join('[redis token]'));
    }
    let j: any = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || j === null || 'error' in j) {
      throw new Error(`Redis ${args[0]}: ${j?.error ?? `HTTP ${res.status}`}`.split(this.token).join('[redis token]'));
    }
    return j.result;
  }

  async get(key: string): Promise<string | null> {
    const v = await this.cmd('GET', this.prefix + key);
    return v === null || v === undefined ? null : String(v);
  }

  async set(key: string, value: string): Promise<void> {
    await this.cmd('SET', this.prefix + key, value);
  }

  async lock<T>(name: string, fn: () => Promise<T>, opts: LockOptions): Promise<T> {
    const key = `${this.prefix}lock:${name}`;
    const token = crypto.randomUUID();
    const until = Date.now() + opts.waitMs;
    let pause = 100;
    while ((await this.cmd('SET', key, token, 'NX', 'PX', this.lockTtlMs)) !== 'OK') {
      if (Date.now() + pause > until) throw new BusyError(name);
      await new Promise((r) => setTimeout(r, pause));
      pause = Math.min(pause * 2, 1000);
    }
    try {
      return await fn();
    } finally {
      // A lock that could not be freed runs out by itself.
      await this.cmd('EVAL', RELEASE, 1, key, token).catch(() => undefined);
    }
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.cmd('SET', this.prefix + key, '1', 'NX', 'EX', ttlSeconds)) === 'OK';
  }

  async hit(key: string, ttlSeconds: number): Promise<number> {
    return Number(await this.cmd('EVAL', HIT, 1, this.prefix + key, ttlSeconds));
  }

  scope(prefix: string): Store {
    return new RedisStore({ url: this.url, token: this.token, prefix: this.prefix + prefix, lockTtlMs: this.lockTtlMs, fetch: this.fetchFn });
  }
}
