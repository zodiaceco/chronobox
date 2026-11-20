import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState, useRef } from "preact/hooks";
import type { Chain, Token } from "../lib/chains.ts";
import { formatAmount, shortAddress } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";
import { type Rpc, readBalances } from "../lib/chronobox.ts";
import { customTokens } from "../lib/store.ts";
import { tokenIcon } from "../lib/token-icons.ts";
import { moreTokens } from "../lib/token-list.ts";
import { type WalletOption, errorText } from "../lib/wallet.ts";

export type Session = {
  wallet: WalletOption;
  account: Address;
  chainId: number;
  rpc: Rpc;
};

/** `main` marks the network's coin, its main tokens and tokens added by hand. The others come from the long list. */
export type Asset = { token: Address | null; symbol: string; decimals: number; main?: boolean; /** Found by the token index (third-party services). The app's own lists do not know it. */ found?: boolean; /** The icon file of a token of the app's own lists. */ icon?: string | null };

/**
 * Every asset the app knows on a network: the coin, the main tokens, tokens
 * added by hand, then the long list. An address is in it once, or it would
 * look like twice the money.
 */
export function assetsOf(chain: Chain): Asset[] {
  const seen = new Set<string>();
  const assets: Asset[] = [{ token: null, symbol: chain.native.symbol, decimals: 18, main: true, icon: tokenIcon(chain.id, null) }];
  const add = (tokens: Token[], main: boolean) => {
    for (const t of tokens) {
      const key = t.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      assets.push({ token: t.address, symbol: t.symbol, decimals: t.decimals, main, icon: tokenIcon(chain.id, t.address) });
    }
  };
  add(chain.tokens, true);
  add(customTokens(chain.id), true);
  add(moreTokens(chain.id), false);
  return assets;
}

/**
 * The mark of an asset: its icon where the app has one, else the first letter of its symbol.
 * The icon is a file of this page. Nothing is loaded from another site.
 */
export function TokenBadge(props: { asset: Asset }) {
  const { asset } = props;
  if (asset.icon) return <img class="token-badge token-icon" src={asset.icon} alt="" width="28" height="28" loading="lazy" decoding="async" />;
  return (
    <span class="token-badge" aria-hidden="true">
      {asset.symbol.slice(0, 1)}
    </span>
  );
}

/** Moving stripes: something is in progress. Drawn with SVG, because the page allows no inline style. */
export function Stripes(props: { x: number; width: number; height: number }) {
  if (props.width <= 0) return null;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <>
      <defs>
        <pattern id="cb-stripes" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="skewX(-30)">
          <rect width="8" height="16" fill="currentColor" />
          {still ? null : <animateTransform attributeName="patternTransform" type="translate" from="0 0" to="16 0" dur="0.9s" repeatCount="indefinite" additive="sum" />}
        </pattern>
      </defs>
      <rect class="mover-pending-back" x={props.x} y="0" width={props.width} height={props.height} />
      <rect class="mover-pending" x={props.x} y="0" width={props.width} height={props.height} fill="url(#cb-stripes)" />
    </>
  );
}

/**
 * How much of a wait has passed, as a bar. The part that has passed is striped and moving, like
 * the unlocking part of the bar in the list: the same thing, shown in two places.
 */
export function WaitBar(props: { value: number; label?: string }) {
  const done = Math.round(Math.max(0, Math.min(1, props.value)) * 1000);
  return (
    <svg class="wait-bar" viewBox="0 0 1000 8" preserveAspectRatio="none" role="img" aria-label={props.label ?? `${Math.round(done / 10)} percent of the wait has passed`}>
      <rect class="wait-bar-track" x="0" y="0" width="1000" height="8" />
      <Stripes x={0} width={done} height={8} />
    </svg>
  );
}

export function Button(props: {
  children: ComponentChildren;
  onClick?: () => void;
  kind?: "primary" | "plain" | "quiet" | "danger";
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  small?: boolean;
}) {
  const kind = props.kind ?? "plain";
  return (
    <button
      type={props.type ?? "button"}
      class={`button button-${kind}${props.small ? " button-small" : ""}`}
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
    >
      {props.busy ? <span class="spinner" aria-hidden="true" /> : null}
      {props.children}
    </button>
  );
}

