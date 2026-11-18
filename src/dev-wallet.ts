// Dev-only EIP-1193 test wallet for a local anvil fork on 127.0.0.1:8545.
// Bundled to out/dev-wallet.js by `node build.mjs --dev` only; never in production.
//
// ?account=<n> picks the nth default anvil account (default 0). Anvil holds the
// keys of its default accounts, so signing and sending are forwarded to it.
// Announced via EIP-6963 only; window.ethereum is not set.
// window.__anvil.rpc(method, params) and window.__anvil.warp(seconds) help in the console and tests.

import { createTx, ownerBatchTx, predictSafe } from "./lib/timebox.ts";

const RPC_URL = "http://127.0.0.1:8545";

// ?safe=1 makes the wallet act as a 1 of 1 Safe that the anvil account owns.
// It then answers the EIP-5792 methods, like a smart contract wallet does.
const SAFE_MODE = new URLSearchParams(location.search).get("safe") === "1";
const SAFE_INDEX = 900;

const ANVIL_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
] as const;

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

function pickAccount(): string {
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

function createProvider(account: string, owner: string) {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) fn(...args);
  };

  const provider = {
    isAnvilTestWallet: true,

    async request({ method, params }: RequestArguments): Promise<unknown> {
      const list = Array.isArray(params) ? params : [];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "wallet_switchEthereumChain": {
          const wanted = (list[0] as { chainId?: string } | undefined)?.chainId;
          const current = (await rpc("eth_chainId")) as string;
          if (wanted !== undefined && BigInt(wanted) === BigInt(current)) return null;
          throw new ProviderRpcError(4902, `Unrecognized chain ${String(wanted)}: anvil runs chain ${BigInt(current)}`);
        }
        case "eth_sendTransaction": {
          const tx = (list[0] ?? {}) as Record<string, unknown>;
          if (SAFE_MODE) return sendAsSafe(owner, account, [tx as RawCall]);
          return rpc(method, [{ ...tx, from: account }, ...list.slice(1)]);
        }
        case "wallet_getCapabilities": {
          if (!SAFE_MODE) throw new ProviderRpcError(-32601, "Method not found");
          return { [(await rpc("eth_chainId")) as string]: { atomic: { status: "supported" } } };
        }
        case "wallet_sendCalls": {
          if (!SAFE_MODE) throw new ProviderRpcError(-32601, "Method not found");
          const request = list[0] as { calls: RawCall[] };
          return { id: await sendAsSafe(owner, account, request.calls) };
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
rpc("anvil_setCode", [owner, "0x"]).catch(() => undefined);

const detail = Object.freeze({
  info: Object.freeze({
    uuid: crypto.randomUUID(),
    name: SAFE_MODE ? "Anvil test Safe" : "Anvil test wallet",
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
