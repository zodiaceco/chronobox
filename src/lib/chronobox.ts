/**
 * Everything Chronobox does on chain: build the setup transactions, check a
 * vault, read the queue, build withdrawals.
 *
 * A Chronobox is three things:
 *   - a Safe 1.4.1 that holds the funds. Its only owner is a burn address.
 *   - a Zodiac Delay modifier. Every transaction that goes through it waits
 *     the delay. It is the only way to move funds or change the vault.
 *   - the hot wallet, the only module of the Delay. It is the control unit:
 *     it can queue any transaction.
 * One thing does not wait: cancel. The Delay lets only its owner (the Safe)
 * remove a queued transaction, and the owner can also set the delay to zero.
 * So a Zodiac Roles modifier sits beside the Delay with exactly one
 * permission: the hot wallet can make the Safe call setTxNonce on the
 * Delay. It cannot move funds and it cannot change anything else.
 * Nothing here is custom contract code.
 */
import { call, decode, encode, selector, topic } from "./abi.ts";
import { CONTRACTS, SENTINEL, ZERO } from "./chains.ts";
import { answerOrStop, assertWallet, isTemporary } from "./wallet.ts";
import {
  type Address,
  type Hex,
  checksum,
  concat,
  keccak,
  sameAddress,
  size,
  strip,
  toBigInt,
  toQuantity,
  uintWord,
  utf8,
  word,
} from "./hex.ts";

/** A JSON-RPC transport. In the app this is the wallet's `request`. */
export type Rpc = (method: string, params?: unknown[]) => Promise<any>;

export type TxRequest = { to: Address; data: Hex; value?: bigint };

// ---------------------------------------------------------------------------
// Pinned code. The fork test proves these against the live contracts.
// ---------------------------------------------------------------------------

/** keccak256 of SafeProxy 1.4.1 creation code + the SafeL2 singleton address. */
export const SAFE_PROXY_INIT_CODE_HASH: Hex = "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee";
/** keccak256 of the runtime code of a SafeProxy 1.4.1. */
export const SAFE_PROXY_CODE_HASH: Hex = "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c";
/** keccak256 of the code of SafeModuleSetup 0.3.0, the helper that the Council Safe of a recovery calls in its setup. The fork test checks it. */
export const SAFE_MODULE_SETUP_CODE_HASH: Hex = "0xaf2d170bb766d2773c3fa88717f5b3599827478074d3767d1dee55e5c2f3fbcb";

const MINIMAL_PROXY_PREFIX = "363d3d373d3d3d363d73";
const MINIMAL_PROXY_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const MINIMAL_PROXY_DEPLOY = "602d8060093d393df3";

/** Runtime code of the EIP-1167 proxy that ModuleProxyFactory deploys for the Delay. */
export const DELAY_PROXY_CODE: Hex = concat(MINIMAL_PROXY_PREFIX, CONTRACTS.delayMastercopy, MINIMAL_PROXY_SUFFIX);

/** Runtime code of the EIP-1167 proxy for the Roles modifier. */
export const ROLES_PROXY_CODE: Hex = concat(MINIMAL_PROXY_PREFIX, CONTRACTS.rolesMastercopy, MINIMAL_PROXY_SUFFIX);

/** The one role in the Roles modifier: bytes32("cancel"). */
export const CANCEL_ROLE: Hex = ("0x" + strip(utf8("cancel")).padEnd(64, "0")) as Hex;
const SET_TX_NONCE = selector("setTxNonce(uint256)");

/**
 * The second role, for a Chronobox with a guardian: bytes32("council"). Its one member is a
 * 2 of 2 Safe of the wallet and the guardian. Together they can hand the Chronobox to a new
 * wallet at once. The role cannot move funds, change the delay, or add a module to the Safe.
 */
export const COUNCIL_ROLE: Hex = ("0x" + strip(utf8("council")).padEnd(64, "0")) as Hex;
const ENABLE_MODULE = selector("enableModule(address)");
const DISABLE_MODULE = selector("disableModule(address,address)");
const ASSIGN_ROLES = selector("assignRoles(address,bytes32[],bool[])");
const WITH_ROLE_SIGNATURE = "execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)";
const WITH_ROLE = selector(WITH_ROLE_SIGNATURE);

// Events of the Roles modifier, from the verified ABI of the master copy.
const ROLES_TOPIC = {
  setup: topic("RolesModSetup(address,address,address,address)"),
  initialized: topic("Initialized(uint64)"),
  avatarSet: topic("AvatarSet(address,address)"),
  targetSet: topic("TargetSet(address,address)"),
  ownership: topic("OwnershipTransferred(address,address)"),
  enabledModule: topic("EnabledModule(address)"),
  disabledModule: topic("DisabledModule(address)"),
  assignRoles: topic("AssignRoles(address,bytes32[],bool[])"),
  scopeTarget: topic("ScopeTarget(bytes32,address)"),
  allowFunction: topic("AllowFunction(bytes32,address,bytes4,uint8)"),
  execSuccess: topic("ExecutionFromModuleSuccess(address)"),
  execFailure: topic("ExecutionFromModuleFailure(address)"),
};

const GUARD_SLOT = keccak(utf8("guard_manager.guard.address"));
const FALLBACK_SLOT = keccak(utf8("fallback_manager.handler.address"));

/** Base salt. The nth vault of a wallet uses SALT_BASE + n. */
const SALT_BASE = toBigInt(keccak(utf8("zodiac-timebox:v1")));

export const TOPIC_TRANSACTION_ADDED = topic("TransactionAdded(uint256,bytes32,address,uint256,bytes,uint8)");
const TOPIC_PROXY_CREATION = topic("ProxyCreation(address,address)");

/** Time a queued withdrawal stays executable after its delay ends. */
export const EXPIRATION_SECONDS = 7n * 24n * 3600n;
export const MIN_COOLDOWN = 3600n;
export const MAX_COOLDOWN = 90n * 24n * 3600n;

/** A recovery that is ready stays executable this long. Longer than a withdrawal: the people involved may be slow. */
export const RECOVERY_EXPIRATION = 30n * 24n * 3600n;
/** How long a recovery waits, unless the owner chooses another time: six months. The Recovery Delay is made with it. */
export const DEFAULT_RECOVERY_WAIT = 180n * 24n * 3600n;
/** The guardian chooses the wallet that a recovery brings the Chronobox to. A short wait would make that too easy. */
export const MIN_RECOVERY_WAIT = 30n * 24n * 3600n;
export const MAX_RECOVERY_WAIT = 730n * 24n * 3600n;
/** The Recovery Delay has its own salt, so it can never be at the address of the Delay for withdrawals. */
const SALT_RECOVERY = SALT_BASE + 1n;

// ---------------------------------------------------------------------------
// Address prediction
// ---------------------------------------------------------------------------

function create2(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  return checksum(keccak(concat("ff", deployer, salt, initCodeHash)).slice(-40));
}

/** Initializer of step 1: a plain 1 of 1 Safe owned by the wallet, with no module, guard or handler. */
export function safeInitializer(wallet: Address): Hex {
  return call("setup(address[],uint256,address,bytes,address,address,uint256,address)", [
    [wallet],
    1n,
    ZERO,
    "0x",
    ZERO,
    ZERO,
    0n,
    ZERO,
  ]);
}

/**
 * The address of the nth Chronobox of a wallet. It depends only on the wallet
 * and the index, and it is the same on every chain. The app can find a
 * wallet's vaults again without a server.
 */
export function predictSafe(wallet: Address, index: number): Address {
  const salt = keccak(concat(keccak(safeInitializer(wallet)), uintWord(SALT_BASE + BigInt(index))));
  return create2(CONTRACTS.safeProxyFactory, salt, SAFE_PROXY_INIT_CODE_HASH);
}

export function delayInitializer(safe: Address, cooldown: bigint, expiration: bigint): Hex {
  const params = encode(["address", "address", "address", "uint256", "uint256"], [safe, safe, safe, cooldown, expiration]);
  return call("setUp(bytes)", [params]);
}

export function predictDelay(safe: Address, cooldown: bigint, expiration: bigint): Address {
  return minimalProxyAddress(CONTRACTS.delayMastercopy, delayInitializer(safe, cooldown, expiration));
}

function minimalProxyAddress(mastercopy: Address, initializer: Hex, saltNonce: bigint = SALT_BASE): Address {
  const salt = keccak(concat(keccak(initializer), uintWord(saltNonce)));
  const initCode = concat(MINIMAL_PROXY_DEPLOY, MINIMAL_PROXY_PREFIX, mastercopy, MINIMAL_PROXY_SUFFIX);
  return create2(CONTRACTS.moduleProxyFactory, salt, keccak(initCode));
}

function recoveryInitializer(safe: Address): Hex {
  return delayInitializer(safe, DEFAULT_RECOVERY_WAIT, RECOVERY_EXPIRATION);
}

/**
 * The second Delay of a Chronobox with a recovery: the line that a recovery waits in. Its
 * address depends only on the Chronobox, so there is one for each Chronobox, for ever. The
 * Chronobox owns it. It is never a module of the Chronobox: with a recovery on, it acts on the
 * Council Safe of wallet and guardian, and the guardian is the one who can put something into
 * its line. Anybody can make it. As made, it points at the Chronobox, where it can do nothing.
 */
export function predictRecoveryDelay(safe: Address): Address {
  return minimalProxyAddress(CONTRACTS.delayMastercopy, recoveryInitializer(safe), SALT_RECOVERY);
}

/** Makes the Recovery Delay. Anybody can send this, and the result is the same. Nobody can use it until the Chronobox says so. */
export function recoveryDelayCreateTx(safe: Address): TxRequest {
  return {
    to: CONTRACTS.moduleProxyFactory,
    data: call("deployModule(address,bytes,uint256)", [CONTRACTS.delayMastercopy, recoveryInitializer(safe), SALT_RECOVERY]),
  };
}

/** The Roles modifier is owned by the Safe. So its one permission can change only through the Delay queue. */
export function rolesInitializer(safe: Address): Hex {
  return call("setUp(bytes)", [encode(["address", "address", "address"], [safe, safe, safe])]);
}

export function predictRoles(safe: Address): Address {
  return minimalProxyAddress(CONTRACTS.rolesMastercopy, rolesInitializer(safe));
}

/**
 * The 2 of 2 Safe of the wallet and the guardian. It holds nothing. No guard, no handler.
 * Without a recovery it has no module. With a recovery it has one module from its first moment:
 * the Recovery Delay of this Chronobox. Safe's own helper contract enables it during the setup.
 */
export function councilInitializer(wallet: Address, guardian: Address, recoveryDelay: Address | null = null): Hex {
  const to = recoveryDelay ? CONTRACTS.safeModuleSetup : ZERO;
  const data = recoveryDelay ? call("enableModules(address[])", [[recoveryDelay]]) : "0x";
  return call("setup(address[],uint256,address,bytes,address,address,uint256,address)", [[wallet, guardian], 2n, to, data, ZERO, ZERO, 0n, ZERO]);
}

/** Each Chronobox has its own, so a change in one never reaches another. */
function councilSalt(safe: Address): bigint {
  return toBigInt(keccak(concat(uintWord(SALT_BASE), word(safe))));
}

/**
 * The address of that Safe. Only a Safe with exactly these two owners and a threshold of 2
 * can ever exist there, so the address can get its role before the Safe is made. Anybody
 * can make it, at any time, and the result is the same.
 */
export function predictCouncil(safe: Address, wallet: Address, guardian: Address, withRecovery = false): Address {
  const initializer = councilInitializer(wallet, guardian, withRecovery ? predictRecoveryDelay(safe) : null);
  const salt = keccak(concat(keccak(initializer), uintWord(councilSalt(safe))));
  return create2(CONTRACTS.safeProxyFactory, salt, SAFE_PROXY_INIT_CODE_HASH);
}

/** Makes that Safe. `withRecovery` must be the form that the address was predicted with. */
export function councilCreateTx(safe: Address, wallet: Address, guardian: Address, withRecovery = false): TxRequest {
  const initializer = councilInitializer(wallet, guardian, withRecovery ? predictRecoveryDelay(safe) : null);
  return {
    to: CONTRACTS.safeProxyFactory,
    data: call("createProxyWithNonce(address,bytes,uint256)", [CONTRACTS.safeSingleton, initializer, councilSalt(safe)]),
  };
}

// ---------------------------------------------------------------------------
// Setup transactions
// ---------------------------------------------------------------------------

/** Step 1: create the Safe. The wallet is its only owner until step 2. */
export function createTx(wallet: Address, index: number): TxRequest {
  return {
    to: CONTRACTS.safeProxyFactory,
    data: call("createProxyWithNonce(address,bytes,uint256)", [
      CONTRACTS.safeSingleton,
      safeInitializer(wallet),
      SALT_BASE + BigInt(index),
    ]),
  };
}

export type Call = { to: Address; data: Hex; value?: bigint };

/**
 * A Safe transaction that runs several calls as the Safe, in one MultiSend
 * batch. It works only while the sender is the one owner of the Safe, so only
 * between step 1 and step 2 of the setup.
 */
export function ownerBatchTx(owner: Address, safe: Address, calls: Call[], send: bigint = 0n): TxRequest {
  const batch = concat(...calls.map((c) => "00" + strip(c.to) + uintWord(c.value ?? 0n) + uintWord(size(c.data)) + strip(c.data)));
  // An owner that sends the transaction itself needs no signature: v = 1, r = owner.
  const signature = concat(word(owner), uintWord(0n), "01");
  return {
    to: safe,
    data: call("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)", [
      CONTRACTS.multiSend,
      0n,
      call("multiSend(bytes)", [batch]),
      1, // delegatecall into MultiSend
      0n,
      0n,
      0n,
      ZERO,
      ZERO,
      signature,
    ]),
    // Coin that the owner sends along. It arrives in the Safe first, and a call in the batch can pass it on.
    ...(send > 0n ? { value: send } : {}),
  };
}

