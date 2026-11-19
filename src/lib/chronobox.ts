/**
 * Everything Chronobox does on chain: build the setup transactions, check a
 * vault, read the queue, build withdrawals.
 *
 * A Chronobox is three things:
 *   - a Safe 1.4.1 that holds the funds. Its only owner is a burn address.
 *   - a Zodiac Delay modifier. Every transaction that goes through it waits
 *     the delay. It is the only way to move funds or change the vault.
 *   - the setup wallet, the only module of the Delay. It is the control unit:
 *     it can queue any transaction.
 * One thing does not wait: cancel. The Delay lets only its owner (the Safe)
 * remove a queued transaction, and the owner can also set the delay to zero.
 * So a Zodiac Roles modifier sits beside the Delay with exactly one
 * permission: the setup wallet can make the Safe call setTxNonce on the
 * Delay. It cannot move funds and it cannot change anything else.
 * Nothing here is custom contract code.
 */
import { call, decode, encode, selector, topic } from "./abi.ts";
import { CONTRACTS, SENTINEL, ZERO } from "./chains.ts";
import { assertWallet, isTemporary } from "./wallet.ts";
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

function minimalProxyAddress(mastercopy: Address, initializer: Hex): Address {
  const salt = keccak(concat(keccak(initializer), uintWord(SALT_BASE)));
  const initCode = concat(MINIMAL_PROXY_DEPLOY, MINIMAL_PROXY_PREFIX, mastercopy, MINIMAL_PROXY_SUFFIX);
  return create2(CONTRACTS.moduleProxyFactory, salt, keccak(initCode));
}

/** The Roles modifier is owned by the Safe. So its one permission can change only through the Delay queue. */
export function rolesInitializer(safe: Address): Hex {
  return call("setUp(bytes)", [encode(["address", "address", "address"], [safe, safe, safe])]);
}

export function predictRoles(safe: Address): Address {
  return minimalProxyAddress(CONTRACTS.rolesMastercopy, rolesInitializer(safe));
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
 * Step 2: one Safe transaction, sent by the owner wallet, that
 *   1. deploys the Delay (owner, avatar and target are the Safe),
 *   2. deploys the Roles modifier (owner, avatar and target are the Safe) and
 *      gives it one permission: the wallet can call setTxNonce on the Delay,
 *   3. enables the Delay and the Roles modifier as the modules of the Safe,
 *   4. enables the wallet as the only module of the Delay,
 *   5. replaces the wallet as Safe owner with the burn address,
 *   6. if the user chose to contribute: passes the contribution, which the
 *      wallet sends along with this transaction, on to its receiver.
 * All of it happens together or not at all.
 */
export function lockTx(
  wallet: Address,
  safe: Address,
  cooldown: bigint,
  expiration: bigint = EXPIRATION_SECONDS,
  contribution: Contribution | null = null,
): TxRequest {
  if (contribution && (contribution.amount <= 0n || sameAddress(contribution.to, safe) || sameAddress(contribution.to, ZERO))) {
    throw new Error("The contribution is not valid");
  }
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
    ...(contribution ? [{ to: contribution.to, data: "0x" as Hex, value: contribution.amount }] : []),
  ], contribution?.amount ?? 0n);
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
): TxRequest[] {
  const safe = predictSafe(wallet, index);
  return [
    ...(created ? [] : [createTx(wallet, index)]),
    lockTx(wallet, safe, cooldown, EXPIRATION_SECONDS, contribution),
    ...deposits.map((d) => depositTx(safe, d.token, d.amount)),
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
  const request: Record<string, string> = { from, to: tx.to, data: tx.data };
  if (tx.value && tx.value > 0n) request.value = toQuantity(tx.value);
  // Estimate first: a transaction that would fail is stopped before the wallet
  // asks for a signature, and a plain transfer to a Safe gets enough gas.
  const estimate = toBigInt(await rpc("eth_estimateGas", [request]));
  request.gas = toQuantity((estimate * 5n) / 4n + 10_000n);
  const hash = (await rpc("eth_sendTransaction", [request])) as Hex;
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
  /** The setup wallet: the one address that can queue transactions, and cancel them. */
  controller: Address | null;
  cooldown: bigint;
  expiration: bigint;
  txNonce: bigint;
  queueNonce: bigint;
};

/** Remembers in which block a contract was created, so its logs are read from there. */
export type BlockHints = {
  get(address: Address): bigint | null;
  set(address: Address, block: bigint): void;
};

type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex };

