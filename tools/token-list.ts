// Writes src/lib/token-list.ts: the long list of tokens that the app can show, for each network.
//
//   node tools/token-list.ts <tokens.json>
//
// The input is a JSON file of the form { "<chain id>": [{ address, symbol, decimals, rank }, ...] },
// where a lower rank means a larger token. Each token is checked against the real chain, through the
// chain's public RPC: it must answer balanceOf, and its decimals must be the ones in the input.
// The main tokens of a network stay in chains.ts. They are not repeated here.
import { readFileSync, writeFileSync } from "node:fs";
import { call } from "../src/lib/abi.ts";
import { CHAINS, CONTRACTS } from "../src/lib/chains.ts";
import { readMany } from "../src/lib/chronobox.ts";
import { checksum, isAddress, sameAddress, toBigInt } from "../src/lib/hex.ts";
import { type ListToken, listSymbol, tokenListModule } from "./token-list-module.ts";

const PER_CHAIN = 200;
const input = process.argv[2];
if (!input) throw new Error("Usage: node tools/token-list.ts <tokens.json>");
type Entry = { address: string; symbol: string; decimals: number; rank: number | null };
const source = JSON.parse(readFileSync(input, "utf8")) as Record<string, Entry[]>;

const lists: { chainId: number; tokens: ListToken[] }[] = [];
for (const chain of CHAINS) {
  if (chain.testnet) continue;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(chain.publicRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    return json.result;
  };
  const seen = new Set(chain.tokens.map((t) => t.address.toLowerCase()));
  const symbols = new Set([chain.native.symbol, ...chain.tokens.map((t) => t.symbol)].map((symbol) => symbol.toLowerCase()));
  const candidates = (source[String(chain.id)] ?? [])
    .filter((t) => t.rank !== null && isAddress(t.address) && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36)
    .sort((a, b) => a.rank! - b.rank!)
    // A symbol goes into source code that runs in the app. One with any other character is left out, not repaired.
    .filter((t) => listSymbol(t.symbol) !== null || (console.log("  left out", chain.name, JSON.stringify(t.symbol), t.address, "(symbol)"), false))
    .filter((t) => !seen.has(t.address.toLowerCase()) && !!seen.add(t.address.toLowerCase()))
    // One token for each symbol: the largest. A second "USDC" next to the real one would only mislead.
    .filter((t) => !symbols.has(t.symbol.toLowerCase()) && !!symbols.add(t.symbol.toLowerCase()))
    .slice(0, PER_CHAIN + 80);
  const kept: Entry[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const part = candidates.slice(i, i + 100);
    const answers = await readMany(rpc, part.flatMap((t) => [
      { to: checksum(t.address), data: call("decimals()") },
      { to: checksum(t.address), data: call("balanceOf(address)", [CONTRACTS.burn]) },
    ]));
    part.forEach((t, k) => {
      const [decimals, balance] = [answers[k * 2], answers[k * 2 + 1]];
      const ok = decimals !== null && decimals.length === 66 && toBigInt(decimals) === BigInt(t.decimals) && balance !== null && balance.length >= 66;
      if (ok) kept.push(t);
      else console.log("  left out", chain.name, t.symbol, t.address);
    });
  }
  const list = kept.slice(0, PER_CHAIN);
  // How large one combined read can be on this network's public RPC.
  let whole = "ok";
  try {
    await readMany(rpc, list.map((t) => ({ to: checksum(t.address), data: call("balanceOf(address)", [CONTRACTS.burn]) })));
  } catch (error) {
    whole = (error as Error).message.slice(0, 80);
  }
  console.log(chain.name, "candidates", candidates.length, "kept", list.length, "| all", list.length, "balances in one read:", whole);
  if (list.some((t) => chain.tokens.some((main) => sameAddress(main.address, t.address)))) throw new Error("A main token is in the long list");
  lists.push({ chainId: chain.id, tokens: list });
}

writeFileSync(new URL("../src/lib/token-list.ts", import.meta.url), tokenListModule(lists));

