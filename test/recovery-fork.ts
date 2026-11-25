/**
 * The recovery, end to end against the real contracts on a local fork.
 *
 *   npm run fork                 (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:recovery
 *
 * A recovery is set on a finished Chronobox that has a guardian. This script proves what the
 * guardian can start, that the wallet can stop it, that it brings the Chronobox to the recovery
 * wallet and nowhere else, and what happens when it no longer fits. It reverts the fork at the end.
 */
import assert from "node:assert/strict";
import { call } from "../src/lib/abi.ts";
import { type Address, type Hex, sameAddress, toBigInt } from "../src/lib/hex.ts";
import {
  CANCEL_ROLE,
  RECOVER_ROLE,
  type DelayTx,
  type Rpc,
  addGuardianTx,
  cancelTx,
  changeWalletTx,
  classify,
  createTx,
  depositTx,
  executeTx,
  inspect,
  lockTx,
  nativeBalance,
  predictCouncil,
  predictRecoveryDelay,
  queueTx,
  readRecoveryLine,
  recoveryTx,
  removeGuardianTx,
  removeRecoveryTx,
  safeFromReceipt,
  sendAndWait,
  setRecoveryTx,
  startRecoveryTx,
  withdrawalTx,
} from "../src/lib/chronobox.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 6 to 9, and 4 as the stranger.
const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const RECOVERY: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const OTHER: Address = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const STRANGER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DAY = 24n * 3600n;
const WAIT = 30n * DAY;
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

