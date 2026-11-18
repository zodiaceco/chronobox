/**
 * The Timebox mark, concept "Horizon dial": the Zodiac horizon, and the path
 * of the sun above it. The sun has a way to go before the box opens.
 */
export function Mark(props: { size?: number }) {
  const size = props.size ?? 28;
  return (
    <svg class="mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path d="M6.06 45.81A26 26 0 0 1 57.94 45.81" fill="none" stroke="currentColor" stroke-width="5" />
      <path d="M2 50A44 44 0 0 1 62 50Z" fill="#469CED" />
      <circle cx="15.99" cy="23.51" r="7.5" fill="currentColor" />
    </svg>
  );
}

export function Lockup() {
  return (
    <a class="lockup" href="#/" aria-label="Zodiac Timebox, start page">
      <Mark />
      <span class="lockup-word">TIMEBOX</span>
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
