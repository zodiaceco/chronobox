/**
 * The alert service (watcher --all with a Telegram bot) against the real
 * contracts on a local fork.
 *
 *   npm run fork              (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:alerts
 *
 * It creates Chronoboxes and a Safe that is not a Chronobox, lets chats press
 * Start and an email address sign up, and checks that every alert goes to the
 * people who follow that Chronobox and to nobody else. The Telegram API and
 * Resend are local stand-ins that record what they get. The script prints the
 * messages, so that a person can read them. It takes a snapshot first and reverts to it at the end.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { telegramStart } from "../src/lib/alerts.ts";
import type { Address } from "../src/lib/hex.ts";
import {
  type Rpc,
  addGuardianTx,
  cancelTx,
  changeDelayTx,
  createTx,
  depositTx,
  executeTx,
  inspect,
  lockTx,
  queueTx,
  safeFromReceipt,
  sendAndWait,
  withdrawalTx,
} from "../src/lib/chronobox.ts";
import { madeOnFork } from "./fork-hints.ts";
import { AllWatcher, EMAIL_PATH, Email, Telegram, parseConfig } from "../watcher/src/index.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 6 to 8. The browser dev wallet uses 0 to 2 and test/fork.ts uses 3 to 5.
const ANNA: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const BEN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const CARL: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
// Anvil account 9: the guardian. It sends nothing.
const GUARD: Address = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const DAY = 24n * 3600n;
const ETH = 10n ** 18n;

let id = 0;
const rpc: Rpc = async (method, params = []) => {
  const response = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { data: body.error.data });
  return body.result;
};
const warp = async (seconds: bigint) => {
  await rpc("evm_increaseTime", [Number(seconds)]);
  await rpc("evm_mine", []);
};
const step = (text: string) => console.log(`\n${text}`);
const ok = (text: string) => console.log(`  ok  ${text}`);
const show = (text: string) => console.log(`\n${text.replace(/^/gm, "      | ")}\n`);

// A stand-in for the Telegram Bot API: people "send" messages, and it records what the bot says.
const TOKEN = "123456:AAfork-test-token_0123456789abcdef";
const KEY = "a-secret-for-the-fork-test-0123456789abcdef";
type Said = { chat: number; text: string; silent: boolean };
const said: Said[] = [];
const updates: { update_id: number; message: unknown }[] = [];
const person = (chat: number, text: string) => updates.push({ update_id: updates.length + 1, message: { chat: { id: chat, type: "private" }, text } });
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const method = req.url!.split("/").pop();
    const args = body ? JSON.parse(body) : {};
    let result: unknown = true;
    if (method === "getMe") result = { id: 1, is_bot: true, username: "chronobox_fork_bot" };
    if (method === "getUpdates") result = updates.filter((u) => args.offset === undefined || u.update_id >= args.offset);
    if (method === "sendMessage") said.push({ chat: args.chat_id, text: args.text, silent: Boolean(args.disable_notification) });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const telegramApi = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// A stand-in for Resend: it records every email.
type Mail = { to: string; subject: string; text: string; html: string };
const mails: Mail[] = [];
const resend = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const m = JSON.parse(body);
    mails.push({ to: m.to[0], subject: m.subject, text: m.text, html: m.html });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "mail" }));
  });
});
await new Promise<void>((resolve) => resend.listen(0, "127.0.0.1", resolve));
const resendApi = `http://127.0.0.1:${(resend.address() as { port: number }).port}`;
const inbox = () => mails.splice(0, mails.length);
const ANNA_MAIL = "anna@example.org";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronobox-alerts-"));
const heard = () => said.splice(0, said.length);
const chats = (messages: Said[]) => messages.map((m) => m.chat).sort();
// A person reads these. No word of the contracts belongs in them, and one link only: the last line of an alert, the
// page of its Chronobox in the app.
const BOX_LINK = /\nhttps:\/\/www\.chrono\.box\/#\/v\/eth:0x[0-9a-f]{40}$/;
const plain = (messages: Said[]) => {
  for (const m of messages) assert.doesNotMatch(m.text.split("Technical detail:")[0].replace(BOX_LINK, ""), /queue|transaction|execut|vault|module|Delay |Roles|#\d|https?:/, m.text);
};
// Who follows what.
const ANNA_PHONE = 11, ANNA_FRIEND = 12, BEN_PHONE = 13, OLD_PHONE = 14, CURIOUS = 15;

async function chronobox(wallet: Address, cooldown: bigint, index = 0) {
  const safe = safeFromReceipt(await sendAndWait(rpc, wallet, createTx(wallet, index)))!;
  await sendAndWait(rpc, wallet, lockTx(wallet, safe, cooldown));
  const state = await inspect(rpc, safe, forkHints);
  assert.equal(state.state, "locked");
  return { safe, delay: state.delay!, roles: state.roles! };
}

// Everything that this test makes comes after the head of now. See fork-hints.ts.
const forkHints = await madeOnFork(rpc);
const snapshot = await rpc("evm_snapshot", []);
try {
  for (const account of [ANNA, BEN, CARL, GUARD]) await rpc("anvil_setCode", [account, "0x"]);
  // A Chronobox that is there before the watcher starts. The watcher does not search the past.
  const old = await chronobox(ANNA, DAY, 1);

  step("1. The alert service starts and knows nobody");
  const logs: string[] = [];
  const settings = {
    RPC_URL: URL, STATE_DIR: dir, HEARTBEAT_HOURS: "0", TELEGRAM_TOKEN: TOKEN, ALERTS_KEY: KEY, TELEGRAM_API: telegramApi,
    RESEND_KEY: "re_fork_test_key_0123456789", RESEND_API: resendApi, EMAIL_FROM: "Chronobox alerts <alerts@chrono.example>", PUBLIC_URL: "https://alerts.example",
  };
  const config = parseConfig(["--all"], settings);
  // The time of the bot: step 8 moves it a day on, because only a follow of a day or more tells the others of a stop.
  let later = 0;
  const bot = new Telegram(config, { log: (line) => logs.push(line), clock: () => Date.now() + later });
  await bot.start();
  const email = await Email.open(config, { log: (line) => logs.push(line), clock: () => Date.now() + later });
  bot.peers.push(email);
  email.peers.push(bot);
  // The pages of the alert service, called as the function /api/email calls them.
  const page = (fields: Record<string, string>) =>
    email.handle({ method: "POST", url: EMAIL_PATH, headers: { "x-forwarded-for": "203.0.113.1" }, body: new URLSearchParams(fields).toString() });
  const watcher = new AllWatcher(config, { log: (line) => logs.push(line), telegram: bot, email });
  assert.equal(await watcher.poll(), true);
  assert.deepEqual(watcher.state.vaults, {});
  ok("first look: no Chronobox, no message");

  step("2. Two Chronoboxes and one plain Safe appear");
  const anna = await chronobox(ANNA, DAY);
  const ben = await chronobox(BEN, 12n * 3600n);
  const plainSafe = safeFromReceipt(await sendAndWait(rpc, CARL, createTx(CARL, 0)))!;
  assert.equal(await watcher.poll(), true);
  assert.deepEqual(Object.keys(watcher.state.vaults).sort(), [anna.safe, ben.safe].map((a) => a.toLowerCase()).sort());
  assert.equal(said.length, 0);
  ok("both found by what they deployed, without anybody telling the alert service");
  ok("the plain Safe is ignored, and nobody gets a message yet");

  step("3. People press Start in Telegram");
  person(ANNA_PHONE, `/start ${telegramStart(1, anna.safe)}`);
  person(ANNA_FRIEND, `/start ${telegramStart(1, anna.safe)}`);
  person(BEN_PHONE, `/start ${telegramStart(1, ben.safe)}`);
  person(OLD_PHONE, `/start ${telegramStart(1, old.safe)}`);
  person(CURIOUS, `/start ${telegramStart(1, plainSafe)}`);
  assert.equal(await bot.pump(), 5);
  let told = heard();
  assert.deepEqual(chats(told), [ANNA_PHONE, ANNA_FRIEND, BEN_PHONE, OLD_PHONE, CURIOUS]);
  for (const m of told.filter((m) => m.chat !== CURIOUS)) assert.match(m.text, /^You now get the alerts of the Chronobox 0x\w{4}…\w{4} on Ethereum\.\n\nNothing waits there right now\./);
  assert.match(told.find((m) => m.chat === CURIOUS)!.text, /is not a Chronobox on Ethereum/);
  // A Start does not take the lock of the network, so the next poll takes the older Chronobox in, and tells nothing new.
  assert.equal(watcher.state.vaults[old.safe.toLowerCase()], undefined);
  assert.equal(await watcher.poll(), true);
  assert.ok(watcher.state.vaults[old.safe.toLowerCase()], "the older Chronobox is known now");
  assert.equal(said.length, 0);
  assert.deepEqual(bot.subscribers(1, anna.safe), [String(ANNA_PHONE), String(ANNA_FRIEND)]);
  ok("four chats follow three Chronoboxes; the older one was found because somebody asked");
  ok("the plain Safe is refused");
  show(told[0].text);

  step("3b. An email address signs up, and confirms");
  await page({ c: telegramStart(1, anna.safe), email: ANNA_MAIL });
  let got = inbox();
  assert.deepEqual(got.map((m) => [m.to, m.subject]), [[ANNA_MAIL, "Confirm the alerts for the Chronobox"]]);
  assert.deepEqual(email.subscribers(1, anna.safe), []);
  const confirmed = await page({ confirm: /\?confirm=([\w-]+)/.exec(got[0].text)![1] });
  assert.match(confirmed.html, /<h1>Done<\/h1><p>You now get the alerts of the Chronobox 0x\w{4}…\w{4} on Ethereum by email\.<\/p><p>Nothing waits there right now\.<\/p>/);
  assert.match((await page({ c: telegramStart(1, plainSafe), email: ANNA_MAIL })).html, /is not a Chronobox on Ethereum/);
  assert.equal(mails.length, 0);
  ok("one email with a link, and the alerts start only after the confirmation");
  show(got[0].text.replace(/=[\w-]+/, "=…"));

  step("4. A withdrawal is asked for in one of them");
  await sendAndWait(rpc, ANNA, depositTx(anna.safe, null, 3n * ETH));
  await sendAndWait(rpc, BEN, depositTx(ben.safe, null, 2n * ETH));
  assert.equal(await watcher.poll(), true);
  assert.equal(said.length, 0);
  ok("money that comes in raises no alert");
  const annaOut = withdrawalTx(ANNA, null, ETH);
  await sendAndWait(rpc, ANNA, queueTx(anna.delay, annaOut));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [ANNA_PHONE, ANNA_FRIEND]);
  assert.match(told[0].text, /^New request: Withdraw 1 ETH\n\nA request to withdraw 1 ETH has started\. The money goes to the wallet of this Chronobox, 0x976ea7\w+\.\n\nThe wait ends on .* UTC \(in 1 day\)\.\n\nIf the owner did not ask for this, /);
  assert.match(told[0].text, /\n\nIf the owner did not ask for this, open the Chronobox and cancel it\.\n\nChronobox 0x\w{4}…\w{4} on Ethereum\nhttps:\/\/www\.chrono\.box\/#\/v\/eth:0x[0-9a-f]{40}$/);
  ok("it went to the two chats of that Chronobox, and to nobody else");
  show(told[0].text);
  got = inbox();
  assert.deepEqual(got.map((m) => [m.to, m.subject]), [[ANNA_MAIL, "New request: Withdraw 1 ETH"]]);
  assert.match(got[0].text, /^A request to withdraw 1 ETH has started\.[\s\S]*\n\nChronobox 0x\w{4}…\w{4} on Ethereum\n\nTo stop these alerts, open this link:\nhttps:\/\/alerts\.example\/api\/email\?stop=[\w-]+$/);
  assert.match(got[0].html, />A request to withdraw 1 ETH has started\./);
  ok("the email address got the same alert, as text and as HTML, with a link to stop");
  show(`Subject: ${got[0].subject}\n\n${got[0].text.replace(/=[\w-]+/, "=…")}`);
  // Somebody who starts now is told what waits.
  person(CURIOUS, `/start ${telegramStart(1, anna.safe)}`);
  await bot.pump();
  told = heard();
  assert.match(told[0].text, /Right now one request waits there:\nWithdraw 1 ETH\. Its wait ends on /);
  person(CURIOUS, "/stop");
  await bot.pump();
  heard();
  ok("a chat that starts while something waits is told about it");

  step("5. Cancel");
  await sendAndWait(rpc, ANNA, cancelTx(anna.roles, anna.delay, 0n));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [ANNA_PHONE, ANNA_FRIEND]);
  assert.match(told[0].text, /^Cancelled: Withdraw 1 ETH\n\nThe request to withdraw 1 ETH was cancelled on .* UTC\. No money moved\./);
  assert.equal(watcher.state.vaults[anna.safe.toLowerCase()].active, false);
  ok("the cancel is reported, and the Chronobox is quiet again");
  show(told[0].text);

  step("6. Money asked to go to a stranger in the other one, then the wait ends");
  const benOut = withdrawalTx(CARL, null, ETH);
  await sendAndWait(rpc, BEN, queueTx(ben.delay, benOut));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [BEN_PHONE]);
  assert.match(told[0].text, /^New request: Send 1 ETH to 0x2361…1E8f\n\n/i);
  assert.match(told[0].text, /That is not the wallet of this Chronobox\. The Chronobox app does not make such a request\./);
  ok("it names the address in full");
  show(told[0].text);
  await warp(12n * 3600n + 60n);
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [BEN_PHONE]);
  assert.match(told[0].text, /^Wait over: Send 1 ETH to /);
  ok("the end of the wait is reported");
  show(told[0].text);
  await sendAndWait(rpc, CARL, executeTx(ben.delay, benOut));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [BEN_PHONE]);
  assert.match(told[0].text, /^Done: Send 1 ETH to .*\n\nThe request to send 1 ETH to .* was carried out\. The money left this Chronobox\./);
  ok("that the money left is reported");
  show(told[0].text);

  step("7. The delay is changed, and a guardian is added");
  const shorter = changeDelayTx(anna.delay, 3600n);
  await sendAndWait(rpc, ANNA, queueTx(anna.delay, shorter));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [ANNA_PHONE, ANNA_FRIEND]);
  assert.match(told[0].text, /^New request: Change the delay to 1 hour\n\n.*After this, every withdrawal waits 1 hour\. It is 1 day now\. With a shorter delay there is less time to cancel a withdrawal\./u);
  ok("a shorter delay says what it means");
  show(told[0].text);
  await sendAndWait(rpc, ANNA, cancelTx(anna.roles, anna.delay, 1n));
  assert.equal(await watcher.poll(), true);
  assert.match(heard()[0].text, /^Cancelled: Change the delay to 1 hour\n\n.*Nothing changed\./);

  const adding = addGuardianTx({ safe: anna.safe, delay: anna.delay, roles: anna.roles, controller: ANNA }, GUARD)!;
  await sendAndWait(rpc, ANNA, queueTx(anna.delay, adding));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(chats(told), [ANNA_PHONE, ANNA_FRIEND]);
  assert.match(told[0].text, /^New request: Add the guardian 0xa0ee…9720\n\n/u);
  assert.match(told[0].text, /After this, 0xa0ee7a\w+ can stop every withdrawal\. Together with the wallet of this Chronobox, it can hand the Chronobox to a new wallet at once\./);
  ok("the request of the app to add a guardian is named as that");
  show(told[0].text);
  await warp(DAY + 60n);
  assert.equal(await watcher.poll(), true);
  heard();
  await sendAndWait(rpc, CARL, executeTx(anna.delay, adding));
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual([...new Set(chats(told))], [ANNA_PHONE, ANNA_FRIEND]);
  const changed = told.find((m) => /This Chronobox changed/.test(m.text))!;
  assert.ok(changed.text.includes(`${GUARD.toLowerCase()} is now the guardian of this Chronobox.`));
  assert.doesNotMatch(changed.text, /can now cancel a request/);
  assert.doesNotMatch(changed.text, /Warning/);
  ok("after it is carried out, the chats are told that the Chronobox changed");
  show(changed.text);
  const guarded = await inspect(rpc, anna.safe, forkHints);
  assert.equal(guarded.guardian?.toLowerCase(), GUARD.toLowerCase());
  // A watcher that starts from nothing still knows it as a Chronobox.
  const fresh = new AllWatcher(parseConfig(["--all"], { ...settings, STATE_DIR: path.join(dir, "fresh") }), { log: () => undefined });
  await fresh.poll();
  assert.equal(await fresh.adopt(anna.safe.toLowerCase()), true);
  assert.equal(await fresh.adopt(plainSafe.toLowerCase()), false);
  heard();
  ok("a Chronobox with a guardian is still a Chronobox for the alert service");

  step("8. Stop");
  // A stranger who follows and stops at once tells nobody: else anybody could ring the phones of all followers.
  person(CURIOUS, `/start ${telegramStart(1, anna.safe)}`);
  person(CURIOUS, "/stop");
  await bot.pump();
  assert.deepEqual(chats(heard()), [CURIOUS, CURIOUS]);
  ok("a stranger who follows and stops at once rings nobody else");
  later = 24 * 3600 * 1000;
  person(ANNA_PHONE, "/stop");
  await bot.pump();
  told = heard();
  assert.match(told.find((m) => m.chat === ANNA_PHONE)!.text, /^Done\. You get no more alerts here/);
  assert.match(told.find((m) => m.chat === ANNA_FRIEND)!.text, /has stopped them\. You still get them here\.$/);
  got = inbox().filter((m) => /stopped/.test(m.subject));
  assert.deepEqual(got.map((m) => m.to), [ANNA_MAIL]);
  assert.match(got[0].text, /^A chat that got the alerts of the Chronobox 0x\w{4}…\w{4} on Ethereum has stopped them\. You still get them\./);
  await sendAndWait(rpc, ANNA, queueTx(anna.delay, annaOut));
  assert.equal(await watcher.poll(), true);
  assert.deepEqual(chats(heard()), [ANNA_FRIEND]);
  assert.deepEqual(inbox().map((m) => m.to), [ANNA_MAIL]);
  ok("the friend and the email address are told that a chat stopped, and only they get the next alert");

  step("9. A restart sends nothing twice");
  const bot2 = new Telegram(config, { log: () => undefined });
  const again = new AllWatcher(config, { log: () => undefined, telegram: bot2 });
  assert.equal(await again.poll(), true);
  assert.equal(await bot2.pump(), 0);
  assert.equal(said.length, 0);
  assert.deepEqual(bot2.subscribers(1, anna.safe), [String(ANNA_FRIEND)]);
  assert.deepEqual((await Email.open(config)).subscribers(1, anna.safe).map((e) => e.email), [ANNA_MAIL]);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "email.json"), "utf8"), /anna|example\.org/);
  assert.doesNotMatch(logs.join("\n"), /anna@/);
  ok("no message after a restart, and the list of chats is kept");
  const onDisk = fs.readFileSync(path.join(dir, "telegram.json"), "utf8");
  assert.doesNotMatch(onDisk, new RegExp(`${anna.safe.slice(2)}|chats`, "i"));
  ok("the list of chats on disk is sealed: no address in it");
  assert.doesNotMatch(logs.join("\n"), new RegExp(TOKEN));

  step("10. In one block: a withdrawal is carried out, and the request after it is cancelled");
  // Somebody with the wallet takes the money and cancels a decoy in the same block. The state of the block before
  // says nothing about which was which; the logs of the Safe do.
  const decoy = withdrawalTx(ANNA, null, 1n);
  await sendAndWait(rpc, ANNA, queueTx(anna.delay, decoy));
  const decoyNonce = BigInt(await rpc("eth_call", [{ to: anna.delay, data: "0xde8dd91d" }, "latest"])) - 1n; // queueNonce - 1
  assert.equal(await watcher.poll(), true);
  heard();
  await warp(DAY + 60n);
  await rpc("evm_setAutomine", [false]);
  const send = (from: Address, tx: { to: string; data: string }) => rpc("eth_sendTransaction", [{ from, to: tx.to, data: tx.data, gas: "0x200000" }]);
  const hashes = [await send(CARL, executeTx(anna.delay, annaOut)), await send(ANNA, cancelTx(anna.roles, anna.delay, decoyNonce))];
  await rpc("evm_mine", []);
  await rpc("evm_setAutomine", [true]);
  const receipts = await Promise.all(hashes.map((h) => rpc("eth_getTransactionReceipt", [h])));
  assert.deepEqual(receipts.map((r: any) => r.status), ["0x1", "0x1"]);
  assert.equal(receipts[0].blockNumber, receipts[1].blockNumber, "one block");
  assert.equal(await watcher.poll(), true);
  told = heard();
  plain(told);
  assert.deepEqual(told.map((m) => m.text.split("\n")[0]), ["Done: Withdraw 1 ETH", "Cancelled: Withdraw 0.000000000000000001 ETH"]);
  assert.match(told[0].text, /was carried out\. The money went to the wallet of this Chronobox\./);
  assert.doesNotMatch(told[0].text, /No money moved/);
  ok("the withdrawal is reported as carried out, and only the decoy as cancelled");
  show(told.map((m) => m.text).join("\n\n"));

  console.log("\nAll alert checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
  resend.closeAllConnections();
  resend.close();
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
