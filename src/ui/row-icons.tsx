/**
 * The small pictures in front of the rows of a Chronobox: one for each thing a
 * person can look at or change there. They are drawn as lines in the colour of
 * the text, like the chevrons and the close button, so that they work in the
 * light and the dark look without a second set.
 */
import type { ComponentChildren } from "preact";

export type RowIconName = "address" | "delay" | "wallet" | "guardian" | "checks" | "alerts" | "tokens" | "thirdParty";

const SHAPES: Record<RowIconName, ComponentChildren> = {
  // A pin: where this Chronobox is.
  address: (
    <>
      <path d="M10 17.4s5.4-4.8 5.4-9.2a5.4 5.4 0 1 0-10.8 0c0 4.4 5.4 9.2 5.4 9.2z" />
      <circle cx="10" cy="8.1" r="1.9" />
    </>
  ),
  // A clock: how long every withdrawal waits.
  delay: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 6v4.2l2.7 1.6" />
    </>
  ),
  // A wallet: the one that controls this Chronobox.
  wallet: (
    <>
      <path d="M3.2 6.3h12.1a1.5 1.5 0 0 1 1.5 1.5v6.9a1.5 1.5 0 0 1-1.5 1.5H4.7a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M3.2 6.3v-.9a1.5 1.5 0 0 1 1.5-1.5h9.1" />
      <circle cx="13.3" cy="11.2" r="0.6" fill="currentColor" />
    </>
  ),
  // A moon: the guardian, as in the film and in "How it works". It watches.
  guardian: <path d="M16.3 12.2A6.9 6.9 0 1 1 7.8 3.7a5.5 5.5 0 0 0 8.5 8.5z" />,
  // A shield with a tick: the checks passed.
  checks: (
    <>
      <path d="M10 2.7l5.8 2.1v4.7c0 3.6-2.4 6.3-5.8 7.8-3.4-1.5-5.8-4.2-5.8-7.8V4.8z" />
      <path d="M7.4 10.1l1.9 1.9 3.4-3.8" />
    </>
  ),
  // A bell: get told. The row for it comes with the alerts.
  alerts: (
    <>
      <path d="M5.2 13.7V9a4.8 4.8 0 0 1 9.6 0v4.7l1.4 1.6H3.8z" />
      <path d="M8.4 17.1a1.7 1.7 0 0 0 3.2 0" />
    </>
  ),
  // A mask: third-party services, and what they learn about you.
  thirdParty: (
    <>
      <path d="M2.6 7.6c2.2-1.5 4.7-1.7 7.4-.4 2.7-1.3 5.2-1.1 7.4.4-.1 3.4-1.7 5.6-4.1 5.6-1.5 0-2.4-.9-3.3-2.1-.9 1.2-1.8 2.1-3.3 2.1-2.4 0-4-2.2-4.1-5.6z" />
      <path d="M5.4 9.6c.7-.6 1.6-.6 2.3 0M12.3 9.6c.7-.6 1.6-.6 2.3 0" />
    </>
  ),
  // Two coins: the tokens that this Chronobox shows.
  tokens: (
    <>
      <circle cx="7.9" cy="8" r="4.7" />
      <path d="M12.5 7.2a4.7 4.7 0 1 1-5.4 5.5" />
    </>
  ),
};

export function RowIcon(props: { name: RowIconName }) {
  return (
    <svg
      class="row-icon"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[props.name]}
    </svg>
  );
}
