/**
 * Wallet discovery (EIP-6963) and a thin EIP-1193 wrapper.
 * The app has no RPC of its own. Every read and every transaction goes
 * through the wallet the user connected.
 */
import { type Chain } from "./chains.ts";
import { type Address, checksum, toQuantity } from "./hex.ts";
import type { Rpc, TxRequest } from "./chronobox.ts";

export type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
};

export type WalletOption = {
  id: string;
  name: string;
  icon: string | null;
  provider: Provider;
};

/** Collects the wallets that announce themselves in this page. */
export function watchWallets(onChange: (wallets: WalletOption[]) => void): () => void {
  const found = new Map<string, WalletOption>();
  const publish = () => onChange([...found.values()]);

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent).detail as
      | { info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Provider }
      | undefined;
    if (!detail?.provider || !detail.info?.name) return;
    const id = detail.info.rdns || detail.info.uuid || detail.info.name;
    // Only data: icons. A wallet must not make this page load a remote image.
    const icon = detail.info.icon?.startsWith("data:image/") ? detail.info.icon : null;
    found.set(id, { id, name: detail.info.name, icon, provider: detail.provider });
    publish();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Older wallets only set window.ethereum.
  const timer = setTimeout(() => {
    const legacy = (window as { ethereum?: Provider }).ethereum;
    if (found.size === 0 && legacy) {
      found.set("injected", { id: "injected", name: "Browser wallet", icon: null, provider: legacy });
      publish();
    }
  }, 400);

  return () => {
    clearTimeout(timer);
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  };
}

// ---------------------------------------------------------------------------
// A wallet's RPC is not ours. It can be slow, busy, or silent.
// ---------------------------------------------------------------------------

/** A read that got no answer in time. */
export class RpcTimeout extends Error {
  constructor(method: string) {
    super(`No answer to ${method} in time`);
    this.name = "RpcTimeout";
  }
}

/**
 * Requests that only read. They can be asked again without harm, so they get a time limit and
 * are tried again when the failure looks temporary. A request that makes the wallet ask its owner
 * something (connect, switch network, send) has no time limit: a person may take minutes.
 */
const READS = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_chainId",
  "eth_accounts",
  "eth_estimateGas",
  "eth_gasPrice",
  "wallet_getCallsStatus",
  "wallet_getCapabilities",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function messageOf(error: unknown): string {
  const e = error as { message?: string; shortMessage?: string; data?: { message?: string; originalError?: { message?: string } }; cause?: { message?: string } } | null;
  return String(e?.data?.originalError?.message || e?.data?.message || e?.shortMessage || e?.cause?.message || e?.message || error || "");
}

function errorCode(error: unknown): number | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown }; data?: { code?: unknown; originalError?: { code?: unknown } } } | null;
  for (const candidate of [e?.data?.originalError?.code, e?.cause?.code, e?.code, e?.data?.code]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

/** Would the same request probably work a moment later? */
export function isTemporary(error: unknown, method = ""): boolean {
  if (error instanceof RpcTimeout) return true;
  const code = errorCode(error);
  const text = messageOf(error).toLowerCase();
  if (code === 4001 || code === 4100 || code === -32601 || code === -32602) return false;
  if (/revert|user rejected|user denied|insufficient funds|invalid opcode|out of gas/.test(text)) return false;
  // A log query that is too wide is refused in many words, some with the code of a rate limit. Asking again does not help.
  if (method === "eth_getLogs" && /range|more than|too many results|limited to|exceed|block count|response size/.test(text)) return false;
  if (code === 429 || code === -32005) return true;
  return /rate limit|too many requests|timeout|timed out|temporar|unavailable|overloaded|busy|failed to fetch|network error|networkerror|bad gateway|gateway time|header not found|\b50[234]\b|\b429\b/.test(text);
}

function withLimit<T>(promise: Promise<T>, ms: number, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RpcTimeout(method)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type RpcLimits = { timeoutMs?: number; tries?: number; waitMs?: number };

/** The wallet as an RPC: reads have a time limit and are tried again on a temporary failure. */
export function rpcOf(provider: Provider, limits: RpcLimits = {}): Rpc {
  const tries = limits.tries ?? 4;
  const wait = limits.waitMs ?? 600;
  return async (method, params = []) => {
    if (!READS.has(method)) return provider.request({ method, params });
    const limit = limits.timeoutMs ?? (method === "eth_getLogs" ? 30_000 : 20_000);
    let last: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        return await withLimit(provider.request({ method, params }), limit, method);
      } catch (error) {
        last = error;
        if (!isTemporary(error, method) || attempt === tries - 1) break;
        await sleep(wait * 2 ** attempt);
      }
    }
    throw last;
  };
}

