/**
 * Several withdrawals at once, for a wallet that can send several calls as one (EIP-5792).
 * They are asked for in one confirmation, wait together, and are collected in one confirmation.
 * A wallet that cannot batch keeps the sheet for one asset at a time.
 */
import { useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { type Inspection, type ItemStatus, type QueueItem, chainTime, classify, executeTx, itemStatus, queueTx, withdrawalTx } from "../lib/chronobox.ts";
import { formatAmount, formatDate, formatDuration, formatUnits, parseUnits } from "../lib/format.ts";
import { sameAddress } from "../lib/hex.ts";
import { assertWallet, sendBatch } from "../lib/wallet.ts";
import { type Asset, AddressText, AssetAmount, Button, Modal, Notice, type Session, SlowNote, TokenBadge, useAction } from "./common.tsx";
import type { VaultRef } from "./queue.tsx";
import { SunPassArt } from "./art.tsx";

type Line = { asset: number; text: string };

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
  now: bigint;
  canCancel: boolean;
  onClose: () => void;
}) {
  const { session, chain, vault, inspection, assets, balances } = props;
  const held = assets.map((_, i) => i).filter((i) => (balances[i] ?? 0n) > 0n);
  const [lines, setLines] = useState<Line[]>([{ asset: held[0] ?? 0, text: "" }]);
  const [stage, setStage] = useState<"form" | "confirm" | "done">("form");
  const [doneAt, setDoneAt] = useState<bigint | null>(null);
  const action = useAction();

  const available = (index: number) => {
    const inside = balances[index];
    if (inside === null) return 0n;
    const reserved = reservedOf(props.queue, vault, inspection, props.now, assets[index]);
    return inside > reserved ? inside - reserved : 0n;
  };
  const parsed = lines.map((l) => ({ ...l, amount: parseUnits(l.text, assets[l.asset].decimals) }));
  const problems = parsed.map((l) =>
    l.text === ""
      ? null
      : l.amount === null
        ? "Enter the amount as a plain number, for example 1000 or 1.5."
        : l.amount === 0n
          ? "Enter more than zero."
          : l.amount > available(l.asset)
            ? `You can withdraw up to ${formatAmount(available(l.asset), assets[l.asset].decimals)} ${assets[l.asset].symbol}.`
            : null,
  );
  const twice = new Set(lines.map((l) => l.asset)).size !== lines.length;
  const chosen = parsed.filter((l, i) => l.amount && l.amount > 0n && !problems[i]);
  const ready = chosen.length > 0 && problems.every((p) => p === null) && !twice;
  const listText = chosen.map((l) => `${formatAmount(l.amount!, assets[l.asset].decimals)} ${assets[l.asset].symbol}`).join(", ");
  const delayText = formatDuration(inspection.cooldown);

  const submit = () =>
    action.run("queue", async (waiting) => {
      await assertWallet(session.rpc, session.account, chain.id, chain.name);
      const calls = chosen.map((l) => queueTx(vault.delay, withdrawalTx(vault.controller, assets[l.asset].token, l.amount!)));
      await sendBatch(session.wallet.provider, session.account, chain.id, calls, undefined, waiting.shouldStop);
      setDoneAt(await chainTime(session.rpc));
      setStage("done");
    });

  if (stage === "done" && doneAt !== null) {
    const status = itemStatus({ createdAt: doneAt }, inspection.cooldown, inspection.expiration, doneAt);
    return (
      <Modal title="The wait has started." onClose={props.onClose}>
        <div class="sun-pass">
          <SunPassArt size={96} />
        </div>
        <p class="big-line">{listText}</p>
        <p>
          Come back on <b>{formatDate(status.readyAt)}</b>. Then you collect all of it with one confirmation.
        </p>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
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
        </div>
        <ul class="plain-list">
          <li>Nobody can make it faster. No password, no threat, no stolen key. Not even you.</li>
          {props.canCancel ? <li>You can cancel it while it waits.</li> : null}
          <li>
            After the wait, you collect all of it here with one confirmation. Then it goes to your wallet <AddressText address={vault.controller} />.
          </li>
        </ul>
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        <div class="modal-actions">
          <Button kind="primary" busy={action.busy === "queue"} onClick={submit}>
            {action.busy ? "Confirm in your wallet" : "Start the wait"}
          </Button>
          <Button kind="quiet" onClick={() => setStage("form")} disabled={!!action.busy}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Withdraw" lead="How much do you need? Several assets can wait together." onClose={props.onClose}>
      {lines.map((line, k) => (
        <div class="many-line" key={k}>
          <AssetAmount
            assets={assets}
            asset={line.asset}
            amount={line.text}
            balances={balances}
            onAsset={(index) => setLines((all) => all.map((l, i) => (i === k ? { asset: index, text: "" } : l)))}
            onAmount={(text) => setLines((all) => all.map((l, i) => (i === k ? { ...l, text } : l)))}
            onMax={() => setLines((all) => all.map((l, i) => (i === k ? { ...l, text: formatUnits(available(line.asset), assets[line.asset].decimals) } : l)))}
          />
          {problems[k] ? <p class="field-error">{problems[k]}</p> : null}
          {lines.length > 1 ? (
            <button type="button" class="link-button" onClick={() => setLines((all) => all.filter((_, i) => i !== k))}>
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {twice ? <p class="field-error">Each asset once, please.</p> : null}
      {lines.length < held.length ? (
        <button
          type="button"
          class="link-button"
          onClick={() => setLines((all) => [...all, { asset: held.find((i) => !all.some((l) => l.asset === i)) ?? 0, text: "" }])}
        >
          Add another asset
        </button>
      ) : null}
      <p class="hint">After {delayText}, you collect all of it here with one confirmation.</p>
      <div class="modal-actions">
        <Button kind="primary" disabled={!ready} onClick={() => setStage("confirm")}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Withdrawals that were asked for together: in the same block, one after the other in the line.
 * Only plain withdrawals to the wallet are grouped. Anything else keeps its own card.
 */
export function groupsOf(queue: QueueItem[], vault: VaultRef): QueueItem[][] {
  const groups: QueueItem[][] = [];
  for (const item of queue) {
    const last = groups[groups.length - 1];
    const plain = item.tx && classify(item.tx, vault).kind === "withdraw";
    const prev = last?.[last.length - 1];
    if (last && plain && prev?.tx && classify(prev.tx, vault).kind === "withdraw" && prev.createdAt === item.createdAt) last.push(item);
    else groups.push([item]);
  }
  return groups;
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
  busy: string | null;
  onCollect: () => void;
  /** Clears expired items from the front of the line. */
  onRemove: () => void;
  onCancel: (() => void) | null;
  cancelLabel: string;
}) {
  const { items, status, now } = props;
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
            const asset = props.assets.find((x) => (token === null ? x.token === null : sameAddress(x.token, token)));
            return (
              <li key={String(item.nonce)}>
                {asset ? <TokenBadge asset={asset} /> : null}
                {a.kind === "withdraw" && asset ? `${formatAmount(a.amount, asset.decimals)} ${asset.symbol}` : "A token this app does not list"}
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
          <Button kind="primary" small busy={props.busy === `finish-${items[0].nonce}`} disabled={!!props.busy} onClick={props.onCollect}>
            Collect all
          </Button>
        ) : null}
        {status.phase === "expired" && props.first ? (
          <Button small busy={props.busy === "remove"} disabled={!!props.busy} onClick={props.onRemove}>
            Clear
          </Button>
        ) : null}
        {status.phase !== "expired" && props.onCancel ? (
          <button type="button" class="link-button" onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The calls that carry out a group, in its order in the line. */
export function collectCalls(items: QueueItem[], delay: VaultRef["delay"]) {
  return items.map((item) => executeTx(delay, item.tx!));
}
