/**
 * "How it is built": the four parts of a Timebox, who audited them, what the
 * app checks, and what it cannot do for you. Static. Every fact here must
 * match README.md and src/lib/timebox.ts.
 */
import "../technical.css";
import type { ComponentChildren } from "preact";
import { CONTRACTS } from "../lib/chains.ts";
import { Tick } from "./common.tsx";

const BLUE = "#469CED";
const BUILD = (document.querySelector('meta[name="timebox-build"]')?.getAttribute("content") ?? "").slice(0, 8);

function Ext(props: { href: string; children: ComponentChildren }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer noopener">
      {props.children}
    </a>
  );
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function Contract(props: { address: string }) {
  return (
    <Ext href={`https://etherscan.io/address/${props.address}`}>
      <span class="tech-mono">{short(props.address)}</span>
    </Ext>
  );
}

// The path of the money, drawn with the pieces of the mark.

function Glyph(props: { children: ComponentChildren }) {
  return (
    <svg class="tech-glyph" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">
      {props.children}
    </svg>
  );
}

const WALLET = (
  <>
    <path d="M15 19L43 9.5L47 19" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" />
    <rect x="8.5" y="19" width="47" height="35" rx="7" fill="none" stroke="currentColor" stroke-width="5" />
    <rect x="37" y="29.5" width="21" height="14" rx="7" fill={BLUE} />
    <circle cx="44.5" cy="36.5" r="3.5" fill="currentColor" />
  </>
);

const LOCK = (
  <g transform="translate(0 6)">
    <path d="M6.06 45.81A26 26 0 0 1 57.94 45.81" fill="none" stroke="currentColor" stroke-width="5" />
    <circle cx="15.99" cy="23.51" r="7.5" fill="currentColor" />
    <path d="M2 50A44 44 0 0 1 62 50Z" fill={BLUE} />
  </g>
);

const BOX = (
  <>
    <rect x="8.5" y="10.5" width="47" height="43" rx="10" fill="none" stroke="currentColor" stroke-width="5" />
    <path d="M14 48.5A19 17 0 0 1 50 48.5Z" fill={BLUE} />
  </>
);

