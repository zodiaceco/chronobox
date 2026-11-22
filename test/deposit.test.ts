import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTRIBUTION_STEPS } from "../src/lib/chains.ts";
import {
  type Pick,
  amountAt,
  coinMax,
  domainSeparator,
  chosenGive,
  feeReserves,
  formatUsd,
  giveChoices,
  holdingOrder,
  keptCoin,
  laterCoin,
  suggestedGive,
  partOf,
  pullCalls,
  pullMessage,
  roundStep,
  snapPart,
  splitContribution,
  splitSignature,
  usdValue,
} from "../src/lib/deposit.ts";
import { formatUnits, parseUnits } from "../src/lib/format.ts";
import type { Address, Hex } from "../src/lib/hex.ts";

const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WALLET: Address = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const SAFE: Address = "0x51C0bE5A9a3F0c1dB7d2E84F6a09C3bD4E7f2A18";
const units = (text: string, decimals: number) => parseUnits(text, decimals)!;

test("the slider gives round amounts: whole numbers for much, decimals for little", () => {
  const usdc = units("12345.678901", 6);
  assert.equal(formatUnits(roundStep(usdc), 6), "100");
  assert.equal(formatUnits(amountAt(250, usdc), 6), "3100");
  assert.equal(formatUnits(amountAt(500, usdc), 6), "6200");
  assert.equal(formatUnits(amountAt(750, usdc), 6), "9300");
  // Everything is everything, to the last unit.
  assert.equal(amountAt(1000, usdc), usdc);

  const eth = units("2.4", 18);
  assert.deepEqual([250, 500, 750].map((p) => formatUnits(amountAt(p, eth), 18)), ["0.6", "1.2", "1.8"]);
  assert.equal(formatUnits(amountAt(333, eth), 18), "0.8");

  const small = units("0.8371", 18);
  assert.deepEqual([250, 500, 750].map((p) => formatUnits(amountAt(p, small), 18)), ["0.209", "0.419", "0.628"]);

  const round = units("3000", 6);
  assert.deepEqual([250, 500, 750].map((p) => formatUnits(amountAt(p, round), 6)), ["750", "1500", "2250"]);

  // A token with very little in it: the step is never smaller than one unit.
  assert.equal(amountAt(500, 7n), 3n);
  assert.equal(amountAt(0, usdc), 0n);
  assert.equal(amountAt(500, 0n), 0n);
});

test("an amount is never more than what is there", () => {
  for (const max of [999n, 1005n, units("0.999999", 6), units("99999.99", 6), 10n ** 18n - 1n]) {
    for (let part = 0; part <= 1000; part++) assert.ok(amountAt(part, max) <= max, `${part} of ${max}`);
  }
});

test("a typed amount has a place on the slider", () => {
  const max = units("2000", 6);
  assert.equal(partOf(units("500", 6), max), 250);
  assert.equal(partOf(units("2000", 6), max), 1000);
  assert.equal(partOf(units("9000", 6), max), 1000);
  assert.equal(partOf(0n, max), 0);
  assert.equal(partOf(5n, 0n), 0);
});

test("the slider goes to a stop when it comes close", () => {
  assert.equal(snapPart(243), 250);
  assert.equal(snapPart(262), 250);
  assert.equal(snapPart(300), 300);
  assert.equal(snapPart(990), 1000);
  assert.equal(snapPart(9), 0);
  assert.equal(snapPart(500), 500);
});

test("the most coin that can go in leaves the fees, and is a short number", () => {
  assert.equal(formatUnits(coinMax(units("2.4", 18), units("0.0068", 18)), 18), "2.393");
  assert.equal(coinMax(units("0.005", 18), units("0.0068", 18)), 0n);
  assert.equal(formatUnits(coinMax(units("123.456789", 18), units("0.01", 18)), 18), "123.4");
});

test("dollar values", () => {
  assert.equal(usdValue(units("2.4", 18), 18, 3_100_00000000n), 7_440_00000000n);
  assert.equal(usdValue(units("5", 6), 6, null), null);
  assert.equal(formatUsd(7_440_00000000n), "$7,440");
  assert.equal(formatUsd(12_50000000n), "$12.50");
  assert.equal(formatUsd(99_99600000n), "$100");
  assert.equal(formatUsd(400000n), "less than $0.01");
  assert.equal(formatUsd(0n), "$0");
});

