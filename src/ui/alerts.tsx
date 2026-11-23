/**
 * Alerts for one Chronobox: the sheet "Get told".
 *
 * The first screen asks how the person wants to hear about a withdrawal:
 * Telegram or email from our alert service, or an alert service of their own.
 * A way that is not set in chains.ts is not in the list. Email is the one
 * exception: while ALERTS_EMAIL_SOON is true and ALERTS_EMAIL is not set, the
 * list shows it as "Coming soon", and it cannot be chosen. With one way left
 * and nothing coming, the question is skipped. With none, the Chronobox page
 * does not show "Get told".
 *
 * The first screen also says what our alert service costs in privacy: to send
 * an alert it must know who follows a Chronobox, and we can see that. A person
 * who does not want that runs the alert service on their own.
 *
 * Every way works the same: the app only builds a link, and the registration
 * happens somewhere else (in Telegram, on a page of the alert service, on the
 * person's own machine). The app sends nothing, and it never sees an email
 * address.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { telegramLink, telegramStart } from "../lib/alerts.ts";
import { ALERTS_EMAIL, ALERTS_EMAIL_SOON, ALERTS_GUIDE, ALERTS_TELEGRAM, type Chain } from "../lib/chains.ts";
import type { Address } from "../lib/hex.ts";
import { Button, Modal, Notice } from "./common.tsx";

/** The dev server shows the sheet with a bot name that is only a stand-in. Put the name of your test bot in ALERTS_TELEGRAM. */
export const BOT: string | null = ALERTS_TELEGRAM ?? (__DEV__ ? "chronobox_alerts_dev_bot" : null);
/** The page of the alert service where a person gives an email address. */
const EMAIL: string | null = ALERTS_EMAIL;
/** The guide to run the alert service yourself. */
const OWN: string | null = ALERTS_GUIDE;

export type Stage = "choose" | "telegram" | "email" | "own";
const WAYS = [BOT ? "telegram" : null, EMAIL ? "email" : null, OWN ? "own" : null].filter(Boolean) as Stage[];
/** Email is not there yet, and the list says so. */
const EMAIL_SOON = ALERTS_EMAIL_SOON && !EMAIL && WAYS.length > 0;
/** The sheet opens with the question, not with the one way there is. */
const CHOICE = WAYS.length > 1 || EMAIL_SOON;

/** The sheet has something to offer. Without it the Chronobox page does not show "Get told". */
export const ALERTS = WAYS.length > 0;
/** What the row "Get told" says: the one way there is, or that there is a choice. */
export const ALERTS_ROW = CHOICE ? "Alerts" : { telegram: "Alerts in Telegram", email: "Alerts by email", own: "Your own alerts", choose: "" }[WAYS[0]];

type Screen = { title: string; lead?: string; body: ComponentChildren };
type Ctx = { chain: Chain; safe: Address; go: (stage: Stage) => void };

function Chevron() {
  return (
    <svg class="row-chevron" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true">
      <path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** One way to choose: a name, one line about it, and a tap that goes on. Without a tap it is a way that is not there yet. */
function Pick(props: { title: string; text: string; onClick?: () => void }) {
  const text = (
    <span class="row-pick-text">
      <strong>{props.title}</strong>
      <span>{props.text}</span>
    </span>
  );
  return (
    <li>
      {props.onClick ? (
        <button type="button" class="row row-pick" onClick={props.onClick}>
          {text}
          <Chevron />
        </button>
      ) : (
        <div class="row row-pick row-pick-soon">{text}</div>
      )}
    </li>
  );
}

/** Back to the choice. Without a choice (one way only) there is nothing to go back to. */
function Back(props: { go: (stage: Stage) => void }) {
  if (!CHOICE) return null;
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
              {EMAIL_SOON ? <Pick title="Email" text="Coming soon." /> : null}
              {OWN ? <Pick title="Your own alert service" text="You run it on a server. We learn nothing about you." onClick={() => go("own")} /> : null}
            </ul>
            {BOT || EMAIL ? (
              <Notice kind="info" title="Our alert service is not private">
                To send you an alert, it must know who follows this Chronobox. We can see that.
                {OWN ? " If you do not want that and you can run a server, run your own alert service." : null}
              </Notice>
            ) : null}
          </>
        ),
      };
    case "telegram":
      return {
        title: CHOICE ? "Alerts in Telegram" : "Get told",
        lead: CHOICE ? "Telegram opens. Press Start there, and you are done." : "The wait protects you only if you hear about a withdrawal in time.",
        body: (
          <>
            <div class="modal-actions">
              <a class="button button-primary" href={telegramLink(BOT ?? "", chain.id, safe)} target="_blank" rel="noreferrer noopener">
                Get alerts in Telegram
              </a>
              <Back go={go} />
            </div>
            <p class="deposit-note">
              {CHOICE ? null : "Telegram opens. Press Start there. "}
              Our alert service keeps the number of your Telegram chat, the address of this Chronobox, and since when you follow it. So we
              can see that your Telegram account follows this Chronobox, and Telegram can see it too. To end the alerts, send /stop there.
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
              Our alert service keeps your email address, the address of this Chronobox, and since when you follow it. So we can see that
              your email address follows this Chronobox. Every alert ends with a link that stops them.
            </p>
          </>
        ),
      };
    case "own":
      return {
        title: "Your own alert service",
        lead: "The alert service is open source. If you can run a server, you can run it yourself. Then it writes only to you, and we learn nothing about you.",
        body: (
          <>
            <div class="modal-actions">
              <a class="button button-primary" href={OWN ?? ""} target="_blank" rel="noreferrer noopener">
                See how on GitHub
              </a>
              <Back go={go} />
            </div>
            <p class="deposit-note">The guide there shows what you need, and every step.</p>
          </>
        ),
      };
  }
}

export function AlertsSheet(props: { chain: Chain; safe: Address; onClose: () => void }) {
  // With one way and nothing coming, the sheet opens on that way.
  const [stage, setStage] = useState<Stage>(CHOICE ? "choose" : WAYS[0]);
  if (!ALERTS) return null;
  const screen = screenOf(stage, { chain: props.chain, safe: props.safe, go: setStage });
  return (
    <Modal title={screen.title} lead={screen.lead} onClose={props.onClose}>
      {screen.body}
    </Modal>
  );
}
