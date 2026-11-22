/**
 * Money that goes into a Chronobox while it is set up.
 *
 * A token moves only when its holder calls it, or when a spender that the
 * holder approved calls it. During the setup the Chronobox still belongs to
 * the wallet and runs the setup batch, so it can pull tokens in that batch.
 * After the time delay is on, it can act only after the wait. So the setup
 * is the one moment when money can go in without a transaction of its own.
 *
 * Three ways in, from the cheapest for the owner:
 *   - the coin rides on the transaction that switches on the time delay,
 *   - a token that takes a signed message (EIP-3009 or EIP-2612) is pulled
 *     by the Chronobox in that same transaction: one free signature,
 *   - every other token is a plain transfer after the safety checks.
 *
 * This file also holds the small things around that: dollar values (to sort
 * and to label, never to set an amount), round amounts for the slider, and
 * who pays the contribution when everything goes in.
 */
import { call, decode } from "./abi.ts";
import type { Chain, Token } from "./chains.ts";
import { type Call, type Rpc, chainTime, coinPriceUsd, readMany } from "./chronobox.ts";
import { type Address, type Hex, bytesToHex, concat, keccak, sameAddress, size, strip, toBigInt, uintWord, utf8, word } from "./hex.ts";

// ---------------------------------------------------------------------------
// Dollar values
// ---------------------------------------------------------------------------

/** How old a price may be. A feed for euros or gold does not move at night or at the weekend. */
const PRICE_MAX_AGE = 3n * 86_400n;

/**
 * The price of each asset in US dollars with 8 decimals, or null where the
 * app has no source. One combined read for all feeds.
 */
export async function readPrices(rpc: Rpc, chain: Chain, assets: readonly { token: Address | null; usd?: Token["usd"] }[]): Promise<(bigint | null)[]> {
  const coin = await coinPriceUsd(rpc, chain.usdFeed);
  const feeds = [...new Set(assets.map((a) => a.usd).filter((u): u is Address => !!u && u !== "one" && u !== "coin"))];
  const byFeed = new Map<string, bigint | null>();
  if (feeds.length > 0) {
    try {
      const [answers, now] = await Promise.all([readMany(rpc, feeds.map((feed) => ({ to: feed, data: call("latestRoundData()") }))), chainTime(rpc)]);
      feeds.forEach((feed, i) => {
        const answer = answers[i];
        if (answer === null || size(answer) < 160) return byFeed.set(feed, null);
        const [, price, , updatedAt] = decode(["uint80", "uint256", "uint256", "uint256", "uint80"], answer) as bigint[];
        byFeed.set(feed, price > 0n && price < 1n << 255n && now - updatedAt <= PRICE_MAX_AGE ? price : null);
      });
    } catch {
      // No prices from the feeds. The list is then sorted without them.
    }
  }
  return assets.map((a) => {
    if (a.token === null || a.usd === "coin") return coin;
    if (a.usd === "one") return 100_000_000n;
    return a.usd ? (byFeed.get(a.usd) ?? null) : null;
  });
}

/** What an amount is worth, in US dollars with 8 decimals. */
export function usdValue(amount: bigint, decimals: number, price: bigint | null): bigint | null {
  return price === null ? null : (amount * price) / 10n ** BigInt(decimals);
}

/** "$7,440", "$12.50", "less than $0.01". Whole dollars from $100 on. */
export function formatUsd(value: bigint): string {
  const cents = (value + 500_000n) / 1_000_000n;
  if (cents === 0n) return value > 0n ? "less than $0.01" : "$0";
  if (cents >= 10_000n) return "$" + ((cents + 50n) / 100n).toLocaleString("en-US");
  return "$" + (cents / 100n).toLocaleString("en-US") + "." + (cents % 100n).toString().padStart(2, "0");
}

const ONE_DOLLAR = 100_000_000n;

/**
 * The assets that an address holds, most important first: by dollar value
 * where the app knows it, then the main tokens without a price, then the
 * rest of the long list, and at the end what is worth less than a dollar.
 * The answer is a list of positions in `assets`.
 */
