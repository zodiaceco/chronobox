// The service on Vercel: the cron poll, the Telegram webhook and the health check, with Redis, the chain and
// Telegram as stand-ins. The handlers are called the way vercel.ts calls them.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {
  BusyError, ConfigError, RedisStore, Telegram, health, parseConfig, poll, serviceConfig, telegramStart, telegramWebhook,
  type Env, type Request,
} from '../src/index.ts';
import { vercelFunction } from '../src/vercel.ts';
import { DAY, FakeRedis, MockChain, OWNER_WALLET, SAFE, handle, startServer } from './mocks.ts';

const TG_TOKEN = '123456:AAfake-token_for-the-service-0123456789';
const TG_KEY = 'a-secret-for-the-service-test-that-is-long-0123';
const CRON = 'cron-secret-for-the-tests-0123';
const REDIS_TOKEN = 'redis-token-for-the-tests';
const ANNA = 4001;
const ONE_ETH = 10n ** 18n;

let chain: MockChain;
let rpcDelayMs = 0;
let rpc: { url: string; close: () => Promise<void> };
let redis: FakeRedis;
let redisServer: { url: string; close: () => Promise<void> };
let tg: { url: string; close: () => Promise<void> };
let said: { chat: number; text: string }[] = [];
let tgCalls: { method: string; args: any }[] = [];
const logs: string[] = [];
const deps = { log: (m: string) => { logs.push(m); } };

before(async () => {
  rpc = await startServer(async (_req, body, res) => {
    if (rpcDelayMs) await new Promise((r) => setTimeout(r, rpcDelayMs));
    const msg = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...handle(chain, msg.method, msg.params ?? []) }));
  });
  redis = new FakeRedis(REDIS_TOKEN);
  redisServer = await redis.serve();
  tg = await startServer((req, body, res) => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url!);
    const answer = (json: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    if (!m || m[1] !== TG_TOKEN) { res.writeHead(401).end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); return; }
    const args = body ? JSON.parse(body) : {};
    tgCalls.push({ method: m[2], args });
    if (m[2] === 'getMe') return answer({ ok: true, result: { id: 1, is_bot: true, username: 'chronobox_service_bot' } });
    if (m[2] === 'sendMessage') said.push({ chat: args.chat_id, text: args.text });
    answer({ ok: true, result: true });
  });
});
after(async () => { await rpc.close(); await redisServer.close(); await tg.close(); });

beforeEach(() => {
  chain = new MockChain();
  rpcDelayMs = 0;
  redis.data.clear();
  redis.commands = [];
  said = [];
  tgCalls = [];
  logs.length = 0;
});

const env = (extra: Env = {}): Env => ({
  CHAINS: '1',
  RPC_URL: `${rpc.url}/{chainId}`,
  UPSTASH_REDIS_REST_URL: redisServer.url,
  UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN,
  CRON_SECRET: CRON,
  TELEGRAM_TOKEN: TG_TOKEN,
  TELEGRAM_KEY: TG_KEY,
  TELEGRAM_API: tg.url,
  PUBLIC_URL: 'https://alerts.example',
  HEARTBEAT_HOURS: '0',
  ...extra,
});
const cron = (secret = CRON): Request => ({ method: 'GET', headers: { authorization: `Bearer ${secret}` }, body: '' });
const secretOf = (e: Env) => new Telegram(parseConfig(['--all'], { RPC_URL: 'http://x', TELEGRAM_TOKEN: e.TELEGRAM_TOKEN, TELEGRAM_KEY: e.TELEGRAM_KEY })).webhookSecret();
let nextUpdate = 1;
const message = (chat: number, text: string, update_id = nextUpdate++): Request => ({
  method: 'POST',
  headers: { 'x-telegram-bot-api-secret-token': secretOf(env()) },
  body: JSON.stringify({ update_id, message: { chat: { id: chat, type: 'private' }, text } }),
});
const START = `/start ${telegramStart(1, SAFE)}`;

