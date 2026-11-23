// Alerts by email: the sign-up with a double opt-in, the alerts, the stop, and the notices across Telegram and
// email. The chain, Telegram and Resend are stand-ins. The pages are called the way service.ts and the CLI call them.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AllWatcher, ConfigError, EMAIL_PATH, EMAIL_PENDING_MS, EMAIL_PER_VISITOR_HOUR, Email, MemoryStore, NOTICE_GAP_MS, NOTICE_MIN_FOLLOW_MS,
  type PageRequest, Telegram, fmtWhen, parseConfig, servePages, stopText, telegramStart,
} from '../src/index.ts';
import { DAY, MockChain, OWNER_WALLET, SAFE, STRANGER, handle, startServer } from './mocks.ts';

const TG_TOKEN = '123456:AAfake-token_for-the-email-tests-0123456789';
const KEY = 'a-secret-for-the-email-tests-that-is-long-0123';
const RESEND_KEY = 're_fake_key_for_the_tests_0123456789';
const PUBLIC = 'https://alerts.example';
const ONE_HALF_ETH = 1_500_000_000_000_000_000n;
const MAIL_ANNA = 'anna@example.org', MAIL_BEN = 'ben@example.org';
const CARL = 4003;

let chain: MockChain;
let rpc: { url: string; close: () => Promise<void> };
let tg: { url: string; close: () => Promise<void> };
let resend: { url: string; close: () => Promise<void> };
let dir: string;
let logs: string[] = [];
/** The time of the bot and of the email pages (ms). */
let now = Date.now();

type Said = { chat: number; text: string };
let said: Said[] = [];
let inbox: { update_id: number; message: unknown }[] = [];
let nextUpdate = 1;
const person = (chat: number, text: string) => inbox.push({ update_id: nextUpdate++, message: { chat: { id: chat, type: 'private' }, text } });
const saidTo = (chat: number) => said.filter((m) => m.chat === chat).map((m) => m.text);

type Mail = { to: string; from: string; subject: string; text: string; html: string; headers?: Record<string, string>; idem?: string; agent?: string };
let mails: Mail[] = [];
let resendRefuse: { code: number; message: string; once?: boolean } | null = null;
/** Resend fails once for this address. */
let resendFailTo: string | null = null;
const mailsTo = (to: string) => mails.filter((m) => m.to === to);
const linkIn = (m: Mail, kind: 'confirm' | 'stop') => new RegExp(`https://\\S+\\?${kind}=[\\w-]+`).exec(m.text)![0];
const tokenOf = (link: string) => new URL(link).search.slice(1).split('=')[1];

before(async () => {
  rpc = await startServer((_req, body, res) => {
    const msg = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...handle(chain, msg.method, msg.params ?? []) }));
  });
  tg = await startServer((req, body, res) => {
    const answer = (json: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    const method = req.url!.split('/').pop();
    const args = body ? JSON.parse(body) : {};
    if (method === 'getUpdates') return answer({ ok: true, result: inbox.filter((u) => args.offset === undefined || u.update_id >= args.offset) });
    if (method === 'sendMessage') said.push({ chat: args.chat_id, text: args.text });
    answer({ ok: true, result: true });
  });
  resend = await startServer((req, body, res) => {
    const answer = (code: number, json: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    if (req.method !== 'POST' || req.url !== '/emails') return answer(404, { name: 'not_found', message: 'Not found' });
    if (req.headers.authorization !== `Bearer ${RESEND_KEY}`) return answer(403, { name: 'validation_error', message: 'API key is invalid' });
    // Resend refuses a request without this header.
    if (!req.headers['user-agent']) return answer(403, { name: 'forbidden', message: 'error code: 1010' });
    if (resendRefuse) {
      const r = resendRefuse;
      if (r.once) resendRefuse = null;
      return answer(r.code, { name: 'error', message: r.message });
    }
    const m = JSON.parse(body);
    if (resendFailTo === m.to[0]) { resendFailTo = null; return answer(500, { name: 'error', message: 'Internal error' }); }
    const idem = req.headers['idempotency-key'] as string | undefined;
    // The same key a second time: Resend sends nothing again.
    if (!idem || !mails.some((x) => x.idem === idem)) mails.push({ to: m.to[0], from: m.from, subject: m.subject, text: m.text, html: m.html, headers: m.headers, idem, agent: req.headers['user-agent'] as string });
    return answer(200, { id: `mail-${mails.length}` });
  });
});
after(async () => { await rpc.close(); await tg.close(); await resend.close(); });