test("what the wallet holds is sorted by value, then by importance, and dust comes last", () => {
  const assets = [{ main: true }, { main: true }, { main: true }, { main: false }, { main: true }, { main: false }, { main: true }];
  //               coin $50        USDC $9,000     wstETH no price  LONG no price    dust 20 cents    nothing held     DAI $300
  const balances = [1n, 1n, 1n, 1n, 1n, 0n, 1n];
  const values = [50_00000000n, 9000_00000000n, null, null, 20000000n, null, 300_00000000n];
  assert.deepEqual(holdingOrder(assets, balances, values), [1, 6, 0, 2, 3, 4]);
  assert.deepEqual(holdingOrder(assets, [null, 0n, null, 0n, 0n, 0n, 0n], values), []);
});

const coin = (amount: string): Pick => ({ token: null, amount: units(amount, 18), decimals: 18, dollar: false, inSetup: true });
const usdc = (amount: string, inSetup = true): Pick => ({ token: USDC, amount: units(amount, 6), decimals: 6, dollar: true, inSetup });
const give = { cents: 1000n, coin: units("0.0031", 18) };
const reserve = units("0.0068", 18);
const usd = (dollars: number) => BigInt(dollars) * 100_000_000n;

test("the suggestion follows the money: nothing for a few dollars, one for a hundred, never more than fifty", () => {
  const suggest = (dollars: number) => suggestedGive(usd(dollars), CONTRIBUTION_STEPS);
  assert.deepEqual([10, 99, 100, 499, 500, 1000, 2500, 4999, 5000, 10_000_000].map(suggest), [0, 0, 1, 1, 5, 10, 25, 25, 50, 50]);
  assert.equal(suggestedGive(null, CONTRIBUTION_STEPS), 0);
  // About one part in a hundred at the start of each step, and less after it.
  for (const [from, amount] of CONTRIBUTION_STEPS) assert.ok(amount * 100 <= from);
});

test("the owner can make it smaller, down to nothing, or one step larger", () => {
  assert.deepEqual(giveChoices(50, CONTRIBUTION_STEPS), [0, 10, 25, 50, 100]);
  assert.deepEqual(giveChoices(25, CONTRIBUTION_STEPS), [0, 5, 10, 25, 50]);
  assert.deepEqual(giveChoices(10, CONTRIBUTION_STEPS), [0, 1, 5, 10, 25]);
  assert.deepEqual(giveChoices(1, CONTRIBUTION_STEPS), [0, 1, 5]);
  assert.deepEqual(giveChoices(0, CONTRIBUTION_STEPS), [0]);
});

test("a choice holds when the suggestion moves under it", () => {
  const at = (suggested: number) => giveChoices(suggested, CONTRIBUTION_STEPS);
  // No choice: the suggestion.
  assert.equal(chosenGive(null, 50, at(50)), 50);
  // "Nothing" stays nothing, however much goes in.
  assert.equal(chosenGive({ usd: 0, more: false }, 50, at(50)), 0);
  // Less stays less, and is never more than a smaller suggestion.
  assert.equal(chosenGive({ usd: 10, more: false }, 50, at(50)), 10);
  assert.equal(chosenGive({ usd: 10, more: false }, 5, at(5)), 5);
  // More stays more: not above the largest choice on offer, and not below a suggestion that grew.
  assert.equal(chosenGive({ usd: 100, more: true }, 50, at(50)), 100);
  assert.equal(chosenGive({ usd: 100, more: true }, 10, at(10)), 25);
  assert.equal(chosenGive({ usd: 25, more: true }, 50, at(50)), 50);
  // Below the first step nothing is asked, whatever was chosen before.
  assert.equal(chosenGive({ usd: 100, more: true }, 0, at(0)), 0);
});

test("the contribution is a part of what goes in: from a dollar token first, ten dollars are ten tokens", () => {
  const split = splitContribution([coin("1"), usdc("5000")], give, units("2.4", 18), reserve)!;
  assert.ok(split.from === "token" && split.fee === units("10", 6) && split.token === USDC);
  assert.deepEqual(split.stays, [units("1", 18), units("4990", 6)]);
  // The wallet needs no coin for it.
  assert.equal(splitContribution([usdc("50")], give, 0n, reserve)!.from, "token");
});

test("with no dollar token in the setup, it comes from the coin that goes in", () => {
  const split = splitContribution([coin("2.39"), usdc("12000", false)], give, units("2.4", 18), reserve)!;
  assert.equal(split.from, "coin");
  assert.deepEqual(split.stays, [units("2.3869", 18), units("12000", 6)]);
});

