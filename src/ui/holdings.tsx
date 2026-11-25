/**
 * What a wallet holds, next to what its Chronobox holds: one list with Unlocked (in the wallet),
 * Locked (in the Chronobox) and Total. The network it is about is chosen at its head.
 *
 * Everything is read through the wallet. Only with third-party services switched on does the page
 * ask a token index (Blockscout) which other tokens the two addresses hold, and what they are worth.
 * Decimals and balances of those tokens are still read on the chain.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import { call } from "../lib/abi.ts";
import { type Chain, CHAINS, chainById } from "../lib/chains.ts";
import { readBalances, readMany } from "../lib/chronobox.ts";
import { formatUsd, holdingOrder, readPrices, usdValue } from "../lib/deposit.ts";
import { formatAmount, shortAmount } from "../lib/format.ts";
import { type Address, sameAddress } from "../lib/hex.ts";
import { type FoundToken, findTokens, lookupHost } from "../lib/lookup.ts";
import { lookupAllowed, setLookupAllowed } from "../lib/store.ts";
import { isRejection } from "../lib/wallet.ts";
import { type Asset, assetsOf, Button, Choice, Modal, type Session, TokenBadge } from "./common.tsx";

/** A price from the index, in the form of the app's own prices: dollars with 8 decimals for one whole token. */
const fromUsd = (usd: number): bigint => BigInt(Math.round(usd * 1e8));
const keyOf = (asset: { token: Address | null }) => (asset.token ?? "native").toLowerCase();

export type Holdings = {
  assets: Asset[];
  /** In the wallet: unlocked. */
  wallet: (bigint | null)[];
  /** In the Chronobox: locked. Null where not read yet. */
  box: (bigint | null)[];
  prices: (bigint | null)[];
  loading: boolean;
};

/**
 * The holdings of a wallet and, if there is one, of its Chronobox. `boxBase` are the Chronobox's balances of
 * the app's own list, as the page has read them already. Only the tokens the index adds are read here for it.
 */
export function useHoldings(session: Session, chain: Chain, safe: Address | null, boxBase: (bigint | null)[] | null, round = 0): Holdings {
  const base = useMemo(() => assetsOf(chain), [chain]);
  const lookup = lookupAllowed() && !!chain.indexer;
  const [wallet, setWallet] = useState<(bigint | null)[] | null>(null);
  const [prices, setPrices] = useState<(bigint | null)[]>([]);
  const [found, setFound] = useState<{ assets: Asset[]; wallet: (bigint | null)[]; box: (bigint | null)[]; usd: (number | null)[] }>({ assets: [], wallet: [], box: [], usd: [] });

  useEffect(() => {
    let stale = false;
    setWallet(null);
    setFound({ assets: [], wallet: [], box: [], usd: [] });
    readBalances(session.rpc, session.account, base).then(
      (read) => !stale && setWallet(read.balances),
      () => !stale && setWallet(base.map(() => null)),
    );
    readPrices(session.rpc, chain, base).then(
      (read) => !stale && setPrices(read),
      () => undefined,
    );
    if (lookup) {
      (async () => {
        // The index does not know an address that has never been used. That is an empty list, not a failure.
        const none = (): FoundToken[] => [];
        const lists = await Promise.all([findTokens(chain, session.account).catch(none), safe ? findTokens(chain, safe).catch(none) : Promise.resolve(none())]);
        const fresh = lists.flat().filter((t, i, list) => list.findIndex((o) => sameAddress(o.address, t.address)) === i && !base.some((a) => sameAddress(a.token, t.address)));
        if (fresh.length === 0 || stale) return;
        // What the index says about a token is taken only where the chain agrees.
        // In pieces, as the balances are read: a weak network refuses one large request. A piece that fails leaves its tokens out.
        const decimals: (string | null)[] = [];
        for (let i = 0; i < fresh.length; i += 20) {
          const piece = fresh.slice(i, i + 20);
          decimals.push(...(await readMany(session.rpc, piece.map((t) => ({ to: t.address, data: call("decimals()") }))).catch(() => piece.map(() => null))));
          if (stale) return;
        }
        const good = fresh.filter((t, i) => {
          const answer = decimals[i];
          return answer !== null && answer.length >= 66 && BigInt(answer.slice(0, 66)) === BigInt(t.decimals);
        });
        const tokens = good.map((t) => ({ token: t.address }));
        const [mine, boxed] = await Promise.all([
          readBalances(session.rpc, session.account, tokens),
          safe ? readBalances(session.rpc, safe, tokens) : Promise.resolve({ balances: tokens.map(() => 0n as bigint | null) }),
        ]);
        if (stale) return;
        setFound({
          assets: good.map((t) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals, found: true })),
          wallet: mine.balances,
          box: boxed.balances,
          usd: good.map((t) => t.usd),
        });
      })().catch(() => undefined);
    }
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account, chain, safe, base, lookup, round]);

  return useMemo(() => {
    const assets = [...base, ...found.assets];
    return {
      assets,
      wallet: [...(wallet ?? base.map(() => null)), ...found.wallet],
      box: [...(safe ? (boxBase ?? base.map(() => null)) : base.map(() => 0n)), ...found.box],
      prices: [...base.map((_, i) => prices[i] ?? null), ...found.usd.map((u) => (u === null ? null : fromUsd(u)))],
      loading: wallet === null,
    };
  }, [base, found, wallet, boxBase, prices, safe]);
}

