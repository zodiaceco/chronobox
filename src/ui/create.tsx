/**
 * Creating a Chronobox, one question per screen: network, delay, two promises,
 * money to put in, review, then the result. Every answer stays when you go back.
 *
 * Money can go in during the setup (see lib/deposit.ts). A wallet that can
 * batch does all of it with one confirmation. Any other wallet sends the coin
 * with the second setup transaction, signs for the tokens that take a signed
 * message, and sends the other tokens one by one after the safety checks.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Chain, CHAINS, CONTRIBUTION_RECEIVER, CONTRIBUTION_STEPS } from "../lib/chains.ts";
import { type Pick, type Pull, type Reserves, type Split, type Way, coinMax, feeReserves, chosenGive, formatUsd, freshPulls, giveChoices, holdingOrder, keptCoin, laterCoin, readPrices, signPull, splitContribution, suggestedGive, tokenPayment, usdValue, waysIn } from "../lib/deposit.ts";
import { formatAmount, formatDuration, parseUnits } from "../lib/format.ts";
import { type Address, sameAddress, toQuantity } from "../lib/hex.ts";
import { blockHints, clearSetupAmounts, rememberVault, setupAmountsFor } from "../lib/store.ts";
import {
  EXPIRATION_SECONDS,
  type TxRequest,
  arrivedInReceipt,
  depositTx,
  coinPriceUsd,
  usdToCoin,
  MAX_COOLDOWN,
  MIN_COOLDOWN,
  createTx,
  discover,
  inspect,
  isHalfMade,
  lockTx,
  nativeBalance,
  predictRoles,
  predictSafe,
  safeFromReceipt,
  sendAndWait,
  setupCalls,
  askSlowAfterMs,
  slowAfterMs,
  tokenBalance,
} from "../lib/chronobox.ts";
import { StoppedAsking, answerOrStop, assertWallet, canBatch, errorText, isRejection, isTemporary, sendCalls, signTyped, waitForBatch } from "../lib/wallet.ts";
import { AddressText, type Asset, assetsOf, Button, Choice, Notice, type Session, Tick, useBalancesState } from "./common.tsx";
import { DepositPanel } from "./deposit.tsx";
import { FundList } from "./fund.tsx";
import { OnUs, Support } from "./give.tsx";
import { Mark } from "./logo.tsx";

// Plain lengths, without a word on which is better: the owner knows what is right for them.
const PRESETS: { label: string; seconds: bigint }[] = [
  { label: "12 hours", seconds: 12n * 3600n },
  { label: "1 day", seconds: 24n * 3600n },
  { label: "1 week", seconds: 7n * 24n * 3600n },
];

/**
 * Where the voluntary contribution goes. A build without a receiver does not
 * ask. The dev server uses a throwaway address so that the step can be seen.
 */
const RECEIVER: Address | null = CONTRIBUTION_RECEIVER ?? (__DEV__ ? "0x000000000000000000000000000000000000c0de" : null);

type Plan = { index: number; safe: Address; created: boolean };
type StepId = "network" | "delay" | "promises" | "fund" | "review";
/**
 * Where the setup stands: the id of a row on the working screen ("sign:3",
 * "create", "lock", "check", "send:3", "batch"), or "waiting" for a batch
 * that the wallet holds.
 */