/** The wallet is on another network or another account than the page thinks. */
export class WalletMoved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletMoved";
  }
}

/**
 * Checks, directly before something is sent, that the wallet is still on the network and the
 * account that the page shows. A person can change both in the wallet at any time.
 */
export async function assertWallet(rpc: Rpc, account: Address, chainId: number, chainName = "the network of this page"): Promise<void> {
  const now = Number(BigInt((await rpc("eth_chainId")) as string));
  if (now !== chainId) throw new WalletMoved(`Your wallet is on another network now. Switch it back to ${chainName}, then try again.`);
  const accounts = ((await rpc("eth_accounts")) as string[] | null) ?? [];
  if (!accounts[0] || accounts[0].toLowerCase() !== account.toLowerCase()) {
    throw new WalletMoved("Your wallet is on another account now. Switch it back to the account you started with, then try again.");
  }
}

export async function accountsOf(provider: Provider, prompt: boolean): Promise<Address[]> {
  const list = (await provider.request({ method: prompt ? "eth_requestAccounts" : "eth_accounts" })) as string[];
  return (list ?? []).map((a) => checksum(a));
}

export async function chainIdOf(provider: Provider): Promise<number> {
  return Number(BigInt((await provider.request({ method: "eth_chainId" })) as string));
}

export async function switchChain(provider: Provider, chain: Chain): Promise<void> {
  const chainId = toQuantity(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    const missing = errorCode(error) === 4902 || /unrecognized chain|unknown chain|not been added/i.test(messageOf(error));
    if (!missing) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: { name: chain.native.symbol, symbol: chain.native.symbol, decimals: 18 },
          rpcUrls: [chain.publicRpc],
          blockExplorerUrls: [chain.explorer],
        },
      ],
    });
  }
}

/**
 * Asks the wallet to sign a typed message (EIP-712). It costs nothing and sends nothing.
 * The answer is the signature as the wallet gave it. A refusal is thrown.
 */
export async function signTyped(provider: Provider, account: Address, data: object): Promise<string> {
  const signature = await provider.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(data)] });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]*$/.test(signature)) throw new Error("The wallet did not give a signature");
  return signature;
}

/**
 * Can this wallet send several calls as one atomic transaction (EIP-5792) today?
 * True for smart contract wallets such as a Safe, and for accounts that already
 * have EIP-7702 code. A wallet that does not know the method is a plain wallet.
 */
export async function canBatch(provider: Provider, account: Address, chainId: number): Promise<boolean> {
  try {
    const id = toQuantity(chainId);
    const all = (await provider.request({ method: "wallet_getCapabilities", params: [account, [id]] })) as Record<string, any> | null;
    const entry = all?.[id] ?? all?.[id.toLowerCase()] ?? all?.[String(chainId)];
    const status = entry?.atomic?.status;
    // "ready" means a plain account that the wallet would upgrade to a smart account when the
    // first batch is sent. Chronobox does not start that: what kind of account the wallet is
    // stays the owner's choice. Such an account takes the plain path.
    return status === "supported" || entry?.atomicBatch?.supported === true;
  } catch {
    return false;
  }
}

/**
 * Sends calls as one atomic transaction and waits until it is on chain.
 * A multisig can take hours to collect its signatures. `onWaiting` is called
 * once the wallet has accepted the batch.
 */
