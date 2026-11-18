/**
 * End-to-end proof against the real contracts on a local fork.
 *
 *   npm run fork        (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork
 *
 * The script takes a snapshot first and reverts to it at the end, so it
 * can run again and again and leaves the fork as it found it.
 */
import assert from "node:assert/strict";
import { call, decode } from "../src/lib/abi.ts";
import { CONTRACTS, SENTINEL, ZERO } from "../src/lib/chains.ts";
import { type Address, type Hex, concat, keccak, sameAddress, toBigInt, uintWord, word } from "../src/lib/hex.ts";
import {
  type BlockHints,
  CANCEL_ROLE,
  DELAY_PROXY_CODE,
  ROLES_PROXY_CODE,
  cancelTx,
  predictRoles,
  rolesInitializer,
  EXPIRATION_SECONDS,
  changeDelayTx,
  changeWalletTx,
  delayInitializer,
  ownerBatchTx,
  setupCalls,
  type Rpc,
  SAFE_PROXY_CODE_HASH,
  SAFE_PROXY_INIT_CODE_HASH,
  chainTime,
  classify,
  createTx,
  delayTxHash,
  depositTx,
  discover,
  executeTx,
  inspect,
  itemStatus,
  lockTx,
  nativeBalance,
  predictDelay,
  predictSafe,
  queueTx,
  queuedInReceipt,
  readQueue,
  readToken,
  safeFromReceipt,
  sendAndWait,
  skipExpiredTx,
  tokenBalance,
  withdrawalTx,
} from "../src/lib/chronobox.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 3 and 4. The dev wallet in the browser uses accounts 0 to 2,
// so this test and a browser session can share one fork.
const WALLET: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const STRANGER: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WEEK = 7n * 24n * 3600n;
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

