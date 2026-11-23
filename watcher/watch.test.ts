import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Watcher, AllWatcher, Telegram, batchCalls, fmtWhen, telegramStart, TELEGRAM_MAX_PER_CHAT, parseConfig, ConfigError, itemStatus, fmtTime, fmtDuration, describeTx,
  TOPIC_TRANSACTION_ADDED, TOPIC_TX_NONCE_SET, TOPIC_SAFE_MODULE_TRANSACTION, TOPIC_MODULE_PROXY_CREATION, MODULE_PROXY_FACTORY,
  SEL, encUint, encAddr, proxyCode, MASTER_COPY, BURN_ADDRESS,
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
type Sent = { url: string; json: any };
let sent: Sent[] = [];
let notifyFails = false;
let dir: string;
const logs: string[] = [];

// A stand-in for the Telegram Bot API: it hands out the messages that "people" sent and records what the bot says.
const TG_TOKEN = '123456:AAfake-token_for-the-tests-0123456789';
const TG_KEY = 'a-secret-for-the-tests-that-is-long-enough-0123';
let telegramApi: { url: string; close: () => Promise<void> };
type Said = { chat: number; text: string; silent: boolean };
let said: Said[] = [];
let inbox: { update_id: number; message: unknown }[] = [];
let nextUpdate = 1;
let tgCalls: string[] = [];
/** What sendMessage answers for a chat: a Telegram error, one time ("once") or every time. */
let tgRefuse: Record<number, { code: number; description: string; once?: boolean }> = {};
const person = (chat: number, text: string, type = 'private') => {
  inbox.push({ update_id: nextUpdate++, message: { chat: { id: chat, type }, from: { id: chat, first_name: 'Somebody', username: 'somebody' }, text } });
};
const saidTo = (chat: number) => said.filter((m) => m.chat === chat).map((m) => m.text);

before(async () => {
  rpc = await startServer((_req, body, res) => {
    if (chain.down) { res.writeHead(503).end(); return; }
    const msg = JSON.parse(body);
    const r = handle(chain, msg.method, msg.params ?? []);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...r }));
  });
  notify = await startServer((req, body, res) => {
    if (notifyFails) { res.writeHead(500).end(); return; }
    sent.push({ url: req.url!, json: JSON.parse(body) });
    res.writeHead(200).end('ok');
  });
  telegramApi = await startServer((req, body, res) => {
    const answer = (code: number, json: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url!);
    if (!m || m[1] !== TG_TOKEN) return answer(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const args = body ? JSON.parse(body) : {};
    tgCalls.push(m[2]);
    if (m[2] === 'getMe') return answer(200, { ok: true, result: { id: 1, is_bot: true, username: 'chronobox_test_bot' } });
    if (m[2] === 'setMyCommands') return answer(200, { ok: true, result: true });
    if (m[2] === 'getUpdates') {
      const result = inbox.filter((u) => args.offset === undefined || u.update_id >= args.offset);
      return answer(200, { ok: true, result });
    }
    if (m[2] === 'sendMessage') {
      const refuse = tgRefuse[args.chat_id];
      if (refuse) {
        if (refuse.once) delete tgRefuse[args.chat_id];
        return answer(refuse.code, { ok: false, error_code: refuse.code, description: refuse.description });
      }
      said.push({ chat: args.chat_id, text: args.text, silent: Boolean(args.disable_notification) });
      return answer(200, { ok: true, result: { message_id: said.length } });
    }
    return answer(404, { ok: false, error_code: 404, description: 'Not Found' });
  });
});
after(async () => { await rpc.close(); await notify.close(); await telegramApi.close(); });

beforeEach(() => {
  chain = new MockChain();
  sent = [];
  notifyFails = false;
  said = [];
  inbox = [];
  tgCalls = [];
  tgRefuse = {};
  logs.length = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronobox-watch-'));
});

