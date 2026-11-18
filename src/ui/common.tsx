import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { formatAmount, shortAddress } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";
import { type Rpc, nativeBalance, tokenBalance } from "../lib/chronobox.ts";
import { type WalletOption, errorText } from "../lib/wallet.ts";

export type Session = {
  wallet: WalletOption;
  account: Address;
  chainId: number;
  rpc: Rpc;
};

export type Asset = { token: Address | null; symbol: string; decimals: number };

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

export function Modal(props: { title: string; lead?: string; wide?: boolean; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, [props.onClose]);
  return (
    <div class="modal-backdrop" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class={props.wide ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="modal-head">
          <h2>{props.title}</h2>
          <button type="button" class="icon-button" aria-label="Close" onClick={props.onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
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

export function Copy(props: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // Clipboard is blocked. The text is visible and can be selected by hand.
    }
  };
  return (
    <button type="button" class="link-button" onClick={copy}>
      {done ? "Copied" : (props.label ?? "Copy")}
    </button>
  );
}

export function AddressText(props: { address: Address; chain?: Chain; full?: boolean }) {
  const text = props.full ? props.address : shortAddress(props.address);
  return props.chain ? (
    <a class="address" href={`${props.chain.explorer}/address/${props.address}`} target="_blank" rel="noreferrer noopener" title={props.address}>
      {text}
    </a>
  ) : (
    <span class="address" title={props.address}>
      {text}
    </span>
  );
}

/** Runs one wallet action at a time and keeps its error. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

/** Balances of one address for a list of assets. Null while loading or when a read failed. */
export function useBalances(rpc: Rpc, holder: Address | null, assets: Asset[], round = 0): (bigint | null)[] {
  const [balances, setBalances] = useState<(bigint | null)[]>([]);
  const key = assets.map((a) => a.token ?? "native").join(",");
  useEffect(() => {
    if (!holder) return setBalances([]);
    let stale = false;
    Promise.all(
      assets.map((a) => (a.token ? tokenBalance(rpc, a.token, holder) : nativeBalance(rpc, holder)).catch(() => null)),
    ).then((list) => !stale && setBalances(list));
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
  const current = props.assets[props.value];
  return (
    <div class="token-select">
      <button type="button" class="token-button" aria-haspopup="listbox" aria-expanded={open} disabled={props.disabled} onClick={() => setOpen(!open)}>
        <span class="token-badge" aria-hidden="true">
          {current.symbol.slice(0, 1)}
        </span>
        {current.symbol}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul class="token-list" role="listbox" aria-label="Asset">
          {props.assets.map((asset, index) => {
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
                  <span class="token-badge" aria-hidden="true">
                    {asset.symbol.slice(0, 1)}
                  </span>
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
        <button type="button" class="link-button" onClick={props.onMax} disabled={props.disabled}>
          Max
        </button>
      ) : null}
      <TokenSelect assets={props.assets} value={props.asset} balances={props.balances} onChange={props.onAsset} disabled={props.disabled} />
    </div>
  );
}
