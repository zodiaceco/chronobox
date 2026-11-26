// The alert service finds the guardian's parts and reads a recovery as the app makes them. It has its own copy of
// the address math and of the decoding, so this test holds the two together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { call } from "../src/lib/abi.ts";
import { CONTRACTS, ZERO } from "../src/lib/chains.ts";
import { type Address, concat, size, strip, uintWord } from "../src/lib/hex.ts";
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
import {
  predictCouncil as watcherCouncil,
  predictRecoveryDelay as watcherRecoveryDelay,
  readGuard,
  recoveryWallet,
} from "../watcher/src/guardian.ts";
import { replayQueue } from "../watcher/src/status.ts";
import { guardWarnings } from "../watcher/src/watcher.ts";
import type { Settings } from "../watcher/src/types.ts";

const WALLET: Address = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const GUARDIAN: Address = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";
const NEW: Address = "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f";
const DAY = 86400n;
const lower = (a: string) => a.toLowerCase();

const safe = predictSafe(WALLET, 0);
const delay = predictDelay(safe, DAY, EXPIRATION_SECONDS);
const roles = predictRoles(safe);
const recoveryDelay = predictRecoveryDelay(safe);

test("the watcher finds the Recovery Delay and the Council Safe at the addresses of the app", () => {
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
  assert.match(gone.detail, /The recovery turns off too/);
});

test("recoveryWallet rejects spoofed batches with modified middle calls or wrong council", () => {
  const real = councilSwapTx(guarded, [WALLET, GUARDIAN], NEW, 3n)!;
  const realLower = { ...real, to: lower(real.to), data: lower(real.data) };
  assert.equal(recoveryWallet(realLower, lower(delay), lower(roles), lower(council)), lower(NEW));
  assert.equal(recoveryWallet(realLower, lower(delay), lower(roles), lower(NEW)), null);

  // Build a spoofed 2-call batch with valid first and last calls (missing calls 1..7).
  const item = (to: Address, data: `0x${string}`) => "00" + strip(to) + uintWord(0n) + uintWord(size(data)) + strip(data);
  const firstCall = call("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)", [
    delay,
    0n,
    call("enableModule(address)", [NEW]),
    0,
    ("0x" + Buffer.from("council").toString("hex").padEnd(64, "0")) as `0x${string}`,
    true,
  ]);
  const lastCall = call("swapOwner(address,address,address)", [GUARDIAN, WALLET, NEW]);
  const spoof2 = {
    to: lower(CONTRACTS.multiSend),
    value: 0n,
    data: lower(call("multiSend(bytes)", [concat(item(roles, firstCall), item(council, lastCall))])),
    operation: 1,
  };
  assert.equal(recoveryWallet(spoof2, lower(delay), lower(roles), lower(council)), null);
});

test("readGuard rejects non-Safe contracts and propagates transient RPC errors", async () => {
  const fake = lower(NEW);
  const members = [lower(WALLET), lower(GUARDIAN), fake];
  // Fake contract returning [WALLET, GUARDIAN] with non-SafeProxy runtime code is rejected.
  const rejected = await readGuard(
    {
      code: async () => "0x600160005260206000f3",
      owners: async () => [lower(WALLET), lower(GUARDIAN)],
      threshold: async () => 2n,
      modules: async () => [],
    },
    lower(safe),
    lower(WALLET),
    members,
  );
  assert.equal(rejected, null);

  // Transient RPC error on code lookup propagates instead of returning null.
  await assert.rejects(
    readGuard(
      {
        code: async () => {
          throw new Error("429 too many requests");
        },
        owners: async () => [],
        threshold: async () => 2n,
        modules: async () => [],
      },
      lower(safe),
      lower(WALLET),
      [lower(WALLET), lower(GUARDIAN), lower(council)],
    ),
    /429/,
  );
});

