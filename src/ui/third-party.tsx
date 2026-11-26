/**
 * Third-party services, off until the person switches them on: the page then asks a token index
 * (Blockscout) which other tokens the Chronobox holds. Their decimals and balances are still read
 * on the chain, through the wallet. Without the switch the page asks nobody but the wallet.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { call } from "../lib/abi.ts";
import type { Chain } from "../lib/chains.ts";
import { readBalances, readManyInPieces } from "../lib/chronobox.ts";
import { type Address, sameAddress } from "../lib/hex.ts";
import { findTokens, lookupHost } from "../lib/lookup.ts";
import { lookupAllowed, setLookupAllowed } from "../lib/store.ts";
import { type Asset, assetsOf, Button, Choice, Modal, type Session } from "./common.tsx";

export type Found = { assets: Asset[]; box: (bigint | null)[] };

/** The tokens of the Chronobox that the app's own lists do not know, with their balances. Empty unless third-party services are on. */
export function useFoundTokens(session: Session, chain: Chain, safe: Address, enabled: boolean, round = 0): Found {
  const [found, setFound] = useState<Found>({ assets: [], box: [] });
  const on = enabled && lookupAllowed() && !!chain.indexer;
  const scope = `${chain.id}:${safe.toLowerCase()}:${on ? "1" : "0"}`;
  const lastScope = useRef(scope);
  useEffect(() => {
    let stale = false;
    if (lastScope.current !== scope || !on) {
      lastScope.current = scope;
      setFound({ assets: [], box: [] });
    }
    if (!on) return;
    (async () => {
      const base = assetsOf(chain);
      const listed = await findTokens(chain, safe).catch(() => []);
      const fresh = listed.filter((t, i) => listed.findIndex((o) => sameAddress(o.address, t.address)) === i && !base.some((a) => sameAddress(a.token, t.address)));
      if (stale) return;
      if (fresh.length === 0) return setFound({ assets: [], box: [] });
      // What the index says about a token is taken only where the chain agrees. In pieces, as the balances are read:
      // a weak network refuses one large request. A piece that fails at every size leaves its tokens out.
      const decimals = await readManyInPieces(
        session.rpc,
        fresh.map((t) => ({ to: t.address, data: call("decimals()") })),
      );
      if (stale) return;
      const good = fresh.filter((t, i) => {
        const answer = decimals[i];
        return answer !== null && /^0x[0-9a-fA-F]{64,}$/.test(answer) && BigInt(answer.slice(0, 66)) === BigInt(t.decimals);
      });
      if (good.length === 0) return setFound({ assets: [], box: [] });
      const read = await readBalances(session.rpc, safe, good.map((t) => ({ token: t.address })));
      if (stale) return;
      setFound({ assets: good.map((t) => ({ token: t.address, symbol: t.symbol, decimals: t.decimals, found: true })), box: read.balances });
    })().catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [session.rpc, chain, safe, on, scope, round]);
  return found;
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
          See every token in your Chronobox. For that, this page asks{" "}
          <a class="lead-link" href={props.chain.indexer} target="_blank" rel="noreferrer noopener">
            {host}
          </a>
          , which then sees your IP address with the address of your Chronobox.
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
