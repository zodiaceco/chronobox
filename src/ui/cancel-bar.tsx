/**
 * After a cancel: the bar of the wait, as the card showed it, flashes red and runs back to empty.
 * Nothing waits any more, and nothing moved.
 *
 * Drawn with SVG attributes and animations, not with styles: the page's content security policy
 * allows no inline style, and a <progress> cannot be animated.
 */
export function CancelBar(props: { /** How much of the wait had passed, from 0 to 1. */ passed: number }) {
  const width = String(Math.round(1000 * Math.max(0, Math.min(1, props.passed))));
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <svg class="cancel-bar" viewBox="0 0 1000 6" preserveAspectRatio="none" role="img" aria-label="The wait was cancelled" focusable="false">
      <rect class="cancel-bar-track" x="0" y="0" width="1000" height="6" rx="3" />
      {still ? null : (
        <>
          {/* The bar as it was, in blue, for a moment. */}
          <rect class="cancel-bar-was" x="0" y="0" width={width} height="6" rx="3">
            <set attributeName="opacity" to="0" begin="0.4s" fill="freeze" />
          </rect>
          {/* The whole bar flashes red, so the cancel is seen even when little of the wait had passed. */}
          <rect class="cancel-bar-out" x="0" y="0" width="1000" height="6" rx="3" opacity="0">
            <animate attributeName="opacity" values="0;0.45;0" keyTimes="0;0.35;1" begin="0.4s" dur="1.4s" fill="freeze" />
          </rect>
          {/* Then red, and back to empty. */}
          <rect class="cancel-bar-out" x="0" y="0" width={width} height="6" rx="3" opacity="0">
            <set attributeName="opacity" to="1" begin="0.4s" fill="freeze" />
            <animate attributeName="width" from={width} to="0" begin="1.1s" dur="0.8s" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.55 1" fill="freeze" />
          </rect>
        </>
      )}
    </svg>
  );
}
