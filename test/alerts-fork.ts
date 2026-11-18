/**
 * The watcher with --all against the real contracts on a local fork.
 *
 *   npm run fork              (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:alerts
 *
 * It creates two Chronoboxes and a Safe that is not a Chronobox, and checks that
 * every alert goes to the public topic of the right vault. The ntfy server is
 * a local stand-in that records what it gets. The script takes a snapshot
 * first and reverts to it at the end.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { alertTopic } from "../src/lib/alerts.ts";
import type { Address } from "../src/lib/hex.ts";
import { type Rpc, cancelTx, createTx, depositTx, executeTx, inspect, lockTx, queueTx, safeFromReceipt, sendAndWait, withdrawalTx } from "../src/lib/chronobox.ts";
import { AllWatcher, parseConfig } from "../watcher/watch.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 6 to 8. The browser dev wallet uses 0 to 2 and test/fork.ts uses 3 to 5.
const ANNA: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const BEN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const CARL: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
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

// A stand-in for the ntfy server: it records every published message.
type Message = { topic: string; title: string; priority: string; body: string };
const inbox: Message[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    inbox.push({ topic: req.url!.slice(1), title: String(req.headers.title), priority: String(req.headers.priority), body });
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const ntfy = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronobox-alerts-"));
const take = () => inbox.splice(0, inbox.length);

async function chronobox(wallet: Address, cooldown: bigint) {
  const safe = safeFromReceipt(await sendAndWait(rpc, wallet, createTx(wallet, 0)))!;
  await sendAndWait(rpc, wallet, lockTx(wallet, safe, cooldown));
  const state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  return { safe, delay: state.delay!, roles: state.roles!, topic: alertTopic(1, safe) };
}

const snapshot = await rpc("evm_snapshot", []);
try {
  for (const account of [ANNA, BEN, CARL]) await rpc("anvil_setCode", [account, "0x"]);

  step("1. The watcher starts and knows nobody");
  const logs: string[] = [];
  const watcher = new AllWatcher(
    parseConfig(["--all"], { RPC_URL: URL, NTFY_SERVER: ntfy, STATE_DIR: dir, HEARTBEAT_HOURS: "0" }),
    { log: (line) => logs.push(line) },
  );
  assert.equal(await watcher.poll(), true);
  assert.deepEqual(watcher.state.vaults, {});
  assert.equal(inbox.length, 0);
  ok("first poll: no vault, no message");

  step("2. Two Chronoboxes and one plain Safe appear");
  const anna = await chronobox(ANNA, DAY);
  const ben = await chronobox(BEN, 12n * 3600n);
  const plain = safeFromReceipt(await sendAndWait(rpc, CARL, createTx(CARL, 0)))!;
  assert.equal(await watcher.poll(), true);
  assert.deepEqual(Object.keys(watcher.state.vaults).sort(), [anna.safe, ben.safe].map((a) => a.toLowerCase()).sort());
  let got = take();
  assert.deepEqual(got.map((m) => m.topic).sort(), [anna.topic, ben.topic].sort());
  for (const m of got) {
    assert.equal(m.title, "Watching the vault");
    assert.match(m.body, /Cancel: yes, through the Roles modifier/);
  }
  ok(`both found by the Delay they deployed, without anybody telling the watcher`);
  ok(`the plain Safe ${plain} is ignored`);
  ok(`topics: ${anna.topic}, ${ben.topic}`);

  step("3. A withdrawal is asked for in one of them");
  await sendAndWait(rpc, ANNA, depositTx(anna.safe, null, 3n * ETH));
  await sendAndWait(rpc, BEN, depositTx(ben.safe, null, 2n * ETH));
  assert.equal(await watcher.poll(), true);
  assert.equal(inbox.length, 0);
  ok("deposits raise no alert");
  const annaOut = withdrawalTx(ANNA, null, ETH);
  await sendAndWait(rpc, ANNA, queueTx(anna.delay, annaOut));
  assert.equal(await watcher.poll(), true);
  got = take();
  assert.equal(got.length, 1);
  assert.equal(got[0].topic, anna.topic);
  assert.match(got[0].title, /^Queued: Withdrawal of 1 ETH to the owner wallet$/);
  assert.match(got[0].body, /can be cancelled until it is executed/);
  ok(`"${got[0].title}" went to the first topic only`);

  step("4. Cancel");
  await sendAndWait(rpc, ANNA, cancelTx(anna.roles, anna.delay, 0n));
  assert.equal(await watcher.poll(), true);
  got = take();
  assert.deepEqual(got.map((m) => [m.topic, m.title]), [[anna.topic, "Cancelled: transaction #0"]]);
  assert.equal(watcher.state.vaults[anna.safe.toLowerCase()].active, false);
  ok("the cancel is reported, and the vault is quiet again");

  step("5. A transfer to a stranger in the other one, then the wait ends");
  const benOut = withdrawalTx(CARL, null, ETH);
  await sendAndWait(rpc, BEN, queueTx(ben.delay, benOut));
  assert.equal(await watcher.poll(), true);
  got = take();
  assert.deepEqual(got.map((m) => [m.topic, m.priority]), [[ben.topic, "4"]]);
  assert.match(got[0].title, /^Unusual transfer queued/);
  ok(`"${got[0].title}" with priority 4 went to the second topic only`);
  await warp(12n * 3600n + 60n);
  assert.equal(await watcher.poll(), true);
  got = take();
  assert.deepEqual(got.map((m) => m.topic), [ben.topic]);
  assert.match(got[0].title, /^Ready to execute/);
  ok("ready is reported");
  await sendAndWait(rpc, CARL, executeTx(ben.delay, benOut));
  assert.equal(await watcher.poll(), true);
  got = take();
  assert.deepEqual(got.map((m) => m.topic), [ben.topic]);
  assert.match(got[0].body, /It was executed/);
  ok("the execution is reported");

  step("6. A restart sends nothing twice");
  const again = new AllWatcher(parseConfig(["--all"], { RPC_URL: URL, NTFY_SERVER: ntfy, STATE_DIR: dir, HEARTBEAT_HOURS: "0" }), { log: () => undefined });
  assert.equal(await again.poll(), true);
  assert.equal(inbox.length, 0);
  ok("no message after a restart");

  console.log("\nAll alert checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
  server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
