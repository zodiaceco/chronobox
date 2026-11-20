import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Chain, CHAINS, chainById, chainByShort } from "./lib/chains.ts";
import { shortAddress } from "./lib/format.ts";
import { type Address, parseAddress, sameAddress } from "./lib/hex.ts";
import { buildChanged, lastAccount, lastWallet, setLastAccount, setLastWallet } from "./lib/store.ts";
import { type WalletOption, accountsOf, chainIdOf, errorText, isRejection, rpcOf, switchChain, watchWallets } from "./lib/wallet.ts";
import { AddressText, Button, Experimental, Modal, Notice, type Session } from "./ui/common.tsx";
import { CreatePage } from "./ui/create.tsx";
import { ByZodiac, Lockup } from "./ui/logo.tsx";
import { StartPage, vaultHref } from "./ui/start.tsx";
import { ImprintPage, PrivacyPage, TermsPage } from "./ui/legal.tsx";
import { TechnicalPage } from "./ui/technical.tsx";
import { VaultPage } from "./ui/vault.tsx";

/** `swapTo`: a link from the owner of a Chronobox to its guardian, with the new wallet that the owner asks for. */
type Route =
  | { page: "start" }
  | { page: "new" }
  | { page: "technical" }
  | { page: "privacy" }
  | { page: "terms" }
  | { page: "imprint" }
  | { page: "vault"; chain: Chain; safe: Address; swapTo: Address | null }
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
  const match = /^\/v\/([a-z0-9]+):(0x[0-9a-fA-F]{40})(?:\?to=(0x[0-9a-fA-F]{40}))?$/.exec(path);
  if (match) {
    const chain = chainByShort(match[1]);
    const safe = parseAddress(match[2]);
    const swapTo = match[3] ? parseAddress(match[3]) : null;
    if (chain && safe && (!match[3] || swapTo)) return { page: "vault", chain, safe, swapTo };
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

  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(location.hash));
      // "#how" is an anchor on the start page, not a route.
      if (location.hash.startsWith("#/")) window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => watchWallets(setWallets), []);

  const disconnect = useCallback(() => {
    detach.current?.();
    detach.current = null;
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
    const rpc = rpcOf(wallet.provider);
    detach.current?.();
    setSession({ wallet, account: accounts[0], chainId, rpc });
    setLastWallet(wallet.id);

    const onAccounts = (list: string[]) => {
      const next = list?.[0] ? parseAddress(list[0]) : null;
      if (!next) {
        detach.current?.();
        detach.current = null;
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
        chainIdOf(wallet.provider).then(
          (value) => setSession((s) => (s ? { ...s, chainId: value } : s)),
          () => undefined,
        );
        return;
      }
      setSession((s) => (s ? { ...s, chainId: next! } : s));
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
    const wanted = lastWallet();
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

  // Another account in the wallet is another person, as far as the app can tell. It gets its own
  // list, and not the Chronobox of the account before it in a view that can do nothing.
  useEffect(() => {
    if (!session) return;
    const before = lastAccount();
    setLastAccount(session.account);
    // A link that asks a guardian to agree is for the account that opens it. It stays.
    if (before && !sameAddress(before, session.account) && route.page === "vault" && !route.swapTo) location.hash = "#/";
  }, [session?.account]);

  const chain = useMemo(() => (session ? chainById(session.chainId) : undefined), [session?.chainId]);

  let body;
  if (route.page === "start") {
    body = <StartPage session={session} chain={chain} onConnect={() => setConnectOpen(true)} />;
  } else if (route.page === "technical") {
    body = <TechnicalPage />;
  } else if (route.page === "privacy") {
    body = <PrivacyPage />;
  } else if (route.page === "terms") {
    body = <TermsPage />;
  } else if (route.page === "imprint") {
    body = <ImprintPage />;
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
              switchChain(session.wallet.provider, target).catch((e) => {
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
    body = <VaultPage key={`${route.chain.id}:${route.safe}:${route.swapTo ?? ""}`} session={session} chain={route.chain} safe={route.safe} swapTo={route.swapTo} />;
  }

  return (
    <div class="shell">
      <header class="top">
        <Lockup />
        {session ? (
          <details class="wallet-chip">
            <summary>
              <span class="dot" aria-hidden="true" />
              {shortAddress(session.account)}
              <span class="muted">{chain?.name ?? `Chain ${session.chainId}`}</span>
            </summary>
            <div class="wallet-menu">
              <p class="muted">{session.wallet.name}</p>
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
        ) : (
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
          <a href="#/technical">How it is built</a> · <a href="#/terms">Terms</a> · <a href="#/privacy">Privacy</a> · <a href="#/imprint">Imprint</a>
          <span title="Version and build of the code that runs now. Build the same commit to compare.">
            {" "}
            · v{__VERSION__} · {BUILD}
          </span>
          {UPDATED ? " · updated since your last visit" : ""}
        </span>
      </footer>
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
          {connectError ? <Notice kind="bad">{connectError}</Notice> : null}
        </Modal>
      ) : null}
    </div>
  );
}
