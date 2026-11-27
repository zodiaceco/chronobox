// Dev-only EIP-1193 test wallet for a local anvil fork on 127.0.0.1:8545.
// Bundled to out/dev-wallet.js by `node build.mjs --dev` only; never in production.
//
// ?account=<n> picks the nth default anvil account (default 0). Anvil holds the
// keys of its default accounts, so signing and sending are forwarded to it.
// ?as=<address> acts as any real wallet instead: anvil impersonates it, so the
// app sees that wallet as it is on the forked chain, with all its tokens.
// Announced via EIP-6963 only; window.ethereum is not set.
// window.__anvil.rpc(method, params) and window.__anvil.warp(seconds) help in the console and tests.

import { selector } from "./lib/abi.ts";
import { createTx, ownerBatchTx, predictSafe } from "./lib/chronobox.ts";
import { ANVIL_ACCOUNTS, SAFE_INDEX } from "./dev-accounts.ts";

// The wallet can switch between local forks: a fork of another network on 127.0.0.1:8546 is a second network.
// The choice stays over a reload, as in a real wallet.
const FORKS = ["http://127.0.0.1:8545", "http://127.0.0.1:8546"];
let RPC_URL = FORKS[0];
try {
  const kept = sessionStorage.getItem("dev-wallet:fork");
  if (kept && FORKS.includes(kept)) RPC_URL = kept;
} catch {
  // No storage: the wallet starts on the first fork.
}

async function chainIdOfFork(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] }) });
    return ((await res.json()) as { result?: string }).result ?? null;
  } catch {
    return null;
  }
}

// ?wallet= says what kind of wallet this is. The dev bar of the app sets it.
//   plain: an account without batching (the default).
//   batch: an account that answers the EIP-5792 methods and sends several calls as one.
//   safe:  a 1 of 1 Safe that the anvil account owns. It answers the EIP-5792 methods too.
// ?safe=1 is the older way to say "safe".
const QUERY = new URLSearchParams(location.search);
const KIND: "plain" | "batch" | "safe" = QUERY.get("wallet") === "safe" || QUERY.get("safe") === "1" ? "safe" : QUERY.get("wallet") === "batch" ? "batch" : "plain";
const SAFE_MODE = KIND === "safe";
const BATCHES = KIND !== "plain";

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f59e0b"/><path d="M9 23l7-14 7 14z" fill="#111"/></svg>',
  );

interface RequestArguments {
  readonly method: string;
  readonly params?: readonly unknown[] | object;
}

type Listener = (...args: unknown[]) => void;

interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

class ProviderRpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    this.data = data;
  }
}

const AS = new URLSearchParams(location.search).get("as");

function pickAccount(): string {
  if (AS !== null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(AS)) throw new Error(`dev-wallet: ?as=${AS} is not an address`);
    return AS;
  }
  const raw = new URLSearchParams(location.search).get("account") ?? "0";
  const index = Number(raw);
  const account = Number.isInteger(index) ? ANVIL_ACCOUNTS[index] : undefined;
  if (!account) {
    throw new Error(`dev-wallet: ?account=${raw} is not one of 0..${ANVIL_ACCOUNTS.length - 1}`);
  }
  return account;
}

let rpcId = 0;

