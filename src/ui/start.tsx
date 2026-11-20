/**
 * The first screen, before a wallet is connected: what Chronobox is, and one
 * thing to do. With a wallet, the app shows that wallet's funds instead.
 */
import { useState } from "preact/hooks";
import { type Chain, CHAINS } from "../lib/chains.ts";
import type { Address } from "../lib/hex.ts";
import { Button } from "./common.tsx";
import { HowItWorks } from "./how.tsx";

// The film and its poster get a tag in their address. A new film has a new address, so no browser shows an old copy.
// In the dev build the tag is new on every page load.
const FILM_TAG = __DEV__ ? String(Date.now()) : __FILM__;
const FILM = `./chronobox-film.mp4?v=${FILM_TAG}`;
const POSTER = `./chronobox-film-poster.jpg?v=${FILM_TAG}`;

export function vaultHref(chain: Chain, safe: Address): string {
  return `#/v/${chain.short}:${safe}`;
}

export function StartPage(props: { onConnect: () => void }) {
  const [film, setFilm] = useState(false);
  return (
    <div class="start">
      <section class="hero">
        <h1>Money that cannot leave in a hurry.</h1>
        <p class="lead">Lock money with your wallet. Unlocking it has to wait. No password, no threat and no stolen key can make it faster. Not even you can.</p>
        <div class="hero-actions">
          <Button kind="primary" onClick={props.onConnect}>
            Get started
          </Button>
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
          <strong>No tracking</strong>
        </li>
        <li>
          <Tick />
          <strong>Open source</strong>
        </li>
        <li>
          <Tick />
          <strong>Audited contracts</strong>
        </li>
      </ul>

      <section class="section" id="how">
        <h2>How it works</h2>
        <HowItWorks />
        <div class="info-box info-box-center">
          <p>When you need the money, you unlock it. When the wait ends, you collect it and it is back in your wallet. You can cancel until then.</p>
        </div>
      </section>

      <section class="section film-section">
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

export function OpenByAddress(props: { chainId: number; onChain: (id: number) => void; text: string; onText: (text: string) => void; target: string | null }) {
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
