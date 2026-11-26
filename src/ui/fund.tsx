/**
 * "Add money now?": what the wallet holds, most important first. Each
 * row has an amount to type and a slider with stops at a quarter, a half,
 * three quarters and everything. The slider gives round amounts. The field
 * takes any amount.
 */
import { useRef, useState } from "preact/hooks";
import { SLIDER_FULL, SLIDER_STOPS, amountAt, formatUsd, partOf, snapPart, usdValue } from "../lib/deposit.ts";
import { formatAmount, formatUnits, parseUnits } from "../lib/format.ts";
import { type Asset, TokenBadge } from "./common.tsx";

/** How many rows show at first, and how many more each "See more" adds. */
const FIRST_ROWS = 5;
const MORE_ROWS = 10;

const STOP_LABELS = ["25%", "50%", "75%", "Max"];

type RowProps = {
  asset: Asset;
  held: bigint;
  /** The end of the slider. For the coin this is less than what the wallet holds: the wallet keeps coin for fees and for the contribution. */
  max: bigint;
  /** The most that the field takes. For the coin: all but what the wallet must keep for fees. For a token: all of it. */
  limit: bigint;
  price: bigint | null;
  text: string;
  active: boolean;
  disabled?: boolean;
  onText: (text: string) => void;
  onTouch: () => void;
};

function FundRow(props: RowProps) {
  const { asset, held, max, text } = props;
  // The place of the slider while it is the slider that sets the amount. A typed amount has no such place.
  const slid = useRef<number | null>(null);
  const typed = text.trim() === "" ? 0n : parseUnits(text, asset.decimals);
  const part = slid.current !== null && typed !== null && amountAt(slid.current, max) === typed ? slid.current : partOf(typed ?? 0n, max);
  const value = usdValue(held, asset.decimals, props.price);

  const slideTo = (raw: number) => {
    const next = snapPart(raw);
    if (next !== slid.current && (SLIDER_STOPS as readonly number[]).includes(next)) {
      // A small tick in the hand where the phone can give one. A browser allows it only after a touch.
      const device = navigator as { vibrate?: (ms: number) => void; userActivation?: { isActive: boolean } };
      if (device.userActivation?.isActive) device.vibrate?.(8);
    }
    slid.current = next;
    const amount = amountAt(next, max);
    props.onText(amount === 0n ? "" : formatUnits(amount, asset.decimals));
  };

  const problem =
    text.trim() !== "" && typed === null
      ? "Enter the amount as a plain number, for example 1000 or 1.5."
      : typed !== null && typed > props.limit
        ? asset.token
          ? `Your wallet has only ${formatAmount(held, asset.decimals)} ${asset.symbol}.`
          : props.limit > 0n
            ? `At most ${formatAmount(props.limit, asset.decimals)} ${asset.symbol} can go in. Your wallet keeps the rest: it pays the network fees, now and when you withdraw or cancel.`
            : `Your wallet needs its ${asset.symbol} for the network fees.`
        : null;
  const none = max <= 0n;

  return (
    <li class={`fund-row${typed ? " is-on" : ""}${props.active ? " is-active" : ""}`} onPointerDown={props.onTouch} onFocusCapture={props.onTouch}>
      <div class="fund-head">
        <TokenBadge asset={asset} />
        <span class="fund-name">
          <strong>
            {asset.symbol}
            {value !== null && asset.usd !== "one" ? <span class="fund-usd">{formatUsd(value)}</span> : null}
          </strong>
          <span>{formatAmount(held, asset.decimals)} in this wallet</span>
        </span>
        <input
          class="input fund-amount"
          inputMode="decimal"
          autocomplete="off"
          placeholder="0"
          aria-label={`Amount of ${asset.symbol}`}
          value={text}
          disabled={props.disabled || none}
          onInput={(event) => {
            slid.current = null;
            props.onText((event.target as HTMLInputElement).value);
          }}
        />
      </div>
      <div class="fund-slide" style={{ "--part": String(part / SLIDER_FULL) }}>
        <input
          class="fund-range"
          type="range"
          min="0"
          max={SLIDER_FULL}
          step="1"
          aria-label={`Part of your ${asset.symbol}`}
          aria-valuetext={typed ? `${formatAmount(typed, asset.decimals)} ${asset.symbol}` : "Nothing"}
          value={part}
          disabled={props.disabled || none}
          onInput={(event) => slideTo(Number((event.target as HTMLInputElement).value))}
        />
        <span class="fund-ticks" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <div class="fund-stops" role="group" aria-label={`Quick amounts of ${asset.symbol}`}>
        {SLIDER_STOPS.map((stop, i) => {
          // A second press on the amount that is set takes it away again. An amount that was typed is never that amount by chance.
          const set = !!typed && typed === amountAt(stop, max);
          return (
            <button type="button" key={stop} class={set ? "fund-stop fund-stop-on" : "fund-stop"} disabled={props.disabled || none} onClick={() => slideTo(set ? 0 : stop)}>
              {STOP_LABELS[i]}
            </button>
          );
        })}
      </div>
      {problem ? <p class="field-error">{problem}</p> : null}
      {none && !asset.token && held > 0n ? <p class="hint">Your wallet needs its {asset.symbol} for the network fees.</p> : null}
      {!problem && !asset.token && typed !== null && typed >= max && max > 0n ? (
        <p class="hint">
          Some {asset.symbol} stays in your wallet. It pays the network fees, now and when you withdraw or cancel.
        </p>
      ) : null}
    </li>
  );
}

