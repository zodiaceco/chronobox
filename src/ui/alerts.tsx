/**
 * Alerts for one Chronobox: the sheet "Get told".
 *
 * The first screen asks how the person wants to hear about a withdrawal:
 * Telegram or email from the alert service, or an alert service of their own.
 * A way that is not set in chains.ts is not in the list. With one way left
 * the question is skipped, and with none the Chronobox page does not show
 * "Get told".
 *
 * Every way works the same: the app only builds a link, and the registration
 * happens somewhere else (in Telegram, on a page of the alert service, on the
 * person's own machine). The app sends nothing, and it never sees an email
 * address.
 *
 * Email is a double opt-in. The person gives the address on the page of the
 * alert service. The service sends one email with a link. Alerts start only
 * after the person opens that link and confirms.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { telegramLink, telegramStart } from "../lib/alerts.ts";
import { ALERTS_EMAIL, ALERTS_GUIDE, ALERTS_TELEGRAM, type Chain } from "../lib/chains.ts";
import type { Address } from "../lib/hex.ts";
import { Button, Modal } from "./common.tsx";

/** The dev server shows the sheet with a bot name that is only a stand-in. Put the name of your test bot in ALERTS_TELEGRAM. */
export const BOT: string | null = ALERTS_TELEGRAM ?? (__DEV__ ? "chronobox_alerts_dev_bot" : null);
/** The page of the alert service where a person gives an email address. The dev server expects a watcher on this machine. */
const EMAIL: string | null = ALERTS_EMAIL ?? (__DEV__ ? "http://localhost:8787/api/email" : null);
/** The guide to run the alert service yourself. */
const OWN: string | null = ALERTS_GUIDE ?? (__DEV__ ? "https://github.com/zodiaceco/chronobox/tree/main/watcher#run-it-yourself" : null);

export type Stage = "choose" | "telegram" | "email" | "own";
const WAYS = [BOT ? "telegram" : null, EMAIL ? "email" : null, OWN ? "own" : null].filter(Boolean) as Stage[];

/** The sheet has something to offer. Without it the Chronobox page does not show "Get told". */
export const ALERTS = WAYS.length > 0;
/** What the row "Get told" says: the one way there is, or that there is a choice. */
export const ALERTS_ROW = WAYS.length === 1 ? { telegram: "Alerts in Telegram", email: "Alerts by email", own: "Your own alerts", choose: "" }[WAYS[0]] : "Alerts";

type Screen = { title: string; lead?: string; body: ComponentChildren };
type Ctx = { chain: Chain; safe: Address; go: (stage: Stage) => void };

function Chevron() {
  return (
    <svg class="row-chevron" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
      <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** One way to choose: a name, one line about it, and a tap that goes on. */
function Pick(props: { title: string; text: string; onClick: () => void }) {
  return (
    <li>
      <button type="button" class="row row-pick" onClick={props.onClick}>
        <span class="row-pick-text">
          <strong>{props.title}</strong>
          <span>{props.text}</span>
        </span>
        <Chevron />
      </button>
    </li>
  );
}

/** Back to the choice. Without a choice (one way only) there is nothing to go back to. */
function Back(props: { go: (stage: Stage) => void }) {
  if (WAYS.length < 2) return null;
  return (
    <Button kind="quiet" onClick={() => props.go("choose")}>
      Back
    </Button>
  );
}

function screenOf(stage: Stage, ctx: Ctx): Screen {
  const { chain, safe, go } = ctx;
  switch (stage) {
    case "choose":
      return {
        title: "Get told",
        lead: "The wait protects you only if you hear about a withdrawal in time.",
        body: (
          <>
            <strong>How do you want to hear about it?</strong>
            <ul class="rows">
              {BOT ? <Pick title="Telegram" text="A message from our alert service." onClick={() => go("telegram")} /> : null}
              {EMAIL ? <Pick title="Email" text="An email from our alert service." onClick={() => go("email")} /> : null}
              {OWN ? <Pick title="Your own alert service" text="You run it. It writes only to you." onClick={() => go("own")} /> : null}
            </ul>
          </>
        ),
      };
    case "telegram":
      return {
        title: WAYS.length === 1 ? "Get told" : "Alerts in Telegram",
        lead: WAYS.length === 1 ? "The wait protects you only if you hear about a withdrawal in time." : "Telegram opens. Press Start there, and you are done.",
        body: (
          <>
            <div class="modal-actions">
              <a class="button button-primary" href={telegramLink(BOT ?? "", chain.id, safe)} target="_blank" rel="noreferrer noopener">
                Get alerts in Telegram
              </a>
              <Back go={go} />
            </div>
            <p class="deposit-note">
              Telegram opens. Press Start there. The alert service keeps the number of your Telegram chat, the address of this Chronobox,
              and since when you follow it. Nothing else. To end the alerts, send /stop there.
            </p>
          </>
        ),
      };
    case "email":
      return {
        title: "Alerts by email",
        lead: "The page of our alert service opens. Give your email address there, and confirm it with the link that we send you.",
        body: (
          <>
            <div class="modal-actions">
              <a class="button button-primary" href={`${EMAIL}?c=${telegramStart(chain.id, safe)}`} target="_blank" rel="noreferrer noopener">
                Open the alert service
              </a>
              <Back go={go} />
            </div>
            <p class="deposit-note">
              The alert service keeps your email address, the address of this Chronobox, and since when you follow it. Nothing else. Every
              alert ends with a link that stops them.
            </p>
          </>
        ),
      };
    case "own":
      return {
        title: "Your own alert service",
        lead: "The alert service is open source. You can run it yourself. Then it writes only to you, and it does not need us.",
        body: (
          <>
            <div class="modal-actions">
              <a class="button button-primary" href={OWN ?? ""} target="_blank" rel="noreferrer noopener">
                See how on GitHub
              </a>
              <Back go={go} />
            </div>
            <p class="deposit-note">The guide there shows what you can run, and what each way needs.</p>
          </>
        ),
      };
  }
}

export function AlertsSheet(props: { chain: Chain; safe: Address; onClose: () => void }) {
  // With one way, the sheet opens on it.
  const [stage, setStage] = useState<Stage>(WAYS.length === 1 ? WAYS[0] : "choose");
  if (!ALERTS) return null;
  const screen = screenOf(stage, { chain: props.chain, safe: props.safe, go: setStage });
  return (
    <Modal title={screen.title} lead={screen.lead} onClose={props.onClose}>
      {screen.body}
    </Modal>
  );
}
