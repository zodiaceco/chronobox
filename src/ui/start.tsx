/**
 * The first screen. Before a wallet is connected it says what Timebox is and
 * offers one thing to do. After that it is the list of your Timeboxes.
 */
import { useEffect, useState } from "preact/hooks";
import { type Chain, CHAINS, chainById } from "../lib/chains.ts";
import { formatDuration } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import { savedVaults } from "../lib/store.ts";
import { discover, inspect } from "../lib/timebox.ts";
import { Button, Modal, type Session } from "./common.tsx";
import { HowItWorks } from "./how.tsx";
import { Mark } from "./logo.tsx";

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
  const [openChain, setOpenChain] = useState(chain?.id ?? CHAINS[0].id);
  const [film, setFilm] = useState(false);

  useEffect(() => {
    if (chain) setOpenChain(chain.id);
  }, [chain]);

  useEffect(() => {
    if (!session) return setRows(null);
    let stale = false;
    setRows(null);
    (async () => {
      // Timeboxes on other networks come from this browser's memory.
      const list: Row[] = [];
      for (const saved of savedVaults()) {
        const other = chainById(saved.chainId);
        if (other && other.id !== chain?.id) list.push({ chain: other, safe: saved.safe, title: "Timebox", note: other.name });
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

  const openAddress = parseAddress(openText);
  const openTarget = chainById(openChain);
  const hasSome = !!rows && rows.length > 0;

  // With Timeboxes: the list is the page. Without: the welcome.
  if (session && hasSome) {
    return (
      <div class="start">
        <section class="home">
          <h1>Your Timeboxes</h1>
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
        <Mark size={72} />
        <h1>Money that cannot leave in a hurry.</h1>
        <p class="lead">Every withdrawal has to wait. No password, no threat and no stolen key can make it faster. Not even you can.</p>
        <div class="hero-actions">
          {!session ? (
            <Button kind="primary" onClick={props.onConnect}>
              Get started
            </Button>
          ) : rows === null ? (
            <p class="muted">Looking for your Timebox…</p>
          ) : (
            <a class="button button-primary" href="#/new">
              Create my Timebox
            </a>
          )}
        </div>
        <button type="button" class="film-link" onClick={() => setFilm(true)}>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
            <circle cx="12" cy="12" r="12" fill="#469CED" />
            <path d="M9.6 7.4v9.2l7.4-4.6z" fill="#fff" />
          </svg>
          See it in 30 seconds
        </button>
        <p class="hero-note">No account. No server. Open source.</p>
      </section>

      {film ? (
        <Modal title="How it works" wide onClose={() => setFilm(false)}>
          <video class="film" src="./timebox-film.mp4" controls autoplay playsinline />
        </Modal>
      ) : null}

      <section class="section" id="how">
        <HowItWorks />
        <p class="hiw-after">When you need the money, you ask for it. It comes back to your wallet when the wait ends, and you can cancel until then.</p>
      </section>

      {session && rows !== null ? (
        <section class="section section-center">
          <button type="button" class="link-button" onClick={() => setOpening(!opening)}>
            Open a Timebox by its address
          </button>
          {opening ? <OpenByAddress chainId={openChain} onChain={setOpenChain} text={openText} onText={setOpenText} target={openTarget && openAddress ? vaultHref(openTarget, openAddress) : null} /> : null}
        </section>
      ) : null}
    </div>
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
        placeholder="Address of the Timebox"
        aria-label="Address of the Timebox"
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
