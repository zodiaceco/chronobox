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
import { addCustomToken, blockHints, pendingSwap, rememberVault, setPendingSwap, txCache } from "../lib/store.ts";
import {
  type Action,
  type Inspection,
  type ItemStatus,
  type QueueItem,
  type SwapRequest,
  cancelAllTx,
  cancelTx,
  changeDelayTx,
  changeWalletTx,
  delayNonces,
  chainTime,
  classify,
  councilCompatible,
  executeTx,
  inspect,
  isForeign,
  itemStatus,
  queuedInReceipt,
  queueLength,
  readQueue,
  readRecoveryLine,
  type RecoveryItem,
  councilOwnersNow,
  recoveryDelayCreateTx,
  readBalances,
  readToken,
  sendAndWait,
  skipExpiredTx,
  withdrawalTx,
  Replaced,
  StoppedWaiting,
  receiptTime,
  MAX_COOLDOWN,
  MIN_COOLDOWN,
  QUEUE_PAGE,
} from "../lib/chronobox.ts";
import { errorText } from "../lib/wallet.ts";
import { ALERTS, ALERTS_ROW, AlertsSheet } from "./alerts.tsx";
import { AddressText, type Asset, AssetAmount, assetsOf, Button, copyText, Choice, Modal, Notice, type Session, SlowNote, useAction } from "./common.tsx";
import { SunPassArt } from "./art.tsx";
import { Ring } from "./ring.tsx";
import { LookupSheet, OwnerHoldings } from "./holdings.tsx";
import { lookupAllowed } from "../lib/store.ts";
import { DepositPanel } from "./deposit.tsx";
import { AgreeSheet, AskGuardianSheet, GuardianSheet, prepareSwap } from "./guardian.tsx";
import { RecoverySection, type RecoveryWaiting, guarded } from "./recovery.tsx";
import { UnknownSheet, type VaultRef, queueItem } from "./queue.tsx";
import { RowIcon, type RowIconName } from "./row-icons.tsx";

type VaultData = {
  /** The network and the Chronobox this was read for. */
  key: string;
  inspection: Inspection;
  /** The front of the line, oldest first: at most QUEUE_PAGE items. `queueLength(inspection)` is how many wait. */
  queue: QueueItem[];
  /** "reading" while the items are looked up. The page does not wait for them: cancel needs none of it. */
  queueRead: "reading" | "done" | "failed";
  /** Null where the balance could not be read. That is "not known", never "nothing". */
  balances: (bigint | null)[];
  /** False until the balances were read once. Until then, a null is "not read yet". */
  balancesRead: boolean;
  /** False when the long list of tokens could not be read, and only the main ones were. */
  allRead: boolean;
  assets: Asset[];
  /** What waits in the line of the recovery. Usually nothing. */
  recoveryLine: RecoveryItem[];
  /** "reading" while recovery items are looked up, "failed" when the RPC could not read them. */
  recoveryRead: "reading" | "done" | "failed";
  now: bigint;
  fetchedAt: number;
};

type Sheet = "withdraw" | "deposit" | "token" | "delay" | "wallet" | "guardian" | "checks" | "alerts" | "lookup" | null;

