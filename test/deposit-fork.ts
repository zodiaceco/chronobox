/**
 * Money that goes in during the setup, against the real tokens on a local fork.
 *
 *   npm run fork             (anvil fork of Ethereum mainnet on 127.0.0.1:8545)
 *   npm run test:fork:deposit
 *
 * The script takes a snapshot first and reverts to it at the end.
 */
import assert from "node:assert/strict";
import { call } from "../src/lib/abi.ts";
import { CHAINS } from "../src/lib/chains.ts";
import { EXPIRATION_SECONDS, type Rpc, createTx, inspect, lockTx, nativeBalance, safeFromReceipt, sendAndWait, tokenBalance } from "../src/lib/chronobox.ts";
import { type Pull, freshPulls, readPrices, signPull, splitContribution, tokenPayment, tolerantCall, waysIn } from "../src/lib/deposit.ts";
import { type Address, type Hex, toBigInt } from "../src/lib/hex.ts";

const URL = process.env.FORK_RPC ?? "http://127.0.0.1:8545";
// Anvil accounts 3 to 5. The dev wallet in the browser uses accounts 0 to 2.
const WALLETS: Address[] = ["0x90F79bf6EB2c4f870365E785982E1f101E93b906", "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"];
const RECEIVER: Address = "0x000000000000000000000000000000000000c0de";
const DAY = 86_400n;
const ETH = 10n ** 18n;

let id = 0;
const rpc: Rpc = async (method, params = []) => {
  const response = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { data: body.error.data });
  return body.result;
};
const step = (text: string) => console.log(`\n${text}`);
const ok = (text: string) => console.log(`  ok  ${text}`);

const mainnet = CHAINS.find((c) => c.id === 1)!;
const token = (symbol: string) => mainnet.tokens.find((t) => t.symbol === symbol)!;
const units = (symbol: string, whole: bigint) => whole * 10n ** BigInt(token(symbol).decimals);
/** Gives an address tokens. False when anvil cannot find the balance slot of this token. */
const deal = async (holder: Address, symbol: string, amount: bigint): Promise<boolean> => {
  try {
    await rpc("anvil_dealERC20", [holder, token(symbol).address, "0x" + amount.toString(16)]);
    return (await tokenBalance(rpc, token(symbol).address, holder)) >= amount;
  } catch {
    return false;
  }
};
// The wallet signs as a real wallet does: it gets the typed message as text.
const signAs = (wallet: Address) => (data: object) => rpc("eth_signTypedData_v4", [wallet, JSON.stringify(data)]) as Promise<string>;

