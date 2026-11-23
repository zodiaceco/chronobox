/**
 * Puts a Chronobox in every state that the vault page can show, on a local fork, so that
 * each can be looked at in the dev server.
 *
 *   npm run fork          (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run scenarios     (this script)
 *   npm run dev           then open http://localhost:3130/#/states
 *
 * Unlike the fork tests, this script keeps what it makes: that is the point. Every run makes
 * new vaults with new wallets, so it can run again on the same fork. It moves the fork's
 * clock forward by about nine days, to put items in line into each phase.
 *
 * It writes .scenarios/scenarios.json, which the dev server serves at /scenarios.json for #/states,
 * and which `npm run scenarios:shots` takes a picture of.
 * Every wallet here is made up, and anvil signs for it (impersonation). The dev wallet does
 * the same with ?as=<address>, so each link opens the page as the owner, the guardian, or a
 * stranger.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call } from "../src/lib/abi.ts";
import { CONTRACTS, SENTINEL } from "../src/lib/chains.ts";
import { type Address, type Hex, checksum, keccak, toBigInt, toQuantity, utf8 } from "../src/lib/hex.ts";
import {
  CANCEL_ROLE,
  EXPIRATION_SECONDS,
  type DelayTx,
  type Rpc,
  addGuardianTx,
  changeDelayTx,
  changeWalletTx,
  createTx,
  delayInitializer,
  depositTx,
  executeTx,
  inspect,
  lockTx,
  ownerBatchTx,
  predictDelay,
  predictRoles,
  queueTx,
  rolesInitializer,
  safeFromReceipt,
  sendAndWait,
  withdrawalTx,
} from "../src/lib/chronobox.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, ".scenarios", "scenarios.json");
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const DAY = 24n * 3600n;
const WEEK = 7n * DAY;
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

// New wallets on every run: the same fork can hold the scenarios of many runs.
const run = Date.now().toString(36);
const wallet = (name: string): Address => checksum("0x" + keccak(utf8(`chronobox-scenario:${run}:${name}`)).slice(-40));

/** A made-up wallet that anvil signs for, with coins to pay for gas. */
async function ready(address: Address): Promise<Address> {
  await rpc("anvil_impersonateAccount", [address]);
  await rpc("anvil_setBalance", [address, toQuantity(1000n * ETH)]);
  return address;
}

type Roles = { owner: Address; guardian?: Address; viewer: Address };
type Scenario = {
  id: string;
  title: string;
  /** What to look for on the page. */
  about: string;
  safe: Address;
  roles: Roles;
  /** A fault of the dev wallet that this scenario is about. The page can still pick another. */
  fault?: string;
};
const scenarios: Scenario[] = [];
const viewer = wallet("viewer");
const add = (scenario: Omit<Scenario, "roles"> & { roles: Omit<Roles, "viewer"> }) => {
  scenarios.push({ ...scenario, roles: { ...scenario.roles, viewer } });
  console.log(`  ok  ${scenario.id}: ${scenario.title}`);
};

type Vault = { owner: Address; controller: Address; safe: Address; delay: Address; roles: Address };

/** A finished Chronobox, as the app makes it. */
async function vault(name: string, cooldown: bigint, eth = 0n, weth = 0n): Promise<Vault> {
  const owner = await ready(wallet(name));
  const safe = safeFromReceipt(await sendAndWait(rpc, owner, createTx(owner, 0)))!;
  await sendAndWait(rpc, owner, lockTx(owner, safe, cooldown));
  const state = await inspect(rpc, safe);
  if (state.state !== "locked") throw new Error(`${name}: the vault is ${state.state}, not locked`);
  if (eth > 0n) await sendAndWait(rpc, owner, depositTx(safe, null, eth));
  if (weth > 0n) {
    await sendAndWait(rpc, owner, { to: WETH, data: "0x", value: weth });
    await sendAndWait(rpc, owner, depositTx(safe, WETH, weth));
  }
  return { owner, controller: owner, safe, delay: state.delay!, roles: state.roles! };
}