test('settings of the service', () => {
  const c = serviceConfig(env({ CHAINS: '8453, 1,100', RPC_URL_8453: 'https://base-a, https://base-b', START_BLOCK_8453: '7' }));
  assert.deepEqual(c.networks.map((n) => n.chainId), [1, 100, 8453]);
  // The chain id goes into the template; RPC_URL_<chain id> takes its place for one chain.
  assert.deepEqual(c.networks[0].cfg.rpcUrls, [`${rpc.url}/1`]);
  assert.deepEqual(c.networks[1].cfg.rpcUrls, [`${rpc.url}/100`]);
  assert.deepEqual(c.networks[2].cfg.rpcUrls, ['https://base-a', 'https://base-b']);
  assert.equal(c.networks[2].cfg.startBlock, 7);
  assert.equal(c.networks[2].cfg.chainId, 8453);
  // Without RPC_URL: the RPC of Zodiac, the internal one first when there is a token secret.
  assert.deepEqual(serviceConfig(env({ RPC_URL: undefined })).networks[0].cfg.rpcUrls, ['https://public-rpc.zodiac.eco/1']);
  assert.deepEqual(serviceConfig(env({ RPC_URL: undefined, RPC_TOKEN_SECRET: 'the-rpc-token-secret-0123456789' })).networks[0].cfg.rpcUrls,
    ['https://rpc.zodiac.eco/1', 'https://public-rpc.zodiac.eco/1']);
  assert.equal(c.webhookUrl, 'https://alerts.example/api/telegram');
  assert.equal(c.redis.prefix, 'chronobox:');
  // The Vercel integration of Upstash names its variables KV_REST_API_*.
  const kv = serviceConfig({ ...env(), UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't' });
  assert.equal(kv.redis.url, 'https://kv');
  // Without PUBLIC_URL, the production domain of the Vercel project.
  assert.equal(serviceConfig(env({ PUBLIC_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: 'alerts.vercel.app' })).webhookUrl, 'https://alerts.vercel.app/api/telegram');

  assert.throws(() => serviceConfig(env({ RPC_URL: 'https://x' })), /RPC_URL must have \{chainId\} in it/);
  assert.throws(() => serviceConfig(env({ CHAINS: undefined })), /Set CHAINS/);
  assert.throws(() => serviceConfig(env({ CHAINS: 'ethereum' })), /CHAINS must be chain ids/);
  assert.throws(() => serviceConfig(env({ RPC_URL_5: 'https://goerli' })), /RPC_URL_5 is set, but 5 is not in CHAINS/);
  assert.throws(() => serviceConfig(env({ UPSTASH_REDIS_REST_TOKEN: '' })), /Upstash Redis/);
  assert.throws(() => serviceConfig(env({ CRON_SECRET: 'short' })), /CRON_SECRET/);
  assert.throws(() => serviceConfig(env({ PUBLIC_URL: 'http://alerts.example' })), /PUBLIC_URL must start with https/);
  assert.throws(() => serviceConfig(env({ TELEGRAM_KEY: 'too-short' })), ConfigError);
});

test('only Vercel Cron starts a poll', async () => {
  assert.equal((await poll(env(), cron('wrong-secret-of-the-same-size'), deps)).status, 401);
  assert.equal((await poll(env(), { method: 'GET', headers: {}, body: '' }, deps)).status, 401);
  assert.equal((await poll({ ...env(), CRON_SECRET: undefined }, cron(''), deps)).status, 401);
  assert.equal(redis.commands.length, 0, 'nothing was read before the check');
});