/** "Your funds on [network]". A wallet that is a contract exists on one network only: there the name is fixed. */
export function NetworkHeader(props: { session: Session; chain: Chain }) {
  const { session, chain } = props;
  const [contract, setContract] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setContract(false);
    // A Safe or another contract wallet has code. An account with a delegation (EIP-7702) is still an account on every network.
    session.rpc("eth_getCode", [session.account, "latest"]).then(
      (code) => !stale && setContract(typeof code === "string" && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account]);
  const choices = CHAINS.filter((c) => !c.testnet || __DEV__ || c.id === chain.id);
  return (
    <div class="funds-head">
      {contract ? (
        <p class="funds-network">
          <span class="eyebrow">Your funds on</span>
          <b>{chain.name}</b>
        </p>
      ) : (
        <label class="funds-network">
          <span class="eyebrow">Your funds on</span>
          <select
            class="input select"
            value={String(chain.id)}
            onChange={(event) => {
              const target = chainById(Number((event.target as HTMLSelectElement).value));
              (event.target as HTMLSelectElement).value = String(chain.id);
              if (!target || target.id === chain.id) return;
              setError(null);
              session.switchChain(target).then(
                // Another network has its own Chronobox, or none. The start page finds it.
                () => (location.hash = "#/"),
                (e) => {
                  if (!isRejection(e)) setError(`Your wallet did not switch. Switch to ${target.name} in your wallet itself.`);
                },
              );
            }}
          >
            {choices.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {contract ? <p class="notice-line">Your wallet is a Safe or another contract wallet on {chain.name}.</p> : null}
      {error ? <p class="field-error">{error}</p> : null}
    </div>
  );
}

/** One list: Unlocked, Locked and Total, for every asset in the wallet or in the Chronobox. Most valuable first. */
export function HoldingsTable(props: { chain: Chain; holdings: Holdings; onLookup?: () => void }) {
  const { chain, holdings } = props;
  const { assets, wallet, box, prices } = holdings;
  const total = (i: number) => (wallet[i] ?? 0n) + (box[i] ?? 0n);
  const values = assets.map((a, i) => usdValue(total(i), a.decimals, prices[i] ?? null));
  const order = holdingOrder(
    assets,
    assets.map((_, i) => total(i)),
    values,
  );
  // The coin is always there, so that an empty wallet still shows a row.
  const rows = order.includes(0) ? order : [0, ...order];
  const cell = (value: bigint | null, asset: Asset) =>
    value === null ? (
      <span class="muted">…</span>
    ) : (
      <span title={`${formatAmount(value, asset.decimals, asset.decimals)} ${asset.symbol}`}>{shortAmount(value, asset.decimals)}</span>
    );
  return (
    <div class="holdings">
      <div class="holdings-table" role="table" aria-label={`Your funds on ${chain.name}`}>
        <div class="holdings-row holdings-header" role="row">
          <span role="columnheader">Asset</span>
          <span role="columnheader">Unlocked</span>
          <span role="columnheader">Locked</span>
          <span role="columnheader">Total</span>
        </div>
        {rows.map((i) => {
          const asset = assets[i];
          const value = values[i];
          return (
            <div class="holdings-row" role="row" key={keyOf(asset)}>
              <span class="holdings-asset" role="cell">
                <TokenBadge asset={asset} />
                <span>
                  {asset.symbol}
                  {value !== null && value > 0n && asset.usd !== "one" ? <small>{formatUsd(value)}</small> : null}
                </span>
              </span>
              <span role="cell">{cell(holdings.loading ? null : wallet[i], asset)}</span>
              <span role="cell" class={(box[i] ?? 0n) > 0n ? "holdings-locked" : undefined}>
                {cell(box[i], asset)}
              </span>
              <span role="cell" class="muted">
                {holdings.loading || box[i] === null ? <span class="muted">…</span> : cell(total(i), asset)}
              </span>
            </div>
          );
        })}
      </div>
      {props.onLookup && chain.indexer && !lookupAllowed() ? (
        <button type="button" class="link-button holdings-lookup" onClick={props.onLookup}>
          A token is missing? Find all my tokens and their value
        </button>
      ) : null}
    </div>
  );
}

/**
 * The question before the page asks a third party. It says who learns what. One of the two ticks is needed.
 * `onAddToken`: the way that asks nobody, naming a token by its address.
 */
export function LookupSheet(props: { chain: Chain; onClose: () => void; onChanged: () => void; onAddToken?: () => void }) {
  const host = lookupHost(props.chain);
  const [vpn, setVpn] = useState(false);
  const [trusts, setTrusts] = useState(false);
  const on = lookupAllowed();
  const choose = (allowed: boolean) => {
    setLookupAllowed(allowed);
    props.onChanged();
    props.onClose();
  };
  if (!host) return null;
  return (
    <Modal
      title="Third-party services"
      lead={
        <>
          See every token you hold and what it is worth. For that, this page asks{" "}
          <a class="lead-link" href={props.chain.indexer} target="_blank" rel="noreferrer noopener">
            {host}
          </a>
          , which then sees your IP address with the address of your wallet.
        </>
      }
      onClose={props.onClose}
    >
      {on ? (
        <div class="modal-actions">
          <Button kind="primary" onClick={() => choose(false)}>
            Switch it off
          </Button>
          <Button kind="quiet" onClick={props.onClose}>
            Keep it on
          </Button>
        </div>
      ) : (
        <>
          {props.onAddToken ? <Button onClick={props.onAddToken}>Add a token by its address instead</Button> : null}
          <div class="wiz-list">
            <Choice role="checkbox" on={vpn} title="I use a VPN." text="It hides my IP address from Blockscout." onClick={() => setVpn(!vpn)} />
            <Choice role="checkbox" on={trusts} title="I trust Blockscout." text="I hope they won't leak my IP address." onClick={() => setTrusts(!trusts)} />
          </div>
          <div class="modal-actions">
            <Button kind="primary" disabled={!vpn && !trusts} onClick={() => choose(true)}>
              Switch it on
            </Button>
            <Button kind="quiet" onClick={props.onClose}>
              Keep it off
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The head and the list for the owner of a Chronobox. */
export function OwnerHoldings(props: {
  session: Session;
  chain: Chain;
  safe: Address;
  boxBase: (bigint | null)[] | null;
  round: number;
  onLookup: () => void;
  /** The tokens that only the index knows, with what the Chronobox holds of them: so they can be withdrawn too. */
  onFound?: (found: { assets: Asset[]; box: (bigint | null)[] }) => void;
}) {
  const holdings = useHoldings(props.session, props.chain, props.safe, props.boxBase, props.round);
  const baseCount = useMemo(() => assetsOf(props.chain).length, [props.chain]);
  const foundKey = holdings.assets.slice(baseCount).map((a) => a.token).join(",") + "|" + holdings.box.slice(baseCount).join(",");
  useEffect(() => {
    props.onFound?.({ assets: holdings.assets.slice(baseCount), box: holdings.box.slice(baseCount) });
  }, [foundKey]);
  return (
    <>
      <NetworkHeader session={props.session} chain={props.chain} />
      <HoldingsTable chain={props.chain} holdings={holdings} onLookup={props.onLookup} />
    </>
  );
}
