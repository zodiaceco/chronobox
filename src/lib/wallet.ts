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

export function rpcOf(provider: Provider): Rpc {
  return (method, params = []) => provider.request({ method, params });
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
    if ((error as { code?: number }).code !== 4902) throw error;
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
    // first batch is sent. Chronobox does not start that: the wallet is the only key, and what
    // kind of account it is stays the owner's choice. Such an account takes the plain path.
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
): Promise<{ blockNumber: bigint | null }> {
  // A call that only sends ETH has no data. Wallets reject "0x" there, so the field is left out.
  const list = calls.map((c) => ({ to: c.to, ...(c.data === "0x" ? {} : { data: c.data }), value: toQuantity(c.value ?? 0n) }));
  const base = { from: account, chainId: toQuantity(chainId), calls: list };
  let result: unknown;
  try {
    result = await provider.request({ method: "wallet_sendCalls", params: [{ version: "2.0.0", atomicRequired: true, ...base }] });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 4001 || code === 5740 || code === 5750) throw error;
    // Wallets that implement the first draft of the standard. If that fails too, the first answer is the one to show.
    try {
      result = await provider.request({ method: "wallet_sendCalls", params: [{ version: "1.0", ...base }] });
    } catch (second) {
      const again = (second as { code?: number }).code;
      throw again === 4001 ? second : error;
    }
  }
  const id = typeof result === "string" ? result : (result as { id?: string })?.id;
  if (!id) throw new Error("The wallet did not return a batch id.");
  onWaiting?.();
  for (;;) {
    const status = (await provider.request({ method: "wallet_getCallsStatus", params: [id] })) as {
      status?: number | string;
      receipts?: { blockNumber?: string; status?: string }[];
    } | null;
    const code = status?.status;
    const done = code === 200 || code === "CONFIRMED";
    const failed = (typeof code === "number" && code >= 400) || code === "FAILED" || code === "REVERTED";
    const receipt = status?.receipts?.[status.receipts.length - 1];
    if (failed || (done && receipt?.status !== undefined && BigInt(receipt.status) !== 1n)) {
      throw new Error("The transaction failed on chain. Nothing was created and nothing was deposited.");
    }
    if (done) return { blockNumber: receipt?.blockNumber ? BigInt(receipt.blockNumber) : null };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** A short, plain message for an error that came from a wallet or an RPC. */
export function errorText(error: unknown): string {
  const e = error as { code?: number; message?: string; shortMessage?: string; data?: { message?: string } };
  if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? "")) return "You rejected the request in your wallet.";
  const text = e?.data?.message || e?.shortMessage || e?.message || String(error);
  const reason = /reverted(?: with reason string)?:? ?['"]?([^'"]+)/i.exec(text)?.[1];
  if (reason) return `The transaction would fail: ${reason.trim()}`;
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}