export function holdingOrder(assets: readonly { main?: boolean }[], balances: readonly (bigint | null)[], values: readonly (bigint | null)[]): number[] {
  const held = assets.map((_, i) => i).filter((i) => (balances[i] ?? 0n) > 0n);
  const group = (i: number): number => {
    const value = values[i];
    if (value === null || value === undefined) return assets[i].main ? 1 : 2;
    return value >= ONE_DOLLAR ? 0 : 3;
  };
  return held.sort((a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 0 || ga === 3) {
      const va = values[a]!;
      const vb = values[b]!;
      if (va !== vb) return va > vb ? -1 : 1;
    }
    return a - b;
  });
}

// ---------------------------------------------------------------------------
// Round amounts for the slider
// ---------------------------------------------------------------------------

/** The slider counts in thousandths of what the wallet holds. */
export const SLIDER_FULL = 1000;
/** A quarter, a half, three quarters, everything. */
export const SLIDER_STOPS = [250, 500, 750, 1000] as const;

/**
 * The size of one step: the amounts of the slider have three digits that
 * count. With 12,345 USDC it moves in hundreds, with 2.4 ETH in hundredths.
 */
export function roundStep(max: bigint): bigint {
  const digits = max.toString().length;
  return digits > 3 ? 10n ** BigInt(digits - 3) : 1n;
}

/** The amount at a place on the slider: a round number, and exactly everything at the end. */
export function amountAt(part: number, max: bigint): bigint {
  if (max <= 0n || part <= 0) return 0n;
  if (part >= SLIDER_FULL) return max;
  const step = roundStep(max);
  const exact = (max * BigInt(Math.round(part))) / BigInt(SLIDER_FULL);
  const rounded = ((exact + step / 2n) / step) * step;
  return rounded > max ? max : rounded;
}

/** The place on the slider for an amount that was typed. More than everything is the end of the slider. */
export function partOf(amount: bigint, max: bigint): number {
  if (max <= 0n || amount <= 0n) return 0;
  if (amount >= max) return SLIDER_FULL;
  return Number((amount * BigInt(SLIDER_FULL) + max / 2n) / max);
}

/** A slider that comes close to a stop goes to it. Close to the start, it goes back to nothing. */
export function snapPart(part: number, reach = 14): number {
  if (part <= reach) return 0;
  for (const stop of SLIDER_STOPS) if (Math.abs(part - stop) <= reach) return stop;
  return part;
}

/**
 * The most coin that can go in: what the wallet holds, less what it must
 * keep (see feeReserves), cut to four digits that count. The rest stays in
 * the wallet. A little more for fees does no harm.
 */
export function coinMax(held: bigint, reserve: bigint): bigint {
  const most = held - reserve;
  if (most <= 0n) return 0n;
  const step = roundStep(most) / 10n || 1n;
  return (most / step) * step;
}

/**
 * Coin that a wallet keeps when "everything" goes in.
 *   setup: the network fees of the setup itself: its two transactions and a
 *          few transfers after them, at twice the price of now.
 *   later: what is still there when the setup is over. The wallet is the
 *          only way to withdraw or to cancel, and both cost a fee. A wallet
 *          with no coin could do neither. Enough for a few transactions at
 *          four times the price of now, and never less than `keep`.
 * With no price from the network: fixed amounts.
 */
export type Reserves = { setup: bigint; later: bigint };

export async function feeReserves(rpc: Rpc, keep: bigint): Promise<Reserves> {
  try {
    const price = toBigInt((await rpc("eth_gasPrice", [])) as string);
    if (price > 0n) {
      // The setup uses about 1.1 million gas, and a transfer after it 65,000. Half as much again on top.
      const later = price * 4n * 300_000n;
      return { setup: price * 2_100_000n, later: later > keep ? later : keep };
    }
  } catch {
    // Fall through.
  }
  return { setup: 10_000_000_000_000_000n, later: keep };
}

/**
 * The coin for later is never more than a quarter of what the wallet holds.
 * A wallet with a few dollars in it, for a first try, can then still put
 * most of them in.
 */
export function laterCoin(reserves: Reserves, held: bigint): bigint {
  return reserves.later < held / 4n ? reserves.later : held / 4n;
}

