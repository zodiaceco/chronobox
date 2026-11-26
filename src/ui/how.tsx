/**
 * "How it works" in five pictures, drawn with the parts of the mark: the
 * Zodiac tile, the path of the sun, the sun, a coin. Captions are plain HTML.
 *
 * Each step answers the pointer: its picture moves, and a card says what a
 * person wants to know at that step. In the row the card is as wide as the
 * row and sits directly under the pictures, with a corner that points at
 * the picture it belongs to. The row itself shows only a title and one line
 * for each step. With a mouse the card opens on
 * hover. With a finger or the keyboard it opens and closes on a tap or Enter.
 * On a narrow column the card opens in place, under the text of its step.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { CHAINS } from "../lib/chains.ts";
import { DelayArt, DepositArt, GuardianArt, NightArt, WalletArt } from "./art.tsx";
import { ChainLogo } from "./chain-logo.tsx";

type StepProps = {
  n: number;
  title: string;
  text: string;
  art: ComponentChildren;
  /** The card: one sentence in bold and a few words on it, and beside them what is worth knowing. */
  more: { lead: string; text: string; side: ComponentChildren };
  /** Not part of the setup: no line joins it to the step before, and its number is a "+". */
  optional?: boolean;
  open: boolean;
  onOpen: (open: boolean, how: "hover" | "toggle") => void;
};

function Num(props: { n: number; optional?: boolean }) {
  return props.optional ? (
    <span class="hiw-num hiw-num-optional" role="img" aria-label="Optional">
      +
    </span>
  ) : (
    <span class="hiw-num">{props.n}</span>
  );
}

function Step(props: StepProps) {
  const id = `hiw-more-${props.n}`;
  return (
    <li
      class={`hiw-step${props.optional ? " hiw-step-optional" : ""}${props.open ? " is-open" : ""}`}
      // Only a mouse hovers. A finger that taps also sends these, and the tap itself then decides.
      onPointerEnter={(event) => event.pointerType === "mouse" && props.onOpen(true, "hover")}
      onPointerLeave={(event) => event.pointerType === "mouse" && props.onOpen(false, "hover")}
      onKeyDown={(event) => event.key === "Escape" && props.onOpen(false, "toggle")}
    >
      <button
        type="button"
        class="hiw-trigger"
        aria-expanded={props.open}
        aria-controls={id}
        onClick={(event) => {
          // A click of the mouse arrives when the card is open already, from the hover. It stays open.
          if ((event as { pointerType?: string }).pointerType !== "mouse") props.onOpen(!props.open, "toggle");
        }}
      >
        {props.art}
        <span class="hiw-copy">
          <Num n={props.n} optional={props.optional} />
          <span class="hiw-title">{props.title}</span>
          <span class="hiw-text">{props.text}</span>
        </span>
        <svg class="hiw-chevron" viewBox="0 0 14 8" width="14" height="8" aria-hidden="true">
          <path d="M1 1l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div class="hiw-more" id={id} role="region" aria-label={props.title} aria-hidden={!props.open}>
        <div class="hiw-card">
          <div class="hiw-card-inner">
            <div class="hiw-card-main">
              {/* In the row the card covers the titles, so it names its step. */}
              <p class="hiw-card-step">
                <Num n={props.n} optional={props.optional} />
                {props.title}
              </p>
              <p class="hiw-card-lead">{props.more.lead}</p>
              <p>{props.more.text}</p>
            </div>
            <div class="hiw-card-side">{props.more.side}</div>
          </div>
        </div>
      </div>
    </li>
  );
}

function Ticks(props: { lines: string[] }) {
  return (
    <ul class="hiw-ticks">
      {props.lines.map((line) => (
        <li key={line}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          {line}
        </li>
      ))}
    </ul>
  );
}

