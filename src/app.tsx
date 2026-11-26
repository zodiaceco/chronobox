import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Chain, CHAINS, chainById, chainByShort, REPO } from "./lib/chains.ts";
import { shortAddress } from "./lib/format.ts";
import { type Address, parseAddress, sameAddress } from "./lib/hex.ts";
import { buildChanged, lastWallet, setLastAccount, setLastWallet } from "./lib/store.ts";
import { type WalletOption, accountsOf, chainIdOf, errorText, isRejection, rpcOf, switchChain, watchWallets } from "./lib/wallet.ts";
import { AddressText, Button, Experimental, Modal, Notice, type Session } from "./ui/common.tsx";
import { ALERTS, AlertsPage } from "./ui/alerts.tsx";
import { CreatePage } from "./ui/create.tsx";
import { DevBar } from "./ui/devbar.tsx";
import { ByZodiac, Lockup } from "./ui/logo.tsx";
import { StartPage, vaultHref } from "./ui/start.tsx";
import { ImprintPage, PrivacyPage, TermsPage } from "./ui/legal.tsx";
import { TechnicalPage } from "./ui/technical.tsx";
import { StatesPage } from "./ui/states.tsx";
import { VaultPage } from "./ui/vault.tsx";

/**
 * `swap`: a link from the owner of a Chronobox to its guardian, with the new wallet that the owner
 * asks for and the point of the line the change cancels up to. `upTo` is null in links of an older
 * version: they cannot be agreed to any more.
 * `alerts`: the page that the owner sends to their guardian. The guardian sets up alerts there,
 * without a wallet.
 */
type Route =
  | { page: "start" }
  | { page: "new" }
  | { page: "technical" }
  | { page: "privacy" }
  | { page: "states" }
  | { page: "terms" }
  | { page: "imprint" }
  | { page: "vault"; chain: Chain; safe: Address; swap: { to: Address; upTo: bigint | null } | null }
  | { page: "alerts"; chain: Chain; safe: Address }
  | { page: "unknown" };

