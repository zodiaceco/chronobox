/**
 * Several withdrawals at once, for a wallet that can send several calls as one (EIP-5792).
 * They are asked for in one confirmation, wait together, and are collected in one confirmation.
 * A wallet that cannot batch keeps the sheet for one asset at a time.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { type Inspection, type ItemStatus, type QueueItem, chainTime, classify, collectCalls, groupsOf, itemStatus, queueTx, readToken, withdrawalTx } from "../lib/chronobox.ts";
import { formatAmount, formatDate, formatDuration, formatUnits, parseUnits, shortAddress } from "../lib/format.ts";
import { type Address, sameAddress } from "../lib/hex.ts";
import { BatchUnknown, assertWallet, sendBatch } from "../lib/wallet.ts";
import { type Asset, AddressText, AssetAmount, Button, Choice, Modal, Notice, type Session, SlowNote, TokenBadge, useAction } from "./common.tsx";
import { UnknownSheet, type VaultRef } from "./queue.tsx";
import { SunPassArt } from "./art.tsx";

export { collectCalls, groupsOf };

type Line = { id: number; asset: number; text: string };

/** What the line will take out already, per asset, from items that can still be carried out. */
function reservedOf(queue: QueueItem[], vault: VaultRef, inspection: Inspection, now: bigint, asset: Asset): bigint {
  let sum = 0n;
  for (const item of queue) {
    if (!item.tx || itemStatus(item, inspection.cooldown, inspection.expiration, now).phase === "expired") continue;
    const a = classify(item.tx, vault);
    if ((a.kind === "withdraw" || a.kind === "transfer-elsewhere") && (a.token === null ? asset.token === null : sameAddress(a.token, asset.token))) sum += a.amount;
  }
  return sum;
}

