import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Watcher, parseConfig, ConfigError, itemStatus, fmtTime, fmtDuration, describeTx,
  TOPIC_TRANSACTION_ADDED, TOPIC_TX_NONCE_SET, SEL, encUint, encAddr, proxyCode, MASTER_COPY, BURN_ADDRESS,
} from './watch.ts';
import type { Config } from './watch.ts';

// ---------------------------------------------------------------------------
// Mock chain

const SAFE = '0x' + '5a'.repeat(20);
const DELAY = '0x' + 'de'.repeat(20);
const OWNER_WALLET = '0x' + '0e'.repeat(20);
const STRANGER = '0x' + 'ba'.repeat(20);
const TOKEN = '0x' + '70'.repeat(20);
const ROLES = '0x' + '7e'.repeat(20);
const GUARDIAN = '0x' + '6a'.repeat(20);
const OTHER_PROXY = '0x' + 'c0'.repeat(20);
const SENTINEL = '0x0000000000000000000000000000000000000001';
const T0 = 1_800_000_000n;
const DAY = 86400n;

type QItem = { createdAt: bigint; to: string; value: bigint; data: string; operation: number; block: number };

class MockChain {
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
  codes: Record<string, string> = {
    [DELAY]: proxyCode(MASTER_COPY.delay),
    [ROLES]: proxyCode(MASTER_COPY.roles),
    [OTHER_PROXY]: proxyCode('0x' + '11'.repeat(20)),
  };
  nonceSets: { block: number; nonce: number }[] = []; // TxNonceSet logs
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

const word = (h: string) => h.padStart(64, '0');
const u = (n: number | bigint) => encUint(n);
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

function handle(chain: MockChain, method: string, params: any[]): { result?: unknown; error?: { code: number; message: string } } {
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
      if (f.topics[0] === TOPIC_TX_NONCE_SET && f.address.toLowerCase() === DELAY) {
        for (const l of chain.nonceSets) {
          if (l.block < from || l.block > to) continue;
          out.push({ address: DELAY, blockNumber: '0x' + l.block.toString(16), logIndex: '0x0', topics: [TOPIC_TX_NONCE_SET], data: '0x' + u(l.nonce) });
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

function startServer(fn: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
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

// ---------------------------------------------------------------------------
// Fixtures

let chain: MockChain;
let rpc: { url: string; close: () => Promise<void> };
let notify: { url: string; close: () => Promise<void> };
type Sent = { channel: string; headers: http.IncomingHttpHeaders; body: string; json?: any };
let sent: Sent[] = [];
let notifyFails = false;
let dir: string;
const logs: string[] = [];

before(async () => {
  rpc = await startServer((_req, body, res) => {
    if (chain.down) { res.writeHead(503).end(); return; }
    const msg = JSON.parse(body);
    const r = handle(chain, msg.method, msg.params ?? []);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...r }));
  });
  notify = await startServer((req, body, res) => {
    if (notifyFails) { res.writeHead(500).end(); return; }
    const channel = req.url!.startsWith('/hook') ? 'webhook' : 'ntfy';
    sent.push({ channel, headers: req.headers, body, json: channel === 'webhook' ? JSON.parse(body) : undefined });
    res.writeHead(200).end('ok');
  });
});
after(async () => { await rpc.close(); await notify.close(); });

beforeEach(() => {
  chain = new MockChain();
  sent = [];
  notifyFails = false;
  logs.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timebox-watch-'));
});

function config(extra: Partial<Config> = {}): Config {
  return {
    ...parseConfig([], {
      RPC_URL: rpc.url, TIMEBOX: SAFE, NTFY_URL: `${notify.url}/secret-topic-123`, WEBHOOK_URL: `${notify.url}/hook`,
      STATE_FILE: path.join(dir, 'state.json'), HEARTBEAT_HOURS: '0',
    }),
    ...extra,
  };
}
const watcher = (extra: Partial<Config> = {}) => new Watcher(config(extra), { log: (m) => logs.push(m) });
const ntfy = () => sent.filter((s) => s.channel === 'ntfy');
const hooks = () => sent.filter((s) => s.channel === 'webhook');
const ONE_HALF_ETH = 1_500_000_000_000_000_000n;

// ---------------------------------------------------------------------------
// Tests

test('first start reports Watching and treats queued items as known', async () => {
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  chain.mine(3600n);
  const w = watcher();
  assert.equal(await w.poll(), true);
  assert.deepEqual(hooks().map((h) => h.json.event), ['watching']);
  const h = hooks()[0].json;
  assert.equal(h.vault, SAFE);
  assert.equal(h.delay, DELAY);
  assert.equal(h.chainId, 1);
  assert.match(h.message, /1 pending transaction/);
  assert.match(h.message, /#0: Withdrawal of 1\.5 ETH to the owner wallet, ready from /);
  assert.equal(ntfy()[0].headers.title, 'Watching the vault');
  assert.equal(w.state.items['0'].kind, 'withdrawal');
  // a known item gets its Ready alert later
  sent = [];
  chain.mine(2n * DAY);
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['ready']);
});

test('a queued native withdrawal produces one Queued alert, then Ready once', async () => {
  const w = watcher();
  await w.poll();
  sent = [];
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  const q = chain.queue[0];
  await w.poll();
  assert.equal(ntfy().length, 1);
  assert.equal(hooks().length, 1);
  const h = hooks()[0].json;
  assert.equal(h.event, 'queued');
  assert.equal(h.nonce, 0);
  assert.equal(h.title, 'Queued: Withdrawal of 1.5 ETH to the owner wallet');
  assert.ok(h.message.includes(`on ${fmtTime(q.createdAt)}`));
  assert.ok(h.message.includes(`from ${fmtTime(q.createdAt + chain.cooldown)}`));
  assert.ok(h.message.includes(`until ${fmtTime(q.createdAt + chain.cooldown + chain.expiration)}`));
  assert.equal(ntfy()[0].headers.priority, '3');
  assert.ok(!ntfy()[0].body.includes('secret-topic'));

  sent = [];
  await w.poll();
  assert.equal(sent.length, 0, 'same poll again sends nothing');

  chain.mine(DAY);
  await w.poll();
  assert.equal(sent.length, 0, 'still waiting');

  chain.mine(DAY + 60n);
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['ready']);
  assert.match(hooks()[0].json.message, /can be executed now/);
  sent = [];
  await w.poll();
  assert.equal(sent.length, 0, 'Ready only once');
});

test('a non-withdrawal call is flagged with the highest priority', async () => {
  const w = watcher();
  await w.poll();
  sent = [];
  chain.enqueue(DELAY, 0n, '0xebb2b4a2' + u(0)); // setTxCooldown(0)
  await w.poll();
  const n = ntfy()[0];
  assert.equal(n.headers.priority, '5');
  assert.match(n.body, /This transaction is not a withdrawal\. It can change the vault settings\./);
  assert.match(n.body, /setTxCooldown\(0\) \(new value: 0 seconds\) on the Delay 0xdede/);
  assert.match(n.body, /selector 0xebb2b4a2/);
});

test('transfers to other addresses are unusual, ERC-20 withdrawals are decoded', async () => {
  const w = watcher();
  await w.poll();
  sent = [];
  chain.enqueue(STRANGER, 10n ** 18n);
  chain.enqueue(TOKEN, 0n, SEL.transfer + encAddr(OWNER_WALLET) + u(2_500_000n));
  chain.enqueue(TOKEN, 0n, SEL.transfer + encAddr(STRANGER) + u(1_000_000n));
  await w.poll();
  const msgs = ntfy();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].headers.priority, '4');
  assert.match(msgs[0].body, /not the owner wallet\. This is unusual/);
  assert.equal(msgs[1].headers.priority, '3');
  assert.match(msgs[1].body, /Withdrawal of 2\.5 USDC to the owner wallet/);
  assert.equal(msgs[2].headers.priority, '4');
  assert.match(msgs[2].body, /Transfer of 1 USDC to 0xbaba/);
});