/** All the coin that stays in the wallet when "everything" goes in. */
export function keptCoin(reserves: Reserves, held: bigint): bigint {
  return reserves.setup + laterCoin(reserves, held);
}

// ---------------------------------------------------------------------------
// Who pays the contribution
// ---------------------------------------------------------------------------

/** One asset that the owner chose to put in. `inSetup`: it moves inside the setup transaction. */
export type Pick = { token: Address | null; amount: bigint; decimals: number; dollar: boolean; inSetup: boolean };

/**
 * Where the contribution comes from, and what stays in the Chronobox of each pick.
 *   token:  it is taken from a dollar token that goes in. Ten dollars are ten tokens.
 *   coin:   it is taken from the coin that goes in.
 *   wallet: the wallet pays it in coin, on top of what goes in.
 */
export type Split =
  | { from: "none" | "wallet" | "coin"; stays: bigint[] }
  | { from: "token"; token: Address; fee: bigint; stays: bigint[] };

/**
 * The suggested contribution in whole dollars, for an amount of money in
 * dollars (8 decimals). `steps` is CONTRIBUTION_STEPS: largest first.
 */
export function suggestedGive(money: bigint | null, steps: readonly (readonly [number, number])[]): number {
  if (money === null) return 0;
  for (const [from, give] of steps) if (money >= BigInt(from) * ONE_DOLLAR) return give;
  return 0;
}

/**
 * What the owner can choose in place of the suggestion: nothing, up to two
 * smaller amounts, the suggestion, and one larger amount. The larger one is
 * the next step, or twice the suggestion when there is no next step.
 */
export function giveChoices(suggested: number, steps: readonly (readonly [number, number])[]): number[] {
  if (suggested <= 0) return [0];
  const amounts = steps.map(([, give]) => give).sort((a, b) => a - b);
  const less = amounts.filter((give) => give < suggested).slice(-2);
  const more = amounts.find((give) => give > suggested) ?? suggested * 2;
  return [0, ...less, suggested, more];
}

/**
 * The amount that counts, from the owner's choice and the suggestion of
 * now. The suggestion moves when other amounts go in. A choice to give less
 * never becomes more than the suggestion, and "nothing" stays nothing. A
 * choice to give more never becomes less than the suggestion, and never
 * more than the largest choice on offer.
 */
export function chosenGive(pick: { usd: number; more: boolean } | null, suggested: number, choices: readonly number[]): number {
  if (pick === null || suggested <= 0) return suggested;
  if (!pick.more) return Math.min(pick.usd, suggested);
  return Math.max(suggested, Math.min(pick.usd, choices[choices.length - 1]));
}

/**
 * The contribution is a part of the money that goes in, and the owner sees
 * it while choosing the amounts. So "everything" stays everything, and the
 * wallet needs no extra coin for it. It is taken from a dollar token that
 * goes in (ten dollars are ten tokens), or from the coin that goes in.
 * When neither goes in during the setup, the wallet pays it on top in coin,
 * if it has that coin beyond `reserve`. Null when nothing can pay it: the
 * setup then goes on without a contribution.
 */
export function splitContribution(picks: readonly Pick[], give: { cents: bigint; coin: bigint } | null, coinHeld: bigint, reserve: bigint): Split | null {
  const stays = picks.map((p) => p.amount);
  if (!give || give.cents <= 0n || give.coin <= 0n) return { from: "none", stays };

  let best = -1;
  let bestFee = 0n;
  picks.forEach((p, i) => {
    if (!p.token || !p.dollar || !p.inSetup || p.decimals < 2) return;
    const fee = give.cents * 10n ** BigInt(p.decimals - 2);
    if (p.amount > fee && (best < 0 || p.amount * 10n ** BigInt(36 - p.decimals) > picks[best].amount * 10n ** BigInt(36 - picks[best].decimals))) {
      best = i;
      bestFee = fee;
    }
  });
  if (best >= 0) {
    stays[best] -= bestFee;
    return { from: "token", token: picks[best].token!, fee: bestFee, stays };
  }
  const coinAt = picks.findIndex((p) => p.token === null);
  const coinIn = coinAt >= 0 ? picks[coinAt].amount : 0n;
  if (coinIn > give.coin) {
    stays[coinAt] -= give.coin;
    return { from: "coin", stays };
  }
  if (coinIn + give.coin + reserve <= coinHeld) return { from: "wallet", stays };
  return null;
}