beforeEach(() => {
  chain = new MockChain();
  said = [];
  inbox = [];
  mails.splice(0);
  resendRefuse = null;
  resendFailTo = null;
  logs = [];
  now = Date.now();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronobox-email-'));
});

/** The watcher of every Chronobox with email, and the Telegram bot too with `bot`. */
async function withEmail(opts: { bot?: boolean; heartbeat?: string } = {}) {
  const env: Record<string, string> = {
    RPC_URL: rpc.url, STATE_DIR: path.join(dir, 'all'), HEARTBEAT_HOURS: opts.heartbeat ?? '0', ALERTS_KEY: KEY,
    RESEND_KEY, RESEND_API: resend.url, EMAIL_FROM: 'Chronobox alerts <alerts@chrono.example>', PUBLIC_URL: `${PUBLIC}/`,
  };
  if (opts.bot) { env.TELEGRAM_TOKEN = TG_TOKEN; env.TELEGRAM_API = tg.url; }
  const cfg = parseConfig(['--all'], env);
  const log = (m: string) => { logs.push(m); };
  const email = await Email.open(cfg, { log, clock: () => now });
  const bot = opts.bot ? await Telegram.open(cfg, { log, clock: () => now }) : undefined;
  if (bot) { bot.peers.push(email); email.peers.push(bot); }
  const w = new AllWatcher(cfg, { log, telegram: bot, email });
  const req = (method: string, query: string, fields?: Record<string, string>, ip = '203.0.113.7'): PageRequest => ({
    method, url: `${EMAIL_PATH}${query}`, headers: { 'x-forwarded-for': ip }, body: fields ? new URLSearchParams(fields).toString() : '',
  });
  const get = (query: string) => email.handle(req('GET', query));
  const post = (fields: Record<string, string>, ip?: string, query = '') => email.handle(req('POST', query, fields, ip));
  /** Sign up and confirm, as a person does it. */
  const join = async (address: string) => {
    await post({ c: `1-${SAFE}`, email: address });
    return post({ confirm: tokenOf(linkIn(mailsTo(address).at(-1)!, 'confirm')) });
  };
  /** A watcher that knows the Chronobox. */
  const ready = async () => { await w.poll(); chain.create(); await w.poll(); };
  return { w, email, bot, cfg, get, post, join, ready, req };
}