test('failed delivery is retried and not marked as sent', async () => {
  const w = watcher();
  await w.poll();
  sent = [];
  notifyFails = true;
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(sent.length, 0);
  assert.equal(w.state.outbox.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.outbox.length, 1, 'pending alert is persisted');
  notifyFails = false;
  await w.poll();
  assert.equal(ntfy().length, 1);
  assert.equal(hooks().length, 1);
  assert.equal(hooks()[0].json.event, 'queued');
  assert.equal(w.state.outbox.length, 0);
  sent = [];
  await w.poll();
  assert.equal(sent.length, 0);
});

test('the state file survives a restart', async () => {
  await watcher().poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await watcher().poll();
  sent = [];
  const w2 = watcher();
  await w2.poll();
  assert.equal(sent.length, 0, 'no second Watching, no duplicate Queued');
  chain.mine(2n * DAY + 60n);
  await watcher().poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['ready']);
  sent = [];
  await watcher().poll();
  assert.equal(sent.length, 0);
});

test('closed, expires soon, settings changed and heartbeat', async () => {
  const w = watcher({ heartbeatHours: 24 });
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  chain.enqueue(OWNER_WALLET, 1n);
  await w.poll();
  sent = [];
  chain.mine(2n * DAY + 6n * DAY + 60n); // inside the last 24 hours of the 7 day window
  await w.poll();
  const events = hooks().map((h) => `${h.json.event}:${h.json.nonce ?? ''}`);
  assert.deepEqual(events, ['ready:0', 'expires_soon:0', 'ready:1', 'expires_soon:1', 'heartbeat:']);
  assert.match(hooks()[4].json.message, /2 pending transactions/);
  sent = [];
  chain.txNonce = 1;
  chain.cooldown = 3n * DAY;
  chain.delayModules = [OWNER_WALLET, STRANGER];
  await w.poll();
  const ev = hooks().map((h) => h.json.event);
  assert.deepEqual(ev, ['settings_changed', 'closed']);
  assert.match(hooks()[0].json.message, /cooldown 2 days -> 3 days/);
  assert.match(hooks()[0].json.message, /owner wallets/);
  assert.equal(hooks()[1].json.nonce, 0);
});

