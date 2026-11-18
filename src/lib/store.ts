/**
 * Local state in the browser. Nothing here is secret and nothing here is
 * needed to get funds out: the chain is the source of truth. It can be empty
 * or blocked (private windows), so every access is guarded.
 */
import type { Token } from "./chains.ts";
import { type Address, type Hex, sameAddress } from "./hex.ts";
import type { BlockHints, DelayTx, TxCache } from "./timebox.ts";

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

export type SavedVault = { chainId: number; safe: Address };

export function savedVaults(): SavedVault[] {
  return load<SavedVault[]>("timebox:vaults", []);
}

export function rememberVault(vault: SavedVault): void {
  const all = savedVaults();
  if (all.some((v) => v.chainId === vault.chainId && sameAddress(v.safe, vault.safe))) return;
  save("timebox:vaults", [...all, vault]);
}

export function forgetVault(vault: SavedVault): void {
  save(
    "timebox:vaults",
    savedVaults().filter((v) => !(v.chainId === vault.chainId && sameAddress(v.safe, vault.safe))),
  );
}

export function customTokens(chainId: number): Token[] {
  return load<Token[]>(`timebox:tokens:${chainId}`, []);
}

export function addCustomToken(chainId: number, token: Token): void {
  const all = customTokens(chainId);
  if (all.some((t) => sameAddress(t.address, token.address))) return;
  save(`timebox:tokens:${chainId}`, [...all, token]);
}

/** Remembers the content of queued transactions, so the logs are searched only once. */
export function txCache(chainId: number, delay: Address): TxCache {
  const key = (nonce: bigint) => `timebox:tx:${chainId}:${delay.toLowerCase()}:${nonce}`;
  return {
    get(nonce: bigint, hash: Hex): DelayTx | null {
      const entry = load<{ hash: Hex; to: Address; value: string; data: Hex; operation: number } | null>(key(nonce), null);
      if (!entry || entry.hash !== hash) return null;
      return { to: entry.to, value: BigInt(entry.value), data: entry.data, operation: entry.operation };
    },
    set(nonce: bigint, hash: Hex, tx: DelayTx): void {
      save(key(nonce), { hash, to: tx.to, value: tx.value.toString(), data: tx.data, operation: tx.operation });
    },
  };
}

/** Remembers the block in which a contract was created, so its logs are read from there. */
export function blockHints(chainId: number): BlockHints {
  const key = (address: Address) => `timebox:block:${chainId}:${address.toLowerCase()}`;
  return {
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
  const before = load<string | null>("timebox:build", null);
  if (before !== current) save("timebox:build", current);
  return before !== null && before !== current;
}

export function lastWallet(): string | null {
  return load<string | null>("timebox:wallet", null);
}

export function setLastWallet(rdns: string | null): void {
  save("timebox:wallet", rdns);
}