/** Sizes of the pieces, largest first. Networks differ in the range they accept. */
const LOG_CHUNKS = [50_000n, 10_000n];
const LOG_CHUNKS_MAX = 400n;

/**
 * Every log of one contract from a block to now. Many wallet networks refuse a wide range, so
 * when the one query fails and the start is known, the range is read in pieces. With no known
 * start, or a range too long to read in pieces, it throws: the caller then says "could not check".
 */
async function logsOf(rpc: Rpc, address: Address, from: bigint | null): Promise<Log[]> {
  try {
    return (await rpc("eth_getLogs", [{ address, fromBlock: from === null ? "0x0" : toQuantity(from), toBlock: "latest" }])) as Log[];
  } catch (error) {
    if (from === null) throw error;
    const latest = toBigInt(await rpc("eth_blockNumber", []));
    if (latest < from) throw error;
    let last: unknown = error;
    for (const chunk of LOG_CHUNKS) {
      if ((latest - from) / chunk >= LOG_CHUNKS_MAX) continue;
      const ranges: [bigint, bigint][] = [];
      for (let start = from; start <= latest; start += chunk) ranges.push([start, start + chunk - 1n > latest ? latest : start + chunk - 1n]);
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

/**
 * Proves what the Roles modifier allows, from its whole event history.
 *
 * The contract has no function that lists its permissions, so the state alone
 * cannot show that there is no second, wider permission. The events can:
 * every function that grants or changes something emits one. The history
 * must hold only the cancel permission on this Delay, and the role must end
 * with exactly one member: the setup wallet.
 *
 * Returns null when the RPC cannot provide the history.
 */
export async function verifyCancelPermission(
  rpc: Rpc,
  roles: Address,
  delay: Address,
  controller: Address,
  hints?: BlockHints,
): Promise<{ ok: boolean; detail: string } | null> {
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
  const bad = (detail: string) => ({ ok: false, detail });
  const members = new Set<string>();
  let created = false;
  let scoped = false;
  let allowed = false;

  for (const log of logs) {
    const kind = log.topics[0];
    if (kind === ROLES_TOPIC.setup) {
      created = true;
      hints?.set(roles, toBigInt(log.blockNumber));
    } else if (kind === ROLES_TOPIC.assignRoles) {
      const [member, keys, flags] = decode(["address", "bytes32[]", "bool[]"], log.data) as [Address, Hex[], boolean[]];
      if (keys.length !== 1 || keys[0] !== CANCEL_ROLE || flags.length !== 1) return bad(`A role other than "cancel" was assigned to ${member}`);
      if (flags[0]) members.add(member.toLowerCase());
      else members.delete(member.toLowerCase());
    } else if (kind === ROLES_TOPIC.scopeTarget) {
      const [key, target] = decode(["bytes32", "address"], log.data) as [Hex, Address];
      if (key !== CANCEL_ROLE || !sameAddress(target, delay)) return bad(`A permission on another contract exists: ${target}`);
      scoped = true;
    } else if (kind === ROLES_TOPIC.allowFunction) {
      const [key, target, fn, options] = decode(["bytes32", "address", "bytes4", "uint8"], log.data) as [Hex, Address, Hex, bigint];
      if (key !== CANCEL_ROLE || !sameAddress(target, delay) || fn !== SET_TX_NONCE || options !== 0n) {
        return bad(`A permission other than cancel exists: ${fn} on ${target}`);
      }
      allowed = true;
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
  if (!created) return bad("The start of the history is missing");
  if (!scoped || !allowed) return bad("The cancel permission is missing");
  if (members.size !== 1 || !members.has(controller.toLowerCase())) {
    return bad(`Addresses that can cancel: ${[...members].join(", ") || "none"}`);
  }
  return { ok: true, detail: `Read from the full event history of ${roles}` };
}

async function modulesOf(rpc: Rpc, address: Address): Promise<Address[] | null> {
  const [list, next] = await read(rpc, address, "getModulesPaginated(address,uint256)", [SENTINEL, 10n], ["address[]", "address"]);
  // More than one page means more modules than a Chronobox can have.
  return sameAddress(next as Address, SENTINEL) ? (list as Address[]) : null;
}

async function safeSlot(rpc: Rpc, safe: Address, slot: Hex | bigint): Promise<Hex> {
  const [bytes] = await read(rpc, safe, "getStorageAt(uint256,uint256)", [typeof slot === "bigint" ? slot : toBigInt(slot), 1n], ["bytes"]);
  return bytes as Hex;
}

/** History checks that passed, per wallet connection (so per network). See where it is used. */
const passed = new WeakMap<Rpc, Map<string, { ok: boolean; detail: string }>>();

export async function inspect(rpc: Rpc, safe: Address, hints?: BlockHints): Promise<Inspection> {
  const result: Inspection = {
    safe,
    state: "invalid",
    checks: [],
    owners: [],
    delay: null,
    roles: null,
    controller: null,
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

  const [singleton, owners, threshold, modules, guard, handler] = await Promise.all([
    safeSlot(rpc, safe, 0n),
    read(rpc, safe, "getOwners()", [], ["address[]"]).then((r) => r[0] as Address[]),
    read(rpc, safe, "getThreshold()", [], ["uint256"]).then((r) => r[0] as bigint),
    modulesOf(rpc, safe),
    safeSlot(rpc, safe, GUARD_SLOT),
    safeSlot(rpc, safe, FALLBACK_SLOT),
  ]);
  result.owners = owners;

  const singletonOk = add(
    "singleton",
    sameAddress(("0x" + strip(singleton).slice(-40)) as Address, CONTRACTS.safeSingleton),
    "It runs the official Safe code",
    CONTRACTS.safeSingleton,
  );
  const cleanOk = add(
    "extras",
    toBigInt(guard) === 0n && toBigInt(handler) === 0n,
    "Nothing extra is attached to it",
    "Both storage slots are empty",
  );

  // Step 1 done, step 2 not done: a plain Safe that one wallet still owns.
  if (singletonOk && cleanOk && modules !== null && modules.length === 0 && owners.length === 1 && threshold === 1n && !sameAddress(owners[0], CONTRACTS.burn)) {
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
    "Owner, avatar and target of the Delay are the Safe",
  );
  // The Delay asks its guard before it executes anything. A guard could refuse every withdrawal for ever.
  const guardOk = add("delay-guard", sameAddress(delayGuard, ZERO), "Nothing can block a withdrawal", `Guard of the Delay: ${sameAddress(delayGuard, ZERO) ? "none" : delayGuard}`);
  const controllerOk = add(
    "controller",
    controllers !== null && controllers.length === 1,
    "One wallet controls it",
    controllers === null ? "More than ten" : controllers.join(", ") || "none",
  );
  if (controllerOk && controllers) result.controller = controllers[0];
  const cooldownOk = add("cooldown", cooldown > 0n, "Every withdrawal has to wait", `${cooldown} seconds`);

  let cancelOk = true;
  let cancelUnknown = false;
  if (roles && controllerOk && result.controller) {
    const [rolesOwner, rolesAvatar, rolesTarget, members] = await Promise.all([
      one(roles, "owner()", "address") as Promise<Address>,
      one(roles, "avatar()", "address") as Promise<Address>,
      one(roles, "target()", "address") as Promise<Address>,
      modulesOf(rpc, roles),
    ]);
    const wiredOk = add(
      "cancel-wiring",
      sameAddress(rolesOwner, safe) && sameAddress(rolesAvatar, safe) && sameAddress(rolesTarget, safe),
      "Only the Chronobox itself can change who can cancel",
      `Owner, avatar and target of the Roles modifier ${roles} are the Safe`,
    );
    const memberOk = add(
      "canceller",
      members !== null && members.length === 1 && sameAddress(members[0], result.controller),
      "Only that wallet can cancel",
      members === null ? "More than ten" : members.join(", ") || "none",
    );
    cancelOk = wiredOk && memberOk;
    if (cancelOk) {
      // The permission can change only through the Delay, and that moves txNonce. So a history that
      // passed is good until txNonce moves. Only a pass is kept, and only in memory.
      const key = `${safe}:${roles}:${delay}:${result.controller}:${txNonce}`.toLowerCase();
      const kept = passed.get(rpc)?.get(key);
      const history = kept ?? (await verifyCancelPermission(rpc, roles, delay, result.controller, hints));
      if (history?.ok && !kept) {
        if (!passed.has(rpc)) passed.set(rpc, new Map());
        passed.get(rpc)!.set(key, history);
      }
      if (history === null) {
        cancelUnknown = true;
        result.checks.push({
          id: "cancel-only",
          ok: false,
          unknown: true,
          label: "Cancel is the only thing that does not wait",
          detail: "Your wallet's RPC did not return the event history of the Roles modifier. Use an RPC that serves old logs.",
        });
      } else {
        cancelOk = add("cancel-only", history.ok, "Cancel is the only thing that does not wait", history.detail);
      }
    }
  }

  if (singletonOk && cleanOk && ownerOk && wiringOk && guardOk && controllerOk && cooldownOk && cancelOk) {
    result.state = cancelUnknown ? "unverified" : "locked";
  }
  return result;
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

/** Reads every pending queue item, oldest first. */
export async function readQueue(rpc: Rpc, inspection: Inspection, cache?: TxCache): Promise<QueueItem[]> {
  const delay = inspection.delay;
  if (!delay) return [];
  const nonces: bigint[] = [];
  for (let nonce = inspection.txNonce; nonce < inspection.queueNonce; nonce++) nonces.push(nonce);

  const one = async (nonce: bigint): Promise<QueueItem> => {
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
  for (let i = 0; i < nonces.length; i += 3) items.push(...(await Promise.all(nonces.slice(i, i + 3).map(one))));
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
export function classify(tx: DelayTx, vault: { safe: Address; delay: Address; controller: Address; roles?: Address | null }): Action {
  // The two changes that this app builds. Anything else that touches the vault is a warning.
  const next = firstNewWallet(tx);
  const swap = changeWalletTx(vault.delay, vault.controller, next, vault.roles ?? null, vault.safe);
  if (next && swap && sameTx(swap, tx)) return { kind: "change-wallet", to: next };
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

/**
 * Hands the vault to another wallet, in one step (a MultiSend batch that the
 * Safe runs as a delegatecall): the Safe enables the new wallet on the Delay
 * and disables the old one, and it moves the right to cancel the same way.
 * After it executes, only the new wallet can queue and cancel.
 */
export function changeWalletTx(delay: Address, from: Address, to: Address | null, roles: Address | null = null, safe: Address | null = null): DelayTx | null {
  // An address that nobody can sign with would lock the Chronobox for ever: its own parts, and the burn address.
  const dead = [ZERO, SENTINEL, delay, roles, safe, CONTRACTS.burn];
  if (!to || sameAddress(to, from) || dead.some((address) => sameAddress(to, address))) return null;
  const item = (target: Address, data: Hex) => "00" + strip(target) + uintWord(0n) + uintWord(size(data)) + strip(data);
  const batch = concat(
    item(delay, call("enableModule(address)", [to])),
    // The new wallet is now first in the list, so it is the one "before" the old wallet.
    item(delay, call("disableModule(address,address)", [to, from])),
    ...(roles
      ? [
          item(roles, call("assignRoles(address,bytes32[],bool[])", [to, [CANCEL_ROLE], [true]])),
          item(roles, call("assignRoles(address,bytes32[],bool[])", [from, [CANCEL_ROLE], [false]])),
          item(roles, call("disableModule(address,address)", [to, from])),
        ]
      : []),
  );
  return { to: CONTRACTS.multiSend, value: 0n, data: call("multiSend(bytes)", [batch]), operation: 1 };
}

/**
 * Cancels the queue item with this nonce and every item before it. Nothing
 * moves. Only the setup wallet can send this: the Roles modifier makes the
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

const ENABLE_MODULE = selector("enableModule(address)");

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
export async function feeReserve(rpc: Rpc): Promise<bigint> {
  try {
    const price = toBigInt(await rpc("eth_gasPrice", []));
    if (price > 0n) return price * 2n * 150_000n;
  } catch {
    // Fall through.
  }
  return 5_000_000_000_000_000n;
}
