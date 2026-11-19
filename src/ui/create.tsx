/**
 * Creating a Chronobox, one question per screen: network, delay, two promises,
 * (for a wallet that can batch: money to put in), review, then the result
 * with the address to send money to. Every answer stays when you go back.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type Chain, CHAINS, CONTRIBUTION_RECEIVER, CONTRIBUTION_USD } from "../lib/chains.ts";
import { formatAmount, formatDuration, parseUnits } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";
import { blockHints, customTokens, rememberVault } from "../lib/store.ts";
import {
  EXPIRATION_SECONDS,
  coinPriceUsd,
  usdToCoin,
  MAX_COOLDOWN,
  MIN_COOLDOWN,
  createTx,
  discover,
  inspect,
  lockTx,
  nativeBalance,
  predictSafe,
  safeFromReceipt,
  sendAndWait,
  setupCalls,
  tokenBalance,
} from "../lib/chronobox.ts";
import { canBatch, errorText, sendBatch, switchChain } from "../lib/wallet.ts";
import { type Asset, AssetAmount, Button, Choice, Notice, type Session, Tick, useBalances } from "./common.tsx";
import { DepositPanel } from "./deposit.tsx";
import { Mark } from "./logo.tsx";

const PRESETS: { label: string; hint: string; seconds: bigint }[] = [
  { label: "12 hours", hint: "Overnight", seconds: 12n * 3600n },
  { label: "1 day", hint: "A good start", seconds: 24n * 3600n },
  { label: "1 week", hint: "The strongest of the three", seconds: 7n * 24n * 3600n },
];

/**
 * Where the voluntary contribution goes. A build without a receiver does not
 * ask. The dev server uses a throwaway address so that the step can be seen.
 */
const RECEIVER: Address | null = CONTRIBUTION_RECEIVER ?? (__DEV__ ? "0x000000000000000000000000000000000000c0de" : null);

