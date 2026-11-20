/**
 * "How it protects me and my funds": the four parts of a Chronobox, who audited them, what the
 * app checks, and what it cannot do for you. Then, folded away, the mechanism
 * in depth for people who want all of it. Static. Every fact here must
 * match README.md and src/lib/chronobox.ts.
 */
import "../technical.css";
import type { ComponentChildren } from "preact";
import { CONTRACTS } from "../lib/chains.ts";
import { BoxArt, SunArt, WalletArt } from "./art.tsx";
import { Tick } from "./common.tsx";

const BUILD = (document.querySelector('meta[name="chronobox-build"]')?.getAttribute("content") ?? "").slice(0, 8);

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

// The path of the money is drawn with the pictures from art.tsx: the wallet, the mark, the box.

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
        <p class="lead">Your wallet, a time lock, a cancel switch, and a box that nobody owns. That is all a Chronobox is.</p>
      </header>

      <ol class="tech-flow" aria-label="How money leaves a Chronobox">
        <li>
          <WalletArt class="tech-glyph" />
          <strong>Your wallet</strong>
          <span>asks</span>
        </li>
        <li>
          <SunArt class="tech-glyph" />
          <strong>The time lock</strong>
          <span>makes it wait</span>
        </li>
        <li>
          <BoxArt class="tech-glyph" />
          <strong>The Chronobox</strong>
          <span>lets the money go</span>
        </li>
      </ol>
      <p class="tech-caption">The money can only go this way.</p>

      <div class="tech-block">
        <h2>The parts</h2>
        <ul class="tech-cards">
          <li>
            <strong>Your wallet</strong>
            <p>The only key. It can ask to unlock or to change something, and each of these waits. It can also cancel what is waiting.</p>
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
            <strong>The Chronobox</strong>
            <p>Holds the money. Its owner is an address that nobody has a key for. So no person owns it, not even you.</p>
            <p class="tech-meta">
              Safe 1.4.1 · <Contract address={CONTRACTS.safeSingleton} /> ·{" "}
              <Ext href="https://github.com/safe-fndn/safe-smart-account/blob/main/docs/Safe_Audit_Report_1_4_0.pdf">Audit by Ackee Blockchain, 2023</Ext>
            </p>
          </li>
        </ul>
        <p class="tech-note">Chronobox adds no contract of its own. These contracts have been in use for years. This app itself has not been audited yet.</p>
      </div>

      <div class="tech-block">
        <h2>What your wallet can do</h2>
        <ul class="tech-rows">
          <li>
            <span>Unlock money to itself</span>
            <span class="tech-tag">Waits</span>
          </li>
          <li>
            <span>Change how long unlocking takes</span>
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
            "Only the Chronobox itself can change the time lock.",
            "One wallet controls it, and only that wallet can cancel.",
            "Cancel is the only thing that does not wait.",
            "Every unlock has to wait.",
          ].map((text) => (
            <li key={text}>
              <Tick on />
              {text}
            </li>
          ))}
        </ul>
        <p class="tech-note">The app reads all of this from the chain. Anybody can open any Chronobox by its address and see the same checks.</p>
      </div>

      <div class="tech-block">
        <h2>What it cannot do for you</h2>
        <ul class="tech-cards">
          <li>
            <strong>It cannot keep your wallet safe.</strong>
            <p>
              A person who has your wallet can ask to unlock and wait. You can cancel it, and they can ask again. The wait gives you
              time to see it and to cancel.
            </p>
          </li>
          <li>
            <strong>It cannot bring a lost wallet back.</strong>
            <p>If you lose the wallet, the locked money is lost. There is no recovery.</p>
          </li>
          <li>
            <strong>It cannot stop a thief from blocking you.</strong>
            <p>A person who has your wallet can also cancel what you ask for. Then the money is stuck, not gone.</p>
          </li>
        </ul>
        <p class="tech-note">
          One more thing to know: this app unlocks only to your wallet, but the contracts would let your wallet ask for other
          things too. Anything this app did not create shows up under "Waiting" with a warning, and you can cancel it.
        </p>
      </div>

      <div class="tech-block">
        <h2>In depth</h2>
        <p class="tech-note">For people who want to know exactly what holds their money. You do not need any of this to use Chronobox.</p>

        <details class="tech-more">
          <summary>The two principles</summary>
          <ol class="tech-list">
            <li>
              <strong>Life before funds.</strong> Nothing an attacker does to you should ever get them the money: no threat of any length, no harm
              that keeps you from signing again. If hurting you cannot pay off, there is no reason to try.
            </li>
            <li>
              <strong>Lost before stolen.</strong> Where money cannot stay reachable, it should end up blocked or lost, never with the attacker.
            </li>
          </ol>
          <p>The setup of every Chronobox is public on chain, so an attacker can work out in advance what pays off.</p>
        </details>

        <details class="tech-more">
          <summary>What happens in each case</summary>
          <p>
            Today a Chronobox has one key: your wallet. A second setup with a guardian is designed and not in this app yet. A guardian is a
            second key that can cancel anything your wallet asks for, and can never take anything.
          </p>
          <div class="tech-table-wrap">
            <table class="tech-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Today: one wallet</th>
                  <th>Planned: with a guardian</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>No incident</td>
                  <td class="tech-ok">Nothing lost</td>
                  <td class="tech-ok">Nothing lost</td>
                </tr>
                <tr>
                  <td>
                    Forced to unlock
                    <small>for less time than the wait</small>
                  </td>
                  <td class="tech-ok">Nothing lost</td>
                  <td class="tech-ok">Nothing lost</td>
                </tr>
                <tr>
                  <td>
                    Key leaked
                    <small>a copy: you still have it</small>
                  </td>
                  <td>
                    <b class="tech-amber">Stalemate.</b> The attacker can block for good.
                  </td>
                  <td class="tech-ok">Nothing lost</td>
                </tr>
                <tr>
                  <td>
                    Key taken
                    <small>only the attacker has it, or you can never sign again</small>
                  </td>
                  <td>
                    <b class="tech-theft">Theft.</b> Nobody can cancel.
                  </td>
                  <td>
                    <b class="tech-amber">Stalemate,</b> for any length of time.
                  </td>
                </tr>
                <tr>
                  <td>
                    Key lost
                    <small>no copy, no backup</small>
                  </td>
                  <td>
                    <b class="tech-lost">Lost.</b> Nobody can ever move the money.
                  </td>
                  <td>
                    <b class="tech-lost">Lost.</b> Nobody can ever move the money.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            <b>Stalemate:</b> blocked while it lasts, nobody is paid. <b>Lost:</b> gone for good, nobody is paid. <b>Theft:</b> the attacker is
            paid.
          </p>
          <p>
            These outcomes come from a model of the design that was checked over every possible order of actions, with the attacker free to act
            first. They assume that you cancel what you did not ask for before its wait runs out.
          </p>
          <p>
            So with one wallet, a person who holds your key gets the money once you cannot cancel. That does not meet "life before funds". The
            guardian closes this gap, at a price: a hostile guardian can block your money, though never take it. Your wallet can itself be a
            Safe with its own recovery.
          </p>
        </details>

        <details class="tech-more">
          <summary>The contracts, and who is what on each</summary>
          <div class="tech-table-wrap">
            <table class="tech-table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Owner</th>
                  <th>Modules, members</th>
                  <th>Allows</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Vault (Safe)</td>
                  <td>
                    <span class="tech-mono">0x…dEaD</span>, no key
                  </td>
                  <td>Delay, Roles</td>
                  <td>Holds the money. Changes only through the Delay, or through the one rule of the Roles modifier.</td>
                </tr>
                <tr>
                  <td>Delay</td>
                  <td>Vault</td>
                  <td>Your wallet</td>
                  <td>
                    Your wallet can queue anything on the Vault. It can be carried out after the wait, by anybody. A ready item stays valid for
                    7 days, then it expires.
                  </td>
                </tr>
                <tr>
                  <td>Roles</td>
                  <td>Vault</td>
                  <td>Role "cancel": your wallet</td>
                  <td>
                    Cancel on the Delay (<code>setTxNonce</code>), at once. No transfers, no change of the wait, no new modules.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            "Anything" is meant literally: the Delay lets your wallet queue a transfer to any address and any change of the Vault. This app builds
            three things only: unlock to your wallet, change the wait, hand over to another wallet. Whatever else is in the line shows with a
            warning.
          </p>
        </details>

        <details class="tech-more">
          <summary>The address, and the first lock</summary>
          <p>
            Each wallet has one Chronobox. Its address follows from the wallet's address alone: it is the <code>CREATE2</code> address of a Safe
            proxy from the Safe proxy factory, with your wallet as the one owner in the initializer and a fixed salt. The wait is not part of
            it. So the app knows the address before anything exists there, on every device, without a server.
          </p>
          <p>The first time you lock money, the same press builds the Chronobox:</p>
          <ol class="tech-list">
            <li>Create the Safe at that address, owned by your wallet.</li>
            <li>
              One Safe transaction deploys the Delay and the Roles modifier, sets the one cancel rule, enables both as modules, makes your wallet
              the only module of the Delay, and replaces your wallet as owner with <span class="tech-mono">0x…dEaD</span>. All of it or none of
              it. The network's coin that you lock rides along in this transaction.
            </li>
            <li>One transfer per token.</li>
          </ol>
          <p>
            A wallet that can batch (EIP-5792 with atomic support), such as a Safe or an EIP-7702 account, sends all of it as one atomic call. A
            plain wallet confirms step by step.
          </p>
          <p>
            Money at the address is protected only from step 2 on. Before that, your wallet owns the Safe outright. So the app never sends
            money ahead of the time lock, and it shows money that it finds there earlier as "not locked yet".
          </p>
        </details>

        <details class="tech-more">
          <summary>How the checks work</summary>
          <p>
            Most checks read the state of now: the code at each address, the owner, the modules, the guard and fallback slots, the wiring and
            the wait of the Delay. They take a moment.
          </p>
          <p>
            One check cannot be read from state. The Roles contract has no function that lists its permissions, so "cancel is the only thing that
            does not wait" is proven from every event the contract has ever emitted: the history may hold the cancel rule and nothing else. The
            app remembers the block in which the lock was switched on and reads from there. It runs this check after the page is on screen, and
            locks no more money until it has passed. On a device that cannot read old events, the Chronobox shows as "unverified".
          </p>
        </details>
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
            Everything comes through your wallet. This page makes no network requests of its own.
          </li>
          <li>
            <Tick on />
            One exception, and only if you switch it on: the balance lookup asks a public node and a token index for your balances.
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
          <summary>Calls and addresses</summary>
          <p>
            A change of the wait is <code>setTxCooldown</code> on the Delay. A hand-over enables the new wallet on the Delay and the Roles
            modifier and disables the old one, in one batch. Cancel is <code>setTxNonce</code> on the Delay, called by the Safe through
            the Roles modifier.
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