/** The first 8 characters of the build hash, from index.html. "dev" in the dev server. */
const BUILD = (document.querySelector('meta[name="chronobox-build"]')?.getAttribute("content") ?? "unknown").slice(0, 8);
const UPDATED = buildChanged(BUILD);

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "");
  if (path === "" || path === "/" || !path.startsWith("/")) return { page: "start" };
  if (path === "/new") return { page: "new" };
  if (path === "/technical") return { page: "technical" };
  if (path === "/privacy") return { page: "privacy" };
  if (path === "/terms") return { page: "terms" };
  if (path === "/imprint") return { page: "imprint" };
  // Every state of the vault page, from `npm run scenarios`. Only in the dev server.
  if (__DEV__ && path === "/states") return { page: "states" };
  const alerts = /^\/alerts\/([a-z0-9]+):(0x[0-9a-fA-F]{40})$/.exec(path);
  if (alerts) {
    const chain = chainByShort(alerts[1]);
    const safe = parseAddress(alerts[2]);
    // Without a way to get alerts, the link leads to the Chronobox itself.
    if (chain && safe) return ALERTS ? { page: "alerts", chain, safe } : { page: "vault", chain, safe, swap: null };
  }
  const match = /^\/v\/([a-z0-9]+):(0x[0-9a-fA-F]{40})(?:\?to=(0x[0-9a-fA-F]{40})(?:&upTo=(\d{1,78}))?)?$/.exec(path);
  if (match) {
    const chain = chainByShort(match[1]);
    const safe = parseAddress(match[2]);
    const to = match[3] ? parseAddress(match[3]) : null;
    const swap = to ? { to, upTo: match[4] ? BigInt(match[4]) : null } : null;
    if (chain && safe && (!match[3] || to)) return { page: "vault", chain, safe, swap };
  }
  return { page: "unknown" };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const walletChip = useRef<HTMLDetailsElement>(null);
  const prevAccount = useRef<Address | null>(null);

  useEffect(() => {
    const onHash = () => {
      if (walletChip.current) walletChip.current.open = false;
      setRoute(parseRoute(location.hash));
      // "#how" is an anchor on the start page, not a route.
      if (location.hash.startsWith("#/")) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const closeMenu = (event: Event) => {
      if (!walletChip.current?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !walletChip.current.contains(event.target as Node)) {
        walletChip.current.open = false;
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, []);

  useEffect(() => watchWallets(setWallets), []);

  const disconnect = useCallback(() => {
    detach.current?.();
    detach.current = null;
    prevAccount.current = null;
    setSession(null);
    setLastWallet(null);
  }, []);

  const connect = useCallback(async (wallet: WalletOption, prompt: boolean) => {
    const accounts = await accountsOf(wallet.provider, prompt);
    if (accounts.length === 0) {
      if (prompt) throw new Error("Your wallet did not share an account. Unlock it, then try again.");
      return;
    }
    const chainId = await chainIdOf(wallet.provider);
    const applyChain = (next: number) =>
      setSession((s) => (s && s.chainId !== next ? { ...s, chainId: next, rpc: rpcOf(wallet.provider) } : s));
    const switchTo = async (target: Chain) => {
      await switchChain(wallet.provider, target);
      // Some wallets resolve without emitting chainChanged. Read the active chain directly to stay in sync.
      const actual = await chainIdOf(wallet.provider).catch(() => target.id);
      applyChain(actual);
    };
    const rpc = rpcOf(wallet.provider);
    detach.current?.();
    setSession({ wallet, account: accounts[0], chainId, rpc, switchChain: switchTo });
    setLastWallet(wallet.id);

    const onAccounts = (list: string[]) => {
      const next = list?.[0] ? parseAddress(list[0]) : null;
      if (!next) {
        detach.current?.();
        detach.current = null;
        prevAccount.current = null;
        setSession(null);
      } else {
        setSession((s) => (s ? { ...s, account: next } : s));
      }
    };
    const onChain = (id: string) => {
      // Wallets send this as hex text. One that sends something else is asked directly.
      let next: number | null = null;
      try {
        next = Number(BigInt(id));
      } catch {
        chainIdOf(wallet.provider).then(applyChain, () => undefined);
        return;
      }
      applyChain(next);
    };
    wallet.provider.on?.("accountsChanged", onAccounts);
    wallet.provider.on?.("chainChanged", onChain);
    detach.current = () => {
      wallet.provider.removeListener?.("accountsChanged", onAccounts);
      wallet.provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  // Reconnect without a prompt when the wallet already knows this page.
  useEffect(() => {
    if (session) return;
    // In the dev server, a link that names a test wallet (?as= or ?account=) opens with it at once.
    const wanted = lastWallet() ?? (__DEV__ && /[?&](as|account)=/.test(location.search) ? "dev.anvil" : null);
    const wallet = wallets.find((w) => w.id === wanted);
    if (wallet) connect(wallet, false).catch(() => undefined);
  }, [wallets, session, connect]);

  const choose = async (wallet: WalletOption) => {
    // One request at a time: a second one makes many wallets answer "already pending".
    if (connecting) return;
    setConnectError(null);
    setConnecting(wallet.id);
    try {
      await connect(wallet, true);
      setConnectOpen(false);
    } catch (e) {
      setConnectError(errorText(e));
    } finally {
      setConnecting(null);
    }
  };

  // A live account switch inside the wallet while looking at a Chronobox goes back to the start,
  // so the new account sees its own list. Freshly connecting on a deep link (e.g. a guardian link) stays.
  useEffect(() => {
    if (!session) return;
    const before = prevAccount.current;
    prevAccount.current = session.account;
    setLastAccount(session.account);
    if (before && !sameAddress(before, session.account) && route.page === "vault" && !route.swap) location.hash = "#/";
  }, [session?.account]);

  const chain = useMemo(() => (session ? chainById(session.chainId) : undefined), [session?.chainId]);

  let body;
  if (route.page === "start") {
    body = <StartPage session={session} chain={chain} connectOpen={connectOpen} onConnect={() => setConnectOpen(true)} />;
  } else if (route.page === "technical") {
    body = <TechnicalPage />;
  } else if (route.page === "privacy") {
    body = <PrivacyPage />;
  } else if (route.page === "terms") {
    body = <TermsPage />;
  } else if (route.page === "imprint") {
    body = <ImprintPage />;
  } else if (route.page === "states") {
    // Only the dev server has this route; the production build leaves the page out.
    body = __DEV__ ? <StatesPage /> : null;
  } else if (route.page === "alerts") {
    body = <AlertsPage key={`${route.chain.id}:${route.safe}`} chain={route.chain} safe={route.safe} />;
  } else if (route.page === "unknown") {
    body = (
      <section class="page page-center">
        <h1>This link does not lead to a Chronobox.</h1>
        <p class="lead">Check that the address is complete.</p>
        <div class="page-actions">
          <a class="button button-primary" href="#/">
            Go to the start
          </a>
        </div>
      </section>
    );
  } else if (!session) {
    body = (
      <section class="page page-center">
        <h1>{route.page === "new" ? "First, connect your wallet." : "Connect your wallet to open this Chronobox."}</h1>
        <p class="lead">
          {route.page === "new" ? "It will control your Chronobox." : "Chronobox has no server. It reads everything through your wallet."}
        </p>
        <div class="page-actions">
          <Button kind="primary" onClick={() => setConnectOpen(true)}>
            Connect wallet
          </Button>
        </div>
      </section>
    );
  } else if (route.page === "new") {
    body = (
      <CreatePage
        session={session}
        chain={chain}
        onDone={(c, safe) => {
          location.hash = vaultHref(c, safe);
        }}
      />
    );
  } else if (route.chain.id !== session.chainId) {
    const target = route.chain;
    body = (
      <section class="page page-center">
        <h1>This Chronobox lives on {target.name}.</h1>
        <p class="lead">Your wallet is on {chain?.name ?? "another network"}. Switch to open it.</p>
        <div class="page-actions">
          <Button
            kind="primary"
            onClick={() => {
              setSwitchError(null);
              session.switchChain(target).catch((e) => {
                if (!isRejection(e)) setSwitchError(`Your wallet did not switch. Switch to ${target.name} in your wallet itself.`);
              });
            }}
          >
            Switch to {target.name}
          </Button>
        </div>
        {switchError ? <Notice kind="bad">{switchError}</Notice> : null}
      </section>
    );
  } else {
    body = <VaultPage key={`${route.chain.id}:${route.safe}:${route.swap?.to ?? ""}:${route.swap?.upTo ?? ""}`} session={session} chain={route.chain} safe={route.safe} swap={route.swap} />;
  }

  return (
    <div class="shell">
      <header class="top">
        <Lockup />
        {session ? (
          <details class="wallet-chip" ref={walletChip}>
            <summary>
              <span class="dot" aria-hidden="true" />
              {shortAddress(session.account)}
              <span class="muted">{chain?.name ?? `Chain ${session.chainId}`}</span>
            </summary>
            <div class="wallet-menu">
              <p class="muted">
                {session.wallet.name} · {chain?.name ?? `Chain ${session.chainId}`}
              </p>
              <p class="mono">
                <AddressText address={session.account} full />
              </p>
              <Button small onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          </details>
        ) : route.page === "start" ? (
          // The landing page has its own button to connect. This corner says that the app is new.
          <Experimental />
        ) : route.page === "alerts" ? null : ( // The guardian's alert page needs no wallet, so it does not ask for one.
          // The welcome screen has its own button. Everywhere else this is the way in.
          <Button small onClick={() => setConnectOpen(true)}>
            Connect wallet
          </Button>
        )}
      </header>

      <main>{body}</main>

      <footer class="foot">
        <ByZodiac />
        <span class="muted">
          <a href="#/technical">How it is built</a> · <a href="#/terms">Terms</a> · <a href="#/privacy">Privacy</a> · <a href="#/imprint">Imprint</a> ·{" "}
          <a href={REPO} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          <span title="Build of the code that runs now. Build the same commit to compare.">
            {" "}
            · {BUILD}
          </span>
          {UPDATED ? " · updated since your last visit" : ""}
        </span>
      </footer>
      {__DEV__ ? <DevBar /> : null}
      <div class="horizon" aria-hidden="true" />

      {connectOpen ? (
        <Modal title="Connect your wallet" lead={wallets.length === 0 ? undefined : "It will control your Chronobox."} onClose={() => setConnectOpen(false)}>
          {wallets.length === 0 ? (
            <p>
              There is no wallet in this browser yet. Add one, such as Rabby or MetaMask, or open this page inside your wallet app. Then
              come back here.
            </p>
          ) : (
            <ul class="wallet-list">
              {wallets.map((wallet) => (
                <li key={wallet.id}>
                  <button type="button" disabled={connecting !== null} onClick={() => choose(wallet)}>
                    {wallet.icon ? <img src={wallet.icon} alt="" width="28" height="28" /> : <span class="wallet-blank" />}
                    {wallet.name}
                    {connecting === wallet.id ? <span class="wallet-wait">Look in your wallet…</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/* Chronobox has no WalletConnect, so a Safe needs a wallet in this browser that acts as it. */}
          <p class="connect-safe">
            <strong>Using a Safe?</strong> Chronobox has no WalletConnect. Add a wallet to this browser that can act as your Safe, such as{" "}
            <a href="https://www.ambire.com/" target="_blank" rel="noopener noreferrer">
              Ambire
            </a>
            ,{" "}
            <a href="https://rabby.io/" target="_blank" rel="noopener noreferrer">
              Rabby
            </a>{" "}
            or{" "}
            <a href="https://chromewebstore.google.com/detail/zodiac-pilot/jklckajipokenkbbodifahogmidkekcb" target="_blank" rel="noopener noreferrer">
              Zodiac Pilot
            </a>
            . Then choose it here.
          </p>
          {connectError ? <Notice kind="bad">{connectError}</Notice> : null}
        </Modal>
      ) : null}
    </div>
  );
}
