/**
 * The alerts of the guardian and the recovery, against the real contracts on a local fork.
 *
 *   npm run fork                       (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:recovery-alerts
 *
 * The alert service watches every Chronobox on the network (--all) and posts to a local webhook. A Chronobox gets a
 * guardian with a recovery, the guardian starts a recovery, the wallet stops it, the guardian starts another one,
 * nobody stops it, and it is carried out. Then wallet and guardian change the wallet together, without a request.
 * The script checks each alert and prints them, so that a person can read them. It reverts the fork at the end.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Address } from "../src/lib/hex.ts";
import {
  type DelayTx,
  type Inspection,
  type Rpc,
  addGuardianTx,
  cancelAllTx,
  cancelTx,
  councilApproveTx,
  councilCreateTx,
  councilExecTx,
  councilHash,
  councilOwners,
  councilSwapTx,
  createTx,
  delayNonces,
  executeTx,
  inspect,
  lockTx,
  queueTx,
  recoveryDelayCreateTx,
  recoveryTx,
  removeRecoveryTx,
  safeFromReceipt,
  sendAndWait,
  withdrawalTx,
} from "../src/lib/chronobox.ts";
import { AllWatcher, RECOVERY_WINDOW, parseConfig } from "../watcher/src/index.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 6 to 9, and 4 as the stranger who carries things out.
const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const NEW: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const OTHER: Address = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const STRANGER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DAY = 24n * 3600n;
const WAIT = 90n * DAY;
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

// A stand-in for a webhook: it records every alert.
type Hook = { event: string; title: string; message: string; vault: string };
const hooks: Hook[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    hooks.push(JSON.parse(body));
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronobox-recovery-alerts-"));

/** The alerts since the last call, printed for a person, and checked for words that belong to the contracts. */
const heard = (): Hook[] => {
  const got = hooks.splice(0, hooks.length);
  for (const h of got) {
    console.log(`\n      [${h.event}] ${h.title}\n${h.message.replace(/^/gm, "      | ")}`);
    assert.doesNotMatch(h.message.split("Technical detail:")[0], /queue|transaction|execut|module|Delay |Roles|https?:/, h.message);
  }
  return got;
};
const events = (got: Hook[]) => got.map((h) => h.event);

const partsOf = (state: Inspection) => ({
  safe: state.safe,
  delay: state.delay!,
  roles: state.roles!,
  controller: state.controller!,
  guardian: state.guardian!,
  council: state.council!,
  members: state.members,
  recoveryDelay: state.recoveryDelay,
  recoveryOn: state.recovery !== null,
  councilRecovery: state.councilRecovery,
});

