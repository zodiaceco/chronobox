/**
 * The one third-party service: an explorer's index. Off until the person switches it on.
 *
 * By default every read goes through the connected wallet, so no extra party
 * learns which addresses this page looks at. That is private, and it has a
 * cost: nothing can list the tokens of an address, so the app only finds the
 * tokens it already knows, and it has no prices.
 *
 * With the service on, the page asks a Blockscout index directly which tokens
 * an address holds and what they are worth in dollars. Blockscout sees the IP
 * address of the browser and the addresses that are asked for. Only networks
 * whose index answers a browser have this.
 *
 * What comes back is used for display only. The index says which tokens to
 * look at and what a price is. The balance of each token is read from the
 * chain through the wallet, and its decimals too. Nothing here decides what is
 * safe: the checks and every transaction go through the wallet.
 */
import type { Chain } from "./chains.ts";
import { type Address, parseAddress } from "./hex.ts";

const OPTIONS = { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" } as const;

async function limited(url: string, init: RequestInit, ms: number): Promise<Response> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(url, { ...OPTIONS, ...init, signal: control.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** `usd` is the price of one whole token in US dollars, as the index has it. Null when it has none. */
export type FoundToken = { address: Address; symbol: string; decimals: number; usd: number | null };

/** A price is somebody else's number. Only a plain positive one is used, and only to order and label the list. */
export function plainPrice(value: unknown): number | null {
  const price = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(price) && price > 0 && price < 1e9 ? price : null;
}

/** A name from an index is somebody else's text. Only plain characters, and not many of them. */
export function plainSymbol(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[^\x21-\x7e]/g, "").slice(0, 12) : "";
  return text || "?";
}

/**
 * Turns the answer of the index into a list of tokens. Anything that is not clearly an ERC-20 token
 * with a balance is left out. An address can hold thousands of tokens that were sent to it unasked,
 * so the list is cut: tokens with a price come first, the most valuable first.
 */
export function parseTokenList(answer: unknown, limit = 150): FoundToken[] {
  if (!Array.isArray(answer)) return [];
  const found: (FoundToken & { worth: number })[] = [];
  const seen = new Set<string>();
  for (const entry of answer) {
    const token = (entry as { token?: Record<string, unknown> } | null)?.token;
    if (!token || token.type !== "ERC-20") continue;
    // The index marks tokens that it holds to be a scam.
    if (typeof token.reputation === "string" && token.reputation !== "ok") continue;
    const raw = token.address_hash ?? token.address;
    const address = typeof raw === "string" ? parseAddress(raw.toLowerCase()) : null;
    const decimals = Number(token.decimals);
    let value = 0n;
    try {
      value = BigInt(String((entry as { value?: unknown }).value ?? "0"));
    } catch {
      continue;
    }
    if (!address || value <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const usd = plainPrice(token.exchange_rate);
    found.push({ address, symbol: plainSymbol(token.symbol), decimals, usd, worth: usd === null ? -1 : (Number(value) / 10 ** decimals) * usd });
  }
  return found
    .sort((a, b) => b.worth - a.worth)
    .slice(0, limit)
    .map(({ worth: _, ...token }) => token);
}

/** The tokens that an address holds, as the network's index knows them. Empty when the network has no index. */
export async function findTokens(chain: Chain, holder: Address): Promise<FoundToken[]> {
  if (!chain.indexer) return [];
  // An address that many tokens were sent to has a long list. It gets the time it needs.
  const res = await limited(`${chain.indexer}/api/v2/addresses/${holder}/token-balances`, { headers: { Accept: "application/json" } }, 40_000);
  if (!res.ok) throw new Error(`The index answered ${res.status}`);
  return parseTokenList(await res.json());
}

/** The price of the network's coin in US dollars, as the index has it. Null when the network has no index or it has no price. */
export async function findCoinPrice(chain: Chain): Promise<number | null> {
  if (!chain.indexer) return null;
  const res = await limited(`${chain.indexer}/api/v2/stats`, { headers: { Accept: "application/json" } }, 12_000);
  if (!res.ok) return null;
  return plainPrice(((await res.json()) as { coin_price?: unknown } | null)?.coin_price);
}

/** The host of the network's index, for the question that asks for consent. Null when the network has none. */
export function lookupHost(chain: Chain): string | null {
  return chain.indexer ? new URL(chain.indexer).host : null;
}
