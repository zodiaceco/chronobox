/**
 * One Chronobox: what is inside, how it is protected, what is waiting, and a
 * short list of things you can look at or change. Every action opens a sheet
 * with one decision and one main button.
 */
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { type Chain, CONTRACTS } from "../lib/chains.ts";
import { formatAmount, formatDate, formatDuration, formatUnits, parseUnits, shortAddress } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import { calendarFile, download } from "../lib/ics.ts";
import { addCustomToken, blockHints, customTokens, rememberVault, txCache } from "../lib/store.ts";
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
  nativeBalance,
  queueTx,
  queuedInReceipt,
  readQueue,
  readToken,
  sendAndWait,
  skipExpiredTx,
  tokenBalance,
  withdrawalTx,
} from "../lib/chronobox.ts";
import { errorText } from "../lib/wallet.ts";
import { AlertsSheet } from "./alerts.tsx";
import { AddressText, type Asset, AssetAmount, Button, Choice, Modal, Notice, type Session, useAction } from "./common.tsx";
import { DepositPanel } from "./deposit.tsx";

type VaultData = {
  inspection: Inspection;
  queue: QueueItem[];
  balances: bigint[];
  assets: Asset[];
  now: bigint;
  fetchedAt: number;
};

type VaultRef = { safe: Address; delay: Address; controller: Address; roles?: Address | null };
type Sheet = "withdraw" | "deposit" | "token" | "delay" | "wallet" | "checks" | "alerts" | null;

function assetsOf(chain: Chain): Asset[] {
  return [
    { token: null, symbol: chain.native.symbol, decimals: 18 },
    ...chain.tokens.map((t) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals })),
    ...customTokens(chain.id).map((t) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals })),
  ];
}