const snapshot = await rpc("evm_snapshot", []);
try {
  for (const account of [WALLET, GUARDIAN, NEW, OTHER, STRANGER]) await rpc("anvil_setCode", [account, "0x"]);
  const config = parseConfig(["--all"], { RPC_URL: URL, STATE_DIR: dir, HEARTBEAT_HOURS: "0", WEBHOOK_URL: hookUrl });
  // Counts how often the service reads when a step of the recovery line was queued: the work that a long line costs.
  let recoveryLine = "";
  let lineReads = 0;
  const counting: typeof fetch = (input, init) => {
    try {
      const body = JSON.parse(String(init?.body ?? ""));
      for (const one of [body].flat()) {
        const call = one?.method === "eth_call" ? one.params?.[0] : null;
        if (call && String(call.to).toLowerCase() === recoveryLine && String(call.data).startsWith("0x3aa76906")) lineReads++;
      }
    } catch { /* not JSON-RPC */ }
    return fetch(input, init);
  };
  const watcher = new AllWatcher(config, { log: () => {}, fetch: counting });
  const poll = async () => assert.equal(await watcher.poll(), true);
  await poll();

  /** Queues as `from`, polls, waits the delay, lets a stranger carry it out, and polls again. */
  const through = async (delay: Address, from: Address, tx: DelayTx) => {
    await sendAndWait(rpc, from, queueTx(delay, tx));
    await poll();
    const asked = heard();
    await warp(DAY + 60n);
    await sendAndWait(rpc, STRANGER, executeTx(delay, tx));
    await poll();
    return { asked, done: heard() };
  };

  step("1. A new Chronobox, then a guardian with a recovery of 90 days");
  const safe = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 0)))!;
  await sendAndWait(rpc, WALLET, lockTx(WALLET, safe, DAY));
  await sendAndWait(rpc, WALLET, { to: safe, data: "0x", value: 2n * ETH });
  await poll();
  let got = heard();
  assert.deepEqual(events(got), ["watching"]);
  let state = await inspect(rpc, safe);
  const delay = state.delay!;
  const roles = state.roles!;
  await sendAndWait(rpc, STRANGER, recoveryDelayCreateTx(safe));
  state = await inspect(rpc, safe);
  const adding = addGuardianTx({ safe, delay, roles, controller: WALLET }, GUARDIAN, { parts: state.recoveryDelay!, wait: WAIT })!;
  let r = await through(delay, WALLET, adding);
  assert.deepEqual(events(r.asked), ["queued"]);
  assert.match(r.asked[0].title, /^New request: Add the guardian 0x14dc…9955 with a recovery$/);
  assert.match(r.asked[0].message, /A recovery waits 90 days, and the wallet and the guardian can stop it/);
  assert.deepEqual(events(r.done), ["settings_changed", "closed"]);
  assert.match(r.done[0].message, new RegExp(`${GUARDIAN.toLowerCase()} is now the guardian`));
  assert.match(r.done[0].message, /The recovery is on\. .* A recovery waits 90 days/);
  assert.doesNotMatch(r.done[0].message, /can now cancel a request|Warning/);
  ok("the request and the change name the guardian and the recovery, and nothing else");
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  const delayR = state.recoveryDelay!.delay;

  step("2. A quiet Chronobox is not read, until the guardian starts a recovery");
  await poll();
  assert.equal(heard().length, 0);
  assert.equal(watcher.state.vaults[safe.toLowerCase()].active, false);
  await sendAndWait(rpc, GUARDIAN, councilCreateTx(safe, WALLET, GUARDIAN, true));
  state = await inspect(rpc, safe);
  let owners = await councilOwners(rpc, state.council!);
  let started = recoveryTx(partsOf(state), owners, NEW, state.queueNonce)!;
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, started));
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_started"]);
  assert.match(got[0].title, /^Recovery started: Recovery to 0x2361…1E8f$/i);
  assert.match(got[0].message, new RegExp(`hands this Chronobox to the wallet ${NEW.toLowerCase()}`));
  assert.match(got[0].message, /\(in 90 days\)/);
  assert.match(got[0].message, /If you did not ask for this, open your Chronobox and stop it\.$/);
  ok("the guardian started a recovery: the alert names the new wallet and the end of the wait");

  step("3. The wallet stops it");
  state = await inspect(rpc, safe);
  await sendAndWait(rpc, WALLET, cancelTx(roles, delayR, state.recovery!.txNonce));
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_stopped"]);
  assert.match(got[0].message, /was stopped on .*The wallet of this Chronobox did not change\./);
  ok("stopped");

  step("4. The guardian starts another one, and nobody stops it");
  state = await inspect(rpc, safe);
  // The recovery names the end of the line of withdrawals when it starts. Whatever the old wallet asks for after
  // that, it cancels too: the guardian leaves room for one more.
  started = recoveryTx(partsOf(state), owners, NEW, state.queueNonce + 1n)!;
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, started));
  await poll();
  assert.deepEqual(events(heard()), ["recovery_started"]);
  // Reminders before the wait ends: when it ends, anybody can carry it out at once.
  await warp(WAIT - 7n * DAY + 60n);
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_soon"]);
  assert.match(got[0].title, /^Recovery wait ends soon: Recovery to 0x2361…1e8f$/i);
  assert.match(got[0].message, /That is in 6 days 23 hours\. Then anybody can carry it out at once, and that wallet holds this Chronobox\.\n\nIf you did not ask for this, open your Chronobox and stop it before then\.$/);
  await poll();
  assert.deepEqual(events(heard()), []);
  await warp(6n * DAY);
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_soon"]);
  assert.match(got[0].message, /That is in 23 hours/);
  ok("reminders 7 days and 1 day before the wait ends, each once");
  await warp(DAY);
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_ready"]);
  assert.match(got[0].message, /Anybody can carry it out now, until .*stop it now\.$/s);
  ok("the wait is over: the last chance to stop it");
  // The old wallet has a withdrawal waiting. The recovery cancels it.
  await sendAndWait(rpc, WALLET, queueTx(delay, withdrawalTx(WALLET, null, ETH)));
  await poll();
  assert.deepEqual(events(heard()), ["queued"]);
  await sendAndWait(rpc, STRANGER, executeTx(delayR, started));
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_done", "cancelled"]);
  assert.match(got[0].message, new RegExp(`The wallet ${NEW.toLowerCase()} now holds this Chronobox\\. ${WALLET.toLowerCase()} cannot withdraw or cancel any more\\. No money moved\\.`));
  assert.match(got[1].title, /^Cancelled: Withdraw 1 ETH$/);
  ok("carried out: the new wallet holds it, the old withdrawal is cancelled, and no second message repeats the wallet");
  state = await inspect(rpc, safe);
  assert.equal(state.controller!.toLowerCase(), NEW.toLowerCase());

  step("5. Wallet and guardian change the wallet together, at once, without a request");
  assert.equal(watcher.state.vaults[safe.toLowerCase()].active, false);
  owners = await councilOwners(rpc, state.council!);
  const { queueNonce } = await delayNonces(rpc, delay);
  const swap = councilSwapTx(partsOf(state), owners, OTHER, queueNonce)!;
  const hash = await councilHash(rpc, state.council!, swap);
  await sendAndWait(rpc, GUARDIAN, councilApproveTx(state.council!, hash));
  await sendAndWait(rpc, NEW, councilExecTx(state.council!, swap, owners));
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["settings_changed"]);
  assert.match(got[0].message, new RegExp(`^The wallet of this Chronobox changed from ${NEW.toLowerCase()} to ${OTHER.toLowerCase()}\\. Only the new wallet can withdraw and cancel\\.\n\n`));
  ok("the service read the quiet Chronobox because its wallet changed");

  step("6. A state from before the service knew of guardians: no news of the guardian, but a waiting recovery is told");
  const file = path.join(dir, `${safe.toLowerCase()}.json`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const k of ["guardian", "council", "councilOwners", "councilThreshold", "councilModules", "recovery"]) delete saved.settings[k];
  for (const k of ["recoveryTxNonce", "recoveryQueueNonce", "recoveryItems"]) delete saved[k];
  fs.writeFileSync(file, JSON.stringify(saved));
  state = await inspect(rpc, safe);
  owners = await councilOwners(rpc, state.council!);
  started = recoveryTx(partsOf(state), owners, NEW, state.queueNonce)!;
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, started));
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_started"]);
  assert.match(got[0].message, new RegExp(`After that, ${OTHER.toLowerCase()} cannot withdraw`));
  ok("the first poll after the update learns the guardian quietly, and tells of the recovery that nobody was told of");

  step("7. Somebody follows the Chronobox while a recovery waits");
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "chronobox-recovery-alerts-"));
  const fresh = new AllWatcher(parseConfig(["--all"], { RPC_URL: URL, STATE_DIR: dir2, HEARTBEAT_HOURS: "0", WEBHOOK_URL: hookUrl }), { log: () => {} });
  assert.equal(await fresh.poll(), true);
  assert.equal(await fresh.adopt(safe.toLowerCase()), true);
  got = heard();
  assert.deepEqual(events(got), ["watching"]);
  assert.match(got[0].message, new RegExp(`Guardian: ${GUARDIAN.toLowerCase()}\\. .*A recovery waits 90 days`));
  assert.match(got[0].message, /In the line of the recovery, one step waits:\nRecovery to 0x2361…1e8f\. Its wait ends on /);
  assert.deepEqual(await fresh.pending(safe.toLowerCase()), [
    ...(await watcher.pending(safe.toLowerCase()))!,
  ]);
  fs.rmSync(dir2, { recursive: true, force: true });
  ok("the first message names the guardian, the recovery, and the recovery that waits");

  step("8. The guardian floods the line of the recovery: every poll reads the same few steps");
  recoveryLine = delayR.toLowerCase();
  state = await inspect(rpc, safe);
  owners = await councilOwners(rpc, state.council!);
  const flood = recoveryTx(partsOf(state), owners, NEW, state.queueNonce)!;
  const queueMany = async (n: number) => {
    for (let i = 0; i < n; i++) await sendAndWait(rpc, GUARDIAN, queueTx(delayR, flood));
  };
  await queueMany(12);
  lineReads = 0;
  await poll();
  got = heard();
  assert.deepEqual(events(got), [...Array(RECOVERY_WINDOW - 1).fill("recovery_started"), "recovery_backlog"]);
  assert.match(got.at(-1)!.title, /^Recovery line: 13 steps wait$/);
  assert.match(got.at(-1)!.message, /The alerts name the first 5, and the 8 behind them are only counted\. One stop removes all of them\./);
  assert.ok(lineReads <= RECOVERY_WINDOW, `${lineReads} reads`);
  ok(`13 steps: the first ${RECOVERY_WINDOW} are named, the rest counted (${lineReads} reads of the line)`);
  await queueMany(10);
  lineReads = 0;
  await poll();
  got = heard();
  assert.deepEqual(events(got), ["recovery_backlog"]);
  assert.match(got[0].title, /^Recovery line: 23 steps wait$/);
  assert.equal(lineReads, 0);
  await queueMany(1);
  await poll();
  assert.deepEqual(events(heard()), []);
  ok("told again when the line doubled, not for each step, and no more reads");
  assert.ok((await watcher.pending(safe.toLowerCase()))!.some((line) => /^19 more steps in the line of the recovery\./.test(line)));
  state = await inspect(rpc, safe);
  await sendAndWait(rpc, state.controller!, cancelAllTx(roles, delayR, state.recovery!)!);
  await poll();
  got = heard();
  assert.deepEqual(events(got), Array(RECOVERY_WINDOW).fill("recovery_stopped"));
  await queueMany(1);
  await poll();
  assert.deepEqual(events(heard()), ["recovery_started"]);
  ok("one stop removed all 24, and a new step is named again");

  step("9. The new wallet turns the recovery off, while a recovery waits");
  state = await inspect(rpc, safe);
  r = await through(delay, OTHER, removeRecoveryTx(partsOf(state))!);
  assert.match(r.asked[0].title, /^New request: Turn off the recovery$/);
  assert.deepEqual(events(r.done), ["settings_changed", "closed"]);
  assert.match(r.done[0].message, /^The recovery is off\. The guardian cannot start a recovery any more\. A recovery that waited can never be carried out now\./);
  ok("off");

  console.log("\nAll recovery alert checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