function config(extra: Partial<Config> = {}): Config {
  return {
    ...parseConfig([], {
      RPC_URL: rpc.url, CHRONOBOX: SAFE, WEBHOOK_URL: `${notify.url}/hook/secret-123`,
      STATE_FILE: path.join(dir, 'state.json'), HEARTBEAT_HOURS: '0',
    }),
    ...extra,
  };
}
const watcher = (extra: Partial<Config> = {}) => new Watcher(config(extra), { log: (m) => logs.push(m) });
const hooks = () => sent;
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
  assert.match(h.message, /^The alert service now watches the Chronobox 0x5a5a\w+ on Ethereum\. Every withdrawal waits 2 days, and a request stays open for 7 days after its wait\. Wallet: 0x0e0e\w+\./);
  assert.match(h.message, /One request waits:\nWithdraw 1\.5 ETH\. Its wait ends on \d+ \w{3} \d{4}, \d\d:\d\d UTC\.$/);
  assert.equal(h.title, 'Watching this Chronobox');
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
  assert.equal(hooks().length, 1);
  const h = hooks()[0].json;
  assert.equal(h.event, 'queued');
  assert.equal(h.nonce, 0);
  assert.equal(h.title, 'New request: Withdraw 1.5 ETH');
  assert.ok(h.message.startsWith(`Somebody asked this Chronobox to withdraw 1.5 ETH. The money goes to the wallet of this Chronobox, ${OWNER_WALLET}.`));
  assert.ok(h.message.includes(`\n\nThe wait ends on ${fmtWhen(q.createdAt + chain.cooldown)} (in 1 day 23 hours).\n\nWas it you?`));
  // This vault has no cancel, so the alert does not say "cancel it".
  assert.ok(h.message.endsWith('Was it you? Then you need to do nothing. If not, look at your Chronobox now. It cannot cancel a request. Somebody else may have your wallet.'));
  // No word of the contracts in what a person reads.
  assert.doesNotMatch(`${h.title} ${h.message}`, /queue|transaction|execute|vault|module|Delay|Roles|#\d/);
  assert.equal(fmtWhen(1_800_000_000n), '15 Jan 2027, 08:00 UTC');
  assert.equal(h.priority, 3);
  assert.ok(!JSON.stringify(h).includes('secret-123'));

  sent = [];
  await w.poll();
  assert.equal(sent.length, 0, 'same poll again sends nothing');

  chain.mine(DAY);
  await w.poll();
  assert.equal(sent.length, 0, 'still waiting');

  chain.mine(DAY + 60n);
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['ready']);
  assert.equal(hooks()[0].json.title, 'Wait over: Withdraw 1.5 ETH');
  assert.match(hooks()[0].json.message, /^The wait is over for the request to withdraw 1\.5 ETH\. Anybody can finish it now, and it does only what the request says\. It must be finished before /);
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
  const n = hooks()[0];
  assert.equal(n.json.priority, 5);
  assert.equal(n.json.title, 'New request: Remove the delay');
  assert.match(n.json.message, /^Somebody asked this Chronobox to remove the delay\. After this, a withdrawal does not wait at all\. A person who has your wallet can take the money at once\./);

  // A call that the app does not make: one plain sentence, and the call itself for a person who can read it.
  sent = [];
  chain.enqueue(SAFE, 0n, '0xe19a9dd9' + encAddr(STRANGER)); // setGuard(stranger) on the Safe
  chain.enqueue(STRANGER, 5n, '0x12345678'); // an unknown call with coin
  chain.enqueue(TOKEN, 0n, '0x095ea7b3' + encAddr(STRANGER) + u(1)); // approve
  await w.poll();
  const [guard, unknown, approve] = hooks();
  assert.equal(guard.json.title, 'New request: Change this Chronobox in a way that the app does not know');
  assert.match(guard.json.message, new RegExp(`It lets ${STRANGER} block everything that this Chronobox does\\. The Chronobox app does not make such a request\\. Technical detail: a call of setGuard\\(${STRANGER}\\) on the Safe of the Chronobox ${SAFE}\\.`));
  assert.equal(unknown.json.title, 'New request: Do something that the app does not know');
  assert.match(unknown.json.message, /It sends 0\.000000000000000005 ETH with it\..*Technical detail: a call of the function 0x12345678 on the contract 0xbaba/);
  assert.equal(approve.json.title, 'New request: Let 0xbaba…baba take tokens');
  assert.match(approve.json.message, /take the token 0x7070\w+ out of this Chronobox later, without the wait\./);
  for (const m of [guard, unknown, approve]) assert.equal(m.json.priority, 5);
});

test('a change of the delay says what it is now, and what the change means', async () => {
  const w = watcher();
  await w.poll();
  sent = [];
  chain.enqueue(DELAY, 0n, '0xebb2b4a2' + u(3600)); // 1 hour: shorter
  chain.enqueue(DELAY, 0n, '0xebb2b4a2' + u(30n * DAY)); // longer
  await w.poll();
  assert.equal(hooks()[0].json.title, 'New request: Change the delay to 1 hour');
  assert.match(hooks()[0].json.message, /After this, every withdrawal waits 1 hour\. It is 2 days now\. A shorter delay gives you less time to stop a thief\./);
  assert.match(hooks()[1].json.message, /After this, every withdrawal waits 30 days\. It is 2 days now\. A longer delay makes every withdrawal wait longer\./);
  assert.deepEqual(hooks().map((m) => m.json.priority), [5, 5]);
});

// What the Chronobox app puts in a batch: MultiSend, as a delegate call from the Safe.
const MULTI_SEND = '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526';
function batch(calls: [string, string][]): string {
  const packed = calls.map(([to, data]) => '00' + to.slice(2) + u(0) + u((data.length - 2) / 2) + data.slice(2)).join('');
  return '0x8d80ff0a' + u(32) + u(packed.length / 2) + packed.padEnd(Math.ceil(packed.length / 64) * 64, '0');
}
const CANCEL = '63616e63656c'.padEnd(64, '0');
const COUNCIL = '636f756e63696c'.padEnd(64, '0');
const assign = (who: string, role: string, on: boolean) => '0x957ed2b3' + encAddr(who) + u(96) + u(160) + u(1) + role + u(1) + u(on ? 1 : 0);
const NEW_WALLET = '0x' + 'a1'.repeat(20);
const SHARED_SAFE = '0x' + 'c5'.repeat(20);