test('Email: a person signs up, confirms, and then gets the alerts of the vault', async () => {
  chain.withCancel();
  const { w, email, get, post, ready } = await withEmail();
  await ready();

  // 1. The page of the alert service, opened from the app.
  const form = await get(`?c=1-${SAFE}`);
  assert.equal(form.status, 200);
  assert.match(form.html, /<h1>Alerts by email<\/h1><p>For the Chronobox 0x5a5a…5a5a on Ethereum\.<\/p>/);
  assert.match(form.html, new RegExp(`<form action="${EMAIL_PATH}" method="post"><input type="hidden" name="c" value="1-${SAFE}"/>`));

  // 2. The address is given. One email goes out, and nothing else happens yet.
  const sent = await post({ c: `1-${SAFE}`, email: ' Anna@Example.org ' });
  assert.equal(sent.status, 200);
  assert.match(sent.html, /<h1>Look in your inbox<\/h1><p>We sent a link to anna@example\.org\./);
  assert.equal(mails.length, 1);
  const first = mails[0];
  assert.equal(first.to, MAIL_ANNA);
  assert.equal(first.from, 'Chronobox alerts <alerts@chrono.example>');
  assert.equal(first.subject, 'Confirm the alerts for your Chronobox');
  assert.match(first.text, new RegExp(`^Somebody asked for alerts for the Chronobox ${SAFE} on Ethereum to this address\\.\\n\\nWas it you\\? Then open this link and confirm:\\n${PUBLIC}${EMAIL_PATH}\\?confirm=`));
  assert.match(first.text, new RegExp(`If it was not you, do nothing: we delete this request after one day\\.\\n\\nNot you\\? Cancel this request, and every other one to this address, now:\\n${PUBLIC}${EMAIL_PATH}\\?cancel=[\\w-]+$`));
  assert.equal(first.agent, 'chronobox-watcher');
  // The HTML part, from react-email: the same words, a button to the same link, and nothing else to click.
  assert.match(first.html, /^<!DOCTYPE html/);
  assert.match(first.html, new RegExp(`Somebody asked for alerts for the Chronobox ${SAFE} on Ethereum to this address\\.`));
  const cancelLink = new RegExp(`https://\\S+\\?cancel=[\\w-]+`).exec(first.text)![0];
  assert.deepEqual([...first.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), [linkIn(first, 'confirm'), cancelLink]);
  assert.match(first.html, />Confirm the alerts<\/span>/);
  assert.deepEqual(email.subscribers(1, SAFE), []);
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(mails.length, 1, 'no alert before the person confirmed');

  // 3. The link opens a page with a button. Opening it alone confirms nothing: a mail scanner opens links too.
  const link = linkIn(first, 'confirm');
  const ask = await get(new URL(link).search);
  assert.match(ask.html, /<h1>Confirm the alerts<\/h1><p>For the Chronobox 0x5a5a…5a5a on Ethereum, to anna@example\.org\.<\/p>/);
  assert.match(ask.html, /<input type="hidden" name="confirm" value="[\w-]+"\/><button type="submit">Confirm<\/button>/);
  assert.deepEqual(email.subscribers(1, SAFE), []);
  const done = await post({ confirm: tokenOf(link) });
  assert.match(done.html, /<h1>Done<\/h1><p>You now get the alerts of the Chronobox 0x5a5a…5a5a on Ethereum by email\.<\/p><p>Right now one request waits there:<\/p><p>Withdraw 1\.5 ETH\. Its wait ends on /);
  assert.deepEqual(email.subscribers(1, SAFE).map((e) => e.email), [MAIL_ANNA]);
  // The link works one time.
  assert.equal((await post({ confirm: tokenOf(link) })).status, 410);
  assert.equal(mails.length, 1, 'no extra email after the confirmation');

  // 4. Alerts. The stop link is in the text and in the headers that mail programs read.
  chain.enqueue(STRANGER, ONE_HALF_ETH);
  await w.poll();
  assert.equal(mails.length, 2);
  const alert = mails[1];
  assert.equal(alert.subject, '⚠️ New request: Send 1.5 ETH to 0xbaba…baba');
  assert.match(alert.text, /^Somebody asked this Chronobox to send 1\.5 ETH to 0xbaba…baba\./);
  assert.match(alert.text, new RegExp(`\\n\\nChronobox 0x5a5a…5a5a on Ethereum\\n\\nTo stop these alerts, open this link:\\n${PUBLIC}${EMAIL_PATH}\\?stop=[\\w-]+$`));
  const stop = linkIn(alert, 'stop');
  assert.notEqual(tokenOf(stop), tokenOf(link), 'the link of the confirmation stops nothing');
  assert.deepEqual(alert.headers, { 'List-Unsubscribe': `<${stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.equal((alert.text.match(/https?:\/\//g) ?? []).length, 1, 'the stop link is the only link in an alert');
  // In the HTML too, and the text is escaped, with its paragraphs and lines.
  assert.deepEqual([...alert.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), [stop]);
  assert.match(alert.html, /<h1[^>]*>New request: Send 1\.5 ETH to 0xbaba…baba<\/h1>/);
  assert.match(alert.html, />Somebody asked this Chronobox to send 1\.5 ETH to 0xbaba…baba\./);
  assert.match(alert.html, />Chronobox 0x5a5a…5a5a on Ethereum<\/p>/);
  assert.match(alert.html, />Stop these alerts<\/a>/);
  assert.ok((alert.html.match(/<p /g) ?? []).length >= 3, 'one paragraph per block of the message');

  // 5. The list on disk is sealed, and no address and no key is in the log.
  const text = fs.readFileSync(path.join(dir, 'all', 'email.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['sealed', 'version']);
  assert.doesNotMatch(Buffer.from(JSON.parse(text).sealed, 'base64').toString('latin1'), /anna|example\.org/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(`anna|${RESEND_KEY}|${KEY}`));
});

test('Email: an alert that waits does not show in the state of the vault which address got it', async () => {
  const { w, join, ready } = await withEmail();
  await ready();
  await join(MAIL_ANNA);
  await join(MAIL_BEN);
  mails.splice(0);
  // Anna gets it, Ben does not yet. The alert waits, stored without encryption.
  resendFailTo = MAIL_BEN;
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.deepEqual(mails.map((m) => m.to), [MAIL_ANNA]);
  const stateText = fs.readFileSync(path.join(dir, 'all', `${SAFE}.json`), 'utf8');
  const marks = JSON.parse(stateText).outbox.flatMap((a: any) => a.done);
  assert.equal(marks.length, 1);
  assert.match(marks[0], /^em:[\w-]{22}$/);
  assert.doesNotMatch(stateText, /anna|ben|example\.org/);
  // The next poll sends it to Ben only.
  await w.poll();
  assert.deepEqual(mails.map((m) => m.to), [MAIL_ANNA, MAIL_BEN]);
});

test('Email: stop from the page or from the mail program; the others are told, but only of a follow of a day or more', async () => {
  const { w, email, bot, get, post, join, ready } = await withEmail({ bot: true });
  await ready();
  await join(MAIL_ANNA);
  await join(MAIL_BEN);
  person(CARL, `/start ${telegramStart(1, SAFE)}`);
  await bot!.pump();
  said = [];
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  mails = mails.filter((m) => /^New request/.test(m.subject));
  assert.deepEqual(mails.map((m) => m.to), [MAIL_ANNA, MAIL_BEN]);
  assert.equal(said.length, 1, 'the chat in Telegram gets the same alert');
  const annaStop = linkIn(mailsTo(MAIL_ANNA)[0], 'stop');
  const benStop = linkIn(mailsTo(MAIL_BEN)[0], 'stop');

  // A day later, Anna stops on the page: a page with a button first, then the stop.
  now += NOTICE_MIN_FOLLOW_MS;
  const ask = await get(new URL(annaStop).search);
  assert.match(ask.html, /<h1>Stop these alerts\?<\/h1><p>The alerts of the Chronobox 0x5a5a…5a5a on Ethereum, to anna@example\.org\.<\/p>/);
  assert.equal(email.subscribers(1, SAFE).length, 2);
  mails.splice(0);
  said = [];
  const done = await post({ stop: tokenOf(annaStop) });
  assert.match(done.html, /<h1>Done<\/h1><p>No more alerts of the Chronobox 0x5a5a…5a5a on Ethereum to this address\. We deleted it from our list\.<\/p>/);
  assert.deepEqual(email.subscribers(1, SAFE).map((e) => e.email), [MAIL_BEN]);
  // Alerts do not go off in silence: Ben and the chat are told.
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [[MAIL_BEN, 'Somebody stopped the alerts of your Chronobox']]);
  assert.match(mails[0].text, /^An email address that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them\. You still get them\.\n\nChronobox/);
  assert.deepEqual(saidTo(CARL), ['An email address that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them. You still get them here.']);
  assert.equal((await post({ stop: tokenOf(annaStop) })).status, 410);

  // Ben stops with the button of his mail program: one POST to the link, no page in between. Within the hour, so
  // the chat is told on a later poll, together with anything else.
  mails.splice(0);
  said = [];
  const one = await email.handle({ method: 'POST', url: new URL(benStop).pathname + new URL(benStop).search, headers: {}, body: 'List-Unsubscribe=One-Click' });
  assert.equal(one.status, 200);
  assert.deepEqual(email.subscribers(1, SAFE), []);
  assert.deepEqual(saidTo(CARL), []);
  now += NOTICE_GAP_MS;
  await w.poll();
  assert.deepEqual(saidTo(CARL), ['An email address that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them. You still get them here.']);
  assert.equal(mails.length, 0, 'nobody with email is left to tell');
});

test('Email: a chat that stops in Telegram is told to the people with email, together with the stops by email', async () => {
  const { w, email, bot, join, post, ready } = await withEmail({ bot: true });
  await ready();
  await join(MAIL_ANNA);
  await join(MAIL_BEN);
  person(CARL, `/start ${telegramStart(1, SAFE)}`);
  await bot!.pump();
  // A stranger who follows and stops at once tells nobody.
  person(4666, `/start ${telegramStart(1, SAFE)}`);
  person(4666, '/stop');
  await bot!.pump();
  mails.splice(0);
  assert.equal(email.state.notices[`1-${SAFE}`], undefined);

  now += NOTICE_MIN_FOLLOW_MS;
  person(CARL, '/stop');
  await bot!.pump();
  assert.deepEqual(mails.map((m) => m.to), [MAIL_ANNA, MAIL_BEN]);
  assert.match(mails[0].text, /^A chat that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them\. You still get them\./);

  // Within the hour, Ben stops: Anna hears of it with the next notice, an hour after the last one.
  const benStop = linkIn(mailsTo(MAIL_BEN).at(-1)!, 'stop');
  mails.splice(0);
  now += 60_000;
  await post({ stop: tokenOf(benStop) });
  assert.equal(mails.length, 0);
  now += NOTICE_GAP_MS;
  await w.poll();
  assert.deepEqual(mails.map((m) => [m.to, m.text.split('\n')[0]]), [
    [MAIL_ANNA, 'An email address that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum has stopped them. You still get them.'],
  ]);
});

test('Email: the notice of more than one stop names both kinds', () => {
  const key = `1-${SAFE}`;
  assert.equal(stopText(key, { stopped: 2, emails: 1, firstAt: 0 }, ''),
    `2 chats and 1 email address that got the alerts of the Chronobox 0x5a5a…5a5a on Ethereum have stopped them since ${fmtWhen(0)}. You still get them.`);
  assert.match(stopText(key, { stopped: 0, emails: 3, firstAt: 0 }, ' here'), /^3 email addresses that got .* You still get them here\.$/);
});

test('Email: what the sign-up refuses, and what it does not give away', async () => {
  const { email, get, post, join, ready } = await withEmail();
  assert.match((await post({ c: `1-${SAFE}`, email: MAIL_ANNA })).html, /Try again in a few minutes/, 'before the watcher read its chain');
  await ready();

  assert.equal((await get('?c=nonsense')).status, 400);
  assert.equal((await email.handle({ method: 'GET', url: '/nothing', headers: {}, body: '' })).status, 404);
  assert.equal((await get('?confirm=unknown')).status, 410);
  assert.equal((await get('?stop=unknown')).status, 410);
  for (const bad of ['', 'anna', 'anna@', 'a b@example.org', 'anna@example', '<script>@example.org', `${'a'.repeat(250)}@example.org`]) {
    const r = await post({ c: `1-${SAFE}`, email: bad }, `198.51.100.${bad.length}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.html, /This does not look like an email address\./);
    assert.doesNotMatch(r.html, /<script>/);
  }
  assert.equal(mails.length, 0);
  const notOne = await post({ c: `1-${STRANGER}`, email: MAIL_ANNA });
  assert.equal(notOne.status, 404);
  assert.match(notOne.html, /is not a Chronobox on Ethereum/);
  assert.match((await post({ c: `137-${SAFE}`, email: MAIL_ANNA })).html, /Our alert service does not watch Polygon\./);
  assert.equal(mails.length, 0);

  // The same address again: the same page, and no second email within ten minutes.
  const a = await post({ c: `1-${SAFE}`, email: MAIL_ANNA }, '198.51.100.20');
  const b = await post({ c: `1-${SAFE}`, email: MAIL_ANNA }, '198.51.100.20');
  assert.equal(a.html, b.html);
  assert.equal(mails.length, 1);
  // An address that is on the list gets the same page too, and no email: the page does not say who is on the list.
  await join(MAIL_BEN);
  const count = mails.length;
  const c = await post({ c: `1-${SAFE}`, email: MAIL_BEN }, '198.51.100.21');
  assert.equal(c.html.replace(MAIL_BEN, MAIL_ANNA), a.html);
  assert.equal(mails.length, count);

  // A request that nobody confirmed is deleted after one day, and its link is dead.
  const link = linkIn(mailsTo(MAIL_ANNA)[0], 'confirm');
  now += EMAIL_PENDING_MS + 1;
  assert.equal((await get(new URL(link).search)).status, 410);
  assert.equal((await post({ confirm: tokenOf(link) })).status, 410);
  assert.deepEqual(email.state.pending, []);
  assert.deepEqual(email.subscribers(1, SAFE).map((e) => e.email), [MAIL_BEN]);

  // One visitor cannot ask for more than ten emails an hour. The last address of X-Forwarded-For is the visitor:
  // what comes before it, the visitor wrote.
  mails.splice(0);
  let refused = 0;
  for (let i = 0; i < EMAIL_PER_VISITOR_HOUR + 2; i++) {
    const r = await post({ c: `1-${SAFE}`, email: `person${i}@example.org` }, `10.0.0.${i}, 198.51.100.9`);
    if (r.status === 429) refused++;
  }
  assert.equal(refused, 2);
  assert.equal(mails.length, EMAIL_PER_VISITOR_HOUR);

  // A form that is far too long is not read.
  assert.equal((await post({ c: `1-${SAFE}`, email: 'x'.repeat(9000) + '@example.org' })).status, 413);
});