async function reverts(from: Address, tx: { to: Address; data: Hex }, what: string) {
  try {
    await rpc("eth_call", [{ from, to: tx.to, data: tx.data }, "latest"]);
  } catch {
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
  for (const account of [WALLET, GUARDIAN, RECOVERY, OTHER, STRANGER]) await rpc("anvil_setCode", [account, "0x"]);

  /** A finished Chronobox of `wallet` with a delay of one day and a guardian. */
  const make = async (wallet: Address, index: number) => {
    const safe = safeFromReceipt(await sendAndWait(rpc, wallet, createTx(wallet, index)))!;
    await sendAndWait(rpc, wallet, lockTx(wallet, safe, DAY));
    const first = await inspect(rpc, safe);
    const delay = first.delay!;
    const roles = first.roles!;
    const adding = addGuardianTx({ safe, delay, roles, controller: wallet }, GUARDIAN)!;
    await sendAndWait(rpc, wallet, queueTx(delay, adding));
    await warp(DAY + 60n);
    await sendAndWait(rpc, STRANGER, executeTx(delay, adding));
    return { safe, delay, roles };
  };
  /** Queues as `from`, waits the day, and lets a stranger carry it out. */
  const through = async (delay: Address, from: Address, tx: DelayTx) => {
    await sendAndWait(rpc, from, queueTx(delay, tx));
    await warp(DAY + 60n);
    return sendAndWait(rpc, STRANGER, executeTx(delay, tx));
  };
  const partsOf = (state: Awaited<ReturnType<typeof inspect>>) => ({
    safe: state.safe,
    delay: state.delay!,
    roles: state.roles!,
    controller: state.controller!,
    guardian: state.guardian!,
    council: state.council!,
    members: state.members,
    modules: state.modules,
    recoveryDelay: state.recoveryDelay,
    recoveryOn: state.recovery !== null,
  });

  step("1. A finished Chronobox with a guardian, and no recovery");
  const { safe, delay, roles } = await make(WALLET, 0);
  await sendAndWait(rpc, WALLET, depositTx(safe, null, 2n * ETH));
  let state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  assert.equal(state.recovery, null);
  assert.ok(state.recoveryDelay && !state.recoveryDelay.deployed && !state.recoveryDelay.enabled);
  const delayR = predictRecoveryDelay(safe);
  assert.ok(sameAddress(state.recoveryDelay!.delay, delayR));
  ok("locked, guardian, no recovery, the recovery Delay is not made");
  const viaRoles = (to: Address, data: Hex, role: Hex, operation = 0, value = 0n) => ({
    to: roles,
    data: call("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)", [to, value, data, operation, role, true]),
  });
  const exec = (tx: DelayTx) => call("execTransactionFromModule(address,uint256,bytes,uint8)", [tx.to, tx.value, tx.data, tx.operation]);

  step("2. Set the recovery: one item in the line, it waits like everything else");
  for (const bad of [WALLET, GUARDIAN, state.council, safe, delay, roles, delayR, null]) assert.equal(setRecoveryTx(partsOf(state), bad, WAIT), null, `recovery wallet ${bad}`);
  assert.equal(setRecoveryTx(partsOf(state), RECOVERY, 60n), null);
  const setting = setRecoveryTx(partsOf(state), RECOVERY, WAIT)!;
  assert.deepEqual(classify(setting, partsOf(state)), { kind: "set-recovery", wallet: RECOVERY, wait: WAIT });
  assert.equal(classify({ ...setting, data: `${setting.data}00` as Hex }, partsOf(state)).kind, "unknown");
  await reverts(STRANGER, queueTx(delay, setting), "a stranger sets a recovery");
  await reverts(GUARDIAN, queueTx(delay, setting), "the guardian sets a recovery");
  await sendAndWait(rpc, WALLET, queueTx(delay, setting));
  state = await inspect(rpc, safe);
  assert.equal(state.recovery, null);
  assert.equal(state.state, "locked");
  await warp(DAY + 60n);
  console.log(`  gas used to apply the recovery: ${gas(await sendAndWait(rpc, STRANGER, executeTx(delay, setting)))}`);
  state = await inspect(rpc, safe);
  for (const check of state.checks) console.log(`  ${check.ok ? "ok " : "BAD"} ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  assert.ok(state.recovery);
  assert.ok(sameAddress(state.recovery!.wallet, RECOVERY));
  assert.equal(state.recovery!.wait, WAIT);
  assert.equal(state.recovery!.fits, true);
  assert.ok(sameAddress(state.recovery!.delay, delayR));
  assert.ok(state.recoveryDelay!.deployed && state.recoveryDelay!.enabled && state.recoveryDelay!.wired && state.recoveryDelay!.sound);
  assert.equal(state.modules.length, 3);
  const batch = state.recovery!.batch;
  assert.deepEqual(batch, recoveryTx(partsOf(state), RECOVERY));
  ok("locked, with a recovery to the recovery wallet that waits 30 days");

  step("3. The guardian alone: start this one recovery, and nothing else");
  const start = startRecoveryTx(roles, state.recovery!);
  await reverts(STRANGER, start, "a stranger starts the recovery");
  await reverts(WALLET, start, "the wallet starts the recovery");
  await reverts(RECOVERY, start, "the recovery wallet starts the recovery");
  await reverts(GUARDIAN, queueTx(delayR, batch), "the guardian puts the recovery into the line without the Roles modifier");
  await reverts(GUARDIAN, queueTx(delay, batch), "the guardian puts the recovery into the line for withdrawals");
  const toGuardian = recoveryTx(partsOf(state), OTHER)!;
  await reverts(GUARDIAN, viaRoles(delayR, exec(toGuardian), RECOVER_ROLE), "the guardian starts a recovery to another wallet");
  await reverts(GUARDIAN, viaRoles(delayR, exec(withdrawalTx(GUARDIAN, null, ETH)), RECOVER_ROLE), "the guardian puts a withdrawal into the recovery line");
  await reverts(GUARDIAN, viaRoles(delayR, exec({ ...batch, operation: 0 }), RECOVER_ROLE), "the guardian changes the kind of call");
  await reverts(GUARDIAN, viaRoles(delayR, exec({ ...batch, to: GUARDIAN }), RECOVER_ROLE), "the guardian changes the target");
  await reverts(GUARDIAN, viaRoles(delayR, exec({ ...batch, data: `${batch.data}00` as Hex }), RECOVER_ROLE), "the guardian adds a byte");
  await reverts(GUARDIAN, viaRoles(delayR, call("setTxCooldown(uint256)", [1n]), RECOVER_ROLE), "the guardian makes the recovery wait shorter");
  await reverts(GUARDIAN, viaRoles(delay, exec(batch), RECOVER_ROLE), "the guardian uses the role on the line for withdrawals");
  await reverts(GUARDIAN, viaRoles(delayR, exec(batch), RECOVER_ROLE, 1), "the guardian uses a delegatecall");
  await reverts(GUARDIAN, viaRoles(delayR, exec(batch), CANCEL_ROLE), "the guardian starts a recovery with the cancel role");

  step("4. The guardian starts it, and the wallet stops it");
  console.log(`  gas used to start a recovery: ${gas(await sendAndWait(rpc, GUARDIAN, start))}`);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  let line = await readRecoveryLine(rpc, state.recovery!);
  assert.equal(line.length, 1);
  assert.equal(line[0].isRecovery, true);
  await reverts(STRANGER, executeTx(delayR, batch), "a stranger carries the recovery out before the wait is over");
  await warp(WAIT - DAY);
  await reverts(STRANGER, executeTx(delayR, batch), "a stranger carries the recovery out one day early");
  await reverts(STRANGER, cancelTx(roles, delayR, line[0].nonce), "a stranger stops the recovery");
  await sendAndWait(rpc, WALLET, cancelTx(roles, delayR, line[0].nonce));
  state = await inspect(rpc, safe);
  assert.equal((await readRecoveryLine(rpc, state.recovery!)).length, 0);
  assert.ok(sameAddress(state.controller, WALLET));
  await warp(2n * DAY);
  await reverts(STRANGER, executeTx(delayR, batch), "a stranger carries out a recovery that was stopped");
  ok("the wallet stopped the recovery, nothing changed");

  step("5. The wallet is lost: the guardian starts it, nobody stops it");
  // What the lost wallet left in the line stays there. The new wallet and the guardian can cancel it.
  await sendAndWait(rpc, GUARDIAN, start);
  await warp(WAIT + 60n);
  const before = await nativeBalance(rpc, safe);
  console.log(`  gas used to carry a recovery out: ${gas(await sendAndWait(rpc, STRANGER, executeTx(delayR, batch)))}`);
  state = await inspect(rpc, safe);
  for (const check of state.checks) console.log(`  ${check.ok ? "ok " : "BAD"} ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.controller, RECOVERY));
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  assert.ok(sameAddress(state.council, predictCouncil(safe, RECOVERY, GUARDIAN)));
  assert.equal(state.recovery, null);
  assert.equal(await nativeBalance(rpc, safe), before);
  await reverts(WALLET, queueTx(delay, withdrawalTx(WALLET, null, ETH)), "the old wallet asks for a withdrawal");
  await reverts(WALLET, cancelTx(roles, delay, 0n), "the old wallet cancels");
  await reverts(GUARDIAN, start, "the guardian starts the same recovery again");
  await through(delay, RECOVERY, withdrawalTx(RECOVERY, null, ETH));
  assert.equal(await nativeBalance(rpc, safe), before - ETH);
  ok("the recovery wallet is the wallet now, the guardian stays, and no money moved in the recovery");

  step("6. The new wallet sets a recovery again, and changes it");
  const again = setRecoveryTx(partsOf(state), OTHER, WAIT)!;
  assert.deepEqual(classify(again, partsOf(state)), { kind: "set-recovery", wallet: OTHER, wait: WAIT });
  await through(delay, RECOVERY, again);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.recovery!.wallet, OTHER));
  assert.equal(state.recovery!.fits, true);
  const changed = setRecoveryTx(partsOf(state), WALLET, 60n * DAY)!;
  assert.deepEqual(classify(changed, partsOf(state)), { kind: "set-recovery", wallet: WALLET, wait: 60n * DAY });
  await through(delay, RECOVERY, changed);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.recovery!.wallet, WALLET));
  assert.equal(state.recovery!.wait, 60n * DAY);
  await reverts(GUARDIAN, viaRoles(delayR, exec(recoveryTx(partsOf(state), OTHER)!), RECOVER_ROLE), "the guardian starts the recovery that was replaced");
  ok("a new recovery wallet and a new wait replace the old ones");

  step("7. A wallet change makes the recovery stale: it does nothing, and the page says so");
  const moving = changeWalletTx(delay, RECOVERY, OTHER, roles, safe, { guardian: GUARDIAN, council: state.council!, members: state.members })!;
  await through(delay, RECOVERY, moving);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.controller, OTHER));
  assert.ok(state.recovery);
  assert.equal(state.recovery!.fits, false);
  await sendAndWait(rpc, GUARDIAN, startRecoveryTx(roles, state.recovery!));
  await warp(60n * DAY + 60n);
  await reverts(STRANGER, executeTx(delayR, state.recovery!.batch), "a stale recovery is carried out");
  state = await inspect(rpc, safe);
  assert.ok(sameAddress(state.controller, OTHER));
  line = await readRecoveryLine(rpc, state.recovery!);
  assert.equal(line.length, 1);
  await sendAndWait(rpc, OTHER, cancelTx(roles, delayR, line[0].nonce));
  ok("the stale recovery changed nothing, and the wallet cleared it from the line");

  step("8. Turn the recovery off, and on again");
  const off = removeRecoveryTx(partsOf(state))!;
  assert.deepEqual(classify(off, partsOf(state)), { kind: "remove-recovery" });
  await through(delay, OTHER, off);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.equal(state.recovery, null);
  assert.equal(state.modules.length, 2);
  assert.ok(state.recoveryDelay!.deployed && !state.recoveryDelay!.enabled);
  await reverts(GUARDIAN, viaRoles(delayR, exec(recoveryTx(partsOf(state), WALLET)!), RECOVER_ROLE), "the guardian starts a recovery that is off");
  const on = setRecoveryTx(partsOf(state), RECOVERY, WAIT)!;
  assert.deepEqual(classify(on, partsOf(state)), { kind: "set-recovery", wallet: RECOVERY, wait: WAIT });
  await through(delay, OTHER, on);
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.recovery!.wallet, RECOVERY));
  assert.equal(state.recovery!.wait, WAIT);
  assert.equal(state.recovery!.fits, true);
  ok("off: the guardian can start nothing. On again: the same recovery Delay is used");

  step("9. Removing the guardian removes the recovery too");
  const lastRecovery = { delay: delayR, batch: state.recovery!.batch };
  const leaving = removeGuardianTx(partsOf(state))!;
  assert.deepEqual(classify(leaving, partsOf(state)), { kind: "remove-guardian", guardian: GUARDIAN });
  await through(delay, OTHER, leaving);
  state = await inspect(rpc, safe);
  for (const check of state.checks) console.log(`  ${check.ok ? "ok " : "BAD"} ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  assert.equal(state.guardian, null);
  assert.equal(state.recovery, null);
  assert.equal(state.modules.length, 2);
  await reverts(GUARDIAN, startRecoveryTx(roles, lastRecovery), "the old guardian starts a recovery");
  await reverts(GUARDIAN, cancelTx(roles, delay, 0n), "the old guardian cancels");
  ok("no guardian, no recovery, and the Chronobox is as after its setup");

  console.log("\nAll recovery checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
}