test('the changes that the app makes in one step are named: a new wallet, a guardian', async () => {
  chain.withCancel();
  chain.rolesModules = [OWNER_WALLET];
  const w = watcher();
  await w.poll();
  sent = [];
  const handover = batch([
    [DELAY, '0x610b5925' + encAddr(NEW_WALLET)],
    [DELAY, '0xe009cfde' + encAddr(NEW_WALLET) + encAddr(OWNER_WALLET)],
    [ROLES, assign(NEW_WALLET, CANCEL, true)],
    [ROLES, assign(OWNER_WALLET, CANCEL, false)],
    [ROLES, '0xe009cfde' + encAddr(NEW_WALLET) + encAddr(OWNER_WALLET)],
  ]);
  assert.equal(batchCalls({ to: MULTI_SEND, value: 0n, data: handover, operation: 1 })!.length, 5);
  assert.equal(batchCalls({ to: MULTI_SEND, value: 0n, data: handover, operation: 0 }), null);
  assert.equal(batchCalls({ to: MULTI_SEND, value: 0n, data: handover.slice(0, -70), operation: 1 }), null);
  const addGuardian = batch([
    [ROLES, '0x0c6c76b8' + COUNCIL + encAddr(DELAY)],
    [ROLES, assign(GUARDIAN, CANCEL, true)],
    [ROLES, assign(SHARED_SAFE, COUNCIL, true)],
  ]);
  const removeGuardian = batch([
    [ROLES, assign(GUARDIAN, CANCEL, false)],
    [ROLES, assign(SHARED_SAFE, COUNCIL, false)],
    [ROLES, '0xe009cfde' + encAddr(SENTINEL) + encAddr(GUARDIAN)],
  ]);
  // A batch that is not one of these: a call to another contract is in it.
  const strange = batch([[ROLES, assign(GUARDIAN, CANCEL, true)], [TOKEN, SEL.transfer + encAddr(STRANGER) + u(1)]]);
  for (const data of [handover, addGuardian, removeGuardian, strange]) chain.enqueue(MULTI_SEND, 0n, data, 1);
  await w.poll();
  const [h, a, r, x] = hooks();
  assert.equal(h.json.title, 'New request: Hand over to 0xa1a1…a1a1');
  assert.ok(h.json.message.includes(`After this, the wallet ${NEW_WALLET} holds this Chronobox, and the wallet of today does not. It can withdraw all the money. Open your Chronobox to check that the request is what it looks like.`));
  assert.equal(a.json.title, 'New request: Add the guardian 0x6a6a…6a6a');
  assert.ok(a.json.message.includes(`After this, ${GUARDIAN} can stop every withdrawal. Together with the wallet of this Chronobox, it can hand the Chronobox to a new wallet at once.`));
  assert.equal(r.json.title, 'New request: Remove the guardian');
  assert.ok(r.json.message.includes(`After this, ${GUARDIAN} cannot stop a withdrawal any more. Only the wallet of this Chronobox can cancel.`));
  assert.equal(x.json.title, 'New request: Change this Chronobox in a way that the app does not know');
  assert.match(x.json.message, /It makes 2 changes in one step\. The Chronobox app does not make such a request\. Technical detail: a batch of calls to 0x7e7e\w+, 0x7070\w+\./);
  // Every change is the loudest kind, also when it looks like one that the app makes.
  for (const m of [h, a, r, x]) {
    assert.equal(m.json.priority, 5);
    assert.match(m.json.message, /If not, open your Chronobox and cancel it\.$/);
  }
  assert.deepEqual(Object.values(w.state.items).map((i) => i.kind), ['handover', 'guardian_add', 'guardian_remove', 'call']);
});

test('transfers to other addresses are unusual, ERC-20 withdrawals are decoded', async () => {
  const w = watcher();
  await w.poll();
  sent = [];
  chain.enqueue(STRANGER, 10n ** 18n);
  chain.enqueue(TOKEN, 0n, SEL.transfer + encAddr(OWNER_WALLET) + u(2_500_000n));
  chain.enqueue(TOKEN, 0n, SEL.transfer + encAddr(STRANGER) + u(1_000_000n));
  await w.poll();
  const msgs = hooks();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].json.priority, 4);
  assert.equal(msgs[0].json.title, 'New request: Send 1 ETH to 0xbaba…baba');
  assert.ok(msgs[0].json.message.startsWith(`Somebody asked this Chronobox to send 1 ETH to 0xbaba…baba. The money goes to ${STRANGER}. That is not the wallet of this Chronobox. The Chronobox app does not make such a request.`));
  assert.equal(msgs[1].json.priority, 3);
  assert.match(msgs[1].json.message, /^Somebody asked this Chronobox to withdraw 2\.5 USDC\. /);
  assert.equal(msgs[2].json.priority, 4);
  assert.match(msgs[2].json.message, /^Somebody asked this Chronobox to send 1 USDC to 0xbaba…baba\. /);
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
  assert.match(hooks()[4].json.message, /^2 requests wait in this Chronobox\. The alert service looked on /);
  assert.match(hooks()[1].json.message, /^The request to withdraw 1\.5 ETH must be finished before .* UTC\. That is in \d+ hours.*\. After that it is void\.$/);
  sent = [];
  chain.txNonce = 1;
  chain.cooldown = 3n * DAY;
  chain.delayModules = [OWNER_WALLET, STRANGER];
  await w.poll();
  const ev = hooks().map((h) => h.json.event);
  assert.deepEqual(ev, ['settings_changed', 'closed']);
  assert.equal(hooks()[0].json.title, 'This Chronobox changed');
  assert.equal(hooks()[0].json.message, `The delay changed from 2 days to 3 days.\nThe wallets that can withdraw changed. Before: ${OWNER_WALLET}. Now: ${OWNER_WALLET}, ${STRANGER}.\n\nIf you did not want this, look at your Chronobox now.`);
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

test('CHRONOBOX with more than one module is a configuration error', async () => {
  chain.safeModules = [DELAY, STRANGER];
  await assert.rejects(watcher().poll(), ConfigError);
});

