import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACTS } from "../src/lib/chains.ts";
import type { Address, Hex } from "../src/lib/hex.ts";
import {
  DEFAULT_RECOVERY_WAIT,
  MIN_RECOVERY_WAIT,
  type RecoveryParts,
  addGuardianTx,
  changeWalletTx,
  classify,
  councilSwapTx,
  predictCouncil,
  predictDelay,
  predictRecoveryDelay,
  predictRoles,
  predictSafe,
  recoveryTx,
  removeGuardianTx,
  removeRecoveryTx,
  setRecoveryTx,
} from "../src/lib/chronobox.ts";

const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const NEW: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const DAY = 86_400n;

const safe = predictSafe(WALLET, 0);
const delay = predictDelay(safe, DAY, 7n * DAY);
const roles = predictRoles(safe);
const plain = predictCouncil(safe, WALLET, GUARDIAN);
const shared = predictCouncil(safe, WALLET, GUARDIAN, true);
const delayR = predictRecoveryDelay(safe);

/** Not made yet. */
const none: RecoveryParts = { delay: delayR, deployed: false, sound: true, avatar: safe, target: safe, modules: [], cooldown: DEFAULT_RECOVERY_WAIT, expiration: 30n * DAY, txNonce: 0n, queueNonce: 0n };
/** Made, and nobody can use it. */
const made: RecoveryParts = { ...none, deployed: true };
/** On: it acts on the shared Safe, and the guardian can use it. */
const on: RecoveryParts = { ...made, avatar: shared, target: shared, modules: [GUARDIAN] };

const off = (recoveryDelay: RecoveryParts) => ({ safe, delay, roles, controller: WALLET, guardian: GUARDIAN, council: plain, members: [plain, GUARDIAN, WALLET], recoveryDelay, recoveryOn: false, councilRecovery: false });
const live = { safe, delay, roles, controller: WALLET, guardian: GUARDIAN, council: shared, members: [shared, GUARDIAN, WALLET], recoveryDelay: on, recoveryOn: true, councilRecovery: true };

test("the recovery Delay and the shared Safe of a recovery have their own addresses", () => {
  assert.notEqual(delayR.toLowerCase(), delay.toLowerCase());
  assert.notEqual(delayR.toLowerCase(), predictDelay(safe, DEFAULT_RECOVERY_WAIT, 30n * DAY).toLowerCase());
  assert.notEqual(delayR.toLowerCase(), predictRecoveryDelay(predictSafe(WALLET, 1)).toLowerCase());
  assert.notEqual(shared.toLowerCase(), plain.toLowerCase());
  assert.notEqual(shared.toLowerCase(), predictCouncil(predictSafe(WALLET, 1), WALLET, GUARDIAN, true).toLowerCase());
});

test("turning the recovery on is the same step before and after the recovery Delay is made", () => {
  const first = setRecoveryTx(off(none), DEFAULT_RECOVERY_WAIT)!;
  assert.equal(first.to, CONTRACTS.multiSend);
  assert.equal(first.operation, 1);
  assert.deepEqual(setRecoveryTx(off(made), DEFAULT_RECOVERY_WAIT), first);
  for (const parts of [none, made]) {
    for (const wait of [MIN_RECOVERY_WAIT, DEFAULT_RECOVERY_WAIT, 365n * DAY]) {
      const tx = setRecoveryTx(off(parts), wait)!;
      assert.deepEqual(classify(tx, off(parts)), { kind: "set-recovery", wait });
      // One byte more, and it is not something this app made.
      assert.equal(classify({ ...tx, data: `${tx.data}00` as Hex }, off(parts)).kind, "unknown");
    }
  }
});

