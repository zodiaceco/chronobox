/**
 * The guardian, end to end against the real contracts on a local fork.
 *
 *   npm run fork                 (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:guardian
 *
 * A guardian is added to a finished Chronobox, never during its setup. This
 * script proves what the guardian can do, what wallet and guardian can do
 * together, and what neither can do. It reverts the fork at the end.
 */
import assert from "node:assert/strict";
import { call, selector } from "../src/lib/abi.ts";
import { type Address, type Hex, sameAddress, toBigInt } from "../src/lib/hex.ts";
import {
  CANCEL_ROLE,
  COUNCIL_ROLE,
  type DelayTx,
  type Rpc,
  addGuardianTx,
  cancelTx,
  changeWalletTx,
  classify,
  councilApproveTx,
  councilApproved,
  councilCreateTx,
  councilExecTx,
  councilHash,
  councilOwners,
  councilSwapTx,
  createTx,
  depositTx,
  executeTx,
  inspect,
  lockTx,
  nativeBalance,
  predictCouncil,
  queueTx,
  removeGuardianTx,
  safeFromReceipt,
  sendAndWait,
  withdrawalTx,
} from "../src/lib/chronobox.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 6 to 9. The browser uses 0 to 2 and the main fork test 3 to 5.
const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const SECOND: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const THIRD: Address = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const STRANGER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
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

async function reverts(from: Address, tx: { to: Address; data: Hex }, expect: RegExp | null, what: string) {
  try {
    await rpc("eth_call", [{ from, to: tx.to, data: tx.data }, "latest"]);
  } catch (error) {
    const text = `${(error as Error).message} ${JSON.stringify((error as any).data ?? "")}`;
    if (expect) assert.match(text, expect, `${what}: wrong revert reason: ${text}`);
    console.log(`  ok  reverts: ${what}`);
    return;
  }
  assert.fail(`${what}: expected a revert`);
}

const step = (text: string) => console.log(`\n${text}`);
const ok = (text: string) => console.log(`  ok  ${text}`);
const gas = (receipt: unknown) => toBigInt((receipt as { gasUsed: Hex }).gasUsed);