async function rpc(method: string, params: unknown = []): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new ProviderRpcError(-32603, `anvil HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: RpcErrorShape };
  if (json.error) throw new ProviderRpcError(json.error.code, json.error.message, json.error.data);
  return json.result;
}

type RawCall = { to: string; data?: string; value?: string };

/** Sends calls through the dev Safe: one Safe transaction from its owner. */
async function sendAsSafe(owner: string, safe: string, calls: RawCall[]): Promise<string> {
  const tx = ownerBatchTx(
    owner as `0x${string}`,
    safe as `0x${string}`,
    calls.map((c) => ({ to: c.to as `0x${string}`, data: (c.data ?? "0x") as `0x${string}`, value: BigInt(c.value ?? "0x0") })),
  );
  return (await rpc("eth_sendTransaction", [{ from: owner, to: tx.to, data: tx.data }])) as string;
}

/**
 * Sends calls from a plain account as one: all of them or none. Anvil has no account that batches,
 * so the calls go out one after the other, and the fork is put back to where it was when one fails.
 */
async function sendTogether(from: string, calls: RawCall[]): Promise<string> {
  const before = await rpc("evm_snapshot");
  const hashes: string[] = [];
  try {
    // A real batch lands in one block. The fork stops mining on its own, takes every call, and mines them as one block.
    await rpc("evm_setAutomine", [false]);
    try {
      for (const c of calls) hashes.push((await rpc("eth_sendTransaction", [{ from, to: c.to, data: c.data ?? "0x", value: c.value ?? "0x0", gas: "0x4c4b40" }])) as string);
      await rpc("evm_mine");
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
    for (const hash of hashes) {
      // The receipt can be a moment behind the block.
      let receipt: { status: string } | null = null;
      for (let tries = 0; tries < 40 && !receipt; tries++) {
        receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: string } | null;
        if (!receipt) await new Promise((r) => setTimeout(r, 100));
      }
      if (!receipt || BigInt(receipt.status) !== 1n) throw new ProviderRpcError(3, "execution reverted: a call of the batch failed");
    }
  } catch (error) {
    await rpc("evm_revert", [before]);
    throw error;
  }
  return hashes[hashes.length - 1] ?? "";
}

let recent: number[] = [];
const SLOW_MS = Number(new URLSearchParams(location.search).get("slow") ?? 1500) || 1500;
/** getTxCreatedAt and getTxHash: what reading the line asks for each item. */
const QUEUE_READS = [selector("getTxCreatedAt(uint256)"), selector("getTxHash(uint256)")];

function createProvider(account: string, owner: string) {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) fn(...args);
  };

  const provider = {
    isAnvilTestWallet: true,

    async request({ method, params }: RequestArguments): Promise<unknown> {
      const list = Array.isArray(params) ? params : [];
      // A wallet that misbehaves on purpose: ?fault=<name>, or set window.__fault while the page runs.
      //   reject     the owner says no to every send
      //   hang       a send never gets an answer
      //   drop       a send returns a hash that is never mined (nothing is sent)
      //   lost       a send goes out, but the wallet reports another hash (as after "speed up")
      //   down       every read fails
      //   busy       only six reads a second pass, the rest are refused as a rate limit
      //   nologs     the network refuses to search old logs
      //   otherchain the wallet is on another network than the page thinks
      //   slow       every read takes a while (?slow=<ms>, 1500 by default): what loads, and in what order
      //   queue      the items in line cannot be read; everything else can
      const fault = (window as { __fault?: string }).__fault;
      if (fault) {
        const sends = method === "eth_sendTransaction" || method === "wallet_sendCalls";
        const asks = ["eth_accounts", "eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "wallet_getCapabilities"].includes(method);
        if (fault === "slow" && !sends && !asks) await new Promise((done) => setTimeout(done, SLOW_MS));
        if (fault === "queue" && method === "eth_call") {
          const data = String((list[0] as { data?: string } | undefined)?.data ?? "").slice(0, 10).toLowerCase();
          if (data === QUEUE_READS[0] || data === QUEUE_READS[1]) throw new ProviderRpcError(-32603, "Internal JSON-RPC error: 503 Service Unavailable");
        }
        if (fault === "reject" && sends) throw new ProviderRpcError(4001, "User rejected the request.");
        if (fault === "hang" && sends) return new Promise(() => undefined);
        if (fault === "drop" && method === "eth_sendTransaction") return "0x" + "de".repeat(32);
        if (fault === "lost" && method === "eth_sendTransaction") {
          await rpc(method, [{ ...((list[0] ?? {}) as Record<string, unknown>), from: account }]);
          return "0x" + "ad".repeat(32);
        }
        if (fault === "down" && !sends && !asks) throw new ProviderRpcError(-32603, "Internal JSON-RPC error: 503 Service Unavailable");
        if (fault === "busy" && !sends && !asks) {
          // A rate limit as networks have it: a few requests a second pass, the rest are refused.
          const now = Date.now();
          recent = recent.filter((at) => now - at < 1000);
          if (recent.length >= 6) throw new ProviderRpcError(-32005, "Too Many Requests");
          recent.push(now);
        }
        if (fault === "nologs" && method === "eth_getLogs") throw new ProviderRpcError(-32005, "query returned more than 10000 results");
        if (fault === "otherchain" && method === "eth_chainId") return "0x2105";
      }
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "wallet_switchEthereumChain": {
          const wanted = (list[0] as { chainId?: string } | undefined)?.chainId;
          const current = (await rpc("eth_chainId")) as string;
          if (wanted !== undefined && BigInt(wanted) === BigInt(current)) return null;
          for (const url of FORKS) {
            const id = await chainIdOfFork(url);
            if (wanted === undefined || id === null || BigInt(id) !== BigInt(wanted)) continue;
            RPC_URL = url;
            try {
              sessionStorage.setItem("dev-wallet:fork", url);
            } catch {
              // The choice lasts until the page loads again.
            }
            emit("chainChanged", id);
            return null;
          }
          throw new ProviderRpcError(4902, `Unrecognized chain ${String(wanted)}: anvil runs chain ${BigInt(current)}`);
        }
        case "eth_sendTransaction": {
          const tx = (list[0] ?? {}) as Record<string, unknown>;
          if (SAFE_MODE) return sendAsSafe(owner, account, [tx as RawCall]);
          return rpc(method, [{ ...tx, from: account }, ...list.slice(1)]);
        }
        case "wallet_getCapabilities": {
          if (!BATCHES) throw new ProviderRpcError(-32601, "Method not found");
          return { [(await rpc("eth_chainId")) as string]: { atomic: { status: "supported" } } };
        }
        case "wallet_sendCalls": {
          if (!BATCHES) throw new ProviderRpcError(-32601, "Method not found");
          const request = list[0] as { calls: RawCall[]; atomicRequired?: unknown };
          // As strict as MetaMask, so that a request it would refuse fails here too.
          if (typeof request.atomicRequired !== "boolean") throw new ProviderRpcError(-32602, "Invalid params: atomicRequired must be a boolean");
          request.calls.forEach((c, i) => {
            if (c.data !== undefined && !/^0x[0-9a-f]+$/.test(c.data)) throw new ProviderRpcError(-32602, `Invalid params: calls > ${i} > data must be hex with at least one byte`);
          });
          return { id: SAFE_MODE ? await sendAsSafe(owner, account, request.calls) : await sendTogether(account, request.calls) };
        }
        case "wallet_getCallsStatus": {
          const receipt = (await rpc("eth_getTransactionReceipt", [list[0]])) as { status: string } | null;
          if (!receipt) return { status: 100 };
          return { status: BigInt(receipt.status) === 1n ? 200 : 500, receipts: [receipt] };
        }
        default:
          return rpc(method, params ?? []);
      }
    },

    on(event: string, listener: Listener) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return provider;
    },

    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };

  rpc("eth_chainId").then(
    (chainId) => emit("connect", { chainId }),
    (err: unknown) => console.warn(`dev-wallet: anvil not reachable at ${RPC_URL}`, err),
  );

  return provider;
}

(window as { __fault?: string }).__fault = new URLSearchParams(location.search).get("fault") ?? undefined;

const owner = pickAccount();
const account = SAFE_MODE ? predictSafe(owner as `0x${string}`, SAFE_INDEX) : owner;
const provider = createProvider(account, owner);

if (SAFE_MODE) {
  // Create the dev Safe on first use and give it funds.
  (async () => {
    if (((await rpc("eth_getCode", [account, "latest"])) as string) === "0x") {
      const tx = createTx(owner as `0x${string}`, SAFE_INDEX);
      await rpc("eth_sendTransaction", [{ from: owner, to: tx.to, data: tx.data }]);
    }
    await rpc("anvil_setBalance", [account, "0x56bc75e2d63100000"]);
  })().catch((err) => console.warn("dev-wallet: could not set up the dev Safe", err));
}

// On mainnet the well-known anvil keys carry EIP-7702 delegations to sweeper
// contracts, which take any ETH the account receives. Clear the delegation on
// the fork so the test account behaves like a fresh wallet.
// A real wallet (?as=) keeps what it has on the chain, and anvil signs for it.
if (AS === null) rpc("anvil_setCode", [owner, "0x"]).catch(() => undefined);
else rpc("anvil_impersonateAccount", [owner]).catch((err) => console.warn("dev-wallet: could not impersonate", err));

const detail = Object.freeze({
  info: Object.freeze({
    uuid: crypto.randomUUID(),
    name: SAFE_MODE ? "Anvil test Safe" : BATCHES ? "Anvil test wallet (batching)" : "Anvil test wallet",
    icon: ICON,
    rdns: "dev.anvil",
  }),
  provider,
});

function announce() {
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
}
window.addEventListener("eip6963:requestProvider", announce);
announce();

const anvil = {
  rpc,
  async warp(seconds: number): Promise<void> {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine", []);
  },
};

declare global {
  interface Window {
    __anvil?: typeof anvil;
  }
}
window.__anvil = anvil;

console.info(`dev-wallet: Anvil test wallet ready, account ${account}`);

export {};