const snapshot = await rpc("evm_snapshot", []);
try {
  // On mainnet the well-known anvil keys carry EIP-7702 delegations to sweeper
  // contracts. Clear them so that the test wallets behave like fresh wallets.
  for (const account of [WALLET, STRANGER]) await rpc("anvil_setCode", [account, "0x"]);

  step("0. Pinned code");
  assert.equal(toBigInt(await rpc("eth_chainId", [])), 1n);
  for (const [name, address] of Object.entries(CONTRACTS)) {
    const code = (await rpc("eth_getCode", [address, "latest"])) as Hex;
    if (name === "burn") assert.equal(code, "0x", "the burn address must have no code");
    else assert.ok(code.length > 2, `${name} has no code`);
  }
  ok("all contracts exist, the burn address has no code");
  const [creationCode] = decode(["bytes"], await rpc("eth_call", [{ to: CONTRACTS.safeProxyFactory, data: call("proxyCreationCode()") }, "latest"]));
  const initCodeHash = keccak(concat(creationCode as Hex, word(CONTRACTS.safeSingleton)));
  assert.equal(SAFE_PROXY_INIT_CODE_HASH, initCodeHash, `pin SAFE_PROXY_INIT_CODE_HASH = ${initCodeHash}`);
  ok("Safe proxy init code hash matches the factory");

  step("1. Create");
  const predicted = predictSafe(WALLET, 0);
  assert.equal(await rpc("eth_getCode", [predicted, "latest"]), "0x", "index 0 is already used on this fork");
  const created = await sendAndWait(rpc, WALLET, createTx(WALLET, 0));
  const safe = safeFromReceipt(created)!;
  assert.equal(safe, predicted, "predicted Safe address");
  ok(`Safe ${safe} is at the predicted address`);
  const runtimeHash = keccak((await rpc("eth_getCode", [safe, "latest"])) as Hex);
  assert.equal(SAFE_PROXY_CODE_HASH, runtimeHash, `pin SAFE_PROXY_CODE_HASH = ${runtimeHash}`);
  ok("Safe proxy runtime code hash matches");
  let state = await inspect(rpc, safe);
  assert.equal(state.state, "open");
  assert.ok(sameAddress(state.owners[0], WALLET));
  ok("inspection says: open (not locked yet)");
  assert.deepEqual(await discover(rpc, WALLET), [{ index: 0, safe }]);
  ok("discovery finds the vault from the wallet address");

  step("2. Lock");
  // A stranger cannot lock somebody else's Safe.
  await reverts(STRANGER, lockTx(STRANGER, safe, WEEK), /GS026|GS025/, "a stranger sends the lock transaction");
  const locked = await sendAndWait(rpc, WALLET, lockTx(WALLET, safe, WEEK));
  console.log(`  gas used by the lock transaction: ${toBigInt((locked as any).gasUsed)}`);
  state = await inspect(rpc, safe);
  for (const check of state.checks) console.log(`  ${check.ok ? "ok " : "BAD"} ${check.label} (${check.detail})`);
  assert.equal(state.state, "locked");
  const delay = state.delay!;
  assert.equal(delay, predictDelay(safe, WEEK, EXPIRATION_SECONDS), "predicted Delay address");
  assert.equal(await rpc("eth_getCode", [delay, "latest"]), DELAY_PROXY_CODE);
  assert.ok(sameAddress(state.controller, WALLET));
  assert.equal(state.cooldown, WEEK);
  assert.equal(state.expiration, EXPIRATION_SECONDS);
  ok("inspection says: locked, 7 days, controller is the wallet");

  const roles = state.roles!;
  assert.equal(roles, predictRoles(safe), "predicted Roles address");
  assert.equal(await rpc("eth_getCode", [roles, "latest"]), ROLES_PROXY_CODE);
  ok("the cancel permission is in place and proven from the event history");

  step("3. Nobody can act as owner");
  const execAs = (signer: Address, v: string, inner: { to: Address; data: Hex }) => ({
    to: safe,
    data: call("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", [
      inner.to,
      0n,
      inner.data,
      0,
      0n,
      0n,
      0n,
      ZERO,
      ZERO,
      v === "contract" ? concat(word(signer), uintWord(65n), "00", uintWord(0n)) : concat(word(signer), uintWord(0n), v),
    ]),
  });
  const takeover = { to: safe, data: call("enableModule(address)", [WALLET]) };
  await reverts(WALLET, execAs(WALLET, "01", takeover), /GS026/, "the old owner sends a Safe transaction");
  await reverts(WALLET, execAs(CONTRACTS.burn, "01", takeover), /GS025/, "claiming a pre-approved hash for the burn owner");
  await reverts(WALLET, execAs(CONTRACTS.burn, "contract", takeover), null, "a contract signature for the burn owner");
  await reverts(WALLET, execAs(CONTRACTS.burn, "1b", takeover), /GS026/, "a random ECDSA signature");
  await reverts(WALLET, execAs(CONTRACTS.burn, "1f", takeover), /GS026/, "a random eth_sign signature");
  await reverts(WALLET, takeover, /GS031/, "calling enableModule on the Safe directly");
  await reverts(WALLET, { to: delay, data: call("setTxCooldown(uint256)", [0n]) }, null, "the wallet sets the delay to zero directly");
  await reverts(WALLET, { to: delay, data: call("setTxNonce(uint256)", [1n]) }, null, "the wallet skips the queue directly");
  await reverts(WALLET, { to: delay, data: call("enableModule(address)", [STRANGER]) }, null, "the wallet adds a controller directly");
  await reverts(
    WALLET,
    { to: safe, data: call("execTransactionFromModule(address,uint256,bytes,uint8)", [WALLET, 1n, "0x", 0]) },
    /GS104/,
    "the wallet calls the Safe as a module",
  );

  step("3b. Through Roles the wallet can cancel and nothing else");
  const viaRoles = (to: Address, data: Hex, operation = 0, value = 0n, role: Hex = CANCEL_ROLE) => ({
    to: roles,
    data: call("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)", [to, value, data, operation, role, true]),
  });
  await reverts(WALLET, viaRoles(delay, call("setTxCooldown(uint256)", [0n])), null, "set the delay to zero through Roles");
  await reverts(WALLET, viaRoles(delay, call("enableModule(address)", [WALLET])), null, "add a controller through Roles");
  await reverts(WALLET, viaRoles(safe, call("enableModule(address)", [WALLET])), null, "add a Safe module through Roles");
  await reverts(WALLET, viaRoles(WALLET, "0x", 0, 1n), null, "send ETH through Roles");
  await reverts(WALLET, viaRoles(delay, call("setTxNonce(uint256)", [1n]), 1), null, "cancel as a delegatecall");
  await reverts(WALLET, viaRoles(delay, call("setTxNonce(uint256)", [1n]), 0, 0n, ("0x" + "00".repeat(32)) as Hex), null, "use another role");
  await reverts(WALLET, { to: roles, data: call("assignRoles(address,bytes32[],bool[])", [STRANGER, [CANCEL_ROLE], [true]]) }, null, "change the roles directly");
  await reverts(WALLET, { to: roles, data: call("allowTarget(bytes32,address,uint8)", [CANCEL_ROLE, safe, 3]) }, null, "widen the permission directly");
  await reverts(WALLET, { to: roles, data: call("transferOwnership(address)", [WALLET]) }, null, "take ownership of Roles");
  await reverts(STRANGER, cancelTx(roles, delay, 0n), null, "a stranger cancels");

  step("4. Deposit");
  await sendAndWait(rpc, WALLET, depositTx(safe, null, 5n * ETH));
  // Wrap 3 ETH so that the wallet has a token to deposit.
  await sendAndWait(rpc, WALLET, { to: WETH, data: "0x", value: 3n * ETH });
  await sendAndWait(rpc, WALLET, depositTx(safe, WETH, 3n * ETH));
  assert.equal(await nativeBalance(rpc, safe), 5n * ETH);
  assert.equal(await tokenBalance(rpc, WETH, safe), 3n * ETH);
  assert.deepEqual(await readToken(rpc, WETH), { symbol: "WETH", decimals: 18 });
  ok("the vault holds 5 ETH and 3 WETH");

  step("5. Queue two withdrawals");
  await reverts(STRANGER, queueTx(delay, withdrawalTx(STRANGER, null, ETH)), null, "a stranger queues a withdrawal");
  const ethOut = withdrawalTx(WALLET, null, ETH);
  const wethOut = withdrawalTx(WALLET, WETH, 2n * ETH);
  const queued = await sendAndWait(rpc, WALLET, queueTx(delay, ethOut));
  assert.deepEqual(queuedInReceipt(queued, delay), [{ nonce: 0n, tx: ethOut }]);
  await warp(3600n);
  await sendAndWait(rpc, WALLET, queueTx(delay, wethOut));
  state = await inspect(rpc, safe);
  assert.equal(state.queueNonce, 2n);
  const queue = await readQueue(rpc, state);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue[0].tx, ethOut);
  assert.deepEqual(queue[1].tx, wethOut);
  assert.equal(queue[0].hash, delayTxHash(ethOut));
  ok("the queue is read back from the logs without a cache, hashes match");
  const vault = { safe, delay, controller: WALLET };
  assert.deepEqual(classify(queue[0].tx!, vault), { kind: "withdraw", token: null, amount: ETH });
  assert.deepEqual(classify(queue[1].tx!, vault), { kind: "withdraw", token: WETH, amount: 2n * ETH });
  assert.equal(itemStatus(queue[0], state.cooldown, state.expiration, await chainTime(rpc)).phase, "waiting");

  step("6. The delay cannot be skipped");
  await reverts(WALLET, executeTx(delay, ethOut), /cooldown/, "execute at once");
  await warp(WEEK - 3600n - 120n);
  await reverts(WALLET, executeTx(delay, ethOut), /cooldown/, "execute two minutes early");
  await reverts(WALLET, executeTx(delay, wethOut), /cooldown|hashes do not match/, "execute the second item first");
  await warp(180n);
  assert.equal(itemStatus(queue[0], state.cooldown, state.expiration, await chainTime(rpc)).phase, "ready");

  step("7. Execute after the delay");
  const before = await nativeBalance(rpc, WALLET);
  await sendAndWait(rpc, STRANGER, executeTx(delay, ethOut));
  assert.equal((await nativeBalance(rpc, WALLET)) - before, ETH);
  ok("a stranger executed the withdrawal, the funds went to the wallet");
  await reverts(STRANGER, executeTx(delay, wethOut), /cooldown/, "the second item, queued one hour later, is still waiting");
  await warp(3600n);
  const wethBefore = await tokenBalance(rpc, WETH, WALLET);
  await sendAndWait(rpc, WALLET, executeTx(delay, wethOut));
  assert.equal((await tokenBalance(rpc, WETH, WALLET)) - wethBefore, 2n * ETH);
  ok("the token withdrawal arrived");

  step("7b. Change the delay and the wallet, through the queue");
  const NEW_WALLET: Address = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
  await rpc("anvil_setCode", [NEW_WALLET, "0x"]);
  const DAY = 24n * 3600n;
  const toDay = changeDelayTx(delay, DAY);
  // Cancel first: two withdrawals, the wallet cancels both at once, nothing moves.
  const c1 = withdrawalTx(WALLET, null, ETH / 10n);
  const c2 = withdrawalTx(WALLET, WETH, ETH / 2n);
  await sendAndWait(rpc, WALLET, queueTx(delay, c1));
  await sendAndWait(rpc, WALLET, queueTx(delay, c2));
  state = await inspect(rpc, safe);
  const vaultBefore = await nativeBalance(rpc, safe);
  await sendAndWait(rpc, WALLET, cancelTx(roles, delay, state.queueNonce - 1n));
  state = await inspect(rpc, safe);
  assert.equal(state.txNonce, state.queueNonce);
  assert.equal(state.state, "locked");
  assert.equal(await nativeBalance(rpc, safe), vaultBefore);
  ok("the wallet cancelled two queued withdrawals at once, nothing moved");

  const vaultR = { ...vault, roles };
  const handOver = changeWalletTx(delay, WALLET, NEW_WALLET, roles)!;
  assert.deepEqual(classify(toDay, vaultR), { kind: "change-delay", cooldown: DAY });
  assert.deepEqual(classify(handOver, vaultR), { kind: "change-wallet", to: NEW_WALLET });
  // The hand-over without the cancel right is not the one this app builds.
  assert.equal(classify(changeWalletTx(delay, WALLET, NEW_WALLET)!, vaultR).kind, "unknown");
  // A batch that also does something else is not a clean hand-over.
  assert.equal(classify({ ...handOver, data: `${handOver.data}00` as Hex }, vaultR).kind, "unknown");
  assert.equal(changeWalletTx(delay, WALLET, WALLET), null);
  await sendAndWait(rpc, WALLET, queueTx(delay, toDay));
  await sendAndWait(rpc, WALLET, queueTx(delay, handOver));
  await reverts(WALLET, executeTx(delay, toDay), /cooldown/, "the change of the delay before its own wait");
  await warp(WEEK + 60n);
  await sendAndWait(rpc, STRANGER, executeTx(delay, toDay));
  state = await inspect(rpc, safe);
  assert.equal(state.cooldown, DAY);
  assert.equal(state.state, "locked");
  ok("the delay is 1 day now, after it waited 7 days");
  await sendAndWait(rpc, STRANGER, executeTx(delay, handOver));
  state = await inspect(rpc, safe);
  assert.equal(state.state, "locked");
  assert.ok(sameAddress(state.controller, NEW_WALLET));
  await reverts(WALLET, queueTx(delay, withdrawalTx(WALLET, null, 1n)), null, "the old wallet queues a withdrawal");
  await reverts(WALLET, cancelTx(roles, delay, state.txNonce), null, "the old wallet cancels");
  ok("the new wallet is the only controller, the old wallet can neither queue nor cancel");
  await sendAndWait(rpc, NEW_WALLET, queueTx(delay, withdrawalTx(NEW_WALLET, null, 1n)));
  await sendAndWait(rpc, NEW_WALLET, cancelTx(roles, delay, state.txNonce));
  ok("the new wallet can cancel");
  // Hand it back so that the rest of the test runs as before, and put the delay back to 7 days.
  const handBack = changeWalletTx(delay, NEW_WALLET, WALLET, roles)!;
  await sendAndWait(rpc, NEW_WALLET, queueTx(delay, handBack));
  await sendAndWait(rpc, NEW_WALLET, queueTx(delay, changeDelayTx(delay, WEEK)));
  await warp(DAY + 60n);
  await sendAndWait(rpc, STRANGER, executeTx(delay, handBack));
  await sendAndWait(rpc, STRANGER, executeTx(delay, changeDelayTx(delay, WEEK)));
  state = await inspect(rpc, safe);
  assert.ok(sameAddress(state.controller, WALLET));
  assert.equal(state.cooldown, WEEK);

  step("8. Other queued transactions are flagged and also wait");
  const shorten = { to: delay, value: 0n, data: call("setTxCooldown(uint256)", [0n]), operation: 0 };
  const elsewhere = withdrawalTx(STRANGER, WETH, 1_000000n);
  await sendAndWait(rpc, WALLET, queueTx(delay, shorten));
  await sendAndWait(rpc, WALLET, queueTx(delay, elsewhere));
  assert.deepEqual(classify(shorten, vault), { kind: "settings", label: "Changes the delay" });
  assert.deepEqual(classify(elsewhere, vault), { kind: "transfer-elsewhere", token: WETH, to: STRANGER, amount: 1_000000n });
  await reverts(WALLET, executeTx(delay, shorten), /cooldown/, "the change of the delay is itself delayed");

  step("9. Expiry");
  await warp(WEEK + EXPIRATION_SECONDS + 60n);
  state = await inspect(rpc, safe);
  const stale = await readQueue(rpc, state);
  assert.equal(stale.length, 2);
  assert.equal(itemStatus(stale[0], state.cooldown, state.expiration, await chainTime(rpc)).phase, "expired");
  await reverts(WALLET, executeTx(delay, shorten), /expired/, "execute after the window closed");
  await sendAndWait(rpc, STRANGER, skipExpiredTx(delay));
  state = await inspect(rpc, safe);
  assert.equal(state.txNonce, state.queueNonce);
  assert.equal(state.state, "locked");
  assert.equal(state.cooldown, WEEK);
  ok("expired items were skipped, the delay is unchanged");

  step("9b. An RPC without old logs");
  const noHistory: Rpc = async (method, params = []) => {
    if (method === "eth_getLogs" && (params as any[])[0]?.address?.toLowerCase() === roles.toLowerCase()) throw new Error("query exceeds max block range");
    return rpc(method, params);
  };
  assert.equal((await inspect(noHistory, safe)).state, "unverified");
  ok("without the event history the vault is unverified, not locked");
  const wrongHints: BlockHints = { get: () => toBigInt(locked.blockNumber) + 5n, set: () => undefined };
  assert.equal((await inspect(rpc, safe, wrongHints)).state, "locked");
  ok("a wrong remembered block does not break the check");

  step("10. A tampered setup is caught");
  // What a fake copy of the app could do: the normal setup plus one extra.
  const BACKDOOR = keccak("0x6261636b646f6f72");
  const tampered = async (index: number, what: string, extra: (evil: Address, evilDelay: Address, evilRoles: Address) => { to: Address; data: Hex }[], after = false) => {
    const evil = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, index)))!;
    const evilDelay = predictDelay(evil, WEEK, EXPIRATION_SECONDS);
    const evilRoles = predictRoles(evil);
    const salt = toBigInt(keccak("0x7a6f646961632d74696d65626f783a7631"));
    await sendAndWait(
      rpc,
      WALLET,
      ownerBatchTx(WALLET, evil, [
        { to: CONTRACTS.moduleProxyFactory, data: call("deployModule(address,bytes,uint256)", [CONTRACTS.delayMastercopy, delayInitializer(evil, WEEK, EXPIRATION_SECONDS), salt]) },
        { to: CONTRACTS.moduleProxyFactory, data: call("deployModule(address,bytes,uint256)", [CONTRACTS.rolesMastercopy, rolesInitializer(evil), salt]) },
        { to: evilRoles, data: call("scopeTarget(bytes32,address)", [CANCEL_ROLE, evilDelay]) },
        { to: evilRoles, data: call("allowFunction(bytes32,address,bytes4,uint8)", [CANCEL_ROLE, evilDelay, "0x46ba2307", 0]) },
        { to: evilRoles, data: call("assignRoles(address,bytes32[],bool[])", [WALLET, [CANCEL_ROLE], [true]]) },
        { to: evil, data: call("enableModule(address)", [evilDelay]) },
        { to: evil, data: call("enableModule(address)", [evilRoles]) },
        { to: evilDelay, data: call("enableModule(address)", [WALLET]) },
        ...(after ? [] : extra(evil, evilDelay, evilRoles)),
        { to: evil, data: call("swapOwner(address,address,address)", [SENTINEL, WALLET, CONTRACTS.burn]) },
        ...(after ? extra(evil, evilDelay, evilRoles) : []),
      ]),
    );
    const result = await inspect(rpc, evil);
    const failed = result.checks.filter((check) => !check.ok).map((check) => check.id);
    assert.equal(result.state, "invalid", `${what}: must be invalid`);
    console.log(`  ok  caught: ${what} (failed check: ${failed.join(", ")})`);
  };
  await tampered(1, "a second module on the Safe", (evil) => [{ to: evil, data: call("enableModule(address)", [STRANGER]) }]);
  await tampered(2, "a second wallet that can queue", (_evil, evilDelay) => [{ to: evilDelay, data: call("enableModule(address)", [STRANGER]) }]);
  await tampered(3, "a Delay that another address owns", (_evil, evilDelay) => [{ to: evilDelay, data: call("transferOwnership(address)", [STRANGER]) }]);
  await tampered(4, "a second Safe owner", (evil) => [{ to: evil, data: call("addOwnerWithThreshold(address,uint256)", [STRANGER, 1n]) }], true);
  await tampered(6, "a second role that can call anything on the Safe", (evil, _d, evilRoles) => [
    { to: evilRoles, data: call("allowTarget(bytes32,address,uint8)", [BACKDOOR, evil, 3]) },
    { to: evilRoles, data: call("assignRoles(address,bytes32[],bool[])", [WALLET, [BACKDOOR], [true]]) },
  ]);
  await tampered(7, "the cancel role also allowed to set the delay to zero", (_e, evilDelay, evilRoles) => [
    { to: evilRoles, data: call("allowFunction(bytes32,address,bytes4,uint8)", [CANCEL_ROLE, evilDelay, "0xebb2b4a2", 0]) },
  ]);
  await tampered(8, "a second address that can cancel", (_e, _d, evilRoles) => [
    { to: evilRoles, data: call("assignRoles(address,bytes32[],bool[])", [STRANGER, [CANCEL_ROLE], [true]]) },
  ]);
  await tampered(9, "a Roles modifier that another address owns", (_e, _d, evilRoles) => [
    { to: evilRoles, data: call("transferOwnership(address)", [STRANGER]) },
  ]);
  await tampered(5, "a delay of zero", (_evil, evilDelay) => [{ to: evilDelay, data: call("setTxCooldown(uint256)", [0n]) }]);

  step("10b. A contribution rides in the lock transaction");
  const RECEIVER: Address = "0x000000000000000000000000000000000000c0de";
  const fee = ETH / 200n;
  const paid = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 20)))!;
  const receiverBefore = await nativeBalance(rpc, RECEIVER);
  const lockPaid = lockTx(WALLET, paid, WEEK, EXPIRATION_SECONDS, { to: RECEIVER, amount: fee });
  assert.equal(lockPaid.value, fee);
  assert.equal(lockTx(WALLET, paid, WEEK).value, undefined, "no contribution, no value");
  // Without the coin the batch cannot pay, so nothing is locked.
  await reverts(WALLET, { to: lockPaid.to, data: lockPaid.data }, null, "the lock with a contribution but without the coin");
  await sendAndWait(rpc, WALLET, lockPaid);
  assert.equal((await nativeBalance(rpc, RECEIVER)) - receiverBefore, fee);
  assert.equal(await nativeBalance(rpc, paid), 0n, "nothing stays in the vault");
  assert.equal((await inspect(rpc, paid)).state, "locked");
  assert.throws(() => lockTx(WALLET, paid, WEEK, EXPIRATION_SECONDS, { to: paid, amount: fee }));
  ok("the contribution arrived, the vault is locked and empty");

  step("11. A Safe as the wallet: create, lock and two deposits in one transaction");
  // A plain 1 of 1 Safe that WALLET owns. It stands for any smart contract wallet that can batch.
  const walletSafe = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 900)))!;
  await rpc("anvil_setBalance", [walletSafe, "0x" + (10n * ETH).toString(16)]);
  const asSafe = (calls: { to: Address; data: Hex; value?: bigint }[]) => sendAndWait(rpc, WALLET, ownerBatchTx(WALLET, walletSafe, calls));
  await asSafe([{ to: WETH, data: "0x", value: 2n * ETH }]);
  const vault2 = predictSafe(walletSafe, 0);
  const batch = setupCalls(walletSafe, 0, false, WEEK, [
    { token: null, amount: 3n * ETH },
    { token: WETH, amount: 2n * ETH },
  ]);
  assert.equal(batch.length, 4);
  const one = await asSafe(batch);
  console.log(`  gas used by the one transaction: ${toBigInt((one as any).gasUsed)}`);
  const state2 = await inspect(rpc, vault2);
  assert.equal(state2.state, "locked");
  assert.ok(sameAddress(state2.controller, walletSafe));
  assert.equal(await nativeBalance(rpc, vault2), 3n * ETH);
  assert.equal(await tokenBalance(rpc, WETH, vault2), 2n * ETH);
  ok("one transaction: vault created, locked and holding 3 ETH and 2 WETH, controller is the Safe");
  await reverts(WALLET, ownerBatchTx(WALLET, walletSafe, setupCalls(walletSafe, 1, false, WEEK, [{ token: WETH, amount: 50n * ETH }])), null, "a batch with a deposit that the wallet cannot pay");
  assert.equal(await rpc("eth_getCode", [predictSafe(walletSafe, 1), "latest"]), "0x");
  await asSafe([queueTx(state2.delay!, withdrawalTx(walletSafe, null, ETH))]);
  await asSafe([cancelTx(state2.roles!, state2.delay!, 0n)]);
  await asSafe([queueTx(state2.delay!, withdrawalTx(walletSafe, WETH, ETH))]);
  await warp(WEEK + 60n);
  const safeWethBefore = await tokenBalance(rpc, WETH, walletSafe);
  await sendAndWait(rpc, STRANGER, executeTx(state2.delay!, withdrawalTx(walletSafe, WETH, ETH)));
  assert.equal((await tokenBalance(rpc, WETH, walletSafe)) - safeWethBefore, ETH);
  ok("the Safe received its withdrawal after the delay");

  console.log("\nAll fork checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
}