test('a vault without the Roles modifier says it has no cancel', async () => {
  await watcher().poll();
  assert.match(hooks()[0].json.message, /This Chronobox cannot cancel a request\./);
});

for (const order of ['delay-first', 'roles-first'] as const) {
  test(`the Delay is found in a Safe with the Delay and the Roles modifier (${order})`, async () => {
    chain.withCancel(order);
    await watcher().poll();
    const h = hooks()[0].json;
    assert.equal(h.event, 'watching');
    assert.equal(h.delay, DELAY);
    assert.ok(h.message.includes(`The wallet can cancel a request, and so can ${GUARDIAN}.`));
    assert.doesNotMatch(h.message, /Warning/);
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
  assert.match(hooks()[0].json.message, /If not, open your Chronobox and cancel it\. Somebody else may have your wallet\.$/);
  sent = [];
  chain.cancel(1);
  await watcher().poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['cancelled:0']);
  assert.match(hooks()[0].json.message, /^The request to withdraw 1\.5 ETH was cancelled on \d+ \w{3} \d{4}, \d\d:\d\d UTC\. No money moved\.$/);
  assert.equal(hooks()[0].json.priority, 3);
  assert.equal(hooks()[0].json.title, 'Cancelled: Withdraw 1.5 ETH');
  sent = [];
  await watcher().poll();
  await watcher().poll();
  assert.equal(sent.length, 0, 'no second alert, also after a restart');
});

test('a cancel is also read from TxNonceSet on a Delay that has the event, and not counted twice', async () => {
  chain.delayHasNonceEvent = true;
  chain.withCancel();
  const w = watcher();
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  chain.cancel(1);
  await w.poll();
  assert.deepEqual(hooks().slice(2).map((s) => s.json.title), ['Cancelled: Withdraw 1.5 ETH']);
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
  assert.match(hooks()[0].json.message, /was carried out\. The money left this Chronobox\.$/);

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
  assert.match(hooks()[0].json.message, /is closed\. It was carried out, or it was cancelled\. The alert service could not see which\./);
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
  assert.equal(hooks()[0].json.title, 'Done: Withdraw 1.5 ETH');
  assert.equal(hooks()[0].json.message, 'The request to withdraw 1.5 ETH was carried out. The money left this Chronobox.');

  chain.enqueue(OWNER_WALLET, 1n);
  await w.poll();
  chain.mine(2n * DAY + 7n * DAY + 60n);
  await w.poll(); // Expired alert
  sent = [];
  chain.execute(); // skipExpired
  await w.poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['closed:1']);
  assert.equal(hooks()[0].json.title, 'Removed: Withdraw 0.000000000000000001 ETH');
  assert.match(hooks()[0].json.message, /was not finished in time and was removed\. No money moved\.$/);
});

test('a new canceller and a call on the Roles modifier get the highest priority', async () => {
  chain.withCancel();
  const w = watcher();
  await w.poll();
  sent = [];
  chain.rolesModules = [OWNER_WALLET, GUARDIAN, STRANGER];
  await w.poll();
  assert.deepEqual(hooks().map((h) => h.json.event), ['settings_changed']);
  assert.equal(hooks()[0].json.priority, 5);
  assert.equal(hooks()[0].json.message, `${STRANGER} can now cancel a request.\n\nIf you did not want this, look at your Chronobox now.`);
  sent = [];
  await w.poll();
  assert.equal(sent.length, 0);

  chain.rolesOwner = STRANGER;
  chain.safeModules = [DELAY];
  await w.poll();
  const m = hooks()[0].json.message;
  assert.ok(m.startsWith('This Chronobox cannot cancel a request any more.'));
  assert.doesNotMatch(m, /Warning|0x6a6a/);

  sent = [];
  chain.withCancel();
  await w.poll(); // Roles back, owner is not the burn address
  assert.match(hooks()[0].json.message, /^This Chronobox can now cancel a request\.\n0x0e0e\w+, 0x6a6a\w+ and 0xbaba\w+ can now cancel a request\.\nWith a guardian, these are the guardian and the Safe that the guardian shares with the wallet\. That Safe can hand the Chronobox to a new wallet at once\.\nWarning: the address 0xbaba\w+ can change who can cancel and what they can do\./);
  sent = [];
  chain.enqueue(ROLES, 0n, '0x610b5925' + encAddr(STRANGER)); // enableModule(stranger)
  await w.poll();
  const n = hooks()[0];
  assert.equal(n.json.priority, 5);
  assert.equal(n.json.title, 'New request: Change this Chronobox in a way that the app does not know');
  assert.match(n.json.message, /It changes who can cancel, or what they can do\..*Technical detail: a call of enableModule\(0xbaba\w+\) on the cancel contract 0x7e7e/);
});

test('the Safe of a Chronobox owns its cancel contract: that is not a warning, another owner is', async () => {
  chain.withCancel();
  chain.rolesOwner = SAFE;
  await watcher().poll();
  assert.doesNotMatch(hooks()[0].json.message, /Warning/);
  chain.rolesOwner = STRANGER;
  sent = [];
  await watcher().poll();
  assert.match(hooks()[0].json.message, new RegExp(`The address that decides who can cancel changed from ${SAFE} to ${STRANGER}\\.\\nWarning: the address ${STRANGER} can change who can cancel`));
  // A module of the Safe that is not the delay or the cancel contract.
  chain.safeModules = [DELAY, ROLES, OTHER_PROXY];
  sent = [];
  await watcher().poll();
  assert.match(hooks()[0].json.message, new RegExp(`^Warning: ${OTHER_PROXY} can now move the money without the wait\\.\\nWarning: the address`));
});