test('Email: a stranger who fills the requests of an address does not block it: the mailbox cancels them, and signs up', async () => {
  const { email, get, post, ready } = await withEmail();
  await ready();
  // The stranger knows Anna's address and asks for alerts to it: for this Chronobox through the page, and (the
  // stand-in chain has one Chronobox only) for two others straight into the list. Three requests fill her slots.
  await post({ c: `1-${SAFE}`, email: MAIL_ANNA }, '198.51.100.66');
  const strangers = mailsTo(MAIL_ANNA);
  assert.equal(strangers.length, 1);
  await (email as any).edit((st: any) => {
    for (const vault of ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20)]) st.pending.push({ email: MAIL_ANNA, box: `1-${vault}`, token: `token-${vault.slice(2, 6)}`, at: now });
  });
  // Past the pause per Chronobox, so that only the full slots hold Anna back.
  now += 11 * 60_000;

  // Anna asks for her own: the same page as always, but no email, because the slots are full.
  mails.splice(0);
  const blocked = await post({ c: `1-${SAFE}`, email: MAIL_ANNA }, '203.0.113.200');
  assert.match(blocked.html, /Look in your inbox/);
  assert.match(blocked.html, /If you got emails for a Chronobox that is not yours, open &quot;Not you\? Cancel&quot;/);
  assert.equal(mails.length, 0);

  // In the email of the stranger: "Not you? Cancel". Opening it changes nothing, as a scanner opens links too.
  const cancel = /\?cancel=([\w-]+)/.exec(strangers[0].text)![1];
  const ask = await get(`?cancel=${cancel}`);
  assert.match(ask.html, /<h1>Cancel these requests\?<\/h1><p>3 requests for alerts wait for a confirmation from anna@example\.org\.<\/p>/);
  assert.equal(email.state.pending.length, 3);
  const done = await post({ cancel });
  assert.match(done.html, /<h1>Done<\/h1><p>We deleted every request to this address that was not confirmed\.<\/p>/);
  assert.deepEqual(email.state.pending, []);
  assert.equal((await post({ cancel })).status, 410, 'the link works one time');

  // Now Anna's own request goes out at once.
  await post({ c: `1-${SAFE}`, email: MAIL_ANNA }, '203.0.113.200');
  assert.deepEqual(mails.map((m) => [m.to, m.subject]), [[MAIL_ANNA, 'Confirm the alerts for your Chronobox']]);
  assert.match(logs.join('\n'), /email: an address cancelled its requests/);
  assert.doesNotMatch(logs.join('\n'), /anna/);
});