const queue = (v: Vault, tx: DelayTx, from = v.owner) => sendAndWait(rpc, from, queueTx(v.delay, tx));

console.log(`Scenarios on ${URL}, run ${run}`);
const chainId = toBigInt(await rpc("eth_chainId", []));
if (chainId !== 1n) throw new Error(`The fork must be of Ethereum mainnet (chain 1), not chain ${chainId}`);
// A real wallet would be checked by its own network; on the fork, the guardian is a made-up one too.
const guardian = await ready(wallet("guardian"));

// Phase A: items that must be expired by the end. The clock moves 8 days here.
console.log("\nPhase A: what must be old");
const expired = await vault("expired", DAY, 3n * ETH);
await queue(expired, withdrawalTx(expired.owner, null, ETH));
const guarded = await vault("guarded", DAY, 4n * ETH, 2n * ETH);
await queue(guarded, addGuardianTx(guarded, guardian)!);
await warp(DAY + 60n);
await sendAndWait(rpc, guarded.owner, executeTx(guarded.delay, addGuardianTx(guarded, guardian)!));
await warp(WEEK + 60n);

// Phase B: items that are ready to be carried out. The clock moves 1 day here.
console.log("\nPhase B: what must be ready");
const readyVault = await vault("ready", DAY, 3n * ETH, ETH);
await queue(readyVault, withdrawalTx(readyVault.owner, null, ETH));
await queue(readyVault, withdrawalTx(readyVault.owner, WETH, ETH / 2n));
await warp(DAY + 60n);

// Phase C: everything that waits. The clock does not move after this.
console.log("\nPhase C: what waits");
add({ id: "expired", title: "An item that waited too long", about: "One withdrawal past its window: it can only be removed.", safe: expired.safe, roles: { owner: expired.owner } });
add({ id: "ready", title: "Withdrawals ready to collect", about: "Two items whose wait is over: Finish, and the reminder.", safe: readyVault.safe, roles: { owner: readyVault.owner } });

const empty = await vault("empty", WEEK);
add({ id: "empty", title: "A new Chronobox", about: "Locked, nothing inside, nothing waits.", safe: empty.safe, roles: { owner: empty.owner } });

const funded = await vault("funded", WEEK, 5n * ETH, 3n * ETH);
add({ id: "funded", title: "Money inside, nothing waits", about: "The usual quiet page: two assets, the rows, no line.", safe: funded.safe, roles: { owner: funded.owner } });
add({
  id: "unverified",
  title: "One check could not run",
  about: "The same vault, read by a network that refuses old logs: deposits are held back.",
  safe: funded.safe,
  roles: { owner: funded.owner },
  fault: "nologs",
});

const waiting = await vault("waiting", WEEK, 5n * ETH, 3n * ETH);
await queue(waiting, withdrawalTx(waiting.owner, null, 2n * ETH));
await queue(waiting, withdrawalTx(waiting.owner, WETH, ETH));
add({ id: "waiting", title: "Two withdrawals wait", about: "The line with its countdowns. What waits is subtracted in the withdraw sheet.", safe: waiting.safe, roles: { owner: waiting.owner } });

const changes = await vault("changes", WEEK, 2n * ETH);
await queue(changes, changeDelayTx(changes.delay, 2n * WEEK));
await queue(changes, changeWalletTx(changes.delay, changes.owner, wallet("changes-new"), changes.roles)!);
await queue(changes, addGuardianTx(changes, guardian)!);
add({ id: "changes", title: "Changes the app makes", about: "A longer delay, a new wallet and a guardian, each waiting, each named plainly.", safe: changes.safe, roles: { owner: changes.owner } });

const flagged = await vault("flagged", WEEK, 5n * ETH, 3n * ETH);
await queue(flagged, withdrawalTx(wallet("thief"), WETH, ETH));
await queue(flagged, { to: flagged.delay, value: 0n, data: call("setTxCooldown(uint256)", [0n]), operation: 0 });
await queue(flagged, { to: wallet("contract"), value: 0n, data: "0x12345678", operation: 0 });
add({ id: "flagged", title: "Items the app did not make", about: "A transfer to another address, a delay of zero and an unknown call: each one a warning.", safe: flagged.safe, roles: { owner: flagged.owner } });