export function TechnicalPage() {
  return (
    <section class="tech">
      <a class="wiz-back tech-back" href="#/">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Back
      </a>

      <header class="tech-head">
        <h1>Four parts. No back door.</h1>
        <p class="lead">Your wallet, a time lock, a cancel switch, and a box that nobody owns. That is all a Timebox is.</p>
      </header>

      <ol class="tech-flow" aria-label="How money leaves a Timebox">
        <li>
          <Glyph>{WALLET}</Glyph>
          <strong>Your wallet</strong>
          <span>asks</span>
        </li>
        <li>
          <Glyph>{LOCK}</Glyph>
          <strong>The time lock</strong>
          <span>makes it wait</span>
        </li>
        <li>
          <Glyph>{BOX}</Glyph>
          <strong>The Timebox</strong>
          <span>lets the money go</span>
        </li>
      </ol>
      <p class="tech-caption">The money can only go this way, and only back to your wallet.</p>

      <div class="tech-block">
        <h2>The parts</h2>
        <ul class="tech-cards">
          <li>
            <strong>Your wallet</strong>
            <p>The only key. It can ask for a withdrawal or a change, and each one waits. It can also cancel what is waiting.</p>
          </li>
          <li>
            <strong>The time lock</strong>
            <p>The only way out. Everything waits here, in line, for the full delay. Nobody can make it faster.</p>
            <p class="tech-meta">
              Zodiac Delay · <Contract address={CONTRACTS.delayMastercopy} /> ·{" "}
              <Ext href="https://github.com/zodiaceco/zodiac-modifier-delay/blob/main/audits/ZodiacDelayModuleSep2021.pdf">Audit by G0 Group, 2021</Ext>
            </p>
          </li>
          <li>
            <strong>The cancel switch</strong>
            <p>
              Lets your wallet clear what is waiting, at once. It can do nothing else. It cannot move money, and it cannot change the delay.
              Its one rule can only change through the time lock.
            </p>
            <p class="tech-meta">
              Zodiac Roles 2.1.1 · <Contract address={CONTRACTS.rolesMastercopy} /> · Audits by{" "}
              <Ext href="https://github.com/zodiaceco/zodiac-modifier-roles/blob/main/packages/evm/docs/Audit04_Roles-V2_1_Nov2023_G0Group.pdf">G0 Group</Ext> and{" "}
              <Ext href="https://github.com/zodiaceco/zodiac-modifier-roles/blob/main/packages/evm/docs/Audit03_RolesV2_1_Nov2023_Ominiscia.pdf">Omniscia</Ext>, 2023
            </p>
          </li>
          <li>
            <strong>The Timebox</strong>
            <p>Holds the money. Its owner is an address that nobody has a key for. So no person owns it, not even you.</p>
            <p class="tech-meta">
              Safe 1.4.1 · <Contract address={CONTRACTS.safeSingleton} /> ·{" "}
              <Ext href="https://github.com/safe-fndn/safe-smart-account/blob/main/docs/Safe_Audit_Report_1_4_0.pdf">Audit by Ackee Blockchain, 2023</Ext>
            </p>
          </li>
        </ul>
        <p class="tech-note">Timebox adds no contract of its own. These contracts have been in use for years. This app itself has not been audited yet.</p>
      </div>

      <div class="tech-block">
        <h2>What your wallet can do</h2>
        <ul class="tech-rows">
          <li>
            <span>Withdraw to itself</span>
            <span class="tech-tag">Waits</span>
          </li>
          <li>
            <span>Change the delay</span>
            <span class="tech-tag">Waits</span>
          </li>
          <li>
            <span>Hand over to another wallet</span>
            <span class="tech-tag">Waits</span>
          </li>
          <li>
            <span>Cancel what is waiting</span>
            <span class="tech-tag tech-tag-now">At once</span>
          </li>
        </ul>
        <p class="tech-note">Cancel moves nothing, so it does not need to wait. Everything else goes through the time lock.</p>
      </div>

      <div class="tech-block">
        <h2>Checked every time you open it</h2>
        <ul class="tech-checks">
          {[
            "It is a genuine Safe, and it runs the official code.",
            "Nothing extra is attached to it.",
            "No person and no key owns it.",
            "The time lock is the only way out.",
            "Only the Timebox itself can change the time lock.",
            "One wallet controls it, and only that wallet can cancel.",
            "Cancel is the only thing that does not wait.",
            "Every withdrawal has to wait.",
          ].map((text) => (
            <li key={text}>
              <Tick on />
              {text}
            </li>
          ))}
        </ul>
        <p class="tech-note">The app reads all of this from the chain. Anybody can open any Timebox by its address and see the same checks.</p>
      </div>

      <div class="tech-block">
        <h2>What it cannot do for you</h2>
        <ul class="tech-cards">
          <li>
            <strong>It cannot keep your wallet safe.</strong>
            <p>
              A person who has your wallet can ask for a withdrawal and wait. You can cancel it, and they can ask again. The wait gives you
              time. Alerts are what make that time useful.
            </p>
          </li>
          <li>
            <strong>It cannot bring a lost wallet back.</strong>
            <p>If you lose the wallet, the money in the Timebox is lost. There is no recovery.</p>
          </li>
          <li>
            <strong>It cannot stop a thief from blocking you.</strong>
            <p>A person who has your wallet can also cancel your withdrawals. Then the money is stuck, not gone.</p>
          </li>
        </ul>
        <p class="tech-note">
          One more thing to know: this app sends withdrawals only to your wallet, but the contracts would let your wallet ask for other
          things too. Anything this app did not create shows up under "Waiting" with a warning, and you can cancel it.
        </p>
      </div>

      <div class="tech-block">
        <h2>Private</h2>
        <ul class="tech-checks">
          <li>
            <Tick on />
            No server, no account, no tracking.
          </li>
          <li>
            <Tick on />
            This page makes no network requests. Everything comes through your wallet.
          </li>
        </ul>
      </div>

      <div class="tech-block">
        <h2>See for yourself</h2>
        <ul class="tech-rows">
          <li>
            <span>Source</span>
            <span class="tech-value">Open, MIT license</span>
          </li>
          <li>
            <span>This build</span>
            <span class="tech-value tech-mono">
              v{__VERSION__} · {BUILD || "unknown"}
            </span>
          </li>
          <li>
            <span>Rebuild it</span>
            <span class="tech-value">
              <code>npm run build</code> prints the same hash
            </span>
          </li>
        </ul>
        <details class="tech-more">
          <summary>For developers</summary>
          <p>
            Setup is two transactions: create a 1 of 1 Safe owned by your wallet, then one Safe transaction that deploys the Delay and the
            Roles modifier, wires them, and replaces the owner with <span class="tech-mono">0x…dEaD</span>. A wallet that can batch
            (EIP-5792), such as a Safe or an EIP-7702 account, does create, lock and deposits as one atomic transaction.
          </p>
          <p>
            A change of the delay is <code>setTxCooldown</code> on the Delay. A hand-over enables the new wallet on the Delay and the Roles
            modifier and disables the old one, in one batch. Cancel is <code>setTxNonce</code> on the Delay, called by the Safe through
            the Roles modifier. The app proves that this is the only permission from the full event history of the Roles contract.
          </p>
          <ul class="tech-addresses">
            {(
              [
                ["Safe 1.4.1 (SafeL2)", CONTRACTS.safeSingleton],
                ["Safe proxy factory", CONTRACTS.safeProxyFactory],
                ["MultiSend 1.4.1", CONTRACTS.multiSend],
                ["Zodiac module factory", CONTRACTS.moduleProxyFactory],
                ["Zodiac Delay", CONTRACTS.delayMastercopy],
                ["Zodiac Roles 2.1.1", CONTRACTS.rolesMastercopy],
              ] as const
            ).map(([name, address]) => (
              <li key={address}>
                <span>{name}</span>
                <Ext href={`https://etherscan.io/address/${address}`}>
                  <span class="tech-mono">{address}</span>
                </Ext>
              </li>
            ))}
          </ul>
          <p>The addresses are the same on every supported network.</p>
        </details>
      </div>
    </section>
  );
}
