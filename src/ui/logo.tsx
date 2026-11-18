import { SunArt } from "./art.tsx";

/**
 * The Chronobox mark: the Zodiac tile (its sky, and its planet as the horizon),
 * with the path of the sun on it. The path behind the sun is solid, the path
 * ahead is pale: the sun has a way to go before the box opens.
 */
export function Mark(props: { size?: number }) {
  return <SunArt size={props.size ?? 28} />;
}

export function Lockup() {
  return (
    <a class="lockup" href="#/" aria-label="Zodiac Chronobox, start page">
      <Mark />
      <span class="lockup-word">CHRONOBOX</span>
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