await queue(guarded, withdrawalTx(guarded.owner, null, ETH));
add({ id: "guardian", title: "A guardian, and a withdrawal waits", about: "As the guardian: the shield tag and Stop it. As the owner: Cancel, and the guardian in the rows.", safe: guarded.safe, roles: { owner: guarded.owner, guardian } });

const flooded = await vault("flooded", WEEK, 5n * ETH);
await queue(flooded, withdrawalTx(flooded.owner, null, 4n * ETH));
for (let i = 1; i <= 40; i++) await queue(flooded, withdrawalTx(flooded.owner, null, BigInt(i) * 10n ** 15n));
add({ id: "flooded", title: "41 items in line", about: "A stolen wallet flooded the line: only the first 20 are read, and Stop all is there at once.", safe: flooded.safe, roles: { owner: flooded.owner } });

// The setup stopped halfway: the Safe exists, the lock was never sent.
const halfOwner = await ready(wallet("half"));
const half = safeFromReceipt(await sendAndWait(rpc, halfOwner, createTx(halfOwner, 0)))!;
add({ id: "open", title: "A setup that stopped halfway", about: "The Safe exists, the delay is not on: Do not send money.", safe: half, roles: { owner: halfOwner } });

// What a fake copy of the app could make: the normal setup plus a second module on the Safe.
const evilOwner = await ready(wallet("tampered"));
const evil = safeFromReceipt(await sendAndWait(rpc, evilOwner, createTx(evilOwner, 0)))!;
{
  const evilDelay = predictDelay(evil, WEEK, EXPIRATION_SECONDS);
  const evilRoles = predictRoles(evil);
  const salt = toBigInt(keccak("0x7a6f646961632d74696d65626f783a7631"));
  await sendAndWait(
    rpc,
    evilOwner,
    ownerBatchTx(evilOwner, evil, [
      { to: CONTRACTS.moduleProxyFactory, data: call("deployModule(address,bytes,uint256)", [CONTRACTS.delayMastercopy, delayInitializer(evil, WEEK, EXPIRATION_SECONDS), salt]) },
      { to: CONTRACTS.moduleProxyFactory, data: call("deployModule(address,bytes,uint256)", [CONTRACTS.rolesMastercopy, rolesInitializer(evil), salt]) },
      { to: evilRoles, data: call("scopeTarget(bytes32,address)", [CANCEL_ROLE, evilDelay]) },
      { to: evilRoles, data: call("allowFunction(bytes32,address,bytes4,uint8)", [CANCEL_ROLE, evilDelay, "0x46ba2307", 0]) },
      { to: evilRoles, data: call("assignRoles(address,bytes32[],bool[])", [evilOwner, [CANCEL_ROLE], [true]]) },
      { to: evil, data: call("enableModule(address)", [evilDelay]) },
      { to: evil, data: call("enableModule(address)", [evilRoles]) },
      { to: evilDelay, data: call("enableModule(address)", [evilOwner]) },
      { to: evil, data: call("enableModule(address)", [wallet("backdoor")]) },
      { to: evil, data: call("swapOwner(address,address,address)", [SENTINEL, evilOwner, CONTRACTS.burn]) },
    ]),
  );
  const state = await inspect(rpc, evil);
  if (state.state !== "invalid") throw new Error(`tampered: the vault is ${state.state}, not invalid`);
}
add({ id: "tampered", title: "A Chronobox that fails a check", about: "A second module on the Safe: the page must warn, not reassure.", safe: evil, roles: { owner: evilOwner } });

add({ id: "missing", title: "No Chronobox at this address", about: "A link to an address with nothing behind it.", safe: wallet("nothing"), roles: { owner: wallet("nobody") } });

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ run, chain: "eth", createdAt: new Date().toISOString(), scenarios }, null, 2) + "\n");
console.log(`\n${scenarios.length} scenarios written to ${path.relative(ROOT, OUT)}. Open http://localhost:3130/#/states in the dev server.`);