export function HowItWorks() {
  const [open, setOpen] = useState<number | null>(null);
  // Leaving a step for the next one must not flicker: the close waits a moment, and an open cancels it.
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cancel = () => {
    if (closing.current) clearTimeout(closing.current);
    closing.current = null;
  };
  const handler = (n: number) => (on: boolean, how: "hover" | "toggle") => {
    cancel();
    if (on) return setOpen(n);
    if (how === "toggle") return setOpen((now) => (now === n ? null : now));
    closing.current = setTimeout(() => setOpen((now) => (now === n ? null : now)), 90);
  };
  useEffect(() => {
    // A tap or a click outside closes the open card.
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      cancel();
    };
  }, []);
  const step = (n: number) => ({ n, open: open === n, onOpen: handler(n) });
  const networks = CHAINS.filter((chain) => !chain.testnet);

  return (
    <div class="hiw" ref={root}>
      <ol>
        <Step
          {...step(1)}
          title="Set up"
          text="Create your Chronobox with your wallet."
          art={<WalletArt class="hiw-art" />}
          more={{
            lead: "Connect your wallet.",
            text: "Your wallet controls your Chronobox. No account, no email, no password.",
            side: (
              <>
                <p class="hiw-card-label">Works on</p>
                <ul class="hiw-chips">
                  {networks.map((chain) => (
                    <li key={chain.id}>
                      <ChainLogo chainId={chain.id} />
                      {chain.name}
                    </li>
                  ))}
                </ul>
              </>
            ),
          }}
        />
        <Step
          {...step(2)}
          title="Set the delay"
          text="Choose how long every withdrawal must wait."
          art={<DelayArt class="hiw-art" />}
          more={{
            lead: "You choose the wait.",
            text: "Every withdrawal waits this long. You can change it later, and that change waits too.",
            side: (
              <>
                <ul class="hiw-chips">
                  {["24 hours", "48 hours", "7 days", "30 days"].map((time) => (
                    <li key={time}>{time}</li>
                  ))}
                  <li class="hiw-chip-quiet">or your own, from 1 hour to 90 days</li>
                </ul>
              </>
            ),
          }}
        />
        <Step
          {...step(3)}
          title="Deposit"
          text="Send money to your Chronobox."
          art={<DepositArt class="hiw-art" />}
          more={{
            lead: "Any token, from anywhere.",
            text: "Your Chronobox has its own address. Send to it from a wallet or an exchange, as often as you like.",
            side: (
              <>
                <ul class="hiw-chips">
                  {["ETH", "USDC", "USDT", "DAI", "WBTC", "wstETH"].map((symbol) => (
                    <li key={symbol}>{symbol}</li>
                  ))}
                  <li class="hiw-chip-quiet">and other ERC-20 tokens</li>
                </ul>
              </>
            ),
          }}
        />
        <Step
          {...step(4)}
          title="Peace of mind"
          text="Nobody can take it in a hurry."
          art={<NightArt class="hiw-art" />}
          more={{
            lead: "A stolen key is not enough.",
            text: "A person who has your wallet still has to wait. That is your time to act.",
            side: <Ticks lines={["Every withdrawal waits the full time.", "You can cancel it until the wait ends.", "This app sends withdrawals back to your wallet."]} />,
          }}
        />
        <Step
          {...step(5)}
          optional
          title="Add a guardian"
          text="Can say stop, and bring you back in."
          art={<GuardianArt class="hiw-art" />}
          more={{
            lead: "A second pair of eyes. And a way back in.",
            text: "Optional, and added later. Your second device, or a person you trust. If you lose your wallet, your guardian can choose a new one. That waits months, and you can stop it.",
            side: (
              <dl class="hiw-lanes">
                <dt>At once</dt>
                <dd>Stop a withdrawal. Change the wallet with you.</dd>
                <dt class="hiw-lane-slow">After months</dt>
                <dd>Change the wallet alone, if you lose yours.</dd>
                <dt>Never</dt>
                <dd>Withdraw.</dd>
              </dl>
            ),
          }}
        />
      </ol>
    </div>
  );
}
