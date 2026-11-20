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
import { formatAmount, formatDate, formatDuration, formatUnits, parseUnits, shortAddress, shortAmount } from "../lib/format.ts";
import { type Address, sameAddress } from "../lib/hex.ts";
import { blockHints, lookupAllowed, setLookupAllowed, txCache } from "../lib/store.ts";
import { findCoinPrice, findTokens, lookupHost } from "../lib/lookup.ts";
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
  classify,
  delayTxHash,
  itemStatus,
  queueTx,
  withdrawalTx,
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
import { AddressText, type Asset, AssetAmount, assetsOf, Button, Choice, Modal, Notice, type Session, SlowNote, Stripes, Tick, TokenBadge, useAction } from "./common.tsx";
import { DepositPanel } from "./deposit.tsx";
import { vaultHref } from "./start.tsx";
import { ChangeDelaySheet, ChangeWalletSheet, ChecksSheet, QueueSection, Row, TokenSheet, UnknownSheet, type VaultRef, WithdrawSheet, saveReminders, useChainClock } from "./vault.tsx";

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
  /** Dollars for one whole unit of an asset, by `keyOf`. From the index, so only with third-party services on. For the order of the list and a label, nothing else. */
  prices: Record<string, number>;
  /** False when the wallet's network refused the combined reads, so that only the main assets could be read. */
  allRead: boolean;
  /** True when the wallet's network took the balances only in small pieces. Everything was read, slowly. */
  slowReads: boolean;
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
  const prices = useRef<Record<string, number>>({});
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
        if (!lookup) {
          found.current = [];
          prices.current = {};
        }
        // Every balance is read through the wallet. The index only says which tokens to look at, and what they are worth.
        const reader = rpc;
        const listed = assetsOf(chain);
        const merge = () => [...listed, ...found.current.filter((f) => !listed.some((a) => sameAddress(a.token, f.token)))];
        let assets = merge();
        const before = new Map((last.current?.assets ?? []).map((a, i) => [keyOf(a), [last.current!.wallet[i], last.current!.box[i]] as const]));
        const some = assets.map((_, i) => i).filter((i) => {
          const known = before.get(keyOf(assets[i]));
          return assets[i].main || (known?.[0] ?? 0n) > 0n || (known?.[1] ?? 0n) > 0n;
        });
        let allRead = true;
        let slowReads = false;
        const readSome = async (indexes: number[]) => {
          const part = indexes.map((i) => assets[i]);
          const [mine, boxed] = await Promise.all([readBalances(reader, session.account, part), readBalances(reader, safe, part)]);
          if (!mine.complete || !boxed.complete) allRead = false;
          if (mine.reduced || boxed.reduced) slowReads = true;
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
          const next: Funds = { inspection, queue, assets, wallet: [...wallet], box: [...box], prices: { ...prices.current }, allRead, slowReads, now, fetchedAt };
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
          // The price of the coin is one small answer. It does not wait for the list of tokens, which can be long.
          later.push(
            findCoinPrice(chain).then(
              (coin) => {
                if (coin === null || stale) return;
                prices.current = { ...prices.current, native: coin };
                publish();
              },
              () => undefined,
            ),
          );
          // Which other tokens do the two addresses hold? The index names them. Decimals and balances are read from the chain.
          later.push(
            (async () => {
              // The index does not know an address that has never been used. That is an empty list, not a failure.
              const none = (): Awaited<ReturnType<typeof findTokens>> => [];
              const lists = await Promise.all([findTokens(chain, session.account).catch(none), findTokens(chain, safe).catch(none)]);
              const priced: Record<string, number> = {};
              for (const t of lists.flat()) if (t.usd !== null) priced[t.address.toLowerCase()] = t.usd;
              prices.current = { ...prices.current, ...priced };
              if (!stale) publish();
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
  // A network without an index has no third-party service to switch on.
  const host = lookupHost(chain);
  const [vpn, setVpn] = useState(false);
  const [trusts, setTrusts] = useState(false);
  const { data, error, refresh } = useFunds(session, chain, safe, lookup && host !== null);
  const now = useChainClock(data);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [preset, setPreset] = useState<number | null>(null);
  // The amount that was chosen in a row of the list, for the sheet that carries it out.
  const [presetAmount, setPresetAmount] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  // The item in the line that the person wants to cancel from a row of the list.
  const [askCancel, setAskCancel] = useState<bigint | null>(null);
  const [reserve, setReserve] = useState<bigint | null>(null);
  useEffect(() => {
    let stale = false;
    feeReserve(session.rpc).then((r) => !stale && setReserve(r));
    return () => {
      stale = true;
    };
  }, [session.rpc]);
  const [batch, setBatch] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // A wallet that is a contract, such as a Safe, exists on the network it was made on. On another network the same
  // address is not that wallet, and so the address of its Chronobox is not its Chronobox there either.
  const [contractWallet, setContractWallet] = useState(false);
  useEffect(() => {
    let stale = false;
    setContractWallet(false);
    session.rpc("eth_getCode", [session.account, "latest"]).then(
      // An account that has handed its code to a contract (EIP-7702) is still the same key on every network.
      (code: string) => !stale && setContractWallet(typeof code === "string" && code.length > 2 && !code.toLowerCase().startsWith("0xef0100")),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account, chain]);
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

  const network = contractWallet ? (
    <div class="funds-network-fixed">
      <p class="funds-network">
        <span class="eyebrow">Your funds on</span>
        <b>{chain.name}</b>
      </p>
      <Notice kind="info" title={`Your wallet is a Safe or another contract wallet on ${chain.name}.`}>
        It exists on this network only. Send money to your Chronobox on {chain.name} only: on any other network, this address is not
        yours.
      </Notice>
    </div>
  ) : (
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

  const { inspection, queue, assets, wallet, box, prices } = data;
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
  // What a row is worth in dollars, where the index has a price. Null where it has none.
  const worth = (r: (typeof held)[number]): number | null => {
    const price = prices[keyOf(r.asset)];
    return price === undefined ? null : (Number((r.unlocked ?? 0n) + (r.locked ?? 0n)) / 10 ** r.asset.decimals) * price;
  };
  // A token that only the index knows and that has no price can be anything, also something that was sent to the wallet unasked. Those are shown on request.
  const other = held.filter((r) => r.asset.found && worth(r) === null && !((r.locked ?? 0n) > 0n));
  // With prices: the most valuable first. What has no price keeps its place after that. Without prices the order is the app's own.
  const rows = held
    .filter((r) => showOther || !other.includes(r))
    .map((r, i) => ({ r, i, usd: worth(r) }))
    .sort((a, b) => (a.usd === null && b.usd === null ? a.i - b.i : a.usd === null ? 1 : b.usd === null ? -1 : b.usd - a.usd || a.i - b.i))
    .map(({ r, usd }) => ({ ...r, usd }));
  const dollars = (usd: number) => (usd >= 1 ? `about $${Math.round(usd).toLocaleString("en-US")}` : usd >= 0.01 ? `about $${usd.toFixed(2)}` : "under $0.01");
  // Money at the address of the Chronobox while the time lock is off. It is not protected.
  // A token that only the lookup knows does not count: anybody can send such a token to any address.
  const loose = assets.map((asset, i) => ({ asset, amount: mine || asset.found ? 0n : (box[i] ?? 0n) })).filter((l) => l.amount > 0n);
  const anyLocked = mine && box.some((b) => (b ?? 0n) > 0n);
  // What is on its way out, by asset: asked for and not collected yet.
  const pendingOf = new Map<string, Pending>();
  // The last waiting item of each asset. A cancel takes an item and every item before it, so this one takes all of the asset's.
  const lastWaiting = new Map<string, bigint>();
  if (vault) {
    for (const item of queue) {
      if (!item.tx) continue;
      const status = itemStatus(item, inspection.cooldown, inspection.expiration, now);
      if (status.phase === "expired") continue;
      const action = classify(item.tx, vault);
      if (action.kind !== "withdraw") continue;
      const key = action.token?.toLowerCase() ?? "native";
      const before = pendingOf.get(key) ?? { waiting: 0n, ready: 0n };
      if (status.phase === "ready") before.ready += action.amount;
      else {
        before.waiting += action.amount;
        lastWaiting.set(key, item.nonce);
      }
      pendingOf.set(key, before);
    }
  }
  /** The most of an unlocked balance that can be locked from a row: the coin keeps what the next steps cost. */
  const mostOf = (index: number): bigint => {
    const held = wallet[index] ?? 0n;
    if (index !== 0 || batch) return held;
    const room = (reserve ?? 0n) * (fresh ? 8n : 1n);
    return held > room ? held - room : 0n;
  };
  const anyUnlocked = wallet.some((b) => (b ?? 0n) > 0n);
  const unread = assets.filter((a, i) => a.main && (wallet[i] === null || box[i] === null)).map((a) => a.symbol);
  const close = () => {
    setSheet(null);
    setPreset(null);
    setPresetAmount(null);
    setOpenRow(null);
    refresh();
  };

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
        <Notice kind="risk" title={`${loose.map((l) => `${shortAmount(l.amount, l.asset.decimals)} ${l.asset.symbol}`).join(", ")} is not locked yet.`}>
          It sits at the address of your Chronobox, but the time lock is not on. Until it is, whoever holds your wallet can take it at once.{" "}
          <button type="button" class="link-button" onClick={() => setSheet("lock")}>
            Switch on the time lock
          </button>
        </Notice>
      ) : null}

      <div class="funds-table" aria-label="Your funds">
        <div class="funds-row funds-header">
          <span>Asset</span>
          <span>Unlocked</span>
          <span>Locked</span>
          <span>Total</span>
        </div>
        {rows.map((r) => (
          <FundRow
            key={keyOf(r.asset)}
            asset={r.asset}
            note={[r.usd !== null ? dollars(r.usd) : "", r.asset.found && r.asset.token ? shortAddress(r.asset.token) : ""].filter(Boolean).join(" · ") || null}
            inWallet={r.unlocked}
            inBox={mine ? box[r.index] : 0n}
            waiting={pendingOf.get(keyOf(r.asset))?.waiting ?? 0n}
            ready={pendingOf.get(keyOf(r.asset))?.ready ?? 0n}
            open={openRow === keyOf(r.asset)}
            onToggle={() => setOpenRow(openRow === keyOf(r.asset) ? null : keyOf(r.asset))}
            most={mostOf(r.index)}
            canLock={(fresh || verified) && !handedOver}
            canUnlock={mine}
            delayText={mine ? formatDuration(inspection.cooldown) : ""}
            onLock={(value) => {
              setPreset(r.index);
              setPresetAmount(formatUnits(value, r.asset.decimals));
              setSheet("lock");
            }}
            onUnlock={(value) => {
              setPreset(r.index);
              setPresetAmount(formatUnits(value, r.asset.decimals));
              setSheet("unlock");
            }}
            onRelock={
              canCancel && lastWaiting.has(keyOf(r.asset))
                ? () => setAskCancel(lastWaiting.get(keyOf(r.asset))!)
                : null
            }
          />
        ))}
      </div>
      {unread.length > 0 ? <p class="hint">The balance of {unread.join(", ")} could not be read now. It is not shown, and it is not gone.</p> : null}
      {unread.length === 0 && !data.allRead ? (
        <Notice kind="risk" title="Your wallet's network connection refused to read the list of tokens.">
          Only the main tokens are shown. Other tokens are not gone. Choose a more capable network connection (RPC) for {chain.name} in the
          network settings of your wallet. Until then you can add a token by its address.
        </Notice>
      ) : data.slowReads ? (
        <Notice kind="info" title="Your wallet's network connection is slow for this page.">
          It takes balances only in small pieces, so this list loads slowly. Everything was read. For a faster page, choose a more capable
          network connection (RPC) for {chain.name} in the network settings of your wallet.
        </Notice>
      ) : null}
      {other.length > 0 ? (
        <button type="button" class="link-button funds-more" onClick={() => setShowOther(!showOther)}>
          {showOther ? "Hide the other tokens" : `Show ${other.length} other ${other.length === 1 ? "token" : "tokens"}`}
        </button>
      ) : !lookup && host ? (
        <button type="button" class="link-button funds-more" onClick={() => setSheet("lookup")}>
          A token is missing? Find all my tokens and their value
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

      {vault ? <QueueSection session={session} chain={chain} vault={vault} inspection={inspection} queue={queue} assets={assets} now={now} canCancel={canCancel} batch={batch} askCancel={askCancel} onAskedCancel={() => setAskCancel(null)} refresh={() => refresh()} /> : null}

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
        {host ? <Row label="Third-party services" value={lookup ? "On" : "Off"} onClick={() => setSheet("lookup")} /> : null}
      </ul>


      {sheet === "lock" ? (
        <LockSheet session={session} chain={chain} safe={safe} inspection={inspection} assets={assets} wallet={wallet} loose={loose.length > 0} batch={batch} preset={preset ?? 0} presetAmount={presetAmount} onChanged={() => refresh()} onClose={close} />
      ) : null}
      {sheet === "unlock" && vault && batch ? (
        <UnlockManySheet session={session} chain={chain} vault={vault} inspection={inspection} assets={assets} balances={box} queue={queue} now={now} canCancel={canCancel} preset={presetAmount && preset !== null ? { asset: preset, amount: presetAmount } : null} onClose={close} />
      ) : null}
      {sheet === "unlock" && vault && !batch ? (
        <WithdrawSheet session={session} chain={chain} vault={vault} inspection={inspection} assets={assets} balances={box} queue={queue} now={now} canCancel={canCancel} preset={presetAmount && preset !== null ? { asset: preset, amount: presetAmount } : null} onClose={close} />
      ) : null}
      {sheet === "receive" ? (
        <Modal title="Lock from elsewhere" lead={contractWallet ? `Money that is sent to this address on ${chain.name} is locked when it arrives. Only on ${chain.name}: on another network this address is not yours.` : "Money that is sent to this address is locked when it arrives."} onClose={close}>
          <DepositPanel session={session} chain={chain} safe={safe} assets={assets} addressOnly />
        </Modal>
      ) : null}
      {sheet === "delay" && vault ? <ChangeDelaySheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "wallet" && vault ? <ChangeWalletSheet session={session} chain={chain} vault={vault} inspection={inspection} canCancel={canCancel} onClose={close} /> : null}
      {sheet === "token" ? <TokenSheet session={session} chain={chain} onClose={close} /> : null}
      {sheet === "checks" ? <ChecksSheet inspection={inspection} onClose={() => setSheet(null)} /> : null}
      {sheet === "lookup" && host ? (
        <Modal
          title="Third-party services"
          lead={`See every token you hold and what it is worth. For that, this page asks ${host}, which then sees your IP address with the address of your wallet and of your Chronobox.`}
          onClose={() => setSheet(null)}
        >
          {lookup ? (
            <div class="modal-actions">
              <Button kind="primary" onClick={() => chooseLookup(false)}>
                Switch it off
              </Button>
              <Button kind="quiet" onClick={() => setSheet(null)}>
                Keep it on
              </Button>
            </div>
          ) : (
            <>
              <div class="wiz-list">
                <Choice role="checkbox" on={vpn} title="I use a VPN." text="It hides my IP address from Blockscout." onClick={() => setVpn(!vpn)} />
                <Choice role="checkbox" on={trusts} title="I trust Blockscout not to leak my IP address." onClick={() => setTrusts(!trusts)} />
              </div>
              <div class="modal-actions">
                <Button kind="primary" disabled={!vpn && !trusts} onClick={() => chooseLookup(true)}>
                  Switch it on
                </Button>
                <Button kind="quiet" onClick={() => setSheet(null)}>
                  Keep it off
                </Button>
              </div>
            </>
          )}
        </Modal>
      ) : null}
    </section>
  );
}


/** What is on its way out of the lock for one asset: still waiting, and ready to be collected. */
type Pending = { waiting: bigint; ready: bigint };

/** A number in a cell that can be typed over. While it has the focus it shows what was typed, not what was understood. */
function EditCell(props: { label: string; value: bigint; decimals: number; locked?: boolean; onValue: (value: bigint) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      class={props.locked ? "input funds-edit funds-edit-locked" : "input funds-edit"}
      inputMode="decimal"
      autocomplete="off"
      aria-label={props.label}
      value={text ?? formatUnits(props.value, props.decimals)}
      onFocus={(event) => (event.target as HTMLInputElement).select()}
      onInput={(event) => {
        const typed = (event.target as HTMLInputElement).value;
        setText(typed);
        const parsed = parseUnits(typed, props.decimals);
        if (parsed !== null) props.onValue(parsed);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/**
 * One asset in the list. A press opens it: a bar shows the whole holding, unlocked on the left and
 * locked on the right, as in the columns above it. The handle is the border between the two, and
 * moving it moves money across. The two balances turn into fields that can be typed over. What is
 * already on its way out sits at the far right, striped and moving, and what waits to be
 * collected at the far left. The handle goes into neither.
 */
function FundRow(props: {
  asset: Asset;
  note: string | null;
  /** In the wallet. */
  inWallet: bigint | null;
  /** At the address of the Chronobox, whatever its state. */
  inBox: bigint | null;
  /** Asked for and still waiting: locked until the wait is over. */
  waiting: bigint;
  /** The wait is over: unlocked, and to be collected before it is in the wallet. */
  ready: bigint;
  open: boolean;
  onToggle: () => void;
  /** The most of the wallet's amount that can be locked: all of it, less what the wallet needs for fees. */
  most: bigint;
  canLock: boolean;
  canUnlock: boolean;
  delayText: string;
  onLock: (amount: bigint) => void;
  onUnlock: (amount: bigint) => void;
  /** Keep what is unlocking locked after all: cancels it. Null when this wallet cannot cancel. */
  onRelock: (() => void) | null;
}) {
  const { asset } = props;
  const W = props.inWallet ?? 0n;
  const B = props.inBox ?? 0n;
  const ready = props.ready > B ? B : props.ready;
  // What the list calls locked and unlocked. Money whose wait is over is unlocked, also before it is collected.
  const L = B - ready;
  const U = W + ready;
  const waiting = props.waiting > L ? L : props.waiting;
  const all = U + L;
  const [target, setTarget] = useState<bigint>(L);
  // The handle was moved into what is unlocking: keep that locked after all.
  const [relock, setRelock] = useState(false);
  // The balances are the starting point. When they change, or the row closes, the choice is gone.
  useEffect(() => {
    setTarget(L);
    setRelock(false);
  }, [props.open, U, L]);

  const lo = props.canUnlock ? waiting : L;
  const hi = props.canLock ? L + (props.most < W ? props.most : W) : L;
  const clamp = (value: bigint) => (value < lo ? lo : value > hi ? hi : value);
  const choice = clamp(target);
  const delta = choice - L;
  // A short form in the list, so that every amount fits its column. The exact amount is in the tooltip.
  const show = (value: bigint | null) => (value === null ? "–" : shortAmount(value, asset.decimals, value >= 1000n * 10n ** BigInt(asset.decimals) ? 2 : 4));
  const exact = (value: bigint | null) => (value === null ? undefined : `${formatAmount(value, asset.decimals, asset.decimals)} ${asset.symbol}`);
  const part = (value: bigint) => (all > 0n ? Number((value * 1000n) / all) : 0);
  const moved = `${shortAmount(delta < 0n ? -delta : delta, asset.decimals)} ${asset.symbol}`;
  const known = props.inWallet !== null && props.inBox !== null;

  const name = (
    <>
      <TokenBadge asset={asset} />
      <span class="funds-symbol">
        {asset.symbol}
        {props.note ? <small>{props.note}</small> : null}
      </span>
    </>
  );

  if (!props.open) {
    return (
      <button type="button" class="funds-row funds-row-button" aria-expanded="false" disabled={!known || all === 0n} onClick={props.onToggle}>
        <span class="funds-asset">{name}</span>
        <span class="funds-num" title={exact(known ? U : null)}>
          {show(known ? U : null)}
        </span>
        <span class={L > 0n ? "funds-num funds-locked" : "funds-num funds-none"} title={exact(known ? L : null)}>
          {show(known ? L : null)}
          {L > 0n ? <LockIcon /> : null}
        </span>
        <span class="funds-num funds-total" title={exact(known ? all : null)}>
          {show(known ? all : null)}
        </span>
      </button>
    );
  }

  // The bar, from the left: what is unlocked, then what is unlocking, then what stays locked. In thousandths.
  const pU = part(U);
  const pW = part(waiting);
  const canRelock = waiting > 0n && props.onRelock !== null;
  const keeping = relock && canRelock && delta === 0n;
  // The handle is the border of the locked part, so at rest it sits to the right of what is unlocking.
  // Further right, more is unlocked. Moved left into what is unlocking, it jumps to the far side of it: that part
  // stays locked after all. Further left still, more of the wallet's money is locked.
  const pos = delta > 0n ? part(all - choice) : delta < 0n ? part(all - (choice - waiting)) : keeping ? pU : pU + pW;
  const unlockedAfter = U - delta;
  const firmAfter = L + delta - (keeping ? 0n : waiting);
  const stillWaiting = keeping ? 0n : waiting;
  return (
    <div class="funds-item-open">
      <div class="funds-row">
        <button type="button" class="funds-asset funds-asset-button" aria-expanded="true" onClick={props.onToggle}>
          {name}
        </button>
        <EditCell label={`${asset.symbol} that stays unlocked`} value={U - delta} decimals={asset.decimals} onValue={(value) => setTarget(clamp(all - value))} />
        <EditCell label={`${asset.symbol} that is locked`} value={L + delta} decimals={asset.decimals} locked onValue={(value) => setTarget(clamp(value))} />
        <span class="funds-num funds-total" title={exact(all)}>
          {show(all)}
        </span>
      </div>
      <div class="mover">
        <div class="mover-bar">
          <svg class="mover-svg" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true">
            <rect class="mover-track" x="0" y="0" width="1000" height="14" />
            {ready > 0n ? <rect class="mover-ready" x="0" y="0" width={part(ready)} height="14" /> : null}
            <rect class="mover-locked" x={pU + pW} y="0" width={1000 - pU - pW} height="14" />
            {delta > 0n ? <rect class="mover-adding" x={pos} y="0" width={pU - pos} height="14" /> : null}
            {keeping ? <rect class="mover-adding" x={pU} y="0" width={pW} height="14" /> : <Stripes x={pU} width={pW} height={14} />}
            {delta < 0n ? <rect class="mover-leaving" x={pU + pW} y="0" width={pos - pU - pW} height="14" /> : null}
          </svg>
          <input
            class="mover-range"
            type="range"
            min="0"
            max="1000"
            step="1"
            aria-label={`Where unlocked ${asset.symbol} ends and locked ${asset.symbol} begins`}
            value={pos}
            onInput={(event) => {
              const at = Number((event.target as HTMLInputElement).value);
              // Everything to the left of the handle is unlocked. The ends are exact: all means all, not all but a rounding rest.
              const left = at >= 1000 ? all : at <= 0 ? 0n : (all * BigInt(at)) / 1000n;
              if (at >= pU && at <= pU + pW) {
                // On or inside what is unlocking. Its right edge is where things stand. Anywhere further in means "keep it locked".
                setTarget(L);
                setRelock(canRelock && at < pU + pW);
              } else if (at < pU) {
                setRelock(false);
                setTarget(clamp(all - left));
              } else {
                setRelock(false);
                setTarget(clamp(all - left + waiting));
              }
            }}
          />
        </div>
        <div class="mover-scale" aria-hidden="true">
          <span class="mover-part" style={{ flexGrow: Math.max(delta > 0n ? pos : pU, 1) }}>
            {unlockedAfter > 0n ? (firmAfter === 0n && stillWaiting === 0n ? "All unlocked" : "Unlocked") : ""}
          </span>
          {delta > 0n ? <span class="mover-part" style={{ flexGrow: Math.max(pU - pos, 1) }} /> : null}
          {stillWaiting > 0n || delta < 0n ? (
            <span class="mover-part mover-part-mid" style={{ flexGrow: Math.max(pW + (delta < 0n ? pos - pU - pW : 0), 1) }}>
              Unlocking
            </span>
          ) : null}
          <span class="mover-part mover-part-end" style={{ flexGrow: Math.max(1000 - (delta < 0n ? pos : keeping ? pU : pU + pW), 1) }}>
            {firmAfter > 0n ? (unlockedAfter === 0n && stillWaiting === 0n ? "All locked" : "Locked") : ""}
          </span>
        </div>
        {waiting > 0n ? (
          <p class="mover-note">
            {shortAmount(waiting, asset.decimals)} {asset.symbol} of this is unlocking: the striped part.
            {canRelock ? " Move the handle left over it to keep it locked." : ""}
          </p>
        ) : null}
        {ready > 0n ? (
          <p class="mover-note mover-note-ready">
            {shortAmount(ready, asset.decimals)} {asset.symbol} is unlocked and waits to be collected below. Collect it before you lock it again.
          </p>
        ) : null}
        <div class="mover-actions">
          {delta > 0n ? (
            <Button kind="primary" onClick={() => props.onLock(delta)}>
              Lock {moved}
            </Button>
          ) : delta < 0n ? (
            <Button onClick={() => props.onUnlock(-delta)}>
              Unlock {moved} · takes {props.delayText}
            </Button>
          ) : keeping ? (
            <Button kind="primary" onClick={props.onRelock!}>
              Keep {shortAmount(waiting, asset.decimals)} {asset.symbol} locked
            </Button>
          ) : (
            <Button disabled>Drag left to lock, right to unlock</Button>
          )}
        </div>
        {!props.canLock && W > 0n ? <p class="mover-note">Locking is not possible right now. See the notice above.</p> : null}
      </div>
    </div>
  );
}

type Line = { asset: Asset; index: number; amount: bigint };
type Step = { id: string; text: string };

type Entry = { asset: number; amount: string };

/**
 * Several assets at once, for a wallet that can send them as one: tick the ones you want, and
 * change the amount if it should not be all of it.
 */
function Picker(props: { assets: Asset[]; available: (bigint | null)[]; entries: Entry[]; most: (index: number) => bigint; onChange: (entries: Entry[]) => void; disabled?: boolean }) {
  const { assets, available, entries } = props;
  const shown = assets.map((asset, index) => ({ asset, index })).filter((a) => (available[a.index] ?? 0n) > 0n || entries.some((e) => e.asset === a.index));
  if (shown.length === 0) return <p class="hint">There is nothing here to choose from.</p>;
  return (
    <ul class="picker">
      {shown.map(({ asset, index }) => {
        const entry = entries.find((e) => e.asset === index);
        const toggle = () => {
          if (entry) return props.onChange(entries.filter((e) => e.asset !== index));
          const most = props.most(index);
          props.onChange([...entries, { asset: index, amount: most > 0n ? formatUnits(most, asset.decimals) : "" }]);
        };
        return (
          <li key={keyOf(asset)} class={entry ? "picker-row picker-on" : "picker-row"}>
            <button type="button" class="picker-toggle" role="checkbox" aria-checked={!!entry} disabled={props.disabled} onClick={toggle}>
              <Tick on={!!entry} />
              <TokenBadge asset={asset} />
              <span class="picker-name">
                <strong>{asset.symbol}</strong>
                <small>{available[index] === null ? "" : `${shortAmount(available[index]!, asset.decimals)} available`}</small>
              </span>
            </button>
            {entry ? (
              <input
                class="input picker-amount"
                inputMode="decimal"
                autocomplete="off"
                aria-label={`Amount of ${asset.symbol}`}
                value={entry.amount}
                disabled={props.disabled}
                onInput={(event) => props.onChange(entries.map((e) => (e.asset === index ? { ...e, amount: (event.target as HTMLInputElement).value } : e)))}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Unlocks several assets with one confirmation, for a wallet that can send several calls as one.
 * Each asset becomes its own item in the line of the time lock. They start their wait together,
 * and the page shows them as one group that is collected with one confirmation.
 */
function UnlockManySheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  assets: Asset[];
  balances: (bigint | null)[];
  queue: QueueItem[];
  now: bigint;
  canCancel: boolean;
  /** An asset and amount that were chosen in the list already: the sheet opens on the question about the wait. */
  preset?: Entry | null;
  onClose: () => void;
}) {
  const { session, chain, vault, inspection, assets } = props;
  const [entries, setEntries] = useState<Entry[]>(props.preset ? [props.preset] : []);
  const [stage, setStage] = useState<"form" | "confirm" | "done" | "unknown">(props.preset ? "confirm" : "form");
  const [agreed, setAgreed] = useState(false);
  const [queued, setQueued] = useState<{ nonce: bigint; at: bigint } | null>(null);
  const action = useAction();

  // What is in the line already will take its part out first.
  const available = useMemo(() => {
    const reserved = new Map<string, bigint>();
    for (const item of props.queue) {
      if (!item.tx) continue;
      if (itemStatus(item, inspection.cooldown, inspection.expiration, props.now).phase === "expired") continue;
      const a = classify(item.tx, vault);
      if (a.kind === "withdraw" || a.kind === "transfer-elsewhere") {
        const key = a.token?.toLowerCase() ?? "native";
        reserved.set(key, (reserved.get(key) ?? 0n) + a.amount);
      }
    }
    return assets.map((asset, i) => {
      const inside = props.balances[i];
      const taken = reserved.get(keyOf(asset)) ?? 0n;
      return inside === null ? null : inside > taken ? inside - taken : 0n;
    });
  }, [props.queue, props.balances, assets, vault, inspection.cooldown, inspection.expiration, props.now]);

  const parsed = entries.map((e) => ({ index: e.asset, asset: assets[e.asset], amount: parseUnits(e.amount, assets[e.asset].decimals) }));
  const lines = parsed.filter((p): p is Line => !!p.amount).sort((a, b) => a.index - b.index);
  const over = lines.find((l) => l.amount > (available[l.index] ?? 0n));
  const problem = parsed.some((p) => p.amount === null || p.amount === 0n)
    ? "Enter each amount as a plain number above zero, for example 1000 or 1.5."
    : over
      ? `You can unlock up to ${shortAmount(available[over.index] ?? 0n, over.asset.decimals)} ${over.asset.symbol}.`
      : null;
  const delayText = formatDuration(inspection.cooldown);
  const listText = lines.map((l) => `${shortAmount(l.amount, l.asset.decimals)} ${l.asset.symbol}`).join(", ");

  const submit = () =>
    action.run("queue", async (waiting) => {
      if (!sameAddress(vault.controller, session.account)) throw new Error(`Your wallet is on another account now. Only the wallet ${shortAddress(vault.controller)} can do this.`);
      const txs = lines.map((l) => withdrawalTx(vault.controller, l.asset.token, l.amount));
      // The items get the next numbers in the line. Their content is kept here, so that the page can show them without
      // reading old records. What is kept is used only when it gives the hash that is on chain.
      const seen = await inspect(session.rpc, vault.safe, blockHints(chain.id), { historyLater: true });
      const cache = txCache(chain.id, vault.delay);
      txs.forEach((tx, i) => cache.set(seen.queueNonce + BigInt(i), delayTxHash(tx), tx));
      await assertWallet(session.rpc, session.account, chain.id, chain.name);
      try {
        await sendBatch(session.wallet.provider, session.account, chain.id, txs.map((tx) => queueTx(vault.delay, tx)), undefined, waiting.shouldStop);
      } catch (e) {
        if (e instanceof BatchUnknown) return setStage("unknown");
        throw e;
      }
      setQueued({ nonce: seen.queueNonce, at: await chainTime(session.rpc) });
      setStage("done");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done" && queued) {
    const status = itemStatus({ createdAt: queued.at }, inspection.cooldown, inspection.expiration, queued.at);
    return (
      <Modal title="The wait has started." onClose={props.onClose}>
        <div class="sun-pass">
          <Dial size={96} play="drain" />
        </div>
        <p class="big-line">{listText}</p>
        <p>
          Come back on <b>{formatDate(status.readyAt)}</b>.
          {status.expiresAt !== null
            ? ` You then have ${formatDuration(inspection.expiration)} to collect it, all with one confirmation. After that time, this request is no longer valid and the money stays locked.`
            : " Then you can collect it, all with one confirmation."}
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
      <Modal title={`Unlock ${listText}`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <div class="delay-callout">
          <span class="delay-callout-label">This takes</span>
          <span class="delay-callout-value">{delayText}</span>
        </div>
        <ul class="plain-list">
          <li>Nobody can make it faster. No password, no threat, no stolen key. Not even you.</li>
          {props.canCancel ? <li>You can cancel it while it waits.</li> : null}
          <li>
            After the wait, you come back here and collect it. Then it is unlocked in your wallet <AddressText address={vault.controller} />.
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
    <Modal title="Unlock" lead="What do you need? Tick one or several." onClose={props.onClose}>
      <Picker assets={assets} available={available} entries={entries} most={(index) => available[index] ?? 0n} onChange={setEntries} />
      {problem ? <p class="field-error">{problem}</p> : <p class="hint">After {delayText}, you collect all of it here with one confirmation.</p>}
      <div class="modal-actions">
        <Button kind="primary" disabled={lines.length === 0 || !!problem} onClick={() => setStage("confirm")}>
          Continue
        </Button>
      </div>
    </Modal>
  );
}

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
  /** An amount that was chosen in the list already. */
  presetAmount?: string | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { session, chain, safe, assets, batch } = props;
  // What the page knew when the sheet opened. Every press reads the chain again.
  const [first] = useState(props.inspection.state === "missing" || props.inspection.state === "open");
  // A wallet that batches ticks assets in a list. A plain wallet starts with one line.
  const [entries, setEntries] = useState<Entry[]>(props.presetAmount ? [{ asset: props.preset, amount: props.presetAmount }] : batch ? [] : [{ asset: props.preset, amount: "" }]);
  const [delay, setDelay] = useState<number | "custom">(1);
  const [customValue, setCustomValue] = useState("3");
  const [customUnit, setCustomUnit] = useState<"hours" | "days">("days");
  const [agreed, setAgreed] = useState(false);
  const [giveUsd, setGiveUsd] = useState<number>(first ? CONTRIBUTION_USD.suggested : 0);
  const [giveOpen, setGiveOpen] = useState(false);
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
  // The contribution has been sent. A second press does not send it again.
  const gave = useRef(false);

  useEffect(() => {
    if (!RECEIVER) return;
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
  const asks = !!RECEIVER && price !== null;
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
        : `Your wallet has only ${shortAmount(props.wallet[tooMuch.index]!, tooMuch.asset.decimals)} ${tooMuch.asset.symbol}.`
      : null;
  const nothing = lines.length === 0;
  const ready = !amountProblem && !cooldownProblem && !giveProblem && (first ? agreed && (!nothing || props.loose) : !nothing);
  const listText = (list: Line[]) => list.map((l) => `${shortAmount(l.amount, l.asset.decimals)} ${l.asset.symbol}`).join(", ");

  /** The most of an asset that can be locked: all of it, less what the wallet needs for the fee and the contribution. */
  const most = (index: number): bigint => {
    const held = props.wallet[index] ?? 0n;
    const left = index === 0 ? held - (contribution?.amount ?? 0n) - feeRoom : held;
    return left > 0n ? left : 0n;
  };
  const max = (row: number) => {
    const index = entries[row].asset;
    if (!props.wallet[index]) return;
    const top = most(index);
    setEntries((all) => all.map((e, k) => (k === row ? { ...e, amount: top > 0n ? formatUnits(top, assets[index].decimals) : "0" } : e)));
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
      const give = gave.current ? null : contribution;

      // Does the wallet hold what is asked for? Read now, not when the sheet opened.
      const involved = [...new Set([0, ...todo.map((l) => l.index)])];
      const held = (await readBalances(rpc, session.account, involved.map((i) => assets[i]))).balances;
      for (const line of todo) {
        const has = held[involved.indexOf(line.index)];
        if (has !== null && line.amount > has) throw new Error(`Your wallet has only ${shortAmount(has, line.asset.decimals)} ${line.asset.symbol}.`);
      }
      const coin = todo.find((l) => l.index === 0)?.amount ?? 0n;
      if (held[0] !== null && !batch) {
        const room = (await feeReserve(rpc)) * (setup ? 8n : 1n);
        if (coin + (give?.amount ?? 0n) + room > held[0]) {
          throw new Error(`Leave some ${assets[0].symbol} unlocked for the network fee${give ? " and your contribution" : ""}. Lock less, or choose a lower contribution.`);
        }
      } else if (held[0] !== null && coin + (give?.amount ?? 0n) > held[0]) {
        throw new Error(`Your wallet has only ${shortAmount(held[0], 18)} ${assets[0].symbol}.`);
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
        plan.push({ id: "all", text: `Lock ${listText(todo)}` + giveLine });
      } else {
        for (const line of todo) plan.push({ id: `line-${line.index}`, text: `Lock ${listText([line])}` });
        if (give) plan.push({ id: "give", text: `Send your contribution of ${giveText}` });
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
          gave.current = true;
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
          gave.current = true;
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
          [...rest.map((l) => depositTx(safe, l.asset.token, l.amount)), ...(give && !gave.current ? [{ to: give.to, data: "0x" as const, value: give.amount }] : [])],
          () => setWaiting(true),
          () => stop.current,
        );
        moving = false;
        setWaiting(false);
        for (const line of rest) sent.current.add(line.index);
        if (give) gave.current = true;
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
            else if (arrived + 2n < line.amount) notes.current.push(`${shortAmount(arrived, line.asset.decimals)} ${line.asset.symbol} arrived. The token kept the rest.`);
          }
        }
      }
      if (give && !gave.current) {
        // A plain wallet sends the contribution of a later lock as a step of its own, after the money is locked.
        setAt("give");
        await sendAndWait(rpc, session.account, { to: give.to, data: "0x", value: give.amount }, send);
        gave.current = true;
        done("give");
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
          gave.current = true;
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

  const count = batch ? 1 : (first ? (props.inspection.state === "missing" ? 2 : 1) : 0) + lines.filter((l) => !(first && l.index === 0)).length + (contribution && !first ? 1 : 0);
  const givePills = (none: boolean) => (
    <div class="wiz-give-less">
      <div class="pills" role="radiogroup" aria-label="Contribution">
        {[CONTRIBUTION_USD.suggested, ...CONTRIBUTION_USD.less, ...(none ? [0] : [])].map((usd) => (
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
            {usd === 0 ? "None" : `$${usd}`}
          </button>
        ))}
        <label class="wiz-give-own">
          <span aria-hidden="true">$</span>
          <input class="input" inputMode="decimal" aria-label="Another amount in dollars" placeholder={String(CONTRIBUTION_USD.hint)} value={giveOwn} onInput={(event) => setGiveOwn((event.target as HTMLInputElement).value)} />
        </label>
      </div>
      {giveProblem ? <p class="field-error">{giveProblem}</p> : null}
    </div>
  );
  const giveCoin = contribution ? (
    <span class="wiz-give-coin">
      about {formatAmount(contribution.amount, 18, 5)} {chain.native.symbol}, with this lock.
    </span>
  ) : null;
  // The first lock asks plainly, with an amount selected. Every later lock offers it in one quiet line.
  const giveBox = !asks ? null : first ? (
    <div class="wiz-give">
      <strong>{giveCents > 0 ? `Contribute ${giveText}` : "No contribution"}</strong>
      {giveCoin}
      <p>
        Your contribution keeps Chronobox secure. It funds more audits of the contracts underneath and pays for this app, so that Chronobox
        needs no other business model, such as selling your data.
      </p>
      {giveLess ? (
        givePills(false)
      ) : (
        <button type="button" class="link-button" onClick={() => setGiveLess(true)}>
          Donate less
        </button>
      )}
    </div>
  ) : giveOpen ? (
    <div class="wiz-give wiz-give-quiet">
      <strong>{giveCents > 0 ? `Contribute ${giveText}` : "Add a contribution"}</strong>
      {giveCoin}
      {givePills(true)}
      <p>It funds more audits and pays for this app, so that Chronobox never has to sell your data.</p>
    </div>
  ) : (
    <p class="hint give-ask">
      Chronobox lives on contributions, not on your data.{" "}
      <button
        type="button"
        class="link-button"
        onClick={() => {
          setGiveOpen(true);
          setGiveUsd(CONTRIBUTION_USD.less[0] ?? CONTRIBUTION_USD.suggested);
        }}
      >
        Add one to this lock
      </button>
    </p>
  );

  return (
    <Modal title={first && nothing && props.loose ? "Switch on the time lock" : "Lock"} lead="Locked money cannot leave in a hurry. To get it back, you unlock it and wait." onClose={props.onClose}>
      <div class="wiz-fund">
        {batch ? (
          <Picker assets={assets} available={props.wallet} entries={entries} most={most} onChange={setEntries} />
        ) : (
          <>
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
          </>
        )}
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
          {giveBox}
        </>
      ) : (
        <>
          <p class="hint">Unlocking takes {delayText}.</p>
          {giveBox}
        </>
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
