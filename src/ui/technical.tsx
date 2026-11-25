/**
 * "How it is built": the four parts of a Chronobox, who audited them, what the
 * app checks, what it cannot do for you, and the two optional parts: a
 * guardian, and with it a recovery. Static. Every fact here must
 * match README.md and src/lib/chronobox.ts.
 */
import "../technical.css";
import type { ComponentChildren } from "preact";
import { CONTRACTS, DELAY_DOCS, ROLES_DOCS } from "../lib/chains.ts";
import { BoxArt, GuardianArt, SunArt, WalletArt } from "./art.tsx";
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
      <p class="tech-caption">The money can only go this way. This app sends it only back to your wallet.</p>

      <div class="tech-block">
        <h2>The parts</h2>
        <ul class="tech-cards">
          <li>
            <strong>Your wallet</strong>
            <p>It controls the Chronobox. It can ask for a withdrawal or a change, and each one waits. It can also cancel what is waiting.</p>
          </li>
          <li>
            <strong>The time lock</strong>
            <p>The only way out. Everything waits here, in line, for the full delay. Nobody can make it faster.</p>
            <p class="tech-meta">
              <Ext href={DELAY_DOCS}>Zodiac Delay</Ext> · <Contract address={CONTRACTS.delayMastercopy} /> ·{" "}
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
              <Ext href={ROLES_DOCS}>Zodiac Roles 2.1.1</Ext> · <Contract address={CONTRACTS.rolesMastercopy} /> · Audits by{" "}
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

      {/* Optional. A Chronobox is complete without it, so it looks different from the parts above: a dashed frame and a tag. */}
      <div class="tech-block tech-optional">
        <div class="tech-optional-head">
          <GuardianArt class="tech-optional-glyph" />
          <div>
            <span class="tech-tag tech-tag-optional">Optional</span>
            <h2>A guardian</h2>
          </div>
        </div>
        <p class="tech-optional-lead">
          A second wallet that can say stop: your own on another device, or the wallet of a person you trust. You add it later, on the page of your
          Chronobox. A Chronobox works without one.
        </p>
        <ul class="tech-rows">
          <li>
            <span>Cancel what is waiting</span>
            <span class="tech-tag tech-tag-now">At once</span>
          </li>
          <li>
            <span>Hand over to a new wallet, together with your wallet</span>
            <span class="tech-tag tech-tag-now">At once</span>
          </li>
          <li>
            <span>Withdraw, or change anything alone</span>
            <span class="tech-tag">Never</span>
          </li>
        </ul>
        <ul class="tech-checks">
          <li>
            <Tick on />A person who has your wallet gains nothing by keeping you from cancelling. Your guardian cancels.
          </li>
          <li>
            <Tick on />A leaked key is no standoff. You and your guardian move the Chronobox to a new wallet.
          </li>
        </ul>
        <p class="tech-note">
          The price: your guardian can cancel every withdrawal, and you can remove your guardian only when your guardian lets it happen. By
          default a guardian is not a backup: a move by both of you needs your wallet. For a lost wallet, turn on the recovery below. Adding,
          changing or removing a guardian or a recovery waits in the time lock, like every change.
        </p>
        <p class="tech-note">
          Built from the same contracts: a second rule in the cancel switch (<Ext href={ROLES_DOCS}>Zodiac Roles 2.1.1</Ext>), a Safe 1.4.1
          that needs your wallet and your guardian together, and (when recovery is on) a second <Ext href={DELAY_DOCS}>Zodiac Delay</Ext>{" "}
          owned by the Chronobox that acts on that shared Safe. The app checks all of them every time you open the Chronobox.
        </p>
      </div>

      {/* Optional, and only with a guardian: the same frame as the guardian. */}
      <div class="tech-block tech-optional">
        <div class="tech-optional-head">
          <SunArt class="tech-optional-glyph" />
          <div>
            <span class="tech-tag tech-tag-optional">Optional, with a guardian</span>
            <h2>A recovery</h2>
          </div>
        </div>
        <p class="tech-optional-lead">
          A way back in when your wallet is lost. Your guardian starts it and enters the new wallet. Then it waits a long time, and you can stop it at
          once. You turn it on with the guardian, or later, on the page of your Chronobox.
        </p>
        <ul class="tech-rows">
          <li>
            <span>Your guardian starts a recovery to a new wallet</span>
            <span class="tech-tag">Waits</span>
          </li>
          <li>
            <span>Your wallet or your guardian stops it</span>
            <span class="tech-tag tech-tag-now">At once</span>
          </li>
          <li>
            <span>Anybody carries it out</span>
            <span class="tech-tag">After the wait</span>
          </li>
          <li>
            <span>A recovery moves money</span>
            <span class="tech-tag">Never</span>
          </li>
        </ul>
        <ul class="tech-rows">
          <li>
            <span>The wait</span>
            <span class="tech-value">90, 180 or 365 days, or your own</span>
          </li>
          <li>
            <span>Your own wait</span>
            <span class="tech-value">30 to 730 days, never shorter than your delay</span>
          </li>
          <li>
            <span>Open after the wait</span>
            <span class="tech-value">30 days, then it is void</span>
          </li>
          <li>
            <span>When it is carried out</span>
            <span class="tech-value">The new wallet holds the Chronobox</span>
          </li>
        </ul>
        <p class="tech-note">
          The price: your guardian chooses the new wallet. If you do not stop a recovery in time, because you are away, ill or gone, your guardian
          can take the Chronobox. The long wait and the alerts protect you: an alert tells you when a recovery starts. After a recovery, every
          withdrawal still waits your delay. A recovery is for a lost wallet. A person who has your wallet can stop it too.
        </p>
        <p class="tech-note">
          Built from the same contracts: a second <Ext href={DELAY_DOCS}>Zodiac Delay</Ext> that the Chronobox owns, with your guardian as the
          only one who can put a recovery into it. It acts on the Safe of your wallet and your guardian. The app checks it every time you open the
          Chronobox.
        </p>
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
            "One wallet controls it. Only that wallet, and a guardian if you added one, can cancel.",
            "Cancel is the only thing that does not wait.",
            "Every withdrawal has to wait.",
          ].map((text) => (
            <li key={text}>
              <Tick on />
              {text}
            </li>
          ))}
        </ul>
        <p class="tech-note">With a guardian and a recovery, also:</p>
        <ul class="tech-checks">
          {[
            "A wallet change without the wait needs your wallet and your guardian together.",
            "Only your guardian can start a recovery, and it waits.",
            "Your wallet and your guardian can stop a recovery at once.",
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
              A person who has your wallet can ask for a withdrawal and wait. You can cancel it, and they can ask again. The wait gives you
              time to see it and to cancel.
            </p>
          </li>
          <li>
            <strong>It cannot bring a lost wallet back on its own.</strong>
            <p>
              If you can no longer sign with your wallet and the recovery is off, the money in the Chronobox is lost. A guardian alone cannot help.
              With the recovery on, your guardian can bring the Chronobox to a new wallet after a long wait. The recovery of your wallet itself still
              works too. Zodiac cannot recover it for you.
            </p>
          </li>
          <li>
            <strong>It cannot stop a thief from blocking you.</strong>
            <p>A person who has your wallet can also cancel your withdrawals. Then the money is stuck, not gone. A guardian can help you move to a new wallet.</p>
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
            No backend, no account, no tracking.
          </li>
          <li>
            <Tick on />
            This page loads only its own files. All chain data comes through your wallet.
          </li>
        </ul>
        <p class="tech-note">
          Alerts are the exception, and you choose them. Our alert service must know who follows a Chronobox to send an alert, and we can see that.
          You can also run the alert service yourself.
        </p>
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
              {BUILD || "unknown"}
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
            Setup is two transactions: create a 1 of 1 Safe owned by your wallet, then one Safe transaction that deploys the <Ext href={DELAY_DOCS}>Delay</Ext> and the{" "}
            <Ext href={ROLES_DOCS}>Roles modifier</Ext>, wires them, and replaces the owner with <span class="tech-mono">0x…dEaD</span>. A wallet that can batch
            (EIP-5792), such as a Safe or an EIP-7702 account, creates the Chronobox, switches on the time delay and makes the deposits as one atomic transaction.
          </p>
          <p>
            A change of the delay is <code>setTxCooldown</code> on the Delay. A hand-over enables the new wallet on the Delay and the Roles
            modifier and disables the old one, in one batch. Cancel is <code>setTxNonce</code> on the Delay, called by the Safe through
            the Roles modifier. The app proves that this is the only permission from the full event history of the Roles contract.
          </p>
          <p>
            A guardian is one batch through the Delay. It gives the guardian the role "cancel", and it gives a second role, "council", to the
            address of a 2 of 2 Safe of wallet and guardian. That role can call <code>enableModule</code> and <code>disableModule</code> on the
            Delay, and <code>assignRoles</code> and <code>disableModule</code> on the Roles modifier. The Safe is made with the first request.
            A hand-over by both is <code>approveHash</code> by the guardian and <code>execTransaction</code> by the wallet.
          </p>
          <p>
            The recovery is a second Delay, at an address that depends only on the Chronobox. The Safe owns it, and it is never a module of the
            Safe. Turned on, it points at the 2 of 2 Safe (<code>setAvatar</code>, <code>setTarget</code>), and the guardian is its one module.
            That 2 of 2 Safe is then made in a second form: its setup calls <code>enableModules</code> of SafeModuleSetup 0.3.0, so the
            recovery Delay is its one module from its first moment. A recovery is the same batch as a hand-over by both. The guardian queues it
            on the recovery Delay, and after the wait anybody calls <code>executeNextTx</code>. The role "cancel" also covers{" "}
            <code>setTxNonce</code> on the recovery Delay: that is how the wallet and the guardian stop it. Turning it off takes the guardian off
            the recovery Delay and points it back at the Safe, where it can do nothing.
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
                ["SafeModuleSetup 0.3.0 (recovery only)", CONTRACTS.safeModuleSetup],
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