test('a poll sets the webhook one time, finds a Chronobox, and a Start through the webhook subscribes', async () => {
  chain.withCancel();
  let r = await poll(env(), cron(), deps);
  assert.equal(r.status, 200);
  assert.deepEqual((r.body as any).networks, [{ chainId: 1, ok: true }]);
  const hook = tgCalls.filter((c) => c.method === 'setWebhook');
  assert.equal(hook.length, 1);
  assert.equal(hook[0].args.url, 'https://alerts.example/api/telegram');
  assert.equal(hook[0].args.secret_token, secretOf(env()));
  assert.deepEqual(hook[0].args.allowed_updates, ['message']);
  assert.ok(tgCalls.some((c) => c.method === 'setMyCommands'));
  await poll(env(), cron(), deps);
  assert.equal(tgCalls.filter((c) => c.method === 'setWebhook').length, 1, 'set one time');

  chain.create();
  await poll(env(), cron(), deps);
  assert.ok(redis.get('chronobox:1:all')!.includes(SAFE));
  assert.ok(redis.get(`chronobox:1:${SAFE}`));

  // Only Telegram, with the secret of this bot, can talk to the webhook.
  assert.equal((await telegramWebhook(env(), { ...message(ANNA, START), headers: {} }, deps)).status, 401);
  assert.equal((await telegramWebhook(env(), { ...message(ANNA, START), headers: { 'x-telegram-bot-api-secret-token': 'x'.repeat(43) } }, deps)).status, 401);
  assert.equal(said.length, 0);

  const start = message(ANNA, START);
  assert.equal((await telegramWebhook(env(), start, deps)).status, 200);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /^You now get the alerts of the Chronobox 0x5a5a…5a5a on Ethereum\./);
  // Telegram sends an update again when the answer was slow. It is answered one time.
  assert.deepEqual((await telegramWebhook(env(), start, deps)).body, { duplicate: true });
  assert.equal(said.length, 1);

  // In Redis the list of chats is sealed: neither the chat nor the address can be read.
  const stored = redis.get('chronobox:telegram')!;
  assert.doesNotMatch(stored, new RegExp(`${SAFE.slice(2)}|${ANNA}`));
  assert.doesNotMatch(Buffer.from(JSON.parse(stored).sealed, 'base64').toString('latin1'), new RegExp(`${SAFE.slice(2)}|${ANNA}`));

  // The alerts of the vault go to the chat.
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_ETH);
  r = await poll(env(), cron(), deps);
  assert.equal(r.status, 200);
  assert.equal(said.length, 2);
  assert.equal(said[1].chat, ANNA);
  assert.match(said[1].text, /^New request: Withdraw 1 ETH/);
  chain.mine(2n * DAY);
  await poll(env(), cron(), deps);
  assert.match(said[2].text, /^Wait over: Withdraw 1 ETH/);
  await poll(env(), cron(), deps);
  assert.equal(said.length, 3, 'nothing twice');

  // /stop through the webhook.
  await telegramWebhook(env(), message(ANNA, '/stop'), deps);
  assert.match(said.at(-1)!.text, /^Done\. You get no more alerts here/);
  chain.enqueue(OWNER_WALLET, ONE_ETH);
  await poll(env(), cron(), deps);
  assert.equal(said.length, 4);

  // No secret in the log.
  for (const secret of [TG_TOKEN, TG_KEY, CRON, REDIS_TOKEN, rpc.url]) assert.doesNotMatch(logs.join('\n'), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('two polls at the same time: one works, the other one sees the lock and stops', async () => {
  await poll(env(), cron(), deps);
  chain.create();
  rpcDelayMs = 20;
  const [a, b] = await Promise.all([poll(env(), cron(), deps), poll(env(), cron(), deps)]);
  const nets = [(a.body as any).networks[0], (b.body as any).networks[0]];
  assert.equal(nets.filter((n) => n.skipped).length, 1, JSON.stringify(nets));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // The lock is free again.
  rpcDelayMs = 0;
  assert.deepEqual(((await poll(env(), cron(), deps)).body as any).networks, [{ chainId: 1, ok: true }]);
});

test('a Start while a poll runs waits for the poll, and both work', async () => {
  chain.withCancel();
  chain.create();
  await poll(env(), cron(), deps);
  chain.enqueue(OWNER_WALLET, ONE_ETH);
  rpcDelayMs = 15;
  const [p, w] = await Promise.all([poll(env(), cron(), deps), telegramWebhook(env(), message(ANNA, START), deps)]);
  assert.equal(p.status, 200);
  assert.equal(w.status, 200);
  const answer = said.find((m) => /^You now get the alerts/.test(m.text));
  assert.ok(answer, JSON.stringify(said));
  assert.match(answer.text, /Right now one request waits there/);
});

test('a network whose RPC is on another chain is a configuration error, and the other networks still work', async () => {
  const r = await poll(env({ CHAINS: '1,5' }), cron(), deps);
  assert.equal(r.status, 500);
  const nets = (r.body as any).networks;
  assert.deepEqual(nets[0], { chainId: 1, ok: true });
  assert.equal(nets[1].chainId, 5);
  assert.match(nets[1].error, /The RPC of chain 5 is on chain 1/);
});

test('a wrong TELEGRAM_KEY stops the service with a clear error, without the key', async () => {
  await poll(env(), cron(), deps);
  await telegramWebhook(env(), message(ANNA, START), deps);
  const other = 'another-secret-that-is-also-long-enough-98765';
  const r = await poll(env({ TELEGRAM_KEY: other }), cron(), deps);
  assert.equal(r.status, 500);
  assert.match((r.body as any).message, /TELEGRAM_KEY does not open/);
  assert.doesNotMatch(JSON.stringify(r.body), new RegExp(other));
});

test('health: 503 before the first poll and when the polls stopped, 200 after a good poll', async () => {
  const req: Request = { method: 'GET', headers: {}, body: '' };
  assert.equal((await health(env(), req, deps)).status, 503);
  await poll(env(), cron(), deps);
  const ok = await health(env(), req, deps);
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body as any).networks, [{ chainId: 1, ok: true }]);
  const last = JSON.parse(redis.get('chronobox:last-poll')!);
  redis.data.set('chronobox:last-poll', { value: JSON.stringify({ ...last, at: new Date(Date.now() - 600_000).toISOString() }) });
  assert.equal((await health(env(), req, deps)).status, 503);
});

