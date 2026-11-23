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
const EMAIL: string | null = ALERTS_EMAIL ?? (__DEV__ ? "http://localhost:8787/email" : null);
/** The guide to run the alert service yourself. */
const OWN: string | null = ALERTS_GUIDE ?? (__DEV__ ? "https://github.com/zodiaceco/chronobox/tree/main/watcher#run-it-yourself" : null);

/** The sheet has something to offer. Without it the Chronobox page does not show "Get told". */
export const ALERTS = Boolean(BOT || EMAIL || OWN);

export type Stage = "choose" | "telegram" | "email" | "own";
export type Screen = { title: string; lead?: string; body: ComponentChildren };
export type Ctx = { chain: Chain; safe: Address; go: (stage: Stage) => void };

export function Chevron() {
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

function Back(props: { to: Stage; go: (stage: Stage) => void }) {
  return (
    <Button kind="quiet" onClick={() => props.go(props.to)}>
      Back
    </Button>
  );
}

export function screenOf(stage: Stage, ctx: Ctx): Screen {
  const { chain, safe, go } = ctx;
  const which = telegramStart(chain.id, safe);
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
        title: "Alerts in Telegram",
        lead: "Telegram opens. Press Start there, and you are done.",
        body: (
          <>
            <div class="modal-actions">
              <a class="button button-primary" href={telegramLink(BOT ?? "", chain.id, safe)} target="_blank" rel="noreferrer noopener">
                Open Telegram
              </a>
              <Back to="choose" go={go} />
            </div>
            <p class="hint">
              Our alert service keeps the number of your Telegram chat and the address of this Chronobox. Nothing else. To end the alerts,
              send /stop there.
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
              <a class="button button-primary" href={`${EMAIL}?c=${which}`} target="_blank" rel="noreferrer noopener">
                Open the alert service
              </a>
              <Back to="choose" go={go} />
            </div>
            <p class="hint">
              Our alert service keeps your email address and the address of this Chronobox. Nothing else. Every alert has a line that
              ends them.
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
              <Back to="choose" go={go} />
            </div>
            <p class="hint">The guide there shows what you can run, and what each way needs.</p>
          </>
        ),
      };
  }
}

/** Where the sheet starts: with the choice, or with the one way there is. */
function firstStage(): Stage {
  const ways = [BOT ? "telegram" : null, EMAIL ? "email" : null, OWN ? "own" : null].filter(Boolean) as Stage[];
  return ways.length === 1 ? ways[0] : "choose";
}

export function AlertsSheet(props: { chain: Chain; safe: Address; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>(firstStage);
  if (!ALERTS) return null;
  const screen = screenOf(stage, { chain: props.chain, safe: props.safe, go: setStage });
  return (
    <Modal title={screen.title} lead={screen.lead} onClose={props.onClose}>
      {screen.body}
    </Modal>
  );
}