// ---------------------------------------------------------------------------
// --all

function allConfig(extra: Record<string, string> = {}): Config {
  return parseConfig(['--all'], {
    RPC_URL: rpc.url, WEBHOOK_URL: `${notify.url}/hook`, STATE_DIR: path.join(dir, 'all'), HEARTBEAT_HOURS: '0', ...extra,
  });
}
const all = (extra: Record<string, string> = {}) => new AllWatcher(allConfig(extra), { log: (m) => logs.push(m) });

test('--all finds a new Chronobox by its Delay and sends its alerts with the address of the vault', async () => {
  chain.withCancel();
  const w = all();
  await w.poll(); // first start: begins at the newest block
  assert.equal(sent.length, 0);
  chain.create();
  assert.equal(await w.poll(), true);
  assert.deepEqual(hooks().map((s) => s.json.vault), [SAFE]);
  assert.match(hooks()[0].json.title, /Watching this Chronobox/);

  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(hooks().length, 2);
  assert.equal(hooks()[1].json.vault, SAFE);
  assert.equal(hooks()[1].json.title, 'New request: Withdraw 1.5 ETH');
  assert.match(hooks()[1].json.message, /cancel it/);

  // A restart sends nothing twice.
  await all().poll();
  assert.equal(hooks().length, 2);
});

test('--all reads a quiet Chronobox only when it queues something', async () => {
  const w = all();
  await w.poll();
  chain.create();
  await w.poll();
  chain.calls.length = 0;
  chain.mine(600n);
  await w.poll();
  assert.equal(chain.calls.filter((c) => c === 'eth_call').length, 0);
  assert.equal(chain.calls.filter((c) => c === 'eth_getLogs').length, 1);

  // Something waits: the vault is read on every poll until the queue is empty again.
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  chain.mine(2n * DAY);
  await w.poll();
  assert.match(hooks().at(-1)!.json.title, /^Wait over/);
  chain.execute();
  await w.poll();
  assert.match(hooks().at(-1)!.json.title, /^Done/);
  chain.calls.length = 0;
  chain.mine(600n);
  await w.poll();
  assert.equal(chain.calls.filter((c) => c === 'eth_call').length, 0);
});

test('--all finds an older Chronobox when it queues a transaction', async () => {
  const w = all();
  await w.poll();
  chain.mine(12n);
  chain.enqueue(STRANGER, ONE_HALF_ETH);
  await w.poll();
  assert.equal(hooks().length, 1);
  assert.equal(hooks()[0].json.vault, SAFE);
  assert.match(hooks()[0].json.title, /Watching this Chronobox/);
  assert.equal(hooks()[0].json.priority, 4);
  assert.match(hooks()[0].json.message, /One request waits:\nSend 1\.5 ETH to 0xbaba…baba\. Its wait ends on /);
});

test('--all with START_BLOCK finds Chronoboxes that are already there', async () => {
  chain.create();
  chain.mine(600n);
  await all({ START_BLOCK: '900' }).poll();
  assert.deepEqual(hooks().map((s) => s.json.vault), [SAFE]);
});

test('--all ignores a Delay that is not a Chronobox', async () => {
  const cases: (() => void)[] = [
    () => { chain.safeOwners = [OWNER_WALLET]; },
    () => { chain.safeOwners = [BURN_ADDRESS, OWNER_WALLET]; },
    () => { chain.safeModules = [DELAY, OTHER_PROXY]; },
    () => { chain.safeModules = [ROLES]; },
    () => { chain.codes[DELAY] = proxyCode('0x' + '11'.repeat(20)); },
  ];
  for (const [i, change] of cases.entries()) {
    chain = new MockChain();
    change();
    const w = all({ STATE_DIR: path.join(dir, `not-${i}`) });
    await w.poll();
    chain.create();
    chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
    assert.equal(await w.poll(), true);
    assert.equal(sent.length, 0, `case ${i}`);
    assert.deepEqual(w.state.vaults, {});
  }
});

test('--all settings', () => {
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x' }), /Set TELEGRAM_TOKEN and\/or WEBHOOK_URL/);
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', WEBHOOK_URL: 'http://h', CHRONOBOX: SAFE }), /CHRONOBOX does not work with --all/);
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', WEBHOOK_URL: 'ftp://h' }), /WEBHOOK_URL must start/);
  assert.throws(() => parseConfig(['--all', '--ntfy-server', 'http://n'], { RPC_URL: 'http://x' }), /Unknown flag/);
  const c = parseConfig([], { ALL: '1', RPC_URL: 'http://x', WEBHOOK_URL: 'https://h.example/x', START_BLOCK: '12' });
  assert.equal(c.all, true);
  assert.equal(c.startBlock, 12);
});

test('--all tries a failed delivery again on the next poll', async () => {
  const w = all();
  await w.poll();
  chain.create();
  notifyFails = true;
  await w.poll();
  assert.equal(sent.length, 0);
  assert.equal(w.state.vaults[SAFE].active, true);
  notifyFails = false;
  await w.poll();
  assert.deepEqual(hooks().map((s) => s.json.vault), [SAFE]);
  assert.equal(w.state.vaults[SAFE].active, false);
});