test('RPC fallback, log chunk halving and watcher problem alerts', async () => {
  chain.maxLogRange = 30;
  const w = watcher({ rpcUrls: ['http://127.0.0.1:1/dead-key', rpc.url], failPolls: 2, logChunk: 2000 });
  await w.poll();
  chain.mine(12n * 200n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  sent = [];
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['queued']);
  assert.ok(logs.some((l) => /retrying with/.test(l)));
  assert.ok(!logs.some((l) => l.includes('dead-key') || l.includes(rpc.url)), 'RPC URLs are not logged');

  sent = [];
  chain.down = true;
  assert.equal(await w.poll(), false);
  assert.equal(sent.length, 0);
  await w.poll();
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['watcher_problem'], 'sent once');
  assert.ok(!JSON.stringify(sent).includes('127.0.0.1:1'));
  chain.down = false;
  sent = [];
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['watcher_recovered']);
});

test('TIMEBOX with more than one module is a configuration error', async () => {
  chain.safeModules = [DELAY, STRANGER];
  await assert.rejects(watcher().poll(), ConfigError);
});

test('a vault without the Roles modifier says it has no cancel', async () => {
  await watcher().poll();
  assert.match(hooks()[0].json.message, /Cancel: no\./);
});

for (const order of ['delay-first', 'roles-first'] as const) {
  test(`the Delay is found in a Safe with the Delay and the Roles modifier (${order})`, async () => {
    chain.withCancel(order);
    await watcher().poll();
    const h = hooks()[0].json;
    assert.equal(h.event, 'watching');
    assert.equal(h.delay, DELAY);
    assert.ok(h.message.includes(`Cancel: yes, through the Roles modifier ${ROLES}.`));
    assert.ok(h.message.includes(`can cancel queued transactions: ${OWNER_WALLET} (owner wallet), ${GUARDIAN}.`));
    assert.doesNotMatch(h.message, /other modules|Warning/);
  });
}

test('a two-module Safe whose second module is not a Roles modifier is a configuration error', async () => {
  chain.safeModules = [DELAY, OTHER_PROXY];
  await assert.rejects(watcher().poll(), (e: Error) =>
    e instanceof ConfigError && e.message.includes(`${OTHER_PROXY}: not a Delay or Roles modifier`) && e.message.includes(`${DELAY}: a Delay`));
});

test('a cancel is reported as Cancelled, once', async () => {
  chain.withCancel();
  await watcher().poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  sent = [];
  await watcher().poll();
  assert.match(hooks()[0].json.message, /It can be cancelled until it is executed\./);
  sent = [];
  chain.cancel(1);
  await watcher().poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['cancelled:0']);
  assert.match(hooks()[0].json.message, /^The withdrawal of 1\.5 ETH to the owner wallet \(transaction #0\) was cancelled in block \d+ .*Nothing moved\.$/);
  assert.equal(ntfy()[0].headers.priority, '3');
  assert.equal(ntfy()[0].headers.title, 'Cancelled: transaction #0');
  sent = [];
  await watcher().poll();
  await watcher().poll();
  assert.equal(sent.length, 0, 'no second alert, also after a restart');
});

test('an execution followed by a cancel in the same poll interval is told apart', async () => {
  chain.withCancel();
  const w = watcher();
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH); // #0
  chain.mine(2n * DAY);
  chain.enqueue(OWNER_WALLET, 1n); // #1, ready later
  chain.enqueue(OWNER_WALLET, 2n); // #2
  await w.poll();
  sent = [];
  chain.execute(); // #0 executed
  chain.cancel(3); // #1 and #2 cancelled
  await w.poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['closed:0', 'cancelled:1', 'cancelled:2']);
  assert.match(hooks()[0].json.message, /It was executed\./);

  // Without old state at the RPC, a cancelled item that was ready is not called "cancelled".
  chain.noArchive = true;
  chain.enqueue(OWNER_WALLET, 3n); // #3, ready at the cancel
  chain.mine(2n * DAY + 60n);
  chain.enqueue(OWNER_WALLET, 4n); // #4, still waiting at the cancel
  await w.poll();
  sent = [];
  chain.cancel(5);
  await w.poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['closed:3', 'cancelled:4']);
  assert.match(hooks()[0].json.message, /It was executed, or cancelled in block \d+\./);
});

