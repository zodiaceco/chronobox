// Checks the token list and the price feeds against the real chains, through each chain's public RPC.
// Not part of the unit tests: it needs the network.   node test/tokens-live.ts
import { CHAINS } from "../src/lib/chains.ts";
import { readToken } from "../src/lib/chronobox.ts";
import { execFileSync } from "node:child_process";
for (const chain of CHAINS) {
  const rpc = async (method: string, params: unknown[] = []) => {
    const out = execFileSync("curl", ["-s", "-m", "20", "-X", "POST", "-H", "content-type: application/json", "--data", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), chain.publicRpc]).toString();
    const json = JSON.parse(out);
    if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code });
    return json.result;
  };
  for (const t of chain.tokens) {
    try {
      const code = await rpc("eth_getCode", [t.address, "latest"]);
      const meta = code.length > 2 ? await readToken(rpc, t.address) : null;
      const ok = meta && meta.decimals === t.decimals;
      if (!ok) process.exitCode = 1;
      console.log(ok ? "ok " : "BAD", chain.name, t.symbol, t.address, "code", code.length > 2, "on chain:", meta ? `${meta.symbol} ${meta.decimals}` : "none");
    } catch (e) {
      console.log("ERR", chain.name, t.symbol, (e as Error).message.slice(0, 80));
    }
  }
  if (chain.usdFeed) {
    try { console.log("feed", chain.name, (await rpc("eth_getCode", [chain.usdFeed, "latest"])).length > 2 ? "has code" : "NO CODE"); } catch (e) { console.log("ERR feed", chain.name); }
  }
}
