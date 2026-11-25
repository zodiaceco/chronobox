import type { Address } from "./hex.ts";

/**
 * Makes one plain decimal number out of what a person typed, or null when it can be read in two ways.
 * "1,5" is one and a half. "1,234,567.5" has thousands separators. "1,000" alone can be one or
 * one thousand, and a wrong guess moves money, so it is refused.
 */
export function plainNumber(text: string): string | null {
  const value = text.trim().replace(/[\s_']/g, "");
  if (!value.includes(",")) return value;
  if (/^\d{1,3}(,\d{3})+\.\d*$/.test(value) || /^\d{1,3}(,\d{3}){2,}$/.test(value)) return value.replace(/,/g, "");
  if (/^\d*,\d*$/.test(value)) return /^[1-9]\d{0,2},\d{3}$/.test(value) ? null : value.replace(",", ".");
  return null;
}

/** "1.5" with 18 decimals becomes 1500000000000000000n. Returns null for bad input. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const value = plainNumber(text);
  if (value === null || !/^\d*\.?\d*$/.test(value) || value === "" || value === ".") return null;
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

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/**
 * For display where room is short. Below a million it is `formatAmount`. From a million on it is
 * three digits and a word for the size: 1.23M, 45.6B, 789T. Beyond that it is three digits and a
 * power of ten: 1.15 × 10⁷⁷. Rounded down, like every amount on the page: it never shows more
 * than there is. The exact amount belongs in a tooltip next to it.
 */
export function shortAmount(value: bigint, decimals: number, places = 6): string {
  const whole = (value / 10n ** BigInt(decimals)).toString();
  if (whole.length <= 6) return formatAmount(value, decimals, places);
  // The first three digits, with the point where the size word or the power of ten puts it.
  const lead = (before: number) => `${whole.slice(0, before)}${before < 3 ? `.${whole.slice(before, 3)}` : ""}`;
  if (whole.length <= 15) {
    const group = Math.floor((whole.length - 1) / 3);
    return `${lead(whole.length - group * 3)}${["", "K", "M", "B", "T"][group]}`;
  }
  const power = [...String(whole.length - 1)].map((digit) => SUPERSCRIPT[Number(digit)]).join("");
  return `${lead(1)} × 10${power}`;
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