test('Email: a cancel clears only requests that are not confirmed, of that address only', async () => {
  const { email, post, join, ready } = await withEmail();
  await ready();
  await join(MAIL_ANNA);
  await post({ c: `1-${SAFE}`, email: MAIL_BEN });
  await (email as any).edit((st: any) => { st.pending.push({ email: MAIL_ANNA, box: `1-0x${'11'.repeat(20)}`, token: 'anna-other', at: now }); });
  await post({ cancel: 'anna-other' });
  assert.deepEqual(email.subscribers(1, SAFE).map((e) => e.email), [MAIL_ANNA], 'her confirmed alerts stay');
  assert.deepEqual(email.state.pending.map((e) => e.email), [MAIL_BEN], 'the request of Ben stays');
});

test('Email: an email that fails is tried again, and nobody gets it twice', async () => {
  const { w, email, join, post, ready } = await withEmail();
  await ready();
  await join(MAIL_ANNA);
  await join(MAIL_BEN);
  mails.splice(0);

  // Resend is down for one request: the first address fails, the watcher stops there and tries again.
  resendRefuse = { code: 500, message: 'Internal error', once: true };
  chain.mine(12n);
  chain.enqueue(OWNER_WALLET, ONE_HALF_ETH);
  await w.poll();
  assert.equal(mails.length, 0);
  assert.match(logs.join('\n'), /via email failed, will retry next poll/);
  await w.poll();
  assert.deepEqual(mails.map((m) => m.to), [MAIL_ANNA, MAIL_BEN]);
  await w.poll();
  assert.equal(mails.length, 2);
  // Every alert to every address has its own key, so that Resend sends it one time also when the answer got lost.
  assert.equal(new Set(mails.map((m) => m.idem)).size, 2);
  assert.match(mails[0].idem!, /^em:[\w-]{22}$/);

  // An email that Resend will never take is not tried for ever.
  resendRefuse = { code: 422, message: 'Invalid `to` field' };
  chain.enqueue(OWNER_WALLET, 1n);
  await w.poll();
  resendRefuse = null;
  await w.poll();
  assert.equal(mails.length, 2);
  assert.match(logs.join('\n'), /was refused: Resend: 422/);

  // When the confirmation cannot be sent, the page says so and the request is not kept.
  resendRefuse = { code: 500, message: 'Internal error' };
  const r = await post({ c: `1-${SAFE}`, email: 'carl@example.org' });
  assert.equal(r.status, 502);
  assert.match(r.html, /We could not send the email right now/);
  assert.deepEqual(email.state.pending, []);
});

