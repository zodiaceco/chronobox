/**
 * Alerts for one Chronobox. Two pieces:
 *
 * - AlertsSheet: inside a Chronobox. A QR code that opens the setup page on a
 *   phone, yours or the phone of a person you trust.
 * - AlertsPage: the setup page. It needs no wallet and sends nothing: it
 *   shows the ntfy topic of this Chronobox and opens the ntfy app.
 *
 * Without ALERTS_SERVER there is no alert service, and the sheet shows how to
 * run the watcher yourself.
 */
import { alertLinks, alertsHref } from "../lib/alerts.ts";
import { ALERTS_SERVER, type Chain } from "../lib/chains.ts";
import { shortAddress } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";
import { Copy, Modal } from "./common.tsx";
import { QrCode } from "./deposit.tsx";

/** The dev server expects a local ntfy (see watcher/README.md, "Try it on your machine"). */
export const SERVER: string | null = ALERTS_SERVER ?? (__DEV__ ? "http://localhost:3133" : null);

const APPS = [
  { name: "App Store", href: "https://apps.apple.com/app/ntfy/id1625396347" },
  { name: "Google Play", href: "https://play.google.com/store/apps/details?id=io.heckel.ntfy" },
  { name: "F-Droid", href: "https://f-droid.org/packages/io.heckel.ntfy/" },
];

function pageUrl(chain: Chain, safe: Address): string {
  return `${location.origin}${location.pathname}${alertsHref(chain, safe)}`;
}

function Calendar() {
  return (
    <div class="sheet-block">
      <strong>Calendar</strong>
      <p>Each waiting item has "Add to calendar". It reminds you when the wait ends and before the item expires.</p>
    </div>
  );
}

export function AlertsSheet(props: { chain: Chain; safe: Address; onClose: () => void }) {
  const { chain, safe } = props;
  if (!SERVER) {
    return (
      <Modal
        title="Get told"
        lead="The wait protects you only if you hear about a withdrawal in time. Chronobox has no server, so it cannot message you by itself."
        onClose={props.onClose}
      >
        <Calendar />
        <div class="sheet-block">
          <strong>Alerts on your phone</strong>
          <p>
            A small script watches this Chronobox and sends an alert the moment something is asked for. It needs only this address and runs
            on any computer that stays on. Share the alerts with a person you trust.
          </p>
          <pre class="code">{`CHRONOBOX=${safe} \\\nRPC_URL=<your RPC URL for ${chain.name}> \\\nNTFY_URL=https://ntfy.sh/<a-long-random-topic> \\\nnode watcher/watch.ts`}</pre>
        </div>
      </Modal>
    );
  }
  const url = pageUrl(chain, safe);
  return (
    <Modal title="Get told" lead="The wait protects you only if you hear about a withdrawal in time." onClose={props.onClose}>
      <div class="deposit">
        <div class="deposit-qr">
          <QrCode text={url} label="QR code that opens the alert setup for this Chronobox" />
        </div>
        <p class="deposit-note">
          Scan this with your phone to get alerts. Then let a person you trust scan it too. No account, no sign-up.
        </p>
      </div>
      <div class="modal-actions">
        <a class="button button-primary" href={alertsHref(chain, safe)}>
          Set up on this device
        </a>
        <div class="alerts-share">
          <Copy text={url} label="Copy the link" />
        </div>
      </div>
      <Calendar />
    </Modal>
  );
}

export function AlertsPage(props: { chain: Chain; safe: Address }) {
  const { chain, safe } = props;
  if (!SERVER) {
    return (
      <section class="page page-center">
        <h1>This copy of Chronobox has no alert service.</h1>
        <p class="lead">You can run the watcher yourself. It is one file in the Chronobox source code: watcher/watch.ts.</p>
      </section>
    );
  }
  const links = alertLinks(SERVER, chain.id, safe);
  return (
    <section class="page alerts">
      <header class="alerts-head">
        <h1>Alerts for this Chronobox</h1>
        <p class="lead">Your phone tells you the moment somebody asks for a withdrawal. No account, no sign-up.</p>
        <p class="alerts-which">
          <span class="mono">{shortAddress(safe)}</span> on {chain.name}
        </p>
      </header>

      <ol class="alerts-steps">
        <li>
          <strong>Get the ntfy app</strong>
          <p>It is free and open source.</p>
          <p class="alerts-apps">
            {APPS.map((app) => (
              <a key={app.name} href={app.href} target="_blank" rel="noreferrer noopener">
                {app.name}
              </a>
            ))}
          </p>
        </li>
        <li>
          <strong>Add this Chronobox</strong>
          <a class="button button-primary" href={links.app}>
            Open in ntfy
          </a>
          <p>If nothing opens, add a subscription in the ntfy app by hand, with this server and this topic:</p>
          <ul class="rows alerts-rows">
            <li>
              <div class="row">
                <span class="row-label">Server</span>
                <span class="row-value mono">{links.server}</span>
                <Copy text={links.server} />
              </div>
            </li>
            <li>
              <div class="row">
                <span class="row-label">Topic</span>
                <span class="row-value mono">{links.topic}</span>
                <Copy text={links.topic} />
              </div>
            </li>
          </ul>
        </li>
        <li>
          <strong>Share it</strong>
          <p>Send this page to a person you trust. An alert helps most when it reaches somebody other than you.</p>
          <p>
            <Copy text={pageUrl(chain, safe)} label="Copy the link to this page" />
          </p>
        </li>
      </ol>

      <details class="details">
        <summary>What the alert service can see</summary>
        <p>
          It watches every Chronobox on {chain.name}. It does not know which one is yours, and it keeps no list of people. This page sent
          nothing to it.
        </p>
        <p>The alerts of a Chronobox are public, like the Chronobox itself. Anybody who knows the address can listen.</p>
        <p>
          The alert server can see the internet address of a phone while that phone listens. If you do not want that, run the watcher
          yourself. It is one file in the Chronobox source code: watcher/watch.ts.
        </p>
      </details>
    </section>
  );
}