type Plan = { index: number; safe: Address; created: boolean };
type StepId = "network" | "delay" | "promises" | "fund" | "review";
type Progress = "create" | "lock" | "batch" | "waiting" | "check";

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
  const [deposits, setDeposits] = useState<{ asset: number; amount: string }[]>([{ asset: 0, amount: "" }]);
  // The contribution: a suggested amount in dollars, lower choices behind "Donate less", or any amount including 0.
  const [giveUsd, setGiveUsd] = useState<number>(CONTRIBUTION_USD.suggested);
  const [giveOwn, setGiveOwn] = useState("");
  const [giveLess, setGiveLess] = useState(false);
  const [price, setPrice] = useState<bigint | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ chain: Chain; safe: Address; funded: boolean } | null>(null);

  useEffect(() => {
    let stale = false;
    setBatch(false);
    if (chain) canBatch(session.wallet.provider, session.account, chain.id).then((yes) => !stale && setBatch(yes));
    return () => {
      stale = true;
    };
  }, [session.wallet, session.account, chain]);

  useEffect(() => {
    if (!chain) return;
    let stale = false;
    setPlan(null);
    setLoadError(null);
    (async () => {
      try {
        const found = await discover(session.rpc, session.account);
        // A vault whose setup stopped after the first transaction comes first.
        for (const vault of found) {
          if ((await inspect(session.rpc, vault.safe)).state === "open") {
            if (!stale) setPlan({ index: vault.index, safe: vault.safe, created: true });
            return;
          }
        }
        if (!stale) setPlan({ index: found.length, safe: predictSafe(session.account, found.length), created: false });
      } catch (e) {
        if (!stale) setLoadError(errorText(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account, chain]);

  const assets: Asset[] = chain
    ? [
        { token: null, symbol: chain.native.symbol, decimals: 18 },
        ...[...chain.tokens, ...customTokens(chain.id)].map((t) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals })),
      ]
    : [];
  const walletBalances = useBalances(session.rpc, batch ? session.account : null, assets);

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

  // A line with no amount is ignored.
  const parsedDeposits = deposits
    .filter((d) => d.amount.trim() !== "" && assets[d.asset])
    .map((d) => ({ asset: assets[d.asset], text: d.amount.trim(), amount: parseUnits(d.amount, assets[d.asset].decimals) }));
  const depositProblem = parsedDeposits.some((d) => d.amount === null || d.amount === 0n) ? "An amount is not a number above zero." : null;

  useEffect(() => {
    setPrice(null);
    if (!RECEIVER || !chain) return;
    let stale = false;
    coinPriceUsd(session.rpc, chain.usdFeed).then((p) => !stale && setPrice(p));
    return () => {
      stale = true;
    };
  }, [session.rpc, chain]);

  const ownText = giveOwn.trim().replace(",", ".");
  const ownCents = /^[0-9]{1,5}([.][0-9]{1,2})?$/.test(ownText) ? Math.round(Number(ownText) * 100) : null;
  const giveProblem = ownText !== "" && ownCents === null ? "Enter an amount in dollars, for example 5. Enter 0 to give nothing." : null;
  const giveCents = ownText !== "" ? (ownCents ?? 0) : giveUsd * 100;
  const contribution =
    RECEIVER && chain && price !== null && giveCents > 0 && !giveProblem ? { to: RECEIVER, amount: usdToCoin(BigInt(giveCents), price) } : null;
  const giveText = `$${giveCents % 100 === 0 ? giveCents / 100 : (giveCents / 100).toFixed(2)}`;

  const steps: StepId[] = ["network", "delay", "promises", ...(batch ? (["fund"] as StepId[]) : []), "review"];
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
            : !!plan && !giveProblem;

  const run = async () => {
    if (!plan || !chain || cooldown === null) return;
    setError(null);
    try {
      if (contribution && !batch) {
        const held = await nativeBalance(session.rpc, session.account);
        if (held <= contribution.amount) {
          throw new Error(`Your wallet does not have enough ${chain.native.symbol} for the contribution and the network fee. Choose a lower contribution, or 0.`);
        }
      }
      if (batch) {
        const totals = new Map<Asset, bigint>();
        for (const d of parsedDeposits) totals.set(d.asset, (totals.get(d.asset) ?? 0n) + d.amount!);
        if (contribution) totals.set(assets[0], (totals.get(assets[0]) ?? 0n) + contribution.amount);
        for (const [asset, total] of totals) {
          const held = asset.token ? await tokenBalance(session.rpc, asset.token, session.account) : await nativeBalance(session.rpc, session.account);
          if (total > held) throw new Error(`Your wallet has only ${formatAmount(held, asset.decimals)} ${asset.symbol}.`);
        }
        setProgress("batch");
        const calls = setupCalls(
          session.account,
          plan.index,
          plan.created,
          cooldown,
          parsedDeposits.map((d) => ({ token: d.asset.token, amount: d.amount! })),
          contribution,
        );
        await sendBatch(session.wallet.provider, session.account, chain.id, calls, () => setProgress("waiting"));
      } else {
        let now = plan;
        if (!now.created) {
          setProgress("create");
          const receipt = await sendAndWait(session.rpc, session.account, createTx(session.account, now.index));
          const safe = safeFromReceipt(receipt);
          if (!safe || safe !== now.safe) throw new Error("Something is not right: your Chronobox is not where it should be. Stop here, and do not send money.");
          now = { ...now, created: true };
          setPlan(now);
        }
        setProgress("lock");
        await sendAndWait(session.rpc, session.account, lockTx(session.account, now.safe, cooldown, EXPIRATION_SECONDS, contribution));
      }
      setProgress("check");
      const result = await inspect(session.rpc, plan.safe, blockHints(chain.id));
      if (result.state !== "locked" || result.cooldown !== cooldown) {
        throw new Error("Your Chronobox did not pass the safety checks. Do not send money to it.");
      }
      rememberVault({ chainId: chain.id, safe: plan.safe });
      setDone({ chain, safe: plan.safe, funded: batch && parsedDeposits.length > 0 });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  // --- The result ----------------------------------------------------------
  if (done) {
    return (
      <section class="wiz wiz-done" key="done">
        <div class="wiz-hero-mark">
          <Mark size={72} />
        </div>
        <Screen
          title="Your Chronobox is ready."
          lead={done.funded ? `Your money is inside. From now on, every withdrawal waits ${delayText}.` : `From now on, every withdrawal waits ${delayText}.`}
        >
          {done.funded ? null : (
            <>
              <p class="wiz-label">Put money in whenever you like</p>
              <DepositPanel session={session} chain={done.chain} safe={done.safe} assets={assets} quiet />
            </>
          )}
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
    const rows: { id: Progress[]; text: string }[] = batch
      ? [
          {
            id: ["batch", "waiting"],
            text: (parsedDeposits.length > 0 ? "Create your Chronobox, switch on the time delay and put money in" : "Create your Chronobox and switch on the time delay") +
              (contribution ? `, and send your contribution of ${giveText}` : ""),
          },
          { id: ["check"], text: "Run the safety checks" },
        ]
      : [
          { id: ["create"], text: "Create your Chronobox" },
          { id: ["lock"], text: contribution ? `Switch on the time delay and send your contribution of ${giveText}` : "Switch on the time delay" },
          { id: ["check"], text: "Run the safety checks" },
        ];
    const at = rows.findIndex((r) => r.id.includes(progress));
    return (
      <section class="wiz" key="work">
        <Screen
          title="Creating your Chronobox"
          lead={
            progress === "check"
              ? "Almost there."
              : progress === "waiting"
                ? "Your wallet has it. If it needs more signatures, collect them there. This page waits for you."
                : "Your wallet is asking you to confirm."
          }
        >
          <ol class="wiz-work">
            {rows.map((row, i) => {
              const finished = i < at || (!!plan?.created && row.id[0] === "create");
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
          {CHAINS.filter((c) => !c.testnet || __DEV__ || c.id === session.chainId).map((c) => (
            <Choice
              key={c.id}
              role="radio"
              on={c.id === (pickedChain ?? session.chainId)}
              title={c.name}
              text={c.testnet ? "Test network. No real money." : undefined}
              onClick={() => {
                // Show the choice at once. The wallet needs a moment, and sometimes a confirmation, to follow.
                setPickedChain(c.id);
                switchChain(session.wallet.provider, c).catch(() => setPickedChain(null));
              }}
            />
          ))}
        </div>
        {!chain ? <p class="wiz-note">Your wallet is on another network. Choose one of these to go on.</p> : null}
      </Screen>
    );
  } else if (current === "delay") {
    screen = (
      <Screen title="How long should a withdrawal wait?" lead="Longer than a thief can wait in your home. Short enough that you can live with it.">
        <div class="wiz-list" role="radiogroup" aria-label="Delay">
          {PRESETS.map((p, i) => (
            <Choice key={p.label} role="radio" on={preset === i} title={p.label} text={p.hint} onClick={() => setPreset(i)} />
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
            text="It is the only key. If I lose it, the money in my Chronobox is gone."
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
        lead="Your wallet can create your Chronobox, switch on the time delay and put money in, all in one go. Or skip this and add money later."
      >
        <div class="wiz-fund">
          {deposits.map((d, i) => (
            <div class="deposit-row" key={i}>
              <AssetAmount
                assets={assets}
                asset={d.asset}
                amount={d.amount}
                balances={walletBalances}
                onAsset={(asset) => setDeposits((all) => all.map((x, k) => (k === i ? { ...x, asset } : x)))}
                onAmount={(amount) => setDeposits((all) => all.map((x, k) => (k === i ? { ...x, amount } : x)))}
              />
              {deposits.length > 1 ? (
                <button type="button" class="icon-button" aria-label="Remove this asset" onClick={() => setDeposits((all) => all.filter((_, k) => k !== i))}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                    <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                  </svg>
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" class="link-button" onClick={() => setDeposits((all) => [...all, { asset: 0, amount: "" }])}>
            Add another asset
          </button>
          {depositProblem ? <p class="field-error">{depositProblem}</p> : null}
        </div>
      </Screen>
    );
  } else {
    screen = (
      <Screen title="Ready?" lead={
          batch
            ? `Your wallet asks you to confirm once.${contribution ? ` Your contribution of ${giveText} goes with it.` : ""} If any part fails, nothing happens.`
            : contribution
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
            <dt>Your wallet, the only key</dt>
            <dd class="mono">{session.account}</dd>
          </div>
          {batch ? (
            <div>
              <dt>Goes in now</dt>
              <dd>{parsedDeposits.length > 0 ? parsedDeposits.map((d) => `${d.text} ${d.asset.symbol}`).join(", ") : "Nothing yet"}</dd>
            </div>
          ) : null}
        </dl>
        {RECEIVER && chain && price !== null ? (
          <div class="wiz-give">
            <strong>{giveCents > 0 ? `Contribute ${giveText}` : "No contribution"}</strong>
            {contribution ? (
              <span class="wiz-give-coin">
                about {formatAmount(contribution.amount, 18, 5)} {chain.native.symbol}. Your wallet shows this amount {batch ? "in the same confirmation" : "when you switch on the time delay"}.
              </span>
            ) : null}
            <p>
              Chronobox is free software. You can always run it yourself at no cost. Your contribution pays for the work that keeps this
              app safe and maintained.
            </p>
            {giveLess ? (
              <div class="wiz-give-less">
                <div class="pills" role="radiogroup" aria-label="Contribution">
                  {[CONTRIBUTION_USD.suggested, ...CONTRIBUTION_USD.less].map((usd) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={ownText === "" && giveUsd === usd}
                      class={ownText === "" && giveUsd === usd ? "pill pill-on" : "pill"}
                      key={usd}
                      onClick={() => {
                        setGiveUsd(usd);
                        setGiveOwn("");
                      }}
                    >
                      ${usd}
                    </button>
                  ))}
                  <label class="wiz-give-own">
                    <span aria-hidden="true">$</span>
                    <input
                      class="input"
                      inputMode="decimal"
                      aria-label="Another amount in dollars"
                      placeholder={String(CONTRIBUTION_USD.hint)}
                      value={giveOwn}
                      onInput={(event) => setGiveOwn((event.target as HTMLInputElement).value)}
                    />
                  </label>
                </div>
                {giveProblem ? <p class="field-error">{giveProblem}</p> : null}
              </div>
            ) : (
              <button type="button" class="link-button" onClick={() => setGiveLess(true)}>
                Donate less
              </button>
            )}
          </div>
        ) : null}
        {plan?.created ? <Notice kind="info">Your Chronobox is created already. Only the time delay is not on yet.</Notice> : null}
        {loadError ? <Notice kind="bad">{loadError}</Notice> : null}
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
          {last ? (plan?.created && !batch ? "Switch on the time delay" : "Create my Chronobox") : current === "fund" && parsedDeposits.length === 0 ? "Skip for now" : "Continue"}
        </Button>
      </div>
    </section>
  );
}