test("the recovery is refused for a wait that is too short or too long, and for a Delay that somebody can already use", () => {
  assert.equal(setRecoveryTx(off(none), MIN_RECOVERY_WAIT - 1n), null);
  assert.equal(setRecoveryTx(off(none), 731n * DAY), null);
  assert.equal(setRecoveryTx(off({ ...made, sound: false }), DEFAULT_RECOVERY_WAIT), null);
  assert.equal(setRecoveryTx(off({ ...made, modules: [NEW] }), DEFAULT_RECOVERY_WAIT), null);
  assert.equal(setRecoveryTx({ ...off(none), recoveryDelay: null }, DEFAULT_RECOVERY_WAIT), null);
});

test("what waited in the line of a recovery that was turned off is thrown out when it goes on again", () => {
  const clean = setRecoveryTx(off(made), DEFAULT_RECOVERY_WAIT)!;
  const dirty = setRecoveryTx(off({ ...made, txNonce: 1n, queueNonce: 3n }), DEFAULT_RECOVERY_WAIT)!;
  assert.ok(dirty.data.length > clean.data.length);
});

test("with the recovery on, another wait is one call, and the same wait is nothing", () => {
  const tx = setRecoveryTx(live, 90n * DAY)!;
  assert.equal(tx.operation, 0);
  assert.equal(tx.to, delayR);
  assert.deepEqual(classify(tx, live), { kind: "set-recovery", wait: 90n * DAY });
  assert.equal(setRecoveryTx(live, DEFAULT_RECOVERY_WAIT), null);
});

test("a recovery is the wallet change of the shared Safe, and only with the recovery on", () => {
  const owners = [WALLET, GUARDIAN];
  assert.deepEqual(recoveryTx(live, owners, NEW, 4n), councilSwapTx(live, owners, NEW, 4n));
  assert.equal(recoveryTx({ ...live, recoveryOn: false }, owners, NEW, 4n), null);
  for (const bad of [WALLET, GUARDIAN, shared, safe, delay, roles, delayR, CONTRACTS.burn, null]) assert.equal(recoveryTx(live, owners, bad, 4n), null, `to ${bad}`);
});

test("turning it off, removing the guardian, and a wallet change are read back from the line", () => {
  const turnOff = removeRecoveryTx(live)!;
  assert.deepEqual(classify(turnOff, live), { kind: "remove-recovery" });
  const leaving = removeGuardianTx(live)!;
  assert.deepEqual(classify(leaving, live), { kind: "remove-guardian", guardian: GUARDIAN });
  // With a recovery, removing the guardian does more: the recovery goes too.
  assert.ok(leaving.data.length > removeGuardianTx({ ...live, recoveryOn: false })!.data.length);
  // A wallet change keeps the recovery: the new shared Safe is one with the recovery Delay.
  const moving = changeWalletTx(delay, WALLET, NEW, roles, safe, { guardian: GUARDIAN, council: shared, members: live.members }, on)!;
  assert.deepEqual(classify(moving, live), { kind: "change-wallet", to: NEW });
  assert.ok(moving.data.toLowerCase().includes(predictCouncil(safe, NEW, GUARDIAN, true).slice(2).toLowerCase()));
  assert.ok(!moving.data.toLowerCase().includes(predictCouncil(safe, NEW, GUARDIAN).slice(2).toLowerCase()));
});

test("a guardian with a recovery is one step, and it is read back with its wait", () => {
  const base = { safe, delay, roles, controller: WALLET };
  const view = { ...base, members: [WALLET], recoveryDelay: none };
  const both = addGuardianTx(base, GUARDIAN, { parts: none, wait: 365n * DAY })!;
  assert.deepEqual(classify(both, view), { kind: "add-guardian", guardian: GUARDIAN, recoveryWait: 365n * DAY });
  const alone = addGuardianTx(base, GUARDIAN)!;
  assert.deepEqual(classify(alone, view), { kind: "add-guardian", guardian: GUARDIAN });
  assert.ok(both.data.length > alone.data.length);
  assert.equal(addGuardianTx(base, delayR), null);
  assert.equal(addGuardianTx(base, GUARDIAN, { parts: none, wait: DAY }), null);
});
