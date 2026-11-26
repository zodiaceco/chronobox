/**
 * The recovery, end to end against the real contracts on a local fork.
 *
 *   npm run fork                 (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:recovery
 *
 * A recovery is turned on for a finished Chronobox that has a guardian. With it, the guardian
 * alone can bring the Chronobox to a wallet that the guardian chooses, after a long wait. This
 * script proves who can start it, that the wallet can stop it, that it changes the wallet and
 * moves no money, and that turning it off really ends it. It reverts the fork at the end.
 */
import assert from "node:assert/strict";
import { call } from "../src/lib/abi.ts";
import { CONTRACTS } from "../src/lib/chains.ts";
import { type Address, type Hex, keccak, sameAddress, toBigInt } from "../src/lib/hex.ts";
import {
  CANCEL_ROLE,
  COUNCIL_ROLE,
  DEFAULT_RECOVERY_WAIT,
  MIN_RECOVERY_WAIT,
  SAFE_MODULE_SETUP_CODE_HASH,
  type DelayTx,
  type Inspection,
  type Rpc,
  addGuardianTx,
  cancelAllTx,
  cancelTx,
  changeWalletTx,
  classify,
  councilCreateTx,
  councilOwners,
  councilOwnersNow,
  createTx,
  delayNonces,
  depositTx,
  executeTx,
  inspect,
  lockTx,
  nativeBalance,
  predictCouncil,
  predictRecoveryDelay,
  queueTx,
  readRecoveryLine,
  recoveryDelayCreateTx,
  recoveryTx,
  removeGuardianTx,
  removeRecoveryTx,
  safeFromReceipt,
  sendAndWait,
  setRecoveryTx,
  withdrawalTx,
} from "../src/lib/chronobox.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 6 to 9, and 4 as the stranger.
const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const NEW: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const OTHER: Address = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const STRANGER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DAY = 24n * 3600n;
const WAIT = DEFAULT_RECOVERY_WAIT;
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
const same = (a: readonly string[], b: readonly string[]) => assert.deepEqual(a.map((x) => x.toLowerCase()), b.map((x) => x.toLowerCase()));