test('Email: "All quiet" and "Watching" do not go to an inbox', async () => {
  const { w, cfg, email, join, ready } = await withEmail({ heartbeat: '24' });
  await ready();
  await join(MAIL_ANNA);
  mails.splice(0);
  chain.mine(3n * DAY);
  await new AllWatcher(cfg, { log: () => undefined, email }).poll();
  await w.poll();
  assert.equal(mails.length, 0);
});

test('Email: the list opens only with its key, and survives a restart', async () => {
  const { cfg, join, ready } = await withEmail();
  await ready();
  await join(MAIL_ANNA);
  const again = await Email.open(cfg);
  assert.deepEqual(again.subscribers(1, SAFE).map((e) => e.email), [MAIL_ANNA]);
  const other = 'another-secret-that-is-long-enough-0123456789';
  await assert.rejects(Email.open({ ...cfg, alertsKey: other }), (e: Error) => e instanceof ConfigError && /ALERTS_KEY does not open the stored list of email addresses/.test(e.message) && !e.message.includes(other));
});

test('Email: the pages of the CLI, over HTTP', async () => {
  const { email, ready } = await withEmail();
  await ready();
  const pages = await servePages(email, 0);
  try {
    const base = `http://127.0.0.1:${pages.port}`;
    assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
    const r = await fetch(`${base}${EMAIL_PATH}?c=1-${SAFE}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy')!, /default-src 'none'.*form-action 'self'/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(await r.text(), /<h1>Alerts by email<\/h1>/);
    const sent = await fetch(`${base}${EMAIL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ c: `1-${SAFE}`, email: MAIL_ANNA }) });
    assert.match(await sent.text(), /Look in your inbox/);
    assert.equal(mails.length, 1);
    const long = await fetch(`${base}${EMAIL_PATH}`, { method: 'POST', body: 'x'.repeat(20000) });
    assert.equal(long.status, 413);
  } finally { pages.close(); }
});

