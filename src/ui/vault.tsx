/**
 * One Chronobox: what is inside, how it is protected, what is waiting, and a
 * short list of things you can look at or change. Every action opens a sheet
 * with one decision and one main button.
 */
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Chain, CONTRACTS } from "../lib/chains.ts";
import { formatAmount, formatDate, formatDuration, formatUnits, parseUnits, shortAddress } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import { calendarFile, download } from "../lib/ics.ts";
import { addCustomToken, blockHints, rememberVault, txCache } from "../lib/store.ts";
import {
  type Action,
  type Inspection,
  type ItemStatus,
  type QueueItem,
  cancelTx,
  changeDelayTx,
  changeWalletTx,
  chainTime,
  classify,
  delayTxHash,
  executeTx,
  inspect,
  itemStatus,
  queueTx,
  queuedInReceipt,
  readQueue,
  readBalances,
  readToken,
  sendAndWait,
  skipExpiredTx,
  withdrawalTx,
  Replaced,
  StoppedWaiting,
  type Receipt,
  type DelayTx,
  receiptTime,
  MAX_COOLDOWN,
  MIN_COOLDOWN,
} from "../lib/chronobox.ts";
import { errorText, isRejection } from "../lib/wallet.ts";
import { AddressText, type Asset, AssetAmount, assetsOf, Button, copyText, Choice, Modal, Notice, type Session, SlowNote, type Waiting, useAction } from "./common.tsx";
import { DepositPanel } from "./deposit.tsx";

type VaultData = {
  inspection: Inspection;
  queue: QueueItem[];
  /** Null where the balance could not be read. That is "not known", never "nothing". */
  balances: (bigint | null)[];
  /** False when the long list of tokens could not be read, and only the main ones were. */
  allRead: boolean;
  assets: Asset[];
  now: bigint;
  fetchedAt: number;
};

type VaultRef = { safe: Address; delay: Address; controller: Address; roles?: Address | null };
type Sheet = "withdraw" | "deposit" | "token" | "delay" | "wallet" | "checks" | null;

function useVault(session: Session, chain: Chain, safe: Address) {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // One read at a time. A read that is asked for while another runs starts when that one ends:
  // on a slow network, a new read every 30 seconds would otherwise stop each one before it finishes.
  const reading = useRef(false);
  const wanted = useRef(false);
  const last = useRef<VaultData | null>(null);
  const refresh = useCallback(() => {
    if (reading.current) wanted.current = true;
    else setRound((r) => r + 1);
  }, []);

  useEffect(() => {
    let stale = false;
    reading.current = true;
    (async () => {
      try {
        const rpc = session.rpc;
        const assets = assetsOf(chain);
        let [inspection, now] = await Promise.all([inspect(rpc, safe, blockHints(chain.id)), chainTime(rpc)]);
        // A check that passed a moment ago and cannot run now is asked once more before the page says so.
        if (last.current?.inspection.state === "locked" && inspection.state !== "locked") {
          inspection = await inspect(rpc, safe, blockHints(chain.id)).catch(() => inspection);
        }
        const { balances, complete } = inspection.state === "missing" ? { balances: assets.map((): bigint | null => 0n), complete: true } : await readBalances(rpc, safe, assets);
        const queue = inspection.state === "locked" || inspection.state === "unverified" ? await readQueue(rpc, inspection, txCache(chain.id, inspection.delay!)) : [];
        if (stale) return;
        const next = { inspection, queue, balances, allRead: complete, assets, now, fetchedAt: Date.now() };
        last.current = next;
        setData(next);
        setError(null);
      } catch (e) {
        if (!stale) setError(errorText(e));
      } finally {
        if (!stale) {
          reading.current = false;
          if (wanted.current) {
            wanted.current = false;
            setRound((r) => r + 1);
          }
        }
      }
    })();
    return () => {
      stale = true;
      reading.current = false;
      wanted.current = false;
    };
  }, [session.rpc, chain, safe, round]);

  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && !reading.current && refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // The first read failed: try a few more times before leaving it to the person.
  const tries = useRef(0);
  useEffect(() => {
    if (data) tries.current = 0;
    if (!error || data || tries.current >= 3) return;
    const timer = setTimeout(() => {
      tries.current++;
      refresh();
    }, 3000 * (tries.current + 1));
    return () => clearTimeout(timer);
  }, [error, data, refresh]);

  return { data, error, refresh };
}

/** Chain time in seconds, advanced by the local clock between reads. */
function useChainClock(data: VaultData | null): bigint {
  const [, setBeat] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setBeat((b) => b + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!data) return 0n;
  return data.now + BigInt(Math.floor((Date.now() - data.fetchedAt) / 1000));
}

/**
 * A calendar file with "ready" and "collect it soon" for one waiting item.
 * Many calendars copy their entries to a cloud. So the file says only that something waits:
 * no amount, no address and no link.
 */