/**
 * The price of the network's coin in US dollars with 8 decimals, from the
 * Chainlink feed. Null when there is no usable price: the feed did not
 * answer, or its last update is older than two days.
 */
export async function coinPriceUsd(rpc: Rpc, feed: Address | null): Promise<bigint | null> {
  if (feed === null) return 100_000_000n;
  try {
    const [, answer, , updatedAt] = decode(["uint80", "uint256", "uint256", "uint256", "uint80"], await ethCall(rpc, feed, call("latestRoundData()"))) as bigint[];
    const now = await chainTime(rpc);
    if (answer <= 0n || answer >= 1n << 255n || now - updatedAt > 172_800n) return null;
    return answer;
  } catch {
    return null;
  }
}

/** Dollars (as cents) in the network's coin (wei), at a price with 8 decimals. */
export function usdToCoin(cents: bigint, price: bigint): bigint {
  return (cents * 10n ** 24n) / price;
}

/** A voluntary payment to the people who maintain Chronobox, in the coin of the network. */
export type Contribution = { to: Address; amount: bigint };

/**
 * Money that goes in with step 2. `coin` is sent along and stays in the
 * Chronobox. `calls` are made by the Chronobox itself: it collects tokens
 * that the owner signed for (see deposit.ts). All of it happens with the
 * setup or not at all.
 */
export type Money = { coin: bigint; calls: Call[] };
const NO_MONEY: Money = { coin: 0n, calls: [] };

/**
 * Step 2: one Safe transaction, sent by the owner wallet, that
 *   1. deploys the Delay (owner, avatar and target are the Safe),
 *   2. deploys the Roles modifier (owner, avatar and target are the Safe) and
 *      gives it one permission: the wallet can call setTxNonce on the Delay,
 *   3. enables the Delay and the Roles modifier as the modules of the Safe,
 *   4. enables the wallet as the only module of the Delay,
 *   5. replaces the wallet as Safe owner with the burn address,
 *   6. if money goes in now: collects the tokens that the owner signed for
 *      (the coin came with the transaction and stays),
 *   7. if the user chose to contribute: passes the contribution, which the
 *      wallet sends along with this transaction, on to its receiver.
 * All of it happens together or not at all.
 */
export function lockTx(
  wallet: Address,
  safe: Address,
  cooldown: bigint,
  expiration: bigint = EXPIRATION_SECONDS,
  contribution: Contribution | null = null,
  money: Money = NO_MONEY,
): TxRequest {
  if (contribution && (contribution.amount <= 0n || sameAddress(contribution.to, safe) || sameAddress(contribution.to, ZERO))) {
    throw new Error("The contribution is not valid");
  }
  if (money.coin < 0n) throw new Error("The amount must not be less than zero");
  if (cooldown < 1n) throw new Error("The delay must be longer than zero");
  if (expiration !== 0n && expiration < 60n) throw new Error("The execution window must be at least 60 seconds");
  const delay = predictDelay(safe, cooldown, expiration);
  const roles = predictRoles(safe);
  return ownerBatchTx(wallet, safe, [
    {
      to: CONTRACTS.moduleProxyFactory,
      data: call("deployModule(address,bytes,uint256)", [CONTRACTS.delayMastercopy, delayInitializer(safe, cooldown, expiration), SALT_BASE]),
    },
    {
      to: CONTRACTS.moduleProxyFactory,
      data: call("deployModule(address,bytes,uint256)", [CONTRACTS.rolesMastercopy, rolesInitializer(safe), SALT_BASE]),
    },
    { to: roles, data: call("scopeTarget(bytes32,address)", [CANCEL_ROLE, delay]) },
    // Execution option 0: a plain call with no value. Never a delegatecall.
    { to: roles, data: call("allowFunction(bytes32,address,bytes4,uint8)", [CANCEL_ROLE, delay, SET_TX_NONCE, 0]) },
    { to: roles, data: call("assignRoles(address,bytes32[],bool[])", [wallet, [CANCEL_ROLE], [true]]) },
    { to: safe, data: call("enableModule(address)", [delay]) },
    { to: safe, data: call("enableModule(address)", [roles]) },
    { to: delay, data: call("enableModule(address)", [wallet]) },
    { to: safe, data: call("swapOwner(address,address,address)", [SENTINEL, wallet, CONTRACTS.burn]) },
    ...money.calls,
    ...(contribution ? [{ to: contribution.to, data: "0x" as Hex, value: contribution.amount }] : []),
  ], (contribution?.amount ?? 0n) + money.coin);
}

export type Deposit = { token: Address | null; amount: bigint };

/**
 * The whole setup as a list of calls, for a wallet that can send several
 * calls as one transaction (a Safe, or an account with EIP-7702 code):
 * create, lock, then one transfer per deposit. The vault address is known
 * before anything is sent, so the deposits can be in the same batch. The
 * batch must be atomic: if the lock fails, no deposit happens.
 */
export function setupCalls(
  wallet: Address,
  index: number,
  created: boolean,
  cooldown: bigint,
  deposits: Deposit[],
  contribution: Contribution | null = null,
  more: TxRequest[] = [],
): TxRequest[] {
  const safe = predictSafe(wallet, index);
  return [
    ...(created ? [] : [createTx(wallet, index)]),
    lockTx(wallet, safe, cooldown, EXPIRATION_SECONDS, contribution),
    ...deposits.map((d) => depositTx(safe, d.token, d.amount)),
    // A contribution in a token: one more transfer by the wallet, in the same batch.
    ...more,
  ];
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

export async function ethCall(rpc: Rpc, to: Address, data: Hex): Promise<Hex> {
  return (await rpc("eth_call", [{ to, data }, "latest"])) as Hex;
}

async function read(rpc: Rpc, to: Address, signature: string, args: readonly any[], outputs: readonly string[]) {
  return decode(outputs, await ethCall(rpc, to, call(signature, args)));
}

async function getCode(rpc: Rpc, address: Address): Promise<Hex> {
  return (await rpc("eth_getCode", [address, "latest"])) as Hex;
}

export type Receipt = {
  transactionHash: Hex;
  blockNumber: Hex;
  status: Hex;
  logs: { address: Address; topics: Hex[]; data: Hex }[];
};

/** The transaction that was sent is gone, and the account has moved on: the wallet sent another one in its place. */
export class Replaced extends Error {
  constructor() {
    super("Your wallet replaced this transaction with another one (speed up or cancel). This page now shows what is on chain.");
    this.name = "Replaced";
  }
}

/** The person stopped waiting. The transaction may still arrive. */
export class StoppedWaiting extends Error {
  constructor() {
    super("The transaction was sent, but it is not confirmed yet. Look in your wallet. This page shows it when it arrives.");
    this.name = "StoppedWaiting";
  }
}

export type SendOptions = {
  /** The network the page shows. With it, the wallet is checked directly before the request. */
  chainId?: number;
  chainName?: string;
  onHash?: (hash: Hex) => void;
  /** Called once when the wait for the receipt gets long. */
  onSlow?: () => void;
  /** Return true to stop waiting. The transaction is not undone by that. */
  shouldStop?: () => boolean;
  /** Time between two looks for the receipt. */
  pollMs?: number;
};

/** After this long, a wait is called long and gets a way out. A test can set a shorter time. */
export const slowAfterMs = (): number => (globalThis as { __CHRONOBOX_SLOW_MS?: number }).__CHRONOBOX_SLOW_MS ?? 75_000;
/**
 * How long the wallet may take to answer before the page offers a way out. Shorter than the
 * wait for the chain: a request that the owner lost sight of never gets an answer by itself.
 */
export const askSlowAfterMs = (): number => Math.min(slowAfterMs(), 20_000);

/**
 * Sends a transaction through the wallet and waits until it is mined.
 *
 * The wallet and its network are not ours, so: the wallet is checked first, a bad answer while
 * waiting is not taken as a failure, a replaced transaction is noticed, and the caller can stop a
 * wait that never ends. After the wallet has returned a hash, the only failures are "failed on
 * chain", Replaced and StoppedWaiting.
 */
export async function sendAndWait(rpc: Rpc, from: Address, tx: TxRequest, options: SendOptions | ((hash: Hex) => void) = {}): Promise<Receipt> {
  const opts: SendOptions = typeof options === "function" ? { onHash: options } : options;
  if (opts.chainId !== undefined) await assertWallet(rpc, from, opts.chainId, opts.chainName);
  const request: Record<string, string> = { from, to: tx.to, ...(tx.data === "0x" ? {} : { data: tx.data }) };
  if (tx.value && tx.value > 0n) request.value = toQuantity(tx.value);
  // Estimate first: a transaction that would fail is stopped before the wallet
  // asks for a signature, and a plain transfer to a Safe gets enough gas.
  const estimate = toBigInt(await rpc("eth_estimateGas", [request]));
  request.gas = toQuantity((estimate * 5n) / 4n + 10_000n);
  // The wallet asks its owner now. That can take minutes, and it can also never end: the owner can stop waiting.
  const hash = (await answerOrStop(rpc("eth_sendTransaction", [request]), opts.shouldStop)) as Hex;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("Your wallet did not confirm that it sent the transaction. Look in your wallet before you try again.");
  }
  opts.onHash?.(hash);

  const started = Date.now();
  let told = false;
  let nonce: bigint | null = null;
  let gone = 0;
  for (let round = 0; ; round++) {
    let receipt: Receipt | null = null;
    try {
      receipt = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
    } catch {
      // A bad answer about a sent transaction says nothing about the transaction. Ask again.
    }
    if (receipt && receipt.blockNumber) {
      if (toBigInt(receipt.status) !== 1n) throw new Error("The transaction failed on chain. Nothing was changed.");
      return receipt;
    }
    // Now and then: is the transaction still known? If it is gone and the account has sent
    // something else with its number, the wallet replaced it.
    if (round % 4 === 3) {
      try {
        const sent = (await rpc("eth_getTransactionByHash", [hash])) as { nonce?: Hex } | null;
        if (sent?.nonce) {
          nonce = toBigInt(sent.nonce);
          gone = 0;
        } else if (nonce !== null && ++gone >= 2) {
          const used = toBigInt(await rpc("eth_getTransactionCount", [from, "latest"]));
          const late = (await rpc("eth_getTransactionReceipt", [hash])) as Receipt | null;
          if (!late?.blockNumber && used > nonce) throw new Replaced();
        }
      } catch (error) {
        if (error instanceof Replaced) throw error;
      }
    }
    if (!told && Date.now() - started > slowAfterMs()) {
      told = true;
      opts.onSlow?.();
    }
    if (opts.shouldStop?.()) throw new StoppedWaiting();
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1500));
  }
}

/** When a mined transaction happened, in chain time. Never fails: the latest block or this device's clock stand in. */
export async function receiptTime(rpc: Rpc, receipt: Receipt): Promise<bigint> {
  try {
    const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (block?.timestamp) return toBigInt(block.timestamp);
  } catch {
    // Fall through.
  }
  try {
    return await chainTime(rpc);
  } catch {
    return BigInt(Math.floor(Date.now() / 1000));
  }
}

export async function chainTime(rpc: Rpc): Promise<bigint> {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  return toBigInt(block.timestamp);
}

