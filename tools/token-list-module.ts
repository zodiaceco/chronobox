// What tools/token-list.ts writes, without the reads of the chain, so that it can be tested.
//
// The input of the tool is a file from outside. Its symbols end up in source code that runs in the
// app, so two things keep them data: a symbol must be made of a few plain characters, and every
// string goes into the source through JSON.stringify, never between quotes written by hand.
import { checksum } from "../src/lib/hex.ts";

/** A symbol the list may show: letters, digits and . $ _ + -, at most 12 of them. */
const SYMBOL = /^[A-Za-z0-9.$_+-]{1,12}$/;

/** The symbol as it is, or null if it has any other character. A symbol is not repaired: one that needs it is left out. */
export function listSymbol(symbol: unknown): string | null {
  return typeof symbol === "string" && SYMBOL.test(symbol) ? symbol : null;
}

export type ListToken = { address: string; symbol: string; decimals: number };

/** The source of src/lib/token-list.ts. One entry is symbol:decimals:address, packed into one string per network. */
export function tokenListModule(lists: { chainId: number; tokens: ListToken[] }[]): string {
  const lines = lists.map(({ chainId, tokens }) => {
    for (const t of tokens) {
      if (listSymbol(t.symbol) === null) throw new Error(`Not a list symbol: ${JSON.stringify(t.symbol)}`);
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) throw new Error(`Bad decimals for ${t.symbol}: ${t.decimals}`);
    }
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`Bad chain id: ${chainId}`);
    return `  ${chainId}: ${JSON.stringify(tokens.map((t) => `${t.symbol}:${t.decimals}:${checksum(t.address)}`).join(","))},`;
  });
  return `/**
 * The long list of tokens for each network, largest first. Written by
 * tools/token-list.ts, not by hand. The app shows a token from this list
 * only when an address holds some of it. The main tokens are in chains.ts.
 *
 * One entry is symbol:decimals:address.
 */
import type { Token } from "./chains.ts";
import type { Address } from "./hex.ts";

const LISTS: Record<number, string> = {
${lines.join("\n")}
};

const parsed = new Map<number, Token[]>();

export function moreTokens(chainId: number): Token[] {
  let list = parsed.get(chainId);
  if (!list) {
    list = (LISTS[chainId] ?? "")
      .split(",")
      .filter(Boolean)
      .map((entry) => {
        const [symbol, decimals, address] = entry.split(":");
        return { address: address as Address, symbol, decimals: Number(decimals) };
      });
    parsed.set(chainId, list);
  }
  return list;
}
`;
}
