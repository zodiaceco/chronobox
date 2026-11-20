/**
 * The page of a connected wallet: one list of its money. Each asset has an
 * unlocked amount (in the wallet) and a locked amount (in the wallet's
 * Chronobox). Locking moves money in. Unlocking asks for it back and waits.
 *
 * A wallet has one Chronobox, at an address that follows from the wallet's
 * address alone. It is created the first time money is locked, in the same
 * step. There is no setup to go through.
 *
 * One rule shapes this page: money at that address is protected only once the
 * time lock is on. Until then the wallet owns the Safe outright. So the app
 * never sends money ahead of the lock, and money that is found there before
 * the lock is on is shown as "not locked yet".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Chain, CHAINS, chainById, CONTRIBUTION_RECEIVER, CONTRIBUTION_USD } from "../lib/chains.ts";
import { formatAmount, formatDuration, formatUnits, parseUnits, shortAddress } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import { blockHints, lookupAllowed, setLookupAllowed, txCache } from "../lib/store.ts";
import { findTokens, lookupHosts, publicRpc, withFallback } from "../lib/lookup.ts";
import { call } from "../lib/abi.ts";
import {
  EXPIRATION_SECONDS,
  MAX_COOLDOWN,
  MIN_COOLDOWN,
  type Inspection,
  type QueueItem,
  Replaced,
  StoppedWaiting,
  arrivedInReceipt,
  chainTime,
  coinPriceUsd,
  createTx,
  depositTx,
  feeReserve,
  inspect,
  lockTx,
  predictRoles,
  predictSafe,
  readBalances,
  readMany,
  readQueue,
  safeFromReceipt,
  sendAndWait,
  setupCalls,
  slowAfterMs,
  usdToCoin,
} from "../lib/chronobox.ts";
import { BatchUnknown, assertWallet, canBatch, errorText, isRejection, sendBatch, switchChain } from "../lib/wallet.ts";
import { Dial } from "./logo.tsx";
import { type Asset, AssetAmount, assetsOf, Button, Choice, Modal, Notice, type Session, Tick } from "./common.tsx";
import { DepositPanel } from "./deposit.tsx";
import { OpenByAddress, vaultHref } from "./start.tsx";
import { ChangeDelaySheet, ChangeWalletSheet, ChecksSheet, QueueSection, Row, TokenSheet, type VaultRef, WithdrawSheet, useChainClock } from "./vault.tsx";

/**
 * Where the voluntary contribution goes. A build without a receiver does not
 * ask. The dev server uses a throwaway address so that the line can be seen.
 */
const RECEIVER: Address | null = CONTRIBUTION_RECEIVER ?? (__DEV__ ? "0x000000000000000000000000000000000000c0de" : null);

/** How long unlocking takes, offered when the lock is switched on. The second one is selected. */
const DELAYS: { label: string; seconds: bigint }[] = [
  { label: "1 day", seconds: 24n * 3600n },
  { label: "2 days", seconds: 48n * 3600n },
  { label: "1 week", seconds: 7n * 24n * 3600n },
];

type Funds = {
  inspection: Inspection;
  queue: QueueItem[];
  assets: Asset[];
  /** In the wallet. Null where the balance is not known (yet). That is never "nothing". */
  wallet: (bigint | null)[];
  /** At the address of the Chronobox. */
  box: (bigint | null)[];
  now: bigint;
  fetchedAt: number;
};

type Sheet = "lock" | "unlock" | "receive" | "token" | "delay" | "wallet" | "checks" | "lookup" | null;

const keyOf = (asset: Asset) => asset.token?.toLowerCase() ?? "native";

/**
 * Reads the page in two steps. First what takes a moment: the state of the Chronobox, and the
 * balances of the main assets and of everything that was there last time. The page shows that at
 * once. Then what can take long: the history check, and the long list of tokens.
 */