test("guardWarnings catches hijacked recovery owner, guards, wrong council owners, zero cooldown, and avatar mismatch", () => {
  const attacker = lower(NEW);
  const base: Settings = {
    cooldown: String(DAY),
    expiration: String(7n * DAY),
    controllers: [lower(WALLET)],
    owner: lower(safe),
    avatar: lower(safe),
    target: lower(safe),
    safeModules: [lower(delay), lower(roles)],
    roles: lower(roles),
    rolesOwner: lower(safe),
    cancellers: [lower(WALLET), lower(GUARDIAN), lower(council)],
    guardian: lower(GUARDIAN),
    council: lower(council),
    councilOwners: [lower(WALLET), lower(GUARDIAN)],
    councilThreshold: "2",
    councilModules: [lower(recoveryDelay)],
    councilGuard: ZERO,
    recovery: {
      delay: lower(recoveryDelay),
      made: true,
      owner: lower(safe),
      avatar: lower(council),
      target: lower(council),
      guard: ZERO,
      modules: [lower(GUARDIAN)],
      cooldown: String(DEFAULT_RECOVERY_WAIT),
      expiration: String(30n * DAY),
    },
  };
  assert.deepEqual(guardWarnings(base, lower(safe)), []);
  assert.ok(guardWarnings({ ...base, recovery: { ...base.recovery!, owner: attacker, modules: [], target: lower(safe) } }, lower(safe)).some((w) => w.includes("controls the recovery settings")));
  assert.ok(guardWarnings({ ...base, recovery: { ...base.recovery!, guard: attacker } }, lower(safe)).some((w) => w.includes("attached to the recovery")));
  assert.ok(guardWarnings({ ...base, councilGuard: attacker }, lower(safe)).some((w) => w.includes("attached to the Council Safe")));
  assert.ok(guardWarnings({ ...base, councilOwners: [attacker, lower(GUARDIAN)] }, lower(safe)).some((w) => w.includes("does not need both")));
  assert.ok(guardWarnings({ ...base, recovery: { ...base.recovery!, cooldown: "0" } }, lower(safe)).some((w) => w.includes("has no wait")));
  assert.ok(guardWarnings({ ...base, recovery: { ...base.recovery!, avatar: lower(safe) } }, lower(safe)).some((w) => w.includes("does not point cleanly")));
});

test("describeTx rejects spoofed handover batches and warns on zero recovery wait", () => {
  const zeroWait = describe({ to: recoveryDelay, value: 0n, data: call("setTxCooldown(uint256)", [0n]), operation: 0 });
  assert.equal(zeroWait.kind, "recovery_wait");
  assert.equal(zeroWait.summary, "Remove the recovery wait");

  // Batch mixing delay.enableModule(NEW) with a call on the vault Safe must NOT be described as a plain handover.
  const item = (to: Address, data: `0x${string}`) => "00" + strip(to) + uintWord(0n) + uintWord(size(data)) + strip(data);
  const spoofHandover = {
    to: CONTRACTS.multiSend,
    value: 0n,
    data: call("multiSend(bytes)", [concat(item(delay, call("enableModule(address)", [NEW])), item(safe, call("enableModule(address)", [NEW])))]),
    operation: 1,
  };
  const d = describe(spoofHandover);
  assert.equal(d.kind, "call");
});

test("replayQueue isolates execSafes and ownerSafe across vault and council events", () => {
  const v = lower(safe);
  const c = lower(council);
  const rd = lower(recoveryDelay);
  const r = lower(roles);
  const cancelCall = call("setTxNonce(uint256)", [1n]);
  const events = [
    // Unrelated unknown delegatecall on council must NOT corrupt ownerSafe=vault replay.
    { kind: "call" as const, block: 100, index: 0, safe: c, module: lower(NEW), to: lower(NEW), value: 0n, data: "0x1234", operation: 1 },
    { kind: "result" as const, block: 100, index: 1, safe: c, module: lower(NEW), success: true },
    // Valid cancel from vault Safe via Roles.
    { kind: "call" as const, block: 101, index: 0, safe: v, module: r, to: rd, value: 0n, data: cancelCall, operation: 0 },
    { kind: "result" as const, block: 101, index: 1, safe: v, module: r, success: true },
  ];
  const reasons = replayQueue({
    from: 0,
    to: 1,
    events,
    delay: rd,
    execSafes: [c],
    ownerSafe: v,
    before: { cooldown: DEFAULT_RECOVERY_WAIT, expiration: 30n * DAY },
    after: { cooldown: DEFAULT_RECOVERY_WAIT, expiration: 30n * DAY },
    items: new Map([[0, { createdAt: 1000n }]]),
    timeOf: (b) => BigInt(b * 100),
    now: 20_000n,
  });
  assert.deepEqual(reasons.get(0), { how: "cancelled", block: 101, ts: 10_100n });
});