/** Reads the new Safe address from the receipt of step 1. */
export function safeFromReceipt(receipt: Receipt): Address | null {
  for (const log of receipt.logs) {
    if (sameAddress(log.address, CONTRACTS.safeProxyFactory) && log.topics[0] === TOPIC_PROXY_CREATION && log.topics[1]) {
      return checksum(log.topics[1].slice(-40));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inspection: do not trust, verify
// ---------------------------------------------------------------------------

export type Check = {
  id: string;
  ok: boolean;
  /** True when the check could not be done, for example because the RPC did not return old logs. */
  unknown?: boolean;
  label: string;
  detail: string;
};

export type Inspection = {
  safe: Address;
  /**
   * missing: no contract at the address.
   * open: step 1 is done, the wallet still owns the Safe. Do not deposit.
   * locked: every check passed.
   * unverified: nothing is wrong, but one check could not be done from this
   *   device. Do not deposit until it passes. Withdrawing still works.
   * invalid: something is different from a Chronobox. Do not deposit.
   */
  state: "missing" | "open" | "locked" | "unverified" | "invalid";
  checks: Check[];
  owners: Address[];
  delay: Address | null;
  /** The Roles modifier that allows cancelling. Null for a vault without cancel. */
  roles: Address | null;
  /** The hot wallet: the one address that can queue transactions, and cancel them. */
  controller: Address | null;
  /** The guardian, if there is one: a second address that can cancel, and nothing else alone. */
  guardian: Address | null;
  /** The 2 of 2 Safe of wallet and guardian. Null without a guardian. */
  council: Address | null;
  /** False while nobody has made that Safe yet. It is made the first time it is needed. */
  councilMade: boolean;
  /** True when that Safe has, or will have, the Recovery Delay as its one module. */
  councilRecovery: boolean;
  /** The members of the Roles modifier in the order of the contract's list, newest first. */
  members: Address[];
  /** The Recovery Delay of this Chronobox, as it is on chain now. It may not be made yet. */
  recoveryDelay: RecoveryParts | null;
  /** The recovery, when it is on: the guardian alone can bring the Chronobox to a new wallet, after `wait`. */
  recovery: Recovery | null;
  cooldown: bigint;
  expiration: bigint;
  txNonce: bigint;
  queueNonce: bigint;
};

/** The Recovery Delay as it is on chain. Every builder that touches the recovery needs it. */
export type RecoveryParts = {
  delay: Address;
  /** The contract exists at its address. */
  deployed: boolean;
  /** The Chronobox owns it, and nothing guards it. */
  sound: boolean;
  /** The account that it acts on. As made: the Chronobox, where it can do nothing. With a recovery on: the Council Safe. */
  avatar: Address | null;
  target: Address | null;
  /** Who can put something into its line, newest first. With a recovery on: the guardian, and nobody else. */
  modules: Address[];
  cooldown: bigint;
  expiration: bigint;
  txNonce: bigint;
  queueNonce: bigint;
};

export type Recovery = {
  delay: Address;
  /** How long a recovery waits after the guardian starts it. */
  wait: bigint;
  /** How long it can be carried out after the wait. */
  expiration: bigint;
  txNonce: bigint;
  queueNonce: bigint;
};

/** Remembers in which block a contract was created, so its logs are read from there. */
export type BlockHints = {
  /** The network id, so cached history checks never cross between networks. */
  chainId?: number;
  get(address: Address): bigint | null;
  set(address: Address, block: bigint): void;
};

type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex };

/** Sizes of the pieces, largest first. Networks differ in the range they accept. */
const LOG_CHUNKS = [500_000n, 100_000n, 50_000n, 10_000n];
const LOG_CHUNKS_MAX = 400n;

/**
 * Finds the block in which a contract first appeared, via binary search on historical code.
 * Works on archive RPCs (such as MetaMask/Infura/Alchemy); returns null on pruned nodes.
 */
async function findDeployBlock(rpc: Rpc, address: Address, latest: bigint): Promise<bigint | null> {
  const hasCodeAt = async (block: bigint): Promise<boolean> => {
    const code = (await rpc("eth_getCode", [address, toQuantity(block)])) as Hex;
    return size(code) > 0;
  };
  try {
    if (await hasCodeAt(0n)) return 0n;
    let lo = 0n;
    let hi = latest;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (await hasCodeAt(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  } catch {
    return null;
  }
}

/**
 * Every log of one contract from a block to now. Many wallet networks refuse a wide range, so
 * when the one query fails, the range is read in pieces. When no start block is known yet, the
 * app tries to find the contract's creation block first (on archive RPCs).
 */
async function logsOf(rpc: Rpc, address: Address, from: bigint | null): Promise<Log[]> {
  try {
    return (await rpc("eth_getLogs", [{ address, fromBlock: from === null ? "0x0" : toQuantity(from), toBlock: "latest" }])) as Log[];
  } catch (error) {
    const latest = toBigInt(await rpc("eth_blockNumber", []));
    const startFrom = from ?? (await findDeployBlock(rpc, address, latest));
    if (startFrom === null || latest < startFrom) throw error;
    let last: unknown = error;
    for (const chunk of LOG_CHUNKS) {
      if ((latest - startFrom) / chunk >= LOG_CHUNKS_MAX) continue;
      const ranges: [bigint, bigint][] = [];
      for (let start = startFrom; start <= latest; start += chunk) ranges.push([start, start + chunk - 1n > latest ? latest : start + chunk - 1n]);
      try {
        const all: Log[] = [];
        // A few at a time: fast enough, and not so many that the network refuses them.
        for (let i = 0; i < ranges.length; i += 4) {
          const parts = await Promise.all(
            ranges.slice(i, i + 4).map(([a, b]) => rpc("eth_getLogs", [{ address, fromBlock: toQuantity(a), toBlock: toQuantity(b) }]) as Promise<Log[]>),
          );
          for (const part of parts) all.push(...part);
        }
        return all;
      } catch (smaller) {
        last = smaller;
      }
    }
    throw last;
  }
}

/** The guardian of a Chronobox, and the 2 of 2 Safe that the guardian shares with the wallet. */
export type Guard = { guardian: Address; council: Address };

/**
 * Proves what the Roles modifier allows, from its whole event history.
 *
 * The contract has no function that lists its permissions, so the state alone
 * cannot show that there is no second, wider permission. The events can:
 * every function that grants or changes something emits one. The history
 * must hold only what a Chronobox sets up:
 *   - "cancel": setTxNonce on this Delay. Members: the hot wallet, and the
 *     guardian if there is one.
 *   - "council", only after a guardian was added: enableModule and
 *     disableModule on this Delay (a new wallet), assignRoles and
 *     disableModule on this contract (the cancel right moves with it).
 *     Member: the 2 of 2 Safe of wallet and guardian, and nobody else.
 *
 * One more thing may be there, after a recovery was turned on: "cancel" also covers setTxNonce
 * on the Recovery Delay of this Chronobox, so the wallet and the guardian can stop a recovery.
 * A recovery needs no role of its own: the guardian puts it into the line of the recovery
 * Delay, and that Delay acts on the Council Safe, with the role that the Council Safe has.
 *
 * Returns null when the RPC cannot provide the history.
 */
export type History = {
  ok: boolean;
  detail: string;
  /** True when "cancel" covers the line of the Recovery Delay. */
  stopsRecovery?: boolean;
};

export async function verifyCancelPermission(
  rpc: Rpc,
  roles: Address,
  delay: Address,
  controller: Address,
  hints?: BlockHints,
  guard: Guard | null = null,
  recovery: Address | null = null,
): Promise<History | null> {
  const read = (from: bigint | null) => logsOf(rpc, roles, from);
  let logs: Log[];
  try {
    const hint = hints?.get(roles) ?? null;
    logs = await read(hint);
    // A remembered block that is wrong must not hide the start of the history.
    if (hint !== null && !logs.some((log) => log.topics[0] === ROLES_TOPIC.setup)) logs = await read(null);
  } catch {
    return null;
  }
  const bad = (detail: string): History => ({ ok: false, detail });
  let allowedRecovery = false;
  const cancellers = new Set<string>();
  const council = new Set<string>();
  // What each role may call, as "target:function". Nothing else may ever have been granted.
  const allowedFor: Record<string, string[]> = {
    [CANCEL_ROLE]: [`${delay}:${SET_TX_NONCE}`],
    [COUNCIL_ROLE]: [`${delay}:${ENABLE_MODULE}`, `${delay}:${DISABLE_MODULE}`, `${roles}:${ASSIGN_ROLES}`, `${roles}:${DISABLE_MODULE}`],
  };
  const scoped = new Set<string>();
  const granted = new Set<string>();
  let created = false;

  for (const log of logs) {
    const kind = log.topics[0];
    if (kind === ROLES_TOPIC.setup) {
      created = true;
      hints?.set(roles, toBigInt(log.blockNumber));
    } else if (kind === ROLES_TOPIC.assignRoles) {
      const [member, keys, flags] = decode(["address", "bytes32[]", "bool[]"], log.data) as [Address, Hex[], boolean[]];
      if (keys.length !== 1 || flags.length !== 1 || (keys[0] !== CANCEL_ROLE && keys[0] !== COUNCIL_ROLE)) return bad(`A role that a Chronobox does not have was assigned to ${member}`);
      const set = keys[0] === CANCEL_ROLE ? cancellers : council;
      if (flags[0]) set.add(member.toLowerCase());
      else set.delete(member.toLowerCase());
    } else if (kind === ROLES_TOPIC.scopeTarget) {
      const [key, target] = decode(["bytes32", "address"], log.data) as [Hex, Address];
      const ok =
        (key === CANCEL_ROLE && (sameAddress(target, delay) || sameAddress(target, recovery))) ||
        (key === COUNCIL_ROLE && (sameAddress(target, delay) || sameAddress(target, roles)));
      if (!ok) return bad(`A permission on another contract exists: ${target}`);
      scoped.add(`${key}:${target}`.toLowerCase());
    } else if (kind === ROLES_TOPIC.allowFunction) {
      const [key, target, fn, options] = decode(["bytes32", "address", "bytes4", "uint8"], log.data) as [Hex, Address, Hex, bigint];
      const wanted = (allowedFor[key] ?? []).find((entry) => entry.toLowerCase() === `${target}:${fn}`.toLowerCase());
      // Cancel may also cover the line of the Recovery Delay: that is how a recovery is stopped.
      const stops = key === CANCEL_ROLE && recovery !== null && sameAddress(target, recovery) && fn.toLowerCase() === SET_TX_NONCE;
      // Execution option 0 only: a plain call with no value, never a delegatecall.
      if ((!wanted && !stops) || options !== 0n) return bad(`A permission that a Chronobox does not have exists: ${fn} on ${target}`);
      if (wanted) granted.add(`${key}:${wanted}`.toLowerCase());
      if (stops) allowedRecovery = true;
    } else if (
      kind !== ROLES_TOPIC.initialized &&
      kind !== ROLES_TOPIC.avatarSet &&
      kind !== ROLES_TOPIC.targetSet &&
      kind !== ROLES_TOPIC.ownership &&
      kind !== ROLES_TOPIC.enabledModule &&
      kind !== ROLES_TOPIC.disabledModule &&
      kind !== ROLES_TOPIC.execSuccess &&
      kind !== ROLES_TOPIC.execFailure
    ) {
      // Every other event of this contract grants or changes something.
      return bad(`The history has an event that a Chronobox never emits: ${kind}`);
    }
  }
  const has = (key: Hex) =>
    allowedFor[key].every((entry) => {
      const target = entry.split(":")[0];
      return scoped.has(`${key}:${target}`.toLowerCase()) && granted.has(`${key}:${entry}`.toLowerCase());
    });
  const stopsRecovery = recovery !== null && allowedRecovery && scoped.has(`${CANCEL_ROLE}:${recovery}`.toLowerCase());
  if (!created) return bad("The start of the history is missing");
  if (!has(CANCEL_ROLE)) return bad("The cancel permission is missing");
  const wantCancel = [controller, ...(guard ? [guard.guardian] : [])].map((a) => a.toLowerCase());
  if (cancellers.size !== wantCancel.length || !wantCancel.every((a) => cancellers.has(a))) {
    return bad(`Addresses that can cancel: ${[...cancellers].join(", ") || "none"}`);
  }
  if (guard ? !has(COUNCIL_ROLE) || council.size !== 1 || !council.has(guard.council.toLowerCase()) : council.size !== 0) {
    return bad(`Addresses that can change the wallet without the wait: ${[...council].join(", ") || "none"}`);
  }
  return { ok: true, detail: `Read from the full event history of ${roles}`, stopsRecovery };
}

async function modulesOf(rpc: Rpc, address: Address): Promise<Address[] | null> {
  const [list, next] = await read(rpc, address, "getModulesPaginated(address,uint256)", [SENTINEL, 10n], ["address[]", "address"]);
  // More than one page means more modules than a Chronobox can have.
  return sameAddress(next as Address, SENTINEL) ? (list as Address[]) : null;
}

/**
 * One storage slot, read from the chain state itself. Never through the contract: the Safe's
 * getStorageAt runs in its singleton, and a fake singleton can answer anything.
 */
async function storageAt(rpc: Rpc, address: Address, slot: Hex | bigint): Promise<Hex> {
  const value = (await rpc("eth_getStorageAt", [address, toQuantity(typeof slot === "bigint" ? slot : toBigInt(slot)), "latest"])) as Hex;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`Bad answer to eth_getStorageAt for ${address}`);
  return value;
}

/**
 * The singleton of a SafeProxy: the code that every call to the Safe runs. It sits in slot 0 of
 * the proxy. The proxy code alone proves nothing, any singleton can stand behind it. Until this
 * is the official one, no answer of the Safe's own functions can be trusted.
 */
async function singletonOf(rpc: Rpc, safe: Address): Promise<Address> {
  return checksum(strip(await storageAt(rpc, safe, 0n)).padStart(64, "0").slice(-40));
}

/**
 * Is `council` the 2 of 2 Safe of this wallet and this guardian?
 *   A form: yes. It says whether the Safe is made, and whether the Recovery Delay is its module.
 *   null: no, and it does not look like one.   A text: it should be, and something is wrong with it.
 *
 * A Safe that is not made yet has one of two addresses: without the Recovery Delay, or with it.
 * Only that one Safe can ever exist at each of them.
 */
type CouncilForm = { made: boolean; recovery: boolean };
async function councilState(rpc: Rpc, safe: Address, council: Address, wallet: Address, guardian: Address): Promise<CouncilForm | string | null> {
  const code = await getCode(rpc, council);
  const withRecovery = sameAddress(council, predictCouncil(safe, wallet, guardian, true));
  const predicted = withRecovery || sameAddress(council, predictCouncil(safe, wallet, guardian));
  if (size(code) === 0) return predicted ? { made: false, recovery: withRecovery } : null;
  if (keccak(code) !== SAFE_PROXY_CODE_HASH) return null;
  // First the code behind the proxy. Before that, its answers about owners mean nothing.
  if (!sameAddress(await singletonOf(rpc, council), CONTRACTS.safeSingleton)) {
    return predicted ? `The Safe ${council} does not run the official Safe code` : null;
  }
  const [owners, threshold, modules, guard, handler] = await Promise.all([
    read(rpc, council, "getOwners()", [], ["address[]"]).then((r) => r[0] as Address[]),
    read(rpc, council, "getThreshold()", [], ["uint256"]).then((r) => r[0] as bigint),
    modulesOf(rpc, council),
    storageAt(rpc, council, GUARD_SLOT),
    storageAt(rpc, council, FALLBACK_SLOT),
  ]);
  const both = owners.length === 2 && owners.some((o) => sameAddress(o, wallet)) && owners.some((o) => sameAddress(o, guardian));
  // A Safe with other owners is not the Council Safe of this pair. The other order of the pair may fit.
  if (!both) return predicted ? `The owners of the Safe ${council} are not the wallet and the guardian` : null;
  if (threshold !== 2n) return `The Safe ${council} does not need both owners`;
  // No module, or one: the Recovery Delay of this Chronobox.
  const attached = modules !== null && modules.length === 1 && sameAddress(modules[0], predictRecoveryDelay(safe));
  if (modules === null || (modules.length > 0 && !attached) || toBigInt(guard) !== 0n || toBigInt(handler) !== 0n) {
    return `Something extra is attached to the Safe ${council}`;
  }
  return { made: true, recovery: attached };
}

/**
 * Can `predictCouncil(safe, wallet, guardian)` serve as the shared 2 of 2 Safe for this pair?
 * True when nothing is deployed there yet, or when a clean 2 of 2 Safe of exactly these two exists there.
 * False when an existing Safe at that address has other owners (e.g. after an earlier rotation).
 */
export async function councilCompatible(rpc: Rpc, safe: Address, wallet: Address, guardian: Address, withRecovery = false): Promise<boolean> {
  const state = await councilState(rpc, safe, predictCouncil(safe, wallet, guardian, withRecovery), wallet, guardian);
  return state !== null && typeof state !== "string";
}

/** History checks that passed, keyed by network + vault state. See where it is used. */
const passed = new WeakMap<Rpc, Map<string, History>>();

export async function inspect(rpc: Rpc, safe: Address, hints?: BlockHints): Promise<Inspection> {
  const result: Inspection = {
    safe,
    state: "invalid",
    checks: [],
    owners: [],
    delay: null,
    roles: null,
    controller: null,
    guardian: null,
    council: null,
    councilMade: false,
    councilRecovery: false,
    members: [],
    recoveryDelay: null,
    recovery: null,
    cooldown: 0n,
    expiration: 0n,
    txNonce: 0n,
    queueNonce: 0n,
  };
  const add = (id: string, ok: boolean, label: string, detail: string) => {
    result.checks.push({ id, ok, label, detail });
    return ok;
  };

  let code = await getCode(rpc, safe);
  if (size(code) === 0) {
    // One node of a wallet's network can be a few blocks behind. Ask once more before saying "nothing here".
    await new Promise((r) => setTimeout(r, 1200));
    code = await getCode(rpc, safe);
  }
  if (size(code) === 0) {
    result.state = "missing";
    return result;
  }
  if (!add("proxy", keccak(code) === SAFE_PROXY_CODE_HASH, "It is a genuine Safe", "Code hash of the contract")) {
    return result;
  }

  // The proxy code is the same for every Safe, whatever singleton stands behind it. Every call to
  // the Safe runs that singleton, so it is read from the chain state and checked before the Safe is
  // asked anything. A fake singleton could answer every question below the way a Chronobox would.
  const singleton = await singletonOf(rpc, safe);
  const singletonOk = add(
    "singleton",
    sameAddress(singleton, CONTRACTS.safeSingleton),
    "It runs the official Safe code",
    sameAddress(singleton, CONTRACTS.safeSingleton) ? CONTRACTS.safeSingleton : `Runs ${singleton}, not ${CONTRACTS.safeSingleton}`,
  );
  if (!singletonOk) return result;

  const [owners, threshold, modules, guard, handler] = await Promise.all([
    read(rpc, safe, "getOwners()", [], ["address[]"]).then((r) => r[0] as Address[]),
    read(rpc, safe, "getThreshold()", [], ["uint256"]).then((r) => r[0] as bigint),
    modulesOf(rpc, safe),
    storageAt(rpc, safe, GUARD_SLOT),
    storageAt(rpc, safe, FALLBACK_SLOT),
  ]);
  result.owners = owners;
  const cleanOk = add(
    "extras",
    toBigInt(guard) === 0n && toBigInt(handler) === 0n,
    "Nothing extra is attached to it",
    "Both storage slots are empty",
  );

  // Step 1 done, step 2 not done: a plain Safe that one wallet still owns.
  if (cleanOk && modules !== null && modules.length === 0 && owners.length === 1 && threshold === 1n && !sameAddress(owners[0], CONTRACTS.burn)) {
    result.state = "open";
    return result;
  }

  const ownerOk = add(
    "owner",
    owners.length === 1 && threshold === 1n && sameAddress(owners[0], CONTRACTS.burn),
    "No person and no key owns it",
    `Owner: ${owners.join(", ") || "none"}`,
  );

  // The modules: one Delay, and at most one Roles modifier. Nothing else.
  const codes = await Promise.all((modules ?? []).map((m) => getCode(rpc, m)));
  const delays = (modules ?? []).filter((_, i) => strip(codes[i]) === strip(DELAY_PROXY_CODE));
  const rolesList = (modules ?? []).filter((_, i) => strip(codes[i]) === strip(ROLES_PROXY_CODE));
  const moduleOk = add(
    "module",
    modules !== null && delays.length === 1 && rolesList.length <= 1 && delays.length + rolesList.length === modules.length,
    "The time lock is the only way out",
    modules === null ? "More than ten modules" : `Modules of the Safe: ${modules.join(", ") || "none"}`,
  );
  if (!moduleOk) return result;
  const delay = delays[0];
  const roles = rolesList[0] ?? null;
  result.delay = delay;
  result.roles = roles;

  const one = (target: Address, signature: string, type: string) => read(rpc, target, signature, [], [type]).then((r) => r[0]);
  const [owner, avatar, target, controllers, cooldown, expiration, txNonce, queueNonce, delayGuard] = await Promise.all([
    one(delay, "owner()", "address") as Promise<Address>,
    one(delay, "avatar()", "address") as Promise<Address>,
    one(delay, "target()", "address") as Promise<Address>,
    modulesOf(rpc, delay),
    one(delay, "txCooldown()", "uint256") as Promise<bigint>,
    one(delay, "txExpiration()", "uint256") as Promise<bigint>,
    one(delay, "txNonce()", "uint256") as Promise<bigint>,
    one(delay, "queueNonce()", "uint256") as Promise<bigint>,
    one(delay, "getGuard()", "address") as Promise<Address>,
  ]);
  Object.assign(result, { cooldown, expiration, txNonce, queueNonce });

  const wiringOk = add(
    "wiring",
    sameAddress(owner, safe) && sameAddress(avatar, safe) && sameAddress(target, safe),
    "Only the Chronobox itself can change the time lock",
    "Owner, avatar and target of the Vault Delay are the Safe",
  );
  // The Delay asks its guard before it executes anything. A guard could refuse every withdrawal for ever.
  const guardOk = add("delay-guard", sameAddress(delayGuard, ZERO), "Nothing can block a withdrawal", `Guard of the Vault Delay: ${sameAddress(delayGuard, ZERO) ? "none" : delayGuard}`);
  const controllerOk = add(
    "controller",
    controllers !== null && controllers.length === 1,
    "One wallet controls it",
    controllers === null ? "More than ten" : controllers.join(", ") || "none",
  );
  if (controllerOk && controllers) result.controller = controllers[0];
  const cooldownOk = add("cooldown", cooldown > 0n, "Every withdrawal has to wait", `${cooldown} seconds`);

  // The Recovery Delay is at one address. It is never a module of the Chronobox, so by itself it can do nothing.
  const parts = await recoveryParts(rpc, safe);
  result.recoveryDelay = parts;
  let recoveryOk = true;

  let cancelOk = true;
  let cancelUnknown = false;
  if (roles && controllerOk && result.controller) {
    const [rolesOwner, rolesAvatar, rolesTarget, members, rolesGuard] = await Promise.all([
      one(roles, "owner()", "address") as Promise<Address>,
      one(roles, "avatar()", "address") as Promise<Address>,
      one(roles, "target()", "address") as Promise<Address>,
      modulesOf(rpc, roles),
      (one(roles, "getGuard()", "address") as Promise<Address>).catch((error) => {
        if (isTemporary(error)) throw error;
        return ZERO;
      }),
    ]);
    const wiredOk = add(
      "cancel-wiring",
      sameAddress(rolesOwner, safe) && sameAddress(rolesAvatar, safe) && sameAddress(rolesTarget, safe),
      "Only the Chronobox itself can change who can cancel",
      `Owner, avatar and target of the Roles modifier ${roles} are the Safe`,
    );
    const rolesGuardOk = sameAddress(rolesGuard, ZERO)
      ? true
      : add("roles-guard", false, "Nothing can block a cancel", `Guard of the Roles modifier: ${rolesGuard}`);
    // One member: the wallet alone. Three: the wallet, a guardian, and the 2 of 2 Safe of the two.
    result.members = members ?? [];
    const controller = result.controller;
    let guard: Guard | null = null;
    let councilProblem: string | null = null;
    const others = (members ?? []).filter((m) => !sameAddress(m, controller));
    if (members !== null && members.length === 3 && others.length === 2) {
      for (const [guardian, council] of [others, [others[1], others[0]]] as [Address, Address][]) {
        const made = await councilState(rpc, safe, council, controller, guardian);
        if (made === null) continue;
        if (typeof made === "string") councilProblem ??= made;
        else {
          guard = { guardian, council };
          result.councilMade = made.made;
          result.councilRecovery = made.recovery;
          break;
        }
      }
    }
    const memberOk = add(
      "canceller",
      members !== null && ((members.length === 1 && sameAddress(members[0], controller)) || guard !== null),
      guard ? "Only that wallet and the guardian can cancel" : "Only that wallet can cancel",
      members === null ? "More than ten" : guard ? `Wallet ${controller}, guardian ${guard.guardian}` : members.join(", ") || "none",
    );
    if (guard) {
      result.guardian = guard.guardian;
      result.council = guard.council;
      add(
        "council",
        true,
        "A wallet change without the wait needs the wallet and the guardian together",
        (result.councilMade
          ? `The Safe ${guard.council} has these two owners and needs both`
          : `Only a Safe of these two, which needs both, can exist at ${guard.council}. It is not made yet.`) +
          (result.councilRecovery ? " Its one module is the Recovery Delay." : ""),
      );
    } else if (councilProblem) {
      add("council", false, "A wallet change without the wait needs the wallet and the guardian together", councilProblem);
    }
    // When the Council Safe has the Recovery Delay as its module and that Delay exists, any tampering
    // (wrong owner, guard, >10 modules) or active wiring must pass every recovery check — never
    // silently appear "off".
    const armed =
      guard !== null &&
      result.councilRecovery &&
      parts.deployed &&
      (!parts.sound || parts.modules.length > 0 || sameAddress(parts.target, guard.council) || sameAddress(parts.avatar, guard.council));
    if (guard && armed) {
      const wiringGood =
        parts.sound &&
        sameAddress(parts.avatar, guard.council) &&
        sameAddress(parts.target, guard.council) &&
        parts.modules.length === 1 &&
        sameAddress(parts.modules[0], guard.guardian) &&
        parts.cooldown > 0n;
      const wiringDetail = wiringGood
        ? `The Recovery Delay ${parts.delay}: the Chronobox owns it, it acts on the Council Safe, and only the guardian can use it. It waits ${parts.cooldown} seconds.`
        : !parts.sound
          ? `The Recovery Delay ${parts.delay} is not cleanly owned by this Chronobox, has a guard, or has more than ten modules`
          : !sameAddress(parts.avatar, guard.council) || !sameAddress(parts.target, guard.council)
            ? `The Recovery Delay ${parts.delay} does not point cleanly at the Council Safe ${guard.council}`
            : parts.modules.length !== 1 || !sameAddress(parts.modules[0], guard.guardian)
              ? `Modules of the Recovery Delay ${parts.delay}: ${parts.modules.join(", ") || "none"}`
              : `The Recovery Delay ${parts.delay} has no wait (${parts.cooldown} seconds)`;
      recoveryOk = add("recovery-wiring", wiringGood, "Only the guardian can start a recovery, and it waits", wiringDetail);
    }
    cancelOk = wiredOk && rolesGuardOk && memberOk;
    if (cancelOk) {
      // A history that passed is good until the network, members, txNonce, or council nonce change:
      // a permission can change only through the Delay (moving txNonce), through the shared 2 of 2
      // Safe (moving its nonce), or through the Recovery Delay, which acts on that Safe (moving its
      // own txNonce). Only a pass is kept, and only in memory when the chainId is known.
      //
      // That holds only for a Chronobox that passed every other check: above all, one that no person
      // owns. A Safe that still has an owner can change its Roles modifier directly, without the
      // Delay, and then burn its ownership. So a pass is kept, and used, only when everything else
      // passed. The Safe's own nonce is part of the key as well: every transaction of an owner moves it.
      const isolated = cleanOk && ownerOk && wiringOk && guardOk && controllerOk && cooldownOk && recoveryOk;
      const councilNonce = guard && result.councilMade ? ((await one(guard.council, "nonce()", "uint256")) as bigint) : 0n;
      const safeNonce = isolated ? ((await one(safe, "nonce()", "uint256")) as bigint) : 0n;
      const chainKey = hints?.chainId;
      const key =
        chainKey !== undefined && isolated
          ? `${chainKey}:${safe}:${safeNonce}:${roles}:${delay}:${controller}:${txNonce}:${councilNonce}:${result.members.join(",")}:${parts.txNonce}`.toLowerCase()
          : null;
      const kept = key ? passed.get(rpc)?.get(key) : undefined;
      const history = kept ?? (await verifyCancelPermission(rpc, roles, delay, controller, hints, guard, parts.delay));
      if (history?.ok && key && !kept) {
        if (!passed.has(rpc)) passed.set(rpc, new Map());
        passed.get(rpc)!.set(key, history);
      }
      const label = guard ? "Only cancel, and a wallet change by both, do not wait" : "Cancel is the only thing that does not wait";
      if (history === null) {
        cancelUnknown = true;
        result.checks.push({
          id: "cancel-only",
          ok: false,
          unknown: true,
          label,
          detail: "Your wallet's RPC did not return the event history of the Roles modifier. Use an RPC that serves old logs.",
        });
      } else {
        cancelOk = add("cancel-only", history.ok, label, history.detail);
        if (history.ok && armed && recoveryOk) {
          // A recovery that nobody can stop would be a way around the owner.
          recoveryOk = add(
            "recovery-stop",
            history.stopsRecovery === true,
            "The wallet and the guardian can stop a recovery at once",
            history.stopsRecovery ? "The right to cancel covers the line of the Recovery Delay" : "The right to cancel does not cover the line of the Recovery Delay",
          );
          if (recoveryOk) result.recovery = { delay: parts.delay, wait: parts.cooldown, expiration: parts.expiration, txNonce: parts.txNonce, queueNonce: parts.queueNonce };
        }
      }
    }
  }

  if (cleanOk && ownerOk && wiringOk && guardOk && controllerOk && cooldownOk && cancelOk && recoveryOk) {
    result.state = cancelUnknown ? "unverified" : "locked";
  }
  return result;
}

/** The Recovery Delay of a Chronobox as it is right after it is made: it points at the Chronobox, and nobody can use it. */
function freshRecoveryParts(safe: Address): RecoveryParts {
  return {
    delay: predictRecoveryDelay(safe),
    deployed: false,
    sound: true,
    avatar: safe,
    target: safe,
    modules: [],
    cooldown: DEFAULT_RECOVERY_WAIT,
    expiration: RECOVERY_EXPIRATION,
    txNonce: 0n,
    queueNonce: 0n,
  };
}

/** Reads the Recovery Delay of a Chronobox. It is at one address, and it may not be made yet. */
export async function recoveryParts(rpc: Rpc, safe: Address): Promise<RecoveryParts> {
  const address = predictRecoveryDelay(safe);
  const code = await getCode(rpc, address);
  if (strip(code) !== strip(DELAY_PROXY_CODE)) return freshRecoveryParts(safe);
  const one = (signature: string, type: string) => read(rpc, address, signature, [], [type]).then((r) => r[0]);
  const [owner, avatar, target, modules, cooldown, expiration, txNonce, queueNonce, guard] = await Promise.all([
    one("owner()", "address") as Promise<Address>,
    one("avatar()", "address") as Promise<Address>,
    one("target()", "address") as Promise<Address>,
    modulesOf(rpc, address),
    one("txCooldown()", "uint256") as Promise<bigint>,
    one("txExpiration()", "uint256") as Promise<bigint>,
    one("txNonce()", "uint256") as Promise<bigint>,
    one("queueNonce()", "uint256") as Promise<bigint>,
    one("getGuard()", "address") as Promise<Address>,
  ]);
  // More modules than one page is never a state of a Chronobox.
  const sound = sameAddress(owner, safe) && sameAddress(guard, ZERO) && modules !== null;
  return { delay: address, deployed: true, sound, avatar, target, modules: modules ?? [], cooldown, expiration, txNonce, queueNonce };
}

/** True when the setup of this Safe stopped after its first step: the wallet is still its only owner. */
export async function isHalfMade(rpc: Rpc, safe: Address, wallet: Address): Promise<boolean> {
  const [owners] = (await read(rpc, safe, "getOwners()", [], ["address[]"])) as [Address[]];
  return owners.length === 1 && sameAddress(owners[0], wallet);
}

/** Finds the vaults of a wallet on the connected chain. Stops at the first unused index. */
export async function discover(rpc: Rpc, wallet: Address, limit = 100): Promise<{ index: number; safe: Address }[]> {
  const found: { index: number; safe: Address }[] = [];
  for (let index = 0; index < limit; index++) {
    const safe = predictSafe(wallet, index);
    if (size(await getCode(rpc, safe)) === 0) break;
    found.push({ index, safe });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export type DelayTx = { to: Address; value: bigint; data: Hex; operation: number };

export type QueueItem = {
  nonce: bigint;
  createdAt: bigint;
  hash: Hex;
  /** Null when the transaction content could not be found in the logs. */
  tx: DelayTx | null;
};

export function delayTxHash(tx: DelayTx): Hex {
  return keccak(concat(tx.to, uintWord(tx.value), tx.data, tx.operation.toString(16).padStart(2, "0")));
}

function txFromLog(data: Hex): DelayTx {
  const [to, value, bytes, operation] = decode(["address", "uint256", "bytes", "uint8"], data);
  return { to: to as Address, value: value as bigint, data: bytes as Hex, operation: Number(operation) };
}

/** The transactions that a receipt added to the Delay queue. */
export function queuedInReceipt(receipt: Receipt, delay: Address): { nonce: bigint; tx: DelayTx }[] {
  return receipt.logs
    .filter((log) => sameAddress(log.address, delay) && log.topics[0] === TOPIC_TRANSACTION_ADDED)
    .map((log) => ({ nonce: toBigInt(log.topics[1]), tx: txFromLog(log.data) }));
}

async function blockTimestamp(rpc: Rpc, number: bigint): Promise<bigint> {
  const block = await rpc("eth_getBlockByNumber", [toQuantity(number), false]);
  if (!block) throw new Error(`Block ${number} is not available`);
  return toBigInt(block.timestamp);
}

/** The first block whose timestamp is at or after `timestamp`. */
export async function blockAtTimestamp(rpc: Rpc, timestamp: bigint): Promise<bigint> {
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  let hi = toBigInt(latest.number);
  const latestTime = toBigInt(latest.timestamp);
  if (latestTime < timestamp) throw new Error("Timestamp is in the future");

  // Bracket the target from the latest block backward, in growing steps.
  let lo = hi;
  let step = 64n;
  while (lo > 0n) {
    lo = lo > step ? lo - step : 0n;
    if ((await blockTimestamp(rpc, lo)) < timestamp) break;
    hi = lo;
    step *= 4n;
  }
  if (lo === 0n && (await blockTimestamp(rpc, 0n)) >= timestamp) return 0n;
  // Invariant: time(lo) < timestamp <= time(hi)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await blockTimestamp(rpc, mid)) < timestamp) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Looks up the content of a queued transaction in the Delay's logs and checks it against the stored hash. */
export async function findQueuedTx(rpc: Rpc, delay: Address, nonce: bigint, createdAt: bigint, hash: Hex): Promise<DelayTx | null> {
  const first = await blockAtTimestamp(rpc, createdAt);
  const latest = toBigInt(await rpc("eth_blockNumber", []));
  // Fast chains have several blocks with the same timestamp.
  const last = first + 40n > latest ? latest : first + 40n;
  const logs = (await rpc("eth_getLogs", [
    {
      address: delay,
      fromBlock: toQuantity(first),
      toBlock: toQuantity(last),
      topics: [TOPIC_TRANSACTION_ADDED, "0x" + uintWord(nonce)],
    },
  ])) as { data: Hex }[];
  for (const log of logs) {
    const tx = txFromLog(log.data);
    if (delayTxHash(tx) === hash) return tx;
  }
  return null;
}

export type TxCache = {
  get(nonce: bigint, hash: Hex): DelayTx | null;
  set(nonce: bigint, hash: Hex, tx: DelayTx): void;
};

/** Lookups that found nothing, and when. They are tried again later, not on every refresh. */
const notFound = new Map<string, number>();
const LOOK_AGAIN_MS = 120_000;

/**
 * How many items of the line are read. Only the oldest item can run next, so the front of the
 * line is what matters. A stolen wallet can queue as much as it likes, and every item costs
 * many reads: without a limit, a long line would keep the page busy for as long as it likes.
 * Everything after the limit is counted, not read, and one cancel removes it all (`cancelAllTx`).
 */
export const QUEUE_PAGE = 20;

/** How many items wait in the line. It needs no reads beyond the inspection. */
export function queueLength(inspection: Pick<Inspection, "txNonce" | "queueNonce">): bigint {
  return inspection.queueNonce > inspection.txNonce ? inspection.queueNonce - inspection.txNonce : 0n;
}

export type ReadQueueOptions = {
  /** At most this many items, from the front of the line. */
  limit?: number;
  /** Items read before. A queued item never changes, so one whose content was found is not read again. */
  known?: readonly QueueItem[];
  /** Called with the items read so far, oldest first, after each few. */
  onItems?: (items: QueueItem[]) => void;
};

/** Reads the pending queue items at the front of the line, oldest first. */
export async function readQueue(rpc: Rpc, inspection: Inspection, cache?: TxCache, options: ReadQueueOptions = {}): Promise<QueueItem[]> {
  const delay = inspection.delay;
  if (!delay) return [];
  const limit = BigInt(options.limit ?? QUEUE_PAGE);
  const end = inspection.queueNonce - inspection.txNonce > limit ? inspection.txNonce + limit : inspection.queueNonce;
  const nonces: bigint[] = [];
  for (let nonce = inspection.txNonce; nonce < end; nonce++) nonces.push(nonce);
  const known = new Map((options.known ?? []).filter((item) => item.tx !== null).map((item) => [item.nonce, item]));

  const one = async (nonce: bigint): Promise<QueueItem> => {
    const seen = known.get(nonce);
    if (seen) return seen;
    const [createdAt, hash] = await Promise.all([
      read(rpc, delay, "getTxCreatedAt(uint256)", [nonce], ["uint256"]).then((r) => r[0] as bigint),
      read(rpc, delay, "getTxHash(uint256)", [nonce], ["bytes32"]).then((r) => r[0] as Hex),
    ]);
    let tx = cache?.get(nonce, hash) ?? null;
    const key = `${delay.toLowerCase()}:${nonce}:${hash}`;
    const last = notFound.get(key);
    if (!tx && (last === undefined || Date.now() - last > LOOK_AGAIN_MS)) {
      try {
        tx = await findQueuedTx(rpc, delay, nonce, createdAt, hash);
        if (tx) cache?.set(nonce, hash, tx);
        // Only "it is not there" is remembered. A network that failed is asked again on the next refresh.
        if (tx) notFound.delete(key);
        else notFound.set(key, Date.now());
      } catch {
        tx = null;
      }
    }
    return { nonce, createdAt, hash, tx };
  };

  // A few at a time. The order of the line is the order of the numbers, not of the answers.
  const items: QueueItem[] = [];
  for (let i = 0; i < nonces.length; i += 3) {
    items.push(...(await Promise.all(nonces.slice(i, i + 3).map(one))));
    options.onItems?.([...items]);
  }
  return items;
}

export type ItemStatus = { phase: "waiting" | "ready" | "expired"; readyAt: bigint; expiresAt: bigint | null };

export function itemStatus(item: { createdAt: bigint }, cooldown: bigint, expiration: bigint, now: bigint): ItemStatus {
  const readyAt = item.createdAt + cooldown;
  const expiresAt = expiration === 0n ? null : readyAt + expiration;
  const phase = now < readyAt ? "waiting" : expiresAt !== null && now > expiresAt ? "expired" : "ready";
  return { phase, readyAt, expiresAt };
}

// ---------------------------------------------------------------------------
// What does a queued transaction do?
// ---------------------------------------------------------------------------

export type Action =
  | { kind: "withdraw"; token: Address | null; amount: bigint }
  | { kind: "change-delay"; cooldown: bigint }
  | { kind: "change-wallet"; to: Address }
  | { kind: "add-guardian"; guardian: Address; /** With a recovery: how long it waits. */ recoveryWait?: bigint }
  | { kind: "remove-guardian"; guardian: Address }
  | { kind: "set-recovery"; wait: bigint }
  | { kind: "remove-recovery" }
  | { kind: "transfer-elsewhere"; token: Address | null; to: Address; amount: bigint }
  | { kind: "settings"; label: string }
  | { kind: "unknown" };

const TRANSFER = selector("transfer(address,uint256)");

const SETTINGS: Record<string, string> = Object.fromEntries(
  (
    [
      ["setTxCooldown(uint256)", "Changes the delay"],
      ["setTxExpiration(uint256)", "Changes the execution window"],
      ["setTxNonce(uint256)", "Skips queued transactions"],
      ["enableModule(address)", "Gives another address control"],
      ["disableModule(address,address)", "Removes a controller"],
      ["transferOwnership(address)", "Changes who can configure the Delay"],
      ["setAvatar(address)", "Points the Delay at another account"],
      ["setTarget(address)", "Points the Delay at another account"],
      ["swapOwner(address,address,address)", "Gives the Safe a new owner"],
      ["addOwnerWithThreshold(address,uint256)", "Gives the Safe a new owner"],
      ["removeOwner(address,address,uint256)", "Removes a Safe owner"],
      ["changeThreshold(uint256)", "Changes the Safe threshold"],
      ["setGuard(address)", "Adds a guard to the Safe"],
      ["setFallbackHandler(address)", "Adds a fallback handler to the Safe"],
    ] as const
  ).map(([signature, label]) => [selector(signature), label]),
);

/**
 * Classifies a queued transaction. Only a plain transfer to the controller
 * wallet is a "withdraw". Everything else must be shown as a warning.
 */
export function classify(tx: DelayTx, vault: VaultParts): Action {
  // The changes that this app builds. Anything else that touches the vault is a warning.
  const next = firstNewWallet(tx);
  const swap = changeWalletTx(vault.delay, vault.controller, next, vault.roles ?? null, vault.safe, guardOf(vault), vault.recoveryOn ? (vault.recoveryDelay ?? null) : null);
  if (next && swap && sameTx(swap, tx)) return { kind: "change-wallet", to: next };
  if (vault.roles) {
    const guard = guardOf(vault);
    const parts = vault.recoveryDelay ?? null;
    if (guard) {
      const remove = removeGuardianTx(vault as Guarded);
      if (remove && sameTx(remove, tx)) return { kind: "remove-guardian", guardian: guard.guardian };
      if (parts) {
        const off = vault.recoveryOn ? removeRecoveryTx(vault as Guarded) : null;
        if (off && sameTx(off, tx)) return { kind: "remove-recovery" };
        const wait = recoveryWaitIn(tx, parts);
        const set = setRecoveryTx(vault as Guarded, wait);
        if (set && sameTx(set, tx)) return { kind: "set-recovery", wait };
      }
    } else {
      const guardian = newGuardian(tx, vault.roles);
      const base = { safe: vault.safe, delay: vault.delay, roles: vault.roles, controller: vault.controller };
      const adding = guardian ? addGuardianTx(base, guardian) : null;
      if (guardian && adding && sameTx(adding, tx)) return { kind: "add-guardian", guardian };
      if (guardian && parts) {
        const recoveryWait = recoveryWaitIn(tx, parts);
        const both = addGuardianTx(base, guardian, { parts, wait: recoveryWait });
        if (both && sameTx(both, tx)) return { kind: "add-guardian", guardian, recoveryWait };
      }
    }
  }
  if (tx.operation !== 0) return { kind: "unknown" };
  if (sameAddress(tx.to, vault.delay) && tx.value === 0n && size(tx.data) === 36 && tx.data.slice(0, 10).toLowerCase() === SET_TX_COOLDOWN) {
    const cooldown = toBigInt(tx.data.slice(10));
    if (cooldown > 0n) return { kind: "change-delay", cooldown };
  }
  if (size(tx.data) === 0) {
    return sameAddress(tx.to, vault.controller)
      ? { kind: "withdraw", token: null, amount: tx.value }
      : { kind: "transfer-elsewhere", token: null, to: tx.to, amount: tx.value };
  }
  const head = tx.data.slice(0, 10).toLowerCase();
  if (sameAddress(tx.to, vault.safe) || sameAddress(tx.to, vault.delay) || sameAddress(tx.to, vault.roles)) {
    return { kind: "settings", label: SETTINGS[head] ?? "Changes the vault in an unknown way" };
  }
  if (head === TRANSFER && size(tx.data) === 68 && tx.value === 0n) {
    try {
      const [to, amount] = decode(["address", "uint256"], "0x" + tx.data.slice(10)) as [Address, bigint];
      return sameAddress(to, vault.controller)
        ? { kind: "withdraw", token: tx.to, amount }
        : { kind: "transfer-elsewhere", token: tx.to, to, amount };
    } catch {
      return { kind: "unknown" };
    }
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Withdraw, execute, skip, deposit
// ---------------------------------------------------------------------------

/** The inner transaction of a withdrawal. The destination is always the controller wallet. */
export function withdrawalTx(controller: Address, token: Address | null, amount: bigint): DelayTx {
  if (amount <= 0n) throw new Error("The amount must be more than zero");
  return token === null
    ? { to: controller, value: amount, data: "0x", operation: 0 }
    : { to: token, value: 0n, data: call("transfer(address,uint256)", [controller, amount]), operation: 0 };
}

/** Queues a transaction on the Delay. Only the controller wallet can send this. */
export function queueTx(delay: Address, tx: DelayTx): TxRequest {
  return {
    to: delay,
    data: call("execTransactionFromModule(address,uint256,bytes,uint8)", [tx.to, tx.value, tx.data, tx.operation]),
  };
}

/** Executes the oldest queued transaction. Any wallet can send this after the delay. */
export function executeTx(delay: Address, tx: DelayTx): TxRequest {
  return {
    to: delay,
    data: call("executeNextTx(address,uint256,bytes,uint8)", [tx.to, tx.value, tx.data, tx.operation]),
  };
}

/** Removes expired transactions from the front of the queue. Any wallet can send this. */
export function skipExpiredTx(delay: Address): TxRequest {
  return { to: delay, data: call("skipExpired()") };
}

const SET_TX_COOLDOWN = selector("setTxCooldown(uint256)");

/** Changes the delay. Like everything else, the change itself waits the current delay. */
export function changeDelayTx(delay: Address, cooldown: bigint): DelayTx {
  if (cooldown < 1n) throw new Error("The delay must be longer than zero");
  return { to: delay, value: 0n, data: call("setTxCooldown(uint256)", [cooldown]), operation: 0 };
}

/** The parts of a Chronobox that the builders below need. With a guardian: who it is, the Council Safe, and the member list. */
export type VaultParts = {
  safe: Address;
  delay: Address;
  controller: Address;
  roles?: Address | null;
  guardian?: Address | null;
  council?: Address | null;
  members?: Address[];
  /** The Recovery Delay as it is now. Needed for everything about a recovery. */
  recoveryDelay?: RecoveryParts | null;
  /** True while a recovery is on. */
  recoveryOn?: boolean;
  /** True when the Council Safe has, or will have, the Recovery Delay as its module. */
  councilRecovery?: boolean;
};
type Guarded = {
  safe: Address;
  delay: Address;
  controller: Address;
  roles: Address;
  guardian: Address;
  council: Address;
  members: Address[];
  recoveryDelay?: RecoveryParts | null;
  recoveryOn?: boolean;
  councilRecovery?: boolean;
};
type GuardList = Guard & { members: Address[] };

function guardOf(vault: VaultParts): GuardList | null {
  return vault.guardian && vault.council && vault.members ? { guardian: vault.guardian, council: vault.council, members: vault.members } : null;
}

/**
 * The member list of the Roles modifier, as the contract keeps it: a new member goes to the
 * front, and to take one out the contract wants the address before it.
 */
class Members {
  list: Address[];
  constructor(list: readonly Address[]) {
    this.list = [...list];
  }
  add(address: Address) {
    if (!this.list.some((m) => sameAddress(m, address))) this.list.unshift(address);
  }
  /** Takes the member out and returns the address before it. */
  remove(address: Address): Address {
    const at = this.list.findIndex((m) => sameAddress(m, address));
    if (at < 0) throw new Error(`${address} is not a member`);
    this.list.splice(at, 1);
    return at === 0 ? SENTINEL : this.list[at - 1];
  }
}

const batchItem = (target: Address, data: Hex) => "00" + strip(target) + uintWord(0n) + uintWord(size(data)) + strip(data);
/** Several calls that the Safe runs as one step: a delegatecall into MultiSend. */
const batchTx = (items: string[]): DelayTx => ({ to: CONTRACTS.multiSend, value: 0n, data: call("multiSend(bytes)", [concat(...items)]), operation: 1 });
const assign = (member: Address, role: Hex, on: boolean) => call("assignRoles(address,bytes32[],bool[])", [member, [role], [on]]);

/**
 * Hands the vault to another wallet, in one step (a MultiSend batch that the
 * Safe runs as a delegatecall): the Safe enables the new wallet on the Delay
 * and disables the old one, and it moves the right to cancel the same way.
 * After it executes, only the new wallet can queue and cancel.
 *
 * With a guardian, the shared 2 of 2 Safe changes too: its role goes to the
 * Safe of the new wallet and the same guardian. The guardian can cancel this
 * while it waits, like everything else.
 *
 * With a recovery on (`recovery` is its Delay), the recovery stays on: the new Council Safe
 * has the Recovery Delay as its module, and that Delay now acts on the new Council Safe.
 */
export function changeWalletTx(
  delay: Address,
  from: Address,
  to: Address | null,
  roles: Address | null = null,
  safe: Address | null = null,
  guard: GuardList | null = null,
  recovery: Pick<RecoveryParts, "delay"> | null = null,
): DelayTx | null {
  // An address that nobody can sign with would lock the Chronobox for ever: its own parts, and the burn address.
  const dead = [ZERO, SENTINEL, delay, roles, safe, CONTRACTS.burn, CONTRACTS.multiSend, guard?.guardian, guard?.council, safe ? predictRecoveryDelay(safe) : null];
  if (!to || sameAddress(to, from) || dead.some((address) => sameAddress(to, address))) return null;
  const items = [
    batchItem(delay, call("enableModule(address)", [to])),
    // The new wallet is now first in the list, so it is the one "before" the old wallet.
    batchItem(delay, call("disableModule(address,address)", [to, from])),
  ];
  if (roles) {
    const members = new Members(guard?.members ?? [from]);
    members.add(to);
    items.push(batchItem(roles, assign(to, CANCEL_ROLE, true)), batchItem(roles, assign(from, CANCEL_ROLE, false)));
    items.push(batchItem(roles, call("disableModule(address,address)", [members.remove(from), from])));
    if (guard) {
      if (!safe) return null;
      const council = predictCouncil(safe, to, guard.guardian, recovery !== null);
      // If the new wallet's predicted council Safe is the same address as the current one (after an earlier rotation),
      // replacing it would immediately revoke and disable it. Require a fresh wallet or a hand-over with the guardian.
      if (sameAddress(council, guard.council)) return null;
      members.add(council);
      items.push(batchItem(roles, assign(council, COUNCIL_ROLE, true)), batchItem(roles, assign(guard.council, COUNCIL_ROLE, false)));
      items.push(batchItem(roles, call("disableModule(address,address)", [members.remove(guard.council), guard.council])));
      if (recovery) items.push(...pointRecoveryAt(recovery.delay, council));
    }
  }
  return batchTx(items);
}

/**
 * Adds a guardian, in one step that waits the delay like every change. After it:
 *   - the guardian can cancel what waits, like the wallet can, and nothing else alone,
 *   - the 2 of 2 Safe of wallet and guardian can hand the Chronobox to a new wallet at once.
 * That Safe is not made here. Its address can hold only that one Safe, and it is made the
 * first time it is needed. So nobody can make this step fail by making the Safe first.
 *
 * With `recovery`, the same step turns the recovery on: see `setRecoveryTx`. The recovery
 * Delay must be made before this step runs: see `recoveryDelayCreateTx`.
 */
export function addGuardianTx(
  vault: { safe: Address; delay: Address; roles: Address; controller: Address },
  guardian: Address | null,
  recovery: { parts: RecoveryParts; wait: bigint } | null = null,
): DelayTx | null {
  const { safe, delay, roles, controller } = vault;
  const dead = [ZERO, SENTINEL, delay, roles, safe, controller, CONTRACTS.burn, CONTRACTS.multiSend, CONTRACTS.safeProxyFactory, CONTRACTS.safeSingleton, predictRecoveryDelay(safe)];
  if (!guardian || dead.some((address) => sameAddress(guardian, address))) return null;
  const council = predictCouncil(safe, controller, guardian, recovery !== null);
  const on = recovery ? recoveryOnItems(safe, roles, guardian, council, recovery.parts, recovery.wait) : [];
  if (on === null) return null;
  const allow = (target: Address, fn: Hex) => batchItem(roles, call("allowFunction(bytes32,address,bytes4,uint8)", [COUNCIL_ROLE, target, fn, 0]));
  return batchTx([
    batchItem(roles, call("scopeTarget(bytes32,address)", [COUNCIL_ROLE, delay])),
    allow(delay, ENABLE_MODULE),
    allow(delay, DISABLE_MODULE),
    batchItem(roles, call("scopeTarget(bytes32,address)", [COUNCIL_ROLE, roles])),
    allow(roles, ASSIGN_ROLES),
    allow(roles, DISABLE_MODULE),
    batchItem(roles, assign(guardian, CANCEL_ROLE, true)),
    batchItem(roles, assign(council, COUNCIL_ROLE, true)),
    ...on,
  ]);
}

/** The guardian that an add-guardian batch names, read from its seventh call. Null for anything else. */
function newGuardian(tx: DelayTx, roles: Address): Address | null {
  const calls = batchCalls(tx);
  const seventh = calls?.[6];
  if (!calls || calls.length < 8 || !seventh || !sameAddress(seventh.to, roles) || seventh.data.slice(0, 10).toLowerCase() !== ASSIGN_ROLES) return null;
  try {
    return (decode(["address", "bytes32[]", "bool[]"], "0x" + seventh.data.slice(10)) as [Address])[0];
  } catch {
    return null;
  }
}

/** The calls of a MultiSend batch. Null when the transaction is not one, or when a call in it is not a plain call. */
function batchCalls(tx: DelayTx): { to: Address; data: Hex }[] | null {
  if (tx.operation !== 1 || !sameAddress(tx.to, CONTRACTS.multiSend) || tx.value !== 0n) return null;
  try {
    const [bytes] = decode(["bytes"], "0x" + tx.data.slice(10)) as [Hex];
    const data = strip(bytes);
    const calls: { to: Address; data: Hex }[] = [];
    for (let at = 0; at < data.length; ) {
      const length = Number(toBigInt("0x" + data.slice(at + 106, at + 170)));
      if (data.slice(at, at + 2) !== "00" || toBigInt("0x" + data.slice(at + 42, at + 106)) !== 0n) return null;
      calls.push({ to: checksum(data.slice(at + 2, at + 42)), data: ("0x" + data.slice(at + 170, at + 170 + length * 2)) as Hex });
      at += 170 + length * 2;
    }
    return calls;
  } catch {
    return null;
  }
}

/**
 * Takes the guardian out again: the right to cancel, and the role of the Council Safe. It waits
 * the delay, and the guardian can cancel it. That is what a guardian is for.
 */
export function removeGuardianTx(vault: {
  roles: Address;
  guardian: Address;
  council: Address;
  members: Address[];
  safe?: Address;
  recoveryDelay?: RecoveryParts | null;
  recoveryOn?: boolean;
}): DelayTx | null {
  const { roles, guardian, council } = vault;
  const members = new Members(vault.members);
  if (![guardian, council].every((a) => members.list.some((m) => sameAddress(m, a)))) return null;
  // A recovery is a power of the guardian. Without the guardian it goes too, in the same step.
  const recovery = vault.recoveryOn ? recoveryOffItems(vault) : [];
  if (recovery === null) return null;
  return batchTx([
    ...recovery,
    batchItem(roles, assign(guardian, CANCEL_ROLE, false)),
    batchItem(roles, assign(council, COUNCIL_ROLE, false)),
    batchItem(roles, call("disableModule(address,address)", [members.remove(guardian), guardian])),
    batchItem(roles, call("disableModule(address,address)", [members.remove(council), council])),
  ]);
}

// ---------------------------------------------------------------------------
// Recovery: the guardian alone can bring the Chronobox to a new wallet, after a long wait
// ---------------------------------------------------------------------------
//
// The parts:
//   - The Recovery Delay. The Chronobox owns it. It acts on the Council Safe of wallet and
//     guardian. The guardian is its one module, so only the guardian can put something into
//     its line. What is in the line can run after the wait, and anybody can send that.
//   - The Council Safe has the Recovery Delay as its one module, from its first moment.
// So after the wait the guardian can do alone what wallet and guardian can do together at
// once: change the wallet. The Council Safe has no right to move money, and so the guardian
// has none either. The wallet and the guardian can empty the line at once: that stops it.

const nonceCall = (nonce: bigint) => call("setTxNonce(uint256)", [nonce]);

/** The two calls that make the Recovery Delay act on this account. */
function pointRecoveryAt(recoveryDelay: Address, account: Address): string[] {
  return [batchItem(recoveryDelay, call("setAvatar(address)", [account])), batchItem(recoveryDelay, call("setTarget(address)", [account]))];
}

/**
 * The calls that turn the recovery on, for a Recovery Delay that nobody can use now.
 * `council` is the Council Safe that it will act on. That Safe must have, or get, the recovery
 * Delay as its module, or the recovery can never run.
 */
function recoveryOnItems(safe: Address, roles: Address, guardian: Address, council: Address, read: RecoveryParts, wait: bigint): string[] | null {
  if (wait < MIN_RECOVERY_WAIT || wait > MAX_RECOVERY_WAIT) return null;
  // Not made yet: it will be made before this step runs, and then it is as every new one is.
  const parts = read.deployed ? read : freshRecoveryParts(safe);
  // A Delay that somebody can already use, or that the Chronobox does not own, is not a state that this app makes.
  if (!parts.sound || parts.modules.length > 0) return null;
  const at = parts.delay;
  const items: string[] = [];
  // Whatever waited in that line when a recovery was turned off must never run. Nobody can add to the
  // line while the recovery is off, so the end of the line as it is now is its end when this runs.
  if (parts.queueNonce > parts.txNonce) items.push(batchItem(at, nonceCall(parts.queueNonce)));
  if (!sameAddress(parts.avatar, council)) items.push(batchItem(at, call("setAvatar(address)", [council])));
  if (!sameAddress(parts.target, council)) items.push(batchItem(at, call("setTarget(address)", [council])));
  if (parts.cooldown !== wait) items.push(batchItem(at, call("setTxCooldown(uint256)", [wait])));
  if (parts.expiration !== RECOVERY_EXPIRATION) items.push(batchItem(at, call("setTxExpiration(uint256)", [RECOVERY_EXPIRATION])));
  items.push(
    batchItem(at, call("enableModule(address)", [guardian])),
    // The right to cancel covers the new line too. Written again each time: it changes nothing when it is there.
    batchItem(roles, call("scopeTarget(bytes32,address)", [CANCEL_ROLE, at])),
    batchItem(roles, call("allowFunction(bytes32,address,bytes4,uint8)", [CANCEL_ROLE, at, SET_TX_NONCE, 0])),
  );
  return items;
}

/**
 * Turns the recovery on, or changes how long a recovery waits. One step in the line, so it
 * waits the delay and the guardian can cancel it.
 *
 * To turn it on, the Council Safe must be the one that has the Recovery Delay as its module.
 * If it is the other one, its role moves to that Safe in the same step. Then the recovery
 * Delay acts on that Safe, and the guardian becomes the one who can use it. The recovery
 * Delay must be made before this step runs: see `recoveryDelayCreateTx`.
 */
export function setRecoveryTx(vault: Guarded, wait: bigint): DelayTx | null {
  const { safe, roles, controller, guardian } = vault;
  const parts = vault.recoveryDelay;
  if (!parts || wait < MIN_RECOVERY_WAIT || wait > MAX_RECOVERY_WAIT) return null;
  if (vault.recoveryOn) {
    return parts.cooldown === wait ? null : { to: parts.delay, value: 0n, data: call("setTxCooldown(uint256)", [wait]), operation: 0 };
  }
  const items: string[] = [];
  let council = vault.council;
  if (!vault.councilRecovery) {
    council = predictCouncil(safe, controller, guardian, true);
    const members = new Members(vault.members);
    if (sameAddress(council, vault.council) || !members.list.some((m) => sameAddress(m, vault.council))) return null;
    members.add(council);
    items.push(batchItem(roles, assign(council, COUNCIL_ROLE, true)), batchItem(roles, assign(vault.council, COUNCIL_ROLE, false)));
    items.push(batchItem(roles, call("disableModule(address,address)", [members.remove(vault.council), vault.council])));
  }
  const on = recoveryOnItems(safe, roles, guardian, council, parts, wait);
  return on ? batchTx([...items, ...on]) : null;
}

/** The wait that a step names for the recovery. Without one in it: the wait that the Recovery Delay has, or is made with. */
function recoveryWaitIn(tx: DelayTx, parts: RecoveryParts): bigint {
  const calls = tx.operation === 0 && tx.value === 0n ? [{ to: tx.to, data: tx.data }] : (batchCalls(tx) ?? []);
  const cooldown = calls.find((c) => sameAddress(c.to, parts.delay) && c.data.slice(0, 10).toLowerCase() === SET_TX_COOLDOWN && size(c.data) === 36);
  return cooldown ? toBigInt("0x" + cooldown.data.slice(10)) : parts.deployed ? parts.cooldown : DEFAULT_RECOVERY_WAIT;
}

/**
 * The calls that turn a recovery off. The guardian can no longer use the Recovery Delay, and
 * the Delay points back at the Chronobox, where it can do nothing. So a recovery that waits
 * in its line when this runs can never be carried out.
 */
function recoveryOffItems(vault: { guardian: Address; safe?: Address; recoveryDelay?: RecoveryParts | null }): string[] | null {
  const { guardian, safe, recoveryDelay: parts } = vault;
  if (!safe || !parts || !parts.deployed) return null;
  const at = parts.modules.findIndex((m) => sameAddress(m, guardian));
  if (at < 0) return null;
  return [
    batchItem(parts.delay, call("disableModule(address,address)", [at === 0 ? SENTINEL : parts.modules[at - 1], guardian])),
    ...pointRecoveryAt(parts.delay, safe),
  ];
}

/** Turns the recovery off. It waits the delay, and the guardian can cancel it. */
export function removeRecoveryTx(vault: Guarded): DelayTx | null {
  const items = recoveryOffItems(vault);
  return items ? batchTx(items) : null;
}

/** The owners of the Council Safe, in the contract's order. For a Safe that is not made yet: the order it will be made with. */
export async function councilOwnersNow(rpc: Rpc, vault: { council: Address; controller: Address; guardian: Address }, made: boolean): Promise<Address[]> {
  return made ? councilOwners(rpc, vault.council) : [vault.controller, vault.guardian];
}

/**
 * What a recovery is: the same step that wallet and guardian sign together to change the wallet
 * at once (see `councilSwapTx`), to the wallet that the guardian chooses. The guardian puts it
 * into the line of the Recovery Delay (`queueTx` on that Delay). After the wait anybody can
 * carry it out (`executeTx` on that Delay), and the Council Safe must be made by then.
 * Null without a recovery, and for a wallet that cannot take a Chronobox.
 */
export function recoveryTx(vault: Guarded, owners: readonly Address[], to: Address | null, cancelUpTo: bigint): CouncilTx | null {
  if (!vault.recoveryOn || !vault.recoveryDelay || sameAddress(to, vault.recoveryDelay.delay)) return null;
  return councilSwapTx(vault, owners, to, cancelUpTo);
}

/** The new wallet and the point of the line that a wallet change of the Council Safe names. Null for anything else. */
function swapRequestIn(tx: DelayTx, roles: Address): SwapRequest | null {
  const calls = batchCalls(tx);
  if (!calls || calls.length < 4) return null;
  const inner = (at: number, fn: Hex): string | null => {
    const one = calls[at];
    if (!sameAddress(one.to, roles) || one.data.slice(0, 10).toLowerCase() !== WITH_ROLE) return null;
    try {
      const [, , data] = decode(["address", "uint256", "bytes", "uint8", "bytes32", "bool"], "0x" + one.data.slice(10)) as [Address, bigint, Hex];
      return data.slice(0, 10).toLowerCase() === fn && size(data) === 36 ? data.slice(10) : null;
    } catch {
      return null;
    }
  };
  const to = inner(0, ENABLE_MODULE);
  const upTo = inner(3, SET_TX_NONCE);
  if (to === null || upTo === null) return null;
  try {
    return { to: checksum(to.slice(24)), upTo: toBigInt("0x" + upTo) };
  } catch {
    return null;
  }
}

export type RecoveryItem = {
  nonce: bigint;
  createdAt: bigint;
  hash: Hex;
  /** What waits. Null when the network did not give it. */
  tx: DelayTx | null;
  /** The wallet that it brings the Chronobox to. Null for anything that is not a recovery as this app makes it now. */
  wallet: Address | null;
};

export type ReadRecoveryOptions = {
  /** At most this many items, from the front of the line. */
  limit?: number;
  /** Items read before. A queued item never changes, so one whose content was found is not read again. */
  known?: readonly RecoveryItem[];
};

/**
 * What waits in the line of the Recovery Delay, oldest first. Usually nothing, or one recovery.
 * Each item is read back and compared with the recovery that this app builds for the same
 * wallet, for the Chronobox as it is now. Only an exact match is called a recovery.
 */
export async function readRecoveryLine(
  rpc: Rpc,
  vault: Guarded,
  owners: readonly Address[],
  cache?: TxCache,
  options: ReadRecoveryOptions | number = {},
): Promise<RecoveryItem[]> {
  const parts = vault.recoveryDelay;
  if (!parts || !parts.deployed) return [];
  const opts: ReadRecoveryOptions = typeof options === "number" ? { limit: options } : options;
  const limit = opts.limit ?? 5;
  const known = new Map((opts.known ?? []).filter((item) => item.tx !== null).map((item) => [item.nonce, item]));
  const items: RecoveryItem[] = [];
  for (let nonce = parts.txNonce; nonce < parts.queueNonce && items.length < limit; nonce++) {
    const seen = known.get(nonce);
    let createdAt: bigint;
    let hash: Hex;
    let tx: DelayTx | null;
    if (seen) {
      ({ createdAt, hash, tx } = seen);
    } else {
      [createdAt, hash] = await Promise.all([
        read(rpc, parts.delay, "getTxCreatedAt(uint256)", [nonce], ["uint256"]).then((r) => r[0] as bigint),
        read(rpc, parts.delay, "getTxHash(uint256)", [nonce], ["bytes32"]).then((r) => r[0] as Hex),
      ]);
      tx = cache?.get(nonce, hash) ?? null;
      const key = `${parts.delay.toLowerCase()}:${nonce}:${hash}`;
      const last = notFound.get(key);
      if (!tx && (last === undefined || Date.now() - last > LOOK_AGAIN_MS)) {
        try {
          tx = await findQueuedTx(rpc, parts.delay, nonce, createdAt, hash);
          if (tx) {
            cache?.set(nonce, hash, tx);
            notFound.delete(key);
          } else {
            notFound.set(key, Date.now());
          }
        } catch {
          tx = null;
        }
      }
    }
    const asked = tx ? swapRequestIn(tx, vault.roles) : null;
    const rebuilt = asked ? councilSwapTx(vault, owners, asked.to, asked.upTo) : null;
    items.push({ nonce, createdAt, hash, tx, wallet: tx && asked && rebuilt && sameTx(rebuilt, tx) ? asked.to : null });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Wallet and guardian together: a new wallet at once
// ---------------------------------------------------------------------------

/** A transaction of the shared 2 of 2 Safe. */
export type CouncilTx = { to: Address; value: bigint; data: Hex; operation: number };

/** What the owner asks the guardian to agree to: the new wallet, and the point of the line that the change cancels up to. */
export type SwapRequest = { to: Address; upTo: bigint };

/**
 * What wallet and guardian sign together: the Chronobox goes to a new wallet, now. The shared
 * Safe uses its role to enable the new wallet on the Delay and disable the old one, moves the
 * right to cancel, and replaces the old wallet with the new one among its own two owners.
 * `owners` is the owner list of the Council Safe, in the contract's order.
 *
 * The same step empties the line: a lost wallet may have queued withdrawals before the owner
 * noticed, and those would still run after the wait. Once the old wallet is disabled it cannot
 * queue anything more, so in the same transaction the Council Safe gives itself the cancel role,
 * sets the Delay's txNonce to `cancelUpTo` (the queueNonce when the request was read), and gives
 * the role back. That call may fail without stopping the change (the line may have moved since
 * the signatures), so a caller must still read the line afterwards: see `delayNonces`.
 *
 * `cancelUpTo` is fixed once, when the owner asks, and travels with the request (see
 * `SwapRequest`). Never derive it from the line at the time of reading: a lost wallet can move
 * the line, and with it the hash that the guardian agreed to.
 */
export function councilSwapTx(vault: Guarded, owners: readonly Address[], to: Address | null, cancelUpTo: bigint): CouncilTx | null {
  const { delay, roles, controller: from, council, guardian } = vault;
  const dead = [ZERO, SENTINEL, delay, roles, vault.safe, council, guardian, CONTRACTS.burn, CONTRACTS.multiSend, predictRecoveryDelay(vault.safe)];
  if (!to || sameAddress(to, from) || dead.some((address) => sameAddress(to, address))) return null;
  const ownerAt = owners.findIndex((o) => sameAddress(o, from));
  if (ownerAt < 0) return null;
  const members = new Members(vault.members);
  members.add(to);
  const withRole = (target: Address, data: Hex, role: Hex = COUNCIL_ROLE, mustWork = true) =>
    batchItem(roles, call(WITH_ROLE_SIGNATURE, [target, 0n, data, 0, role, mustWork]));
  return batchTx([
    withRole(delay, call("enableModule(address)", [to])),
    withRole(delay, call("disableModule(address,address)", [to, from])),
    // Everything the old wallet queued goes. The Delay refuses a txNonce that is not ahead of the
    // current one, or that is past the queue: then nothing is left to cancel from this snapshot,
    // and the change must still go through.
    withRole(roles, assign(council, CANCEL_ROLE, true)),
    withRole(delay, call("setTxNonce(uint256)", [cancelUpTo]), CANCEL_ROLE, false),
    withRole(roles, assign(council, CANCEL_ROLE, false)),
    withRole(roles, assign(to, CANCEL_ROLE, true)),
    withRole(roles, assign(from, CANCEL_ROLE, false)),
    withRole(roles, call("disableModule(address,address)", [members.remove(from), from])),
    batchItem(council, call("swapOwner(address,address,address)", [ownerAt === 0 ? SENTINEL : owners[ownerAt - 1], from, to])),
  ]);
}

/**
 * What a swap request does to the line as it stands now. The guardian checks this before agreeing.
 * The point of the line comes from a link, and the old wallet can make that link: it is one of
 * the two owners of the Council Safe, so it can also carry out whatever the guardian agrees to.
 *   - "impossible": the point is past the end of the line. No real request names it.
 *   - "uncovered": `left` items wait that the change would not cancel, and the first of them has
 *     waited too long already: it could run soon after the change. Cancel them first.
 *   - "ok": the change cancels `cancels` items. `left` items come after the point; each of them
 *     still has at least half of the delay to wait (until `runsAt` at the earliest). They are
 *     cancelled after the change, and nobody can stop that: see below.
 *
 * Why the guardian may agree while young items are left. A lost wallet can queue at any moment,
 * also right after any read and after any cancel, so "nothing is left" can never be a condition
 * of agreeing: the person with the lost wallet could keep the owner and the guardian from ever
 * changing the wallet. The change itself takes the old wallet away from the Delay and takes its
 * right to cancel. From then on, only the new wallet can queue, and the new wallet and the
 * guardian can cancel. A single cancel then removes everything, and nothing can come after it.
 * What the old wallet queued just before can only run after the full delay, so there is time.
 * Only an item that is already old must go before the guardian agrees, and a lost wallet cannot
 * make an old item: anything it queues instead is new.
 *
 * `first` is about the item at the point where the change stops cancelling: when it was queued,
 * the time now, and the delay. Items after it were queued later. Without `first`, any item left
 * counts as "uncovered".
 */
export type SwapCoverage =
  | { state: "impossible" }
  | { state: "uncovered"; left: bigint }
  | { state: "ok"; cancels: bigint; left: bigint; runsAt: bigint | null };

export function swapCoverage(
  upTo: bigint,
  line: { txNonce: bigint; queueNonce: bigint },
  first?: { createdAt: bigint; now: bigint; cooldown: bigint },
): SwapCoverage {
  const { txNonce, queueNonce } = line;
  if (upTo > queueNonce) return { state: "impossible" };
  const reach = upTo > txNonce ? upTo : txNonce;
  const cancels = reach - txNonce;
  if (reach >= queueNonce) return { state: "ok", cancels, left: 0n, runsAt: null };
  const left = queueNonce - reach;
  // Young: at most half of the delay has gone by. Rounded so that a one-second delay is never young.
  if (first && first.now >= first.createdAt && (first.now - first.createdAt) * 2n <= first.cooldown && first.cooldown > 0n) {
    return { state: "ok", cancels, left, runsAt: first.createdAt + first.cooldown };
  }
  return { state: "uncovered", left };
}

/** `swapCoverage` with everything it needs read from the chain. */
export async function readSwapCoverage(rpc: Rpc, delay: Address, upTo: bigint): Promise<SwapCoverage> {
  const line = await delayNonces(rpc, delay);
  const reach = upTo > line.txNonce ? upTo : line.txNonce;
  if (upTo > line.queueNonce || reach >= line.queueNonce) return swapCoverage(upTo, line);
  const [createdAt, cooldown, now] = await Promise.all([
    read(rpc, delay, "getTxCreatedAt(uint256)", [reach], ["uint256"]).then((r) => r[0] as bigint),
    read(rpc, delay, "txCooldown()", [], ["uint256"]).then((r) => r[0] as bigint),
    chainTime(rpc),
  ]);
  return swapCoverage(upTo, line, { createdAt, now, cooldown });
}

/** Where the line of the Delay stands: items from txNonce up to queueNonce wait, or can run. */
export async function delayNonces(rpc: Rpc, delay: Address): Promise<{ txNonce: bigint; queueNonce: bigint }> {
  const [txNonce, queueNonce] = await Promise.all([
    read(rpc, delay, "txNonce()", [], ["uint256"]).then((r) => r[0] as bigint),
    read(rpc, delay, "queueNonce()", [], ["uint256"]).then((r) => r[0] as bigint),
  ]);
  return { txNonce, queueNonce };
}

const SAFE_EXEC = "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)";

export async function councilOwners(rpc: Rpc, council: Address): Promise<Address[]> {
  return (await read(rpc, council, "getOwners()", [], ["address[]"]))[0] as Address[];
}

/** The hash that both owners agree to. The Council Safe computes it, so it holds for this Safe, this network and its next transaction only. */
export async function councilHash(rpc: Rpc, council: Address, tx: CouncilTx): Promise<Hex> {
  const [nonce] = (await read(rpc, council, "nonce()", [], ["uint256"])) as [bigint];
  const [hash] = await read(
    rpc,
    council,
    "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)",
    [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, ZERO, ZERO, nonce],
    ["bytes32"],
  );
  return hash as Hex;
}

/** One owner agrees, on chain. Nothing has to travel back to the other owner. */
export function councilApproveTx(council: Address, hash: Hex): TxRequest {
  return { to: council, data: call("approveHash(bytes32)", [hash]) };
}

export async function councilApproved(rpc: Rpc, council: Address, owner: Address, hash: Hex): Promise<boolean> {
  const [value] = (await read(rpc, council, "approvedHashes(address,bytes32)", [owner, hash], ["uint256"])) as [bigint];
  return value !== 0n;
}

/**
 * Carries the change out. The sender must be one owner, and the other must have agreed on
 * chain. The Safe wants one entry for each owner, in the order of their addresses.
 */
export function councilExecTx(council: Address, tx: CouncilTx, owners: readonly Address[]): TxRequest {
  const sorted = [...owners].sort((a, b) => (toBigInt(a) < toBigInt(b) ? -1 : 1));
  const signatures = concat(...sorted.map((owner) => word(owner) + uintWord(0n) + "01"));
  return { to: council, data: call(SAFE_EXEC, [tx.to, tx.value, tx.data, tx.operation, 0n, 0n, 0n, ZERO, ZERO, signatures]) };
}

/**
 * Cancels the queue item with this nonce and every item before it. Nothing
 * moves. Only the hot wallet can send this: the Roles modifier makes the
 * Safe call setTxNonce on the Delay.
 */
export function cancelTx(roles: Address, delay: Address, nonce: bigint): TxRequest {
  return {
    to: roles,
    data: call("execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)", [
      delay,
      0n,
      call("setTxNonce(uint256)", [nonce + 1n]),
      0,
      CANCEL_ROLE,
      true,
    ]),
  };
}

/**
 * Cancels the whole line as it was read: everything before `queueNonce`. It needs only the two
 * numbers of the inspection, not what the items are, so a line too long to read can still be
 * stopped at once. Null when nothing waits. Something queued after the read is not covered:
 * it shows up on the next read, and waits its full delay like everything else.
 */
export function cancelAllTx(roles: Address, delay: Address, line: Pick<Inspection, "txNonce" | "queueNonce">): TxRequest | null {
  return line.queueNonce > line.txNonce ? cancelTx(roles, delay, line.queueNonce - 1n) : null;
}

/** The wallet that a change-wallet batch would enable, read from its first call. Null for anything else. */
function firstNewWallet(tx: DelayTx): Address | null {
  if (tx.operation !== 1 || !sameAddress(tx.to, CONTRACTS.multiSend)) return null;
  // multiSend(bytes): selector, offset, length, then the first item: op (1) to (20) value (32) length (32) data.
  const data = strip(tx.data);
  const firstCall = data.slice(8 + 128 + 2 + 40 + 64 + 64);
  if (firstCall.slice(0, 8) !== strip(ENABLE_MODULE) || firstCall.length < 72) return null;
  try {
    return checksum(firstCall.slice(8 + 24, 8 + 64));
  } catch {
    return null;
  }
}

function sameTx(a: DelayTx, b: DelayTx): boolean {
  return sameAddress(a.to, b.to) && a.value === b.value && a.operation === b.operation && strip(a.data) === strip(b.data);
}

export function depositTx(safe: Address, token: Address | null, amount: bigint): TxRequest {
  if (amount <= 0n) throw new Error("The amount must be more than zero");
  return token === null
    ? { to: safe, data: "0x", value: amount }
    : { to: token, data: call("transfer(address,uint256)", [safe, amount]) };
}

// ---------------------------------------------------------------------------
// Balances and tokens
// ---------------------------------------------------------------------------

export async function nativeBalance(rpc: Rpc, address: Address): Promise<bigint> {
  return toBigInt(await rpc("eth_getBalance", [address, "latest"]));
}

export async function tokenBalance(rpc: Rpc, token: Address, holder: Address): Promise<bigint> {
  const [balance] = await read(rpc, token, "balanceOf(address)", [holder], ["uint256"]);
  return balance as bigint;
}

const AGGREGATE3 = selector("aggregate3((address,bool,bytes)[])");

/**
 * Many read calls in one request, through Multicall3. The answer has one
 * entry for each call: the returned data, or null where that call failed.
 * Throws when the request as a whole fails.
 */
export async function readMany(rpc: Rpc, calls: readonly { to: Address; data: Hex }[]): Promise<(Hex | null)[]> {
  if (calls.length === 0) return [];
  // One entry is (target, allowFailure = true, bytes callData).
  const entries = calls.map((c) => {
    const data = strip(c.data);
    return word(strip(c.to)) + uintWord(1n) + uintWord(96n) + uintWord(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  });
  let offset = calls.length * 32;
  const offsets = entries.map((entry) => {
    const at = uintWord(offset);
    offset += entry.length / 2;
    return at;
  });
  const out = strip(await ethCall(rpc, CONTRACTS.multicall3, (AGGREGATE3 + uintWord(32n) + uintWord(calls.length) + offsets.join("") + entries.join("")) as Hex));
  const numberAt = (byte: number): number => {
    const w = out.slice(byte * 2, byte * 2 + 64);
    if (w.length !== 64) throw new Error("The answer to a combined read is too short");
    const n = toBigInt(w);
    if (n > BigInt(out.length)) throw new Error("The answer to a combined read is not valid");
    return Number(n);
  };
  const start = numberAt(0);
  if (numberAt(start) !== calls.length) throw new Error("The answer to a combined read has the wrong length");
  const base = start + 32;
  return calls.map((_, i) => {
    const at = base + numberAt(base + i * 32);
    const ok = numberAt(at) !== 0;
    const bytesAt = at + numberAt(at + 32);
    const length = numberAt(bytesAt);
    const data = out.slice((bytesAt + 32) * 2, (bytesAt + 32 + length) * 2);
    if (data.length !== length * 2) throw new Error("The answer to a combined read is too short");
    return ok ? (("0x" + data) as Hex) : null;
  });
}

/** How many balances go into one request. Small enough for the read limits of the networks that wallets use. */
const BALANCES_PER_READ = 100;

export type Balances = {
  /** One entry for each asset. Null where the balance is not known. That is never "nothing". */
  balances: (bigint | null)[];
  /** False when a combined read failed and only the main assets were read one by one. */
  complete: boolean;
};

/**
 * The balances of one address for a long list of assets, in a few requests.
 * When a combined read fails, the main assets are read one by one, and the
 * others stay "not known".
 */
export async function readBalances(rpc: Rpc, holder: Address, assets: readonly { token: Address | null; main?: boolean }[]): Promise<Balances> {
  const balances: (bigint | null)[] = assets.map(() => null);
  let complete = true;
  const groups: number[][] = [];
  for (let i = 0; i < assets.length; i += BALANCES_PER_READ) groups.push(assets.slice(i, i + BALANCES_PER_READ).map((_, k) => i + k));
  await Promise.all(
    groups.map(async (group) => {
      try {
        const answers = await readMany(
          rpc,
          group.map((i) => {
            const token = assets[i].token;
            return token ? { to: token, data: call("balanceOf(address)", [holder]) } : { to: CONTRACTS.multicall3, data: call("getEthBalance(address)", [holder]) };
          }),
        );
        group.forEach((i, k) => {
          const answer = answers[k];
          // An address with no token behind it answers with nothing. That is not a balance of zero.
          balances[i] = answer !== null && size(answer) >= 32 ? toBigInt(strip(answer).slice(0, 64)) : null;
        });
      } catch {
        complete = false;
        await Promise.all(
          group
            .filter((i) => assets[i].main)
            .map(async (i) => {
              const token = assets[i].token;
              balances[i] = await (token ? tokenBalance(rpc, token, holder) : nativeBalance(rpc, holder)).catch(() => null);
            }),
        );
      }
    }),
  );
  return { balances, complete };
}

/** Reads symbol and decimals of a token. Returns null when the address is not an ERC-20 token. */
export async function readToken(rpc: Rpc, token: Address): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const [decimals] = await read(rpc, token, "decimals()", [], ["uint8"]);
    const raw = await ethCall(rpc, token, call("symbol()"));
    let symbol: string;
    try {
      symbol = decode(["string"], raw)[0] as string;
    } catch {
      // Some old tokens return bytes32.
      symbol = new TextDecoder().decode(Uint8Array.from(strip(raw).match(/../g) ?? [], (b) => parseInt(b, 16))).replace(/\0/g, "");
    }
    symbol = symbol.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 12);
    if (!symbol || Number(decimals) > 36) return null;
    return { symbol, decimals: Number(decimals) };
  } catch (error) {
    // "The network did not answer" is not "there is no token here".
    if (isTemporary(error)) throw error;
    return null;
  }
}

const TOPIC_TRANSFER = topic("Transfer(address,address,uint256)");

/** How much of a token a mined transaction moved to an address, by the token's own Transfer events. */
export function arrivedInReceipt(receipt: Receipt, token: Address, to: Address): bigint {
  let sum = 0n;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, token) || log.topics[0] !== TOPIC_TRANSFER || log.topics.length < 3) continue;
    if (sameAddress(("0x" + log.topics[2].slice(-40)) as Address, to)) sum += toBigInt(log.data);
  }
  return sum;
}

/**
 * How much coin to leave in a wallet so that it can still pay for a simple transaction: a
 * generous amount of gas at twice the price of now. With no price from the network, a fixed amount.
 */
export async function feeReserve(rpc: Rpc, fallback = 5_000_000_000_000_000n): Promise<bigint> {
  try {
    const price = toBigInt(await rpc("eth_gasPrice", []));
    if (price > 0n) return price * 2n * 150_000n;
  } catch {
    // Fall through.
  }
  return fallback;
}
