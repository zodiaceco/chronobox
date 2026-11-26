// Writes the icons of the tokens that the app knows: static/tokens/<NAME>.svg for each icon, and
// src/lib/token-icons.ts, which says for each token which icon is its own.
//
//   node tools/token-icons.ts
//
// The icons come from the @web3icons packages (MIT). The app serves the files itself, so the page
// loads no picture from another site. Only tokens of the app's own lists get an icon (chains.ts
// and token-list.ts): first by their address on the network, then by their symbol. A token that
// only the balance lookup found never gets one. Anybody can give a token the symbol of another.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { CHAINS } from "../src/lib/chains.ts";
import { moreTokens } from "../src/lib/token-list.ts";

type Meta = { filePath: string; symbol: string; addresses?: Record<string, string>; variants?: string[] };

const require = createRequire(import.meta.url);
const { tokens } = require("@web3icons/common") as { tokens: Meta[] };
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "static", "tokens");
const SVGS = path.join(path.dirname(require.resolve("@web3icons/core")), "svgs", "tokens", "branded");

/** How the icon package names the networks that the app knows. */
const NETWORK: Record<number, string> = { 1: "ethereum", 8453: "base", 42161: "arbitrum-one", 100: "xdai" };

// A few tokens borrow the icon of a network. Those are left out: this script copies token icons only.
const branded = tokens.filter((t) => t.variants?.includes("branded") && t.filePath.startsWith("token:"));
const nameOf = (meta: Meta) => meta.filePath.replace(/^token:/, "");
const bySymbol = new Map<string, Meta>();
// The list is ordered by name, not by size. Among tokens that share a symbol, the first one is taken.
for (const meta of branded) if (!bySymbol.has(meta.symbol.toLowerCase())) bySymbol.set(meta.symbol.toLowerCase(), meta);

/**
 * Tokens that the package has no icon for, and whose icon is plainly that of another: a wrapped
 * coin shows its coin, a bridged token its token, staked ETH of Lido the mark of Lido. By symbol,
 * for the app's own lists only.
 */
const ALIAS: Record<string, string> = {
  weth: "ETH",
  "usdc.e": "USDC",
  "usd₮0": "USDT",
  usdt0: "USDT",
  wxdai: "DAI",
  xdai: "DAI",
  sdai: "DAI",
  steth: "LDO",
  wsteth: "LDO",
};
const iconFor = (symbol: string): Meta | undefined => {
  const lower = symbol.toLowerCase();
  return bySymbol.get(lower) ?? (ALIAS[lower] ? branded.find((t) => nameOf(t) === ALIAS[lower]) : undefined);
};

const used = new Set<string>();
const lines: string[] = [];
let byAddress = 0;
let bySym = 0;
let none = 0;
for (const chain of CHAINS) {
  const key = NETWORK[chain.id];
  const here = new Map<string, Meta>();
  if (key) for (const meta of branded) if (meta.addresses?.[key]) here.set(meta.addresses[key].toLowerCase(), meta);
  const entries: string[] = [];
  const coin = iconFor(chain.native.symbol);
  if (coin) {
    entries.push(`native:${nameOf(coin)}`);
    used.add(nameOf(coin));
  }
  for (const token of [...chain.tokens, ...moreTokens(chain.id)]) {
    const address = token.address.toLowerCase();
    const found = here.get(address) ?? iconFor(token.symbol);
    if (!found) {
      none++;
      continue;
    }
    if (here.has(address)) byAddress++;
    else bySym++;
    entries.push(`${address}:${nameOf(found)}`);
    used.add(nameOf(found));
  }
  if (entries.length > 0) lines.push(`  ${chain.id}: "${entries.join(",")}",`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const known = new Set(readdirSync(SVGS).filter((f) => f.endsWith(".svg.js")).map((f) => f.slice(0, -".svg.js".length)));
for (const name of [...used].sort()) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || !known.has(name)) throw new Error(`No icon file for ${name}`);
  const svg = ((await import(pathToFileURL(path.join(SVGS, `${name}.svg.js`)).href)) as { default: string }).default;
  // A picture file is a picture and nothing else.
  if (/<script|<foreignObject|\son[a-z]+=|href=/i.test(svg)) throw new Error(`The icon ${name} holds more than a drawing`);
  writeFileSync(path.join(OUT, `${name}.svg`), svg.replace(' class="web3icons"', ""));
}

writeFileSync(
  path.join(ROOT, "src", "lib", "token-icons.ts"),
  `/**
 * Which icon belongs to which token, for each network. Written by
 * tools/token-icons.ts, not by hand. The icon files are in static/tokens.
 *
 * One entry is address:NAME, or native:NAME for the network's coin.
 */
import type { Address } from "./hex.ts";

const ICONS: Record<number, string> = {
${lines.join("\n")}
};

const parsed = new Map<number, Map<string, string>>();

/** The address of the icon file of a token of the app's own lists, relative to the page. Null when it has none. */
export function tokenIcon(chainId: number, token: Address | null): string | null {
  let map = parsed.get(chainId);
  if (!map) {
    map = new Map((ICONS[chainId] ?? "").split(",").filter(Boolean).map((entry) => entry.split(":") as [string, string]));
    parsed.set(chainId, map);
  }
  const name = map.get(token === null ? "native" : token.toLowerCase());
  return name ? \`./tokens/\${name}.svg\` : null;
}
`,
);
console.log(`${used.size} icons. Tokens matched by address: ${byAddress}, by symbol: ${bySym}, without an icon: ${none}.`);
