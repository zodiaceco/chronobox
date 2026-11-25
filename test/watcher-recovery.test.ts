// The alert service finds the guardian's parts and reads a recovery as the app makes them. It has its own copy of
// the address math and of the decoding, so this test holds the two together.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "../src/lib/hex.ts";
import {
  DEFAULT_RECOVERY_WAIT,
  type RecoveryParts,
  addGuardianTx,
  councilSwapTx,
  predictCouncil,
  predictDelay,
  predictRecoveryDelay,
  predictRoles,
  predictSafe,
  removeGuardianTx,
  removeRecoveryTx,
  setRecoveryTx,
  EXPIRATION_SECONDS,
} from "../src/lib/chronobox.ts";
import { describeTx } from "../watcher/src/describe.ts";
import { predictCouncil as watcherCouncil, predictRecoveryDelay as watcherRecoveryDelay, recoveryWallet } from "../watcher/src/guardian.ts";

const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const NEW: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const DAY = 86400n;
const lower = (a: string) => a.toLowerCase();

const safe = predictSafe(WALLET, 0);
const delay = predictDelay(safe, DAY, EXPIRATION_SECONDS);
const roles = predictRoles(safe);
const recoveryDelay = predictRecoveryDelay(safe);

test("the watcher finds the recovery Delay and the shared Safe at the addresses of the app", () => {
  for (const index of [0, 1, 7]) {
    const vault = predictSafe(WALLET, index);
    assert.equal(watcherRecoveryDelay(lower(vault)), lower(predictRecoveryDelay(vault)));
    for (const withRecovery of [false, true]) {
      assert.equal(
        watcherCouncil(lower(vault), lower(WALLET), lower(GUARDIAN), withRecovery),
        lower(predictCouncil(vault, WALLET, GUARDIAN, withRecovery)),
      );
    }
  }
});

const parts: RecoveryParts = {
  delay: recoveryDelay, deployed: true, sound: true, owner: safe, avatar: safe, target: safe, modules: [],
  cooldown: DEFAULT_RECOVERY_WAIT, expiration: 30n * DAY, txNonce: 0n, queueNonce: 0n,
} as RecoveryParts;
const council = predictCouncil(safe, WALLET, GUARDIAN, true);
const guarded = {
  safe, delay, roles, controller: WALLET, guardian: GUARDIAN, council, members: [council, GUARDIAN, WALLET],
  recoveryDelay: { ...parts, avatar: council, target: council, modules: [GUARDIAN] }, recoveryOn: true, councilRecovery: true,
};
const ctx = {
  chainId: 1, delay: lower(delay), vault: lower(safe), controllers: [lower(WALLET)], roles: lower(roles),
  cooldown: DAY, recoveryDelay: lower(recoveryDelay), recoveryWait: DEFAULT_RECOVERY_WAIT,
};
const describe = (tx: { to: string; value: bigint; data: string; operation: number }) =>
  describeTx({ ...tx, to: lower(tx.to), data: lower(tx.data) }, ctx);

test("a recovery of the app names its new wallet; anything else in that line does not", () => {
  const tx = councilSwapTx(guarded, [WALLET, GUARDIAN], NEW, 3n)!;
  assert.equal(recoveryWallet({ ...tx, to: lower(tx.to), data: lower(tx.data) }, lower(delay), lower(roles)), lower(NEW));
  // The same batch for the wrong Delay, or with its last call cut off, is no recovery.
  assert.equal(recoveryWallet({ ...tx, to: lower(tx.to), data: lower(tx.data) }, lower(recoveryDelay), lower(roles)), null);
  assert.equal(recoveryWallet({ to: lower(delay), value: 0n, data: "0x", operation: 0 }, lower(delay), lower(roles)), null);
});

test("the steps of the app that change the recovery are named in the alert", () => {
  const base = { safe, delay, roles, controller: WALLET };
  const withRecovery = describe(addGuardianTx(base, GUARDIAN, { parts, wait: 365n * DAY })!);
  assert.equal(withRecovery.kind, "guardian_add");
  assert.match(withRecovery.summary, /^Add the guardian 0x14dC.* with a recovery$/i);
  assert.match(withRecovery.detail, /A recovery waits 365 days/);
  const plain = describe(addGuardianTx(base, GUARDIAN)!);
  assert.equal(plain.kind, "guardian_add");
  assert.doesNotMatch(plain.summary, /recovery/);

  const plainCouncil = predictCouncil(safe, WALLET, GUARDIAN, false);
  const on = describe(setRecoveryTx({ ...guarded, council: plainCouncil, members: [plainCouncil, GUARDIAN, WALLET], recoveryDelay: parts, recoveryOn: false, councilRecovery: false }, 90n * DAY)!);
  assert.deepEqual([on.kind, on.summary], ["recovery_on", "Turn on the recovery"]);
  assert.match(on.detail, /A recovery waits 90 days/);

  const longer = describe(setRecoveryTx(guarded, 365n * DAY)!);
  assert.deepEqual([longer.kind, longer.summary], ["recovery_wait", "Change the recovery wait to 365 days"]);
  assert.match(longer.detail, /It is 180 days now/);

  const off = describe(removeRecoveryTx(guarded)!);
  assert.deepEqual([off.kind, off.summary], ["recovery_off", "Turn off the recovery"]);

  const gone = describe(removeGuardianTx(guarded)!);
  assert.equal(gone.kind, "guardian_remove");
  assert.match(gone.detail, /The recovery goes too/);
});