export function WithdrawManySheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  assets: Asset[];
  balances: (bigint | null)[];
  queue: QueueItem[];
  /** True when not every item of the line was read: then `reserved` can be too low. */
  partial: boolean;
  now: bigint;
  canCancel: boolean;
  onRemind: (nonce: bigint, status: ItemStatus, at: bigint) => void;
  onClose: () => void;
}) {
  const { session, chain, vault, inspection, assets, balances } = props;
  const held = assets.map((_, i) => i).filter((i) => (balances[i] ?? 0n) > 0n);
  const nextId = useRef(1);
  const [lines, setLines] = useState<Line[]>([{ id: 0, asset: held[0] ?? 0, text: "" }]);
  const [stage, setStage] = useState<"form" | "confirm" | "done" | "unknown">("form");
  const [agreed, setAgreed] = useState(false);
  const [doneAt, setDoneAt] = useState<bigint | null>(null);
  const action = useAction();

  const safeIndex = (index: number) => (index >= 0 && index < assets.length ? index : 0);
  const available = (index: number) => {
    const idx = safeIndex(index);
    const inside = balances[idx];
    if (inside === null || inside === undefined) return 0n;
    const reserved = reservedOf(props.queue, vault, inspection, props.now, assets[idx]);
    return inside > reserved ? inside - reserved : 0n;
  };
  const parsed = lines.map((l) => {
    const asset = safeIndex(l.asset);
    return { ...l, asset, amount: parseUnits(l.text, assets[asset].decimals) };
  });
  const problems = parsed.map((l) => {
    const asset = assets[l.asset];
    const inside = balances[l.asset];
    if (inside === null || inside === undefined) {
      return `The ${asset.symbol} in your Chronobox could not be read now. Close this and try again in a moment.`;
    }
    if (l.text === "") return null;
    if (l.amount === null) return "Enter the amount as a plain number, for example 1000 or 1.5.";
    if (l.amount === 0n) return "Enter more than zero.";
    const avail = available(l.asset);
    if (l.amount > avail) return `You can withdraw up to ${formatAmount(avail, asset.decimals)} ${asset.symbol}.`;
    return null;
  });
  const twice = new Set(parsed.map((l) => l.asset)).size !== parsed.length;
  const chosen = parsed.filter((l, i) => l.amount && l.amount > 0n && !problems[i]);
  const ready = chosen.length > 0 && problems.every((p) => p === null) && !twice;
  const listText = chosen.map((l) => `${formatAmount(l.amount!, assets[l.asset].decimals)} ${assets[l.asset].symbol}`).join(", ");
  const delayText = formatDuration(inspection.cooldown);

  const submit = () =>
    action.run("queue", async (waiting) => {
      await assertWallet(session.rpc, session.account, chain.id, chain.name);
      const calls = chosen.map((l) => queueTx(vault.delay, withdrawalTx(vault.controller, assets[l.asset].token, l.amount!)));
      try {
        await sendBatch(session.wallet.provider, session.account, chain.id, calls, undefined, waiting.shouldStop);
      } catch (e) {
        if (e instanceof BatchUnknown) return setStage("unknown");
        throw e;
      }
      // The withdrawals are in the line. Nothing after this may look like a failure.
      const at = await chainTime(session.rpc).catch(() => BigInt(Math.floor(Date.now() / 1000)));
      setDoneAt(at);
      setStage("done");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done" && doneAt !== null) {
    const status = itemStatus({ createdAt: doneAt }, inspection.cooldown, inspection.expiration, doneAt);
    return (
      <Modal title="The wait has started." onClose={props.onClose}>
        <div class="sun-pass">
          <SunPassArt size={96} />
        </div>
        <p class="big-line">{listText}</p>
        <p>
          Come back on <b>{formatDate(status.readyAt)}</b>.
          {status.expiresAt !== null
            ? ` You then have ${formatDuration(inspection.expiration)} to collect all of it with one confirmation. After that time, this withdrawal is no longer valid and the money stays in your Chronobox.`
            : " Then you collect all of it with one confirmation."}
        </p>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
          <Button kind="quiet" onClick={() => props.onRemind(inspection.queueNonce, status, doneAt)}>
            Add to calendar
          </Button>
        </div>
      </Modal>
    );
  }

  if (stage === "confirm") {
    return (
      <Modal title={`Withdraw ${listText}`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <div class="delay-callout">
          <span class="delay-callout-label">This takes</span>
          <span class="delay-callout-value">{delayText}</span>
          <span class="delay-callout-when">Ready around {formatDate(props.now + inspection.cooldown)}</span>
        </div>
        <ul class="plain-list">
          <li>Nobody can make it faster. No password, no threat, no stolen key. Not even you.</li>
          {props.canCancel ? <li>You can cancel it while it waits.</li> : null}
          <li>
            After the wait, you collect all of it here with one confirmation. Then it goes to your wallet <AddressText address={vault.controller} />.
          </li>
        </ul>
        <Choice role="checkbox" on={agreed} title={`I will wait ${delayText}.`} onClick={() => setAgreed(!agreed)} disabled={!!action.busy} />
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!agreed} busy={action.busy === "queue"} onClick={submit}>
            {action.busy ? "Confirm in your wallet" : "Start the wait"}
          </Button>
          <Button
            kind="quiet"
            onClick={() => {
              action.clearError();
              setStage("form");
            }}
            disabled={!!action.busy}
          >
            Back
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Withdraw" lead="How much do you need? Several assets can wait together." onClose={props.onClose}>
      {parsed.map((line, k) => {
        const inside = balances[line.asset];
        return (
          <div class="many-line" key={line.id}>
            <AssetAmount
              assets={assets}
              asset={line.asset}
              amount={line.text}
              balances={balances}
              onAsset={(index) => setLines((all) => all.map((l) => (l.id === line.id ? { ...l, asset: index, text: "" } : l)))}
              onAmount={(text) => setLines((all) => all.map((l) => (l.id === line.id ? { ...l, text } : l)))}
              onMax={inside === null || inside === undefined ? undefined : () => setLines((all) => all.map((l) => (l.id === line.id ? { ...l, text: formatUnits(available(line.asset), assets[line.asset].decimals) } : l)))}
            />
            {problems[k] ? <p class="field-error">{problems[k]}</p> : null}
            {lines.length > 1 ? (
              <button type="button" class="link-button" onClick={() => setLines((all) => all.filter((l) => l.id !== line.id))}>
                Remove
              </button>
            ) : null}
          </div>
        );
      })}
      {twice ? <p class="field-error">Each asset once, please.</p> : null}
      {lines.length < held.length ? (
        <button
          type="button"
          class="link-button"
          onClick={() => setLines((all) => [...all, { id: nextId.current++, asset: held.find((i) => !all.some((l) => safeIndex(l.asset) === i)) ?? 0, text: "" }])}
        >
          Add another asset
        </button>
      ) : null}
      <p class="hint">
        {props.partial ? "Not everything in line could be read, so more may be waiting than this counts. " : ""}
        After {delayText}, you collect all of it here with one confirmation.
      </p>
      <div class="modal-actions">
        <Button kind="primary" disabled={!ready} onClick={() => setStage("confirm")}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}

/** One card for several withdrawals that wait together. */
export function GroupCard(props: {
  items: QueueItem[];
  first: boolean;
  status: ItemStatus;
  now: bigint;
  cooldown: bigint;
  vault: VaultRef;
  assets: Asset[];
  rpc: Session["rpc"];
  busy: string | null;
  onCollect: () => void;
  /** Carries out the first item alone: when one of the group can no longer go through, the others still can, in their order. */
  onCollectFirst: () => void;
  /** Clears expired items from the front of the line. */
  onRemove: () => void;
  onRemind: (nonce: bigint, status: ItemStatus) => void;
  onCancel: (() => void) | null;
  cancelLabel: string;
}) {
  const { items, status, now } = props;
  const [tokens, setTokens] = useState<Record<string, Asset>>({});
  const unknownKey = items
    .map((item) => {
      const a = classify(item.tx!, props.vault);
      return a.kind === "withdraw" && a.token && !props.assets.some((x) => sameAddress(x.token, a.token)) ? a.token.toLowerCase() : null;
    })
    .filter((t, i, all): t is string => t !== null && all.indexOf(t) === i)
    .sort()
    .join(",");
  useEffect(() => {
    if (!unknownKey) return;
    let stale = false;
    for (const addr of unknownKey.split(",") as Address[]) {
      readToken(props.rpc, addr).then(
        (meta) => {
          if (meta && !stale) setTokens((t) => ({ ...t, [addr]: { token: addr, ...meta } }));
        },
        () => undefined,
      );
    }
    return () => {
      stale = true;
    };
  }, [unknownKey, props.rpc]);

  const progress = Math.max(0, Math.min(1, Number(now - items[0].createdAt) / Number(props.cooldown || 1n)));
  return (
    <li class={`queue-item queue-${status.phase}`}>
      <div class="queue-main">
        <span class="queue-head">
          <strong class="queue-title">Withdraw {items.length} assets</strong>
        </span>
        <ul class="queue-lines">
          {items.map((item) => {
            const a = classify(item.tx!, props.vault);
            const token = a.kind === "withdraw" ? a.token : null;
            const asset =
              props.assets.find((x) => (token === null ? x.token === null : sameAddress(x.token, token))) ??
              (token ? tokens[token.toLowerCase()] : undefined);
            return (
              <li key={String(item.nonce)}>
                {asset ? <TokenBadge asset={asset} /> : null}
                {a.kind === "withdraw"
                  ? asset
                    ? `${formatAmount(a.amount, asset.decimals)} ${asset.symbol}`
                    : `${a.amount} units of token ${shortAddress(a.token!)}`
                  : "A token this app does not list"}
              </li>
            );
          })}
        </ul>
        {status.phase === "waiting" ? (
          <>
            <span class="queue-when">
              Ready in <b>{formatDuration(status.readyAt - now)}</b>, on {formatDate(status.readyAt)}
            </span>
            <progress class="progress" max={1} value={progress} aria-label="Part of the wait that has passed" />
          </>
        ) : status.phase === "ready" ? (
          <span class="queue-when">
            <b>Ready.</b>
            {status.expiresAt !== null ? ` Collect it before ${formatDate(status.expiresAt)}.` : ""}
            {props.first ? "" : " The item before it comes first."}
          </span>
        ) : (
          <span class="queue-when">Expired on {formatDate(status.expiresAt!)}. Nothing moved.</span>
        )}
      </div>
      <div class="queue-actions">
        {status.phase === "ready" && props.first ? (
          <Button kind="primary" small busy={props.busy === `collect-${items[0].nonce}`} disabled={!!props.busy} onClick={props.onCollect}>
            Collect all
          </Button>
        ) : null}
        {status.phase === "ready" && props.first ? (
          <button type="button" class="link-button" disabled={!!props.busy} onClick={props.onCollectFirst}>
            {props.busy === `finish-${items[0].nonce}` ? "Collecting…" : "One at a time"}
          </button>
        ) : null}
        {status.phase === "expired" && props.first ? (
          <Button small busy={props.busy === "remove"} disabled={!!props.busy} onClick={props.onRemove}>
            Clear
          </Button>
        ) : null}
        {status.phase === "waiting" ? (
          <button type="button" class="link-button" onClick={() => props.onRemind(items[0].nonce, status)}>
            Add to calendar
          </button>
        ) : null}
        {status.phase !== "expired" && props.onCancel ? (
          <span class="queue-cancel">
            <Button small onClick={props.onCancel}>
              {props.cancelLabel}
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}
