/**
 * The first screen. Before a wallet is connected it says what Chronobox is and
 * offers one thing to do. After that it is the list of your Chronoboxes.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { type Chain, CHAINS, chainById } from "../lib/chains.ts";
import { formatDuration } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import { savedVaults } from "../lib/store.ts";
import { discover, inspect } from "../lib/chronobox.ts";
import { Button, type Session } from "./common.tsx";
import { HowItWorks } from "./how.tsx";
import { Mark } from "./logo.tsx";

// The film and its poster get a tag in their address. A new film has a new address, so no browser shows an old copy.
// In the dev build the tag is new on every page load.
const FILM_TAG = __DEV__ ? String(Date.now()) : __FILM__;
const FILM = `./chronobox-film.mp4?v=${FILM_TAG}`;
const POSTER = `./chronobox-film-poster.jpg?v=${FILM_TAG}`;

type Row = { chain: Chain; safe: Address; title: string; note: string };

export function vaultHref(chain: Chain, safe: Address): string {
  return `#/v/${chain.short}:${safe}`;
}

function shortOf(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function StartPage(props: { session: Session | null; chain: Chain | undefined; onConnect: () => void }) {
  const { session, chain } = props;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [openText, setOpenText] = useState("");
  const [film, setFilm] = useState(false);
  // "Get started" was pressed here: when the wallet is connected and has no Chronobox, go straight on to the setup.
  const wantsSetup = useRef(false);
  const [openChain, setOpenChain] = useState(chain?.id ?? CHAINS[0].id);

  useEffect(() => {
    if (chain) setOpenChain(chain.id);
  }, [chain]);

  useEffect(() => {
    if (!session) return setRows(null);
    let stale = false;
    setRows(null);
    (async () => {
      // Chronoboxes on other networks come from this browser's memory.
      const list: Row[] = [];
      for (const saved of savedVaults()) {
        const other = chainById(saved.chainId);
        if (other && other.id !== chain?.id) list.push({ chain: other, safe: saved.safe, title: "Chronobox", note: other.name });
      }
      if (chain) {
        try {
          const found = await discover(session.rpc, session.account);
          const known = savedVaults().filter((v) => v.chainId === chain.id && !found.some((f) => sameAddress(f.safe, v.safe)));
          const here = [...found.map((f) => f.safe), ...known.map((k) => k.safe)];
          const inspected = await Promise.all(
            here.map(async (safe): Promise<Row> => {
              const result = await inspect(session.rpc, safe).catch(() => null);
              const title =
                result?.state === "locked" || result?.state === "unverified"
                  ? `Waits ${formatDuration(result.cooldown)}`
                  : result?.state === "open"
                    ? "Setup not finished"
                    : "Needs a look";
              return { chain, safe, title, note: chain.name };
            }),
          );
          list.unshift(...inspected);
        } catch {
          // The wallet could not read the chain. Show what the browser remembers.
        }
      }
      if (!stale) setRows(list);
    })();
    return () => {
      stale = true;
    };
  }, [session?.rpc, session?.account, chain]);

  useEffect(() => {
    if (!wantsSetup.current || !session || rows === null) return;
    wantsSetup.current = false;
    if (rows.length === 0) location.hash = "#/new";
  }, [session, rows]);

  const openAddress = parseAddress(openText);
  const openTarget = chainById(openChain);
  const hasSome = !!rows && rows.length > 0;

  // With Chronoboxes: the list is the page. Without: the welcome.
  if (session && hasSome) {
    return (
      <div class="start">
        <section class="home">
          <h1>Your Chronoboxes</h1>
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
            <a class="button button-plain" href="#/new">
              Create another
            </a>
            <button type="button" class="link-button" onClick={() => setOpening(!opening)}>
              Open one by its address
            </button>
          </div>
          {opening ? <OpenByAddress chainId={openChain} onChain={setOpenChain} text={openText} onText={setOpenText} target={openTarget && openAddress ? vaultHref(openTarget, openAddress) : null} /> : null}
        </section>
      </div>
    );
  }

  return (
    <div class="start">
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
      </section>

      <ul class="trust">
        <li>
          <Tick />
          <strong>No account</strong>
        </li>
        <li>
          <Tick />
          <strong>No data</strong>
        </li>
        <li>
          <Tick />
          <strong>Full privacy</strong>
        </li>
        <li>
          <Tick />
          <strong>Open source</strong>
        </li>
        <li>
          <Tick />
          <strong>Fully audited</strong>
        </li>
      </ul>

      <section class="section" id="how">
        <h2>How it works</h2>
        <HowItWorks />
        <p class="hiw-after">When you need the money, you ask for it. It comes back to your wallet when the wait ends, and you can cancel until then.</p>
      </section>

      <section class="section film-section">
        <h2>See it in 35 seconds</h2>
        {film ? (
          <video class="film" src={FILM} poster={POSTER} controls autoplay playsinline />
        ) : (
          <button type="button" class="film film-poster" aria-label="Play the film" onClick={() => setFilm(true)}>
            <img src={POSTER} alt="" width="1280" height="720" loading="lazy" />
            <span class="film-play">
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            </span>
          </button>
        )}
      </section>

      {session && rows !== null ? (
        <section class="section section-center">
          <button type="button" class="link-button" onClick={() => setOpening(!opening)}>
            Open a Chronobox by its address
          </button>
          {opening ? <OpenByAddress chainId={openChain} onChain={setOpenChain} text={openText} onText={setOpenText} target={openTarget && openAddress ? vaultHref(openTarget, openAddress) : null} /> : null}
        </section>
      ) : null}
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
  return (
    <div class="open-row">
      <select class="input select" aria-label="Network" value={props.chainId} onChange={(event) => props.onChain(Number((event.target as HTMLSelectElement).value))}>
        {CHAINS.filter((c) => !c.testnet || __DEV__ || c.id === props.chainId).map((c) => (
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
      <a class={`button button-plain${props.target ? "" : " is-disabled"}`} href={props.target ?? undefined} aria-disabled={!props.target}>
        Open
      </a>
    </div>
  );
}