test('Redis locks: a held lock is busy, a lock left behind runs out, only the holder frees it', async () => {
  const store = new RedisStore({ url: redisServer.url, token: REDIS_TOKEN, prefix: 't:', lockTtlMs: 150 });
  let inside = 0;
  const holder = store.lock('x', async () => { inside++; await new Promise((r) => setTimeout(r, 80)); return 'first'; }, { waitMs: 0 });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(store.lock('x', async () => 'second', { waitMs: 0 }), BusyError);
  assert.equal(await store.lock('x', async () => 'waited', { waitMs: 2000 }), 'waited');
  assert.equal(await holder, 'first');
  // A function that was killed leaves its lock behind. It runs out.
  await store.cmd('SET', 't:lock:y', 'dead-function', 'NX', 'PX', 150);
  assert.equal(await store.lock('y', async () => 'after', { waitMs: 2000 }), 'after');
  // A holder whose lock ran out does not free the lock of the next one.
  await store.cmd('SET', 't:lock:z', 'somebody-else', 'NX', 'PX', 10_000);
  await store.cmd('EVAL', 'ignored', 1, 't:lock:z', 'me');
  assert.equal(redis.get('t:lock:z'), 'somebody-else');
  assert.equal(inside, 1);
  // A Telegram update is claimed one time.
  assert.equal(await store.claim('u:1', 60), true);
  assert.equal(await store.claim('u:1', 60), false);
  // The token is not in an error.
  const wrong = new RedisStore({ url: redisServer.url, token: 'wrong-token', prefix: 't:' });
  await assert.rejects(wrong.get('k'), (e: Error) => !e.message.includes('wrong-token'));
});