export async function sendBatch(
  provider: Provider,
  account: Address,
  chainId: number,
  calls: TxRequest[],
  onWaiting?: () => void,
  shouldStop?: () => boolean,
): Promise<{ blockNumber: bigint | null }> {
  return waitForBatch(provider, await sendCalls(provider, account, chainId, calls), onWaiting, shouldStop);
}

/** Gives the calls to the wallet as one atomic batch. Returns the id of the batch. */
export async function sendCalls(provider: Provider, account: Address, chainId: number, calls: TxRequest[]): Promise<string> {
  // A call that only sends ETH has no data. Wallets reject "0x" there, so the field is left out.
  const list = calls.map((c) => ({ to: c.to, ...(c.data === "0x" ? {} : { data: c.data }), value: toQuantity(c.value ?? 0n) }));
  const base = { from: account, chainId: toQuantity(chainId), calls: list };
  let result: unknown;
  try {
    result = await provider.request({ method: "wallet_sendCalls", params: [{ version: "2.0.0", atomicRequired: true, ...base }] });
  } catch (error) {
    // Only a wallet that does not know version 2 of the standard gets the first draft. Any other
    // failure may come after the owner approved, and a second request could send the batch twice.
    const code = errorCode(error);
    const unknownVersion = code === -32602 || code === 5700 || /version|atomicrequired|unsupported|not supported/i.test(messageOf(error));
    if (!unknownVersion) throw error;
    try {
      result = await provider.request({ method: "wallet_sendCalls", params: [{ version: "1.0", ...base }] });
    } catch (second) {
      throw isRejection(second) ? second : error;
    }
  }
  const id = typeof result === "string" ? result : (result as { id?: string })?.id;
  if (!id) throw new Error("Your wallet did not confirm that it took the request. Look in your wallet before you try again.");
  return id;
}

/**
 * Waits until the batch with this id is on chain. A batch that the wallet still
 * holds is waited for again, not sent again: some wallets (Ambire) put a second
 * request into the same transaction as the first.
 */
export async function waitForBatch(
  provider: Provider,
  id: string,
  onWaiting?: () => void,
  shouldStop?: () => boolean,
): Promise<{ blockNumber: bigint | null }> {
  onWaiting?.();
  const rpc = rpcOf(provider);
  let misses = 0;
  for (;;) {
    let status = null as CallsStatus | null;
    try {
      status = (await rpc("wallet_getCallsStatus", [id])) as CallsStatus | null;
      misses = 0;
    } catch (error) {
      // One bad answer is not the end of a batch that may already be on chain. A wallet that
      // keeps failing has lost the batch: the caller then looks at the chain itself.
      if (!isTemporary(error) && ++misses >= 5) throw new BatchUnknown();
    }
    const code = status?.status;
    const done = code === 200 || code === "CONFIRMED";
    const partly = code === 600;
    const failed = (typeof code === "number" && code >= 400 && code !== 600) || code === "FAILED" || code === "REVERTED";
    const receipt = status?.receipts?.[status.receipts.length - 1];
    if (partly) throw new BatchUnknown();
    if (failed || (done && receipt?.status !== undefined && BigInt(receipt.status) !== 1n)) {
      throw new Error("The transaction failed on chain. Nothing was created and nothing was deposited.");
    }
    if (done) return { blockNumber: receipt?.blockNumber ? BigInt(receipt.blockNumber) : null };
    if (shouldStop?.()) throw new BatchUnknown();
    await sleep(2000);
  }
}

type CallsStatus = { status?: number | string; receipts?: { blockNumber?: string; status?: string }[] };

/** The wallet cannot say what became of a batch. The chain has the answer. */
export class BatchUnknown extends Error {
  constructor() {
    super("Your wallet cannot say what happened to the request.");
    this.name = "BatchUnknown";
  }
}

/** Did the person say no in the wallet? Then nothing was sent. */
export function isRejection(error: unknown): boolean {
  const code = errorCode(error);
  return code === 4001 || /user rejected|user denied|rejected the request|user cancel/.test(messageOf(error).toLowerCase());
}

const GENERIC = "Your wallet or its network did not answer as expected. Try again.";

