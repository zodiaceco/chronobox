/**
 * The first screen. Before a wallet is connected it says what Chronobox is and
 * offers one thing to do. After that it is the list of your Chronoboxes.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { type Chain, CHAINS, chainById, REPO } from "../lib/chains.ts";
import { type Address, parseAddress } from "../lib/hex.ts";
import { vaultsOf } from "../lib/store.ts";
import { isRejection } from "../lib/wallet.ts";
import { chronoboxExists, chronoboxOf } from "../lib/chronobox.ts";
import { Button, Experimental, type Session } from "./common.tsx";
import { HowItWorks } from "./how.tsx";
import { Mark } from "./logo.tsx";

// The film and its poster get a tag in their address. A new film has a new address, so no browser shows an old copy.
// In the dev build the tag is new on every page load.
const FILM_TAG = __DEV__ ? String(Date.now()) : __FILM__;
// Two sizes of the same film. A large screen gets the larger one, which stays sharp there and when the film
// fills the screen. Every other screen gets 1920 x 1080, which every phone can play.
const LARGE_SCREEN = typeof screen !== "undefined" && Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) >= 2200;
const FILM = `./chronobox-film${LARGE_SCREEN ? "-1440" : ""}.mp4?v=${FILM_TAG}`;
const POSTER = `./chronobox-film-poster.jpg?v=${FILM_TAG}`;

type Row = { chain: Chain; safe: Address; title: string; note: string };

export function vaultHref(chain: Chain, safe: Address): string {
  return `#/v/${chain.short}:${safe}`;
}

function shortOf(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function StartPage(props: { session: Session | null; chain: Chain | undefined; connectOpen: boolean; onConnect: () => void }) {
  const { session, chain } = props;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [openText, setOpenText] = useState("");
  const [film, setFilm] = useState(false);
  // "Get started" was pressed here: when the wallet is connected and has no Chronobox, go straight on to the setup.
  const wantsSetup = useRef(false);
  // The wallet's network did not answer. That is not the same as "this wallet has no Chronobox".
  const [readFailed, setReadFailed] = useState(false);
  const [again, setAgain] = useState(0);
  const [openChain, setOpenChain] = useState(chain?.id ?? CHAINS[0].id);

  useEffect(() => {
    if (!props.connectOpen && !session) wantsSetup.current = false;
  }, [props.connectOpen, session]);

  useEffect(() => {
    if (chain) setOpenChain(chain.id);
  }, [chain]);

  useEffect(() => {
    if (!session) return setRows(null);
    let stale = false;
    setRows(null);
    setReadFailed(false);
    (async () => {
      // Chronoboxes on other networks come from this browser's memory.
      const list: Row[] = [];
      for (const saved of vaultsOf(session.account)) {
        const other = chainById(saved.chainId);
        if (other && other.id !== chain?.id) list.push({ chain: other, safe: saved.safe, title: "Chronobox", note: other.name });
      }
      if (chain) {
        try {
          // A wallet has one Chronobox, at one address: one read. Where it has it, that is the page; where it has none,
          // the setup is. There is no list to choose from. Only when the chain cannot be read does the page show what
          // this browser remembers (below).
          const own = chronoboxOf(session.account);
          const exists = await chronoboxExists(session.rpc, session.account);
          if (stale) return;
          location.hash = exists ? vaultHref(chain, own) : "#/new";
          return;
        } catch {
          // The wallet could not read the chain. Show what the browser remembers, and say so.
          for (const saved of vaultsOf(session.account)) {
            if (saved.chainId === chain.id) list.unshift({ chain, safe: saved.safe, title: "Could not read it now", note: chain.name });
          }
          if (!stale) setReadFailed(true);
        }
      }
      if (!stale) setRows(list);
    })();
    return () => {
      stale = true;
    };
  }, [session?.rpc, session?.account, chain, again]);

  useEffect(() => {
    if (!wantsSetup.current || !session || rows === null) return;
    wantsSetup.current = false;
    // Only when the chain was read: an unanswered question must not look like "you have none".
    if (rows.length === 0 && !readFailed) location.hash = "#/new";
  }, [session, rows, readFailed]);

  const readNotice = readFailed ? (
    <p class="read-failed" role="status">
      Your wallet's network did not answer, so this list may be incomplete.{" "}
      <button type="button" class="link-button" onClick={() => setAgain(again + 1)}>
        Try again
      </button>
    </p>
  ) : null;

  // The app reads through the wallet, and the wallet is on one network. The others are one tap away.
  const [switchError, setSwitchError] = useState<string | null>(null);
  const others = CHAINS.filter((c) => c.id !== chain?.id && (!c.testnet || __DEV__));
  const lookElsewhere =
    session && rows !== null ? (
      <div class="info-box">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path d="M10 9.2v4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          <circle cx="10" cy="6.3" r="1.1" fill="currentColor" />
        </svg>
        <p>
        {chain ? `This is what your wallet has on ${chain.name}, and what this browser has seen before.` : "Chronobox does not work on the network of your wallet."} Look on{" "}
        {others.map((c, i) => (
          <>
            {i === 0 ? "" : i === others.length - 1 ? " or " : ", "}
            <button
              type="button"
              class="link-button"
              key={c.id}
              onClick={() => {
                setSwitchError(null);
                session.switchChain(c).catch((e) => {
                  if (!isRejection(e)) setSwitchError(`Your wallet did not switch. Switch to ${c.name} in your wallet itself.`);
                });
              }}
            >
              {c.name}
            </button>
          </>
        ))}
        .{switchError ? <span class="look-elsewhere-error"> {switchError}</span> : null}
        </p>
      </div>
    ) : null;

  const openAddress = parseAddress(openText);
  const openTarget = chainById(openChain);
  const hasSome = !!rows && rows.length > 0;
  const rememberedSome = !!session && rows === null && vaultsOf(session.account).length > 0;

  // Returning users with remembered Chronoboxes wait in the home layout instead of flashing the landing page.
  if (rememberedSome) {
    return (
      <div class="start">
        <section class="home">
          <h1>Your Chronobox</h1>
          <p class="wiz-note">Looking for your Chronobox…</p>
        </section>
      </div>
    );
  }

  // With Chronoboxes: the list is the page. Without: the welcome.
  if (session && hasSome) {
    return (
      <div class="start">
        <section class="home">
          {/* One of its own, on each network. More rows are on other networks, or ones it watches as a guardian. */}
          <h1>{rows!.length === 1 ? "Your Chronobox" : "Your Chronoboxes"}</h1>
          {readNotice}
          <ul class="vault-list">
            {rows!.map((row) => (
              <li key={`${row.chain.id}:${row.safe}`}>
                <a href={vaultHref(row.chain, row.safe)}>
                  <Mark size={36} />
                  <span class="vault-list-text">
                    <strong>{row.title}</strong>
                    <span>
                      {row.note} · {shortOf(row.safe)}
                    </span>
                  </span>
                  <svg class="row-chevron" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
                    <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </a>
              </li>
            ))}
          </ul>
          <div class="home-actions">
            <button type="button" class="link-button" onClick={() => setOpening(!opening)}>
              Open one by its address
            </button>
          </div>
          {opening ? <OpenByAddress chainId={openChain} onChain={setOpenChain} text={openText} onText={setOpenText} target={openTarget && openAddress ? vaultHref(openTarget, openAddress) : null} /> : null}
          {lookElsewhere}
        </section>
      </div>
    );
  }

  return (
    <div class="start">
      {/* Without a wallet the notice is in the header. With one, the wallet is there, so the notice is here. */}
      {session ? (
        <div class="experimental-row">
          <Experimental />
        </div>
      ) : null}
      <section class="hero">
        <h1>Money that cannot leave in a hurry.</h1>
        <p class="lead">Every withdrawal has to wait. No password, no threat and no stolen key can make it faster. Not even you can.</p>
        <div class="hero-actions">
          {!session ? (
            <Button
              kind="primary"
              onClick={() => {
                wantsSetup.current = true;
                props.onConnect();
              }}
            >
              Get started
            </Button>
          ) : rows === null ? (
            <p class="muted">Looking for your Chronobox…</p>
          ) : (
            <a class="button button-primary" href="#/new">
              Create my Chronobox
            </a>
          )}
        </div>
        {readNotice}
        {lookElsewhere}
      </section>

      <ul class="trust">
        <li>
          <Tick />
          <strong>No account</strong>
        </li>
        <li>
          <Tick />
          <strong>No KYC</strong>
        </li>
        <li>
          <Tick />
          <strong>No tracking</strong>
        </li>
        <li>
          <a class="trust-link" href={REPO} target="_blank" rel="noreferrer noopener">
            <Tick />
            <strong>Open source</strong>
          </a>
        </li>
        <li>
          <a class="trust-link" href="https://www.zodiac.eco/security#audits" target="_blank" rel="noreferrer noopener">
            <Tick />
            <strong>Audited contracts</strong>
          </a>
        </li>
      </ul>

      <section class="section" id="how">
        <h2>How it works</h2>
        <HowItWorks />
        <div class="info-box info-box-center">
          <p>When you need the money, you ask for it. When the wait ends, you collect it and it goes back to your wallet. You can cancel until then.</p>
        </div>
      </section>

      <section class="section film-section">
        {film ? (
          <video class="film" src={FILM} poster={POSTER} controls autoplay playsinline />
        ) : (
          <button type="button" class="film film-poster" aria-label="Play the film" onClick={() => setFilm(true)}>
            <img src={POSTER} alt="" width="1920" height="1080" loading="lazy" />
            <span class="film-play">
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            </span>
          </button>
        )}
      </section>

      {/* At the end of the page, the way in once more, and the way to any Chronobox by its address. */}
      <section class="section section-center start-end">
        <Button
          kind="primary"
          onClick={() => {
            wantsSetup.current = true;
            props.onConnect();
          }}
        >
          Get started
        </Button>
        <a class="link-button" href="#/open">
          Open a Chronobox by its address
        </a>
      </section>
    </div>
  );
}