function useFunds(session: Session, chain: Chain, safe: Address, lookup: boolean) {
  const [data, setData] = useState<Funds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // One read at a time. A read that is asked for while another runs starts when that one ends.
  const reading = useRef(false);
  const wanted = useRef(false);
  // The long list of tokens is read on the first look and after something was done, not on every tick.
  const deep = useRef(true);
  const last = useRef<Funds | null>(null);
  // Tokens that the balance lookup found and the app's own lists do not have.
  const found = useRef<Asset[]>([]);
  const refresh = useCallback((all = true) => {
    if (all) deep.current = true;
    if (reading.current) wanted.current = true;
    else setRound((r) => r + 1);
  }, []);

  useEffect(() => {
    let stale = false;
    reading.current = true;
    (async () => {
      try {
        const rpc = session.rpc;
        const hints = blockHints(chain.id);
        const all = deep.current;
        deep.current = false;
        if (!lookup) found.current = [];
        // Balances are for display. With the lookup on they come from a public node, and from the wallet when that fails.
        const reader = lookup ? withFallback(publicRpc(chain), rpc) : rpc;
        const listed = assetsOf(chain);
        const merge = () => [...listed, ...found.current.filter((f) => !listed.some((a) => sameAddress(a.token, f.token)))];
        let assets = merge();
        const before = new Map((last.current?.assets ?? []).map((a, i) => [keyOf(a), [last.current!.wallet[i], last.current!.box[i]] as const]));
        const some = assets.map((_, i) => i).filter((i) => {
          const known = before.get(keyOf(assets[i]));
          return assets[i].main || (known?.[0] ?? 0n) > 0n || (known?.[1] ?? 0n) > 0n;
        });
        const readSome = async (indexes: number[]) => {
          const part = indexes.map((i) => assets[i]);
          const [mine, boxed] = await Promise.all([readBalances(reader, session.account, part), readBalances(reader, safe, part)]);
          return { mine: mine.balances, boxed: boxed.balances };
        };

        const [quick, now, first] = await Promise.all([inspect(rpc, safe, hints, { historyLater: true }), chainTime(rpc), readSome(some)]);
        const fetchedAt = Date.now();
        let inspection = quick;
        const queue = inspection.state === "locked" || inspection.state === "unverified" ? await readQueue(rpc, inspection, txCache(chain.id, inspection.delay!)) : [];
        if (stale) return;
        const wallet = assets.map((a) => before.get(keyOf(a))?.[0] ?? null);
        const box = assets.map((a) => before.get(keyOf(a))?.[1] ?? null);
        some.forEach((i, k) => {
          wallet[i] = first.mine[k];
          box[i] = first.boxed[k];
        });
        const publish = () => {
          const next: Funds = { inspection, queue, assets, wallet: [...wallet], box: [...box], now, fetchedAt };
          last.current = next;
          setData(next);
          setError(null);
        };
        publish();

        const later: Promise<void>[] = [];
        if (inspection.historyPending) {
          later.push(
            inspect(rpc, safe, hints).then(
              (full) => {
                if (stale) return;
                inspection = full;
                publish();
              },
              () => {
                if (stale) return;
                // The history could not be read. That is "could not check", as on any other device that cannot read it.
                inspection = {
                  ...inspection,
                  historyPending: false,
                  checks: inspection.checks.map((c) => (c.pending ? { ...c, pending: false, detail: "Your wallet's network did not return the event history of the Roles modifier." } : c)),
                };
                publish();
              },
            ),
          );
        }
        if (lookup && all) {
          // Which other tokens do the two addresses hold? The index names them. Decimals and balances are read from the chain.
          later.push(
            (async () => {
              const lists = await Promise.all([findTokens(chain, session.account), findTokens(chain, safe)]);
              const fresh = lists.flat().filter((t, i, list) => list.findIndex((o) => sameAddress(o.address, t.address)) === i && !listed.some((a) => sameAddress(a.token, t.address)));
              if (fresh.length === 0 || stale) return;
              const decimals = await readMany(reader, fresh.map((t) => ({ to: t.address, data: call("decimals()") })));
              const good = fresh.filter((t, i) => {
                const answer = decimals[i];
                return answer !== null && answer.length >= 66 && BigInt(answer.slice(0, 66)) === BigInt(t.decimals);
              });
              const [mine, boxed] = await Promise.all([readBalances(reader, session.account, good.map((t) => ({ token: t.address }))), readBalances(reader, safe, good.map((t) => ({ token: t.address })))]);
              if (stale) return;
              found.current = good.map((t) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals, found: true }));
              const have = new Map(assets.map((a, i) => [keyOf(a), [wallet[i], box[i]] as const]));
              good.forEach((t, i) => have.set(t.address.toLowerCase(), [mine.balances[i], boxed.balances[i]]));
              assets = merge();
              wallet.length = 0;
              box.length = 0;
              for (const a of assets) {
                wallet.push(have.get(keyOf(a))?.[0] ?? null);
                box.push(have.get(keyOf(a))?.[1] ?? null);
              }
              publish();
            })().catch(() => undefined),
          );
        }
        const quickSet = new Set(some);
        const rest = all ? listed.map((_, i) => i).filter((i) => !quickSet.has(i)) : [];
        if (rest.length > 0) {
          later.push(
            readSome(rest).then(
              (more) => {
                if (stale) return;
                rest.forEach((i, k) => {
                  wallet[i] = more.mine[k];
                  box[i] = more.boxed[k];
                });
                publish();
              },
              // The long list is extra. The main assets are on the page.
              () => undefined,
            ),
          );
        }
        await Promise.all(later);
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
  }, [session.rpc, session.account, chain, safe, round, lookup]);

  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && !reading.current && refresh(false), 30_000);
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

function LockIcon() {
  return (
    <svg class="funds-lock-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.8" fill="currentColor" />
      <path d="M5.2 7V5.2a2.8 2.8 0 015.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6" />
    </svg>
  );
}

export function FundsPage(props: { session: Session; chain: Chain }) {
  const { session, chain } = props;
  const safe = useMemo(() => predictSafe(session.account, 0), [session.account]);
  const [lookup, setLookup] = useState(lookupAllowed);
  const [showOther, setShowOther] = useState(false);
  const { data, error, refresh } = useFunds(session, chain, safe, lookup);
  const now = useChainClock(data);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [preset, setPreset] = useState<number | null>(null);
  const [batch, setBatch] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const chooseLookup = (on: boolean) => {
    setLookupAllowed(on);
    setLookup(on);
    setSheet(null);
    refresh();
  };

  useEffect(() => {
    let stale = false;
    setBatch(false);
    canBatch(session.wallet.provider, session.account, chain.id).then((yes) => !stale && setBatch(yes));
    return () => {
      stale = true;
    };
  }, [session.wallet, session.account, chain]);

  const network = (
    <label class="funds-network">
      <span class="eyebrow">Your funds on</span>
      <select
        class="input select"
        aria-label="Network"
        value={chain.id}
        onChange={(event) => {
          const target = chainById(Number((event.target as HTMLSelectElement).value));
          // The wallet decides. Until it has moved, the page stays on the network it reads.
          (event.target as HTMLSelectElement).value = String(chain.id);
          if (!target) return;
          setSwitchError(null);
          switchChain(session.wallet.provider, target).catch((e) => {
            if (!isRejection(e)) setSwitchError(`Your wallet did not switch. Switch to ${target.name} in your wallet itself.`);
          });
        }}
      >
        {CHAINS.filter((c) => !c.testnet || __DEV__ || c.id === chain.id).map((c) => (
          <option value={c.id} key={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );

  if (error && !data) {
    return (
      <section class="page page-center">
        <h1>We could not read your funds.</h1>
        <p class="lead">Your money is not affected. Check the connection of your wallet and try again.</p>
        <p class="hint">{error}</p>
        <div class="page-actions">
          <Button kind="primary" onClick={() => refresh()}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  if (!data) return <section class="page page-center muted">Reading your funds…</section>;

  const { inspection, queue, assets, wallet, box } = data;
  const mine = (inspection.state === "locked" || inspection.state === "unverified") && sameAddress(inspection.controller, session.account);
  // The lock is not on yet. It goes on with the first money that is locked.
  const fresh = inspection.state === "missing" || (inspection.state === "open" && sameAddress(inspection.owners[0], session.account));
  const verified = mine && inspection.state === "locked";
  const checking = mine && !verified && inspection.historyPending === true;
  // Another wallet holds the key now: this one handed it over.
  const handedOver = (inspection.state === "locked" || inspection.state === "unverified") && !mine;
  const vault: VaultRef | null = mine ? { safe, delay: inspection.delay!, controller: inspection.controller!, roles: inspection.roles } : null;
  const canCancel = mine && !!inspection.roles;
  const passed = inspection.checks.filter((c) => c.ok).length;

  const held = assets
    .map((asset, i) => ({ asset, index: i, unlocked: wallet[i], locked: mine ? box[i] : 0n, loose: mine ? 0n : (box[i] ?? 0n) }))
    .filter((r) => r.index === 0 || (r.unlocked ?? 0n) > 0n || (r.locked ?? 0n) > 0n);
  // Tokens that only the lookup knows can be anything, also something that was sent to the wallet unasked. They are shown on request.
  const other = held.filter((r) => r.asset.found && !((r.locked ?? 0n) > 0n));
  const rows = held.filter((r) => showOther || !other.includes(r));
  // Money at the address of the Chronobox while the time lock is off. It is not protected.
  // A token that only the lookup knows does not count: anybody can send such a token to any address.
  const loose = assets.map((asset, i) => ({ asset, amount: mine || asset.found ? 0n : (box[i] ?? 0n) })).filter((l) => l.amount > 0n);
  const anyLocked = mine && box.some((b) => (b ?? 0n) > 0n);
  const anyUnlocked = wallet.some((b) => (b ?? 0n) > 0n);
  const unread = assets.filter((a, i) => a.main && (wallet[i] === null || box[i] === null)).map((a) => a.symbol);
  const close = () => {
    setSheet(null);
    setPreset(null);
    refresh();
  };
  const amount = (value: bigint | null, asset: Asset) => (value === null ? "–" : formatAmount(value, asset.decimals, 6));

  return (
    <section class="page vault funds">
      {network}
      {switchError ? <p class="field-error">{switchError}</p> : null}
      {error ? (
        <p class="read-failed" role="status">
          Your wallet's network did not answer. This page shows what it read at {new Date(data.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.{" "}
          <button type="button" class="link-button" onClick={() => refresh()}>
            Try again
          </button>
        </p>
      ) : null}

      {inspection.state === "invalid" || (inspection.state === "open" && !fresh) ? (
        <Notice kind="bad" title="Something is not right at the address of your Chronobox.">
          The contract there did not pass the safety checks, so this page does not lock money. <button type="button" class="link-button" onClick={() => setSheet("checks")}>See the checks</button>
        </Notice>
      ) : null}
      {handedOver ? (
        <Notice kind="info" title="This wallet handed its Chronobox over.">
          The wallet {shortAddress(inspection.controller!)} holds the key now. Open the Chronobox with that wallet: <a href={vaultHref(chain, safe)}>{shortAddress(safe)}</a>
        </Notice>
      ) : null}
      {mine && !verified && !checking ? (
        <Notice kind="risk" title="One safety check could not run here.">
          Nothing looks wrong, and you can unlock. Wait with locking more until the check passes: open this page with a wallet whose network
          connection can read old records.
        </Notice>
      ) : null}
      {loose.length > 0 && fresh ? (
        <Notice kind="risk" title={`${loose.map((l) => `${formatAmount(l.amount, l.asset.decimals, 6)} ${l.asset.symbol}`).join(", ")} is not locked yet.`}>
          It sits at the address of your Chronobox, but the time lock is not on. Until it is, whoever holds your wallet can take it at once.{" "}
          <button type="button" class="link-button" onClick={() => setSheet("lock")}>
            Switch on the time lock
          </button>
        </Notice>
      ) : null}

      <div class="funds-table" role="table" aria-label="Your funds">
        <div class="funds-row funds-header" role="row">
          <span role="columnheader">Asset</span>
          <span role="columnheader">Unlocked</span>
          <span role="columnheader">Locked</span>
        </div>
        {rows.map((r) => (
          <div class="funds-row" role="row" key={keyOf(r.asset)}>
            <span class="funds-asset" role="cell">
              <span class="token-badge" aria-hidden="true">
                {r.asset.symbol.slice(0, 1)}
              </span>
              <span class="funds-symbol">
                {r.asset.symbol}
                {r.asset.found && r.asset.token ? <small>{shortAddress(r.asset.token)} · unlisted</small> : null}
              </span>
            </span>
            <span class="funds-num" role="cell">
              {amount(r.unlocked, r.asset)}
            </span>
            <span class={(r.locked ?? 0n) > 0n ? "funds-num funds-locked" : "funds-num funds-none"} role="cell">
              {(r.locked ?? 0n) > 0n ? <LockIcon /> : null}
              {amount(r.locked, r.asset)}
            </span>
          </div>
        ))}
      </div>
      {unread.length > 0 ? <p class="hint">The balance of {unread.join(", ")} could not be read now. It is not shown, and it is not gone.</p> : null}
      {other.length > 0 ? (
        <button type="button" class="link-button funds-more" onClick={() => setShowOther(!showOther)}>
          {showOther ? "Hide the other tokens" : `Show ${other.length} other ${other.length === 1 ? "token" : "tokens"}`}
        </button>
      ) : !lookup ? (
        <button type="button" class="link-button funds-more" onClick={() => setSheet("lookup")}>
          A token is missing? Find all my tokens
        </button>
      ) : null}

      {handedOver || inspection.state === "invalid" ? null : (
        <div class="vault-actions">
          <Button
            kind="primary"
            disabled={!(fresh || verified) || (!anyUnlocked && loose.length === 0)}
            onClick={() => {
              // Start with the first asset that the wallet holds.
              const held = wallet.findIndex((b) => (b ?? 0n) > 0n);
              setPreset(held > 0 && (wallet[0] ?? 0n) === 0n ? held : 0);
              setSheet("lock");
            }}
          >
            Lock
          </Button>
          <Button disabled={!anyLocked} onClick={() => setSheet("unlock")}>
            Unlock
          </Button>
        </div>
      )}
      <p class="funds-note">
        {mine ? (
          <>
            Unlocking takes <b>{formatDuration(inspection.cooldown)}</b>. Nobody can make it faster.
            {checking ? " Running the last safety check…" : ""}
          </>
        ) : fresh ? (
          "Locked money cannot leave in a hurry. Unlocking it takes the time you choose, and nobody can make that faster. Not even you."
        ) : null}
      </p>

      {vault ? <QueueSection session={session} chain={chain} vault={vault} inspection={inspection} queue={queue} assets={assets} now={now} canCancel={canCancel} refresh={() => refresh()} /> : null}

      <ul class="rows">
        {mine ? <Row label="Lock from elsewhere" value={shortAddress(safe)} onClick={verified ? () => setSheet("receive") : undefined} /> : null}
        {mine ? <Row label="Unlocking takes" value={formatDuration(inspection.cooldown)} onClick={() => setSheet("delay")} /> : null}
        {mine ? <Row label="Wallet that unlocks" value={shortAddress(inspection.controller!)} onClick={() => setSheet("wallet")} /> : null}
        {inspection.checks.length > 0 ? (
          <Row
            label="Safety checks"
            value={verified ? `All ${passed} passed` : checking ? "Checking…" : `${passed} of ${inspection.checks.length} passed`}
            onClick={() => setSheet("checks")}
          />
        ) : null}
        <Row label="Tokens" value="Add a token" onClick={() => setSheet("token")} />
        <Row label="Balance lookup" value={lookup ? "On" : "Through your wallet"} onClick={() => setSheet("lookup")} />
      </ul>

      <OpenOther chain={chain} />

      {sheet === "lock" ? (
        <LockSheet session={session} chain={chain} safe={safe} inspection={inspection} assets={assets} wallet={wallet} loose={loose.length > 0} batch={batch} preset={preset ?? 0} onChanged={() => refresh()} onClose={close} />
      ) : null}
      {sheet === "unlock" && vault ? (
        <WithdrawSheet session={session} chain={chain} vault={vault} inspection={inspection} assets={assets} balances={box} queue={queue} now={now} canCancel={canCancel} onClose={close} />
      ) : null}
      {sheet === "receive" ? (
        <Modal title="Lock from elsewhere" lead="Money that is sent to this address is locked when it arrives." onClose={close}>
          <DepositPanel session={session} chain={chain} safe={safe} assets={assets} addressOnly />
        </Modal>
      ) : null}
      {sheet === "delay" && vault ? <ChangeDelaySheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "wallet" && vault ? <ChangeWalletSheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "token" ? <TokenSheet session={session} chain={chain} onClose={close} /> : null}
      {sheet === "checks" ? <ChecksSheet inspection={inspection} onClose={() => setSheet(null)} /> : null}
      {sheet === "lookup" ? (
        <Modal title="Balance lookup" onClose={() => setSheet(null)}>
          <p>
            Chronobox reads everything through your wallet. That is private, but it can be slow, and it shows only the tokens that Chronobox knows.
          </p>
          <p>
            With the lookup on, this page asks public services directly for your balances{chain.indexer ? " and for the list of tokens you hold" : ""}:{" "}
            <b>{lookupHosts(chain).join(", ")}</b>. They see your IP address, your wallet address and the address of your Chronobox.
          </p>
          <p class="hint">
            {chain.indexer ? "" : `On ${chain.name} there is no token list to ask, so this makes balances faster and finds no new tokens. `}
            The lookup is for display only. The safety checks and every transaction still go through your wallet.
          </p>
          <div class="modal-actions">
            {lookup ? (
              <>
                <Button kind="primary" onClick={() => chooseLookup(false)}>
                  Switch it off
                </Button>
                <Button kind="quiet" onClick={() => setSheet(null)}>
                  Keep it on
                </Button>
              </>
            ) : (
              <>
                <Button kind="primary" onClick={() => chooseLookup(true)}>
                  Switch it on
                </Button>
                <Button kind="quiet" onClick={() => setSheet(null)}>
                  Keep everything in my wallet
                </Button>
              </>
            )}
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

type Line = { asset: Asset; index: number; amount: bigint };
type Step = { id: string; text: string };

/**
 * Locks money: moves it from the wallet into the Chronobox. The first time, the same press also
 * creates the Chronobox and switches on its time lock, before any money moves or together with it.
 *
 * A wallet that can send several calls as one does all of it in one confirmation. A plain wallet
 * confirms step by step: create, switch on (the network's coin rides along), then one transfer
 * per token. Every press reads the chain first, so a step that has landed is never sent again.
 */
function LockSheet(props: {
  session: Session;
  chain: Chain;
  safe: Address;
  inspection: Inspection;
  assets: Asset[];
  wallet: (bigint | null)[];
  /** Money is at the address already while the lock is off: switching the lock on needs no amount. */
  loose: boolean;
  batch: boolean;
  preset: number;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { session, chain, safe, assets, batch } = props;
  // What the page knew when the sheet opened. Every press reads the chain again.
  const [first] = useState(props.inspection.state === "missing" || props.inspection.state === "open");
  const [entries, setEntries] = useState<{ asset: number; amount: string }[]>([{ asset: props.preset, amount: "" }]);
  const [delay, setDelay] = useState<number | "custom">(1);
  const [customValue, setCustomValue] = useState("3");
  const [customUnit, setCustomUnit] = useState<"hours" | "days">("days");
  const [agreed, setAgreed] = useState(false);
  const [giveUsd, setGiveUsd] = useState<number>(CONTRIBUTION_USD.suggested);
  const [giveOwn, setGiveOwn] = useState("");
  const [giveLess, setGiveLess] = useState(false);
  const [price, setPrice] = useState<bigint | null>(null);
  const [reserve, setReserve] = useState<bigint | null>(null);

  const [steps, setSteps] = useState<Step[] | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [finished, setFinished] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<"form" | "work" | "done" | "unknown">("form");
  const [result, setResult] = useState<{ lines: Line[]; cooldown: bigint; unverified: boolean; notes: string[] } | null>(null);
  const running = useRef(false);
  const stop = useRef(false);
  // Lines whose money has moved. A second press does not send them again.
  const sent = useRef(new Set<number>());
  const notes = useRef<string[]>([]);

  useEffect(() => {
    if (!first || !RECEIVER) return;
    let stale = false;
    coinPriceUsd(session.rpc, chain.usdFeed).then((p) => !stale && setPrice(p));
    return () => {
      stale = true;
    };
  }, [session.rpc, chain, first]);
  useEffect(() => {
    let stale = false;
    feeReserve(session.rpc).then((r) => !stale && setReserve(r));
    return () => {
      stale = true;
    };
  }, [session.rpc]);
  useEffect(() => {
    setSlow(false);
    if (!at || at === "check") return;
    const timer = setTimeout(() => setSlow(true), slowAfterMs());
    return () => clearTimeout(timer);
  }, [at]);
  // A sheet that is gone must not keep asking the wallet's network.
  useEffect(
    () => () => {
      stop.current = true;
    },
    [],
  );

  const cooldown: bigint | null = delay === "custom" ? (/^\d{1,4}$/.test(customValue) ? BigInt(customValue) * (customUnit === "days" ? 86_400n : 3_600n) : null) : DELAYS[delay].seconds;
  const cooldownProblem = !first
    ? null
    : cooldown === null
      ? "Enter a whole number."
      : cooldown < MIN_COOLDOWN
        ? `The shortest time is ${formatDuration(MIN_COOLDOWN)}.`
        : cooldown > MAX_COOLDOWN
          ? `The longest time is ${formatDuration(MAX_COOLDOWN)}.`
          : null;
  const delayText = first ? (cooldown !== null && !cooldownProblem ? formatDuration(cooldown) : "") : formatDuration(props.inspection.cooldown);

  const ownText = giveOwn.trim().replace(",", ".");
  const ownCents = /^[0-9]{1,5}([.][0-9]{1,2})?$/.test(ownText) ? Math.round(Number(ownText) * 100) : null;
  const giveProblem = ownText !== "" && ownCents === null ? "Enter an amount in dollars, for example 5. Enter 0 to give nothing." : null;
  const giveCents = ownText !== "" ? (ownCents ?? 0) : giveUsd * 100;
  const asks = first && !!RECEIVER && price !== null;
  const contribution = asks && giveCents > 0 && !giveProblem ? { to: RECEIVER!, amount: usdToCoin(BigInt(giveCents), price!) } : null;
  const giveText = `$${giveCents % 100 === 0 ? giveCents / 100 : (giveCents / 100).toFixed(2)}`;

  // One line per asset. A line with no amount is ignored. The network's coin comes first: it can ride along when the lock is switched on.
  const parsed = entries.filter((e) => e.amount.trim() !== "" && assets[e.asset]).map((e) => ({ index: e.asset, asset: assets[e.asset], amount: parseUnits(e.amount, assets[e.asset].decimals) }));
  const badAmount = parsed.some((p) => p.amount === null || p.amount === 0n);
  const lines: Line[] = useMemo(() => {
    const totals = new Map<number, bigint>();
    for (const p of parsed) if (p.amount) totals.set(p.index, (totals.get(p.index) ?? 0n) + p.amount);
    return [...totals].sort((a, b) => a[0] - b[0]).map(([index, amount]) => ({ index, asset: assets[index], amount }));
  }, [JSON.stringify(entries), assets]);
  // What the fee of the next steps may cost. A wallet that batches pays its fee in its own way.
  const feeRoom = batch || reserve === null ? 0n : reserve * (first ? 8n : 1n);
  const tooMuch = lines.find((l) => {
    const held = props.wallet[l.index];
    if (held === null || held === undefined) return false;
    return l.amount + (l.index === 0 ? (contribution?.amount ?? 0n) + feeRoom : 0n) > held;
  });
  const amountProblem = badAmount
    ? "Enter each amount as a plain number above zero, for example 1000 or 1.5."
    : tooMuch
      ? tooMuch.index === 0 && tooMuch.amount <= (props.wallet[0] ?? 0n)
        ? `Leave some ${tooMuch.asset.symbol} unlocked for the network fee${contribution ? " and your contribution" : ""}.`
        : `Your wallet has only ${formatAmount(props.wallet[tooMuch.index]!, tooMuch.asset.decimals, 6)} ${tooMuch.asset.symbol}.`
      : null;
  const nothing = lines.length === 0;
  const ready = !amountProblem && !cooldownProblem && !giveProblem && (first ? agreed && (!nothing || props.loose) : !nothing);
  const listText = (list: Line[]) => list.map((l) => `${formatAmount(l.amount, l.asset.decimals, 6)} ${l.asset.symbol}`).join(", ");

  const max = (row: number) => {
    const index = entries[row].asset;
    const held = props.wallet[index];
    if (!held) return;
    const most = index === 0 ? held - (contribution?.amount ?? 0n) - feeRoom : held;
    setEntries((all) => all.map((e, k) => (k === row ? { ...e, amount: most > 0n ? formatUnits(most, assets[index].decimals) : "0" } : e)));
  };

  /** Is the Chronobox finished, with the time that was chosen? "Not there yet" is asked again before it counts. */
  const verify = async (wanted: bigint, tries: number): Promise<"locked" | "unverified" | "invalid" | null> => {
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2500));
      try {
        const seen = await inspect(session.rpc, safe, blockHints(chain.id));
        if ((seen.state === "locked" || seen.state === "unverified") && seen.cooldown === wanted && sameAddress(seen.controller, session.account)) return seen.state;
        if (seen.state === "invalid" || seen.state === "locked" || seen.state === "unverified") return "invalid";
      } catch {
        // Ask again.
      }
    }
    return null;
  };

  const run = async () => {
    if (running.current) return;
    running.current = true;
    stop.current = false;
    setError(null);
    setStage("work");
    setWaiting(false);
    const rpc = session.rpc;
    const hints = blockHints(chain.id);
    const send = { chainId: chain.id, chainName: chain.name, shouldStop: () => stop.current };
    const done = (id: string) => setFinished((f) => (f.includes(id) ? f : [...f, id]));
    // True from the moment a request for the lock itself goes to the wallet. After that, the chain says what happened.
    let asked = false;
    let setup = false;
    let unverified = false;
    let chosen = props.inspection.cooldown;
    // The transfer that is on its way. Its outcome may stay unknown.
    let moving = false;
    try {
      const seen = await inspect(rpc, safe, hints, { historyLater: true });
      if (seen.state === "invalid") throw new Error("The contract at the address of your Chronobox did not pass the safety checks. Nothing was sent.");
      if (seen.state === "open" && !sameAddress(seen.owners[0], session.account)) throw new Error("Another wallet owns the contract at this address. Nothing was sent.");
      if ((seen.state === "locked" || seen.state === "unverified") && !sameAddress(seen.controller, session.account)) {
        throw new Error("Another wallet holds the key of this Chronobox now. Nothing was sent.");
      }
      setup = seen.state === "missing" || seen.state === "open";
      if (setup) {
        if (cooldown === null || cooldownProblem) throw new Error("Choose how long unlocking takes.");
        chosen = cooldown;
      } else {
        chosen = seen.cooldown;
      }
      const todo = lines.filter((l) => !sent.current.has(l.index));
      const give = setup ? contribution : null;

      // Does the wallet hold what is asked for? Read now, not when the sheet opened.
      const involved = [...new Set([0, ...todo.map((l) => l.index)])];
      const held = (await readBalances(rpc, session.account, involved.map((i) => assets[i]))).balances;
      for (const line of todo) {
        const has = held[involved.indexOf(line.index)];
        if (has !== null && line.amount > has) throw new Error(`Your wallet has only ${formatAmount(has, line.asset.decimals, 6)} ${line.asset.symbol}.`);
      }
      const coin = todo.find((l) => l.index === 0)?.amount ?? 0n;
      if (held[0] !== null && !batch) {
        const room = (await feeReserve(rpc)) * (setup ? 8n : 1n);
        if (coin + (give?.amount ?? 0n) + room > held[0]) {
          throw new Error(`Leave some ${assets[0].symbol} unlocked for the network fee${give ? " and your contribution" : ""}. Lock less, or choose a lower contribution.`);
        }
      } else if (held[0] !== null && coin + (give?.amount ?? 0n) > held[0]) {
        throw new Error(`Your wallet has only ${formatAmount(held[0], 18, 6)} ${assets[0].symbol}.`);
      }
      for (const line of todo) {
        if (!line.asset.token) continue;
        // A transfer to an address with no token behind it succeeds and moves nothing.
        const code = (await rpc("eth_getCode", [line.asset.token, "latest"])) as string;
        if (typeof code !== "string" || code.length <= 2) throw new Error(`There is no ${line.asset.symbol} token at this address on ${chain.name}. Nothing was sent.`);
      }

      const tokens = todo.filter((l) => l.index !== 0);
      const giveLine = give ? `, and send your contribution of ${giveText}` : "";
      const plan: Step[] = [];
      if (setup && batch) {
        plan.push({ id: "all", text: (todo.length > 0 ? `Switch on the time lock and lock ${listText(todo)}` : "Switch on the time lock") + giveLine });
        plan.push({ id: "check", text: "Run the safety checks" });
      } else if (setup) {
        if (seen.state === "missing") plan.push({ id: "create", text: "Create your Chronobox" });
        plan.push({ id: "switch", text: (coin > 0n ? `Switch on the time lock and lock ${listText(todo.filter((l) => l.index === 0))}` : "Switch on the time lock") + giveLine });
        plan.push({ id: "check", text: "Run the safety checks" });
        for (const line of tokens) plan.push({ id: `line-${line.index}`, text: `Lock ${listText([line])}` });
      } else if (batch) {
        plan.push({ id: "all", text: `Lock ${listText(todo)}` });
      } else {
        for (const line of todo) plan.push({ id: `line-${line.index}`, text: `Lock ${listText([line])}` });
      }
      setSteps(plan);
      setFinished([]);

      await assertWallet(rpc, session.account, chain.id, chain.name);
      const deposits = (list: Line[]) => list.map((l) => ({ token: l.asset.token, amount: l.amount }));
      let rest = todo;

      if (setup) {
        if (batch) {
          setAt("all");
          asked = true;
          const landed = await sendBatch(session.wallet.provider, session.account, chain.id, setupCalls(session.account, 0, seen.state === "open", chosen, deposits(todo), give), () => setWaiting(true), () => stop.current);
          if (landed.blockNumber !== null) hints.set(predictRoles(safe), landed.blockNumber);
          setWaiting(false);
          done("all");
          rest = [];
        } else {
          if (seen.state === "missing") {
            setAt("create");
            asked = true;
            const receipt = await sendAndWait(rpc, session.account, createTx(session.account, 0), send);
            const made = safeFromReceipt(receipt);
            if (!made || !sameAddress(made, safe)) throw new Error("Something is not right: your Chronobox is not where it should be. Stop here, and do not send money.");
            done("create");
          }
          setAt("switch");
          asked = true;
          const receipt = await sendAndWait(rpc, session.account, lockTx(session.account, safe, chosen, EXPIRATION_SECONDS, give, coin), send);
          hints.set(predictRoles(safe), BigInt(receipt.blockNumber));
          done("switch");
          rest = tokens;
        }
        setAt("check");
        const state = await verify(chosen, 5);
        if (state === "invalid") throw new Error("Your Chronobox did not pass the safety checks. Do not send money to it.");
        if (state === null) throw new Error("Your wallet's network does not show the result yet. Wait a minute, then look at this page again: what is locked shows there.");
        // The lock is on, and with it everything that came in the same step.
        for (const line of todo) if (!rest.includes(line)) sent.current.add(line.index);
        asked = false;
        done("check");
        unverified = state === "unverified";
        if (unverified && rest.length > 0) {
          throw new Error(`The time lock is on, but one safety check could not run from this device. ${listText(rest)} was not moved. Lock it when the check has passed.`);
        }
      } else if (seen.state !== "locked") {
        // The quick look leaves the history check out. Money moves only when that one has passed too.
        const full = await inspect(rpc, safe, hints);
        if (full.state !== "locked") throw new Error("One safety check could not run from this device, so nothing was sent. Try again with a wallet whose network connection can read old records.");
      }

      if (rest.length > 0 && batch) {
        setAt("all");
        moving = true;
        await sendBatch(
          session.wallet.provider,
          session.account,
          chain.id,
          rest.map((l) => depositTx(safe, l.asset.token, l.amount)),
          () => setWaiting(true),
          () => stop.current,
        );
        moving = false;
        setWaiting(false);
        for (const line of rest) sent.current.add(line.index);
        done("all");
      } else {
        for (const line of rest) {
          setAt(`line-${line.index}`);
          moving = true;
          const receipt = await sendAndWait(rpc, session.account, depositTx(safe, line.asset.token, line.amount), send);
          moving = false;
          sent.current.add(line.index);
          done(`line-${line.index}`);
          if (line.asset.token) {
            // A token can report success and still not move the money, or keep a part as a fee. Its own events say what arrived.
            const arrived = arrivedInReceipt(receipt, line.asset.token, safe);
            if (arrived === 0n) notes.current.push(`${line.asset.symbol} did not move: the token reported success, but nothing arrived.`);
            else if (arrived + 2n < line.amount) notes.current.push(`${formatAmount(arrived, line.asset.decimals, 6)} ${line.asset.symbol} arrived. The token kept the rest.`);
          }
        }
      }
      setResult({ lines: lines.filter((l) => sent.current.has(l.index)), cooldown: chosen, unverified, notes: notes.current });
      setStage("done");
    } catch (e) {
      const lost = e instanceof Replaced || e instanceof StoppedWaiting || e instanceof BatchUnknown;
      if (asked && setup && !isRejection(e)) {
        // Something may have reached the chain all the same. Look before saying that it failed.
        setAt("check");
        const state = await verify(chosen, 2);
        if (state === "locked" || state === "unverified") {
          // The lock is on. What rode along with it has moved.
          for (const line of lines) if (batch || line.index === 0) sent.current.add(line.index);
          const left = lines.filter((l) => !sent.current.has(l.index));
          if (left.length === 0) {
            setResult({ lines, cooldown: chosen, unverified: state === "unverified", notes: notes.current });
            setStage("done");
          } else {
            setError(`The time lock is on. ${listText(left)} is not locked yet: press the button to go on.`);
          }
          return;
        }
        if (lost) return setStage("unknown");
      } else if (moving && lost) {
        return setStage("unknown");
      }
      setError(errorText(e));
    } finally {
      running.current = false;
      setAt(null);
      setWaiting(false);
      props.onChanged();
    }
  };

  if (stage === "unknown") {
    return (
      <Modal title="Look at your funds" onClose={props.onClose}>
        <p>Your wallet sent the request, but this page did not see it arrive. That can happen when the network is slow, or when the request was changed in the wallet.</p>
        <p>Close this and look at the list. If the money shows as locked, it is done. If nothing has changed after a few minutes, lock it again. Do not lock twice before you have looked.</p>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </Modal>
    );
  }

  if (stage === "done" && result) {
    return (
      <Modal title={result.lines.length > 0 ? "Locked." : "The time lock is on."} onClose={props.onClose}>
        <div class="sun-pass">
          <Dial size={96} play="close" />
        </div>
        {result.lines.length > 0 ? <p class="big-line">{listText(result.lines)}</p> : null}
        <p>
          Unlocking takes <b>{formatDuration(result.cooldown)}</b>. Nobody can make it faster.
        </p>
        {result.notes.map((note) => (
          <Notice kind="risk" key={note}>
            {note}
          </Notice>
        ))}
        {result.unverified ? (
          <Notice kind="risk" title="One safety check could not run here.">
            Nothing looks wrong. Your wallet's network did not give the old records that the check needs. Wait with locking more until the check passes.
          </Notice>
        ) : null}
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  if (stage === "work") {
    const busy = at !== null;
    return (
      <Modal title="Locking" lead={!busy ? undefined : at === "check" ? "Almost there." : waiting ? "Your wallet has it. If it needs more signatures, collect them there. This page waits for you." : "Your wallet is asking you to confirm."} busy={busy && !slow} onClose={props.onClose}>
        {steps ? (
          <ol class="wiz-work lock-work">
            {steps.map((step) => {
              const isDone = finished.includes(step.id);
              return (
                <li key={step.id} class={isDone ? "wiz-work-done" : step.id === at ? "wiz-work-now" : ""}>
                  <span class="wiz-work-dot" aria-hidden="true">
                    {isDone ? <Tick on /> : step.id === at ? <span class="spinner" /> : null}
                  </span>
                  {step.text}
                </li>
              );
            })}
          </ol>
        ) : (
          <p class="muted">Looking at the chain…</p>
        )}
        {slow && busy ? (
          <div class="wiz-slow">
            <p class="wiz-note">This takes longer than usual. Look in your wallet: the request may still wait for you there, or the network is busy.</p>
            <button
              type="button"
              class="link-button"
              onClick={() => {
                stop.current = true;
              }}
            >
              Stop waiting
            </button>
            <p class="wiz-note">That does not undo anything. This page then looks at the chain and shows where things stand.</p>
          </div>
        ) : null}
        {error ? <Notice kind="bad">{error}</Notice> : null}
        {!busy ? (
          <div class="modal-actions">
            <Button kind="primary" onClick={run}>
              {finished.length > 0 ? "Go on" : "Try again"}
            </Button>
            <Button
              kind="quiet"
              onClick={() => {
                // Back to the amounts only while nothing has moved: after that they would no longer match the chain.
                if (sent.current.size === 0 && finished.length === 0) setStage("form");
                else props.onClose();
              }}
            >
              {sent.current.size === 0 && finished.length === 0 ? "Back" : "Close"}
            </Button>
          </div>
        ) : null}
      </Modal>
    );
  }

  const count = batch ? 1 : (first ? (props.inspection.state === "missing" ? 2 : 1) : 0) + lines.filter((l) => !(first && l.index === 0)).length;
  return (
    <Modal title={first && nothing && props.loose ? "Switch on the time lock" : "Lock"} lead="Locked money cannot leave in a hurry. To get it back, you unlock it and wait." onClose={props.onClose}>
      <div class="wiz-fund">
        {entries.map((entry, row) => (
          <div class="deposit-row" key={row}>
            <AssetAmount
              assets={assets}
              asset={entry.asset}
              amount={entry.amount}
              balances={props.wallet}
              onAsset={(asset) => setEntries((all) => all.map((x, k) => (k === row ? { ...x, asset } : x)))}
              onAmount={(amount) => setEntries((all) => all.map((x, k) => (k === row ? { ...x, amount } : x)))}
              onMax={props.wallet[entry.asset] ? () => max(row) : undefined}
            />
            {entries.length > 1 ? (
              <button type="button" class="icon-button" aria-label="Remove this asset" onClick={() => setEntries((all) => all.filter((_, k) => k !== row))}>
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" class="link-button" onClick={() => setEntries((all) => [...all, { asset: 0, amount: "" }])}>
          Add another asset
        </button>
        {amountProblem ? <p class="field-error">{amountProblem}</p> : null}
      </div>

      {first ? (
        <>
          <div class="lock-time">
            <span class="lock-time-label">Unlocking will take</span>
            <div class="pills" role="radiogroup" aria-label="How long unlocking takes">
              {DELAYS.map((d, i) => (
                <button type="button" role="radio" aria-checked={delay === i} class={delay === i ? "pill pill-on" : "pill"} key={d.label} onClick={() => setDelay(i)}>
                  {d.label}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={delay === "custom"} class={delay === "custom" ? "pill pill-on" : "pill"} onClick={() => setDelay("custom")}>
                Other
              </button>
            </div>
            {delay === "custom" ? (
              <div class="custom-delay">
                <input class="input" inputMode="numeric" aria-label="Length" value={customValue} onInput={(event) => setCustomValue((event.target as HTMLInputElement).value.trim())} />
                <select class="input select" aria-label="Unit" value={customUnit} onChange={(event) => setCustomUnit((event.target as HTMLSelectElement).value as "hours" | "days")}>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
            ) : null}
            {cooldownProblem ? <p class="field-error">{cooldownProblem}</p> : null}
            <p class="hint">
              {cooldown !== null && cooldown > 30n * 86_400n && !cooldownProblem
                ? `That is a long time. In an emergency you cannot reach this money for ${delayText}.`
                : "Longer than a thief can wait in your home. Short enough that you can live with it. You can change it later, and that change waits too."}
            </p>
          </div>
          <Choice
            role="checkbox"
            on={agreed}
            title="I will keep control of the wallet I connected."
            text={`No new key is created. My wallet ${shortAddress(session.account)} is the only way to unlock. If I lose access to it, the locked money is gone.`}
            onClick={() => setAgreed(!agreed)}
          />
          {asks ? (
            <div class="wiz-give">
              <strong>{giveCents > 0 ? `Contribute ${giveText}` : "No contribution"}</strong>
              {contribution ? (
                <span class="wiz-give-coin">
                  about {formatAmount(contribution.amount, 18, 5)} {chain.native.symbol}, once, with your first lock.
                </span>
              ) : null}
              <p>Chronobox is free software. This pays for the work that keeps it safe and maintained.</p>
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
                      <input class="input" inputMode="decimal" aria-label="Another amount in dollars" placeholder={String(CONTRIBUTION_USD.hint)} value={giveOwn} onInput={(event) => setGiveOwn((event.target as HTMLInputElement).value)} />
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
        </>
      ) : (
        <p class="hint">Unlocking takes {delayText}.</p>
      )}

      <div class="modal-actions">
        <Button kind="primary" disabled={!ready} onClick={run}>
          {nothing ? (first && props.loose ? "Switch on the time lock" : "Lock") : `Lock ${listText(lines)}`}
        </Button>
      </div>
      {ready && count > 1 ? <p class="hint lock-count">Your wallet asks you to confirm {count} times, one step after the other.</p> : null}
    </Modal>
  );
}

/**
 * A wallet has one Chronobox, and this page is it. One case needs an address all the same: a
 * wallet that was handed the Chronobox of another wallet does not find it at its own address.
 */
function OpenOther(props: { chain: Chain }) {
  const [opening, setOpening] = useState(false);
  const [text, setText] = useState("");
  const [openChain, setOpenChain] = useState(props.chain.id);
  const target = chainById(openChain);
  const address = parseAddress(text);
  return (
    <div class="funds-other">
      <button type="button" class="link-button" onClick={() => setOpening(!opening)}>
        Open a Chronobox by its address
      </button>
      {opening ? <OpenByAddress chainId={openChain} onChain={setOpenChain} text={text} onText={setText} target={target && address ? vaultHref(target, address) : null} /> : null}
    </div>
  );
}
