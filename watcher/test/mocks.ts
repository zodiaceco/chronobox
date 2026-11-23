// Stand-ins for the outside world: a chain that answers JSON-RPC, and a tiny HTTP server.
import * as http from 'node:http';
import {
  BURN_ADDRESS, MASTER_COPY, MODULE_PROXY_FACTORY, SEL, SENTINEL, TOPIC_MODULE_PROXY_CREATION, TOPIC_SAFE_MODULE_TRANSACTION,
  TOPIC_TRANSACTION_ADDED, TOPIC_TX_NONCE_SET, encAddr, encUint, proxyCode,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Mock chain

export const SAFE = '0x' + '5a'.repeat(20);
export const DELAY = '0x' + 'de'.repeat(20);
export const OWNER_WALLET = '0x' + '0e'.repeat(20);
export const STRANGER = '0x' + 'ba'.repeat(20);
export const TOKEN = '0x' + '70'.repeat(20);
export const ROLES = '0x' + '7e'.repeat(20);
export const GUARDIAN = '0x' + '6a'.repeat(20);
export const OTHER_PROXY = '0x' + 'c0'.repeat(20);
export const T0 = 1_800_000_000n;
export const DAY = 86400n;

export type QItem = { createdAt: bigint; to: string; value: bigint; data: string; operation: number; block: number };

export class MockChain {
  chainId = 1;
  head = 1000;
  cooldown = 2n * DAY;
  expiration = 7n * DAY;
  txNonce = 0;
  queue: QItem[] = [];
  delayModules = [OWNER_WALLET];
  safeModules = [DELAY];
  rolesModules = [OWNER_WALLET, GUARDIAN];
  rolesOwner = BURN_ADDRESS;
  safeOwners = [BURN_ADDRESS];
  created: number | null = null; // block of the ModuleProxyCreation log of the Delay
  create() { this.mine(12n); this.created = this.head; this.mine(12n); }
  codes: Record<string, string> = {
    [DELAY]: proxyCode(MASTER_COPY.delay),
    [ROLES]: proxyCode(MASTER_COPY.roles),
    [OTHER_PROXY]: proxyCode('0x' + '11'.repeat(20)),
  };
  nonceSets: { block: number; nonce: number }[] = []; // cancels
  // The Delay 1.0.1 of a Chronobox has no TxNonceSet event: a cancel shows only as a module call in the Safe.
  delayHasNonceEvent = false;
  nonceHistory: { block: number; nonce: number }[] = []; // txNonce from that block on
  noArchive = false; // eth_call at an old block fails
  maxLogRange = 100000;
  down = false;
  calls: string[] = [];
  ts(n: number) { return T0 + 12n * BigInt(n); }
  now() { return this.ts(this.head); }
  mine(seconds: bigint) { this.head += Number(seconds / 12n) + 1; }
  enqueue(to: string, value: bigint, data = '0x', operation = 0) {
    this.queue.push({ createdAt: this.now(), to, value, data, operation, block: this.head });
    this.mine(12n);
    return this.queue.length - 1;
  }
  withCancel(order: 'delay-first' | 'roles-first' = 'delay-first') {
    this.safeModules = order === 'delay-first' ? [DELAY, ROLES] : [ROLES, DELAY];
  }
  // Each of these is a transaction in a new block.
  private setNonce(n: number) {
    this.mine(12n);
    this.txNonce = n;
    this.nonceHistory.push({ block: this.head, nonce: n });
  }
  /** executeNextTx or skipExpired: no Delay event. */
  execute() { this.setNonce(this.txNonce + 1); }
  /** setTxNonce(n) through the Roles modifier: emits TxNonceSet(n). */
  cancel(n: number) { this.setNonce(n); this.nonceSets.push({ block: this.head, nonce: n }); }
  txNonceAt(block: number) {
    if (block >= this.head) return this.txNonce;
    let v = 0;
    for (const h of this.nonceHistory) if (h.block <= block) v = h.nonce;
    return v;
  }
}

export const u = (n: number | bigint) => encUint(n);
function encAddrArray(arr: string[], next: string) {
  return '0x' + u(64) + encAddr(next) + u(arr.length) + arr.map(encAddr).join('');
}
function encString(s: string) {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + u(32) + u(s.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}
function encAdded(q: QItem) {
  const d = q.data.slice(2);
  const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
  return '0x' + encAddr(q.to) + u(q.value) + u(128) + u(q.operation) + u(d.length / 2) + padded;
}

export function handle(chain: MockChain, method: string, params: any[]): { result?: unknown; error?: { code: number; message: string } } {
  chain.calls.push(method);
  switch (method) {
    case 'eth_chainId': return { result: '0x' + chain.chainId.toString(16) };
    case 'eth_blockNumber': return { result: '0x' + chain.head.toString(16) };
    case 'eth_getBlockByNumber': {
      const n = Number(BigInt(params[0]));
      if (n > chain.head) return { result: null };
      return { result: { number: params[0], timestamp: '0x' + chain.ts(n).toString(16) } };
    }
    case 'eth_getLogs': {
      const f = params[0];
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      if (to - from + 1 > chain.maxLogRange) return { error: { code: -32005, message: 'query returned more than 10000 results' } };
      const out: unknown[] = [];
      if (!f.address) {
        // The search of --all: every contract, ModuleProxyCreation or TransactionAdded.
        const wanted: string[] = [f.topics[0]].flat();
        if (wanted.includes(TOPIC_MODULE_PROXY_CREATION) && chain.created !== null && chain.created >= from && chain.created <= to) {
          out.push({
            address: MODULE_PROXY_FACTORY, blockNumber: '0x' + chain.created.toString(16),
            topics: [TOPIC_MODULE_PROXY_CREATION, '0x' + encAddr(DELAY), '0x' + encAddr(MASTER_COPY.delay)], data: '0x',
          });
        }
        if (wanted.includes(TOPIC_TRANSACTION_ADDED)) {
          chain.queue.forEach((q, n) => {
            if (q.block < from || q.block > to) return;
            out.push({ address: DELAY, blockNumber: '0x' + q.block.toString(16), topics: [TOPIC_TRANSACTION_ADDED, '0x' + u(n), '0x' + 'ab'.repeat(32)], data: encAdded(q) });
          });
        }
        return { result: out };
      }
      if (f.topics[0] === TOPIC_TX_NONCE_SET && f.address.toLowerCase() === DELAY) {
        for (const l of chain.delayHasNonceEvent ? chain.nonceSets : []) {
          if (l.block < from || l.block > to) continue;
          out.push({ address: DELAY, blockNumber: '0x' + l.block.toString(16), logIndex: '0x0', topics: [TOPIC_TX_NONCE_SET], data: '0x' + u(l.nonce) });
        }
        return { result: out };
      }
      if (f.topics[0] === TOPIC_SAFE_MODULE_TRANSACTION && f.address.toLowerCase() === SAFE) {
        // Every module call in the Safe: the cancels (Roles calls setTxNonce on the Delay) and one other call.
        const moduleTx = (module: string, to: string, data: string) =>
          '0x' + encAddr(module) + encAddr(to) + u(0) + u(160) + u(0) + u((data.length - 2) / 2) + data.slice(2).padEnd(128, '0');
        for (const l of chain.nonceSets) {
          if (l.block < from || l.block > to) continue;
          const at = '0x' + l.block.toString(16);
          out.push({ address: SAFE, blockNumber: at, logIndex: '0x0', topics: [TOPIC_SAFE_MODULE_TRANSACTION], data: moduleTx(DELAY, OWNER_WALLET, '0x') });
          out.push({ address: SAFE, blockNumber: at, logIndex: '0x1', topics: [TOPIC_SAFE_MODULE_TRANSACTION], data: moduleTx(ROLES, DELAY, '0x46ba2307' + u(l.nonce)) });
        }
        return { result: out };
      }
      chain.queue.forEach((q, n) => {
        if (f.address.toLowerCase() !== DELAY) return;
        if (q.block < from || q.block > to) return;
        if (f.topics[0] !== TOPIC_TRANSACTION_ADDED) return;
        const t1 = '0x' + u(n);
        if (f.topics[1] && f.topics[1] !== t1) return;
        out.push({ address: DELAY, blockNumber: '0x' + q.block.toString(16), topics: [TOPIC_TRANSACTION_ADDED, t1, '0x' + 'ab'.repeat(32)], data: encAdded(q) });
      });
      return { result: out };
    }
    case 'eth_call': {
      const to = params[0].to.toLowerCase();
      const data: string = params[0].data;
      const sel = data.slice(0, 10);
      const arg = data.length >= 74 ? BigInt('0x' + data.slice(10, 74)) : 0n;
      const ok = (r: string) => ({ result: r.startsWith('0x') ? r : '0x' + r });
      const block = params[1] && params[1] !== 'latest' ? Number(BigInt(params[1])) : chain.head;
      if (block < chain.head && chain.noArchive) return { error: { code: -32000, message: 'missing trie node' } };
      if (to === DELAY) {
        if (sel === SEL.txCooldown) return ok(u(chain.cooldown));
        if (sel === SEL.txExpiration) return ok(u(chain.expiration));
        if (sel === SEL.txNonce) return ok(u(chain.txNonceAt(block)));
        if (sel === SEL.queueNonce) return ok(u(chain.queue.length));
        if (sel === SEL.getTxCreatedAt) return ok(u(chain.queue[Number(arg)]?.createdAt ?? 0n));
        if (sel === SEL.owner || sel === SEL.avatar || sel === SEL.target) return ok(encAddr(SAFE));
        if (sel === SEL.getModulesPaginated) return ok(encAddrArray(chain.delayModules, SENTINEL));
      }
      if (to === SAFE && sel === SEL.getModulesPaginated) return ok(encAddrArray(chain.safeModules, SENTINEL));
      if (to === SAFE && sel === SEL.getOwners) return ok(u(32) + u(chain.safeOwners.length) + chain.safeOwners.map(encAddr).join(''));
      if (to === ROLES && sel === SEL.owner) return ok(encAddr(chain.rolesOwner));
      if (to === ROLES && sel === SEL.getModulesPaginated) return ok(encAddrArray(chain.rolesModules, SENTINEL));
      if (to === TOKEN && sel === SEL.symbol) return ok(encString('USDC'));
      if (to === TOKEN && sel === SEL.decimals) return ok(u(6));
      return { error: { code: 3, message: 'execution reverted' } };
    }
    case 'eth_getCode': return { result: chain.codes[params[0].toLowerCase()] ?? '0x' };
  }
  return { error: { code: -32601, message: 'method not found' } };
}

export function startServer(fn: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => fn(req, body, res));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

/** A stand-in for the REST API of Upstash Redis: GET, SET (NX, PX, EX) and the one script that frees a lock. */
export class FakeRedis {
  data = new Map<string, { value: string; until?: number }>();
  commands: string[][] = [];
  token: string;
  constructor(token: string) { this.token = token; }

  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.until !== undefined && e.until <= Date.now()) { this.data.delete(key); return undefined; }
    return e;
  }

  get(key: string): string | null { return this.live(key)?.value ?? null; }

  run(args: string[]): unknown {
    this.commands.push(args);
    const [cmd, key] = [args[0].toUpperCase(), args[1]];
    if (cmd === 'GET') return this.live(key)?.value ?? null;
    if (cmd === 'SET') {
      const opts = args.slice(3).map((a) => a.toUpperCase());
      if (opts.includes('NX') && this.live(key)) return null;
      let until: number | undefined;
      const px = opts.indexOf('PX'), ex = opts.indexOf('EX');
      if (px >= 0) until = Date.now() + Number(args[3 + px + 1]);
      if (ex >= 0) until = Date.now() + Number(args[3 + ex + 1]) * 1000;
      this.data.set(key, { value: args[2], until });
      return 'OK';
    }
    if (cmd === 'EVAL') {
      // The script of RedisStore: delete the key if it still holds this token.
      const [lock, token] = [args[3], args[4]];
      if (this.live(lock)?.value === token) { this.data.delete(lock); return 1; }
      return 0;
    }
    throw new Error(`ERR unknown command ${cmd}`);
  }

  serve(): Promise<{ url: string; close: () => Promise<void> }> {
    return startServer((req, body, res) => {
      const answer = (code: number, json: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      if (req.headers.authorization !== `Bearer ${this.token}`) return answer(401, { error: 'Unauthorized' });
      try { answer(200, { result: this.run(JSON.parse(body)) }); } catch (e) { answer(400, { error: (e as Error).message }); }
    });
  }
}