test('Email: the limits per visitor live in the store, so that they hold across functions', async () => {
  const store = new MemoryStore();
  assert.equal(await store.hit('k', 3600), 1);
  assert.equal(await store.hit('k', 3600), 2);
  assert.equal(await store.scope('a:').hit('k', 3600), 1);
  assert.equal(await store.hit('gone', 0), 1);
  assert.equal(await store.hit('gone', 0), 1, 'a counter that ran out starts again');
});

test('Email settings', () => {
  const base = { RPC_URL: 'http://x', ALERTS_KEY: KEY };
  const full = { ...base, RESEND_KEY, EMAIL_FROM: 'Alerts <alerts@example.org>', PUBLIC_URL: 'https://alerts.example.org/' };
  assert.throws(() => parseConfig([], { ...full, CHRONOBOX: SAFE, WEBHOOK_URL: 'http://h/x' }), /RESEND_KEY works with --all only/);
  assert.throws(() => parseConfig(['--all'], { RPC_URL: 'http://x', RESEND_KEY }), /ALERTS_KEY is required with TELEGRAM_TOKEN or RESEND_KEY/);
  assert.throws(() => parseConfig(['--all'], { ...base, RESEND_KEY, PUBLIC_URL: 'https://a.example' }), /EMAIL_FROM is required with RESEND_KEY/);
  assert.throws(() => parseConfig(['--all'], { ...base, RESEND_KEY, EMAIL_FROM: 'a@example.org' }), /PUBLIC_URL is required with RESEND_KEY/);
  assert.throws(() => parseConfig(['--all'], { ...full, PUBLIC_URL: 'alerts.example.org' }), /PUBLIC_URL is required/);
  assert.throws(() => parseConfig(['--all'], { ...full, PUBLIC_URL: 'https://alerts.example.org/email' }), /no path/);
  const c = parseConfig(['--all'], full);
  assert.equal(c.publicUrl, 'https://alerts.example.org');
  assert.equal(c.port, 8787);
  assert.equal(c.resendApi, 'https://api.resend.com');
  assert.equal(parseConfig(['--all', '--port', '9000'], full).port, 9000);
  // Email alone is enough.
  assert.equal(parseConfig(['--all'], full).resendKey, RESEND_KEY);
  // The older name of the key still works.
  assert.equal(parseConfig(['--all'], { RPC_URL: 'http://x', TELEGRAM_KEY: KEY, TELEGRAM_TOKEN: TG_TOKEN }).alertsKey, KEY);
});
