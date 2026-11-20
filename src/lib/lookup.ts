/**
 * Balance lookup outside the wallet. Off until the person switches it on.
 *
 * By default every read goes through the connected wallet, so no extra party
 * learns which addresses this page looks at. That is private, and it has two
 * costs: a wallet's network can be slow, and nothing can list the tokens of an
 * address, so the app only finds the tokens it already knows.
 *
 * With the lookup on, the page asks two public services directly:
 *   - a public node of the network, for balances,
 *   - an explorer's index (where the network has one that answers a browser),
 *     for the list of tokens an address holds and their prices in dollars.
 * Both see the IP address of the browser and the addresses that are asked for.
 *
 * What comes back is used for display only. The index says which tokens to
 * look at; the balance of each is then read from the chain, and its decimals
 * too. Nothing here decides what is safe: the checks and every transaction
 * still go through the wallet.
 */
import type { Chain } from "./chains.ts";
import { type Address, parseAddress } from "./hex.ts";
import type { Rpc } from "./chronobox.ts";

/** The lookup only reads. A method that is not in this list is never sent to a public node. */
const READS = new Set(["eth_call", "eth_getBalance", "eth_getCode", "eth_blockNumber", "eth_chainId"]);

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

/** The public node of a network as an RPC, for reads only. */
export function publicRpc(chain: Chain): Rpc {
  let id = 0;
  return async (method, params = []) => {
    if (!READS.has(method)) throw new Error(`${method} is not a read`);
    const res = await limited(chain.publicRpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }, 12_000);
    if (!res.ok) throw new Error(`The public node answered ${res.status}`);
    const answer = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (answer.error || answer.result === undefined) throw new Error(answer.error?.message || "The public node gave no result");
    return answer.result;
  };
}

/** Reads through the public node, and through the wallet when that fails. */
export function withFallback(first: Rpc, second: Rpc): Rpc {
  return async (method, params) => {
    try {
      return await first(method, params);
    } catch {
      return second(method, params);
    }
  };
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

/** The services that the lookup talks to on a network and what each is asked, for the question that asks for consent. */
export function lookupServices(chain: Chain): { host: string; what: string }[] {
  return [
    { host: new URL(chain.publicRpc).host, what: "a public node of the network. It is asked for your balances." },
    ...(chain.indexer ? [{ host: new URL(chain.indexer).host, what: "the Blockscout explorer. It is asked which tokens you hold and what they are worth in dollars." }] : []),
  ];
}
