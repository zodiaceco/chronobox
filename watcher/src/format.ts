// Text for people: names of networks, times, durations and amounts.

const NETWORK_NAMES: Record<number, string> = {
  1: 'Ethereum', 10: 'OP Mainnet', 100: 'Gnosis', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum One', 11155111: 'Sepolia',
};
export const networkName = (chainId: number) => NETWORK_NAMES[chainId] ?? `network ${chainId}`;

/** The names of the networks in the links of the app. The same list is in src/lib/chains.ts (`short`). */
const NETWORK_SHORT: Record<number, string> = { 1: 'eth', 100: 'gno', 8453: 'base', 42161: 'arb1', 11155111: 'sep' };
/** The Chronobox app. Its page of a Chronobox is the one link in an alert. */
export const APP_URL = 'https://www.chrono.box';
/** The page of a Chronobox in the app (#/v/<network>:<address>). Null on a network that the app does not have. */
export function boxLink(app: string, chainId: number, vault: string): string | null {
  const short = NETWORK_SHORT[chainId];
  return short ? `${app}/#/v/${short}:${vault}` : null;
}


export function fmtTime(sec: bigint | number): string {
  const s = BigInt(sec);
  if (s > 8_000_000_000_000n) return 'never (date out of range)';
  return new Date(Number(s) * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A time as a person reads it: "21 Nov 2026, 20:34 UTC". The watcher does not know where the reader lives. */
export function fmtWhen(sec: bigint | number): string {
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return String(sec);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

export function fmtDuration(sec: bigint | number): string {
  let s = BigInt(sec);
  if (s <= 0n) return '0 seconds';
  if (s > 3_153_600_000n) return `${s} seconds (more than 100 years)`;
  const units: [string, bigint][] = [['day', 86400n], ['hour', 3600n], ['minute', 60n], ['second', 1n]];
  const parts: string[] = [];
  for (const [name, size] of units) {
    const n = s / size;
    if (n > 0n) { parts.push(`${n} ${name}${n === 1n ? '' : 's'}`); s -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

export function fmtUnits(v: bigint, decimals: number): string {
  if (decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------------------
// ABI helpers

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