// ---------------------------------------------------------------------------
// --all with a Telegram bot

/** The watcher of every Chronobox with a bot. `hookToo: false` leaves the webhook out: Telegram only. */
function withBot(extra: Record<string, string> = {}, hookToo = true) {
  const env: Record<string, string> = {
    RPC_URL: rpc.url, STATE_DIR: path.join(dir, 'all'), HEARTBEAT_HOURS: '0', TELEGRAM_TOKEN: TG_TOKEN, TELEGRAM_KEY: TG_KEY, TELEGRAM_API: telegramApi.url, ...extra,
  };
  if (hookToo) env.WEBHOOK_URL = `${notify.url}/hook`;
  const cfg = parseConfig(['--all'], env);
  const bot = new Telegram(cfg, { log: (m) => logs.push(m) });
  const w = new AllWatcher(cfg, { log: (m) => logs.push(m), telegram: bot });
  return { w, bot, cfg };
}
const START = `/start ${telegramStart(1, SAFE)}`;
const ANNA = 4001, BEN = 4002, CARL = 4003;

test('Telegram: Start subscribes a chat, and the alerts of the vault go to it', async () => {
  chain.withCancel();
  const { w, bot } = withBot();
  await bot.start();
  assert.equal(bot.username, 'chronobox_test_bot');
  await w.poll();
  chain.create();
  await w.poll();
  assert.equal(said.length, 0, 'nobody listens yet, and "Watching" is not for a chat');

  assert.equal(telegramStart(1, SAFE.toUpperCase().replace('0X', '0x')), `1-${SAFE}`);
  person(ANNA, START);
  assert.equal(await bot.pump(), 1);
  assert.equal(saidTo(ANNA).length, 1);
  assert.match(saidTo(ANNA)[0], /^You now get the alerts of the Chronobox 0x5a5a…5a5a on Ethereum\./);
  assert.match(saidTo(ANNA)[0], /Nothing waits there right now\./);
  assert.match(saidTo(ANNA)[0], /I keep the number of this chat and the address of the Chronobox\. I keep nothing else\./);
  assert.match(saidTo(ANNA)[0], /I never send links/);
  assert.doesNotMatch(saidTo(ANNA)[0], /https?:/);
  // The bot keeps the number of the chat and the vault, and nothing about the person.
  assert.deepEqual(bot.state.chats, { [ANNA]: [`1-${SAFE}`] });
  assert.doesNotMatch(logs.join('\n'), new RegExp(String(ANNA)));
  // On disk the list is one sealed block: no address and no list that somebody can read without the key.
  const text = fs.readFileSync(path.join(dir, 'all', 'telegram.json'), 'utf8');
  const file = JSON.parse(text);
  assert.deepEqual(Object.keys(file).sort(), ['offset', 'sealed', 'version']);
  assert.equal(file.version, 2);
  assert.doesNotMatch(text, new RegExp(`${SAFE.slice(2)}|chats|Somebody|somebody|${TG_KEY}`, 'i'));
  assert.doesNotMatch(Buffer.from(file.sealed, 'base64').toString('latin1'), new RegExp(`${SAFE.slice(2)}|${ANNA}`));

  // A message is read one time.
  assert.equal(await bot.pump(), 0);
  // Start a second time does not subscribe twice.
  person(ANNA, START);
  await bot.pump();
  assert.deepEqual(bot.state.chats[ANNA], [`1-${SAFE}`]);

  said = [];
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(said.length, 1);
  assert.equal(said[0].chat, ANNA);
  assert.equal(said[0].silent, false);
  assert.match(said[0].text, /^New request: Withdraw 1\.5 ETH\n\nSomebody asked this Chronobox to withdraw 1\.5 ETH\./);
  assert.match(said[0].text, /If not, open your Chronobox and cancel it\./);
  assert.match(said[0].text, /Chronobox 0x5a5a…5a5a on Ethereum$/);
  assert.match(hooks().at(-1)!.json.title, /^New request/, 'the webhook gets the same alert');

  // A stranger as the receiver is marked, because Telegram cannot ring louder.
  chain.enqueue(STRANGER, ONE_HALF_ETH);
  await w.poll();
  assert.match(said[1].text, /^\u26A0\uFE0F New request: Send 1\.5 ETH to 0xbaba…baba\n/);

  // A restart sends nothing twice and keeps the chat.
  const again = withBot();
  await again.w.poll();
  assert.equal(said.length, 2);
  assert.deepEqual(again.bot.subscribers(1, SAFE), [String(ANNA)]);
});

test('Telegram: a Chronobox that the watcher has not seen is found when somebody asks, and the answer says what waits', async () => {
  chain.withCancel();
  chain.create();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  chain.mine(600n);
  const { w, bot } = withBot({}, false);
  await w.poll(); // begins at the newest block: the Chronobox is older
  assert.deepEqual(w.state.vaults, {});
  person(ANNA, START);
  await bot.pump();
  assert.deepEqual(Object.keys(w.state.vaults), [SAFE]);
  assert.equal(saidTo(ANNA).length, 1, 'one answer, and no "Watching" message');
  assert.match(saidTo(ANNA)[0], /Right now one request waits there:\nWithdraw 1\.5 ETH\. Its wait ends on /);

  // From here on it is watched like every other one.
  chain.mine(2n * DAY);
  await w.poll();
  assert.match(saidTo(ANNA)[1], /^Wait over: Withdraw 1\.5 ETH/);
});