/** Reasons that the contracts give, in plain words. */
const REASONS: [RegExp, string][] = [
  [/still in cooldown/i, "This withdrawal is still waiting. It cannot be collected yet."],
  [/transaction expired/i, "This withdrawal has expired. It can no longer be collected."],
  [/hashes do not match/i, "This is not the next withdrawal in line. Reload the page to see the line as it is now."],
  [/module transaction failed/i, "The withdrawal itself cannot be carried out now. The Chronobox may not hold enough of this asset, or the token refuses the transfer. Cancel it to let the items behind it go on."],
  [/GS013/, "The Chronobox refused this step. Reload the page and look at its state before you try again."],
  [/GS02[0-9]|GS03[0-9]/, "Your wallet is not allowed to do this with this Chronobox."],
  [/not authorized|NotAuthorized|NoMembership|ConditionViolation/i, "Your wallet is not allowed to do this with this Chronobox."],
  [/create2 call failed/i, "This Chronobox exists already, or your wallet has the setup twice in one request. Reject the request in your wallet, reload the page and start again."],
];

/** A short, plain message for an error that came from a wallet or an RPC. */
export function errorText(error: unknown): string {
  const e = error as { code?: number; name?: string; message?: string } | null;
  const code = errorCode(error);
  const text = messageOf(error);
  const lower = text.toLowerCase();

  if (error instanceof WalletMoved || error instanceof BatchUnknown || e?.name === "Replaced" || e?.name === "StoppedWaiting") return text;
  if (code === 4001 || /user rejected|user denied|rejected the request|user cancel/.test(lower)) return "You rejected the request in your wallet.";
  if (code === -32002 || /already pending|already processing/.test(lower)) return "Your wallet already has a request open. Open your wallet and answer it.";
  if (code === 4100 || /unauthorized|not been authorized/.test(lower)) return "Your wallet did not allow this. Unlock it and connect this page again.";
  if (code === 4900 || code === 4901 || /disconnected from/.test(lower)) return "Your wallet is not connected to the network. Check its connection, then try again.";
  if (code === 4902 || /unrecognized chain/.test(lower)) return "Your wallet does not know this network. Add the network in your wallet, then try again.";
  if (error instanceof RpcTimeout || /timed out|timeout/.test(lower)) return "Your wallet's network did not answer in time. Try again.";
  if (/insufficient funds|insufficient balance for transfer|exceeds balance/.test(lower)) return "Your wallet does not have enough for this amount and the network fee.";
  if (code === 429 || code === -32005 || /rate limit|too many requests/.test(lower)) return "Your wallet's network is busy and refused the request. Wait a moment, then try again.";
  if (/unavailable|bad gateway|gateway time|failed to fetch|network error|networkerror|\b50[234]\b/.test(lower)) {
    return "Your wallet's network cannot be reached now. Check your connection, then try again.";
  }
  if (/nonce too low|replacement transaction underpriced|already known|transaction underpriced/.test(lower)) {
    return "Your wallet has another transaction in progress. Wait until it is done, then try again.";
  }
  if (code === 5740) return "This is too much for your wallet to send in one go. Add less at once.";
  if (code === 5750 || code === 5700 || code === -32601 || /method not found|not supported|unsupported/.test(lower)) return "Your wallet does not support this step.";

  for (const [pattern, plain] of REASONS) if (pattern.test(text)) return plain;
  const reason = /reverted(?: with reason string)?:? ?['"]?([^'"]+)/i.exec(text)?.[1]?.trim();
  if (reason && !/^0x[0-9a-f]*$/i.test(reason)) return `The transaction would fail: ${reason.length > 120 ? `${reason.slice(0, 120)}…` : reason}`;
  if (/revert/.test(lower)) return "The transaction would fail on chain, so it was not sent.";

  // What is left is either a sentence this app wrote itself, or something a wallet or a node said.
  const own = error instanceof Error && code === undefined && !["TypeError", "SyntaxError", "RangeError", "ReferenceError"].includes(error.name);
  if (own && text) return text;
  return GENERIC;
}