// ---------------------------------------------------------------------------
// Tokens that take a signed message
// ---------------------------------------------------------------------------

export type Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

/**
 * How a token gets into the Chronobox during the setup.
 *   authorization: EIP-3009. The owner signs a transfer that only the receiver can collect.
 *   permit:        EIP-2612. The owner signs an approval, the Chronobox uses it at once.
 *   transfer:      no signed message. A plain transfer, after the setup.
 */
export type Way = { kind: "authorization"; domain: Domain } | { kind: "permit"; domain: Domain; nonce: bigint } | { kind: "transfer" };

const DOMAIN_TYPE = keccak(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const PERMIT_TYPE = keccak(utf8("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"));

export function domainSeparator(domain: Domain): Hex {
  return keccak(concat(DOMAIN_TYPE, keccak(utf8(domain.name)), keccak(utf8(domain.version)), uintWord(domain.chainId), word(domain.verifyingContract)));
}

const isWord = (answer: Hex | null): answer is Hex => answer !== null && size(answer) === 32;

/**
 * Finds the way in for each token, from the token itself. A signed message
 * is offered only when the token's own domain separator is the one this app
 * would sign for: a signature for another domain would be worth nothing.
 * When the read fails, every token is a plain transfer.
 */
export async function waysIn(rpc: Rpc, chainId: number, wallet: Address, tokens: readonly Address[]): Promise<Way[]> {
  if (tokens.length === 0) return [];
  const asks = tokens.flatMap((token) => [
    { to: token, data: call("DOMAIN_SEPARATOR()") },
    { to: token, data: call("name()") },
    { to: token, data: call("version()") },
    { to: token, data: call("nonces(address)", [wallet]) },
    { to: token, data: call("authorizationState(address,bytes32)", [wallet, "0x" + "00".repeat(32)]) },
    { to: token, data: call("PERMIT_TYPEHASH()") },
  ]);
  let answers: (Hex | null)[];
  try {
    answers = await readMany(rpc, asks);
  } catch {
    return tokens.map(() => ({ kind: "transfer" }));
  }
  const text = (answer: Hex | null): string | null => {
    if (answer === null) return null;
    try {
      return decode(["string"], answer)[0] as string;
    } catch {
      return null;
    }
  };
  return tokens.map((token, i): Way => {
    const [separator, name, version, nonces, authorization, permitType] = answers.slice(i * 6, i * 6 + 6);
    const tokenName = text(name);
    if (!isWord(separator) || !tokenName) return { kind: "transfer" };
    const versions = [...new Set([text(version), "1", "2"].filter((v): v is string => !!v))];
    const domain = versions
      .map((v) => ({ name: tokenName, version: v, chainId, verifyingContract: token }))
      .find((d) => domainSeparator(d).toLowerCase() === separator.toLowerCase());
    if (!domain) return { kind: "transfer" };
    if (isWord(authorization)) return { kind: "authorization", domain };
    // A token with its own permit format (DAI on Ethereum) names another type. A signature for the standard type would be refused.
    if (isWord(nonces) && (!isWord(permitType) || permitType.toLowerCase() === PERMIT_TYPE.toLowerCase())) return { kind: "permit", domain, nonce: toBigInt(nonces) };
    return { kind: "transfer" };
  });
}

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** What the wallet is asked to sign (EIP-712), for one token and one amount. `salt`: 32 random bytes, used by EIP-3009 only. */
export function pullMessage(way: Exclude<Way, { kind: "transfer" }>, wallet: Address, safe: Address, amount: bigint, deadline: bigint, salt: Hex): object {
  if (way.kind === "authorization") {
    return {
      types: {
        EIP712Domain: DOMAIN_FIELDS,
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      domain: way.domain,
      message: { from: wallet, to: safe, value: amount.toString(), validAfter: "0", validBefore: deadline.toString(), nonce: salt },
    };
  }
  return {
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: way.domain,
    message: { owner: wallet, spender: safe, value: amount.toString(), nonce: way.nonce.toString(), deadline: deadline.toString() },
  };
}

/** A signed pull, ready for the setup batch: the calls that the Chronobox makes. */
export type Pull = { token: Address; amount: bigint; kind: "authorization" | "permit"; calls: Call[] };

/** The three parts of a plain signature of 65 bytes. Null for anything else (a contract wallet signs in another way). */
export function splitSignature(signature: string): { v: number; r: Hex; s: Hex } | null {
  const hex = strip(signature);
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;
  const last = parseInt(hex.slice(128), 16);
  const v = last < 27 ? last + 27 : last;
  if (v !== 27 && v !== 28) return null;
  return { v, r: ("0x" + hex.slice(0, 64)) as Hex, s: ("0x" + hex.slice(64, 128)) as Hex };
}

/** The calls of the Chronobox for one signed message. */
export function pullCalls(way: Exclude<Way, { kind: "transfer" }>, token: Address, wallet: Address, safe: Address, amount: bigint, deadline: bigint, salt: Hex, signature: { v: number; r: Hex; s: Hex }): Call[] {
  const { v, r, s } = signature;
  if (way.kind === "authorization") {
    return [
      {
        to: token,
        data: call("receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)", [wallet, safe, amount, 0n, deadline, salt, v, r, s]),
      },
    ];
  }
  return [
    { to: token, data: call("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", [wallet, safe, amount, deadline, v, r, s]) },
    { to: token, data: call("transferFrom(address,address,uint256)", [wallet, safe, amount]) },
  ];
}

/** How long a signed message stays good. Long enough for a slow setup, short enough to be gone the same day. */
export const PULL_SECONDS = 3600n;

/**
 * Asks the wallet for one signed message and tries it against the token
 * before anything is sent. Null when the token does not take the signature:
 * that token then goes in with a plain transfer. A refusal by the owner is
 * thrown, as the wallet gave it.
 */
export async function signPull(
  rpc: Rpc,
  sign: (data: object) => Promise<string>,
  way: Exclude<Way, { kind: "transfer" }>,
  token: Address,
  wallet: Address,
  safe: Address,
  amount: bigint,
): Promise<Pull | null> {
  const deadline = (await chainTime(rpc)) + PULL_SECONDS;
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const signature = splitSignature(await sign(pullMessage(way, wallet, safe, amount, deadline, salt)));
  if (!signature) return null;
  const calls = pullCalls(way, token, wallet, safe, amount, deadline, salt, signature);
  try {
    // The Chronobox is the caller. For EIP-3009 only the receiver can collect, so the test must come from its address.
    await rpc("eth_call", [{ from: safe, to: token, data: calls[0].data }, "latest"]);
  } catch {
    return null;
  }
  return { token, amount, kind: way.kind, calls };
}

/**
 * A permit can be used by anybody who sees it, and then it cannot be used
 * again. The approval is in place all the same, so the pull goes on without
 * the permit call.
 */
export async function freshPulls(rpc: Rpc, wallet: Address, safe: Address, pulls: readonly Pull[]): Promise<Pull[]> {
  const permits = pulls.filter((p) => p.kind === "permit" && p.calls.length === 2);
  if (permits.length === 0) return [...pulls];
  const allowances = await readMany(rpc, permits.map((p) => ({ to: p.token, data: call("allowance(address,address)", [wallet, safe]) })));
  return pulls.map((pull) => {
    const at = permits.indexOf(pull);
    const allowance = at >= 0 ? allowances[at] : null;
    return isWord(allowance) && toBigInt(allowance) >= pull.amount ? { ...pull, calls: [pull.calls[1]] } : pull;
  });
}

/** A contribution in a token: the Chronobox passes it on from what it pulled. */
export function tokenPayment(token: Address, to: Address, amount: bigint, safe: Address): Call {
  if (amount <= 0n || sameAddress(to, safe) || sameAddress(to, "0x0000000000000000000000000000000000000000")) throw new Error("The contribution is not valid");
  return { to: token, data: call("transfer(address,uint256)", [to, amount]) };
}
