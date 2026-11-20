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
          r="22"
          fill="none"
          stroke="currentColor"
          stroke-width="8"
          pathLength="100"
          transform={RING}
          stroke-dasharray={full ? undefined : "100"}
          stroke-dashoffset={full ? undefined : String(100 * (1 - (play === "drain" ? 1 : left)))}
        >
          {play === "close" ? <animate attributeName="stroke-dashoffset" from="60" to="0" dur="0.9s" {...ease} /> : null}
          {play === "drain" ? <animate attributeName="stroke-dashoffset" from="0" to="14" begin="0.3s" dur="1.4s" {...ease} /> : null}
        </circle>
      ) : null}
      <path d={KNOB} fill-rule="evenodd" fill="currentColor" transform={props.turned ? "rotate(-180 32 32)" : undefined} />
    </svg>
  );
}

export function Mark(props: { size?: number }) {
  return <Dial size={props.size ?? 28} />;
}

export function Lockup() {
  return (
    <a class="lockup" href="#/" aria-label="Zodiac Chronobox, start page">
      <Mark size={26} />
      <span class="lockup-word">Chronobox</span>
    </a>
  );
}

/** The parent brand, shown as an endorsement. */
export function ByZodiac() {
  return (
    <span class="by-zodiac">
      by
      <img class="only-light" src="./zodiac-light.svg" alt="Zodiac" height="12" />
      <img class="only-dark" src="./zodiac-dark.svg" alt="Zodiac" height="12" />
    </span>
  );
}