function Tick() {
  return (
    <svg class="trust-tick" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="currentColor" />
      <path d="M5.8 10.4l2.8 2.8 5.6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function OpenByAddress(props: { chainId: number; onChain: (id: number) => void; text: string; onText: (text: string) => void; target: string | null }) {
  const bad = props.text.trim() !== "" && !props.target;
  return (
    <form
      class="open-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.target) location.hash = props.target;
      }}
    >
      <div class="open-row">
        <select class="input select" aria-label="Network" value={props.chainId} onChange={(event) => props.onChain(Number((event.target as HTMLSelectElement).value))}>
          {CHAINS.filter((c) => (__DEV__ ? true : !c.testnet || c.id === props.chainId)).map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          class="input"
          placeholder="Address of the Chronobox"
          aria-label="Address of the Chronobox"
          autocomplete="off"
          spellcheck={false}
          value={props.text}
          onInput={(event) => props.onText((event.target as HTMLInputElement).value)}
        />
        <Button type="submit" kind="plain" disabled={!props.target}>
          Open
        </Button>
      </div>
      {bad ? <p class="field-error">This is not a valid address. Check that it is complete and spelled right.</p> : null}
    </form>
  );
}

/** Open any Chronobox by its address: one a guardian watches, one on another network, anybody's. */
export function OpenPage(props: { chainId: number | undefined }) {
  const [chainId, setChainId] = useState(props.chainId ?? CHAINS[0].id);
  const [text, setText] = useState("");
  const address = parseAddress(text);
  const target = chainById(chainId);
  return (
    <section class="page page-center">
      <h1>Open a Chronobox</h1>
      <p class="lead">Any Chronobox, by its address: one you watch as a guardian, or one on another network.</p>
      <OpenByAddress chainId={chainId} onChain={setChainId} text={text} onText={setText} target={target && address ? vaultHref(target, address) : null} />
    </section>
  );
}
