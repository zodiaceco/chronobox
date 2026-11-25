/**
 * Before there is a Chronobox: what the connected wallet holds on this network, with a slider for
 * each asset. Moving one is the first step of a lock. The amounts go on into the setup, where they
 * are the step "Put money in now?", and the setup still asks for the network, the delay and the
 * promises first. Nothing is sent from here.
 *
 * Everything is read through the wallet, as in the setup.
 */
import { useEffect, useMemo, useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { type Reserves, coinMax, feeReserves, formatUsd, holdingOrder, keptCoin, readPrices, usdValue } from "../lib/deposit.ts";
import { formatAmount, parseUnits } from "../lib/format.ts";
import { setSetupAmounts } from "../lib/store.ts";
import { assetsOf, Button, type Session, useBalancesState } from "./common.tsx";
import { FundList } from "./fund.tsx";

export function WalletPreview(props: { session: Session; chain: Chain }) {
  const { session, chain } = props;
  const assets = useMemo(() => assetsOf(chain), [chain]);
  const [round, setRound] = useState(0);
  const state = useBalancesState(session.rpc, session.account, assets, round);
  const balances = state.balances;
  const [prices, setPrices] = useState<(bigint | null)[]>([]);
  const [reserve, setReserve] = useState<Reserves | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});

  useEffect(() => {
    setPrices([]);
    setReserve(null);
    setAmounts({});
    let stale = false;
    readPrices(session.rpc, chain, assets).then(
      (read) => !stale && setPrices(read),
      () => undefined,
    );
    feeReserves(session.rpc, chain.keep).then((r) => !stale && setReserve(r));
    return () => {
      stale = true;
    };
  }, [session.rpc, chain, assets]);

  const order = useMemo(() => {
    if (state.loading || balances.length !== assets.length) return null;
    const values = assets.map((a, i) => usdValue(balances[i] ?? 0n, a.decimals, prices[i] ?? null));
    return holdingOrder(assets, balances, values);
  }, [assets, state.loading, balances, prices]);
  const failed = !state.loading && !state.complete && balances.length === assets.length && balances.every((b) => b === null);

  // As in the setup: the coin never goes in whole, so the wallet can still pay to withdraw or cancel.
  const kept = keptCoin(reserve ?? { setup: 10n ** 16n, later: chain.keep }, balances[0] ?? 0n);
  const maxOf = (index: number): bigint => {
    const held = balances[index] ?? 0n;
    return assets[index]?.token ? held : coinMax(held, kept);
  };

  const chosen = (order ?? [])
    .map((index) => ({ index, asset: assets[index], text: (amounts[index] ?? "").trim(), amount: parseUnits(amounts[index] ?? "", assets[index].decimals) }))
    .filter((d) => d.text !== "" && d.amount !== 0n);
  const problem = chosen.some((d) => d.amount === null || d.amount > maxOf(d.index));
  const total =
    chosen.length > 0 && !problem
      ? chosen.reduce<bigint | null>((sum, d) => {
          const value = usdValue(d.amount ?? 0n, d.asset.decimals, prices[d.index] ?? null);
          return sum === null || value === null ? null : sum + value;
        }, 0n)
      : null;
  const list = chosen.map((d) => `${formatAmount(d.amount ?? 0n, d.asset.decimals)} ${d.asset.symbol}`);
  const listText = list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;

  const start = () => {
    setSetupAmounts(chain.id, session.account, problem ? {} : amounts);
    location.hash = "#/new";
  };

  return (
    <div class="preview">
      <h2>What your wallet holds on {chain.name}</h2>
      <p class="preview-lead">Pick what should not leave in a hurry. Next you choose how long every withdrawal waits.</p>
      <FundList
        assets={assets}
        order={order}
        balances={balances}
        prices={prices}
        maxOf={maxOf}
        limitOf={maxOf}
        amounts={amounts}
        onAmount={(index, text) => setAmounts((all) => ({ ...all, [index]: text }))}
        networkName={chain.name}
        failed={failed}
        onRetry={() => setRound((r) => r + 1)}
        calm
      />
      {total !== null ? <p class="fund-total">About {formatUsd(total)} goes in.</p> : null}
      <div class="preview-actions">
        <Button kind="primary" disabled={problem} onClick={start}>
          {chosen.length > 0 && !problem ? `Lock ${listText}` : "Create my Chronobox"}
        </Button>
        <p class="hint">{chosen.length > 0 ? "Nothing is sent yet. You check every step first." : "You can also put money in later."}</p>
      </div>
    </div>
  );
}
