/**
 * The parts of the Chronobox mark, and the small pictures that are drawn with
 * them. Everything sits on the Zodiac tile: its sky, and its planet as the
 * horizon. White is what moves: the path of the sun, the sun, a coin.
 *
 * All pictures use the same 64 x 64 grid as the mark.
 */
import type { ComponentChildren } from "preact";

const WHITE = "#fff";
const BLUE = "#469CED";

/** The path of the sun: a circle around (32, 41) with radius 17. Both ends are behind the planet. */
const CX = 32;
const CY = 41;
const R = 17;
const PATH_START = 195;
const PATH_END = -15;
/** Where the sun sits in the mark itself. */
export const MARK_DEG = 118;

function at(deg: number, r = R): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [Number((CX + r * Math.cos(a)).toFixed(2)), Number((CY - r * Math.sin(a)).toFixed(2))];
}

function arc(from: number, to: number): string {
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  return `M${x0} ${y0}A${R} ${R} 0 ${from - to > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * The tile. `behind` is drawn behind the planet, the children in front of it.
 * The ids are the same in every tile on a page, and so is what they define.
 */
export function Tile(props: { size?: number; class?: string; planet?: boolean; behind?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <svg class={props.class ?? "mark"} viewBox="0 0 64 64" width={props.size ?? 64} height={props.size ?? 64} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="cb-tile">
          <rect x="2" y="2" width="60" height="60" rx="15.5" />
        </clipPath>
        <radialGradient id="cb-sky" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(31.83 96.21) scale(104.07 99.1)">
          <stop offset="0.596" stop-color="#B1D3F2" />
          <stop offset="0.803" stop-color={BLUE} />
          <stop offset="1" stop-color="#286CB2" />
        </radialGradient>
      </defs>
      <g clip-path="url(#cb-tile)">
        <rect x="2" y="2" width="60" height="60" fill="url(#cb-sky)" />
        {props.behind}
        {props.planet === false ? null : <circle cx="31.83" cy="96.21" r="61.01" fill={BLUE} />}
        {props.children}
      </g>
    </svg>
  );
}

/** The path: solid from its start to `solidTo`, pale after that. `gap` leaves room around something that sits on it. */
function Path(props: { solidTo: number; gap?: { deg: number; half: number } }) {
  const parts: { from: number; to: number; pale: boolean }[] = [];
  const add = (from: number, to: number, pale: boolean) => {
    if (!props.gap) return void parts.push({ from, to, pale });
    const hi = props.gap.deg + props.gap.half;
    const lo = props.gap.deg - props.gap.half;
    if (from > hi) parts.push({ from, to: Math.max(to, hi), pale });
    if (to < lo) parts.push({ from: Math.min(from, lo), to, pale });
  };
  if (props.solidTo < PATH_START) add(PATH_START, Math.max(props.solidTo, PATH_END), false);
  if (props.solidTo > PATH_END) add(Math.min(props.solidTo, PATH_START), PATH_END, true);
  return (
    <>
      {parts
        .filter((part) => part.from > part.to)
        .map((part) => (
          <path key={`${part.from}-${part.to}`} d={arc(part.from, part.to)} fill="none" stroke={WHITE} stroke-width="2.6" opacity={part.pale ? 0.45 : undefined} />
        ))}
    </>
  );
}

function Sun(props: { deg: number }) {
  const [x, y] = at(props.deg);
  return <circle cx={x} cy={y} r="6" fill={WHITE} />;
}

/** Money: the outline of a coin with a dollar symbol, in the same line as the wallet. */
function Coin(props: { x: number; y: number; r: number }) {
  return (
    <g transform={`translate(${props.x} ${props.y}) scale(${props.r})`} fill="none" stroke={WHITE} stroke-linecap="round">
      <circle r="0.85" stroke-width="0.3" />
      <path d="M0.27 -0.27C0.2 -0.5 -0.3 -0.5 -0.3 -0.2C-0.3 0.07 0.3 -0.07 0.3 0.21C0.3 0.5 -0.22 0.5 -0.29 0.27" stroke-width="0.17" />
      <path d="M0 -0.6V0.6" stroke-width="0.17" />
    </g>
  );
}

type ArtProps = { size?: number; class?: string };

/**
 * The mark: the sun on its path. Behind it the path is solid, ahead of it the path is pale.
 * The sun is behind the planet, in every picture: low on its path, the horizon covers a part
 * of it, as at sunrise and sunset.
 */
export function SunArt(props: ArtProps & { deg?: number }) {
  const deg = props.deg ?? MARK_DEG;
  return (
    <Tile
      size={props.size}
      class={props.class}
      behind={
        <>
          <Path solidTo={deg} />
          <Sun deg={deg} />
        </>
      }
    />
  );
}

/**
 * The sun at sunrise, for "set the delay". The sun and the solid part
 * of the path are placed by the stylesheet (.art-run), so they can move on:
 * when the picture is in motion, the sun runs its way to sunset.
 */
export function DelayArt(props: ArtProps) {
  const [x, y] = at(0);
  return (
    <Tile
      size={props.size}
      class={props.class}
      behind={
        <>
          <path d={arc(PATH_START, PATH_END)} fill="none" stroke={WHITE} stroke-width="2.6" opacity="0.45" />
          <path class="art-run-path" d={arc(PATH_START, PATH_END)} fill="none" stroke={WHITE} stroke-width="2.6" pathLength="100" stroke-dasharray="100" />
          <circle class="art-run-sun" cx={x} cy={y} r="6" fill={WHITE} />
        </>
      }
    />
  );
}

/** How long one pass of the sun takes, in seconds. */
const PASS_SECONDS = 5;

/**
 * The mark in motion: the sun rises behind the horizon, goes along its whole
 * path once and sets. The path turns solid behind it. Then the picture settles
 * into the mark. With reduced motion it is the mark from the start.
 */
export function SunPassArt(props: ArtProps) {
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still) return <SunArt size={props.size} class={props.class} />;
  const ease = { calcMode: "spline", keyTimes: "0;1", keySplines: "0.45 0 0.55 1" };
  const [sunX, sunY] = at(0);
  return (
    <Tile
      size={props.size}
      class={props.class}
      behind={
        <>
          {/* The pass: it is drawn behind the planet, so the sun rises and sets. */}
          <g>
            <path d={arc(PATH_START, PATH_END)} fill="none" stroke={WHITE} stroke-width="2.6" opacity="0.45" />
            <path d={arc(PATH_START, PATH_END)} fill="none" stroke={WHITE} stroke-width="2.6" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100">
              <animate attributeName="stroke-dashoffset" from="100" to="0" dur={`${PASS_SECONDS}s`} fill="freeze" {...ease} />
            </path>
            <circle cx={sunX} cy={sunY} r="6" fill={WHITE} transform={`rotate(${-PATH_START} ${CX} ${CY})`}>
              <animateTransform attributeName="transform" type="rotate" from={`${-PATH_START} ${CX} ${CY}`} to={`${-PATH_END} ${CX} ${CY}`} dur={`${PASS_SECONDS}s`} fill="freeze" {...ease} />
            </circle>
            <animate attributeName="opacity" from="1" to="0" begin={`${PASS_SECONDS}s`} dur="0.6s" fill="freeze" />
          </g>
          {/* The mark, which comes in when the pass is over. */}
          <g opacity="0">
            <Path solidTo={MARK_DEG} />
            <Sun deg={MARK_DEG} />
            <animate attributeName="opacity" from="0" to="1" begin={`${PASS_SECONDS}s`} dur="0.6s" fill="freeze" />
          </g>
        </>
      }
    />
  );
}

/** A wallet in the open sky. It is the key, and it is outside the box. */
export function WalletArt(props: ArtProps) {
  return (
    <Tile size={props.size} class={props.class} planet={false}>
      <g class="art-wallet">
        <path class="art-flap" d="M20.5 24L38 16.5L41 24" fill="none" stroke={WHITE} stroke-width="2.6" stroke-linejoin="round" />
        <rect x="16" y="24" width="32" height="22" rx="5" fill="none" stroke={WHITE} stroke-width="2.6" />
        <rect x="37.5" y="30.5" width="13" height="9" rx="4.5" fill={WHITE} />
        <circle cx="42.5" cy="35" r="1.7" fill={BLUE} />
        {/* A signal from the clasp. It shows only while the picture is in motion. */}
        <circle class="art-ping" cx="42.5" cy="35" r="5" fill="none" stroke={WHITE} stroke-width="1.6" opacity="0" />
      </g>
    </Tile>
  );
}

/** The box with money in it: a coin that rests on the horizon. */
export function BoxArt(props: ArtProps) {
  return (
    <Tile size={props.size} class={props.class} behind={<Coin x={32} y={27.6} r={7.6} />}>
      {null}
    </Tile>
  );
}

/** A coin on its way down, behind the horizon. */
export function DepositArt(props: ArtProps) {
  return (
    <Tile
      size={props.size}
      class={props.class}
      behind={
        // Behind the planet, so a coin in motion goes down behind the horizon.
        <g class="art-coin">
          <Coin x={32} y={17.4} r={7.4} />
        </g>
      }
    >
      <path class="art-arrow" d="M27.4 29.2L32 33.2L36.6 29.2" fill="none" stroke={WHITE} stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    </Tile>
  );
}

/** Night. The moon is on the path, and nothing moves. */
export function NightArt(props: ArtProps) {
  const deg = 60;
  const [x, y] = at(deg);
  const r = 6.4;
  return (
    <Tile size={props.size} class={props.class} behind={<Path solidTo={PATH_START} gap={{ deg, half: 27 }} />}>
      <mask id="cb-moon" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <circle cx={x} cy={y} r={r} fill="#fff" />
        <circle cx={Number((x + r * 0.46).toFixed(2))} cy={Number((y - r * 0.3).toFixed(2))} r={Number((r * 0.86).toFixed(2))} fill="#000" />
      </mask>
      <rect class="art-moon" x="0" y="0" width="64" height="64" fill={WHITE} mask="url(#cb-moon)" />
      <circle class="art-star" cx="19" cy="17" r="1.1" fill={WHITE} />
      <circle class="art-star" cx="27.5" cy="12.5" r="0.8" fill={WHITE} />
      {/* A third star. It shows only while the picture is in motion. */}
      <circle class="art-star art-star-extra" cx="12.5" cy="26" r="0.9" fill={WHITE} opacity="0" />
    </Tile>
  );
}

/**
 * The guardian: a moon in the sky, off the path. The sun keeps its place on the
 * path, as in the mark. The moon does not walk the path: it only watches.
 * The mask has its own id, because the night picture is on the same page.
 */
export function GuardianArt(props: ArtProps) {
  const x = 47.5;
  const y = 14.5;
  const r = 5.2;
  return (
    <Tile
      size={props.size}
      class={props.class}
      behind={
        <>
          <Path solidTo={MARK_DEG} />
          <Sun deg={MARK_DEG} />
        </>
      }
    >
      <mask id="cb-guardian-moon" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <circle cx={x} cy={y} r={r} fill="#fff" />
        <circle cx={Number((x + r * 0.46).toFixed(2))} cy={Number((y - r * 0.3).toFixed(2))} r={Number((r * 0.86).toFixed(2))} fill="#000" />
      </mask>
      <rect x="0" y="0" width="64" height="64" fill={WHITE} mask="url(#cb-guardian-moon)" />
      {/* It keeps watch. The signal shows only while the picture is in motion. */}
      <circle class="art-ping" cx={x} cy={y} r={r + 1} fill="none" stroke={WHITE} stroke-width="1.6" opacity="0" />
    </Tile>
  );
}
