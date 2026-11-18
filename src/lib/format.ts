import type { Address } from "./hex.ts";

/** "1.5" with 18 decimals becomes 1500000000000000000n. Returns null for bad input. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(value) || value === "" || value === ".") return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
}

/** Exact decimal string, without trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const text = value.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** For display: thousands separators and at most `places` decimals, rounded down. */
export function formatAmount(value: bigint, decimals: number, places = 6): string {
  const exact = formatUnits(value, decimals);
  const [whole, fraction = ""] = exact.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cut = fraction.slice(0, places).replace(/0+$/, "");
  if (cut) return `${grouped}.${cut}`;
  return value > 0n && whole === "0" ? `< 0.${"0".repeat(places - 1)}1` : grouped;
}

const UNITS: [string, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

/** "7 days", "1 day 12 hours", "45 minutes". At most two units. */
export function formatDuration(seconds: bigint | number): string {
  let rest = Math.max(0, Number(seconds));
  const parts: string[] = [];
  for (const [name, length] of UNITS) {
    const count = Math.floor(rest / length);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      rest -= count * length;
    }
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(" ") : "0 seconds";
}

const DATE = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(unixSeconds: bigint | number): string {
  return DATE.format(new Date(Number(unixSeconds) * 1000));
}

export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