test('Telegram: an address that is not a Chronobox, another network, a broken link, the limit', async () => {
  const { w, bot } = withBot();
  await w.poll();
  person(ANNA, `/start 1-${STRANGER}`);
  person(ANNA, `/start 137-${SAFE}`);
  person(ANNA, '/start hello');
  person(ANNA, '/start');
  person(ANNA, 'what is this?');
  person(-500, 'hello group', 'group');
  await bot.pump();
  const got = saidTo(ANNA);
  assert.match(got[0], new RegExp(`^${STRANGER} is not a Chronobox on Ethereum\\.`));
  assert.equal(got[1], 'I do not watch Polygon.');
  for (const help of got.slice(2)) assert.match(help, /^To get alerts, open your Chronobox, tap "Get told" and then "Telegram"\./);
  assert.equal(got.length, 5);
  assert.equal(saidTo(-500).length, 0, 'in a group the bot answers commands only');
  assert.deepEqual(bot.state.chats, {});

  // A Safe with an owner is not a Chronobox, also when it has the Delay.
  chain.safeOwners = [OWNER_WALLET];
  person(ANNA, START);
  await bot.pump();
  assert.match(saidTo(ANNA).at(-1)!, /is not a Chronobox on Ethereum/);
  chain.safeOwners = [BURN_ADDRESS];

  // The limit per chat.
  bot.state.chats[BEN] = Array.from({ length: TELEGRAM_MAX_PER_CHAT }, (_, i) => `1-0x${String(i).padStart(40, '0')}`);
  person(BEN, START);
  await bot.pump();
  assert.match(saidTo(BEN)[0], /follows 20 Chronoboxes already\. That is the limit\./);
  assert.equal(bot.state.chats[BEN].length, TELEGRAM_MAX_PER_CHAT);

  // The chain cannot be read: no subscription, and an honest answer.
  chain.down = true;
  person(CARL, START);
  await bot.pump();
  assert.equal(saidTo(CARL)[0], 'I cannot read the network right now. Try again in a few minutes.');
  assert.equal(bot.state.chats[CARL], undefined);
});

test('Telegram: the bot does not know the network before the watcher read the chain', async () => {
  chain.down = true;
  const { w, bot } = withBot();
  await w.poll();
  person(ANNA, START);
  await bot.pump();
  assert.equal(saidTo(ANNA)[0], 'I cannot read the network right now. Try again in a few minutes.');
  chain.down = false;
  await w.poll();
  person(ANNA, START);
  await bot.pump();
  assert.match(saidTo(ANNA)[1], /^You now get the alerts/);
});

test('Telegram: /stop, /list and /privacy', async () => {
  const { w, bot } = withBot();
  await w.poll();
  chain.create();
  await w.poll();
  person(ANNA, START);
  person(BEN, `/start@chronobox_test_bot ${telegramStart(1, SAFE)}`);
  person(ANNA, '/list');
  person(ANNA, '/privacy');
  await bot.pump();
  assert.deepEqual(bot.subscribers(1, SAFE), [String(ANNA), String(BEN)]);
  assert.equal(saidTo(ANNA)[1], `This chat follows:\n${SAFE} on Ethereum\n\n/stop ends all of them. /stop and an address ends one.`);
  assert.match(saidTo(ANNA)[2], /I do not keep your name, your username or your messages\./);

  person(ANNA, `/stop ${STRANGER}`);
  person(ANNA, `/stop ${SAFE}`);
  person(ANNA, '/stop');
  person(BEN, '/stop');
  await bot.pump();
  assert.match(saidTo(ANNA)[3], /^This chat does not follow/);
  assert.equal(saidTo(ANNA)[4], 'Done. You get no more alerts here, and I deleted this chat from my list.');
  assert.equal(saidTo(ANNA)[5], 'This chat follows no Chronobox.');
  // The alerts do not go off in silence: the chat that still listens is told.
  assert.equal(saidTo(BEN)[1], 'A chat that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them. You still get them here.');
  assert.equal(saidTo(BEN)[2], 'Done. You get no more alerts here, and I deleted this chat from my list.');
  assert.deepEqual(withBot().bot.state.chats, {}, 'the file on disk holds no chat any more');

  said = [];
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(said.length, 0);
});

test('Telegram: a failed chat is tried again without a second message to the others, and a blocked bot is a stop', async () => {
  const { w, bot } = withBot();
  await w.poll();
  chain.create();
  await w.poll();
  for (const chat of [ANNA, BEN, CARL]) person(chat, START);
  await bot.pump();
  said = [];

  tgRefuse[BEN] = { code: 500, description: 'Internal Server Error', once: true };
  tgRefuse[CARL] = { code: 403, description: 'Forbidden: bot was blocked by the user' };
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.deepEqual(said.map((m) => m.chat), [ANNA]);
  assert.match(logs.join('\n'), /via telegram failed, will retry next poll/);
  assert.deepEqual(bot.subscribers(1, SAFE), [String(ANNA), String(BEN)], 'the chat that blocked the bot is gone');
  await w.poll();
  assert.deepEqual(said.map((m) => m.chat), [ANNA, BEN]);
  await w.poll();
  assert.equal(said.length, 2);
  assert.doesNotMatch(logs.join('\n'), new RegExp(TG_TOKEN));
});