const snapshot = await rpc("evm_snapshot", []);
try {
  for (const account of WALLETS) {
    // On mainnet the well-known anvil keys carry EIP-7702 delegations. Clear them.
    await rpc("anvil_setCode", [account, "0x"]);
    await rpc("anvil_setBalance", [account, "0x" + (100n * ETH).toString(16)]);
  }
  // Circle has some of the well-known test addresses on its blocklist. Take one that is free.
  let WALLET: Address | null = null;
  for (const account of WALLETS) {
    const listed = toBigInt((await rpc("eth_call", [{ to: token("USDC").address, data: call("isBlacklisted(address)", [account]) }, "latest"])) as Hex);
    if (listed === 0n) {
      WALLET = account;
      break;
    }
  }
  assert.ok(WALLET, "no test wallet that USDC accepts");
  const STRANGER = WALLETS.find((a) => a !== WALLET)!;

  step("0. Which tokens take a signed message");
  const symbols = mainnet.tokens.map((t) => t.symbol);
  const ways = await waysIn(rpc, 1, WALLET, mainnet.tokens.map((t) => t.address));
  const wayOf = (symbol: string) => ways[symbols.indexOf(symbol)];
  console.log("  " + symbols.map((s, i) => `${s}: ${ways[i].kind}`).join(", "));
  assert.equal(wayOf("USDC").kind, "authorization");
  assert.equal(wayOf("USDS").kind, "permit");
  assert.equal(wayOf("USDT").kind, "transfer");
  assert.equal(wayOf("WETH").kind, "transfer");
  assert.equal(wayOf("DAI").kind, "transfer", "DAI has its own permit format");
  ok("USDC by authorization, USDS by permit, USDT, WETH and DAI by transfer");

  step("1. Every token on the list that says it takes a signed message: does it?");
  const probe = "0x00000000000000000000000000000000000B0bB0" as Address;
  for (const symbol of symbols) {
    const way = wayOf(symbol);
    if (way.kind === "transfer") continue;
    const amount = units(symbol, 3n);
    if (!(await deal(WALLET, symbol, amount))) {
      console.log(`  --  ${symbol}: anvil could not give the test wallet this token, not tested`);
      continue;
    }
    const pull = await signPull(rpc, signAs(WALLET), way, token(symbol).address, WALLET, probe, amount);
    console.log(`  ${pull ? "ok " : "NO "} ${symbol} (${way.kind})${pull ? "" : ": the token refused the signature, it would go in by transfer"}`);
  }

  step("2. Setup with 1 ETH, 5,000 USDC (authorization) and 2,000 USDS (permit); the contribution is on top");
  assert.ok(await deal(WALLET, "USDC", units("USDC", 12_000n)));
  assert.ok(await deal(WALLET, "USDS", units("USDS", 3_000n)));
  const safe = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 40)))!;
  const pulls: Pull[] = [];
  for (const [symbol, whole] of [["USDC", 5_000n], ["USDS", 2_000n]] as const) {
    const way = wayOf(symbol);
    assert.ok(way.kind !== "transfer");
    const pull = await signPull(rpc, signAs(WALLET), way, token(symbol).address, WALLET, safe, units(symbol, whole));
    assert.ok(pull, `${symbol}: the signature was refused`);
    pulls.push(pull);
  }
  // A signature by another wallet is caught before anything is sent.
  const usdcWay = wayOf("USDC");
  assert.ok(usdcWay.kind !== "transfer");
  assert.equal(await signPull(rpc, signAs(STRANGER), usdcWay, token("USDC").address, WALLET, safe, units("USDC", 1n)), null);
  ok("a signature by another wallet is refused before anything is sent");
  // A contract wallet's signature has another form. It is not used.
  assert.equal(await signPull(rpc, async () => "0x" + "ab".repeat(96), usdcWay, token("USDC").address, WALLET, safe, units("USDC", 1n)), null);

  const fee = ETH / 300n;
  const receiverBefore = await nativeBalance(rpc, RECEIVER);
  const walletUsdc = await tokenBalance(rpc, token("USDC").address, WALLET);
  const tx = lockTx(WALLET, safe, DAY, EXPIRATION_SECONDS, { to: RECEIVER, amount: fee }, { coin: ETH, calls: pulls.flatMap((p) => p.calls) });
  assert.equal(tx.value, ETH + fee, "the wallet sends the coin and the contribution as one amount");
  await sendAndWait(rpc, WALLET, tx);
  assert.equal(await nativeBalance(rpc, safe), ETH);
  assert.equal(await tokenBalance(rpc, token("USDC").address, safe), units("USDC", 5_000n));
  assert.equal(await tokenBalance(rpc, token("USDS").address, safe), units("USDS", 2_000n));
  assert.equal(walletUsdc - (await tokenBalance(rpc, token("USDC").address, WALLET)), units("USDC", 5_000n));
  assert.equal((await nativeBalance(rpc, RECEIVER)) - receiverBefore, fee);
  assert.equal((await inspect(rpc, safe)).state, "locked", "the safety checks pass with money in the setup");
  ok("coin and both tokens are inside, the contribution arrived, and the Chronobox passes every check");

  step("3. Everything goes in: the contribution comes out of the dollar token");
  const safe2 = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 41)))!;
  const all = await tokenBalance(rpc, token("USDC").address, WALLET);
  const coinIn = (await nativeBalance(rpc, WALLET)) - ETH / 10n;
  const parts = splitContribution(
    [
      { token: null, amount: coinIn, decimals: 18, dollar: false, inSetup: true },
      { token: token("USDC").address, amount: all, decimals: 6, dollar: true, inSetup: true },
    ],
    { cents: 1000n, coin: fee },
    await nativeBalance(rpc, WALLET),
    ETH / 10n,
  );
  assert.ok(parts && parts.from === "token" && parts.fee === units("USDC", 10n));
  const pullAll = await signPull(rpc, signAs(WALLET), usdcWay, token("USDC").address, WALLET, safe2, all);
  assert.ok(pullAll);
  const receiverUsdc = await tokenBalance(rpc, token("USDC").address, RECEIVER);
  await sendAndWait(rpc, WALLET, lockTx(WALLET, safe2, DAY, EXPIRATION_SECONDS, null, { coin: parts.stays[0], calls: [...pullAll.calls, tokenPayment(parts.token, RECEIVER, parts.fee, safe2)] }));
  assert.equal(await tokenBalance(rpc, token("USDC").address, WALLET), 0n, "all USDC left the wallet");
  assert.equal(await tokenBalance(rpc, token("USDC").address, safe2), all - units("USDC", 10n));
  assert.equal((await tokenBalance(rpc, token("USDC").address, RECEIVER)) - receiverUsdc, units("USDC", 10n));
  assert.equal(await nativeBalance(rpc, safe2), coinIn);
  assert.equal((await inspect(rpc, safe2)).state, "locked");
  ok("the wallet's USDC is empty, the Chronobox has all of it less 10 USDC, the receiver has 10 USDC");

  step("4. A permit that somebody used first does not stop the setup");
  assert.ok(await deal(WALLET, "USDS", units("USDS", 500n)));
  const safe3 = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 42)))!;
  const usdsWay = (await waysIn(rpc, 1, WALLET, [token("USDS").address]))[0];
  assert.ok(usdsWay.kind === "permit");
  const permit = await signPull(rpc, signAs(WALLET), usdsWay, token("USDS").address, WALLET, safe3, units("USDS", 500n));
  assert.ok(permit && permit.calls.length === 2 && permit.permit);
  // A permit that fails, and no approval in place: the transfer fails, and so does the whole setup.
  const forged = { ...permit.permit, data: (permit.permit.data.slice(0, -2) + (permit.permit.data.endsWith("00") ? "01" : "00")) as Hex };
  const broken = lockTx(WALLET, safe3, DAY, EXPIRATION_SECONDS, null, { coin: 0n, calls: [tolerantCall(forged.to, forged.data), permit.calls[1]] });
  await assert.rejects(rpc("eth_call", [{ from: WALLET, to: broken.to, data: broken.data }, "latest"]), "no approval: the transfer fails the setup");
  ok("a permit that fails with no approval in place still fails the setup: nothing moves without the approval");
  // Somebody sees the setup waiting, and sends its permit first. The batch is sent as it was signed: unchanged.
  await sendAndWait(rpc, STRANGER, permit.permit);
  // freshPulls leaves the used permit out when it sees the approval in time: that saves its gas. Not needed any more.
  assert.equal((await freshPulls(rpc, WALLET, safe3, [permit]))[0].calls.length, 1);
  await sendAndWait(rpc, WALLET, lockTx(WALLET, safe3, DAY, EXPIRATION_SECONDS, null, { coin: 0n, calls: permit.calls }));
  assert.equal(await tokenBalance(rpc, token("USDS").address, safe3), units("USDS", 500n));
  assert.equal((await inspect(rpc, safe3)).state, "locked");
  ok("the permit somebody sent first fails inside the setup without stopping it: the approval is in place, and the tokens went in");


  step("5. A setup whose token pull fails moves nothing");
  const safe4 = safeFromReceipt(await sendAndWait(rpc, WALLET, createTx(WALLET, 43)))!;
  // The signed message is for more USDS than the wallet has.
  assert.ok(await deal(WALLET, "USDS", units("USDS", 100n)));
  const tooMuch = await signPull(rpc, signAs(WALLET), (await waysIn(rpc, 1, WALLET, [token("USDS").address]))[0] as any, token("USDS").address, WALLET, safe4, units("USDS", 9_000n));
  assert.ok(tooMuch, "a permit says nothing about the balance, so the signature itself is good");
  const failing = lockTx(WALLET, safe4, DAY, EXPIRATION_SECONDS, null, { coin: ETH, calls: tooMuch.calls });
  await assert.rejects(rpc("eth_call", [{ from: WALLET, to: failing.to, data: failing.data, value: "0x" + ETH.toString(16) }, "latest"]));
  assert.equal(await nativeBalance(rpc, safe4), 0n);
  ok("the whole setup is refused, the coin stays in the wallet");

  step("6. Prices for the list");
  const assets = [{ token: null }, ...mainnet.tokens.map((t) => ({ token: t.address, usd: t.usd }))];
  const prices = await readPrices(rpc, mainnet, assets);
  console.log("  " + ["ETH", ...symbols].map((s, i) => `${s}: ${prices[i] === null ? "no price" : "$" + (Number(prices[i]) / 1e8).toFixed(2)}`).join(", "));
  assert.ok(prices[0] !== null && prices[0] > 100_00000000n, "the coin has a price");
  assert.equal(prices[1 + symbols.indexOf("USDC")], 100_000_000n);
  assert.ok((prices[1 + symbols.indexOf("WBTC")] ?? 0n) > 1000_00000000n);
  assert.equal(prices[1 + symbols.indexOf("wstETH")], null);
  ok("the coin, the dollar tokens and the tokens with a feed have a price");

  console.log("\nAll deposit checks passed.");
} finally {
  await rpc("evm_revert", [snapshot]);
}