test("when nothing that goes in can pay it, the wallet pays on top, if it has the coin", () => {
  assert.equal(splitContribution([usdc("5000", false)], give, units("0.02", 18), reserve)!.from, "wallet");
  assert.equal(splitContribution([], give, units("0.02", 18), reserve)!.from, "wallet");
  assert.equal(splitContribution([coin("1")], null, 0n, reserve)!.from, "none");
});

test("a contribution that nothing can pay is no reason to stop: the answer is null, and the setup goes on without it", () => {
  assert.equal(splitContribution([usdc("5000", false)], give, units("0.001", 18), reserve), null);
  assert.equal(splitContribution([], give, units("0.001", 18), reserve), null);
  assert.equal(splitContribution([coin("0.002")], give, units("0.004", 18), reserve), null);
});

test("the wallet keeps coin for the fees: what the setup costs, and a little for later", async () => {
  const gwei = 10n ** 9n;
  const rpcAt = (price: bigint) => async () => "0x" + price.toString(16);
  const keep = units("0.005", 18);
  const quiet = await feeReserves(rpcAt(gwei), keep);
  assert.deepEqual(quiet, { setup: units("0.0021", 18), later: keep });
  // A busy day: more stays for later.
  assert.equal((await feeReserves(rpcAt(30n * gwei), keep)).later, 30n * gwei * 4n * 300_000n);
  // A network that gives no price.
  const silent = await feeReserves(async () => {
    throw new Error("no answer");
  }, keep);
  assert.deepEqual(silent, { setup: units("0.01", 18), later: keep });

  // A wallet with real money: everything but the fees goes in.
  assert.equal(formatUnits(coinMax(units("2.4", 18), keptCoin(quiet, units("2.4", 18))), 18), "2.392");
  // A wallet for a first try, with about ten dollars: most of it can go in. The coin for later is a quarter at most.
  const small = units("0.006", 18);
  assert.equal(laterCoin(quiet, small), units("0.0015", 18));
  assert.equal(formatUnits(coinMax(small, keptCoin(quiet, small)), 18), "0.0024");
  // A wallet that cannot pay for the setup itself.
  assert.equal(coinMax(units("0.002", 18), keptCoin(quiet, units("0.002", 18))), 0n);
});

test("the domain separator of USDC on Ethereum", () => {
  // Read from the token: DOMAIN_SEPARATOR() of 0xA0b8…eB48.
  assert.equal(
    domainSeparator({ name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC }),
    "0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335",
  );
});

test("a signature has three parts, and a contract wallet's signature is not one", () => {
  const r = "11".repeat(32);
  const s = "22".repeat(32);
  assert.deepEqual(splitSignature("0x" + r + s + "1c"), { v: 28, r: ("0x" + r) as Hex, s: ("0x" + s) as Hex });
  assert.equal(splitSignature("0x" + r + s + "00")!.v, 27);
  assert.equal(splitSignature("0x" + r + s + "1c" + "00"), null);
  assert.equal(splitSignature("0x" + r + s + "05"), null);
  assert.equal(splitSignature("0x"), null);
});

test("the signed message names the Chronobox, the amount and the time limit", () => {
  const domain = { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC };
  const salt = ("0x" + "ab".repeat(32)) as Hex;
  const authorization = pullMessage({ kind: "authorization", domain }, WALLET, SAFE, 5_000_000_000n, 1_800_000_000n, salt) as any;
  assert.equal(authorization.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(authorization.message, { from: WALLET, to: SAFE, value: "5000000000", validAfter: "0", validBefore: "1800000000", nonce: salt });
  const permit = pullMessage({ kind: "permit", domain, nonce: 7n }, WALLET, SAFE, 5_000_000_000n, 1_800_000_000n, salt) as any;
  assert.equal(permit.primaryType, "Permit");
  assert.deepEqual(permit.message, { owner: WALLET, spender: SAFE, value: "5000000000", nonce: "7", deadline: "1800000000" });

  const signature = { v: 27, r: ("0x" + "11".repeat(32)) as Hex, s: ("0x" + "22".repeat(32)) as Hex };
  assert.equal(pullCalls({ kind: "authorization", domain }, USDC, WALLET, SAFE, 1n, 2n, salt, signature).length, 1);
  const calls = pullCalls({ kind: "permit", domain, nonce: 7n }, USDC, WALLET, SAFE, 1n, 2n, salt, signature);
  assert.equal(calls.length, 2);
  // transferFrom(wallet, safe, 1)
  assert.ok(calls[1].data.startsWith("0x23b872dd"));
});