test('Telegram only: a quiet Chronobox is read for "All quiet" only when a chat follows it, and that message is silent', async () => {
  const { w, bot } = withBot({ HEARTBEAT_HOURS: '24' }, false);
  await w.poll();
  chain.create();
  await w.poll();
  chain.calls.length = 0;
  chain.mine(2n * DAY);
  await w.poll();
  assert.equal(chain.calls.filter((c) => c === 'eth_call').length, 0, 'nobody listens, so nothing is read');

  person(ANNA, START);
  await bot.pump();
  chain.mine(2n * DAY);
  await w.poll();
  assert.match(said.at(-1)!.text, /^All quiet/);
  assert.equal(said.at(-1)!.silent, true);
});

test('Telegram: the list of chats on disk opens only with the key', async () => {
  const { w, bot, cfg } = withBot();
  await w.poll();
  chain.create();
  await w.poll();
  person(ANNA, START);
  person(BEN, START);
  await bot.pump();
  const file = path.join(dir, 'all', 'telegram.json');
  const first = JSON.parse(fs.readFileSync(file, 'utf8')).sealed;

  // The same key reads it, after a restart too. Every write uses a new nonce.
  assert.deepEqual(new Telegram(cfg).subscribers(1, SAFE), [String(ANNA), String(BEN)]);
  person(ANNA, '/stop');
  await bot.pump();
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sealed.slice(0, 16), first.slice(0, 16));

  // Another key, or a file that was changed: the watcher stops and says why, without the key in the message.
  const other = 'another-secret-that-is-also-long-enough-98765';
  assert.throws(() => new Telegram({ ...cfg, telegramKey: other }), (e: Error) => e instanceof ConfigError && /TELEGRAM_KEY does not open/.test(e.message) && !e.message.includes(other));
  const saved = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(saved);
  const bytes = Buffer.from(parsed.sealed, 'base64');
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, JSON.stringify({ ...parsed, sealed: bytes.toString('base64') }));
  assert.throws(() => new Telegram(cfg), /TELEGRAM_KEY does not open/);
  fs.writeFileSync(file, saved);

  // A list from before the encryption is sealed at the first start.
  fs.writeFileSync(file, JSON.stringify({ version: 1, offset: 7, chats: { [CARL]: [`1-${SAFE}`] } }));
  const moved = new Telegram(cfg, { log: (m) => logs.push(m) });
  assert.deepEqual(moved.state, { offset: 7, chats: { [CARL]: [`1-${SAFE}`] } });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /chats/);
  assert.deepEqual(new Telegram(cfg).state, moved.state);
  assert.doesNotMatch(logs.join('\n'), new RegExp(TG_KEY));
});

test('Telegram settings', async () => {
  const base = { RPC_URL: 'http://x', TELEGRAM_KEY: TG_KEY };
  // The key that encrypts the list of chats is not optional, and a short one is refused without being repeated.
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', TELEGRAM_TOKEN: TG_TOKEN }), /TELEGRAM_KEY is required with TELEGRAM_TOKEN/);
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', TELEGRAM_TOKEN: TG_TOKEN, TELEGRAM_KEY: 'too-short' }), (e: Error) => /TELEGRAM_KEY is required/.test(e.message) && !/too-short/.test(e.message));
  assert.throws(() => parseConfig([], { ...base, CHRONOBOX: SAFE, WEBHOOK_URL: 'http://h/x', TELEGRAM_TOKEN: TG_TOKEN }), /TELEGRAM_TOKEN works with --all only/);
  assert.throws(() => parseConfig(['--all'], { ...base, TELEGRAM_TOKEN: 'nonsense' }), (e: Error) => /does not look like a bot token/.test(e.message) && !/nonsense/.test(e.message));
  assert.throws(() => parseConfig(['--all'], { ...base, TELEGRAM_TOKEN: TG_TOKEN, TELEGRAM_API: 'ftp://t' }), /TELEGRAM_API must start/);
  // Telegram alone is enough.
  const c = parseConfig(['--all'], { RPC_URL: 'http://a, http://b ; http://c', TELEGRAM_TOKEN: TG_TOKEN, TELEGRAM_KEY: TG_KEY });
  assert.equal(c.telegramApi, 'https://api.telegram.org');
  assert.deepEqual(c.networks, [['http://a', 'http://b'], ['http://c']]);
  assert.deepEqual(c.rpcUrls, ['http://a', 'http://b']);
  assert.throws(() => parseConfig([], { RPC_URL: 'http://a;http://b', CHRONOBOX: SAFE, WEBHOOK_URL: 'http://h/x' }), /works with --all only/);

  // A token that Telegram does not accept is a configuration error, and the token is not in the message.
  const wrong = parseConfig(['--all'], { ...base, STATE_DIR: path.join(dir, 'wrong'), TELEGRAM_TOKEN: '999:AAwrong-token_0123456789abcdef', TELEGRAM_API: telegramApi.url });
  await assert.rejects(new Telegram(wrong).start(), (e: Error) => e instanceof ConfigError && !/AAwrong/.test(e.message));
});

test('config, time and status helpers', () => {
  assert.throws(() => parseConfig([], {}), ConfigError);
  assert.throws(() => parseConfig(['--rpc-url', 'http://x'], { CHRONOBOX: SAFE }), /Set WEBHOOK_URL, or use --dry-run/);
  const c = parseConfig(['--rpc-url', 'http://a, https://b', '--chronobox', SAFE, '--dry-run', '--once', '--poll-seconds=5'], {});
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
