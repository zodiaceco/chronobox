/**
 * The start for a connected wallet. A wallet has one Chronobox, at one address on every network,
 * so there is nothing to choose: one read says whether it exists here. If it does, this is its page;
 * if not, this is the setup. No list, and no redirect.
 */
import { useEffect, useState } from "preact/hooks";
import { type Chain, CHAINS } from "../lib/chains.ts";
import { chronoboxExists, chronoboxOf } from "../lib/chronobox.ts";
import { shortAddress } from "../lib/format.ts";
import { sameAddress } from "../lib/hex.ts";
import { savedVaults } from "../lib/store.ts";
import { isRejection } from "../lib/wallet.ts";
import { Button, Notice, type Session } from "./common.tsx";
import { CreatePage } from "./create.tsx";
import { VaultPage } from "./vault.tsx";

export function HomePage(props: { session: Session; chain: Chain | undefined }) {
  const { session, chain } = props;
  const [state, setState] = useState<"reading" | "there" | "none" | "failed">("reading");
  const [round, setRound] = useState(0);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!chain) return;
    let stale = false;
    setState("reading");
    chronoboxExists(session.rpc, session.account).then(
      (exists) => !stale && setState(exists ? "there" : "none"),
      // An unanswered question is not "you have none": the setup must not start on it.
      () => !stale && setState("failed"),
    );
    return () => {
      stale = true;
    };
  }, [session.rpc, session.account, chain, round]);

  if (!chain) {
    return (
      <section class="page page-center">
        <h1>Chronobox does not work on this network.</h1>
        <p class="lead">Switch your wallet to one of these.</p>
        <div class="page-actions">
          {CHAINS.filter((c) => !c.testnet || __DEV__).map((c) => (
            <Button
              key={c.id}
              onClick={() => {
                setSwitchError(null);
                session.switchChain(c).catch((e) => {
                  if (!isRejection(e)) setSwitchError(`Your wallet did not switch. Switch to ${c.name} in your wallet itself.`);
                });
              }}
            >
              {c.name}
            </Button>
          ))}
        </div>
        {switchError ? <Notice kind="bad">{switchError}</Notice> : null}
      </section>
    );
  }
  if (state === "reading") {
    return (
      <section class="page page-center">
        <p class="wiz-note">Looking for your Chronobox…</p>
      </section>
    );
  }
  if (state === "failed") {
    return (
      <section class="page page-center">
        <h1>Your wallet's network did not answer.</h1>
        <p class="lead">Your money is not affected. Check the connection of your wallet and try again.</p>
        <div class="page-actions">
          <Button kind="primary" onClick={() => setRound((r) => r + 1)}>
            Try again
          </Button>
        </div>
      </section>
    );
  }
  if (state === "there") {
    const safe = chronoboxOf(session.account);
    return <VaultPage key={`${chain.id}:${safe}`} session={session} chain={chain} safe={safe} swap={null} />;
  }
  // No Chronobox yet: the setup. When it is done, the same read finds it, and this becomes its page.
  // Above it, which wallet this is about, but only for someone this browser has seen with a Chronobox of another
  // wallet, or of this wallet on another network: they may be on the wrong account. A first visit gets no note.
  const seenElsewhere = savedVaults().some((v) => !(v.wallet && sameAddress(v.wallet, session.account) && v.chainId === chain.id));
  return (
    <>
      {seenElsewhere ? (
        <div class="home-none">
          <Notice kind="info" title={`The wallet ${shortAddress(session.account)} has no Chronobox on ${chain.name} yet.`}>
            Set one up below. Is your Chronobox on another account? Switch to it in your wallet, or <a href="#/open">open a Chronobox by its address</a>.
          </Notice>
        </div>
      ) : null}
      <CreatePage session={session} chain={chain} onDone={() => setRound((r) => r + 1)} />
    </>
  );
}
