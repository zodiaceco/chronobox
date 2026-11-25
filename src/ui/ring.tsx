/**
 * The state of a wait, as a ring: full while all of the wait is ahead, empty when it is over.
 * It starts at the top and runs clockwise, like a clock. It is a plain ring, not the mark.
 *
 * Everything is set with SVG attributes, not with styles: the page's content security policy
 * allows no inline style.
 */
export function Ring(props: {
  size?: number;
  /** How much of the wait is still ahead: 1 is all of it, 0 is none. */
  left: number;
  /** Plays once: the ring snaps shut in red, and then settles in blue. A cancel: locked as before. */
  play?: "cancel";
  label?: string;
}) {
  const left = Math.max(0, Math.min(1, props.left));
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const play = still ? undefined : props.play;
  const size = props.size ?? 28;
  const ease = { calcMode: "spline", keyTimes: "0;1", keySplines: "0.45 0 0.55 1", fill: "freeze" } as const;
  // After a cancel the ring is full. Without motion it is shown that way at once.
  const shown = props.play && !play ? 1 : left;
  return (
    <svg
      class="ring"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      focusable="false"
    >
      <circle class="ring-track" cx="32" cy="32" r="24" fill="none" stroke-width="8" />
      {shown > 0.001 || play ? (
        <circle
          class={play ? "ring-arc ring-arc-cancel" : "ring-arc"}
          cx="32"
          cy="32"
          r="24"
          fill="none"
          stroke-width="8"
          stroke-linecap={shown >= 0.999 && !play ? undefined : "round"}
          pathLength="100"
          stroke-dasharray="100"
          stroke-dashoffset={String(100 * (1 - (play ? Math.min(left, 0.9) : shown)))}
          transform="rotate(-90 32 32)"
        >
          {play ? <animate attributeName="stroke-dashoffset" to="0" begin="0.35s" dur="0.45s" {...ease} /> : null}
        </circle>
      ) : null}
      {/* After a cancel the red ring gives way to a plain blue one: locked as before. */}
      {play ? (
        <circle class="ring-arc" cx="32" cy="32" r="24" fill="none" stroke-width="8" opacity="0">
          <animate attributeName="opacity" from="0" to="1" begin="1.2s" dur="0.7s" fill="freeze" />
        </circle>
      ) : null}
    </svg>
  );
}