/** The parts of a locked Chronobox, in the form that the builders want. */
function vaultOf(safe: Address, inspection: Inspection): VaultRef {
  return {
    safe,
    delay: inspection.delay!,
    controller: inspection.controller!,
    roles: inspection.roles,
    guardian: inspection.guardian,
    council: inspection.council,
    members: inspection.members,
    recoveryDelay: inspection.recoveryDelay,
    recoveryOn: inspection.recovery !== null,
    councilRecovery: inspection.councilRecovery,
  };
}

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
    const key = `${chain.id}:${safe}`.toLowerCase();
    // Every part that arrives is shown at once. Nothing waits for the slowest part.
    const publish = (patch: Partial<VaultData>) => {
      if (stale || !last.current || last.current.key !== key) return;
      const next = { ...last.current, ...patch };
      last.current = next;
      setData(next);
    };
    (async () => {
      try {
        const rpc = session.rpc;
        const assets = assetsOf(chain);
        // The balances do not depend on the checks. Their read starts now, next to the checks, and not after them.
        const early = readBalances(rpc, safe, assets).catch(() => null);
        let [inspection, now] = await Promise.all([inspect(rpc, safe, blockHints(chain.id)), chainTime(rpc)]);
        // A check that passed a moment ago and cannot run now is asked once more before the page says so.
        if (last.current?.key === key && last.current.inspection.state === "locked" && inspection.state !== "locked") {
          inspection = await inspect(rpc, safe, blockHints(chain.id)).catch(() => inspection);
        }
        if (stale) return;
        const before = last.current?.key === key ? last.current : null;
        const readsQueue = inspection.state === "locked" || inspection.state === "unverified";
        // A queued item never changes. What was read before and is still at the front of the line
        // stays on the page while the line is read again, so a cancel that is being asked for does not lose its item.
        const end = inspection.txNonce + BigInt(QUEUE_PAGE);
        const kept =
          readsQueue && before && sameAddress(before.inspection.delay, inspection.delay)
            ? before.queue.filter((item) => item.nonce >= inspection.txNonce && item.nonce < inspection.queueNonce && item.nonce < end)
            : [];
        const missing = inspection.state === "missing";
        const rec = inspection.recovery;
        const hasRecoveryItems = !!rec && rec.queueNonce > rec.txNonce;
        const keptRecovery =
          hasRecoveryItems && before && sameAddress(before.inspection.recovery?.delay, rec.delay)
            ? before.recoveryLine.filter((item) => item.nonce >= rec.txNonce && item.nonce < rec.queueNonce)
            : [];
        const next: VaultData = {
          key,
          inspection,
          queue: kept,
          queueRead: readsQueue ? "reading" : "done",
          balances: missing ? assets.map((): bigint | null => 0n) : (before?.balances ?? assets.map(() => null)),
          balancesRead: missing || (before?.balancesRead ?? false),
          allRead: missing || (before?.allRead ?? true),
          assets,
          // What was read before stays until the new read is there. Without a recovery the line is empty.
          recoveryLine: keptRecovery,
          recoveryRead: hasRecoveryItems ? "reading" : "done",
          now,
          fetchedAt: Date.now(),
        };
        last.current = next;
        setData(next);
        setError(null);

        const balances = missing
          ? Promise.resolve()
          : early.then((read) => (read ? publish({ balances: read.balances, allRead: read.complete, balancesRead: true }) : publish({ balancesRead: true, allRead: false })));
        const queue = readsQueue
          ? readQueue(rpc, inspection, txCache(chain.id, inspection.delay!), {
              known: kept,
              // The front of the line first. Items read before stay until their turn comes.
              onItems: (items) => publish({ queue: [...items, ...kept.filter((item) => item.nonce > items[items.length - 1].nonce)] }),
            }).then(
              (queue) => publish({ queue, queueRead: "done" }),
              () => publish({ queueRead: "failed" }),
            )
          : Promise.resolve();
        // Each item is read back and compared with the recovery that this app builds, so the page can say where it leads.
        const guard = hasRecoveryItems && inspection.delay && inspection.controller ? guarded(vaultOf(safe, inspection)) : null;
        const recoveryLine = guard && rec
          ? councilOwnersNow(rpc, guard, inspection.councilMade)
              .then((owners) => readRecoveryLine(rpc, guard, owners, txCache(chain.id, rec.delay), { known: keptRecovery }))
              .then(
                (line) => publish({ recoveryLine: line, recoveryRead: "done" }),
                () => publish({ recoveryRead: "failed" }),
              )
          : Promise.resolve();
        await Promise.all([balances, queue, recoveryLine]);
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

/** Chain time in seconds, advanced by the local clock between reads. Only ticks while something is waiting. */
function useChainClock(data: VaultData | null): bigint {
  const [, setBeat] = useState(0);
  const active = (data?.queue.length ?? 0) > 0 || (data?.recoveryLine.length ?? 0) > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setBeat((b) => b + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
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

export function VaultPage(props: { session: Session; chain: Chain; safe: Address; swap?: { to: Address; upTo: bigint | null } | null }) {
  const { session, chain, safe } = props;
  const { data, error, refresh } = useVault(session, chain, safe);
  const now = useChainClock(data);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [depositBusy, setDepositBusy] = useState(false);
  const [cancelling, setCancelling] = useState<QueueItem | null>(null);
  // Counts the times third-party services were switched: the list then reads again.
  const [lookupRound, setLookupRound] = useState(0);
  // What was cancelled a moment ago, and how much of its wait was still ahead: for the sheet that shows the cancel.
  const [cancelled, setCancelled] = useState<{ title: string; left: number; count: number } | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [copied, setCopied] = useState(false);
  // Finishing and clearing share one state. Cancel has its own: it is the emergency action, and
  // nothing else that is pending may block it.
  const action = useAction();
  const cancelAction = useAction();
  const [confirming, setConfirming] = useState<QueueItem | null>(null);
  // A link from the owner can ask the guardian to agree to a new wallet. The sheet opens once.
  const [agreeing, setAgreeing] = useState(props.swap ?? null);
  const sending = { chainId: chain.id, chainName: chain.name };
  const line = useRef<QueueItem[]>([]);
  line.current = data?.queue ?? [];

  useEffect(() => {
    // It is remembered for the wallet that is its key, so it shows in that wallet's list only.
    if (data?.inspection.state !== "locked" || !data.inspection.controller) return;
    // A guardian finds it in the list of the guardian's own wallet. On the guardian's device, that is the wallet to remember.
    const asGuardian = sameAddress(data.inspection.guardian, session.account);
    rememberVault({ chainId: chain.id, safe, wallet: asGuardian ? session.account : data.inspection.controller });
  }, [data?.inspection.state, data?.inspection.controller, data?.inspection.guardian, session.account, chain.id, safe]);

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
  // The guardian: a second wallet that can stop what waits, and nothing else alone.
  const isGuardian = locked && !isController && sameAddress(inspection.guardian, session.account);
  const canCancel = (isController || isGuardian) && !!inspection.roles;
  // Another wallet is the key. This wallet can look, and nothing else.
  const viewOnly = locked && !isController && !isGuardian;
  const vault: VaultRef | null = locked ? vaultOf(safe, inspection) : null;
  // A recovery change that is in the line and has not started yet.
  const queued = vault ? queue.map((item) => (item.tx ? classify(item.tx, vault) : null)) : [];
  const setting = queued.find((a): a is Extract<Action, { kind: "set-recovery" }> => a?.kind === "set-recovery");
  const recoveryWaiting: RecoveryWaiting = setting ? { kind: "set", wait: setting.wait } : queued.some((a) => a?.kind === "remove-recovery") ? { kind: "remove" } : null;
  const recovery = locked ? inspection.recovery : null;
  const recoveryLine = recovery ? data.recoveryLine : [];
  const recoveryWaitingCount = recovery && recovery.queueNonce > recovery.txNonce ? recovery.queueNonce - recovery.txNonce : 0n;
  const role = isController ? "owner" : isGuardian ? "guardian" : "viewer";
  // What the row "Guardian" says about the recovery, under the guardian's address.
  const recoveryNote = !inspection.guardian
    ? null
    : recoveryWaitingCount > 0n
      ? "A recovery waits"
      : recoveryWaiting?.kind === "set" && !recovery
        ? "Recovery goes on soon"
        : recoveryWaiting?.kind === "remove"
          ? "Recovery goes off soon"
          : recovery
            ? `Can recover after ${formatDuration(recovery.wait)}`
            : null;
  // A guardian that is in the line and has not started yet.
  const adding = queued.find((a): a is Extract<Action, { kind: "add-guardian" }> => a?.kind === "add-guardian") ?? null;
  const guardianWaiting = adding?.guardian ?? null;
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
        // A step that turns a recovery on needs the recovery Delay. It is made when the step is asked for. If it is still missing, it is made now.
        const step = vault && item.tx ? classify(item.tx, vault) : null;
        const needsDelay = step?.kind === "set-recovery" || (step?.kind === "add-guardian" && step.recoveryWait !== undefined);
        if (needsDelay && inspection.recoveryDelay && !inspection.recoveryDelay.deployed) {
          const code = (await session.rpc("eth_getCode", [inspection.recoveryDelay.delay, "latest"])) as string;
          if (typeof code !== "string" || code.length <= 2) {
            try {
              await sendAndWait(session.rpc, session.account, recoveryDelayCreateTx(safe), { ...sending, ...waiting });
            } catch (err) {
              if (err instanceof Replaced) {
                const after = (await session.rpc("eth_getCode", [inspection.recoveryDelay.delay, "latest"])) as string;
                if (typeof after !== "string" || after.length <= 2) throw err;
              } else {
                throw err;
              }
            }
          }
        }
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
        const index = queue.findIndex((q) => q.nonce === item.nonce);
        const title = describe(item.tx && vault ? classify(item.tx, vault) : null, assets, {}, Boolean(vault?.recoveryOn)).title;
        const left = 1 - Math.max(0, Math.min(1, Number(now - item.createdAt) / Number(inspection.cooldown || 1n)));
        await sendAndWait(session.rpc, session.account, cancelTx(inspection.roles!, inspection.delay!, item.nonce), { ...sending, ...waiting });
        setCancelling(null);
        setCancelled({ title, left, count: index + 1 });
      } finally {
        refresh();
      }
    });
  // The whole line as the last read saw it. It needs no item to be read: a line too long to
  // read, or a network that cannot look the items up, does not keep the stop out of reach.
  const cancelAll = () =>
    cancelAction.run("cancel", async (waiting) => {
      const tx = cancelAllTx(inspection.roles!, inspection.delay!, inspection);
      if (!tx) return setCancellingAll(false);
      try {
        await sendAndWait(session.rpc, session.account, tx, { ...sending, ...waiting });
        setCancellingAll(false);
      } finally {
        refresh();
      }
    });
  const askCancelAll = () => {
    cancelAction.clearError();
    setConfirming(null);
    setCancelling(null);
    setCancellingAll(true);
  };
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
  const shown: { asset: Asset; amount: bigint | null }[] = held.length > 0 ? held : [{ asset: assets[0], amount: data.balancesRead ? (balances[0] ?? 0n) : null }];
  // Until the balances are read once, a missing one is "not read yet", not "could not be read".
  const unread = data.balancesRead ? assets.filter((a, i) => a.main && balances[i] === null).map((a) => a.symbol) : [];
  // The item in the line that a dialog is about may be gone by now.
  const cancelItem = cancelling ? (queue.find((q) => q.nonce === cancelling.nonce) ?? null) : null;
  const confirmItem = confirming ? (queue.find((q) => q.nonce === confirming.nonce) ?? null) : null;
  const passed = inspection.checks.filter((c) => c.ok).length;
  const cancelIndex = cancelling ? queue.findIndex((q) => q.nonce === cancelling.nonce) : -1;
  // How many wait, from the two numbers of the inspection. The items are read separately, and only the front of the line.
  const waitingCount = locked ? queueLength(inspection) : 0n;
  const unshown = waitingCount - BigInt(queue.length);

  return (
    <section class="page vault">
      <Status inspection={inspection} session={session} chain={chain} />
      {vault ? (
        <ForeignAlarm
          queue={queue}
          vault={vault}
          inspection={inspection}
          assets={assets}
          now={now}
          canCancel={canCancel}
          stops={isGuardian}
          onCancel={(nonce) => {
            const item = queue.find((q) => q.nonce === nonce);
            if (item) askCancel(item);
          }}
        />
      ) : null}
      {props.swap && vault && !isGuardian && inspection.guardian && !sameAddress(props.swap.to, inspection.controller) ? (
        <Notice kind="info" title="This link is for the guardian.">
          It asks the guardian <AddressText address={inspection.guardian} /> to agree to moving this Chronobox to{" "}
          <AddressText address={props.swap.to} />. Connect that wallet to answer it.
        </Notice>
      ) : null}
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
          {isGuardian ? (
            <p class="view-only guardian-tag">
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                <path d="M10 1.8l6.5 2.4v5c0 4-2.7 7.2-6.5 8.9-3.8-1.7-6.5-4.9-6.5-8.9v-5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
              </svg>
              You are the guardian
            </p>
          ) : null}
          {isController ? (
            // The owner sees one list: what the wallet holds (unlocked) next to what the Chronobox holds (locked).
            <OwnerHoldings session={session} chain={chain} safe={safe} boxBase={data.balancesRead ? balances : null} round={lookupRound} onLookup={() => setSheet("lookup")} />
          ) : (
            <>
              <p class="eyebrow">{`A Chronobox on ${chain.name}`}</p>
              <ul class="balances">
                {shown.map((h) => (
                  <li key={h.asset.token ?? "native"}>
                    <span class="balance-amount">{h.amount === null ? "…" : formatAmount(h.amount, h.asset.decimals)}</span>
                    <span class="balance-symbol">{h.asset.symbol}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {unread.length > 0 ? <p class="hint">The balance of {unread.join(", ")} could not be read now. It is not shown, and it is not gone.</p> : null}
          {unread.length === 0 && data.balancesRead && !data.allRead ? <p class="hint">Only the main tokens could be read now. Other tokens are not shown, and they are not gone.</p> : null}
          {locked ? (
            <p class="vault-lock">
              <span class="dot" aria-hidden="true" />
              <span>
                Every withdrawal waits <b>{formatDuration(inspection.cooldown)}</b>.
              </span>
            </p>
          ) : null}
          {/* A guardian is here to watch and to stop. Adding money is not the guardian's job, so the button is not the first thing on the page. */}
          {locked && !isGuardian ? (
            <div class={isController ? "vault-actions" : "vault-actions vault-actions-one"}>
              <Button kind={isController ? "primary" : "plain"} disabled={!verified} onClick={() => setSheet("deposit")}>
                Add money
              </Button>
              {isController ? <Button onClick={() => setSheet("withdraw")}>Withdraw</Button> : null}
            </div>
          ) : null}
          {viewOnly ? (
            <p class="hint">
              The key of this Chronobox is the wallet <AddressText address={inspection.controller!} />. Your wallet can look and add money. It cannot withdraw.
            </p>
          ) : null}
          {isGuardian ? (
            <p class="hint">
              When a withdrawal waits here, call the owner. If you cannot reach them, or they did not ask for it, stop it. You cannot withdraw.
              {recovery ? ' If the owner has lost the wallet, start a recovery under "Guardian".' : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {vault && recovery && recoveryWaitingCount > 0n ? (
        <RecoverySection
          session={session}
          chain={chain}
          vault={vault}
          recovery={recovery}
          items={recoveryLine}
          waitingCount={recoveryWaitingCount}
          readState={data.recoveryRead}
          now={now}
          role={role}
          onChanged={refresh}
        />
      ) : null}

      {vault && waitingCount > 0n ? (
        <div class="section">
          <h2>Waiting</h2>
          {unshown > 0n ? (
            <div class="queue-more" role="status">
              <p class="hint">
                {queueNote(data.queueRead, queue.length, unshown)}
                {canCancel && unshown > 1n ? ` ${isGuardian ? "You can stop" : "You can cancel"} everything that waits without reading it first.` : ""}
              </p>
              {canCancel ? (
                <Button kind={data.queueRead === "reading" && queue.length === 0 && waitingCount <= BigInt(QUEUE_PAGE) ? "plain" : "primary"} onClick={askCancelAll}>
                  {waitingCount === 1n ? (isGuardian ? "Stop it" : "Cancel it") : `${isGuardian ? "Stop" : "Cancel"} all ${waitingCount}`}
                </Button>
              ) : null}
            </div>
          ) : null}
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
                recoveryOn={Boolean(vault.recoveryOn)}
                assets={assets}
                chain={chain}
                safe={safe}
                rpc={session.rpc}
                busy={action.busy}
                onFinish={() => finish(item)}
                onFinishFlagged={() => setConfirming(item)}
                onRemove={remove}
                onCancel={canCancel ? () => askCancel(item) : null}
                cancelLabel={isGuardian ? "Stop it" : "Cancel"}
              />
            ))}
          </ol>
          <SlowNote action={action} />
          {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        </div>
      ) : null}

      {locked ? (
        <ul class="rows">
          <Row icon="address" label="Address" value={copied ? "Copied" : shortAddress(safe)} onClick={copyAddress} hint="Copy" strong />
          <Row icon="delay" label="Delay" value={formatDuration(inspection.cooldown)} onClick={isController ? () => setSheet("delay") : undefined} />
          <Row
            icon="wallet"
            label="Wallet"
            value={isController ? (inspection.guardian && pendingSwap(chain.id, safe) ? "Asking your guardian" : shortAddress(inspection.controller!)) : <AddressText address={inspection.controller!} />}
            onClick={isController ? () => setSheet("wallet") : undefined}
          />
          {inspection.roles ? (
            <Row
              icon="guardian"
              label="Guardian"
              value={
                <>
                  {isGuardian ? "You" : inspection.guardian ? shortAddress(inspection.guardian) : guardianWaiting ? "Starts soon" : isController ? "Add" : "None"}
                  {recoveryNote ? <small class="row-sub">{recoveryNote}</small> : null}
                </>
              }
              onClick={isController || inspection.guardian ? () => setSheet("guardian") : undefined}
            />
          ) : null}
          <Row
            icon="checks"
            label="Safety checks"
            value={verified ? `All ${passed} passed` : `${passed} of ${inspection.checks.length} passed`}
            onClick={() => setSheet("checks")}
          />
          {ALERTS ? <Row icon="alerts" label="Get told" value={ALERTS_ROW} onClick={() => setSheet("alerts")} /> : null}
          <Row icon="tokens" label="Tokens" value="Add a token" onClick={() => setSheet("token")} />
          {isController && chain.indexer ? <Row icon="checks" label="Third-party services" value={lookupAllowed() ? "On" : "Off"} onClick={() => setSheet("lookup")} /> : null}
        </ul>
      ) : inspection.checks.length > 0 ? (
        <ul class="rows">
          <Row icon="checks" label="Safety checks" value={`${passed} of ${inspection.checks.length} passed`} onClick={() => setSheet("checks")} />
        </ul>
      ) : null}

      {sheet === "withdraw" && vault ? (
        <WithdrawSheet session={session} chain={chain} vault={vault} inspection={inspection} assets={assets} balances={balances} queue={queue} partial={unshown > 0n} now={now} canCancel={canCancel} onClose={close} />
      ) : null}
      {sheet === "deposit" ? (
        <Modal title="Add money" busy={depositBusy} onClose={close}>
          <DepositPanel session={session} chain={chain} safe={safe} assets={assets} onSent={refresh} onBusy={setDepositBusy} />
        </Modal>
      ) : null}
      {sheet === "delay" && vault ? <ChangeDelaySheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "wallet" && vault ? <ChangeWalletSheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "guardian" && vault ? (
        <GuardianSheet
          session={session}
          chain={chain}
          vault={vault}
          inspection={inspection}
          role={role}
          waiting={guardianWaiting}
          waitingRecovery={adding?.recoveryWait ?? null}
          recoveryWaiting={recoveryWaiting}
          recoveryStarted={recoveryWaitingCount > 0n}
          onClose={close}
        />
      ) : null}
      {agreeing && vault && isGuardian && sheet === null ? (
        <AgreeSheet
          session={session}
          chain={chain}
          vault={vault}
          request={agreeing}
          onClose={() => {
            setAgreeing(null);
            refresh();
          }}
        />
      ) : null}
      {sheet === "token" ? <TokenSheet session={session} chain={chain} onClose={close} /> : null}
      {sheet === "lookup" ? <LookupSheet chain={chain} onClose={() => setSheet(null)} onChanged={() => setLookupRound((r) => r + 1)} onAddToken={() => setSheet("token")} /> : null}
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
      {cancelled ? (
        <Modal title={isGuardian ? "Stopped." : "Cancelled."} onClose={() => setCancelled(null)}>
          <div class="cancel-ring">
            <Ring size={96} left={cancelled.left} play="cancel" />
          </div>
          <p class="big-line">{cancelled.count > 1 ? `${cancelled.title}, and ${cancelled.count - 1} before it` : cancelled.title}</p>
          <p>Nothing moved. The money stays in the Chronobox.</p>
          <div class="modal-actions">
            <Button kind="primary" onClick={() => setCancelled(null)}>
              Done
            </Button>
          </div>
        </Modal>
      ) : null}
      {cancelling && vault ? (
        <Modal
          title={cancelIndex > 0 ? `${isGuardian ? "Stop" : "Cancel"} ${cancelIndex + 1} items?` : isGuardian ? "Stop this?" : "Cancel this?"}
          busy={cancelAction.busy !== null && !cancelAction.slow}
          onClose={() => setCancelling(null)}
        >
          {cancelItem ? (
            <>
              {cancelIndex > 0 ? (
                <>
                  {/* A cancel takes an item and everything in front of it. So the whole line is shown, with what goes and what stays. */}
                  <p>
                    The time delay keeps one line. A {isGuardian ? "stop" : "cancel"} takes an item <b>and everything in front of it</b>.
                  </p>
                  <ol class="cancel-line">
                    {queue.map((item, index) => {
                      const goes = index <= cancelIndex;
                      const ready = itemStatus(item, inspection.cooldown, inspection.expiration, now).phase === "ready";
                      return (
                        <li key={String(item.nonce)} class={goes ? "cancel-row cancel-row-out" : "cancel-row"}>
                          <span class="cancel-mark" aria-hidden="true">
                            {goes ? "\u00d7" : ""}
                          </span>
                          <span class="cancel-what">
                            <strong>{describe(item.tx ? classify(item.tx, vault) : null, assets, {}, Boolean(vault.recoveryOn)).title}</strong>
                            <small>{index === cancelIndex ? "The one you chose" : goes ? (ready ? "In front of it, and ready" : "In front of it") : "Behind it: stays in line"}</small>
                          </span>
                          <span class={goes ? "cancel-tag cancel-tag-out" : "cancel-tag"}>{goes ? (isGuardian ? "Stopped" : "Cancelled") : "Stays"}</span>
                        </li>
                      );
                    })}
                  </ol>
                  {queue.slice(0, cancelIndex).some((item) => itemStatus(item, inspection.cooldown, inspection.expiration, now).phase === "ready") ? (
                    <Notice kind="risk" title="Something in front of it is ready.">
                      Finish it first if you want it. Otherwise it is cancelled too.
                    </Notice>
                  ) : null}
                  <p class="hint">
                    {isGuardian ? "Nothing moves. The money stays in the Chronobox, and the owner can ask again." : "Nothing moves. Your money stays in the Chronobox."}
                  </p>
                </>
              ) : (
                <>
                  <p class="big-line">{describe(cancelItem.tx ? classify(cancelItem.tx, vault) : null, assets, {}, Boolean(vault.recoveryOn)).title}</p>
                  <p>{isGuardian ? "Nothing moves. The money stays in the Chronobox, and the owner can ask again." : "Nothing moves. Your money stays in the Chronobox."}</p>
                </>
              )}
              <SlowNote action={cancelAction} />
              {cancelAction.error ? <Notice kind="bad">{cancelAction.error}</Notice> : null}
              <div class="modal-actions">
                <Button kind="primary" busy={cancelAction.busy === "cancel"} onClick={() => cancel(cancelItem)}>
                  {cancelIndex > 0 ? `${isGuardian ? "Stop" : "Cancel"} these ${cancelIndex + 1}` : isGuardian ? "Stop it" : "Cancel it"}
                </Button>
                <Button kind="quiet" onClick={() => setCancelling(null)} disabled={!!cancelAction.busy}>
                  {isGuardian ? (cancelIndex > 0 ? "Let them wait" : "Let it wait") : cancelIndex > 0 ? "Keep them" : "Keep it"}
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
      {cancellingAll && vault ? (
        <Modal title={isGuardian ? "Stop everything that waits?" : "Cancel everything that waits?"} busy={cancelAction.busy !== null && !cancelAction.slow} onClose={() => setCancellingAll(false)}>
          {waitingCount > 0n ? (
            <>
              <p class="big-line">{waitingCount === 1n ? "1 item" : `${waitingCount} items`}</p>
              <p>
                {waitingCount === 1n ? "This cancels it" : `This cancels all ${waitingCount}`}
                {unshown > 0n ? ", also what is not shown here. " : ". "}
                {isGuardian ? "Nothing moves. The money stays in the Chronobox, and the owner can ask again." : "Nothing moves. Your money stays in the Chronobox."}
              </p>
              <SlowNote action={cancelAction} />
              {cancelAction.error ? <Notice kind="bad">{cancelAction.error}</Notice> : null}
              <div class="modal-actions">
                <Button kind="primary" busy={cancelAction.busy === "cancel"} onClick={cancelAll}>
                  {isGuardian ? "Stop all" : "Cancel all"}
                </Button>
                <Button kind="quiet" onClick={() => setCancellingAll(false)} disabled={!!cancelAction.busy}>
                  {isGuardian ? "Let it wait" : "Keep it"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>Nothing waits any more. It was cancelled or carried out already.</p>
              <div class="modal-actions">
                <Button kind="primary" onClick={() => setCancellingAll(false)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
      {confirming && vault ? (
        <Modal title="Carry this out?" onClose={() => setConfirming(null)}>
          {confirmItem ? (
            <>
              <p class="big-line">{describe(confirmItem.tx ? classify(confirmItem.tx, vault) : null, assets, {}, Boolean(vault.recoveryOn)).title}</p>
              <Notice kind="risk">{describe(confirmItem.tx ? classify(confirmItem.tx, vault) : null, assets, {}, Boolean(vault.recoveryOn)).warning}</Notice>
              <div class="modal-actions">
                {canCancel ? (
                  <Button kind="primary" onClick={() => askCancel(confirmItem)}>
                    Cancel it
                  </Button>
                ) : null}
                <Button
                  kind="quiet"
                  onClick={() => {
                    const item = confirmItem;
                    setConfirming(null);
                    finish(item);
                  }}
                >
                  Carry it out
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>This item is not in the line any more. It was cancelled or carried out already.</p>
              <div class="modal-actions">
                <Button kind="primary" onClick={() => setConfirming(null)}>
                  Close
                </Button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </section>
  );
}

/** What the page says about the items of the line that it does not show. */
function queueNote(read: VaultData["queueRead"], shown: number, unshown: bigint): string {
  const items = (n: bigint) => (n === 1n ? "1 item" : `${n} items`);
  const more = shown > 0 ? `${items(unshown)} more` : items(unshown);
  if (read === "reading") return shown > 0 ? `Reading ${more}…` : `${more} ${unshown === 1n ? "waits" : "wait"}. Reading what ${unshown === 1n ? "it does" : "they do"}…`;
  if (read === "failed") return `${more} could not be read now.`;
  return `${more} ${unshown === 1n ? "waits" : "wait"} after these. Only the first ${shown} are shown.`;
}

/** One line in the list under the balance. With an action it is a button. */
/** `strong` marks the one row that people come for: the address of the Chronobox. */
function Row(props: { label: string; value: ComponentChildren; icon?: RowIconName; hint?: string; onClick?: () => void; strong?: boolean }) {
  const kind = `row${props.icon ? " row-with-icon" : ""}${props.strong ? " row-strong" : ""}`;
  const inner = (
    <>
      {props.icon ? <RowIcon name={props.icon} /> : null}
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
        <button type="button" class={kind} onClick={props.onClick}>
          {inner}
        </button>
      ) : (
        <div class={kind}>{inner}</div>
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
function describe(
  action: Action | null,
  assets: Asset[],
  tokens: Record<string, Asset>,
  recoveryOn = false,
): { title: string; warning: string | null; finish: string; flagged?: boolean } {
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
    case "add-guardian":
      return action.recoveryWait === undefined
        ? { title: `Add the guardian ${shortAddress(action.guardian)}`, warning: `After this, the wallet ${action.guardian} can stop every withdrawal.`, finish: "Apply now" }
        : {
            title: `Add the guardian ${shortAddress(action.guardian)}, with a recovery`,
            warning: `After this, the wallet ${action.guardian} can stop every withdrawal. It can also start a recovery: after ${formatDuration(action.recoveryWait)}, a wallet that the guardian chooses holds this Chronobox, unless the owner stops it.`,
            finish: "Apply now",
          };
    case "remove-guardian":
      return {
        title: "Remove the guardian",
        warning: recoveryOn
          ? "After this, only the wallet of this Chronobox can cancel a withdrawal, and the recovery turns off too."
          : "After this, only the wallet of this Chronobox can cancel a withdrawal.",
        finish: "Apply now",
      };
    case "set-recovery":
      return recoveryOn
        ? {
            title: `Change the recovery wait to ${formatDuration(action.wait)}`,
            warning: `After this, a recovery waits ${formatDuration(action.wait)}.`,
            finish: "Apply now",
          }
        : {
            title: `Let the guardian recover after ${formatDuration(action.wait)}`,
            warning: `After this, the guardian can start a recovery. A recovery waits ${formatDuration(action.wait)}. Then a wallet that the guardian chooses holds this Chronobox, unless the owner stops it.`,
            finish: "Apply now",
          };
    case "remove-recovery":
      return { title: "Turn the recovery off", warning: "After this, nobody can bring this Chronobox back when its wallet is lost.", finish: "Apply now" };
    case "transfer-elsewhere":
      return {
        title: `Send ${amountOf(action.token, action.amount)} to ${shortAddress(action.to)}`,
        warning: "This does not go to your wallet, and this app did not create it. If you did not ask for it, cancel it.",
        finish: "Send now",
        flagged: true,
      };
    case "settings":
      return {
        title: action.label,
        warning: "This app did not create it. It changes the rules of your Chronobox. If you did not ask for it, cancel it.",
        finish: "Apply now",
        flagged: true,
      };
    default:
      return {
        title: action.label ?? "Something this app cannot read",
        warning: "This app did not create it and cannot tell what it does. It can take your money. If you did not ask for it, cancel it.",
        finish: "Finish",
        flagged: true,
      };
  }
}

/**
 * At the top of the page: something waits in the line that this app did not make. It can change the
 * rules of the Chronobox or move its money, and when its wait is over anybody can carry it out.
 */
function ForeignAlarm(props: {
  queue: QueueItem[];
  vault: VaultRef;
  inspection: Inspection;
  assets: Asset[];
  now: bigint;
  /** This wallet can cancel. Otherwise the alarm says who can. */
  canCancel: boolean;
  /** The wallet on the page is the guardian: it stops. */
  stops?: boolean;
  onCancel: (nonce: bigint) => void;
}) {
  const { vault, inspection, now } = props;
  // An item whose content this page cannot read could be anything. It is named here too: the alarm must not
  // go quiet just when the page cannot tell what waits. Its card stays amber, as it may well be one's own.
  const foreign = props.queue.filter(
    (item) => (!item.tx || isForeign(classify(item.tx, vault))) && itemStatus(item, inspection.cooldown, inspection.expiration, now).phase !== "expired",
  );
  if (foreign.length === 0) return null;
  const first = foreign[0];
  const status = itemStatus(first, inspection.cooldown, inspection.expiration, now);
  const title = describe(first.tx ? classify(first.tx, vault) : null, props.assets, {}, Boolean(vault.recoveryOn)).title;
  const unread = foreign.every((item) => !item.tx);
  const verb = props.stops ? "Stop" : "Cancel";
  return (
    <div class="foreign-alarm" role="alert">
      <span class="foreign-alarm-icon">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M12 3.5 2.5 20h19L12 3.5Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" />
                <path d="M12 10v4.5M12 17.2v.3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              </svg>
      </span>
      <div class="foreign-alarm-body">
        <strong>
          {unread
            ? foreign.length === 1
              ? "Something is waiting that this page cannot read."
              : `${foreign.length} things are waiting that this page cannot read.`
            : foreign.length === 1
              ? "Something is waiting that this app did not create."
              : `${foreign.length} things are waiting that this app did not create.`}
        </strong>
        <p class="foreign-alarm-what">{title}</p>
        <p>
          {status.phase === "ready" ? (
            <>
              Its wait is over: <b>anybody can carry it out now.</b>{" "}
            </>
          ) : (
            <>
              In <b>{formatDuration(status.readyAt - now)}</b>, on {formatDate(status.readyAt)}, anybody can carry it out.{" "}
            </>
          )}
          {props.stops
            ? "If the owner did not ask for it, stop it."
            : "Only your wallet can put something into the line. If you did not ask for it, somebody else can sign with your wallet."}
        </p>
        <div class="foreign-alarm-actions">
          {props.canCancel ? (
            <Button kind="danger" onClick={() => props.onCancel(foreign[foreign.length - 1].nonce)}>
              {foreign.length === 1 ? `${verb} it` : `${verb} all ${foreign.length}`}
            </Button>
          ) : (
            <p class="hint">Only the wallet {shortAddress(vault.controller)} can cancel it.</p>
          )}
          <a
            class="link-button"
            href={`#item-${first.nonce}`}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(`item-${first.nonce}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          >
            Show it in the line
          </a>
        </div>
      </div>
    </div>
  );
}

function QueueCard(props: {
  item: QueueItem;
  first: boolean;
  status: ItemStatus;
  now: bigint;
  cooldown: bigint;
  action: Action | null;
  recoveryOn: boolean;
  assets: Asset[];
  chain: Chain;
  safe: Address;
  rpc: Session["rpc"];
  busy: string | null;
  onFinish: () => void;
  onFinishFlagged: () => void;
  onRemove: () => void;
  onCancel: (() => void) | null;
  cancelLabel: string;
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

  const { title, warning, finish, flagged } = describe(action, props.assets, tokens, props.recoveryOn);
  const progress = Math.max(0, Math.min(1, Number(now - item.createdAt) / Number(props.cooldown || 1n)));
  // Not made by this app: red, and its cancel is the first thing on the card.
  const alarm = isForeign(action) && status.phase !== "expired";

  return (
    <li id={`item-${item.nonce}`} class={`queue-item queue-${status.phase}${alarm ? " queue-alarm" : warning ? " queue-warning" : ""}`}>
      <div class="queue-main">
        <span class="queue-head">
          {alarm ? (
            <span class="queue-alarm-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M12 3.5 2.5 20h19L12 3.5Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" />
                <path d="M12 10v4.5M12 17.2v.3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              </svg>
            </span>
          ) : (
            <Ring size={30} left={status.phase === "waiting" ? 1 - progress : 0} label={status.phase === "waiting" ? `${Math.round(progress * 100)} percent of the wait has passed` : undefined} />
          )}
          <strong class="queue-title">{title}</strong>
        </span>
        {warning ? <span class="queue-flag">{warning}</span> : null}
        {status.phase === "waiting" ? (
          <span class="queue-when">
            Ready in <b>{formatDuration(status.readyAt - now)}</b>, on {formatDate(status.readyAt)}
          </span>
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
        {status.phase === "waiting" && !alarm ? (
          <button type="button" class="link-button" onClick={() => saveReminders(item.nonce, status, now)}>
            Add to calendar
          </button>
        ) : null}
        {status.phase !== "expired" && props.onCancel ? (
          alarm ? (
            <Button small kind="danger" onClick={props.onCancel}>
              {props.cancelLabel}
            </Button>
          ) : (
            <button type="button" class="link-button" onClick={props.onCancel}>
              {props.cancelLabel}
            </button>
          )
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
  balances: (bigint | null)[];
  queue: QueueItem[];
  /** True when not every item of the line was read: then `reserved` can be too low. */
  partial: boolean;
  now: bigint;
  canCancel: boolean;
  onClose: () => void;
}) {
  const { session, vault, inspection, assets, balances } = props;
  const [assetIndex, setAssetIndex] = useState(() => {
    const firstHeld = balances.findIndex((b) => b !== null && b > 0n);
    return firstHeld >= 0 ? firstHeld : 0;
  });
  const [amountText, setAmountText] = useState("");
  const [stage, setStage] = useState<"form" | "confirm" | "done" | "unknown">("form");
  const [agreed, setAgreed] = useState(false);
  const [queued, setQueued] = useState<{ nonce: bigint; at: bigint } | null>(null);
  const action = useAction();

  const safeIndex = assetIndex < assets.length ? assetIndex : 0;
  const asset = assets[safeIndex];
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
  const inside = balances[safeIndex];
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
          ? reserved > 0n && available === 0n
            ? `All of your ${asset.symbol} is already waiting in line.`
            : "Enter more than zero."
          : amount > available
            ? available === 0n && reserved > 0n
              ? `All of your ${asset.symbol} is already waiting in line.`
              : `You can withdraw up to ${formatAmount(available, asset.decimals)} ${asset.symbol}.`
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
      setQueued({ nonce: added[0]?.nonce ?? inspection.queueNonce, at: await receiptTime(session.rpc, receipt) });
      setStage("done");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done" && queued) {
    const status = itemStatus({ createdAt: queued.at }, inspection.cooldown, inspection.expiration, queued.at);
    return (
      <Modal title="The wait has started." onClose={props.onClose}>
        <div class="sun-pass">
          <SunPassArt size={96} />
        </div>
        <p class="big-line">{amountLine}</p>
        <p>
          Come back on <b>{formatDate(status.readyAt)}</b>.
          {status.expiresAt !== null
            ? ` You then have ${formatDuration(inspection.expiration)} to collect it. After that time, this withdrawal is no longer valid and the money stays in your Chronobox.`
            : " Then you can collect it."}
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
    <Modal title="Withdraw" lead="How much do you need?" onClose={props.onClose}>
      <AssetAmount
        assets={assets}
        asset={safeIndex}
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
          {reserved > 0n ? `${formatAmount(reserved, asset.decimals)} ${asset.symbol} is already waiting in line. ` : ""}
          {props.partial ? "Not everything in line could be read, so more may be waiting than this counts. " : ""}
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
  // With a guardian there are two ways: together and now, or alone and after the wait.
  const guard = vault.guardian && vault.council && vault.members ? { guardian: vault.guardian, council: vault.council, members: vault.members } : null;
  const [mode, setMode] = useState<"together" | "alone">(guard ? "together" : "alone");
  // A request that the guardian has not answered yet. The owner can close the page and come back to it.
  const [asking, setAsking] = useState<SwapRequest | null>(() => (guard ? pendingSwap(props.chain.id, vault.safe) : null));
  const next = parseAddress(text);
  // Base address check (independent of council replacement, which only "alone" mode needs).
  const baseValid = next ? changeWalletTx(vault.delay, vault.controller, next, vault.roles ?? null, vault.safe, null) !== null && (!guard || (!sameAddress(next, guard.guardian) && !sameAddress(next, guard.council))) : false;
  const recovery = vault.recoveryOn ? (vault.recoveryDelay ?? null) : null;
  const tx = next ? changeWalletTx(vault.delay, vault.controller, next, vault.roles ?? null, vault.safe, guard, recovery) : null;
  const [incompatible, setIncompatible] = useState(false);
  const councilCollision = !!guard && mode === "alone" && baseValid && (!tx || incompatible);
  const problem =
    text.trim() === ""
      ? null
      : !next
        ? "This is not a wallet address."
        : sameAddress(next, vault.controller)
          ? "Enter a wallet other than this one."
          : sameAddress(next, vault.safe)
            ? "This is the address of the Chronobox itself. Enter the address of the new wallet."
            : guard && sameAddress(next, guard.guardian)
              ? "This is the wallet of your guardian. Wallet and guardian must be two wallets."
              : !baseValid
                ? "Nobody can sign with this address. Enter the address of a wallet."
                : councilCollision
                  ? "This wallet held this Chronobox before. Hand over to it with your guardian, or use another wallet address alone."
                  : null;
  const wait = formatDuration(inspection.cooldown);
  const [unknown, setUnknown] = useState(false);
  // A contract at the new address is not wrong (it can be a Safe), but it is worth a second look.
  const [isContract, setIsContract] = useState(false);
  useEffect(() => {
    setIsContract(false);
    setIncompatible(false);
    if (!next || !baseValid) return;
    let stale = false;
    session.rpc("eth_getCode", [next, "latest"]).then(
      (code: string) => !stale && setIsContract(typeof code === "string" && code.length > 2),
      () => undefined,
    );
    if (guard && tx) {
      councilCompatible(session.rpc, vault.safe, next, guard.guardian, Boolean(vault.recoveryOn)).then(
        (ok) => !stale && setIncompatible(!ok),
        () => undefined,
      );
    }
    return () => {
      stale = true;
    };
  }, [next, baseValid, !!tx, guard?.guardian, vault.safe, vault.recoveryOn, session.rpc]);
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
  const ask = () =>
    action.run("ask", async (waiting) => {
      if (!sameAddress(vault.controller, session.account)) throw new Error(`Your wallet is on another account now. Only the wallet ${shortAddress(vault.controller)} can do this.`);
      await prepareSwap(session, props.chain, vault, waiting);
      // The change cancels the line up to where it stands now. This point is part of what both
      // sign, so it is fixed here, once, and a lost wallet cannot move it by queueing more.
      const request = { to: next!, upTo: (await delayNonces(session.rpc, vault.delay)).queueNonce };
      setPendingSwap(props.chain.id, vault.safe, request);
      setAsking(request);
    });
  if (asking) {
    return (
      <AskGuardianSheet
        session={session}
        chain={props.chain}
        vault={vault}
        request={asking}
        onDrop={() => {
          setPendingSwap(props.chain.id, vault.safe, null);
          setAsking(null);
        }}
        onClose={props.onClose}
      />
    );
  }
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
      lead={
        guard
          ? "The new wallet then controls this Chronobox. This wallet can then do nothing."
          : `After ${wait}, the new wallet controls this Chronobox. This wallet can then do nothing.${props.canCancel ? " You can cancel while it waits." : ""}`
      }
      busy={action.busy !== null && !action.slow}
      onClose={props.onClose}
    >
      {guard ? (
        <div class="wiz-list" role="radiogroup" aria-label="How to hand over">
          <Choice role="radio" on={mode === "together"} title="With my guardian" text="Now. Your guardian agrees on their own device." disabled={!!action.busy} onClick={() => setMode("together")} />
          <Choice role="radio" on={mode === "alone"} title="Alone" text={`After ${wait}. Your guardian can stop it.`} disabled={!!action.busy} onClick={() => setMode("alone")} />
        </div>
      ) : null}
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
        title="I checked the address, and I control this wallet."
        text="If it is wrong, the money in this Chronobox is gone."
        disabled={!!action.busy}
        onClick={() => setSure(!sure)}
      />
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      {guard && mode === "together" && !inspection.councilMade ? (
        <p class="hint">The first time, your wallet sets up a Safe that needs both you and your guardian. That is one transaction.</p>
      ) : null}
      <div class="modal-actions">
        {guard && mode === "together" ? (
          <Button kind="primary" disabled={!baseValid || !sure} busy={action.busy === "ask"} onClick={ask}>
            {action.busy ? "Confirm in your wallet" : "Ask my guardian"}
          </Button>
        ) : (
          <Button kind="primary" disabled={!tx || incompatible || !sure} busy={action.busy === "queue"} onClick={submit}>
            {action.busy ? "Confirm in your wallet" : "Start the wait"}
          </Button>
        )}
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
    <Modal title="Add a token" lead={`Your Chronobox can hold any token on ${props.chain.name}. Paste its address to see it here.`} busy={action.busy !== null} onClose={props.onClose}>
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