/**
 * A sheet. While `busy` is set it cannot be closed: a transaction is on its way, and closing
 * would hide what becomes of it. A wait that gets long has its own way out ("Stop waiting").
 */
export function Modal(props: { title: string; lead?: string; wide?: boolean; busy?: boolean; onClose: () => void; children: ComponentChildren }) {
  const close = () => {
    if (!props.busy) props.onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, [props.onClose, props.busy]);
  return (
    <div class="modal-backdrop" onClick={(event) => event.target === event.currentTarget && close()}>
      <div class={props.wide ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="modal-head">
          <h2>{props.title}</h2>
          <button type="button" class="icon-button" aria-label="Close" disabled={props.busy} onClick={close}>
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {props.lead ? <p class="modal-lead">{props.lead}</p> : null}
        {props.children}
      </div>
    </div>
  );
}

export function Tick(props: { on: boolean }) {
  return (
    <span class={props.on ? "wiz-tick wiz-tick-on" : "wiz-tick"} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
  );
}

/** A large row that is one choice or one promise. Tapping it ticks it. */
export function Choice(props: { on: boolean; onClick: () => void; title: string; text?: string; role: "radio" | "checkbox"; disabled?: boolean }) {
  return (
    <button
      type="button"
      role={props.role}
      aria-checked={props.on}
      class={props.on ? "wiz-choice wiz-choice-on" : "wiz-choice"}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class="wiz-choice-text">
        <strong>{props.title}</strong>
        {props.text ? <span>{props.text}</span> : null}
      </span>
      <Tick on={props.on} />
    </button>
  );
}

export function Notice(props: { kind: "risk" | "bad" | "info" | "good"; title?: string; children?: ComponentChildren }) {
  return (
    <div class={`notice notice-${props.kind}`} role={props.kind === "bad" ? "alert" : undefined}>
      {props.title ? <strong>{props.title}</strong> : null}
      {props.children ? <div>{props.children}</div> : null}
    </div>
  );
}

/** The app is new. This says so, and where feedback goes. It sits at the top right of the landing page. */
export function Experimental() {
  return (
    <p class="experimental">
      <span class="experimental-tag">Experimental</span>
      <span>
        Test funds only. Feedback to <a href="mailto:johannes@zodiac.eco">johannes@zodiac.eco</a> ❤️
      </span>
    </p>
  );
}

/** Copies text. True when it worked. Some browsers and frames do not allow the modern way, so the old one is tried too. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // The old way: select the text in a field that is not seen, and copy the selection.
  }
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.className = "copy-field";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

/** An address on the page. A click copies the whole address, also where only a short form is shown. */
export function AddressText(props: { address: Address; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = props.full ? props.address : shortAddress(props.address);
  const copy = async (event: Event) => {
    // The address can sit inside a row or a menu that has its own click.
    event.stopPropagation();
    // When the browser does not allow it, the address is still on screen and can be selected by hand.
    if (!(await copyText(props.address))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button type="button" class={copied ? "address address-copied" : "address"} title={`Copy ${props.address}`} aria-label={`Copy the address ${props.address}`} onClick={copy}>
      {copied ? "Copied" : text}
    </button>
  );
}

/** Runs one wallet action at a time and keeps its error. */
/** What a running action gives to `sendAndWait`: a call when the wait gets long, and the wish to stop waiting. */
export type Waiting = { onSlow: () => void; shouldStop: () => boolean };

/**
 * One thing the page does with the wallet. Only one runs at a time, so a second press does
 * nothing. An error is shown in plain words. When the wait for the chain gets long, `slow`
 * turns true and `stop` ends the wait (it does not undo what was sent).
 */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const running = useRef(false);
  const stopped = useRef(false);
  const run = useCallback(async (name: string, action: (waiting: Waiting) => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    stopped.current = false;
    setSlow(false);
    setBusy(name);
    setError(null);
    try {
      await action({ onSlow: () => setSlow(true), shouldStop: () => stopped.current });
    } catch (e) {
      setError(errorText(e));
    } finally {
      running.current = false;
      setBusy(null);
      setSlow(false);
    }
  }, []);
  const stop = useCallback(() => {
    stopped.current = true;
  }, []);
  // A page that is gone must not keep asking the wallet's network about its transaction.
  useEffect(() => stop, [stop]);
  return { busy, error, slow, run, stop, clearError: () => setError(null) };
}

/** Shown when a confirmation takes long: what to do, and a way to stop waiting. */
export function SlowNote(props: { action: { slow: boolean; stop: () => void } }) {
  if (!props.action.slow) return null;
  return (
    <p class="slow-note" role="status">
      This takes longer than usual. Look in your wallet: the request may still wait for you there, or the network is busy.{" "}
      <button type="button" class="link-button" onClick={props.action.stop}>
        Stop waiting
      </button>
    </p>
  );
}

/** Balances of one address for a list of assets. Null while loading or when a read failed. */
export function useBalances(rpc: Rpc, holder: Address | null, assets: Asset[], round = 0): (bigint | null)[] {
  const [balances, setBalances] = useState<(bigint | null)[]>([]);
  const key = assets.map((a) => a.token ?? "native").join(",");
  useEffect(() => {
    if (!holder) return setBalances([]);
    let stale = false;
    readBalances(rpc, holder, assets).then((read) => !stale && setBalances(read.balances));
    return () => {
      stale = true;
    };
  }, [rpc, holder, key, round]);
  return balances;
}

/** A token picker: symbol and the balance of each asset. No images, so nothing is loaded from another site. */
export function TokenSelect(props: {
  assets: Asset[];
  value: number;
  balances?: (bigint | null)[];
  onChange: (index: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !(event.target as Element).closest?.(".token-select")) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  // The list can get shorter under a remembered choice (another network). Then the first asset stands in.
  const current = props.assets[props.value] ?? props.assets[0];
  // The list of known tokens is long. The picker shows the main ones, and every other one that the address holds.
  const shown = (asset: Asset, index: number) => asset.main || index === props.value || (props.balances?.[index] ?? 0n) > 0n;
  return (
    <div class="token-select">
      <button type="button" class="token-button" aria-haspopup="listbox" aria-expanded={open} disabled={props.disabled} onClick={() => setOpen(!open)}>
        <TokenBadge asset={current} />
        {current.symbol}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul class="token-list" role="listbox" aria-label="Asset">
          {props.assets.map((asset, index) => {
            if (!shown(asset, index)) return null;
            const balance = props.balances?.[index];
            return (
              <li key={asset.token ?? "native"} role="option" aria-selected={index === props.value}>
                <button
                  type="button"
                  class={index === props.value ? "token-option token-option-on" : "token-option"}
                  onClick={() => {
                    props.onChange(index);
                    setOpen(false);
                  }}
                >
                  <TokenBadge asset={asset} />
                  <span class="token-name">
                    {asset.symbol}
                    <small>{asset.token ? shortAddress(asset.token) : "Native coin"}</small>
                  </span>
                  <span class="token-balance">{balance === null || balance === undefined ? "" : formatAmount(balance, asset.decimals, 4)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function AssetAmount(props: {
  assets: Asset[];
  asset: number;
  amount: string;
  /** Balances of the address that pays, shown in the token picker. */
  balances?: (bigint | null)[];
  onAsset: (index: number) => void;
  onAmount: (text: string) => void;
  onMax?: () => void;
  disabled?: boolean;
}) {
  return (
    <div class="amount-row">
      {/* The field and, inside it at the right, the button that fills in all there is. */}
      <span class={props.onMax ? "amount-field amount-field-max" : "amount-field"}>
        <input
          class="input amount-input"
          inputMode="decimal"
          autocomplete="off"
          placeholder="0.0"
          aria-label="Amount"
          value={props.amount}
          disabled={props.disabled}
          onInput={(event) => props.onAmount((event.target as HTMLInputElement).value)}
        />
        {props.onMax ? (
          <button type="button" class="amount-max" onClick={props.onMax} disabled={props.disabled}>
            Max
          </button>
        ) : null}
      </span>
      <TokenSelect assets={props.assets} value={props.asset} balances={props.balances} onChange={props.onAsset} disabled={props.disabled} />
    </div>
  );
}