type Progress = string;
/** One asset that the owner chose: where it is in the list of assets, the amount as typed and as a number. */
type Chosen = { index: number; asset: Asset; text: string; amount: bigint | null };
/** An amount for the result screen. */
type Line = { symbol: string; text: string };

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const times = (n: number): string => (n === 1 ? "once" : n === 2 ? "twice" : `${COUNT[n] ?? n} times`);
/** "a", "a and b", "a, b and c". */
const listOf = (parts: string[]): string => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
/** The same for parts that can have an "and" inside: "a, b and c, and d". */
const stepsOf = (parts: string[]): string => (parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`);
/** ?fund=one shows the slider on the row in use only. A way to compare the two layouts. */
const CALM = new URLSearchParams(location.search).get("fund") === "one";

function Screen(props: { title: string; lead?: string; children: ComponentChildren }) {
  return (
    <div class="wiz-screen">
      <h1 class="wiz-title">{props.title}</h1>
      {props.lead ? <p class="wiz-lead">{props.lead}</p> : null}
      {props.children}
    </div>
  );
}

export function CreatePage(props: { session: Session; chain: Chain | undefined; onDone: (chain: Chain, safe: Address) => void }) {
  const { session, chain } = props;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [step, setStepRaw] = useState(0);
  // Which way the next screen comes in: from the right when going on, from the left when going back.
  const [back, setBack] = useState(false);
  const setStep = (next: number) => {
    setBack(next < step);
    setStepRaw(next);
  };
  const [preset, setPreset] = useState<number | "custom">(1);
  // The network the user tapped, until the wallet has followed.
  const [pickedChain, setPickedChain] = useState<number | null>(null);
  useEffect(() => setPickedChain(null), [session.chainId]);
  const [customValue, setCustomValue] = useState("3");
  const [customUnit, setCustomUnit] = useState<"hours" | "days">("days");
  const [keepSafe, setKeepSafe] = useState(false);
  const [gladToWait, setGladToWait] = useState(false);
  // What goes in, as typed: one text for each asset, by its place in the list of assets.
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  // Another network or wallet has other assets. A choice made for the old one does not carry over.
  // What was picked on the start page for this wallet and network, before the setup, is where this step starts.
  useEffect(() => setAmounts((chain ? setupAmountsFor(chain.id, session.account) : null) ?? {}), [chain?.id, session.account]);
  const [prices, setPrices] = useState<(bigint | null)[]>([]);
  // Coin that the wallet keeps: for the fees of the setup, and for the fees of a withdrawal or a cancel later.
  const [reserve, setReserve] = useState<Reserves | null>(null);
  // How each chosen token can go in. `key` names the tokens that the answer is for.
  const [ways, setWays] = useState<{ key: string; byToken: Map<string, Way> } | null>(null);
  // Tokens whose signed message did not work in this run. They go in with a transfer of their own.
  const [demoted, setDemoted] = useState<number[]>([]);
  // Did this run have to create the Chronobox? The working screen keeps that row.
  const makes = useRef(true);
  // The contribution: a suggested amount in dollars, lower choices behind "Donate less", or any amount including 0.
  // The owner's own choice in dollars, and whether it was more than the suggestion at that moment. Null: the amount that the app suggests.
  const [givePick, setGivePick] = useState<{ usd: number; more: boolean } | null>(null);
  const [price, setPrice] = useState<bigint | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ chain: Chain; safe: Address; unverified: boolean; inside: Line[] | null; stayed: Line[]; gave: string | null; uncertain?: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const [balancesRound, setBalancesRound] = useState(0);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // A confirmation that takes long gets a way out. Stopping the wait does not undo what was sent.
  const [slow, setSlow] = useState(false);
  const stop = useRef(false);
  const running = useRef(false);
  // Has the wallet answered the question of the step that runs now? Then the transaction is on its way.
  const [sent, setSent] = useState(false);
  // "Ask my wallet again": stop the question that got no answer, and start the setup again at once.
  const again = useRef(false);
  const runAgain = useRef<() => void>(() => undefined);
  // The setup batch that the wallet may still hold after "Stop waiting". The next press waits for it again.
  const pending = useRef<{ id: string; chainId: number; wallet: Address; safe: Address } | null>(null);

  useEffect(() => {
    let stale = false;
    setBatch(false);
    if (chain) canBatch(session.wallet.provider, session.account, chain.id).then((yes) => !stale && setBatch(yes));
    return () => {
      stale = true;
    };
  }, [session.wallet, session.account, chain]);

  /**
   * What is the next step for this wallet on this network? Read from the chain every time, so
   * that a step which has landed is never sent again.
   */
  const findPlan = async (): Promise<Plan> => {
    const found = await discover(session.rpc, session.account);
    // A Chronobox whose setup stopped after the first step comes first.
    for (const vault of found) {
      if (await isHalfMade(session.rpc, vault.safe, session.account)) return { index: vault.index, safe: vault.safe, created: true };
    }
    return { index: found.length, safe: predictSafe(session.account, found.length), created: false };
  };

  useEffect(() => {
    if (!chain) return;
    let stale = false;
    setPlan(null);
    setLoadError(null);
    findPlan().then(
      (next) => !stale && setPlan(next),
      (e) => !stale && setLoadError(errorText(e)),
    );
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account, chain, reload]);

  // Each step starts with a question to the wallet. `sent` turns true when the wallet has answered it.
  useEffect(() => setSent(false), [progress]);
  const answered = sent || progress === "waiting";
  useEffect(() => {
    setSlow(false);
    if (!progress || progress === "check") return;
    // A wallet that does not answer gets a way out sooner than a transaction that is on its way.
    const timer = setTimeout(() => setSlow(true), answered ? slowAfterMs() : askSlowAfterMs());
    return () => clearTimeout(timer);
  }, [progress, answered]);

  const assets: Asset[] = useMemo(() => (chain ? assetsOf(chain) : []), [chain]);
  const balanceState = useBalancesState(session.rpc, chain ? session.account : null, assets, balancesRound);
  const walletBalances = balanceState.balances;
  const balancesFailed = !balanceState.loading && !balanceState.complete && walletBalances.length === assets.length && walletBalances.every((b) => b === null);

  useEffect(() => {
    setPrices([]);
    setReserve(null);
    if (!chain) return;
    let stale = false;
    readPrices(session.rpc, chain, assets).then(
      (read) => !stale && setPrices(read),
      () => undefined,
    );
    feeReserves(session.rpc, chain.keep).then((r) => !stale && setReserve(r));
    return () => {
      stale = true;
    };
  }, [session.rpc, chain, assets]);

  // What the wallet holds, most important first. Null while the balances load.
  const order = useMemo(() => {
    if (assets.length === 0 || balanceState.loading || walletBalances.length !== assets.length) return null;
    const values = assets.map((a, i) => usdValue(walletBalances[i] ?? 0n, a.decimals, prices[i] ?? null));
    return holdingOrder(assets, walletBalances, values);
  }, [assets, balanceState.loading, walletBalances, prices]);
  // The most that can go in. A wallet with no coin left could not withdraw or cancel, so the coin never goes in whole.
  const kept = keptCoin(reserve ?? { setup: 10n ** 16n, later: chain?.keep ?? 0n }, walletBalances[0] ?? 0n);
  const maxOf = (index: number): bigint => {
    const held = walletBalances[index] ?? 0n;
    return assets[index]?.token ? held : coinMax(held, kept);
  };

  const cooldown: bigint | null =
    preset === "custom"
      ? /^\d{1,4}$/.test(customValue)
        ? BigInt(customValue) * (customUnit === "days" ? 86_400n : 3_600n)
        : null
      : PRESETS[preset].seconds;
  const cooldownProblem =
    cooldown === null
      ? "Enter a whole number."
      : cooldown < MIN_COOLDOWN
        ? `The shortest delay is ${formatDuration(MIN_COOLDOWN)}.`
        : cooldown > MAX_COOLDOWN
          ? `The longest delay is ${formatDuration(MAX_COOLDOWN)}.`
          : null;
  const delayText = cooldown !== null && !cooldownProblem ? formatDuration(cooldown) : "";

  // A row with no amount, or with zero, is not chosen.
  const chosen: Chosen[] = (order ?? [])
    .map((index) => ({ index, asset: assets[index], text: (amounts[index] ?? "").trim(), amount: parseUnits(amounts[index] ?? "", assets[index].decimals) }))
    .filter((d) => d.text !== "" && d.amount !== 0n);
  const depositProblem = chosen.some((d) => d.amount === null || d.amount > maxOf(d.index));
  const amountOf = (d: Chosen, amount: bigint = d.amount ?? 0n): string => `${formatAmount(amount, d.asset.decimals)} ${d.asset.symbol}`;

  // A plain wallet: ask each chosen token how it can go in. The answer says how often the wallet will ask.
  const tokenKey = chosen
    .filter((d) => d.asset.token)
    .map((d) => d.asset.token!.toLowerCase())
    .sort()
    .join(",");
  useEffect(() => {
    if (!chain || batch || tokenKey === "") return;
    let stale = false;
    const tokens = tokenKey.split(",") as Address[];
    waysIn(session.rpc, chain.id, session.account, tokens).then((found) => !stale && setWays({ key: tokenKey, byToken: new Map(tokens.map((t, i) => [t, found[i]])) }));
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account, chain, batch, tokenKey]);
  const waysKnown = batch || tokenKey === "" || ways?.key === tokenKey;
  const wayOf = (d: Chosen): Way | undefined => (d.asset.token && !batch && ways?.key === tokenKey ? ways.byToken.get(d.asset.token.toLowerCase()) : undefined);
  /** Does this asset go in with a signed message? Not when the signature failed in this run. */
  const isSigned = (d: Chosen): boolean => {
    const kind = wayOf(d)?.kind;
    return (kind === "authorization" || kind === "permit") && !demoted.includes(d.index);
  };
  /** Does it move inside the setup itself: the coin, a signed token, or anything from a wallet that can batch? */
  const inSetup = (d: Chosen): boolean => batch || !d.asset.token || isSigned(d);
  const signs = chosen.filter((d) => !batch && isSigned(d)).length;
  const sends = chosen.filter((d) => !inSetup(d)).length;
  const confirms = batch ? 1 : (plan?.created ? 0 : 1) + 1 + sends;
  const toPick = (d: Chosen, inside: boolean): Pick => ({ token: d.asset.token, amount: d.amount ?? 0n, decimals: d.asset.decimals, dollar: d.asset.usd === "one", inSetup: inside });
  // All chosen amounts in dollars, when every one of them has a price.
  const total = chosen.length > 0 && !depositProblem ? chosen.reduce<bigint | null>((sum, d) => {
    const value = usdValue(d.amount ?? 0n, d.asset.decimals, prices[d.index] ?? null);
    return sum === null || value === null ? null : sum + value;
  }, 0n) : null;

  useEffect(() => {
    setPrice(null);
    // A test network has no real money: the setup does not ask for a contribution there. With no price, nothing is asked.
    if (!RECEIVER || !chain || chain.testnet) return;
    let stale = false;
    coinPriceUsd(session.rpc, chain.usdFeed).then((p) => !stale && setPrice(p));
    return () => {
      stale = true;
    };
  }, [session.rpc, chain]);

  // The contribution follows the money: what goes in, or what the wallet holds when nothing goes in yet. Money without a price does not count.
  const dollars = (amount: bigint, index: number): bigint => usdValue(amount, assets[index].decimals, prices[index] ?? null) ?? 0n;
  const moneyIn = depositProblem ? 0n : chosen.reduce((sum, d) => sum + dollars(d.amount ?? 0n, d.index), 0n);
  const moneyHeld = (order ?? []).reduce((sum, index) => sum + dollars(walletBalances[index] ?? 0n, index), 0n);
  // No receiver, a test network or no price: nothing is asked.
  const asks = !!RECEIVER && !!chain && price !== null;
  const suggested = asks ? suggestedGive(chosen.length > 0 ? moneyIn : moneyHeld, CONTRIBUTION_STEPS) : 0;
  const choices = giveChoices(suggested, CONTRIBUTION_STEPS);
  // The owner can change it. The suggestion moves under that choice when other amounts go in.
  const giveUsd = chosenGive(givePick, suggested, choices);
  const pickGive = (usd: number) => setGivePick({ usd, more: usd > suggested });
  const giveCents = giveUsd * 100;
  const giveText = `$${giveUsd}`;
  const contribution = RECEIVER && price !== null && giveCents > 0 ? { to: RECEIVER, amount: usdToCoin(BigInt(giveCents), price) } : null;
  const give = contribution ? { cents: BigInt(giveCents), coin: contribution.amount } : null;
  // Who pays the contribution. Null: nothing can pay it, and the setup goes on without one. While the balance is not known, the wallet pays.
  const coinHeld = walletBalances[0] ?? null;
  const toSplit = (g: typeof give): Split | null =>
    coinHeld === null || reserve === null
      ? { from: g ? "wallet" : "none", stays: chosen.map((d) => d.amount ?? 0n) }
      : splitContribution(chosen.map((d) => toPick(d, inSetup(d))), g, coinHeld, batch ? 0n : kept);
  const split = toSplit(give);
  // Could the suggestion be paid at all? If not, the card does not show.
  const payable = suggested > 0 && price !== null && toSplit({ cents: BigInt(suggested * 100), coin: usdToCoin(BigInt(suggested * 100), price) }) !== null;
  // Is a contribution really paid in this setup?
  const gives = !!contribution && split !== null && split.from !== "none";
  // What the card says. "Of it" is true only when the contribution is a part of the money that goes in.
  const giveTitle = (of: string): string => (!gives ? "No contribution. That is fine." : split?.from === "wallet" ? `${giveText} supports the makers.` : `${giveText} ${of} supports the makers.`);
  const giveDetail = !gives
    ? "Chronobox is free either way."
    : split?.from === "wallet"
      ? `Chronobox is free. This part is up to you. Your wallet sends it ${batch ? "in the same confirmation" : "when it switches on the time delay"}.`
      : undefined;
  // In which money it is paid, for the summary and the card.
  const givePaid = (): string => {
    if (!contribution || !split || !chain) return "";
    if (split.from === "token") {
      const d = chosen.find((c) => sameAddress(c.asset.token, split.token))!;
      return amountOf(d, split.fee);
    }
    return `about ${formatAmount(contribution.amount, 18, 5)} ${chain.native.symbol}`;
  };

  const steps: StepId[] = ["network", "delay", "promises", "fund", "review"];
  const current = steps[Math.min(step, steps.length - 1)];
  const canContinue =
    current === "network"
      ? !!chain
      : current === "delay"
        ? !cooldownProblem
        : current === "promises"
          ? keepSafe && gladToWait
          : current === "fund"
            ? !depositProblem
            : !!plan && !depositProblem && waysKnown;

  /**
   * Is the Chronobox at this address finished? A wallet's network can be a few blocks behind
   * right after a transaction, so "not there yet" is asked again before it counts.
   */
  const verify = async (safe: Address, tries: number): Promise<"locked" | "unverified" | "invalid" | null> => {
    let invalids = 0;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
      try {
        const result = await inspect(session.rpc, safe, chain ? blockHints(chain.id) : undefined);
        if ((result.state === "locked" || result.state === "unverified") && result.cooldown === cooldown) return result.state;
        // Right after mining, load-balanced RPCs can briefly serve mixed blocks across parallel reads.
        // Require two readings (or the final try) before calling a Chronobox invalid.
        if (result.state === "invalid" || result.state === "locked" || result.state === "unverified") {
          if (++invalids >= 2 || attempt === tries - 1) return "invalid";
        }
      } catch {
        // Ask again.
      }
    }
    return null;
  };

  const run = async () => {
    if (running.current || !plan || !chain || cooldown === null) return;
    running.current = true;
    stop.current = false;
    setError(null);
    setDemoted([]);
    makes.current = !plan.created;
    setProgress(batch ? "batch" : "start");
    const send = { chainId: chain.id, chainName: chain.name, shouldStop: () => stop.current, onHash: () => setSent(true) };
    let retry = false;
    const money = chosen.filter((d) => d.amount !== null && d.amount > 0n);
    const line = (d: Chosen, amount: bigint): Line => ({ symbol: d.asset.symbol, text: formatAmount(amount, d.asset.decimals) });
    // Snapshot the confirmed contribution from the review screen so a hidden contribution is never sent quietly.
    const confirmedGive = gives ? give : null;
    const confirmedContribution = gives ? contribution : null;
    // Set once a contribution is part of what the wallet sends.
    let gave: string | null = null;
    const finish = (safe: Address, state: "locked" | "unverified", inside: Line[] | null = null, stayed: Line[] = [], uncertain = false) => {
      rememberVault({ chainId: chain.id, safe, wallet: session.account });
      clearSetupAmounts();
      setDone({ chain, safe, unverified: state === "unverified", inside, stayed, gave: inside ? gave : null, uncertain });
    };
    let target = plan.safe;
    // True from the moment a request goes to the wallet. After that, the chain says what happened, not an error.
    let asked = false;
    // True when this press waited for a request sent by an earlier press.
    let resumed = false;
    try {
      let now = await findPlan();
      setPlan(now);
      makes.current = !now.created;
      target = now.safe;
      await assertWallet(session.rpc, session.account, chain.id, chain.name);
      for (const d of money) {
        const held = d.asset.token ? await tokenBalance(session.rpc, d.asset.token, session.account) : await nativeBalance(session.rpc, session.account);
        if (d.amount! > held) throw new Error(`Your wallet has only ${formatAmount(held, d.asset.decimals)} ${d.asset.symbol}.`);
      }
      let inside: Line[] = [];
      const stayed: Line[] = [];
      let later: Chosen[] = [];

      const last = pending.current;
      if (last && !(last.chainId === chain.id && sameAddress(last.wallet, session.account) && sameAddress(last.safe, now.safe) && !now.created)) pending.current = null;
      if (batch && pending.current) {
        // The wallet still has the first request. A second one could end up in the same transaction and make it fail.
        asked = true;
        await waitForBatch(session.wallet.provider, pending.current.id, () => setProgress("waiting"), () => stop.current);
        pending.current = null;
        // The amounts of that first request may differ from the ones chosen now.
        resumed = true;
      } else if (batch) {
        const held = await nativeBalance(session.rpc, session.account);
        // A contribution that nothing can pay is left out. It never stops the setup.
        const parts = splitContribution(money.map((d) => toPick(d, true)), confirmedGive, held, 0n) ?? splitContribution(money.map((d) => toPick(d, true)), null, held, 0n)!;
        const calls = setupCalls(
          session.account,
          now.index,
          now.created,
          cooldown,
          money.map((d, i) => ({ token: d.asset.token, amount: parts.stays[i] })),
          parts.from === "wallet" || parts.from === "coin" ? confirmedContribution : null,
          parts.from === "token" ? [tokenPayment(parts.token, confirmedContribution!.to, parts.fee, now.safe)] : [],
        );
        inside = money.map((d, i) => line(d, parts.stays[i]));
        if (parts.from !== "none") gave = giveText;
        asked = true;
        const id = await sendCalls(session.wallet.provider, session.account, chain.id, calls, () => stop.current);
        pending.current = { id, chainId: chain.id, wallet: session.account, safe: now.safe };
        const landed = await waitForBatch(session.wallet.provider, id, () => setProgress("waiting"), () => stop.current);
        pending.current = null;
        // The history of the cancel permission starts in this block. The first check reads from here, not from the start of the chain.
        if (landed.blockNumber !== null) blockHints(chain.id).set(predictRoles(now.safe), landed.blockNumber);
      } else {
        if (!now.created) {
          setProgress("create");
          asked = true;
          const receipt = await sendAndWait(session.rpc, session.account, createTx(session.account, now.index), send);
          const safe = safeFromReceipt(receipt);
          if (!safe || safe !== now.safe) throw new Error("Something is not right: your Chronobox is not where it should be. Stop here, and do not send money.");
          now = { ...now, created: true };
          setPlan(now);
        }
        // Then the signatures. They come after the Chronobox exists: a wallet warns its owner about an approval
        // for an address with nothing behind it, and before this moment the Chronobox is such an address.
        const pulls: Pull[] = [];
        const failed: number[] = [];
        for (const d of money) {
          const way = wayOf(d);
          if (!d.asset.token || !way || way.kind === "transfer") continue;
          setProgress(`sign:${d.index}`);
          const pull = await signPull(session.rpc, (data) => answerOrStop(signTyped(session.wallet.provider, session.account, data), () => stop.current), way, d.asset.token, session.account, now.safe, d.amount!);
          if (pull) pulls.push(pull);
          else {
            failed.push(d.index);
            setDemoted([...failed]);
          }
        }
        setProgress("lock");
        const safe = now.safe;
        const held = await nativeBalance(session.rpc, session.account);
        // The second setup transaction, with the money that can ride on it: the coin, and the tokens in `use`.
        const build = (use: Pull[]) => {
          const rides = (d: Chosen) => !d.asset.token || use.some((p) => sameAddress(p.token, d.asset.token));
          // Keep enough coin for the lock transaction, any plain transfers after it, and future withdraw/cancel fees.
          const picks = money.map((d) => toPick(d, rides(d)));
          const remainingReserve = reserve ? laterCoin(reserve, held) + reserve.setup / 2n : 0n;
          const parts = splitContribution(picks, confirmedGive, held, remainingReserve) ?? splitContribution(picks, null, held, 0n)!;
          const coinAt = money.findIndex((d) => !d.asset.token);
          const calls = use.flatMap((p) => p.calls);
          if (parts.from === "token") calls.push(tokenPayment(parts.token, confirmedContribution!.to, parts.fee, safe));
          const pays = parts.from === "wallet" || parts.from === "coin" ? confirmedContribution : null;
          return { parts, rides, tx: lockTx(session.account, safe, cooldown, EXPIRATION_SECONDS, pays, { coin: coinAt >= 0 ? parts.stays[coinAt] : 0n, calls }) };
        };
        const passes = async (tx: TxRequest): Promise<boolean> => {
          try {
            await session.rpc("eth_call", [{ from: session.account, to: tx.to, data: tx.data, ...(tx.value ? { value: toQuantity(tx.value) } : {}) }, "latest"]);
            return true;
          } catch (err) {
            // Only a contract revert demotes the signed pulls. A temporary RPC error is left to estimateGas.
            return isTemporary(err);
          }
        };
        let use = await freshPulls(session.rpc, session.account, safe, pulls);
        let built = build(use);
        if (use.length > 0 && !(await passes(built.tx))) {
          // A signed message that a token refuses must not stop the setup. Those tokens go in with a transfer of their own.
          use = [];
          setDemoted(money.filter((d) => d.asset.token && wayOf(d) && wayOf(d)!.kind !== "transfer").map((d) => d.index));
          built = build(use);
        }
        const { parts, rides } = built;
        if (parts.from !== "none") gave = giveText;
        asked = true;
        const switched = await sendAndWait(session.rpc, session.account, built.tx, send);
        // The history of the cancel permission starts in this block. The first check reads from here, not from the start of the chain.
        blockHints(chain.id).set(predictRoles(target), BigInt(switched.blockNumber));
        money.forEach((d, i) => rides(d) && inside.push(line(d, parts.stays[i])));
        later = money.filter((d) => !rides(d));
      }

      setProgress("check");
      const state = await verify(target, 5);
      if (state === "invalid") throw new Error("Your Chronobox did not pass the safety checks. Do not send money to it.");
      if (state !== "locked" && state !== "unverified") {
        throw new Error("Your wallet's network does not show the result yet. Wait a minute, then go to the start page: your Chronobox appears there when it is ready.");
      }
      // The tokens that take no signed message: one transfer each, and only into a Chronobox that passed every check.
      let open = state === "locked";
      for (const d of later) {
        if (!open) {
          stayed.push(line(d, d.amount!));
          continue;
        }
        setProgress(`send:${d.index}`);
        try {
          const receipt = await sendAndWait(session.rpc, session.account, depositTx(target, d.asset.token, d.amount!), send);
          const arrived = arrivedInReceipt(receipt, d.asset.token!, target);
          if (arrived > 0n) inside.push(line(d, arrived));
          else stayed.push(line(d, d.amount!));
        } catch {
          // The Chronobox is ready. What did not go in stays in the wallet, and the owner can add it later.
          stayed.push(line(d, d.amount!));
          open = false;
        }
      }
      if (resumed) return finish(target, state, null, [], money.length > 0);
      return finish(target, state, inside, stayed);
    } catch (e) {
      // The wallet never answered, and the owner stopped waiting. That question sent nothing.
      const noAnswer = e instanceof StoppedAsking;
      // Only "Stop waiting" leaves the request with the wallet. After any other end, the next press may send again.
      if (!stop.current) pending.current = null;
      if (asked && !isRejection(e)) {
        // Something may have reached the chain all the same. Look before saying that it failed.
        setProgress("check");
        const state = noAnswer ? null : await verify(target, 2);
        if (state === "locked" || state === "unverified") return finish(target, state, null, [], money.length > 0);
        try {
          const next = await findPlan();
          setPlan(next);
          // The first step did land. The page says so, and the next press goes on from there.
          if (next.created && !plan.created && !noAnswer) return setError(null);
        } catch {
          // The plan stays as it was. The next try reads it again.
        }
      }
      if (noAnswer && again.current) retry = true;
      else setError(errorText(e));
    } finally {
      again.current = false;
      running.current = false;
      setProgress(null);
      if (retry) setTimeout(() => runAgain.current(), 0);
    }
  };

  runAgain.current = run;

  // --- The result ----------------------------------------------------------
  if (done) {
    return (
      <section class={done.gave ? "wiz wiz-done wiz-gave" : "wiz wiz-done"} key="done">
        <div class="wiz-hero-mark">
          <Mark size={72} />
        </div>
        <Screen
          title="Your Chronobox is ready."
          lead={done.inside?.length ? `Your money is inside. From now on, every withdrawal waits ${delayText}.` : `From now on, every withdrawal waits ${delayText}.`}
        >
          {done.unverified ? (
            <Notice kind="risk" title="One safety check could not run here.">
              Nothing looks wrong. Your wallet's network did not give the old records that the check needs. Open your Chronobox and wait with
              deposits until the check passes.
            </Notice>
          ) : null}
          {done.inside?.length ? (
            <ul class="rows wiz-inside">
              {done.inside.map((l, i) => (
                <li class="row" key={`${l.symbol}-${i}`}>
                  <span class="token-badge" aria-hidden="true">
                    {l.symbol.slice(0, 1)}
                  </span>
                  <span class="row-label">{l.symbol}</span>
                  <span class="row-value">{l.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {done.gave ? <p class="wiz-thanks">Thank you for the {done.gave}. You made our day.</p> : null}
          {done.uncertain ? (
            <Notice kind="info">
              Open your Chronobox to see which amounts went in. Anything that did not go in stayed in your wallet, and you can add it from your Chronobox.
            </Notice>
          ) : null}
          {done.stayed.length > 0 ? (
            <Notice kind="info">
              {listOf(done.stayed.map((l) => `${l.text} ${l.symbol}`))} stayed in your wallet. You can add it from your Chronobox.
            </Notice>
          ) : null}
          {!done.unverified && !done.uncertain && !done.inside?.length && done.stayed.length === 0 ? (
            <>
              <p class="wiz-label">Put money in whenever you like</p>
              <DepositPanel session={session} chain={done.chain} safe={done.safe} assets={assets} quiet />
            </>
          ) : null}
        </Screen>
        <div class="wiz-foot">
          <Button kind="primary" onClick={() => props.onDone(done.chain, done.safe)}>
            Open my Chronobox
          </Button>
        </div>
      </section>
    );
  }

  // --- The work in progress ------------------------------------------------
  if (progress) {
    const rides = chosen.map((d, i) => ({ d, stay: split?.stays[i] ?? d.amount ?? 0n })).filter(({ d }) => inSetup(d));
    const lockText = stepsOf([
      "Switch on the time delay",
      ...(rides.length > 0 && !batch ? [`put ${listOf(rides.map(({ d, stay }) => amountOf(d, stay)))} in`] : []),
      ...(gives ? [`send your contribution of ${giveText}`] : []),
    ]);
    const rows: { id: string; text: string }[] = batch
      ? [
          {
            id: "batch",
            text:
              (chosen.length > 0 ? "Create your Chronobox, switch on the time delay and put money in" : "Create your Chronobox and switch on the time delay") +
              (gives ? `, and send your contribution of ${giveText}` : ""),
          },
          { id: "check", text: "Run the safety checks" },
        ]
      : [
          ...(makes.current ? [{ id: "create", text: "Create your Chronobox" }] : []),
          ...chosen.filter(isSigned).map((d) => ({ id: `sign:${d.index}`, text: `Allow ${amountOf(d)} to go in` })),
          { id: "lock", text: lockText },
          { id: "check", text: "Run the safety checks" },
          ...chosen.filter((d) => !inSetup(d)).map((d) => ({ id: `send:${d.index}`, text: `Put ${amountOf(d)} in` })),
        ];
    const at = rows.findIndex((r) => r.id === (progress === "waiting" ? "batch" : progress));
    return (
      <section class="wiz" key="work">
        <Screen
          title="Creating your Chronobox"
          lead={
            progress === "check"
              ? "Almost there."
              : progress === "waiting"
                ? "Your wallet has it. If it needs more signatures, collect them there. This page waits for you."
                : progress.startsWith("sign:")
                  ? "Your wallet is asking you to sign. A signature costs nothing."
                  : progress.startsWith("send:")
                    ? "Your Chronobox is ready. Your wallet is asking you to confirm the next amount."
                    : "Your wallet is asking you to confirm."
          }
        >
          <ol class="wiz-work">
            {rows.map((row, i) => {
              const finished = i < at;
              return (
                <li key={row.text} class={finished ? "wiz-work-done" : i === at ? "wiz-work-now" : ""}>
                  <span class="wiz-work-dot" aria-hidden="true">
                    {finished ? <Tick on /> : i === at ? <span class="spinner" /> : null}
                  </span>
                  {row.text}
                </li>
              );
            })}
          </ol>
          {slow && !answered ? (
            <div class="wiz-slow">
              <p class="wiz-note">Your wallet has not answered yet. Look in your wallet: the request may still wait for you there.</p>
              <div class="wiz-slow-actions">
                <Button
                  small
                  onClick={() => {
                    again.current = true;
                    stop.current = true;
                  }}
                >
                  Ask my wallet again
                </Button>
                <button
                  type="button"
                  class="link-button"
                  onClick={() => {
                    stop.current = true;
                  }}
                >
                  Go back
                </button>
              </div>
              <p class="wiz-note">Nothing was sent so far. If the old request shows up in your wallet later, reject it.</p>
            </div>
          ) : slow ? (
            <div class="wiz-slow">
              <p class="wiz-note">This takes longer than usual. Look in your wallet: the request may still wait for you there, or the network is busy.</p>
              <button
                type="button"
                class="link-button"
                onClick={() => {
                  stop.current = true;
                }}
              >
                Stop waiting
              </button>
              <p class="wiz-note">
                That does not undo anything. This page then looks at the chain and shows where your setup stands. If you try again, the page waits for the
                same request in your wallet. It does not send a second one.
              </p>
            </div>
          ) : null}
        </Screen>
      </section>
    );
  }

  // --- The questions -------------------------------------------------------
  let screen: ComponentChildren;
  if (current === "network") {
    screen = (
      <Screen title="Where should it live?" lead="Choose the network where your money is.">
        <div class="wiz-list" role="radiogroup" aria-label="Network">
          {CHAINS.filter((c) => (__DEV__ ? true : !c.testnet || c.id === session.chainId)).map((c) => (
            <Choice
              key={c.id}
              role="radio"
              on={c.id === (pickedChain ?? session.chainId)}
              title={c.name}
              text={c.testnet ? "Test network. No real money." : undefined}
              onClick={() => {
                // Show the choice at once. The wallet needs a moment, and sometimes a confirmation, to follow.
                setPickedChain(c.id);
                setSwitchError(null);
                session.switchChain(c).catch((e) => {
                  setPickedChain(null);
                  if (!isRejection(e)) setSwitchError(`Your wallet did not switch. Switch to ${c.name} in your wallet itself.`);
                });
              }}
            />
          ))}
        </div>
        {switchError ? <p class="field-error">{switchError}</p> : null}
        {!chain ? <p class="wiz-note">Your wallet is on another network. Choose one of these to go on.</p> : null}
      </Screen>
    );
  } else if (current === "delay") {
    screen = (
      <Screen title="How long should a withdrawal wait?" lead="Longer than a thief can wait in your home. Short enough that you can live with it.">
        <div class="wiz-list" role="radiogroup" aria-label="Delay">
          {PRESETS.map((p, i) => (
            <Choice key={p.label} role="radio" on={preset === i} title={p.label} onClick={() => setPreset(i)} />
          ))}
          <Choice role="radio" on={preset === "custom"} title="Another length" text="From 1 hour to 90 days" onClick={() => setPreset("custom")} />
        </div>
        {preset === "custom" ? (
          <div class="custom-delay">
            <input
              class="input"
              inputMode="numeric"
              aria-label="Delay length"
              value={customValue}
              onInput={(event) => setCustomValue((event.target as HTMLInputElement).value.trim())}
            />
            <select
              class="input select"
              aria-label="Unit"
              value={customUnit}
              onChange={(event) => setCustomUnit((event.target as HTMLSelectElement).value as "hours" | "days")}
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </div>
        ) : null}
        {cooldownProblem ? <p class="field-error">{cooldownProblem}</p> : null}
        <p class="wiz-note">
          {cooldown !== null && cooldown > 30n * 86_400n && !cooldownProblem
            ? `That is a long time. In an emergency you cannot reach this money for ${delayText}.`
            : `You can cancel a withdrawal while it waits. When the wait ends, you have ${formatDuration(EXPIRATION_SECONDS)} to collect the money.`}
        </p>
      </Screen>
    );
  } else if (current === "promises") {
    screen = (
      <Screen title="Two promises to yourself" lead="Chronobox is simple because it has no back door. Tap each one when you mean it.">
        <div class="wiz-list">
          <Choice
            role="checkbox"
            on={keepSafe}
            title="I will keep this wallet safe."
            text="It controls my Chronobox. If I lose it, the money in my Chronobox is gone."
            onClick={() => setKeepSafe(!keepSafe)}
          />
          <Choice
            role="checkbox"
            on={gladToWait}
            title={`I am glad to wait ${delayText}.`}
            text="Every withdrawal takes that long, for me too. That wait is what protects me."
            onClick={() => setGladToWait(!gladToWait)}
          />
        </div>
        <p class={keepSafe && gladToWait ? "wiz-cheer wiz-cheer-on" : "wiz-cheer"} aria-live="polite">
          {keepSafe && gladToWait ? "Good. That is all it takes." : ""}
        </p>
      </Screen>
    );
  } else if (current === "fund") {
    screen = (
      <Screen
        title="Put money in now?"
        lead={batch ? "Choose what goes in. Your wallet does it in the same confirmation as the setup." : "Choose what goes in. The rest stays in your wallet."}
      >
        <div class="wiz-fund">
          <FundList
            assets={assets}
            order={order}
            balances={walletBalances}
            prices={prices}
            maxOf={maxOf}
            limitOf={maxOf}
            amounts={amounts}
            onAmount={(index, text) => setAmounts((all) => ({ ...all, [index]: text }))}
            networkName={chain?.name ?? "this network"}
            failed={balancesFailed}
            onRetry={() => setBalancesRound((r) => r + 1)}
            calm={CALM}
          />
          {total !== null ? <p class="fund-total">About {formatUsd(total)} goes in.</p> : null}
          {asks && chosen.length > 0 && !depositProblem && moneyIn > 0n ? (
            suggested === 0 ? (
              <OnUs from={CONTRIBUTION_STEPS[CONTRIBUTION_STEPS.length - 1][0]} />
            ) : payable ? (
              <Support usd={gives ? giveUsd : 0} choices={choices} onPick={pickGive} title={giveTitle(total !== null ? "of it" : "of what goes in")} detail={giveDetail} />
            ) : null
          ) : null}
          {!batch && !depositProblem && signs + sends > 0 ? (
            <p class="fund-sorry">
              Your wallet is a bit old. It cannot do all of this in one go, so it will ask you {waysKnown ? `${COUNT[signs + confirms] ?? signs + confirms} times` : "several times"}. We are sorry.
            </p>
          ) : null}
        </div>
      </Screen>
    );
  } else {
    screen = (
      <Screen title="Ready?" lead={
          batch
            ? `Your wallet asks you to confirm once.${gives ? ` Your contribution of ${giveText} goes with it.` : ""} If any part fails, nothing happens.`
            : chosen.length > 0
              ? `Your wallet asks you ${signs > 0 ? `to sign ${times(signs)} and ` : ""}to confirm ${times(confirms)}. If the setup fails, no money moves.`
              : gives
                ? `Your wallet asks you to confirm twice: first to create your Chronobox, then to switch on the time delay and send your contribution of ${giveText}.`
                : "Your wallet asks you to confirm twice: once to create your Chronobox, once to switch on the time delay."
        }>
        <dl class="wiz-summary">
          <div>
            <dt>Network</dt>
            <dd>{chain?.name}</dd>
          </div>
          <div>
            <dt>Every withdrawal waits</dt>
            <dd>{delayText}</dd>
          </div>
          <div>
            <dt>Controlled by your wallet</dt>
            <dd class="mono">
              <AddressText address={session.account} full />
            </dd>
          </div>
          <div>
            <dt>Goes in now</dt>
            <dd>{chosen.length > 0 ? listOf(chosen.map((d, i) => amountOf(d, split?.stays[i]))) : "Nothing yet"}</dd>
          </div>
          {gives ? (
            <div>
              <dt>Your contribution</dt>
              <dd>{givePaid()}</dd>
            </div>
          ) : null}
        </dl>
        {asks && payable ? (
          <Support
            usd={gives ? giveUsd : 0}
            choices={choices}
            onPick={pickGive}
            title={giveTitle("of what goes in")}
            detail={giveDetail}
          />
        ) : null}
        {plan?.created ? <Notice kind="info">Your Chronobox is created already. Only the time delay is not on yet.</Notice> : null}
        {loadError ? (
          <Notice kind="bad" title="We could not read what your wallet has already.">
            {loadError}{" "}
            <button type="button" class="link-button" onClick={() => setReload(reload + 1)}>
              Try again
            </button>
          </Notice>
        ) : !plan ? (
          <p class="wiz-note">Looking at what your wallet has already…</p>
        ) : !waysKnown ? (
          <p class="wiz-note">Looking at how your tokens can go in…</p>
        ) : null}
        {error ? <Notice kind="bad">{error}</Notice> : null}
      </Screen>
    );
  }

  const last = step >= steps.length - 1;
  return (
    <section class="wiz">
      <div class="wiz-top">
        {step > 0 ? (
          <button type="button" class="wiz-back" onClick={() => setStep(step - 1)}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Back
          </button>
        ) : (
          <a class="wiz-back" href="#/">
            Close
          </a>
        )}
        <ol class="wiz-dots" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((id, i) => (
            <li key={id}>
              <button
                type="button"
                class={i === step ? "wiz-dot wiz-dot-now" : i < step ? "wiz-dot wiz-dot-done" : "wiz-dot"}
                disabled={i >= step}
                aria-label={`Go back to step ${i + 1}`}
                onClick={() => setStep(i)}
              />
            </li>
          ))}
        </ol>
      </div>

      <div key={current} class={back ? "wiz-from-left" : "wiz-from-right"}>
        {screen}
      </div>

      <div class="wiz-foot">
        <Button kind="primary" disabled={!canContinue} onClick={last ? run : () => setStep(step + 1)}>
          {last ? (plan?.created && !batch ? "Switch on the time delay" : "Create my Chronobox") : current === "fund" && chosen.length === 0 ? "Deposit later" : "Continue"}
        </Button>
        {current === "fund" && chosen.length > 0 ? (
          <button
            type="button"
            class="link-button wiz-later"
            onClick={() => {
              setAmounts({});
              setStep(step + 1);
            }}
          >
            Deposit later
          </button>
        ) : null}
        {last ? (
          <p class="wiz-note">
            By creating a Chronobox, you agree to the{" "}
            <a href="#/terms" target="_blank" rel="noopener">
              terms
            </a>
            .
          </p>
        ) : null}
      </div>
    </section>
  );
}
