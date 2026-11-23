import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CHAINS } from "../src/lib/chains.ts";
import { moreTokens } from "../src/lib/token-list.ts";
import { listSymbol, tokenListModule } from "../tools/token-list-module.ts";

const A = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const B = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

test("a list symbol is a few plain characters, as it is", () => {
  for (const ok of ["USDC", "stETH", "M-BTC", "MAG7.ssi", "ETH+", "EURC.e", "a$b_c", "X".repeat(12)]) assert.equal(listSymbol(ok), ok);
  // Anything that could leave a string, start a comment, or hide what it is.
  for (const bad of ['US"DC', "US\\DC", "a/*", "*/b", "a//b", "US DC", "USD₮0", "a`b", "a'b", "", "X".repeat(13), "a:b", "a,b", "a\nb"]) {
    assert.equal(listSymbol(bad), null, JSON.stringify(bad));
  }
  assert.equal(listSymbol(42), null);
  assert.equal(listSymbol(null), null);
});

test("the module refuses a symbol that is not data, also one split across two tokens", () => {
  // Each half is short. Together, between hand-written quotes, they would have closed the string and run code.
  const split = [
    { address: A, symbol: '",x:(0,/*', decimals: 18 },
    { address: B, symbol: '*/alert(1))//', decimals: 6 },
  ];
  assert.throws(() => tokenListModule([{ chainId: 1, tokens: split }]), /Not a list symbol/);
  assert.throws(() => tokenListModule([{ chainId: 1, tokens: [{ address: A, symbol: "OK", decimals: 99 }] }]), /Bad decimals/);
  assert.throws(() => tokenListModule([{ chainId: 0, tokens: [] }]), /Bad chain id/);
});

test("what the module writes is read back as the same data", async () => {
  const tokens = [
    { address: A.toLowerCase(), symbol: "DAI", decimals: 18 },
    { address: B, symbol: "EURC.e", decimals: 6 },
  ];
  const source = tokenListModule([{ chainId: 1, tokens }, { chainId: 100, tokens: [] }]);
  // One string per network, written by JSON.stringify: nothing of a symbol is outside it.
  assert.match(source, /^ {2}1: "DAI:18:0x6B175474E89094C44Da98b954EedeAC495271d0F,EURC\.e:6:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",$/m);
  assert.match(source, /^ {2}100: "",$/m);
  const dir = mkdtempSync(path.join(os.tmpdir(), "token-list-"));
  try {
    const file = path.join(dir, "token-list.ts");
    writeFileSync(file, source);
    const written = (await import(pathToFileURL(file).href)) as typeof import("../src/lib/token-list.ts");
    assert.deepEqual(written.moreTokens(1), [
      { address: A, symbol: "DAI", decimals: 18 },
      { address: B, symbol: "EURC.e", decimals: 6 },
    ]);
    assert.deepEqual(written.moreTokens(100), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the list in the app is what the module writes: a new run changes nothing but new tokens", () => {
  const lists = CHAINS.filter((chain) => !chain.testnet).map((chain) => ({ chainId: chain.id, tokens: moreTokens(chain.id) }));
  for (const { tokens } of lists) for (const t of tokens) assert.notEqual(listSymbol(t.symbol), null, t.symbol);
  const shipped = readFileSync(new URL("../src/lib/token-list.ts", import.meta.url), "utf8");
  assert.equal(tokenListModule(lists), shipped);
});