function useVault(session: Session, chain: Chain, safe: Address) {
  const [data, setData] = useState<VaultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const refresh = useCallback(() => setRound((r) => r + 1), []);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const rpc = session.rpc;
        const assets = assetsOf(chain);
        const [inspection, now] = await Promise.all([inspect(rpc, safe, blockHints(chain.id)), chainTime(rpc)]);
        const balances =
          inspection.state === "missing"
            ? assets.map(() => 0n)
            : await Promise.all(assets.map((a) => (a.token ? tokenBalance(rpc, a.token, safe).catch(() => 0n) : nativeBalance(rpc, safe))));
        const queue = inspection.state === "locked" || inspection.state === "unverified" ? await readQueue(rpc, inspection, txCache(chain.id, inspection.delay!)) : [];
        if (stale) return;
        setData({ inspection, queue, balances, assets, now, fetchedAt: Date.now() });
        setError(null);
      } catch (e) {
        if (!stale) setError(errorText(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [session.rpc, chain, safe, round]);

  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

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

/** A calendar file with "ready" and "collect it soon" for one waiting item. */
function saveReminders(chain: Chain, safe: Address, nonce: bigint, title: string, status: ItemStatus, now: bigint) {
  const base = `chronobox-${chain.short}-${safe.toLowerCase()}-${nonce}`;
  const reminders = [
    {
      uid: `${base}-ready@chronobox`,
      at: Number(status.readyAt),
      title: `Chronobox: ${title} is ready`,
      description: `The wait has ended. Open your Chronobox to finish it.\n${location.href}`,
      url: location.href,
    },
  ];
  if (status.expiresAt !== null) {
    const before = status.expiresAt - status.readyAt >= 172_800n ? 86_400n : (status.expiresAt - status.readyAt) / 2n;
    reminders.push({
      uid: `${base}-expires@chronobox`,
      at: Number(status.expiresAt - before),
      title: `Chronobox: ${title} expires soon`,
      description: `It expires on ${formatDate(status.expiresAt)}. After that you must ask again and wait again.\n${location.href}`,
      url: location.href,
    });
  }
  download(`${base}.ics`, calendarFile(reminders, Number(now)));
}

export function VaultPage(props: { session: Session; chain: Chain; safe: Address }) {
  const { session, chain, safe } = props;
  const { data, error, refresh } = useVault(session, chain, safe);
  const now = useChainClock(data);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [cancelling, setCancelling] = useState<QueueItem | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (data?.inspection.state === "locked") rememberVault({ chainId: chain.id, safe });
  }, [data?.inspection.state, chain.id, safe]);

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
  const vault: VaultRef | null = locked ? { safe, delay: inspection.delay!, controller: inspection.controller!, roles: inspection.roles } : null;
  const close = () => {
    setSheet(null);
    refresh();
  };

  const finish = (item: QueueItem) =>
    action.run(`finish-${item.nonce}`, async () => {
      await sendAndWait(session.rpc, session.account, executeTx(inspection.delay!, item.tx!));
      refresh();
    });
  const cancel = (item: QueueItem) =>
    action.run("cancel", async () => {
      await sendAndWait(session.rpc, session.account, cancelTx(inspection.roles!, inspection.delay!, item.nonce));
      setCancelling(null);
      refresh();
    });
  const remove = () =>
    action.run("remove", async () => {
      await sendAndWait(session.rpc, session.account, skipExpiredTx(inspection.delay!));
      refresh();
    });
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(safe);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The address is on the "Add money" sheet too, where it can be selected by hand.
    }
  };

  // What is inside: every asset with a balance. The first one is shown large.
  const held = assets.map((asset, i) => ({ asset, amount: balances[i] })).filter((h) => h.amount > 0n);
  const shown = held.length > 0 ? held : [{ asset: assets[0], amount: 0n }];
  const passed = inspection.checks.filter((c) => c.ok).length;
  const cancelIndex = cancelling ? queue.findIndex((q) => q.nonce === cancelling.nonce) : -1;

  return (
    <section class="page vault">
      <Status inspection={inspection} session={session} chain={chain} />

      {inspection.state !== "missing" ? (
        <div class="vault-main">
          <p class="eyebrow">Your Chronobox on {chain.name}</p>
          <ul class="balances">
            {shown.map((h) => (
              <li key={h.asset.token ?? "native"}>
                <span class="balance-amount">{formatAmount(h.amount, h.asset.decimals)}</span>
                <span class="balance-symbol">{h.asset.symbol}</span>
              </li>
            ))}
          </ul>
          {locked ? (
            <p class="vault-lock">
              <span class="dot" aria-hidden="true" />
              <span>
                Locked. Every withdrawal waits <b>{formatDuration(inspection.cooldown)}</b>.
              </span>
            </p>
          ) : null}
          {locked ? (
            <div class="vault-actions">
              <Button kind="primary" disabled={!verified} onClick={() => setSheet("deposit")}>
                Add money
              </Button>
              <Button disabled={!isController} onClick={() => setSheet("withdraw")}>
                Withdraw
              </Button>
            </div>
          ) : null}
          {locked && !isController ? (
            <p class="hint">
              You are looking at this Chronobox. Only the wallet <AddressText address={inspection.controller!} chain={chain} /> can withdraw.
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
                onRemove={remove}
                onCancel={canCancel ? () => setCancelling(item) : null}
              />
            ))}
          </ol>
          {action.error && !cancelling ? <Notice kind="bad">{action.error}</Notice> : null}
        </div>
      ) : null}

      {locked ? (
        <ul class="rows">
          <Row label="Delay" value={formatDuration(inspection.cooldown)} onClick={isController ? () => setSheet("delay") : undefined} />
          <Row label="Wallet" value={shortAddress(inspection.controller!)} onClick={isController ? () => setSheet("wallet") : undefined} />
          <Row label="Address" value={copied ? "Copied" : shortAddress(safe)} onClick={copyAddress} hint="Copy" />
          <Row
            label="Safety checks"
            value={verified ? `All ${passed} passed` : `${passed} of ${inspection.checks.length} passed`}
            onClick={() => setSheet("checks")}
          />
          <Row label="Get told" value="Calendar and alerts" onClick={() => setSheet("alerts")} />
          <Row label="Tokens" value="Add a token" onClick={() => setSheet("token")} />
        </ul>
      ) : inspection.checks.length > 0 ? (
        <ul class="rows">
          <Row label="Safety checks" value={`${passed} of ${inspection.checks.length} passed`} onClick={() => setSheet("checks")} />
        </ul>
      ) : null}

      {sheet === "withdraw" && vault ? (
        <WithdrawSheet session={session} chain={chain} vault={vault} inspection={inspection} assets={assets} balances={balances} queue={queue} canCancel={canCancel} onClose={close} />
      ) : null}
      {sheet === "deposit" ? (
        <Modal title="Add money" onClose={close}>
          <DepositPanel session={session} chain={chain} safe={safe} assets={assets} />
        </Modal>
      ) : null}
      {sheet === "delay" && vault ? <ChangeDelaySheet session={session} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "wallet" && vault ? <ChangeWalletSheet session={session} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
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
      {sheet === "alerts" ? <AlertsSheet chain={chain} safe={safe} onClose={close} /> : null}
      {cancelling && vault ? (
        <Modal title="Cancel this?" onClose={() => setCancelling(null)}>
          <p class="big-line">{describe(cancelling.tx ? classify(cancelling.tx, vault) : null, assets, {}).title}</p>
          <p>
            Nothing moves. Your money stays in the Chronobox.
            {cancelIndex > 0 ? ` Items wait in line, so this also cancels the ${cancelIndex === 1 ? "one" : cancelIndex} before it.` : ""}
          </p>
          {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
          <div class="modal-actions">
            <Button kind="primary" busy={action.busy === "cancel"} onClick={() => cancel(cancelling)}>
              Cancel it
            </Button>
            <Button kind="quiet" onClick={() => setCancelling(null)} disabled={!!action.busy}>
              Keep it
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

/** One line in the list under the balance. With an action it is a button. */
function Row(props: { label: string; value: ComponentChildren; hint?: string; onClick?: () => void }) {
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
        <button type="button" class="row" onClick={props.onClick}>
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
      <Notice kind="risk" title="This Chronobox is not locked yet. Do not send money.">
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

function describe(action: Action | null, assets: Asset[], tokens: Record<string, Asset>): { title: string; warning: string | null; finish: string } {
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
      };
    case "settings":
      return { title: action.label, warning: "This changes the Chronobox, and this app did not create it. If you did not ask for it, cancel it.", finish: "Apply now" };
    default:
      return { title: "Something this app cannot read", warning: "This app did not create it and cannot tell what it does. If you did not ask for it, cancel it.", finish: "Finish" };
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
    readToken(props.rpc, token).then((meta) => {
      if (meta && !stale) setTokens((t) => ({ ...t, [token.toLowerCase()]: { token, ...meta } }));
    });
    return () => {
      stale = true;
    };
  }, [token, known, props.rpc]);

  const { title, warning, finish } = describe(action, props.assets, tokens);
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
          <Button kind="primary" small busy={props.busy === `finish-${item.nonce}`} disabled={!!props.busy} onClick={props.onFinish}>
            {finish}
          </Button>
        ) : null}
        {status.phase === "expired" && props.first ? (
          <Button small busy={props.busy === "remove"} disabled={!!props.busy} onClick={props.onRemove}>
            Clear
          </Button>
        ) : null}
        {status.phase === "waiting" ? (
          <button type="button" class="link-button" onClick={() => saveReminders(props.chain, props.safe, item.nonce, title, status, now)}>
            Add to calendar
          </button>
        ) : null}
        {status.phase !== "expired" && props.onCancel ? (
          <button type="button" class="link-button" disabled={!!props.busy} onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </li>
  );
}

function WithdrawSheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  assets: Asset[];
  balances: bigint[];
  queue: QueueItem[];
  canCancel: boolean;
  onClose: () => void;
}) {
  const { session, vault, inspection, assets, balances } = props;
  const [assetIndex, setAssetIndex] = useState(0);
  const [amountText, setAmountText] = useState("");
  const [stage, setStage] = useState<"form" | "confirm" | "done">("form");
  const [agreed, setAgreed] = useState(false);
  const [queued, setQueued] = useState<{ nonce: bigint; at: bigint } | null>(null);
  const action = useAction();

  const asset = assets[assetIndex];
  // What earlier items in line will already take out.
  const reserved = useMemo(() => {
    let sum = 0n;
    for (const item of props.queue) {
      if (!item.tx) continue;
      const a = classify(item.tx, vault);
      if ((a.kind === "withdraw" || a.kind === "transfer-elsewhere") && (a.token === null ? asset.token === null : sameAddress(a.token, asset.token))) {
        sum += a.amount;
      }
    }
    return sum;
  }, [props.queue, asset, vault]);
  const available = balances[assetIndex] > reserved ? balances[assetIndex] - reserved : 0n;
  const amount = parseUnits(amountText, asset.decimals);
  const problem =
    amountText === ""
      ? null
      : amount === null
        ? "Enter a number."
        : amount === 0n
          ? "Enter more than zero."
          : amount > available
            ? `You can withdraw up to ${formatAmount(available, asset.decimals)} ${asset.symbol}.`
            : null;
  const delayText = formatDuration(inspection.cooldown);
  const amountLine = amount ? `${formatAmount(amount, asset.decimals)} ${asset.symbol}` : "";

  const submit = () =>
    action.run("queue", async () => {
      const tx = withdrawalTx(vault.controller, asset.token, amount!);
      const receipt = await sendAndWait(session.rpc, session.account, queueTx(vault.delay, tx));
      const cache = txCache(props.chain.id, vault.delay);
      const added = queuedInReceipt(receipt, vault.delay);
      for (const one of added) cache.set(one.nonce, delayTxHash(one.tx), one.tx);
      setQueued({ nonce: added[0]?.nonce ?? inspection.queueNonce, at: await chainTime(session.rpc) });
      setStage("done");
    });

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
          <Button kind="quiet" onClick={() => saveReminders(props.chain, vault.safe, queued.nonce, `Withdraw ${amountLine}`, status, queued.at)}>
            Add to calendar
          </Button>
        </div>
      </Modal>
    );
  }

  if (stage === "confirm") {
    return (
      <Modal title={`Withdraw ${amountLine}`} onClose={props.onClose}>
        <div class="delay-callout">
          <span class="delay-callout-label">This takes</span>
          <span class="delay-callout-value">{delayText}</span>
        </div>
        <ul class="plain-list">
          <li>Nobody can make it faster. No password, no threat, no stolen key. Not even you.</li>
          {props.canCancel ? <li>You can cancel it while it waits.</li> : null}
          <li>
            Then it goes to your wallet <AddressText address={vault.controller} />.
          </li>
        </ul>
        <Choice role="checkbox" on={agreed} title={`I will wait ${delayText}.`} onClick={() => setAgreed(!agreed)} disabled={!!action.busy} />
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
        onMax={() => setAmountText(formatUnits(available, asset.decimals))}
      />
      {problem ? (
        <p class="field-error">{problem}</p>
      ) : (
        <p class="hint">
          It goes to your wallet <AddressText address={vault.controller} />, after {delayText}.
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

function ChangeDelaySheet(props: { session: Session; vault: VaultRef; inspection: Inspection; canCancel: boolean; onClose: () => void }) {
  const { session, vault, inspection } = props;
  const [choice, setChoice] = useState<bigint | null>(null);
  const [done, setDone] = useState(false);
  const action = useAction();
  const now = formatDuration(inspection.cooldown);
  const submit = () =>
    action.run("queue", async () => {
      await sendAndWait(session.rpc, session.account, queueTx(vault.delay, changeDelayTx(vault.delay, choice!)));
      setDone(true);
    });
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
      onClose={props.onClose}
    >
      <div class="wiz-list" role="radiogroup" aria-label="New delay">
        {DELAY_CHOICES.filter((c) => c.seconds !== inspection.cooldown).map((c) => (
          <Choice key={c.label} role="radio" on={choice === c.seconds} title={c.label} disabled={!!action.busy} onClick={() => setChoice(c.seconds)} />
        ))}
      </div>
      {choice !== null && choice < inspection.cooldown ? <p class="hint">A shorter delay gives you less time to notice a withdrawal that you did not ask for.</p> : null}
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={choice === null} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
      </div>
    </Modal>
  );
}

function ChangeWalletSheet(props: { session: Session; vault: VaultRef; inspection: Inspection; canCancel: boolean; onClose: () => void }) {
  const { session, vault, inspection } = props;
  const [text, setText] = useState("");
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const next = parseAddress(text);
  const tx = next ? changeWalletTx(vault.delay, vault.controller, next, vault.roles ?? null) : null;
  const problem = text.trim() === "" ? null : !next ? "This is not a wallet address." : !tx ? "Enter a wallet other than this one." : null;
  const wait = formatDuration(inspection.cooldown);
  const submit = () =>
    action.run("queue", async () => {
      await sendAndWait(session.rpc, session.account, queueTx(vault.delay, tx!));
      setDone(true);
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(vault.safe);
      setCopied(true);
    } catch {
      // The address is on screen and can be selected by hand.
    }
  };
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
      <Choice
        role="checkbox"
        on={sure}
        title="I checked the address, and I hold its key."
        text="If it is wrong, the money in this Chronobox is gone."
        disabled={!!action.busy}
        onClick={() => setSure(!sure)}
      />
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
      const meta = await readToken(props.session.rpc, address);
      if (!meta) throw new Error(`There is no token at this address on ${props.chain.name}.`);
      addCustomToken(props.chain.id, { address, ...meta });
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
