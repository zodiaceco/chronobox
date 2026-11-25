import assert from "node:assert/strict";
import { test } from "node:test";
import { encode, selector, topic } from "../src/lib/abi.ts";
import { CONTRACTS, SENTINEL, ZERO } from "../src/lib/chains.ts";
import type { Address, Hex } from "../src/lib/hex.ts";
import {
  CANCEL_ROLE,
  COUNCIL_ROLE,
  DEFAULT_RECOVERY_WAIT,
  DELAY_PROXY_CODE,
  MIN_RECOVERY_WAIT,
  type DelayTx,
  type RecoveryParts,
  type Rpc,
  addGuardianTx,
  changeWalletTx,
  classify,
  councilCreateTx,
  councilSwapTx,
  delayTxHash,
  predictCouncil,
  predictDelay,
  predictRecoveryDelay,
  predictRoles,
  predictSafe,
  readRecoveryLine,
  recoveryParts,
  recoveryTx,
  removeGuardianTx,
  removeRecoveryTx,
  setRecoveryTx,
  verifyCancelPermission,
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

test("councilCreateTx builds distinct setup calldata for plain vs recovery shared Safes", () => {
  const plainTx = councilCreateTx(safe, WALLET, GUARDIAN, false);
  const recTx = councilCreateTx(safe, WALLET, GUARDIAN, true);
  assert.notEqual(plainTx.data, recTx.data);
  assert.ok(recTx.data.toLowerCase().includes(CONTRACTS.safeModuleSetup.slice(2).toLowerCase()));
  assert.ok(recTx.data.toLowerCase().includes(delayR.slice(2).toLowerCase()));
  assert.ok(!plainTx.data.toLowerCase().includes(CONTRACTS.safeModuleSetup.slice(2).toLowerCase()));
});

test("verifyCancelPermission requires ScopeTarget and AllowFunction for stopsRecovery", async () => {
  const setTxNonce = selector("setTxNonce(uint256)");
  const baseLogs = [
    { address: roles, topics: [topic("RolesModSetup(address,address,address,address)")], data: "0x", blockNumber: "0x10" },
    { address: roles, topics: [topic("ScopeTarget(bytes32,address)")], data: encode(["bytes32", "address"], [CANCEL_ROLE, delay]), blockNumber: "0x10" },
    { address: roles, topics: [topic("AllowFunction(bytes32,address,bytes4,uint8)")], data: encode(["bytes32", "address", "bytes4", "uint8"], [CANCEL_ROLE, delay, setTxNonce, 0n]), blockNumber: "0x10" },
    { address: roles, topics: [topic("ScopeTarget(bytes32,address)")], data: encode(["bytes32", "address"], [COUNCIL_ROLE, delay]), blockNumber: "0x11" },
    { address: roles, topics: [topic("AllowFunction(bytes32,address,bytes4,uint8)")], data: encode(["bytes32", "address", "bytes4", "uint8"], [COUNCIL_ROLE, delay, selector("enableModule(address)"), 0n]), blockNumber: "0x11" },
    { address: roles, topics: [topic("AllowFunction(bytes32,address,bytes4,uint8)")], data: encode(["bytes32", "address", "bytes4", "uint8"], [COUNCIL_ROLE, delay, selector("disableModule(address,address)"), 0n]), blockNumber: "0x11" },
    { address: roles, topics: [topic("ScopeTarget(bytes32,address)")], data: encode(["bytes32", "address"], [COUNCIL_ROLE, roles]), blockNumber: "0x11" },
    { address: roles, topics: [topic("AllowFunction(bytes32,address,bytes4,uint8)")], data: encode(["bytes32", "address", "bytes4", "uint8"], [COUNCIL_ROLE, roles, selector("assignRoles(address,bytes32[],bool[])"), 0n]), blockNumber: "0x11" },
    { address: roles, topics: [topic("AllowFunction(bytes32,address,bytes4,uint8)")], data: encode(["bytes32", "address", "bytes4", "uint8"], [COUNCIL_ROLE, roles, selector("disableModule(address,address)"), 0n]), blockNumber: "0x11" },
    { address: roles, topics: [topic("AssignRoles(address,bytes32[],bool[])")], data: encode(["address", "bytes32[]", "bool[]"], [WALLET, [CANCEL_ROLE], [true]]), blockNumber: "0x10" },
    { address: roles, topics: [topic("AssignRoles(address,bytes32[],bool[])")], data: encode(["address", "bytes32[]", "bool[]"], [GUARDIAN, [CANCEL_ROLE], [true]]), blockNumber: "0x11" },
    { address: roles, topics: [topic("AssignRoles(address,bytes32[],bool[])")], data: encode(["address", "bytes32[]", "bool[]"], [shared, [COUNCIL_ROLE], [true]]), blockNumber: "0x11" },
  ];
  const allowOnly = { address: roles, topics: [topic("AllowFunction(bytes32,address,bytes4,uint8)")], data: encode(["bytes32", "address", "bytes4", "uint8"], [CANCEL_ROLE, delayR, setTxNonce, 0n]), blockNumber: "0x12" };
  const scopeRec = { address: roles, topics: [topic("ScopeTarget(bytes32,address)")], data: encode(["bytes32", "address"], [CANCEL_ROLE, delayR]), blockNumber: "0x12" };
  const guard = { guardian: GUARDIAN, council: shared };
  const rpcOf = (logs: any[]): Rpc => async (method) => {
    if (method === "eth_getLogs") return logs;
    throw new Error(`unexpected ${method}`);
  };

  // AllowFunction without ScopeTarget does NOT count as stopsRecovery.
  const missingScope = await verifyCancelPermission(rpcOf([...baseLogs, allowOnly]), roles, delay, WALLET, undefined, guard, delayR);
  assert.equal(missingScope?.ok, true);
  assert.equal(missingScope?.stopsRecovery, false);

  // Both ScopeTarget and AllowFunction prove stopsRecovery.
  const full = await verifyCancelPermission(rpcOf([...baseLogs, scopeRec, allowOnly]), roles, delay, WALLET, undefined, guard, delayR);
  assert.equal(full?.ok, true);
  assert.equal(full?.stopsRecovery, true);
});

test("recoveryParts marks sound=false when owner, guard, or module count (>10) is tampered", async () => {
  const makeRpc = (opts: { owner?: Address; guard?: Address; next?: Address; modules?: Address[] }): Rpc => async (method, params) => {
    if (method === "eth_getCode") return DELAY_PROXY_CODE;
    if (method === "eth_call") {
      const data = ((params?.[0] as { data: Hex }).data).slice(0, 10).toLowerCase();
      if (data === selector("owner()")) return encode(["address"], [opts.owner ?? safe]);
      if (data === selector("avatar()")) return encode(["address"], [shared]);
      if (data === selector("target()")) return encode(["address"], [shared]);
      if (data === selector("getGuard()")) return encode(["address"], [opts.guard ?? ZERO]);
      if (data === selector("txCooldown()")) return encode(["uint256"], [DEFAULT_RECOVERY_WAIT]);
      if (data === selector("txExpiration()")) return encode(["uint256"], [30n * DAY]);
      if (data === selector("txNonce()")) return encode(["uint256"], [0n]);
      if (data === selector("queueNonce()")) return encode(["uint256"], [0n]);
      if (data === selector("getModulesPaginated(address,uint256)")) return encode(["address[]", "address"], [opts.modules ?? [GUARDIAN], opts.next ?? SENTINEL]);
    }
    throw new Error(`unexpected ${method}`);
  };

  assert.equal((await recoveryParts(makeRpc({}), safe)).sound, true);
  assert.equal((await recoveryParts(makeRpc({ owner: NEW }), safe)).sound, false);
  assert.equal((await recoveryParts(makeRpc({ guard: NEW }), safe)).sound, false);
  const overflow = await recoveryParts(makeRpc({ next: NEW, modules: [GUARDIAN] }), safe);
  assert.equal(overflow.sound, false);
  assert.deepEqual(overflow.modules, []);
});

test("readRecoveryLine reuses txCache and known items without scanning logs", async () => {
  const owners = [WALLET, GUARDIAN];
  const tx0 = recoveryTx(live, owners, NEW, 0n)!;
  const tx1 = recoveryTx(live, owners, NEW, 1n)!;
  const hashes = [delayTxHash(tx0), delayTxHash(tx1)];
  const times = [1_000n, 2_000n];
  let logCalls = 0;
  const rpc: Rpc = async (method, params) => {
    if (method === "eth_getLogs") {
      logCalls++;
      return [];
    }
    if (method === "eth_call") {
      const data = (params?.[0] as { data: Hex }).data;
      const fn = data.slice(0, 10).toLowerCase();
      const nonce = Number(BigInt("0x" + data.slice(10)));
      if (fn === selector("getTxCreatedAt(uint256)")) return encode(["uint256"], [times[nonce]]);
      if (fn === selector("getTxHash(uint256)")) return encode(["bytes32"], [hashes[nonce]]);
    }
    throw new Error(`unexpected ${method}`);
  };

  const cached = new Map<string, DelayTx>([[`0:${hashes[0]}`, tx0], [`1:${hashes[1]}`, tx1]]);
  const cache = {
    get: (nonce: bigint, hash: Hex) => cached.get(`${nonce}:${hash}`) ?? null,
    set: (nonce: bigint, hash: Hex, tx: DelayTx) => void cached.set(`${nonce}:${hash}`, tx),
  };
  const withTwo = { ...live, recoveryDelay: { ...on, txNonce: 0n, queueNonce: 2n } };
  const first = await readRecoveryLine(rpc, withTwo, owners, cache);
  assert.equal(logCalls, 0);
  assert.equal(first.length, 2);
  assert.equal(first[0].wallet, NEW);
  assert.equal(first[1].wallet, NEW);

  // Passing `known` skips even the RPC getTxCreatedAt/getTxHash calls.
  const noRpc: Rpc = async (method) => {
    throw new Error(`should not call ${method}`);
  };
  const second = await readRecoveryLine(noRpc, withTwo, owners, undefined, { known: first });
  assert.equal(second.length, 2);
  assert.equal(second[0].wallet, NEW);
  assert.equal(second[1].wallet, NEW);
});
