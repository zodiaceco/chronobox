/**
 * Local state in the browser. Nothing here is secret and nothing here is
 * needed to get funds out: the chain is the source of truth. It can be empty
 * or blocked (private windows), so every access is guarded.
 */
import type { Token } from "./chains.ts";
import { type Address, type Hex, sameAddress } from "./hex.ts";
import { type BlockHints, type DelayTx, type SwapRequest, type TxCache, delayTxHash, predictSafe } from "./chronobox.ts";
import { parseAddress } from "./hex.ts";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is not available. The app works without it.
  }
}

/** `wallet` is the wallet that was the key of the Chronobox when this browser last saw it. */
export type SavedVault = { chainId: number; safe: Address; wallet?: Address };

/** What is in storage can be old, broken, or changed by hand. Only entries of the right shape are used. */
function list<T>(key: string, valid: (entry: any) => boolean): T[] {
  const value = load<unknown>(key, []);
  return Array.isArray(value) ? (value.filter((entry) => entry && typeof entry === "object" && valid(entry)) as T[]) : [];
}

export function savedVaults(): SavedVault[] {
  return list<SavedVault>(
    "chronobox:vaults",
    (v) => Number.isInteger(v.chainId) && typeof v.safe === "string" && parseAddress(v.safe) !== null && (v.wallet === undefined || (typeof v.wallet === "string" && parseAddress(v.wallet) !== null)),
  );
}

export function rememberVault(vault: SavedVault): void {
  const all = savedVaults();
  const exact = all.findIndex(
    (v) => v.chainId === vault.chainId && sameAddress(v.safe, vault.safe) && (vault.wallet ? sameAddress(v.wallet, vault.wallet) : !v.wallet),
  );
  if (exact >= 0) return;
  // Upgrade an older entry without a wallet, rather than leaving a duplicate beside it.
  const legacy = vault.wallet ? all.findIndex((v) => v.chainId === vault.chainId && sameAddress(v.safe, vault.safe) && !v.wallet) : -1;
  if (legacy >= 0) {
    all[legacy] = { ...all[legacy], wallet: vault.wallet };
    return save("chronobox:vaults", all);
  }
  save("chronobox:vaults", [...all, vault]);
}

/**
 * The remembered Chronoboxes of one wallet. A browser can have seen the
 * Chronoboxes of several wallets. An entry without a wallet is from an older
 * version: it counts when its address is one that this wallet creates.
 */
export function vaultsOf(wallet: Address): SavedVault[] {
  let mine: Address[] | null = null;
  const seen = new Set<string>();
  return savedVaults().filter((v) => {
    const matches = v.wallet
      ? sameAddress(v.wallet, wallet)
      : (mine ??= [predictSafe(wallet, 0)]).some((safe) => sameAddress(safe, v.safe));
    if (!matches) return false;
    const key = `${v.chainId}:${v.safe.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The account that was connected at the last visit. */
export function lastAccount(): Address | null {
  const value = load<string | null>("chronobox:account", null);
  return typeof value === "string" ? parseAddress(value) : null;
}

export function setLastAccount(account: Address): void {
  save("chronobox:account", account);
}

export function customTokens(chainId: number): Token[] {
  return list<Token>(
    `chronobox:tokens:${chainId}`,
    (t) => typeof t.address === "string" && parseAddress(t.address) !== null && typeof t.symbol === "string" && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36,
  );
}

/** Returns false when the browser did not keep the token (storage is blocked or full). */
export function addCustomToken(chainId: number, token: Token): boolean {
  const all = customTokens(chainId);
  if (all.some((t) => sameAddress(t.address, token.address))) return true;
  save(`chronobox:tokens:${chainId}`, [...all, token]);
  return customTokens(chainId).some((t) => sameAddress(t.address, token.address));
}

/** Remembers the content of queued transactions, so the logs are searched only once. */
export function txCache(chainId: number, delay: Address): TxCache {
  const key = (nonce: bigint) => `chronobox:tx:${chainId}:${delay.toLowerCase()}:${nonce}`;
  return {
    get(nonce: bigint, hash: Hex): DelayTx | null {
      const entry = load<{ hash: Hex; to: Address; value: string; data: Hex; operation: number } | null>(key(nonce), null);
      if (!entry || entry.hash !== hash) return null;
      try {
        const tx: DelayTx = { to: entry.to, value: BigInt(entry.value), data: entry.data, operation: entry.operation };
        // Storage is not proof. The content must give the hash that is on chain.
        return delayTxHash(tx) === hash ? tx : null;
      } catch {
        return null;
      }
    },
    set(nonce: bigint, hash: Hex, tx: DelayTx): void {
      save(key(nonce), { hash, to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation });
    },
  };
}

/** Remembers the block in which a contract was created, so its logs are read from there. */
export function blockHints(chainId: number): BlockHints {
  const key = (address: Address) => `chronobox:block:${chainId}:${address.toLowerCase()}`;
  return {
    chainId,
    get(address: Address): bigint | null {
      const value = load<string | null>(key(address), null);
      return value !== null && /^[0-9]+$/.test(value) ? BigInt(value) : null;
    },
    set(address: Address, block: bigint): void {
      save(key(address), block.toString());
    },
  };
}

/**
 * True once when the build that runs now is not the build of the last visit.
 * The page updates quietly, like any website. This lets it say so afterwards.
 */
export function buildChanged(current: string): boolean {
  const before = load<string | null>("chronobox:build", null);
  if (before !== current) save("chronobox:build", current);
  return before !== null && before !== current;
}

export function lastWallet(): string | null {
  return load<string | null>("chronobox:wallet", null);
}

export function setLastWallet(rdns: string | null): void {
  save("chronobox:wallet", rdns);
}

/**
 * A wallet change that the owner asked the guardian to agree to: the new wallet, and the point
 * of the line it cancels up to. It is kept so that the owner can close the page while the
 * guardian looks at it. The chain decides what is true: this is only what the page offers to
 * finish. A request kept by an older version has no point of the line, and is dropped.
 */
export function pendingSwap(chainId: number, safe: Address): SwapRequest | null {
  const value = load<unknown>(`chronobox:swap:${chainId}:${safe.toLowerCase()}`, null);
  if (!value || typeof value !== "object") return null;
  const { to, upTo } = value as { to?: unknown; upTo?: unknown };
  const address = typeof to === "string" ? parseAddress(to) : null;
  return address && typeof upTo === "string" && /^\d{1,78}$/.test(upTo) ? { to: address, upTo: BigInt(upTo) } : null;
}

export function setPendingSwap(chainId: number, safe: Address, request: SwapRequest | null): void {
  const key = `chronobox:swap:${chainId}:${safe.toLowerCase()}`;
  if (request) return save(key, { to: request.to, upTo: request.upTo.toString() });
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage is not available. Then nothing was kept.
  }
}

/** Did the person switch on third-party services (see lookup.ts)? Off unless they said yes in this browser. */
export function lookupAllowed(): boolean {
  return load<unknown>("chronobox:lookup", false) === true;
}

export function setLookupAllowed(allowed: boolean): void {
  save("chronobox:lookup", allowed);
}
