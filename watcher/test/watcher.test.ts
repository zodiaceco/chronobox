import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Watcher, AllWatcher, MemoryStore, NOTICE_GAP_MS, NOTICE_MIN_FOLLOW_MS, MAX_QUEUE, MODULE_PROXY_FACTORY, MASTER_COPY, BadAnswerError, RevertError, decodeAddressArray, decodeAddresses, Telegram, batchCalls, fmtWhen, telegramStart, TELEGRAM_MAX_PER_CHAT, parseConfig, ConfigError, itemStatus, fmtTime, fmtDuration, describeTx,
  encAddr, proxyCode, BURN_ADDRESS, SENTINEL, SEL,
} from '../src/index.ts';
import type { Config } from '../src/index.ts';
import {
  DAY, DELAY, GUARDIAN, MockChain, encAddrArray, T0, OTHER_PROXY, OWNER_WALLET, ROLES, SAFE, STRANGER, TOKEN, handle, startServer, u,
} from './mocks.ts';
import { main } from '../src/cli.ts';
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
/** The time of the bot (ms). */
let tgNow = Date.now();
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
  tgNow = Date.now();
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

  // The case of the finding: in ONE block, a request that is ready is carried out, and the one after it is
  // cancelled. The state of the block before says nothing about that. The logs of the Safe do.
  chain.enqueue(STRANGER, 3n); // #3, ready at the cancel
  chain.mine(2n * DAY + 60n);
  chain.enqueue(OWNER_WALLET, 4n); // #4, still waiting at the cancel
  await w.poll();
  sent = [];
  chain.execute();
  chain.cancel(5, true);
  await w.poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}`), ['closed:3', 'cancelled:4']);
  assert.equal(hooks()[0].json.title, 'Done: Send 0.000000000000000003 ETH to 0xbaba…baba');
  assert.match(hooks()[0].json.message, /was carried out\. The money left this Chronobox\.$/);
  assert.doesNotMatch(hooks()[0].json.message, /No money moved/);
});

test('a cancel that failed is no cancel, and what the logs cannot explain never says that no money moved', async () => {
  chain.withCancel();
  const w = watcher();
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH); // #0
  chain.enqueue(OWNER_WALLET, 1n); // #1
  chain.mine(2n * DAY + 60n);
  await w.poll();
  sent = [];
  // A cancel that failed is logged by the Safe, with its failure. Nothing changed.
  chain.failedCancel(2);
  await w.poll();
  assert.deepEqual(hooks(), []);
  // The Delay carries out #0, but the Safe logs something else than #0 asked for: the replay does not trust itself.
  chain.execute();
  const call = chain.safeLogs.at(-2)!;
  call.data = call.data.replace(encAddr(OWNER_WALLET), encAddr(STRANGER));
  chain.execute(true);
  await w.poll();
  assert.deepEqual(hooks().map((h) => `${h.json.event}:${h.json.nonce}:${h.json.priority}`), ['closed:0:4', 'closed:1:4']);
  for (const h of hooks()) {
    assert.match(h.json.message, /It was carried out, or it was cancelled\. The alert service could not see which\. If nobody cancelled it, the money left this Chronobox\./);
    assert.doesNotMatch(h.json.message, /No money moved/);
  }
});

test('a withdrawal carried out before the delay got shorter is "carried out", not "removed": each by the timing of its time', async () => {
  // The case of the finding: delay 7 days, 7 days to finish. A withdrawal, and a shorter delay (1 hour) after it.
  chain.withCancel();
  chain.cooldown = 7n * DAY;
  chain.expiration = 7n * DAY;
  const w = watcher();
  await w.poll();
  chain.enqueue(STRANGER, ONE_HALF_ETH); // #0
  chain.enqueue(DELAY, 0n, '0xebb2b4a2' + u(3600)); // #1: delay 1 hour
  await w.poll();
  // Just after 7 days and 1 hour: both are ready. By the new delay, #0 would have run out of time long ago.
  chain.mine(7n * DAY + 3600n + 120n);
  sent = [];
  chain.execute();
  chain.execute(true);
  await w.poll();
  const closed = hooks().filter((h) => h.json.event === 'closed');
  assert.deepEqual(closed.map((h) => [h.json.nonce, h.json.title]), [
    [0, 'Done: Send 1.5 ETH to 0xbaba…baba'],
    [1, 'Done: Change the delay to 1 hour'],
  ]);
  assert.match(closed[0].json.message, /The money left this Chronobox\./);
  assert.ok(hooks().every((h) => !/No money moved/.test(h.json.message)));
  assert.ok(hooks().some((h) => h.json.event === 'settings_changed'));
});

test('a request is "removed" only if its time had run out by the timing then, and the timing adds up', async () => {
  chain.withCancel();
  const w = watcher();
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH); // #0
  await w.poll();
  chain.mine(2n * DAY + 30n); // #0 ready, #1 queued now
  chain.enqueue(OWNER_WALLET, 1n); // #1
  await w.poll();
  // #0 runs out of time and is removed (no log), then #1 is carried out: proved by its log.
  chain.mine(7n * DAY);
  sent = [];
  chain.skipExpired();
  chain.execute();
  await w.poll();
  assert.deepEqual(hooks().filter((h) => h.json.event === 'closed').map((h) => [h.json.nonce, h.json.title]), [
    [0, 'Removed: Withdraw 1.5 ETH'],
    [1, 'Done: Withdraw 0.000000000000000001 ETH'],
  ]);

  // The timing changed without a log that the replay can read (here: the stand-in sets it). Then it cannot say
  // that a request was removed: it may have been carried out under another timing.
  chain.enqueue(OWNER_WALLET, 2n); // #2
  await w.poll();
  chain.mine(2n * DAY + 7n * DAY + 60n);
  sent = [];
  chain.skipExpired();
  chain.cooldown = 3n * DAY;
  await w.poll();
  const closed = hooks().filter((h) => h.json.event === 'closed');
  assert.deepEqual(closed.map((h) => [h.json.nonce, h.json.title, h.json.priority]), [[2, 'Closed: Withdraw 0.000000000000000002 ETH', 4]]);
  assert.doesNotMatch(closed[0].json.message, /No money moved/);
});

test('a request that ran out of time before the time to finish got longer is still "removed"', async () => {
  // Delay 2 days, 7 days to finish. #0 runs out of time and is removed; then #1 gives 30 days to finish, and #2 is
  // carried out. By the 30 days of now, #0 would not have run out of time: only the timing then says it did.
  chain.withCancel();
  const w = watcher();
  await w.poll();
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH); // #0
  await w.poll();
  chain.mine(8n * DAY);
  chain.enqueue(DELAY, 0n, '0x9b56d5be' + u(30n * DAY)); // #1: 30 days to finish
  chain.enqueue(OWNER_WALLET, 1n); // #2
  await w.poll();
  chain.mine(2n * DAY + 60n); // #0 is 10 days old: void. #1 and #2 are ready.
  sent = [];
  chain.skipExpired();
  chain.execute();
  chain.execute(true);
  await w.poll();
  assert.deepEqual(hooks().filter((h) => h.json.event === 'closed').map((h) => [h.json.nonce, h.json.title]), [
    [0, 'Removed: Withdraw 1.5 ETH'],
    [1, 'Done: Change this Chronobox in a way that the app does not know'],
    [2, 'Done: Withdraw 0.000000000000000001 ETH'],
  ]);
});

test('a request the watcher could not read proves nothing: it cannot take the log of a real withdrawal', async () => {
  // The case of the finding. 51 requests wait at the first start: the watcher reads 50, and #50 stays unknown.
  chain.withCancel();
  for (let i = 0; i < 51; i++) chain.enqueue(OWNER_WALLET, BigInt(i + 1));
  const w = watcher();
  await w.poll();
  assert.equal(w.state.items['50'].kind, 'unknown');
  chain.mine(DAY);
  chain.enqueue(STRANGER, ONE_HALF_ETH); // #51, known
  await w.poll();
  // #0 to #50 run out of time (9 days) and are removed. #51 is carried out just before its own end.
  chain.mine(8n * DAY + 60n);
  chain.skipExpired(51);
  chain.mine(DAY - 180n);
  sent = [];
  chain.execute();
  // The next poll is just after #51 would have run out of time.
  chain.mine(240n);
  await w.poll();
  const closed = hooks().filter((h) => h.json.event === 'closed');
  const last = closed.find((h) => h.json.nonce === 51)!;
  assert.equal(last.json.title, 'Done: Send 1.5 ETH to 0xbaba…baba');
  assert.match(last.json.message, /The money left this Chronobox\./);
  assert.equal(closed.find((h) => h.json.nonce === 50)!.json.title, 'Removed: Do something that the alert service could not read');
  assert.equal(closed.filter((h) => /^Removed/.test(h.json.title)).length, 51);
});

test('an execution while an unread request is still valid leaves the replay unsure, never "no money moved"', async () => {
  chain.withCancel();
  for (let i = 0; i < 51; i++) chain.enqueue(OWNER_WALLET, BigInt(i + 1));
  chain.mine(2n * DAY + 60n);
  const w = watcher();
  await w.poll();
  // #0 to #49 carried out; then the Delay carries out #50, which the watcher never read.
  sent = [];
  for (let i = 0; i < 51; i++) chain.execute(i > 0);
  await w.poll();
  const closed = hooks().filter((h) => h.json.event === 'closed');
  assert.equal(closed.length, 51);
  assert.ok(closed.slice(0, 50).every((h) => /^Done/.test(h.json.title)));
  assert.equal(closed[50].json.title, 'Closed: Do something that the alert service could not read');
  assert.ok(closed.every((h) => !/No money moved/.test(h.json.message)));
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
  chain.skipExpired();
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
  // Two searches: the requests of the known Delays, and new Delays from the factory. Never all contracts.
  assert.equal(chain.calls.filter((c) => c === 'eth_getLogs').length, 2);
  assert.deepEqual(chain.logQueries.slice(-2), [[DELAY], [MODULE_PROXY_FACTORY]]);

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

test('--all does not read logs of unknown contracts: an older Chronobox is found by START_BLOCK or by a Start', async () => {
  // Anybody can deploy contracts that emit TransactionAdded. Reading those would let anybody fill a poll.
  const w = all();
  await w.poll();
  chain.mine(12n);
  chain.enqueue(STRANGER, ONE_HALF_ETH);
  assert.equal(await w.poll(), true);
  assert.equal(sent.length, 0);
  assert.deepEqual(w.state.vaults, {});
  for (const q of chain.logQueries) assert.ok(q.length > 0 && q.every((a) => a === MODULE_PROXY_FACTORY), JSON.stringify(q));
});

test('--all: a flood of Delays from the factory waits in a queue, saved before any check, and drains a batch per poll', async () => {
  // 50 Delays that are no Chronobox, then the real one.
  for (let i = 0; i < 50; i++) chain.otherCreated.push({ delay: '0x' + (i + 1).toString(16).padStart(40, '0'), block: chain.head + 1 });
  let now = 1_000_000;
  const store = new MemoryStore();
  const w = new AllWatcher(allConfig(), { log: (m) => logs.push(m), store, clock: () => now });
  await w.poll();
  chain.mine(12n);
  chain.create();
  // No time at all: one batch per poll, and nothing else.
  await w.poll({ deadline: now - 1 });
  const saved = JSON.parse((await store.get('all'))!);
  assert.equal(saved.lastBlock, chain.head, 'the search is saved, with the queue, so it is not done again');
  assert.equal(saved.queue.length, 51 - 8);
  assert.equal(w.report.queued, 43);
  let polls = 1;
  while (Object.keys(w.state.vaults).length === 0) { await w.poll({ deadline: now - 1 }); polls++; }
  assert.equal(polls, 7, 'the real one was last in the queue');
  assert.equal(w.report.queued, 0);
  // With time (the CLI has no deadline), the whole queue at once.
  chain = new MockChain();
  for (let i = 0; i < 30; i++) chain.otherCreated.push({ delay: '0x' + (i + 1).toString(16).padStart(40, '0'), block: chain.head + 1 });
  const cli = all({ STATE_DIR: path.join(dir, 'drain') });
  await cli.poll();
  chain.mine(12n);
  chain.create();
  await cli.poll();
  assert.deepEqual(Object.keys(cli.state.vaults), [SAFE]);
  assert.equal(cli.report.queued, 0);

  // More than MAX_QUEUE: the rest is dropped and said so. A Chronobox among them is found when somebody presses Start.
  chain = new MockChain();
  const big = all({ STATE_DIR: path.join(dir, 'big') });
  await big.poll();
  for (let i = 0; i < MAX_QUEUE + 5; i++) chain.otherCreated.push({ delay: '0x' + (i + 1).toString(16).padStart(40, '0'), block: chain.head + 1 });
  chain.mine(12n);
  await big.poll({ deadline: Date.now() - 1 });
  assert.match(logs.join('\n'), /5 new Delays were not queued: 1000 wait to be checked already/);
  assert.equal(big.report.queued, MAX_QUEUE - 8);
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
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x' }), /Set TELEGRAM_TOKEN, RESEND_KEY and\/or WEBHOOK_URL/);
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

test('--all: a poll out of time goes on where it stopped, so busy vaults cannot starve the others', async () => {
  // Four vaults where something always waits. The clock moves 10 ms per read, and a poll has 5 ms: one read each.
  let now = 1_000_000;
  const vaults = ['a', 'b', 'c', 'd'].map((c) => '0x' + c.repeat(40));
  const store = new MemoryStore();
  const seed = { version: 1, chainId: 1, lastBlock: chain.head, vaults: Object.fromEntries(vaults.map((v) => [v, { delay: v, active: true }])) };
  await store.set('all', JSON.stringify(seed));
  const read: string[] = [];
  let hang: string | null = null;
  const open = (st: MemoryStore) => {
    const w = new AllWatcher(allConfig(), { log: (m) => logs.push(m), store: st, clock: () => now });
    (w as any).watcherOf = (vault: string) => ({
      state: { items: { 0: {} }, outbox: [], failCount: 0, lastBlock: 1 },
      poll: async () => {
        // The time of this read is saved before the read.
        assert.equal(JSON.parse((await st.get('all'))!).vaults[vault].lookedAt, now);
        read.push(vault);
        now += 10;
        if (vault === hang) await new Promise(() => undefined); // the function is killed here
        return true;
      },
    });
    return w;
  };
  const w = open(store);
  for (let i = 0; i < 5; i++) await w.poll({ deadline: now + 5 });
  assert.deepEqual(read, [vaults[0], vaults[1], vaults[2], vaults[3], vaults[0]], 'each in turn, then from the start');
  // Skipped vaults are reported with how long the oldest waits.
  assert.deepEqual(w.report, { late: 3, overdueSeconds: 0, queued: 0, failing: 0 });
  now += 600_000;
  await w.poll({ deadline: now + 5 });
  assert.deepEqual(w.report, { late: 3, overdueSeconds: 600, queued: 0, failing: 0 });

  // A read that never ends (the function is killed): the next run starts with the vault after it.
  read.length = 0;
  hang = vaults[2];
  void w.poll({ deadline: now + 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(read, [vaults[2]]);
  hang = null;
  const after = new MemoryStore();
  for (const [k, v] of store.data) after.data.set(k, v); // the lock ran out; the state is what was saved
  await open(after).poll({ deadline: now + 5 });
  assert.deepEqual(read, [vaults[2], vaults[3]]);
});

// A Delay from the factory (genuine code) in front of a contract that only says it is a Chronobox. Anybody can
// deploy one: the contract answers what it likes.
const FAKE_DELAY = '0x' + 'fd'.repeat(20);
const FAKE_SAFE = '0x' + 'fa'.repeat(20);
function fakeChronobox(c: MockChain) {
  const a = c.answers;
  c.codes[FAKE_DELAY] = proxyCode(MASTER_COPY.delay);
  for (const sel of [SEL.owner, SEL.avatar, SEL.target]) a[`${FAKE_DELAY}:${sel}`] = encAddr(FAKE_SAFE);
  for (const sel of [SEL.txCooldown, SEL.txExpiration, SEL.txNonce]) a[`${FAKE_DELAY}:${sel}`] = u(0);
  // One request waits, so the vault is read on every poll.
  a[`${FAKE_DELAY}:${SEL.queueNonce}`] = u(1);
  a[`${FAKE_DELAY}:${SEL.getTxCreatedAt}`] = u(T0 + 1n);
  a[`${FAKE_DELAY}:${SEL.getModulesPaginated}`] = encAddrArray([OWNER_WALLET], SENTINEL).slice(2);
  a[`${FAKE_SAFE}:${SEL.getOwners}`] = u(32) + u(1) + encAddr(BURN_ADDRESS);
  a[`${FAKE_SAFE}:${SEL.getModulesPaginated}`] = encAddrArray([FAKE_DELAY], SENTINEL).slice(2);
}

test('the decoders refuse answers that are not the ABI', () => {
  const good = encAddrArray([DELAY, ROLES], SENTINEL);
  assert.deepEqual(decodeAddressArray(good), { array: [DELAY, ROLES], next: SENTINEL });
  // Two modules declared, one given: before, the second one was "0x", and the RPC refused it later.
  const short = '0x' + u(64) + encAddr(SENTINEL) + u(2) + encAddr(DELAY);
  for (const bad of [short, '0x', '0x' + u(64), '0x' + u(1) + encAddr(SENTINEL) + u(0), '0x' + u(64) + 'ff'.repeat(32) + u(0),
    '0x' + u(64) + encAddr(SENTINEL) + u(1) + 'ff'.repeat(32), '0x' + u(2n ** 200n) + encAddr(SENTINEL)]) {
    assert.throws(() => decodeAddressArray(bad), BadAnswerError, bad);
  }
  assert.throws(() => decodeAddresses('0x' + u(32) + u(3) + encAddr(BURN_ADDRESS)), BadAnswerError);
  // A bad answer counts as a revert: the address is not the contract the watcher thought.
  assert.ok(new BadAnswerError('x') instanceof RevertError);
});

test('--all: a Delay whose Safe answers garbage, or whose check always fails, does not block the queue', async () => {
  const w = all();
  await w.poll();
  fakeChronobox(chain);
  chain.answers[`${FAKE_SAFE}:${SEL.getModulesPaginated}`] = u(64) + encAddr(SENTINEL) + u(2) + encAddr(FAKE_DELAY);
  const BROKEN = '0x' + 'bd'.repeat(20);
  chain.codeErrors.add(BROKEN);
  chain.otherCreated.push({ delay: FAKE_DELAY, block: chain.head + 1 }, { delay: BROKEN, block: chain.head + 1 });
  chain.mine(12n);
  chain.create();
  assert.equal(await w.poll(), true);
  // The real one is found in this poll; the garbage is no Chronobox; the broken one waits at the back.
  assert.deepEqual(Object.keys(w.state.vaults), [SAFE]);
  assert.deepEqual(hooks().map((h) => [h.json.event, h.json.vault]), [['watching', SAFE]]);
  assert.deepEqual(w.state.queue, [BROKEN]);
  // While the chain cannot be read, a failed check says nothing about the Delay.
  chain.down = true;
  await w.poll();
  chain.down = false;
  assert.deepEqual(w.state.tries, { [BROKEN]: 1 });
  await w.poll();
  await w.poll();
  assert.deepEqual(w.state.queue, []);
  assert.equal(w.state.tries, undefined);
  assert.match(logs.join('\n'), new RegExp(`gave up on the new Delay ${BROKEN} after 3 tries`));
});

test('--all: a known vault that stops answering like a Chronobox is its own problem, not the network\'s', async () => {
  let now = 1_000_000;
  const w = new AllWatcher(allConfig(), { log: (m) => logs.push(m), clock: () => now });
  await w.poll();
  fakeChronobox(chain);
  chain.otherCreated.push({ delay: FAKE_DELAY, block: chain.head + 1 });
  chain.mine(12n);
  chain.create();
  await w.poll();
  assert.deepEqual(Object.keys(w.state.vaults).sort(), [FAKE_SAFE, SAFE].sort(), 'it passed the check: it says what a Chronobox says');
  // Now its Delay answers garbage. (A real Delay cannot; this stands for anything that makes one vault unreadable.)
  chain.answers[`${FAKE_DELAY}:${SEL.txCooldown}`] = '';
  sent = [];
  assert.equal(await w.poll(), true, 'the network is fine');
  assert.equal(w.report.failing, 1);
  assert.equal(w.state.vaults[FAKE_SAFE].failures, 1);
  // It waits a minute, then two, then four.
  await w.poll();
  assert.equal(w.report.failing, 0, 'not read again yet');
  now += 61_000;
  await w.poll();
  assert.equal(w.state.vaults[FAKE_SAFE].failures, 2);
  now += 121_000;
  // Meanwhile the real one gets its alerts.
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  assert.equal(await w.poll(), true);
  assert.deepEqual(hooks().map((h) => [h.json.event, h.json.vault]).sort(), [['queued', SAFE], ['watcher_problem', FAKE_SAFE]].sort(),
    'after 3 failed reads, whoever follows the broken one is told that alerts can be late');
  assert.equal(w.state.vaults[FAKE_SAFE].retryAt, now + 240_000);
  // It answers again: back to normal.
  chain.answers[`${FAKE_DELAY}:${SEL.txCooldown}`] = u(0);
  now += 241_000;
  await w.poll();
  assert.equal(w.state.vaults[FAKE_SAFE].failures, undefined);
  assert.match(hooks().at(-1)!.json.title, /Alerts work again/);
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
  const bot = new Telegram(cfg, { log: (m) => logs.push(m), clock: () => tgNow });
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
  assert.match(saidTo(ANNA)[0], /I keep the number of this chat, the address of the Chronobox, and since when this chat follows it\. I keep nothing else\./);
  assert.match(saidTo(ANNA)[0], /I never send links/);
  assert.doesNotMatch(saidTo(ANNA)[0], /https?:/);
  // The bot keeps the number of the chat and the vault, and nothing about the person.
  assert.deepEqual(bot.state.chats, { [ANNA]: [`1-${SAFE}`] });
  assert.doesNotMatch(logs.join('\n'), new RegExp(String(ANNA)));
  // On disk the list is one sealed block: no address and no list that somebody can read without the key.
  const text = fs.readFileSync(path.join(dir, 'all', 'telegram.json'), 'utf8');
  const file = JSON.parse(text);
  assert.deepEqual(Object.keys(file).sort(), ['offset', 'sealed', 'version']);
  assert.equal(file.version, 3);
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
  await bot.edit((s) => { s.chats[BEN] = Array.from({ length: TELEGRAM_MAX_PER_CHAT }, (_, i) => `1-0x${String(i).padStart(40, '0')}`); });
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

  // A day later. (A follow of less than a day tells nobody: see the next test.)
  tgNow += NOTICE_MIN_FOLLOW_MS;
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
  assert.deepEqual((await Telegram.open(withBot().cfg)).state.chats, {}, 'the file on disk holds no chat any more');

  said = [];
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(said.length, 0);
});

test('Telegram: a stranger who follows and stops again and again rings nobody; real stops come together, once an hour', async () => {
  const DAVE = 4004, STRANGE = 4666;
  const { w, bot } = withBot();
  await w.poll();
  chain.create();
  await w.poll();
  for (const chat of [ANNA, BEN, CARL, DAVE]) person(chat, START);
  await bot.pump();
  said = [];
  // The finding: anybody can follow a public Chronobox and stop again, to ring the phones of all its followers.
  for (let i = 0; i < 10; i++) { person(STRANGE, START); person(STRANGE, '/stop'); }
  await bot.pump();
  assert.deepEqual(said.filter((m) => m.chat !== STRANGE), [], 'a follow of less than a day tells nobody');

  // A day later, real followers stop. The first stop is told at once.
  tgNow += NOTICE_MIN_FOLLOW_MS;
  person(BEN, '/stop');
  await bot.pump();
  const told = 'A chat that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them. You still get them here.';
  assert.deepEqual(said.filter((m) => m.chat !== BEN && m.chat !== STRANGE).map((m) => [m.chat, m.text]), [[ANNA, told], [CARL, told], [DAVE, told]]);
  // Two more within the hour: nobody is rung again yet, and nothing is lost.
  said = [];
  tgNow += 600_000;
  person(CARL, '/stop');
  person(DAVE, '/stop');
  await bot.pump();
  await w.poll();
  assert.deepEqual(said.filter((m) => m.chat === ANNA), []);
  // An hour after the first one, the poll sends them together.
  tgNow += NOTICE_GAP_MS;
  await w.poll();
  assert.deepEqual(saidTo(ANNA), [`2 chats that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum have stopped them since ${fmtWhen(Math.floor((tgNow - NOTICE_GAP_MS) / 1000))}. You still get them here.`]);
  await w.poll();
  assert.equal(saidTo(ANNA).length, 1, 'once');
});

test('Telegram: a list of version 2 (the chats alone) still opens, and its follows count as a day old', async () => {
  const crypto = await import('node:crypto');
  const { w, bot, cfg } = withBot();
  await w.poll();
  chain.create();
  await w.poll();
  // Version 2 sealed the chats alone, with the same key and label.
  const key = crypto.scryptSync(TG_KEY, 'chronobox-telegram-chats-v2', 32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('chronobox-telegram-chats-v2'));
  const body = Buffer.concat([cipher.update(JSON.stringify({ [ANNA]: [`1-${SAFE}`], [BEN]: [`1-${SAFE}`] })), cipher.final()]);
  fs.writeFileSync(path.join(dir, 'all', 'telegram.json'), JSON.stringify({ version: 2, sealed: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64') }));
  const old = await Telegram.open(cfg, { log: (m) => logs.push(m), clock: () => tgNow });
  assert.deepEqual(old.subscribers(1, SAFE), [String(ANNA), String(BEN)]);
  void bot;
  const w2 = new AllWatcher(cfg, { log: (m) => logs.push(m), telegram: old });
  await w2.poll();
  said = [];
  person(BEN, '/stop');
  await old.pump();
  assert.match(saidTo(ANNA)[0], /^A chat that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them\./);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'all', 'telegram.json'), 'utf8')).version, 3);
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

test('Telegram: an alert that waits does not show in the state of the vault which chats got it', async () => {
  const { w, bot } = withBot();
  await w.poll();
  chain.create();
  await w.poll();
  for (const chat of [ANNA, BEN]) person(chat, START);
  await bot.pump();
  const stateOf = () => fs.readFileSync(path.join(dir, 'all', `${SAFE}.json`), 'utf8');
  const shows = (text: string) => /tg:-?\d+\b/.test(text) || [ANNA, BEN].some((c) => new RegExp(`\\b${c}\\b`).test(text));
  said = [];

  // Partial delivery: Anna gets it, Ben does not yet. The alert waits, stored without encryption.
  tgRefuse[BEN] = { code: 500, description: 'Internal Server Error', once: true };
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  const waiting = JSON.parse(stateOf()).outbox;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].done.filter((m: string) => m.startsWith('tg:')).length, 1, 'one chat got it');
  assert.ok(!shows(stateOf()), 'no chat in the state of the vault');
  await w.poll();
  assert.deepEqual(said.map((m) => m.chat), [ANNA, BEN], 'Ben gets it on the next poll, Anna not twice');

  // The webhook fails after both chats got the alert: it waits for the webhook, with both marks.
  said = [];
  notifyFails = true;
  chain.mine(12n);
  chain.enqueue(STRANGER, 1n);
  await w.poll();
  const [one] = JSON.parse(stateOf()).outbox;
  const marks = one.done.filter((m: string) => m.startsWith('tg:'));
  assert.equal(marks.length, 2);
  assert.ok(!shows(stateOf()));
  // The marks of this alert are not those of the last one: they do not show that the same chats got both.
  assert.ok(!marks.some((m: string) => waiting[0].done.includes(m)));
  notifyFails = false;
  await w.poll();
  assert.deepEqual(said.map((m) => m.chat), [ANNA, BEN], 'no second message when the webhook works again');

  // A mark from before the tags (the number of the chat) still counts, and becomes a tag.
  said = [];
  const old = { id: '99-queued-9', event: 'queued', title: 'x', message: 'y', priority: 3, at: 0, done: [`tg:${ANNA}`] };
  await bot.deliver(1, SAFE, old);
  assert.deepEqual(said.map((m) => m.chat), [BEN]);
  assert.ok(old.done.every((m) => !shows(m)), JSON.stringify(old.done));
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
  assert.deepEqual((await Telegram.open(cfg)).subscribers(1, SAFE), [String(ANNA), String(BEN)]);
  person(ANNA, '/stop');
  await bot.pump();
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sealed.slice(0, 16), first.slice(0, 16));

  // Another key, or a file that was changed: the watcher stops and says why, without the key in the message.
  const other = 'another-secret-that-is-also-long-enough-98765';
  await assert.rejects(Telegram.open({ ...cfg, alertsKey: other }), (e: Error) => e instanceof ConfigError && /ALERTS_KEY does not open/.test(e.message) && !e.message.includes(other));
  const saved = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(saved);
  const bytes = Buffer.from(parsed.sealed, 'base64');
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, JSON.stringify({ ...parsed, sealed: bytes.toString('base64') }));
  await assert.rejects(Telegram.open(cfg), /ALERTS_KEY does not open/);
  fs.writeFileSync(file, saved);

  // A list from before the encryption is sealed at the first start.
  fs.writeFileSync(file, JSON.stringify({ version: 1, offset: 7, chats: { [CARL]: [`1-${SAFE}`] } }));
  const moved = await Telegram.open(cfg, { log: (m) => logs.push(m) });
  assert.deepEqual(moved.state, { offset: 7, chats: { [CARL]: [`1-${SAFE}`] }, since: {}, notices: {} });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /chats/);
  assert.deepEqual((await Telegram.open(cfg)).state, moved.state);
  assert.doesNotMatch(logs.join('\n'), new RegExp(TG_KEY));
});

test('Telegram settings', async () => {
  const base = { RPC_URL: 'http://x', TELEGRAM_KEY: TG_KEY };
  // The key that encrypts the list of chats is not optional, and a short one is refused without being repeated.
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', TELEGRAM_TOKEN: TG_TOKEN }), /ALERTS_KEY is required with TELEGRAM_TOKEN or RESEND_KEY/);
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', TELEGRAM_TOKEN: TG_TOKEN, TELEGRAM_KEY: 'too-short' }), (e: Error) => /ALERTS_KEY is required/.test(e.message) && !/too-short/.test(e.message));
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

test('the CLI: a Start that waits at Telegram when the watcher starts gets its answer, not "try again"', async () => {
  chain.withCancel();
  chain.create();
  // Somebody wrote to the bot before the watcher ran, or in its first second.
  person(ANNA, START);
  const log = console.log;
  console.log = () => {};
  const until = Date.now() + 10_000;
  try {
    const env = { RPC_URL: rpc.url, STATE_DIR: path.join(dir, 'cli-all'), HEARTBEAT_HOURS: '0', POLL_SECONDS: '1', TELEGRAM_TOKEN: TG_TOKEN, TELEGRAM_KEY: TG_KEY, TELEGRAM_API: telegramApi.url };
    assert.equal(await main(['--all'], env, () => saidTo(ANNA).length > 0 || Date.now() > until), 0);
  } finally {
    console.log = log;
  }
  assert.equal(saidTo(ANNA).length, 1);
  assert.match(saidTo(ANNA)[0], /^You now get the alerts of the Chronobox 0x5a5a…5a5a on Ethereum\./);
});

test('the CLI: --dry-run writes nothing, --once writes STATE_FILE, and each network of --all has its own folder', async () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  try {
    const file = path.join(dir, 'cli.json');
    const env = { RPC_URL: rpc.url, CHRONOBOX: SAFE, STATE_FILE: file, HEARTBEAT_HOURS: '0' };
    assert.equal(await main(['--once', '--dry-run'], env), 0);
    assert.equal(fs.existsSync(file), false);
    assert.match(printed.join('\n'), /\[dry-run\] watching .*Watching this Chronobox/);
    assert.equal(await main(['--once'], { ...env, WEBHOOK_URL: `${notify.url}/hook` }), 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).vault, SAFE);
    assert.deepEqual(hooks().map((h) => h.json.event), ['watching']);

    const multi = path.join(dir, 'multi');
    assert.equal(await main(['--once', '--all'], { RPC_URL: `${rpc.url};${rpc.url}`, STATE_DIR: multi, WEBHOOK_URL: `${notify.url}/hook` }), 0);
    assert.ok(fs.existsSync(path.join(multi, 'network-1', 'all.json')));
    assert.ok(fs.existsSync(path.join(multi, 'network-2', 'all.json')));
    assert.equal(await main(['--bogus'], env), 2);
  } finally {
    console.log = log;
  }
});

// ---------------------------------------------------------------------------
// Property: whatever happens on the chain, the watcher does not contradict it.
//
// Random runs on the stand-in chain, with only what the real Delay allows: requests (withdrawals, a new delay, a new
// time to finish, a cancel of its own), time, executions, skipExpired, cancels, cancels that fail, several of them in
// one block, polls at any point, and sometimes more requests at the first start than the watcher reads. The chain
// keeps the truth of each request; every message must fit it. FUZZ_RUNS and FUZZ_SEED change the runs.

/** mulberry32: small, and the same numbers for the same seed everywhere. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: a request that was carried out is never "cancelled" or "removed", and each message fits what happened', async () => {
  const runs = Number(process.env.FUZZ_RUNS ?? 150);
  const first = Number(process.env.FUZZ_SEED ?? 20261123);
  let messages = 0;
  let unsure = 0;
  let unsureRead = 0; // in runs where the watcher read every request
  for (let r = 0; r < runs; r++) {
    const seed = first + r;
    const rand = random(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
    chain = new MockChain();
    chain.withCancel();
    chain.cooldown = pick([3600n, DAY, 2n * DAY]);
    chain.expiration = pick([0n, DAY, 7n * DAY]);
    sent = [];
    const steps: string[] = [`cooldown ${chain.cooldown}, expiration ${chain.expiration}`];
    const w = new Watcher(config({ stateFile: path.join(dir, `property-${r}.json`) }), { log: () => undefined });
    const unread = rand() < 0.2;
    if (unread) {
      const n = 51 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) chain.enqueue(OWNER_WALLET, BigInt(i + 1));
      steps.push(`${n} requests before the first start`);
    }
    await w.poll();
    let polledAt = chain.head;
    for (let step = 0; step < 40; step++) {
      const x = rand();
      const head = chain.txNonce;
      const size = chain.queue.length;
      const status = (n: number) => itemStatus(chain.queue[n].createdAt, chain.cooldown, chain.expiration, chain.now()).status;
      // Logs may go into the newest block only while the watcher has not read it.
      const same = chain.head !== polledAt && rand() < 0.5;
      if (x < 0.22) {
        const kind = pick(['mine', 'mine', 'stranger', 'delay', 'expiration', 'nonce']);
        if (kind === 'mine') chain.enqueue(OWNER_WALLET, BigInt(1 + Math.floor(rand() * 1000)));
        if (kind === 'stranger') chain.enqueue(STRANGER, BigInt(1 + Math.floor(rand() * 1000)));
        if (kind === 'delay') chain.enqueue(DELAY, 0n, '0xebb2b4a2' + u(pick([3600n, DAY, 2n * DAY, 7n * DAY])));
        if (kind === 'expiration') chain.enqueue(DELAY, 0n, '0x9b56d5be' + u(pick([0n, DAY, 7n * DAY, 30n * DAY])));
        if (kind === 'nonce') chain.enqueue(DELAY, 0n, '0x46ba2307' + u(size + 1 + Math.floor(rand() * 3)));
        steps.push(`queue #${size} ${kind}`);
      } else if (x < 0.42) {
        const t = pick([60n, 3600n, DAY, 2n * DAY, 3n * DAY, 8n * DAY]);
        chain.mine(t);
        steps.push(`wait ${t}s`);
      } else if (x < 0.57) {
        if (head >= size || status(head) !== 'ready') continue;
        // A cancel of its own must be valid when it runs, or the Delay refuses the whole execution.
        const d = chain.queue[head].data.toLowerCase();
        if (chain.queue[head].to === DELAY && d.startsWith('0x46ba2307')) {
          const n = Number(BigInt('0x' + d.slice(10)));
          if (n <= head + 1 || n > size) continue;
        }
        chain.execute(same);
        steps.push(`execute #${head}${same ? ' (same block)' : ''}`);
      } else if (x < 0.67) {
        // skipExpired removes every request in a row whose time ran out (never with no time limit).
        let n = 0;
        while (chain.expiration !== 0n && head + n < size && status(head + n) === 'expired') n++;
        if (n === 0) continue;
        chain.skipExpired(n);
        steps.push(`skipExpired #${head}..#${head + n - 1}`);
      } else if (x < 0.77) {
        if (head >= size) continue;
        const n = head + 1 + Math.floor(rand() * (size - head));
        chain.cancel(n, same);
        steps.push(`cancel to #${n}${same ? ' (same block)' : ''}`);
      } else if (x < 0.8) {
        chain.failedCancel(head);
        steps.push('a cancel that fails');
      } else {
        await w.poll();
        polledAt = chain.head;
        steps.push('poll');
      }
    }
    chain.mine(60n);
    await w.poll();

    const fail = (why: string) => {
      const said = hooks().filter((h) => h.json.nonce !== undefined).map((h) => `#${h.json.nonce} ${h.json.event}: ${h.json.title}`);
      throw new Error(`FUZZ_SEED=${seed} FUZZ_RUNS=1: ${why}\nsteps:\n  ${steps.join('\n  ')}\nsaid:\n  ${said.join('\n  ')}`);
    };
    const closing = hooks().filter((h) => h.json.event === 'closed' || h.json.event === 'cancelled');
    for (let n = 0; n < chain.txNonce; n++) {
      const told = closing.filter((h) => h.json.nonce === n);
      if (told.length !== 1) fail(`#${n} left the queue and got ${told.length} closing messages`);
      const truth = chain.outcomes[n];
      const { title, message } = told[0].json;
      messages++;
      if (/^Closed/.test(title)) { unsure++; if (!unread) unsureRead++; continue; }
      if (truth === 'executed' && (/No money moved|Nothing changed/.test(message) || !/^Done/.test(title))) fail(`#${n} was carried out, and the watcher said "${title}"`);
      if (/^Done/.test(title) && truth !== 'executed') fail(`#${n} was ${truth}, and the watcher said "${title}"`);
      if (/^Cancelled/.test(title) && truth !== 'cancelled') fail(`#${n} was ${truth}, and the watcher said "${title}"`);
      // "Removed" is also true of a request that was cancelled when its time had run out already: it was void.
      if (/^Removed/.test(title) && truth === 'executed') fail(`#${n} was ${truth}, and the watcher said "${title}"`);
    }
    if (closing.length !== chain.txNonce) fail(`${closing.length} closing messages for ${chain.txNonce} requests that left`);
  }
  console.log(`property: ${runs} runs, ${messages} requests left the queue, ${unsure} of them "carried out or cancelled" (${unsureRead} in runs where every request was read)`);
});