function saveReminders(nonce: bigint, status: ItemStatus, now: bigint) {
  const base = `chronobox-${status.readyAt}-${nonce}`;
  const reminders = [
    {
      uid: `${base}-ready@chronobox`,
      at: Number(status.readyAt),
      title: "Chronobox: a withdrawal is ready",
      description: "The wait has ended. Open your Chronobox to finish it.",
    },
  ];
  if (status.expiresAt !== null) {
    const before = status.expiresAt - status.readyAt >= 172_800n ? 86_400n : (status.expiresAt - status.readyAt) / 2n;
    reminders.push({
      uid: `${base}-expires@chronobox`,
      at: Number(status.expiresAt - before),
      title: "Chronobox: a withdrawal expires soon",
      description: `It expires on ${formatDate(status.expiresAt)}. After that you must ask again and wait again.`,
    });
  }
  download("chronobox-reminder.ics", calendarFile(reminders, Number(now)));
}

export function VaultPage(props: { session: Session; chain: Chain; safe: Address }) {
  const { session, chain, safe } = props;
  const { data, error, refresh } = useVault(session, chain, safe);
  const now = useChainClock(data);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [cancelling, setCancelling] = useState<QueueItem | null>(null);
  const [copied, setCopied] = useState(false);
  // Finishing and clearing share one state. Cancel has its own: it is the emergency action, and
  // nothing else that is pending may block it.
  const action = useAction();
  const cancelAction = useAction();
  const [confirming, setConfirming] = useState<QueueItem | null>(null);
  const sending = { chainId: chain.id, chainName: chain.name };
  const line = useRef<QueueItem[]>([]);
  line.current = data?.queue ?? [];

  useEffect(() => {
    // It is remembered for the wallet that is its key, so it shows in that wallet's list only.
    if (data?.inspection.state === "locked" && data.inspection.controller) rememberVault({ chainId: chain.id, safe, wallet: data.inspection.controller });
  }, [data?.inspection.state, data?.inspection.controller, chain.id, safe]);

  if (error && !data) {
    return (
      <section class="page page-center">
        <h1>We could not read your Chronobox.</h1>
        <p class="lead">Your money is not affected. Check the connection of your wallet and try again.</p>
        <p class="hint">{error}</p>
        <div class="page-actions">
          <Button kind="primary" onClick={refresh}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  if (!data) return <section class="page page-center muted">Opening your Chronobox…</section>;

  const { inspection, queue, assets, balances } = data;
  // "unverified": one check could not be done from this device. Money can still come out, so only deposits are held back.
  const verified = inspection.state === "locked";
  const locked = verified || inspection.state === "unverified";
  const isController = locked && sameAddress(inspection.controller, session.account);
  const canCancel = isController && !!inspection.roles;
  // Another wallet is the key. This wallet can look, and nothing else.
  const viewOnly = locked && !isController;
  const vault: VaultRef | null = locked ? { safe, delay: inspection.delay!, controller: inspection.controller!, roles: inspection.roles } : null;
  const close = () => {
    setSheet(null);
    refresh();
  };

  // After every try the page reads the chain again: a failure often means that the line has moved.
  const finish = (item: QueueItem) =>
    action.run(`finish-${item.nonce}`, async (waiting) => {
      // The item can leave the line while this waits: it was cancelled, or carried out from another device. Then there is nothing to wait for.
      const gone = () => !line.current.some((q) => q.nonce === item.nonce);
      try {
        await sendAndWait(session.rpc, session.account, executeTx(inspection.delay!, item.tx!), { ...sending, ...waiting, shouldStop: () => waiting.shouldStop() || gone() });
      } catch (e) {
        if (!(e instanceof StoppedWaiting && gone())) throw e;
      } finally {
        refresh();
      }
    });
  const cancel = (item: QueueItem) =>
    cancelAction.run("cancel", async (waiting) => {
      try {
        await sendAndWait(session.rpc, session.account, cancelTx(inspection.roles!, inspection.delay!, item.nonce), { ...sending, ...waiting });
        setCancelling(null);
      } finally {
        refresh();
      }
    });
  const remove = () =>
    action.run("remove", async (waiting) => {
      try {
        await sendAndWait(session.rpc, session.account, skipExpiredTx(inspection.delay!), { ...sending, ...waiting });
      } finally {
        refresh();
      }
    });
  const askCancel = (item: QueueItem) => {
    cancelAction.clearError();
    setConfirming(null);
    setCancelling(item);
  };
  const copyAddress = async () => {
    try {
      if (!(await copyText(safe))) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The address is on the "Add money" sheet too, where it can be selected by hand.
    }
  };

  // What is inside: every asset with a balance. The first one is shown large.
  const held = assets.map((asset, i) => ({ asset, amount: balances[i] })).filter((h): h is { asset: Asset; amount: bigint } => h.amount !== null && h.amount > 0n);
  const shown = held.length > 0 ? held : [{ asset: assets[0], amount: balances[0] ?? 0n }];
  const unread = assets.filter((a, i) => a.main && balances[i] === null).map((a) => a.symbol);
  // The item in the line that the cancel dialog is about may be gone by now.
  const cancelItem = cancelling ? (queue.find((q) => q.nonce === cancelling.nonce) ?? null) : null;
  const passed = inspection.checks.filter((c) => c.ok).length;
  const cancelIndex = cancelling ? queue.findIndex((q) => q.nonce === cancelling.nonce) : -1;

  return (
    <section class="page vault">
      <Status inspection={inspection} session={session} chain={chain} />
      {error ? (
        <p class="read-failed" role="status">
          Your wallet's network did not answer. This page shows what it read at {new Date(data.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.{" "}
          <button type="button" class="link-button" onClick={refresh}>
            Try again
          </button>
        </p>
      ) : null}

      {inspection.state !== "missing" ? (
        <div class="vault-main">
          {viewOnly ? (
            <p class="view-only">
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                <path d="M1.5 10S4.6 4.5 10 4.5 18.5 10 18.5 10 15.4 15.5 10 15.5 1.5 10 1.5 10z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
                <circle cx="10" cy="10" r="2.6" fill="currentColor" />
              </svg>
              View only
            </p>
          ) : null}
          <p class="eyebrow">{viewOnly ? `A Chronobox on ${chain.name}` : `Your Chronobox on ${chain.name}`}</p>
          <ul class="balances">
            {shown.map((h) => (
              <li key={h.asset.token ?? "native"}>
                <span class="balance-amount">{formatAmount(h.amount, h.asset.decimals)}</span>
                <span class="balance-symbol">{h.asset.symbol}</span>
              </li>
            ))}
          </ul>
          {unread.length > 0 ? <p class="hint">The balance of {unread.join(", ")} could not be read now. It is not shown, and it is not gone.</p> : null}
          {unread.length === 0 && !data.allRead ? <p class="hint">Only the main tokens could be read now. Other tokens are not shown, and they are not gone.</p> : null}
          {locked ? (
            <p class="vault-lock">
              <span class="dot" aria-hidden="true" />
              <span>
                Every withdrawal waits <b>{formatDuration(inspection.cooldown)}</b>.
              </span>
            </p>
          ) : null}
          {locked ? (
            <div class={viewOnly ? "vault-actions vault-actions-one" : "vault-actions"}>
              <Button kind={viewOnly ? "plain" : "primary"} disabled={!verified} onClick={() => setSheet("deposit")}>
                Add money
              </Button>
              {viewOnly ? null : <Button onClick={() => setSheet("withdraw")}>Withdraw</Button>}
            </div>
          ) : null}
          {viewOnly ? (
            <p class="hint">
              The key of this Chronobox is the wallet <AddressText address={inspection.controller!} />. Your wallet can look and add money. It cannot withdraw.
            </p>
          ) : null}
        </div>
      ) : null}

      {vault && queue.length > 0 ? (
        <div class="section">
          <h2>Waiting</h2>
          <ol class="queue">
            {queue.map((item, index) => (
              <QueueCard
                key={String(item.nonce)}
                item={item}
                first={index === 0}
                status={itemStatus(item, inspection.cooldown, inspection.expiration, now)}
                now={now}
                cooldown={inspection.cooldown}
                action={item.tx ? classify(item.tx, vault) : null}
                assets={assets}
                chain={chain}
                safe={safe}
                rpc={session.rpc}
                busy={action.busy}
                onFinish={() => finish(item)}
                onFinishFlagged={() => setConfirming(item)}
                onRemove={remove}
                onCancel={canCancel ? () => askCancel(item) : null}
              />
            ))}
          </ol>
          <SlowNote action={action} />
          {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        </div>
      ) : null}

      {locked ? (
        <ul class="rows">
          <Row label="Address" value={copied ? "Copied" : shortAddress(safe)} onClick={copyAddress} hint="Copy" strong />
          <Row label="Delay" value={formatDuration(inspection.cooldown)} onClick={isController ? () => setSheet("delay") : undefined} />
          <Row label="Wallet" value={isController ? shortAddress(inspection.controller!) : <AddressText address={inspection.controller!} />} onClick={isController ? () => setSheet("wallet") : undefined} />
          <Row
            label="Safety checks"
            value={verified ? `All ${passed} passed` : `${passed} of ${inspection.checks.length} passed`}
            onClick={() => setSheet("checks")}
          />
          <Row label="Tokens" value="Add a token" onClick={() => setSheet("token")} />
        </ul>
      ) : inspection.checks.length > 0 ? (
        <ul class="rows">
          <Row label="Safety checks" value={`${passed} of ${inspection.checks.length} passed`} onClick={() => setSheet("checks")} />
        </ul>
      ) : null}

      {sheet === "withdraw" && vault ? (
        <WithdrawSheet session={session} chain={chain} vault={vault} inspection={inspection} assets={assets} balances={balances} queue={queue} now={now} canCancel={canCancel} onClose={close} />
      ) : null}
      {sheet === "deposit" ? (
        <Modal title="Add money" onClose={close}>
          <DepositPanel session={session} chain={chain} safe={safe} assets={assets} />
        </Modal>
      ) : null}
      {sheet === "delay" && vault ? <ChangeDelaySheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "wallet" && vault ? <ChangeWalletSheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "token" ? <TokenSheet session={session} chain={chain} onClose={close} /> : null}
      {sheet === "checks" ? (
        <Modal title="Safety checks" lead="Chronobox reads these from the chain every time you open this page. Nothing is taken on trust." onClose={() => setSheet(null)}>
          <ul class="checks">
            {inspection.checks.map((check) => (
              <li key={check.id} class={check.ok ? "check-ok" : check.unknown ? "check-unknown" : "check-bad"}>
                <span class="check-mark" aria-hidden="true">
                  {check.ok ? "✓" : check.unknown ? "?" : "✕"}
                </span>
                <span>
                  {check.label}
                  <small>{check.detail}</small>
                </span>
              </li>
            ))}
          </ul>
          <p class="hint">
            Anybody can open this Chronobox by its address and run the same checks. <a href="#/technical">How it is built</a>
          </p>
        </Modal>
      ) : null}
      {cancelling && vault ? (
        <Modal title="Cancel this?" busy={cancelAction.busy !== null && !cancelAction.slow} onClose={() => setCancelling(null)}>
          {cancelItem ? (
            <>
              <p class="big-line">{describe(cancelItem.tx ? classify(cancelItem.tx, vault) : null, assets, {}).title}</p>
              <p>
                Nothing moves. Your money stays in the Chronobox.
                {cancelIndex > 0 ? ` Items wait in line, so this also cancels the ${cancelIndex === 1 ? "one" : cancelIndex} before it.` : ""}
              </p>
              <SlowNote action={cancelAction} />
              {cancelAction.error ? <Notice kind="bad">{cancelAction.error}</Notice> : null}
              <div class="modal-actions">
                <Button kind="primary" busy={cancelAction.busy === "cancel"} onClick={() => cancel(cancelItem)}>
                  Cancel it
                </Button>
                <Button kind="quiet" onClick={() => setCancelling(null)} disabled={!!cancelAction.busy}>
                  Keep it
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>This item is not in the line any more. It was cancelled or carried out already.</p>
              <div class="modal-actions">
                <Button kind="primary" onClick={() => setCancelling(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
      {confirming && vault ? (
        <Modal title="Carry this out?" onClose={() => setConfirming(null)}>
          <p class="big-line">{describe(confirming.tx ? classify(confirming.tx, vault) : null, assets, {}).title}</p>
          <Notice kind="risk">{describe(confirming.tx ? classify(confirming.tx, vault) : null, assets, {}).warning}</Notice>
          <div class="modal-actions">
            {canCancel ? (
              <Button kind="primary" onClick={() => askCancel(confirming)}>
                Cancel it
              </Button>
            ) : null}
            <Button
              kind="quiet"
              onClick={() => {
                const item = confirming;
                setConfirming(null);
                finish(item);
              }}
            >
              Carry it out
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

/** One line in the list under the balance. With an action it is a button. */
/** `strong` marks the one row that people come for: the address of the Chronobox. */
function Row(props: { label: string; value: ComponentChildren; hint?: string; onClick?: () => void; strong?: boolean }) {
  const inner = (
    <>
      <span class="row-label">{props.label}</span>
      <span class="row-value">{props.value}</span>
      {props.onClick ? (
        props.hint ? (
          <span class="row-hint">{props.hint}</span>
        ) : (
          <svg class="row-chevron" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
            <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        )
      ) : null}
    </>
  );
  return (
    <li>
      {props.onClick ? (
        <button type="button" class={props.strong ? "row row-strong" : "row"} onClick={props.onClick}>
          {inner}
        </button>
      ) : (
        <div class="row">{inner}</div>
      )}
    </li>
  );
}

/** Shown only when something needs attention. A healthy Chronobox shows nothing here. */
function Status(props: { inspection: Inspection; session: Session; chain: Chain }) {
  const { inspection, session } = props;
  if (inspection.state === "locked") return null;
  if (inspection.state === "unverified") {
    return (
      <Notice kind="risk" title="One safety check could not run here.">
        Nothing looks wrong, and you can withdraw. Wait with new deposits until the check passes: open this page with a wallet whose
        network connection can read old records.
      </Notice>
    );
  }
  if (inspection.state === "missing") {
    return (
      <Notice kind="bad" title={`There is no Chronobox at this address on ${props.chain.name}.`}>
        Check the address and the network. Do not send money here.
      </Notice>
    );
  }
  if (inspection.state === "open") {
    const mine = sameAddress(inspection.owners[0], session.account);
    return (
      <Notice kind="risk" title="The time delay of this Chronobox is not on yet. Do not send money.">
        {mine ? (
          <>
            The setup stopped halfway. <a href="#/new">Finish it now</a>
          </>
        ) : (
          "Its setup stopped halfway. Only the wallet that started it can finish it."
        )}
      </Notice>
    );
  }
  return (
    <Notice kind="bad" title="This is not a Chronobox. Do not send money here.">
      One or more safety checks failed. Open "Safety checks" to see which.
    </Notice>
  );
}

/** `flagged`: this app did not make the item, so carrying it out asks for a second look first. */
function describe(action: Action | null, assets: Asset[], tokens: Record<string, Asset>): { title: string; warning: string | null; finish: string; flagged?: boolean } {
  if (!action) {
    return { title: "Something this app cannot read", warning: "Its details are not available from your wallet's network connection. It cannot be finished from this device.", finish: "Finish" };
  }
  const amountOf = (token: Address | null, amount: bigint) => {
    const asset = assets.find((a) => (token === null ? a.token === null : sameAddress(a.token, token))) ?? (token ? tokens[token.toLowerCase()] : undefined);
    return asset ? `${formatAmount(amount, asset.decimals)} ${asset.symbol}` : `${amount} units of token ${shortAddress(token!)}`;
  };
  switch (action.kind) {
    case "withdraw":
      return { title: `Withdraw ${amountOf(action.token, action.amount)}`, warning: null, finish: "Collect now" };
    case "change-delay":
      return { title: `Change the delay to ${formatDuration(action.cooldown)}`, warning: null, finish: "Apply now" };
    case "change-wallet":
      return { title: `Hand over to ${shortAddress(action.to)}`, warning: `After this, only the wallet ${action.to} holds this Chronobox.`, finish: "Apply now" };
    case "transfer-elsewhere":
      return {
        title: `Send ${amountOf(action.token, action.amount)} to ${shortAddress(action.to)}`,
        warning: "This does not go to your wallet, and this app did not create it. If you did not ask for it, cancel it.",
        finish: "Send now",
        flagged: true,
      };
    case "settings":
      return { title: action.label, warning: "This changes the Chronobox, and this app did not create it. If you did not ask for it, cancel it.", finish: "Apply now", flagged: true };
    default:
      return { title: "Something this app cannot read", warning: "This app did not create it and cannot tell what it does. If you did not ask for it, cancel it.", finish: "Finish", flagged: true };
  }
}

function QueueCard(props: {
  item: QueueItem;
  first: boolean;
  status: ItemStatus;
  now: bigint;
  cooldown: bigint;
  action: Action | null;
  assets: Asset[];
  chain: Chain;
  safe: Address;
  rpc: Session["rpc"];
  busy: string | null;
  onFinish: () => void;
  onFinishFlagged: () => void;
  onRemove: () => void;
  onCancel: (() => void) | null;
}) {
  const { item, status, now, action } = props;
  const [tokens, setTokens] = useState<Record<string, Asset>>({});
  const token = action && (action.kind === "withdraw" || action.kind === "transfer-elsewhere") ? action.token : null;
  const known = !token || props.assets.some((a) => sameAddress(a.token, token));
  useEffect(() => {
    if (!token || known) return;
    let stale = false;
    readToken(props.rpc, token).then(
      (meta) => {
        if (meta && !stale) setTokens((t) => ({ ...t, [token.toLowerCase()]: { token, ...meta } }));
      },
      // The network did not answer. The item stays shown with the token's address.
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [token, known, props.rpc]);

  const { title, warning, finish, flagged } = describe(action, props.assets, tokens);
  const progress = Math.max(0, Math.min(1, Number(now - item.createdAt) / Number(props.cooldown || 1n)));

  return (
    <li class={`queue-item queue-${status.phase}${warning ? " queue-warning" : ""}`}>
      <div class="queue-main">
        <strong class="queue-title">{title}</strong>
        {warning ? <span class="queue-flag">{warning}</span> : null}
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
            {status.expiresAt !== null ? ` Finish it before ${formatDate(status.expiresAt)}.` : ""}
            {props.first ? "" : " The item before it comes first."}
          </span>
        ) : (
          <span class="queue-when">Expired on {formatDate(status.expiresAt!)}. Nothing moved.</span>
        )}
      </div>
      <div class="queue-actions">
        {status.phase === "ready" && item.tx && props.first ? (
          <Button kind={flagged ? undefined : "primary"} small busy={props.busy === `finish-${item.nonce}`} disabled={!!props.busy} onClick={flagged ? props.onFinishFlagged : props.onFinish}>
            {finish}
          </Button>
        ) : null}
        {status.phase === "expired" && props.first ? (
          <Button small busy={props.busy === "remove"} disabled={!!props.busy} onClick={props.onRemove}>
            Clear
          </Button>
        ) : null}
        {status.phase === "waiting" ? (
          <button type="button" class="link-button" onClick={() => saveReminders(item.nonce, status, now)}>
            Add to calendar
          </button>
        ) : null}
        {status.phase !== "expired" && props.onCancel ? (
          <button type="button" class="link-button" onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Puts one item into the line. Null means that the outcome is not known: the person stopped
 * waiting, or the wallet replaced the transaction. Then the line on the page has the answer,
 * and the form must not invite a second try.
 */
async function queueItem(session: Session, chain: Chain, vault: VaultRef, tx: DelayTx, waiting: Waiting): Promise<Receipt | null> {
  if (!sameAddress(vault.controller, session.account)) {
    throw new Error(`Your wallet is on another account now. Only the wallet ${shortAddress(vault.controller)} can do this.`);
  }
  try {
    return await sendAndWait(session.rpc, session.account, queueTx(vault.delay, tx), { chainId: chain.id, chainName: chain.name, ...waiting });
  } catch (e) {
    if (e instanceof Replaced || e instanceof StoppedWaiting) return null;
    throw e;
  }
}

/** After a send whose outcome is not known. */
function UnknownSheet(props: { onClose: () => void }) {
  return (
    <Modal title="Look at the line" onClose={props.onClose}>
      <p>
        Your wallet sent the request, but this page did not see it arrive. That can happen when the network is slow, or when the request was
        changed in the wallet.
      </p>
      <p>
        Close this and look under "Waiting". If it is there, the wait has started. If it is not there after a few minutes, ask again. Do not ask
        twice before you have looked.
      </p>
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

function WithdrawSheet(props: {
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
  const { session, vault, inspection, assets, balances } = props;
  const [assetIndex, setAssetIndex] = useState(0);
  const [amountText, setAmountText] = useState("");
  const [stage, setStage] = useState<"form" | "confirm" | "done" | "unknown">("form");
  const [agreed, setAgreed] = useState(false);
  const [queued, setQueued] = useState<{ nonce: bigint; at: bigint } | null>(null);
  const action = useAction();

  const asset = assets[assetIndex];
  // What earlier items in line will already take out.
  const reserved = useMemo(() => {
    let sum = 0n;
    for (const item of props.queue) {
      if (!item.tx) continue;
      // An expired item can never be carried out, so it takes nothing.
      if (itemStatus(item, inspection.cooldown, inspection.expiration, props.now).phase === "expired") continue;
      const a = classify(item.tx, vault);
      if ((a.kind === "withdraw" || a.kind === "transfer-elsewhere") && (a.token === null ? asset.token === null : sameAddress(a.token, asset.token))) {
        sum += a.amount;
      }
    }
    return sum;
  }, [props.queue, asset, vault, inspection.cooldown, inspection.expiration, props.now]);
  const inside = balances[assetIndex];
  const available = inside === null ? 0n : inside > reserved ? inside - reserved : 0n;
  const amount = parseUnits(amountText, asset.decimals);
  const problem =
    inside === null
      ? `The ${asset.symbol} in your Chronobox could not be read now. Close this and try again in a moment.`
      : amountText === ""
        ? null
        : amount === null
          ? "Enter the amount as a plain number, for example 1000 or 1.5."
        : amount === 0n
          ? "Enter more than zero."
          : amount > available
            ? `You can withdraw up to ${formatAmount(available, asset.decimals)} ${asset.symbol}.`
            : null;
  const delayText = formatDuration(inspection.cooldown);
  const amountLine = amount ? `${formatAmount(amount, asset.decimals)} ${asset.symbol}` : "";

  const submit = () =>
    action.run("queue", async (waiting) => {
      const tx = withdrawalTx(vault.controller, asset.token, amount!);
      const receipt = await queueItem(session, props.chain, vault, tx, waiting);
      if (!receipt) return setStage("unknown");
      // The withdrawal is in the line. Nothing after this may look like a failure.
      const added = queuedInReceipt(receipt, vault.delay);
      const cache = txCache(props.chain.id, vault.delay);
      for (const one of added) cache.set(one.nonce, delayTxHash(one.tx), one.tx);
      setQueued({ nonce: added[0]?.nonce ?? inspection.queueNonce, at: await receiptTime(session.rpc, receipt) });
      setStage("done");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done" && queued) {
    const status = itemStatus({ createdAt: queued.at }, inspection.cooldown, inspection.expiration, queued.at);
    return (
      <Modal title="The wait has started." onClose={props.onClose}>
        <p class="big-line">{amountLine}</p>
        <p>
          Come back on <b>{formatDate(status.readyAt)}</b> to collect it.
          {status.expiresAt !== null ? ` You then have ${formatDuration(inspection.expiration)}.` : ""}
        </p>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
          <Button kind="quiet" onClick={() => saveReminders(queued.nonce, status, queued.at)}>
            Add to calendar
          </Button>
        </div>
      </Modal>
    );
  }

  if (stage === "confirm") {
    return (
      <Modal title={`Withdraw ${amountLine}`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <div class="delay-callout">
          <span class="delay-callout-label">This takes</span>
          <span class="delay-callout-value">{delayText}</span>
        </div>
        <ul class="plain-list">
          <li>Nobody can make it faster. No password, no threat, no stolen key. Not even you.</li>
          {props.canCancel ? <li>You can cancel it while it waits.</li> : null}
          <li>
            After the wait, you come back here and collect it. Then it goes to your wallet <AddressText address={vault.controller} />.
          </li>
        </ul>
        <Choice role="checkbox" on={agreed} title={`I will wait ${delayText}.`} onClick={() => setAgreed(!agreed)} disabled={!!action.busy} />
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!agreed} busy={action.busy === "queue"} onClick={submit}>
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
    <Modal title="Withdraw" lead="How much do you need?" onClose={props.onClose}>
      <AssetAmount
        assets={assets}
        asset={assetIndex}
        amount={amountText}
        balances={balances}
        onAsset={(index) => {
          setAssetIndex(index);
          setAmountText("");
        }}
        onAmount={setAmountText}
        onMax={inside === null ? undefined : () => setAmountText(formatUnits(available, asset.decimals))}
      />
      {problem ? (
        <p class="field-error">{problem}</p>
      ) : (
        <p class="hint">
          After {delayText}, you collect it here. Then it goes to your wallet <AddressText address={vault.controller} />.
        </p>
      )}
      <div class="modal-actions">
        <Button kind="primary" disabled={!amount || !!problem} onClick={() => setStage("confirm")}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}

const DELAY_CHOICES: { label: string; seconds: bigint }[] = [
  { label: "12 hours", seconds: 12n * 3600n },
  { label: "1 day", seconds: 24n * 3600n },
  { label: "1 week", seconds: 7n * 24n * 3600n },
  { label: "30 days", seconds: 30n * 24n * 3600n },
];

function ChangeDelaySheet(props: { session: Session; chain: Chain; vault: VaultRef; inspection: Inspection; canCancel: boolean; onClose: () => void }) {
  const { session, vault, inspection } = props;
  const [picked, setPicked] = useState<bigint | "custom" | null>(null);
  const [customValue, setCustomValue] = useState("3");
  const [customUnit, setCustomUnit] = useState<"hours" | "days">("days");
  const [done, setDone] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const action = useAction();
  const now = formatDuration(inspection.cooldown);
  const custom = /^\d{1,4}$/.test(customValue) ? BigInt(customValue) * (customUnit === "days" ? 86_400n : 3_600n) : null;
  const problem =
    picked !== "custom"
      ? null
      : custom === null
        ? "Enter a whole number."
        : custom < MIN_COOLDOWN
          ? `The shortest delay is ${formatDuration(MIN_COOLDOWN)}.`
          : custom > MAX_COOLDOWN
            ? `The longest delay is ${formatDuration(MAX_COOLDOWN)}.`
            : custom === inspection.cooldown
              ? "That is the delay now."
              : null;
  const choice = picked === "custom" ? (problem ? null : custom) : picked;
  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, props.chain, vault, changeDelayTx(vault.delay, choice!), waiting);
      if (receipt) setDone(true);
      else setUnknown(true);
    });
  if (unknown) return <UnknownSheet onClose={props.onClose} />;
  if (done) {
    return (
      <Modal title="The wait has started." lead={`In ${now} you can apply the new delay. Until then, every withdrawal still waits ${now}.`} onClose={props.onClose}>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Change the delay"
      lead={`Withdrawals wait ${now} now. A change waits ${now} too${props.canCancel ? ", and you can cancel it in that time" : ""}.`}
      busy={action.busy !== null && !action.slow}
      onClose={props.onClose}
    >
      <div class="wiz-list" role="radiogroup" aria-label="New delay">
        {DELAY_CHOICES.filter((c) => c.seconds !== inspection.cooldown).map((c) => (
          <Choice key={c.label} role="radio" on={picked === c.seconds} title={c.label} disabled={!!action.busy} onClick={() => setPicked(c.seconds)} />
        ))}
        <Choice role="radio" on={picked === "custom"} title="Another length" text="From 1 hour to 90 days" disabled={!!action.busy} onClick={() => setPicked("custom")} />
      </div>
      {picked === "custom" ? (
        <div class="custom-delay">
          <input
            class="input"
            inputMode="numeric"
            aria-label="Delay length"
            disabled={!!action.busy}
            value={customValue}
            onInput={(event) => setCustomValue((event.target as HTMLInputElement).value.trim())}
          />
          <select
            class="input select"
            aria-label="Unit"
            disabled={!!action.busy}
            value={customUnit}
            onChange={(event) => setCustomUnit((event.target as HTMLSelectElement).value as "hours" | "days")}
          >
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      ) : null}
      {problem ? <p class="field-error">{problem}</p> : null}
      {choice !== null && choice < inspection.cooldown ? <p class="hint">A shorter delay gives you less time to notice a withdrawal that you did not ask for.</p> : null}
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={choice === null} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
      </div>
    </Modal>
  );
}

function ChangeWalletSheet(props: { session: Session; chain: Chain; vault: VaultRef; inspection: Inspection; canCancel: boolean; onClose: () => void }) {
  const { session, vault, inspection } = props;
  const [text, setText] = useState("");
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const next = parseAddress(text);
  const tx = next ? changeWalletTx(vault.delay, vault.controller, next, vault.roles ?? null, vault.safe) : null;
  const problem =
    text.trim() === ""
      ? null
      : !next
        ? "This is not a wallet address."
        : sameAddress(next, vault.controller)
          ? "Enter a wallet other than this one."
          : sameAddress(next, vault.safe)
            ? "This is the address of the Chronobox itself. Enter the address of the new wallet."
            : !tx
              ? "Nobody can sign with this address. Enter the address of a wallet."
              : null;
  const wait = formatDuration(inspection.cooldown);
  const [unknown, setUnknown] = useState(false);
  // A contract at the new address is not wrong (it can be a Safe), but it is worth a second look.
  const [isContract, setIsContract] = useState(false);
  useEffect(() => {
    setIsContract(false);
    if (!next || !tx) return;
    let stale = false;
    session.rpc("eth_getCode", [next, "latest"]).then(
      (code: string) => !stale && setIsContract(typeof code === "string" && code.length > 2),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [next, !!tx, session.rpc]);
  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, props.chain, vault, tx!, waiting);
      if (receipt) setDone(true);
      else setUnknown(true);
    });
  const copy = async () => {
    try {
      if (!(await copyText(vault.safe))) return;
      setCopied(true);
    } catch {
      // The address is on screen and can be selected by hand.
    }
  };
  if (unknown) return <UnknownSheet onClose={props.onClose} />;
  if (done) {
    return (
      <Modal title="The wait has started." lead={`In ${wait} you can apply the hand-over. Keep the address of this Chronobox: the new wallet needs it to open it.`} onClose={props.onClose}>
        <button type="button" class="deposit-address" onClick={copy}>
          <code>{vault.safe}</code>
          <span class="deposit-copy">{copied ? "Copied" : "Tap to copy"}</span>
        </button>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Hand over to another wallet"
      lead={`After ${wait}, the new wallet is the only key. This wallet can then do nothing.${props.canCancel ? " You can cancel while it waits." : ""}`}
      busy={action.busy !== null && !action.slow}
      onClose={props.onClose}
    >
      <input
        class="input"
        placeholder="Address of the new wallet"
        aria-label="Address of the new wallet"
        autocomplete="off"
        spellcheck={false}
        value={text}
        disabled={!!action.busy}
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
      />
      {problem ? <p class="field-error">{problem}</p> : null}
      {isContract && !problem ? <p class="hint">This address is a contract, not a plain wallet. That is right only if it is a wallet such as a Safe, and you control it on {props.chain.name}.</p> : null}
      <Choice
        role="checkbox"
        on={sure}
        title="I checked the address, and I hold its key."
        text="If it is wrong, the money in this Chronobox is gone."
        disabled={!!action.busy}
        onClick={() => setSure(!sure)}
      />
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!tx || !sure} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
      </div>
    </Modal>
  );
}

function TokenSheet(props: { session: Session; chain: Chain; onClose: () => void }) {
  const [text, setText] = useState("");
  const action = useAction();
  const add = () =>
    action.run("token", async () => {
      const address = parseAddress(text);
      if (!address) throw new Error("This is not a token address.");
      if (sameAddress(address, CONTRACTS.burn)) throw new Error("This is not a token.");
      if (assetsOf(props.chain).some((a) => sameAddress(a.token, address))) throw new Error("Chronobox knows this token already. It shows as soon as your Chronobox holds some.");
      const meta = await readToken(props.session.rpc, address);
      if (!meta) throw new Error(`There is no token at this address on ${props.chain.name}.`);
      if (!addCustomToken(props.chain.id, { address, ...meta })) {
        throw new Error("This browser did not keep the token. Its storage is blocked or full, for example in a private window.");
      }
      props.onClose();
    });
  return (
    <Modal title="Add a token" lead={`Your Chronobox can hold any token on ${props.chain.name}. Paste its address to see it here.`} onClose={props.onClose}>
      <input
        class="input"
        placeholder="Token address"
        aria-label="Token address"
        autocomplete="off"
        spellcheck={false}
        value={text}
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
      />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" busy={action.busy === "token"} disabled={!text} onClick={add}>
          Add
        </Button>
      </div>
    </Modal>
  );
}