const snapshot = await rpc("evm_snapshot", []);
try {
  for (const account of [WALLET, GUARDIAN, SECOND, THIRD, STRANGER]) await rpc("anvil_setCode", [account, "0x"]);

  /** A finished Chronobox of `wallet` with a delay of one day. */
  const make = async (wallet: Address, index: number) => {
    const safe = safeFromReceipt(await sendAndWait(rpc, wallet, createTx(wallet, index)))!;
    await sendAndWait(rpc, wallet, lockTx(wallet, safe, DAY));
    const state = await inspect(rpc, safe);
    assert.equal(state.state, "locked");
    return { safe, delay: state.delay!, roles: state.roles! };
  };
  /** Queues as `from`, waits the day, and lets a stranger carry it out. */
  const through = async (delay: Address, from: Address, tx: DelayTx) => {
    await sendAndWait(rpc, from, queueTx(delay, tx));
    await warp(DAY + 60n);
    return sendAndWait(rpc, STRANGER, executeTx(delay, tx));
  };

  step("1. A finished Chronobox, as the setup makes it: no guardian");
  const { safe, delay, roles } = await make(WALLET, 0);
  await sendAndWait(rpc, WALLET, depositTx(safe, null, 2n * ETH));
  let state = await inspect(rpc, safe);
  assert.equal(state.guardian, null);
  assert.equal(state.council, null);
  assert.deepEqual(state.members.map((m) => m.toLowerCase()), [WALLET.toLowerCase()]);
  ok("locked, one member, no guardian");
  const parts = () => ({ safe, delay, roles, controller: state.controller!, guardian: state.guardian, council: state.council, members: state.members });
  const viaRoles = (to: Address, data: Hex, role: Hex, operation = 0, value = 0n) => ({
    to: roles,
    data: call("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)", [to, value, data, operation, role, true]),
  });

  step("2. Add a guardian: one item in the line, it waits like everything else");
  for (const bad of [WALLET, safe, delay, roles, null]) assert.equal(addGuardianTx(parts() as any, bad), null);
  const adding = addGuardianTx({ safe, delay, roles, controller: WALLET }, GUARDIAN)!;
  assert.deepEqual(classify(adding, parts()), { kind: "add-guardian", guardian: GUARDIAN });
  assert.equal(classify({ ...adding, data: `${adding.data}00` as Hex }, parts()).kind, "unknown");
  await reverts(STRANGER, queueTx(delay, adding), null, "a stranger adds a guardian");
  await sendAndWait(rpc, WALLET, queueTx(delay, adding));
  await reverts(WALLET, executeTx(delay, adding), /cooldown/, "the guardian starts before the wait is over");
  await reverts(GUARDIAN, cancelTx(roles, delay, 0n), null, "the guardian cancels before it has started");
  state = await inspect(rpc, safe);
  assert.equal(state.guardian, null);
  assert.equal(state.state, "locked");
  await warp(DAY + 60n);
  console.log(`  gas used to apply the guardian: ${gas(await sendAndWait(rpc, STRANGER, executeTx(delay, adding)))}`);
  state = await inspect(rpc, safe);
  for (const check of state.checks) console.log(`  ${check.ok ? "ok " : "BAD"} ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  const council = predictCouncil(safe, WALLET, GUARDIAN);
  assert.ok(sameAddress(state.council, council));
  assert.equal(state.councilMade, false);
  assert.equal(await rpc("eth_getCode", [council, "latest"]), "0x");
  ok("locked with a guardian. The shared Safe has its role and does not exist yet");

  step("3. The guardian alone: cancel, and nothing else");
  const out = withdrawalTx(WALLET, null, ETH);
  await sendAndWait(rpc, WALLET, queueTx(delay, out));
  state = await inspect(rpc, safe);
  const before = await nativeBalance(rpc, safe);
  await sendAndWait(rpc, GUARDIAN, cancelTx(roles, delay, state.queueNonce - 1n));
  state = await inspect(rpc, safe);
  assert.equal(state.txNonce, state.queueNonce);
  assert.equal(await nativeBalance(rpc, safe), before);
  ok("the guardian cancelled a withdrawal, nothing moved");
  await reverts(GUARDIAN, queueTx(delay, withdrawalTx(GUARDIAN, null, 1n)), null, "the guardian asks for a withdrawal");
  await reverts(GUARDIAN, viaRoles(delay, call("setTxCooldown(uint256)", [0n]), CANCEL_ROLE), null, "the guardian sets the delay to zero");
  await reverts(GUARDIAN, viaRoles(delay, call("enableModule(address)", [GUARDIAN]), CANCEL_ROLE), null, "the guardian makes itself the wallet with the cancel role");
  await reverts(GUARDIAN, viaRoles(delay, call("enableModule(address)", [GUARDIAN]), COUNCIL_ROLE), null, "the guardian alone uses the role of the shared Safe");
  await reverts(WALLET, viaRoles(delay, call("enableModule(address)", [SECOND]), COUNCIL_ROLE), null, "the wallet alone uses the role of the shared Safe");
  await reverts(GUARDIAN, viaRoles(GUARDIAN, "0x", CANCEL_ROLE, 0, 1n), null, "the guardian sends ETH out");

  step("4. Wallet and guardian together: a new wallet at once");
  // Anybody can make the shared Safe. The result is the same.
  const made = safeFromReceipt(await sendAndWait(rpc, STRANGER, councilCreateTx(safe, WALLET, GUARDIAN)))!;
  assert.ok(sameAddress(made, council));
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.equal(state.councilMade, true);
  ok("a stranger made the shared Safe, it is at the expected address and the checks pass");
  // What the shared Safe can do with its role, asked as the Safe itself.
  await reverts(council, viaRoles(delay, call("setTxCooldown(uint256)", [0n]), COUNCIL_ROLE), null, "both together set the delay to zero");
  await reverts(council, viaRoles(delay, call("setTxNonce(uint256)", [9n]), COUNCIL_ROLE), null, "both together skip the line with the shared role");
  await reverts(council, viaRoles(safe, call("enableModule(address)", [council]), COUNCIL_ROLE), null, "both together add a module to the Chronobox");
  await reverts(council, viaRoles(council, "0x", COUNCIL_ROLE, 0, ETH), null, "both together send ETH out");
  await reverts(council, viaRoles(delay, call("enableModule(address)", [council]), COUNCIL_ROLE, 1), null, "both together use a delegatecall");
  await reverts(council, viaRoles(roles, call("allowTarget(bytes32,address,uint8)", [COUNCIL_ROLE, safe, 3]), COUNCIL_ROLE), null, "both together widen their own permission");
  await reverts(council, viaRoles(roles, call("transferOwnership(address)", [council]), COUNCIL_ROLE), null, "both together take the Roles modifier");

  const owners = await councilOwners(rpc, council);
  const swap = councilSwapTx(parts() as any, owners, SECOND)!;
  for (const bad of [WALLET, GUARDIAN, council, safe, null]) assert.equal(councilSwapTx(parts() as any, owners, bad), null);
  const hash = await councilHash(rpc, council, swap);
  const exec = councilExecTx(council, swap, owners);
  await reverts(WALLET, exec, /GS025/, "the wallet changes the wallet without the guardian");
  await reverts(GUARDIAN, exec, /GS025/, "the guardian changes the wallet without the wallet");
  await reverts(STRANGER, councilApproveTx(council, hash), /GS030/, "a stranger agrees");
  assert.equal(await councilApproved(rpc, council, GUARDIAN, hash), false);
  await sendAndWait(rpc, GUARDIAN, councilApproveTx(council, hash));
  assert.equal(await councilApproved(rpc, council, GUARDIAN, hash), true);
  await reverts(STRANGER, exec, /GS025/, "a stranger carries it out after the guardian agreed");
  console.log(`  gas used by the change: ${gas(await sendAndWait(rpc, WALLET, exec))}`);
  state = await inspect(rpc, safe);
  for (const check of state.checks) if (!check.ok) console.log(`  BAD ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.controller, SECOND));
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  assert.ok(sameAddress(state.council, council));
  assert.deepEqual((await councilOwners(rpc, council)).map((o) => o.toLowerCase()).sort(), [SECOND, GUARDIAN].map((o) => o.toLowerCase()).sort());
  ok("the new wallet holds the Chronobox, with no wait. The shared Safe is now of the new wallet and the guardian");
  await reverts(WALLET, queueTx(delay, withdrawalTx(WALLET, null, 1n)), null, "the old wallet asks for a withdrawal");
  await reverts(WALLET, cancelTx(roles, delay, state.txNonce), null, "the old wallet cancels");
  await reverts(WALLET, exec, null, "the old wallet runs the same change again");
  await sendAndWait(rpc, SECOND, queueTx(delay, withdrawalTx(SECOND, null, 1n)));
  await sendAndWait(rpc, SECOND, cancelTx(roles, delay, state.txNonce));
  ok("the new wallet can ask and cancel");

  step("5. The guardian has the last word on changes that the wallet makes alone");
  state = await inspect(rpc, safe);
  const alone = changeWalletTx(delay, SECOND, THIRD, roles, safe, { guardian: GUARDIAN, council, members: state.members })!;
  assert.deepEqual(classify(alone, parts()), { kind: "change-wallet", to: THIRD });
  const removal = removeGuardianTx(parts() as any)!;
  assert.deepEqual(classify(removal, parts()), { kind: "remove-guardian", guardian: GUARDIAN });
  await sendAndWait(rpc, SECOND, queueTx(delay, alone));
  await sendAndWait(rpc, SECOND, queueTx(delay, removal));
  state = await inspect(rpc, safe);
  await sendAndWait(rpc, GUARDIAN, cancelTx(roles, delay, state.queueNonce - 1n));
  state = await inspect(rpc, safe);
  assert.equal(state.txNonce, state.queueNonce);
  assert.ok(sameAddress(state.controller, SECOND));
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  ok("the guardian cancelled a new wallet and its own removal");

  step("6. The wallet alone, when the guardian lets it pass: a new wallet after the wait");
  await through(delay, SECOND, alone);
  state = await inspect(rpc, safe);
  for (const check of state.checks) if (!check.ok) console.log(`  BAD ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.controller, THIRD));
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  assert.ok(sameAddress(state.council, predictCouncil(safe, THIRD, GUARDIAN)));
  assert.equal(state.councilMade, false);
  await reverts(council, viaRoles(delay, call("enableModule(address)", [SECOND]), COUNCIL_ROLE), null, "the old shared Safe uses its role");
  ok("the third wallet holds it, and a new shared Safe of that wallet and the guardian has the role");

  step("7. Remove the guardian, then add another: back to one member, and the history still proves it");
  await through(delay, THIRD, removeGuardianTx(parts() as any)!);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.equal(state.guardian, null);
  assert.deepEqual(state.members.map((m) => m.toLowerCase()), [THIRD.toLowerCase()]);
  await reverts(GUARDIAN, cancelTx(roles, delay, state.txNonce), null, "the removed guardian cancels");
  ok("no guardian, one member, locked");
  await through(delay, THIRD, addGuardianTx({ safe, delay, roles, controller: THIRD }, SECOND)!);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.guardian, SECOND));
  ok("a second guardian, locked");

  step("8. An RPC without old logs");
  const noLogs: Rpc = (method, params) => (method === "eth_getLogs" ? Promise.reject(new Error("no logs")) : rpc(method, params));
  const blind = await inspect(noLogs, safe);
  assert.equal(blind.state, "unverified");
  assert.ok(sameAddress(blind.guardian, SECOND));
  ok("unverified, and the guardian is still read from the state");

  step("9. Setups that only look like a guardian are caught");
  const item = (target: Address, data: Hex) => ({ to: target, data });
  const batch = (calls: { to: Address; data: Hex }[]): DelayTx => {
    const packed = calls.map((c) => "00" + c.to.slice(2) + "0".repeat(64) + (c.data.length / 2 - 1).toString(16).padStart(64, "0") + c.data.slice(2)).join("");
    return { to: "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526", value: 0n, data: call("multiSend(bytes)", [("0x" + packed) as Hex]), operation: 1 };
  };
  const assign = (member: Address, role: Hex) => call("assignRoles(address,bytes32[],bool[])", [member, [role], [true]]);
  // The shared role goes to a plain address, not to a Safe of the two.
  const a = await make(WALLET, 1);
  await through(a.delay, WALLET, batch([item(a.roles, assign(GUARDIAN, CANCEL_ROLE)), item(a.roles, assign(STRANGER, COUNCIL_ROLE))]));
  const stateA = await inspect(rpc, a.safe);
  assert.equal(stateA.state, "invalid");
  assert.equal(stateA.checks.find((c) => c.id === "canceller")?.ok, false);
  ok("a plain address with the shared role: invalid");
  // The right guardian setup, plus one more permission for the shared role.
  const b = await make(WALLET, 2);
  await sendAndWait(rpc, WALLET, queueTx(b.delay, addGuardianTx({ ...b, controller: WALLET }, GUARDIAN)!));
  const wider = batch([item(b.roles, call("allowFunction(bytes32,address,bytes4,uint8)", [COUNCIL_ROLE, b.delay, selector("setTxCooldown(uint256)"), 0]))]);
  await sendAndWait(rpc, WALLET, queueTx(b.delay, wider));
  await warp(DAY + 60n);
  await sendAndWait(rpc, STRANGER, executeTx(b.delay, addGuardianTx({ ...b, controller: WALLET }, GUARDIAN)!));
  await sendAndWait(rpc, STRANGER, executeTx(b.delay, wider));
  const stateB = await inspect(rpc, b.safe);
  assert.equal(stateB.state, "invalid");
  assert.equal(stateB.checks.find((c) => c.id === "cancel-only")?.ok, false);
  ok("a wider permission for the shared role: invalid");
  // The shared Safe was made, and then changed so that one owner is enough.
  const c = await make(WALLET, 3);
  await through(c.delay, WALLET, addGuardianTx({ ...c, controller: WALLET }, GUARDIAN)!);
  const loose = safeFromReceipt(await sendAndWait(rpc, STRANGER, councilCreateTx(c.safe, WALLET, GUARDIAN)))!;
  const lower: DelayTx = { to: loose, value: 0n, data: call("changeThreshold(uint256)", [1n]), operation: 0 };
  const looseOwners = await councilOwners(rpc, loose);
  await sendAndWait(rpc, GUARDIAN, councilApproveTx(loose, await councilHash(rpc, loose, lower)));
  await sendAndWait(rpc, WALLET, councilExecTx(loose, lower, looseOwners));
  const stateC = await inspect(rpc, c.safe);
  assert.equal(stateC.state, "invalid");
  assert.equal(stateC.checks.find((check) => check.id === "council")?.ok, false);
  ok("a shared Safe that needs only one owner: invalid");

  console.log("\nAll guardian checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
}
