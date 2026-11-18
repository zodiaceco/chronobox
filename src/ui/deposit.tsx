/**
 * How money gets into a Chronobox. The address comes first: a vault can
 * receive from any wallet or exchange, any token, any number of times.
 * Sending from the connected wallet is the second way, one asset at a time.
 */
import { useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import type { Chain } from "../lib/chains.ts";
import { formatAmount, formatUnits, parseUnits } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";
import { depositTx, sendAndWait } from "../lib/chronobox.ts";
import { type Asset, AssetAmount, Button, Notice, type Session, useAction, useBalances } from "./common.tsx";

/** A QR code as one SVG path. No image file, no inline style. */
export function QrCode(props: { text: string; label: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(props.text);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += `M${col + 2} ${row + 2}h1v1h-1z`;
      }
    }
    // Two modules of quiet zone on each side.
    return { path: d, size: count + 4 };
  }, [props.text]);
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={props.label} shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function DepositPanel(props: { session: Session; chain: Chain; safe: Address; assets: Asset[]; onSent?: () => void; quiet?: boolean }) {
  const { session, chain, safe, assets } = props;
  const [copied, setCopied] = useState(false);
  const [fromWallet, setFromWallet] = useState(false);
  const [assetIndex, setAssetIndex] = useState(0);
  const [amountText, setAmountText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const action = useAction();
  const asset = assets[assetIndex];
  const amount = parseUnits(amountText, asset.decimals);
  const balances = useBalances(session.rpc, fromWallet ? session.account : null, assets, round);
  const held = balances[assetIndex];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(safe);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The address is on screen and can be selected by hand.
    }
  };

  const send = () =>
    action.run("deposit", async () => {
      if (held !== null && held !== undefined && amount! > held) {
        throw new Error(`Your wallet has only ${formatAmount(held, asset.decimals)} ${asset.symbol}.`);
      }
      await sendAndWait(session.rpc, session.account, depositTx(safe, asset.token, amount!));
      setSent(`${formatAmount(amount!, asset.decimals)} ${asset.symbol}`);
      setAmountText("");
      setRound((r) => r + 1);
      props.onSent?.();
    });

  return (
    <div class="deposit">
      <div class="deposit-qr">
        <QrCode text={safe} label={`QR code of the address ${safe}`} />
      </div>
      <button type="button" class="deposit-address" onClick={copy} aria-label="Copy the address">
        <code>{safe}</code>
        <span class="deposit-copy">{copied ? "Copied" : "Tap to copy"}</span>
      </button>
      <p class="deposit-note">
        Send on <b>{chain.name}</b> only. From any wallet or exchange, as often as you like.
      </p>

      {fromWallet ? (
        <div class="deposit-wallet">
          <AssetAmount
            assets={assets}
            asset={assetIndex}
            amount={amountText}
            balances={balances}
            onAsset={setAssetIndex}
            onAmount={setAmountText}
            onMax={held ? () => setAmountText(formatUnits(held, asset.decimals)) : undefined}
            disabled={!!action.busy}
          />
          {held !== null && held !== undefined ? (
            <p class="hint">
              In this wallet: {formatAmount(held, asset.decimals)} {asset.symbol}
            </p>
          ) : null}
          {sent ? <Notice kind="good">{sent} is in your Chronobox.</Notice> : null}
          {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
          <Button kind={props.quiet ? "plain" : "primary"} disabled={!amount} busy={action.busy === "deposit"} onClick={send}>
            Send {amount ? `${amountText} ${asset.symbol}` : ""}
          </Button>
        </div>
      ) : (
        <button type="button" class="link-button deposit-switch" onClick={() => setFromWallet(true)}>
          Or send from this wallet
        </button>
      )}
    </div>
  );
}