export function FundList(props: {
  assets: Asset[];
  /** Positions in `assets` of what the wallet holds, most important first. Null while the balances load. */
  order: number[] | null;
  balances: (bigint | null)[];
  prices: (bigint | null)[];
  maxOf: (index: number) => bigint;
  limitOf: (index: number) => bigint;
  amounts: Record<number, string>;
  onAmount: (index: number, text: string) => void;
  networkName: string;
  /** True when the wallet's network did not answer and no balances could be read. */
  failed?: boolean;
  onRetry?: () => void;
  /** Show the slider only on the row in use. The other rows stay one line high. */
  calm?: boolean;
  disabled?: boolean;
}) {
  const { order } = props;
  const [shown, setShown] = useState(FIRST_ROWS);
  const [active, setActive] = useState<number | null>(null);
  if (order === null) return <p class="wiz-note">Looking at what your wallet holds…</p>;
  if (props.failed && order.length === 0) {
    return (
      <p class="read-failed" role="status">
        Your wallet's network did not answer, so your balances could not be read.{" "}
        {props.onRetry ? (
          <button type="button" class="link-button" onClick={props.onRetry}>
            Try again
          </button>
        ) : null}
      </p>
    );
  }
  if (order.length === 0) return <p class="wiz-note">This wallet holds nothing on {props.networkName} that Chronobox knows. You can add money to your Chronobox at any time.</p>;
  const rest = order.length - shown;
  const current = active ?? order[0];
  return (
    <>
      <ul class={props.calm ? "fund fund-calm" : "fund"}>
        {order.slice(0, shown).map((index) => (
          <FundRow
            key={index}
            asset={props.assets[index]}
            held={props.balances[index] ?? 0n}
            max={props.maxOf(index)}
            limit={props.limitOf(index)}
            price={props.prices[index] ?? null}
            text={props.amounts[index] ?? ""}
            active={index === current}
            disabled={props.disabled}
            onText={(text) => props.onAmount(index, text)}
            onTouch={() => setActive(index)}
          />
        ))}
      </ul>
      {rest > 0 ? (
        <button type="button" class="link-button" onClick={() => setShown(shown + MORE_ROWS)}>
          See {Math.min(MORE_ROWS, rest)} more
        </button>
      ) : null}
    </>
  );
}