test('an execution is reported as executed, an expired item as expired and removed', async () => {
  chain.withCancel();
  const w = watcher();
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  chain.mine(2n * DAY + 60n);
  await w.poll();
  sent = [];
  chain.execute();
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['closed']);
  assert.equal(hooks()[0].json.title, 'Closed: transaction #0');
  assert.match(hooks()[0].json.message, /left the queue by block \d+ .*It was executed\.$/);

  chain.enqueue(OWNER_WALLET, 1n);
  await w.poll();
  chain.mine(2n * DAY + 7n * DAY + 60n);
  await w.poll(); // Expired alert
  sent = [];
  chain.execute(); // skipExpired
  await w.poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['closed:1']);
  assert.match(hooks()[0].json.message, /It had expired and was removed from the queue\. It did not execute\./);
});

test('a new canceller and a call on the Roles modifier get the highest priority', async () => {
  chain.withCancel();
  const w = watcher();
  await w.poll();
  sent = [];
  chain.rolesModules = [OWNER_WALLET, GUARDIAN, STRANGER];
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['settings_changed']);
  assert.equal(ntfy()[0].headers.priority, '5');
  assert.equal(hooks()[0].json.message, `The vault settings changed. A new address can now cancel: ${STRANGER}.`);
  sent = [];
  await w.poll();
  assert.equal(sent.length, 0);

  chain.rolesOwner = STRANGER;
  chain.safeModules = [DELAY];
  await w.poll();
  const m = hooks()[0].json.message;
  assert.match(m, /vault modules .* -> 0xdede/);
  assert.ok(m.includes(`The Roles modifier ${ROLES} is gone. Queued transactions can no longer be cancelled.`));
  assert.ok(m.includes(`This address can no longer cancel: ${GUARDIAN}.`));

  sent = [];
  chain.withCancel();
  await w.poll(); // Roles back, owner is not the burn address
  assert.match(hooks()[0].json.message, /A Roles modifier was added: 0x7e7e.*Warning: the Roles modifier owner is 0xbaba/);
  sent = [];
  chain.enqueue(ROLES, 0n, '0x610b5925' + encAddr(STRANGER)); // enableModule(stranger)
  await w.poll();
  const n = ntfy()[0];
  assert.equal(n.headers.priority, '5');
  assert.equal(n.headers.title, 'Not a withdrawal: transaction #0 queued');
  assert.match(n.body, /enableModule\(0xbaba.*\) on the Roles modifier 0x7e7e/);
});

test('config, time and status helpers', () => {
  assert.throws(() => parseConfig([], {}), ConfigError);
  assert.throws(() => parseConfig(['--rpc-url', 'http://x'], { TIMEBOX: SAFE }), /NTFY_URL/);
  const c = parseConfig(['--rpc-url', 'http://a, https://b', '--timebox', SAFE, '--dry-run', '--once', '--poll-seconds=5'], {});
  assert.deepEqual(c.rpcUrls, ['http://a', 'https://b']);
  assert.equal(c.pollSeconds, 5);
  assert.equal(c.once && c.dryRun, true);
  assert.equal(fmtTime(0n), '1970-01-01 00:00:00 UTC');
  assert.equal(fmtDuration(90061n), '1 day 1 hour');
  assert.equal(itemStatus(100n, 10n, 5n, 109n).status, 'waiting');
  assert.equal(itemStatus(100n, 10n, 5n, 110n).status, 'ready');
  assert.equal(itemStatus(100n, 10n, 5n, 115n).status, 'ready');
  assert.equal(itemStatus(100n, 10n, 5n, 116n).status, 'expired');
  assert.equal(itemStatus(100n, 10n, 0n, 10n ** 12n).status, 'ready');
  const d = describeTx({ to: SAFE, value: 0n, data: '0xe19a9dd9' + encAddr(STRANGER), operation: 0 }, { chainId: 1, delay: DELAY, vault: SAFE, controllers: [OWNER_WALLET] });
  assert.equal(d.priority, 5);
  assert.match(d.detail, /setGuard\(0xbaba/);
  const dc = describeTx({ to: OWNER_WALLET, value: 1n, data: '0x', operation: 1 }, { chainId: 1, delay: DELAY, vault: SAFE, controllers: [OWNER_WALLET] });
  assert.equal(dc.kind, 'call');
  assert.match(dc.detail, /delegate call/);
});
