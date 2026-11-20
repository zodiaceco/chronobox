/**
 * The Chronobox mark: the dial of a vault that counts down.
 *
 * A full ring means locked. The ring drains while an unlock waits, and when
 * it is empty the knob turns: unlocked. The mark is drawn in the colour of the
 * text around it.
 *
 * Everything is set with SVG attributes, not with styles: the page's content
 * security policy allows no inline style.
 */

/*
 * Proportions, measured on the lockup of the brand's own film: with the outer edge of the ring at
 * 26, the ring is 9.6 thick, and the knob has a radius of 8.4. So the space between knob and ring
 * (8) is a little less than the ring is thick, and the mark reads as one solid shape when small.
 */
const RING_RADIUS = 21.2;
const RING_WIDTH = 9.6;
/** The knob is drawn with a radius of 8 and made this much larger around the centre. */
const KNOB_SCALE = "translate(32 32) scale(1.05) translate(-32 -32)";

/** The ring starts at the top right and drains clockwise. */
const RING = "rotate(-40 32 32) translate(0 64) scale(1 -1)";
/** The knob: a disc with a slot cut out to the right. */
const KNOB = "M24 32a8 8 0 1 0 16 0a8 8 0 1 0 -16 0ZM39.8384 30.4A8 8 0 0 1 39.8384 33.6H32A1.6 1.6 0 0 1 32 30.4Z";

export function Dial(props: {
  size?: number;
  /** How much of the ring is left: 1 is locked, 0 is unlocked. */
  left?: number;
  /** The knob is turned: the wait is over. */
  turned?: boolean;
  /** Plays once: "close" shuts an open ring (locked), "drain" opens a full ring a little (the wait has started). */
  play?: "close" | "drain";
  class?: string;
  label?: string;
}) {
  const left = Math.max(0, Math.min(1, props.left ?? 1));
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const play = still ? undefined : props.play;
  const ease = { calcMode: "spline", keyTimes: "0;1", keySplines: "0.45 0 0.55 1", fill: "freeze" } as const;
  // A full ring is a plain circle, so the locked mark has no seam where the stroke starts and ends.
  const full = left >= 0.999 && !play;
  return (
    <svg
      class={props.class ?? "mark"}
      viewBox="0 0 64 64"
      width={props.size ?? 28}
      height={props.size ?? 28}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      focusable="false"
    >
      {left > 0.001 || play ? (
        <circle
          cx="32"
          cy="32"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          stroke-width={RING_WIDTH}
          pathLength="100"
          transform={RING}
          stroke-dasharray={full ? undefined : "100"}
          stroke-dashoffset={full ? undefined : String(100 * (1 - (play === "drain" ? 1 : left)))}
        >
          {play === "close" ? <animate attributeName="stroke-dashoffset" from="60" to="0" dur="0.9s" {...ease} /> : null}
          {play === "drain" ? <animate attributeName="stroke-dashoffset" from="0" to="14" begin="0.3s" dur="1.4s" {...ease} /> : null}
        </circle>
      ) : null}
      {/* A ring that was drawn shut still has a hairline where its two ends meet. When it is shut, a plain circle takes its place. */}
      {play === "close" ? (
        <circle cx="32" cy="32" r={RING_RADIUS} fill="none" stroke="currentColor" stroke-width={RING_WIDTH} opacity="0">
          <set attributeName="opacity" to="1" begin="0.9s" fill="freeze" />
        </circle>
      ) : null}
      <path d={KNOB} fill-rule="evenodd" fill="currentColor" transform={props.turned ? `rotate(-180 32 32) ${KNOB_SCALE}` : KNOB_SCALE} />
    </svg>
  );
}

/** How much of the ring the logo shows. The gap of 80 degrees opens to the right, so the ring reads as a C. */
export const LOGO_RING = 280 / 360;

/** The logo: the dial with its ring open, a C for Chronobox. */
export function Mark(props: { size?: number }) {
  return <Dial size={props.size ?? 28} left={LOGO_RING} />;
}

export function Lockup() {
  return (
    <a class="lockup" href="#/" aria-label="Zodiac Chronobox, start page">
      <Mark size={30} />
      <span class="lockup-word">CHRONOBOX</span>
    </a>
  );
}

/** The parent brand, shown as an endorsement. */
export function ByZodiac() {
  return (
    <a class="by-zodiac" href="https://zodiac.eco" target="_blank" rel="noreferrer noopener" aria-label="by Zodiac, opens zodiac.eco in a new tab">
      by
      <img class="only-light" src="./zodiac-light.svg" alt="Zodiac" height="12" />
      <img class="only-dark" src="./zodiac-dark.svg" alt="Zodiac" height="12" />
    </a>
  );
}