test('the Vercel function answers JSON', async () => {
  const fn = vercelFunction(async (_env, req) => ({ status: 202, body: { method: req.method, body: req.body, auth: req.headers.authorization } }));
  const server = http.createServer((req, res) => { void fn(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const res = await fetch(url, { method: 'POST', body: 'hello', headers: { authorization: 'Bearer x' } });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { method: 'POST', body: 'hello', auth: 'Bearer x' });
  await new Promise((r) => server.close(r));
});

test('the internal RPC of Zodiac gets a signed server token, and no other RPC does', async () => {
  const { signRpcToken, Rpc } = await import('../src/index.ts');
  const secret = 'the-rpc-token-secret-for-the-tests-0123456789';
  // The token: HS256, the claims that @zodiac/rpc/auth checks.
  const token = signRpcToken(secret, 'chronobox-watcher', 1_800_000_000);
  const [head, body, sig] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url').toString()), { alg: 'HS256' });
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url').toString()), {
    scope: 'server', iss: 'zodiac-app', aud: 'zodiac-rpc', sub: 'chronobox-watcher', iat: 1_800_000_000, exp: 1_800_000_600,
  });
  const crypto = await import('node:crypto');
  assert.equal(sig, crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url'));

  // The internal host answers 401 without the token; the fallback is another host and must not see it.
  const seen: { at: string; auth?: string }[] = [];
  let refuse = false;
  const internal = await startServer((req, b, res) => {
    seen.push({ at: 'internal', auth: req.headers.authorization });
    if (refuse || !req.headers.authorization?.startsWith('Bearer ')) { res.writeHead(401).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, result: '0x1' }));
  });
  const fallback = await startServer((req, b, res) => {
    seen.push({ at: 'fallback', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, result: '0x1' }));
  });
  try {
    const host = new URL(internal.url).host;
    const cfg = parseConfig([], { RPC_URL: `${internal.url}/1,${fallback.url}/1`, CHRONOBOX: SAFE, WEBHOOK_URL: 'https://h/x', RPC_TOKEN_SECRET: secret, RPC_TOKEN_HOST: host });
    assert.equal(cfg.rpcTokenSubject, 'chronobox-watcher');
    const rpcClient = new Rpc(cfg.rpcUrls, fetch, 5000, { host: cfg.rpcTokenHost, secret, subject: cfg.rpcTokenSubject });
    assert.equal(await rpcClient.call('eth_chainId'), '0x1');
    assert.equal(seen.length, 1);
    assert.match(seen[0].auth!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    // A refused token falls back to the other RPC, which gets no token.
    refuse = true;
    assert.equal(await rpcClient.call('eth_chainId'), '0x1');
    assert.deepEqual(seen.slice(1).map((s) => [s.at, s.auth]), [['internal', seen[0].auth], ['fallback', undefined]]);
    // The secret never reaches the log of a watcher.
    const { Watcher } = await import('../src/index.ts');
    assert.doesNotMatch(new Watcher(cfg).redact(`oops ${secret}`), new RegExp(secret));
  } finally {
    await internal.close();
    await fallback.close();
  }
  // A secret without a URL on its host is a mistake: the token would go nowhere.
  assert.throws(() => parseConfig([], { RPC_URL: 'https://public-rpc.zodiac.eco/1', CHRONOBOX: SAFE, WEBHOOK_URL: 'https://h/x', RPC_TOKEN_SECRET: secret }), /no RPC_URL is on rpc\.zodiac\.eco/);
  // The service passes it on.
  const sc = serviceConfig(env({ RPC_URL: 'https://rpc.zodiac.eco/{chainId},https://public-rpc.zodiac.eco/{chainId}', RPC_TOKEN_SECRET: secret }));
  assert.equal(sc.networks[0].cfg.rpcTokenSecret, secret);
});
