import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRACTS } from "../src/lib/chains.ts";
import type { Address, Hex } from "../src/lib/hex.ts";
import {
  type RecoveryParts,
  changeWalletTx,
  classify,
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
const RECOVERY: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const OTHER: Address = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720";
const DAY = 86_400n;

const safe = predictSafe(WALLET, 0);
const delay = predictDelay(safe, DAY, 7n * DAY);
const roles = predictRoles(safe);
const council = predictCouncil(safe, WALLET, GUARDIAN);
const delayR = predictRecoveryDelay(safe);
const none: RecoveryParts = { delay: delayR, deployed: false, enabled: false, wired: false, sound: false, cooldown: 0n, expiration: 0n, txNonce: 0n, queueNonce: 0n };
const made: RecoveryParts = { ...none, deployed: true, enabled: true, wired: true, sound: true, cooldown: 30n * DAY, expiration: 30n * DAY };
const vault = (recoveryDelay: RecoveryParts, recoveryOn = false) => ({
  safe,
  delay,
  roles,
  controller: WALLET,
  guardian: GUARDIAN,
  council,
  members: [council, GUARDIAN, WALLET],
  modules: recoveryDelay.enabled ? [delayR, roles, delay] : [roles, delay],
  recoveryDelay,
  recoveryOn,
});

test("the recovery Delay has its own address, also when the delay is as long as its first wait", () => {
  assert.notEqual(delayR.toLowerCase(), delay.toLowerCase());
  assert.notEqual(delayR.toLowerCase(), predictDelay(safe, 90n * DAY, 30n * DAY).toLowerCase());
  assert.notEqual(delayR.toLowerCase(), predictRecoveryDelay(predictSafe(WALLET, 1)).toLowerCase());
});

test("a recovery is a wallet change to the recovery wallet, and nothing else", () => {
  const batch = recoveryTx(vault(none), RECOVERY)!;
  const change = changeWalletTx(delay, WALLET, RECOVERY, roles, safe, { guardian: GUARDIAN, council, members: [council, GUARDIAN, WALLET] })!;
  assert.equal(batch.to, CONTRACTS.multiSend);
  assert.equal(batch.operation, 1);
  assert.equal(batch.value, 0n);
  // The same calls as a wallet change, and one more: the guardian can not start it a second time.
  assert.ok(batch.data.length > change.data.length);
  for (const bad of [WALLET, GUARDIAN, council, safe, delay, roles, delayR, CONTRACTS.burn, null]) assert.equal(recoveryTx(vault(none), bad), null, `to ${bad}`);
});

test("setting a recovery is read back from the line, with its wallet and its wait", () => {
  for (const parts of [none, made, { ...made, enabled: false }]) {
    const tx = setRecoveryTx(vault(parts), RECOVERY, 90n * DAY)!;
    assert.deepEqual(classify(tx, vault(parts)), { kind: "set-recovery", wallet: RECOVERY, wait: 90n * DAY });
    // One byte more, and it is not something this app made.
    assert.equal(classify({ ...tx, data: `${tx.data}00` as Hex }, vault(parts)).kind, "unknown");
  }
  // The wait that is there already needs no change of the wait, and is still read back.
  const same = setRecoveryTx(vault(made), OTHER, 30n * DAY)!;
  assert.deepEqual(classify(same, vault(made)), { kind: "set-recovery", wallet: OTHER, wait: 30n * DAY });
});

test("a recovery is refused for a wait that is too short or too long, and for a Delay that is not sound", () => {
  assert.equal(setRecoveryTx(vault(none), RECOVERY, 60n), null);
  assert.equal(setRecoveryTx(vault(none), RECOVERY, 366n * DAY), null);
  assert.equal(setRecoveryTx(vault({ ...made, sound: false }), RECOVERY, 90n * DAY), null);
  assert.equal(setRecoveryTx({ ...vault(none), recoveryDelay: null }, RECOVERY, 90n * DAY), null);
});

test("turning the recovery off, and removing the guardian with a recovery, are read back from the line", () => {
  const off = removeRecoveryTx(vault(made, true))!;
  assert.deepEqual(classify(off, vault(made, true)), { kind: "remove-recovery" });
  const leaving = removeGuardianTx(vault(made, true))!;
  assert.deepEqual(classify(leaving, vault(made, true)), { kind: "remove-guardian", guardian: GUARDIAN });
  // With a recovery, removing the guardian does more: the recovery goes too.
  const plain = removeGuardianTx(vault(made, false))!;
  assert.ok(leaving.data.length > plain.data.length);
});