const snapshot = await rpc("evm_snapshot", []);
try {
  for (const account of [WALLET, GUARDIAN, NEW, OTHER, STRANGER]) await rpc("anvil_setCode", [account, "0x"]);

  /** Queues as `from`, waits the day, and lets a stranger carry it out. */
  const through = async (delay: Address, from: Address, tx: DelayTx) => {
    await sendAndWait(rpc, from, queueTx(delay, tx));
    await warp(DAY + 60n);
    return sendAndWait(rpc, STRANGER, executeTx(delay, tx));
  };
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
  const report = (state: Inspection) => {
    for (const check of state.checks) if (!check.ok) console.log(`  BAD ${check.label} (${check.detail})`);
  };
  const locked = (state: Inspection) => {
    report(state);
    assert.equal(state.state, "locked");
  };

  step("0. The helper contract of Safe that the Council Safe uses in its setup");
  assert.equal(keccak((await rpc("eth_getCode", [CONTRACTS.safeModuleSetup, "latest"])) as Hex), SAFE_MODULE_SETUP_CODE_HASH);
  ok("its code is the code that this app expects");

  step("1. A finished Chronobox with a guardian, and no recovery");
  const safe = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 0)))!;
  await sendAndWait(rpc, WALLET, lockTx(WALLET, safe, DAY));
  let state = await inspect(rpc, safe);
  const delay = state.delay!;
  const roles = state.roles!;
  await through(delay, WALLET, addGuardianTx({ safe, delay, roles, controller: WALLET }, GUARDIAN)!);
  await sendAndWait(rpc, WALLET, depositTx(safe, null, 2n * ETH));
  state = await inspect(rpc, safe);
  locked(state);
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  assert.equal(state.recovery, null);
  assert.equal(state.councilRecovery, false);
  const delayR = predictRecoveryDelay(safe);
  assert.ok(state.recoveryDelay && !state.recoveryDelay.deployed && sameAddress(state.recoveryDelay.delay, delayR));
  const plainCouncil = state.council!;
  assert.ok(sameAddress(plainCouncil, predictCouncil(safe, WALLET, GUARDIAN)));
  ok("locked, guardian, no recovery, the Recovery Delay is not made");
  const viaRoles = (to: Address, data: Hex, role: Hex) => ({
    to: roles,
    data: call("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)", [to, 0n, data, 0, role, true]),
  });

  step("2. Turn the recovery on: one item in the line, it waits like everything else");
  assert.equal(setRecoveryTx(partsOf(state), MIN_RECOVERY_WAIT - 1n), null);
  assert.equal(setRecoveryTx(partsOf(state), 731n * DAY), null);
  const setting = setRecoveryTx(partsOf(state), WAIT)!;
  assert.deepEqual(classify(setting, partsOf(state)), { kind: "set-recovery", wait: WAIT });
  assert.equal(classify({ ...setting, data: `${setting.data}00` as Hex }, partsOf(state)).kind, "unknown");
  await reverts(STRANGER, queueTx(delay, setting), "a stranger turns the recovery on");
  await reverts(GUARDIAN, queueTx(delay, setting), "the guardian turns the recovery on");
  // The Recovery Delay is made first. Anybody can make it, and the result is the same.
  const made = await sendAndWait(rpc, STRANGER, recoveryDelayCreateTx(safe));
  ok(`a stranger made the Recovery Delay (gas ${gas(made)})`);
  await reverts(STRANGER, recoveryDelayCreateTx(safe), "making the Recovery Delay a second time");
  state = await inspect(rpc, safe);
  locked(state);
  assert.equal(state.recovery, null);
  assert.ok(state.recoveryDelay!.deployed && state.recoveryDelay!.sound && state.recoveryDelay!.modules.length === 0);
  assert.ok(sameAddress(state.recoveryDelay!.target, safe));
  // Made or not made, the step is the same bytes.
  assert.deepEqual(setRecoveryTx(partsOf(state), WAIT), setting);
  // The guardian can cancel it, like everything in the line.
  await sendAndWait(rpc, WALLET, queueTx(delay, setting));
  await sendAndWait(rpc, GUARDIAN, cancelTx(roles, delay, state.queueNonce));
  ok("the guardian cancelled the first try");
  const applied = await through(delay, WALLET, setting);
  state = await inspect(rpc, safe);
  locked(state);
  assert.ok(state.recovery);
  assert.equal(state.recovery!.wait, WAIT);
  assert.equal(state.councilRecovery, true);
  assert.equal(state.councilMade, false);
  const council = predictCouncil(safe, WALLET, GUARDIAN, true);
  assert.ok(sameAddress(state.council, council) && !sameAddress(council, plainCouncil));
  same(state.recoveryDelay!.modules, [GUARDIAN]);
  assert.ok(sameAddress(state.recoveryDelay!.target, council) && sameAddress(state.recoveryDelay!.avatar, council));
  assert.ok(state.checks.some((c) => c.id === "recovery-wiring" && c.ok) && state.checks.some((c) => c.id === "recovery-stop" && c.ok));
  ok(`the recovery is on, it waits ${WAIT / DAY} days, and the Chronobox still passes every check (gas ${gas(applied)})`);
  await reverts(plainCouncil, viaRoles(delay, call("enableModule(address)", [STRANGER]), COUNCIL_ROLE), "the Council Safe of before uses its role");

  step("3. What the guardian can not do");
  const stealing = withdrawalTx(GUARDIAN, null, ETH);
  await reverts(GUARDIAN, queueTx(delay, stealing), "the guardian puts a withdrawal into the line of the Chronobox");
  await reverts(WALLET, queueTx(delayR, stealing), "the wallet puts something into the line of the recovery");
  await reverts(STRANGER, queueTx(delayR, stealing), "a stranger puts something into the line of the recovery");
  // The guardian can put anything into the line of the recovery. What is not a wallet change does nothing.
  const viaCouncil: DelayTx = { ...viaRoles(delay, call("execTransactionFromModule(address,uint256,bytes,uint8)", [GUARDIAN, ETH, "0x", 0]), COUNCIL_ROLE), value: 0n, operation: 0 };
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, stealing));
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, viaCouncil));
  await sendAndWait(rpc, STRANGER, councilCreateTx(safe, WALLET, GUARDIAN, true));
  state = await inspect(rpc, safe);
  locked(state);
  assert.equal(state.councilMade, true);
  same(await councilOwners(rpc, council), [WALLET, GUARDIAN]);
  let line = await readRecoveryLine(rpc, partsOf(state), await councilOwnersNow(rpc, partsOf(state), state.councilMade));
  assert.equal(line.length, 2);
  assert.ok(line.every((item) => item.wallet === null && item.tx !== null));
  ok("two things wait in the line of the recovery, and the app calls neither of them a recovery");
  const before = await rpc("evm_snapshot", []);
  await warp(WAIT + 60n);
  await reverts(STRANGER, executeTx(delayR, stealing), "after the wait: a payment out of the Council Safe, which holds nothing");
  await rpc("evm_revert", [before]);
  // The second one can only be tried when the first is gone.
  await sendAndWait(rpc, WALLET, cancelTx(roles, delayR, line[0].nonce));
  const before2 = await rpc("evm_snapshot", []);
  await warp(WAIT + 60n);
  await reverts(STRANGER, executeTx(delayR, viaCouncil), "after the wait: a withdrawal with the role of the Council Safe");
  await rpc("evm_revert", [before2]);
  state = await inspect(rpc, safe);
  await sendAndWait(rpc, WALLET, cancelAllTx(roles, delayR, state.recovery!)!);
  state = await inspect(rpc, safe);
  assert.equal(state.recovery!.txNonce, state.recovery!.queueNonce);
  assert.equal(await nativeBalance(rpc, safe), 2n * ETH);
  ok("the wallet emptied that line, and no money moved");

  step("4. The guardian starts a recovery, to a wallet that the guardian chooses");
  // The old wallet has a withdrawal in the line. The recovery takes it out.
  await sendAndWait(rpc, WALLET, queueTx(delay, withdrawalTx(WALLET, null, ETH)));
  state = await inspect(rpc, safe);
  const owners = await councilOwnersNow(rpc, partsOf(state), state.councilMade);
  for (const bad of [WALLET, GUARDIAN, council, safe, delay, roles, delayR, CONTRACTS.burn, null]) assert.equal(recoveryTx(partsOf(state), owners, bad, state.queueNonce), null, `to ${bad}`);
  assert.equal(recoveryTx({ ...partsOf(state), recoveryOn: false }, owners, NEW, state.queueNonce), null);
  const recovery = recoveryTx(partsOf(state), owners, NEW, state.queueNonce)!;
  await reverts(WALLET, queueTx(delayR, recovery), "the wallet starts a recovery");
  await reverts(STRANGER, queueTx(delayR, recovery), "a stranger starts a recovery");
  const started = await sendAndWait(rpc, GUARDIAN, queueTx(delayR, recovery));
  ok(`the guardian started it (gas ${gas(started)})`);
  state = await inspect(rpc, safe);
  locked(state);
  line = await readRecoveryLine(rpc, partsOf(state), owners);
  assert.equal(line.length, 1);
  assert.ok(sameAddress(line[0].wallet, NEW));
  ok("the app reads it back from the chain: a recovery to that wallet");
  await reverts(STRANGER, executeTx(delayR, recovery), "it runs before the wait is over");

  step("5. The wallet stops it, at once. So can the guardian");
  await sendAndWait(rpc, WALLET, cancelTx(roles, delayR, line[0].nonce));
  state = await inspect(rpc, safe);
  assert.equal((await readRecoveryLine(rpc, partsOf(state), owners)).length, 0);
  await warp(WAIT + 60n);
  await reverts(STRANGER, executeTx(delayR, recovery), "a stopped recovery, after the wait");
  ok("stopped by the wallet: it can never run");
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, recovery));
  state = await inspect(rpc, safe);
  await sendAndWait(rpc, GUARDIAN, cancelAllTx(roles, delayR, state.recovery!)!);
  ok("started again, and stopped by the guardian");
  await reverts(STRANGER, cancelTx(roles, delayR, 0n), "a stranger stops a recovery");

  step("6. Nobody stops it: after the wait, the Chronobox goes to the new wallet");
  state = await inspect(rpc, safe);
  const again = recoveryTx(partsOf(state), owners, NEW, state.queueNonce)!;
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, again));
  await warp(WAIT - DAY);
  await reverts(STRANGER, executeTx(delayR, again), "one day before the wait is over");
  await warp(DAY + 60n);
  const done = await sendAndWait(rpc, STRANGER, executeTx(delayR, again));
  state = await inspect(rpc, safe);
  locked(state);
  assert.ok(sameAddress(state.controller, NEW));
  assert.ok(sameAddress(state.guardian, GUARDIAN));
  assert.ok(sameAddress(state.council, council));
  same(await councilOwners(rpc, council), [NEW, GUARDIAN]);
  assert.ok(state.recovery, "the recovery stays on for the new wallet");
  assert.equal(state.txNonce, state.queueNonce, "what the old wallet had in the line is gone");
  assert.equal(await nativeBalance(rpc, safe), 2n * ETH);
  ok(`a stranger carried it out (gas ${gas(done)}). New wallet, same guardian, same money`);
  await reverts(WALLET, queueTx(delay, withdrawalTx(WALLET, null, ETH)), "the old wallet asks for a withdrawal");
  await reverts(WALLET, cancelTx(roles, delay, 0n), "the old wallet cancels");
  await through(delay, NEW, withdrawalTx(NEW, null, ETH));
  assert.equal(await nativeBalance(rpc, safe), ETH);
  ok("the new wallet withdraws, with the normal wait");

  step("7. Turning it off really ends it");
  state = await inspect(rpc, safe);
  const owners2 = await councilOwnersNow(rpc, partsOf(state), state.councilMade);
  // The guardian starts one more while the turning off waits.
  const off = removeRecoveryTx(partsOf(state))!;
  assert.deepEqual(classify(off, partsOf(state)), { kind: "remove-recovery" });
  await sendAndWait(rpc, NEW, queueTx(delay, off));
  const late = recoveryTx(partsOf(state), owners2, OTHER, state.queueNonce + 1n)!;
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, late));
  await warp(DAY + 60n);
  await sendAndWait(rpc, STRANGER, executeTx(delay, off));
  state = await inspect(rpc, safe);
  locked(state);
  assert.equal(state.recovery, null);
  assert.equal(state.recoveryDelay!.modules.length, 0);
  assert.ok(sameAddress(state.recoveryDelay!.target, safe));
  assert.equal(state.councilRecovery, true);
  await reverts(GUARDIAN, queueTx(delayR, late), "the guardian starts a recovery while it is off");
  const before3 = await rpc("evm_snapshot", []);
  await warp(WAIT + 60n);
  await reverts(STRANGER, executeTx(delayR, late), "the recovery that waited when it was turned off, after the wait");
  await rpc("evm_revert", [before3]);
  ok("off: nothing can start, and what waited can not run");

  step("8. On again: what waited before is thrown out, and the wait can be another one");
  const onAgain = setRecoveryTx(partsOf(state), 90n * DAY)!;
  assert.deepEqual(classify(onAgain, partsOf(state)), { kind: "set-recovery", wait: 90n * DAY });
  await through(delay, NEW, onAgain);
  state = await inspect(rpc, safe);
  locked(state);
  assert.equal(state.recovery!.wait, 90n * DAY);
  assert.equal(state.recovery!.txNonce, state.recovery!.queueNonce);
  const before4 = await rpc("evm_snapshot", []);
  await warp(90n * DAY + 60n);
  await reverts(STRANGER, executeTx(delayR, late), "the old recovery, after the recovery is on again");
  await rpc("evm_revert", [before4]);
  ok("on again, 90 days, and the line is empty");
  const longer = setRecoveryTx(partsOf(state), WAIT)!;
  assert.equal(longer.operation, 0);
  assert.deepEqual(classify(longer, partsOf(state)), { kind: "set-recovery", wait: WAIT });
  assert.equal(setRecoveryTx(partsOf(state), 90n * DAY), null);
  await through(delay, NEW, longer);
  state = await inspect(rpc, safe);
  locked(state);
  assert.equal(state.recovery!.wait, WAIT);
  ok("the wait changed to 180 days, with one step in the line");

  step("9. The wallet changes by the normal way: the recovery stays on, for the new Council Safe");
  const moving = changeWalletTx(delay, NEW, OTHER, roles, safe, { guardian: GUARDIAN, council: state.council!, members: state.members }, state.recoveryDelay);
  assert.deepEqual(classify(moving!, partsOf(state)), { kind: "change-wallet", to: OTHER });
  await through(delay, NEW, moving!);
  state = await inspect(rpc, safe);
  locked(state);
  const council2 = predictCouncil(safe, OTHER, GUARDIAN, true);
  assert.ok(sameAddress(state.controller, OTHER) && sameAddress(state.council, council2));
  assert.ok(state.recovery && state.councilRecovery && !state.councilMade);
  assert.ok(sameAddress(state.recoveryDelay!.target, council2));
  await reverts(council, viaRoles(delay, call("enableModule(address)", [STRANGER]), COUNCIL_ROLE), "the Council Safe of the wallet before uses its role");
  // And a recovery works there too, from a Council Safe that the guardian makes when it starts.
  const owners3 = await councilOwnersNow(rpc, partsOf(state), state.councilMade);
  const third = recoveryTx(partsOf(state), owners3, WALLET, state.queueNonce)!;
  await sendAndWait(rpc, GUARDIAN, councilCreateTx(safe, OTHER, GUARDIAN, true));
  await sendAndWait(rpc, GUARDIAN, queueTx(delayR, third));
  await warp(WAIT + 60n);
  await sendAndWait(rpc, STRANGER, executeTx(delayR, third));
  state = await inspect(rpc, safe);
  locked(state);
  assert.ok(sameAddress(state.controller, WALLET) && state.recovery);
  ok("new Council Safe, recovery on, and a recovery through it works");

  step("10. Something else than the guardian on the Recovery Delay is found");
  const before5 = await rpc("evm_snapshot", []);
  await through(delay, WALLET, { to: delayR, value: 0n, data: call("enableModule(address)", [STRANGER]), operation: 0 });
  state = await inspect(rpc, safe);
  assert.equal(state.state, "invalid");
  assert.ok(state.checks.some((c) => c.id === "recovery-wiring" && !c.ok));
  await rpc("evm_revert", [before5]);
  ok("a second address that can start a recovery makes the Chronobox fail its checks");

  step("11. Removing the guardian removes the recovery too");
  state = await inspect(rpc, safe);
  const leaving = removeGuardianTx(partsOf(state))!;
  assert.deepEqual(classify(leaving, partsOf(state)), { kind: "remove-guardian", guardian: GUARDIAN });
  await through(delay, WALLET, leaving);
  state = await inspect(rpc, safe);
  locked(state);
  assert.equal(state.guardian, null);
  assert.equal(state.recovery, null);
  assert.equal(state.recoveryDelay!.modules.length, 0);
  await reverts(GUARDIAN, queueTx(delayR, third), "the old guardian starts a recovery");
  await reverts(GUARDIAN, cancelTx(roles, delay, 0n), "the old guardian cancels");
  ok("no guardian, no recovery");

  step("12. A guardian and a recovery in one step");
  const base = { safe, delay, roles, controller: WALLET };
  const both = addGuardianTx(base, OTHER, { parts: state.recoveryDelay!, wait: 365n * DAY })!;
  assert.deepEqual(classify(both, { ...base, members: state.members, recoveryDelay: state.recoveryDelay }), { kind: "add-guardian", guardian: OTHER, recoveryWait: 365n * DAY });
  assert.deepEqual(classify(addGuardianTx(base, OTHER)!, { ...base, members: state.members, recoveryDelay: state.recoveryDelay }), { kind: "add-guardian", guardian: OTHER });
  await through(delay, WALLET, both);
  state = await inspect(rpc, safe);
  locked(state);
  for (const check of state.checks) console.log(`  ${check.ok ? "ok " : "BAD"} ${check.label} (${check.detail})`);
  assert.ok(sameAddress(state.guardian, OTHER));
  assert.equal(state.recovery!.wait, 365n * DAY);
  assert.ok(sameAddress(state.council, predictCouncil(safe, WALLET, OTHER, true)));
  await reverts(GUARDIAN, queueTx(delayR, third), "the guardian of before starts a recovery");
  const { queueNonce } = await delayNonces(rpc, delay);
  const fourth = recoveryTx(partsOf(state), [WALLET, OTHER], NEW, queueNonce)!;
  await sendAndWait(rpc, OTHER, queueTx(delayR, fourth));
  ok("the new guardian can start a recovery, and it waits 365 days");

  console.log("\nAll recovery checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
}
