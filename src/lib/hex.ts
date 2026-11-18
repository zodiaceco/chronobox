import { keccak_256 } from "@noble/hashes/sha3.js";

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out as Hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = strip(hex);
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("Invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Hex without the 0x prefix, lower case. */
export function strip(hex: string): string {
  return (hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex).toLowerCase();
}

export function concat(...parts: string[]): Hex {
  return ("0x" + parts.map(strip).join("")) as Hex;
}

/** Byte length of a hex string. */
export function size(hex: string): number {
  return strip(hex).length / 2;
}

export function keccak(data: string | Uint8Array): Hex {
  return bytesToHex(keccak_256(typeof data === "string" ? hexToBytes(data) : data));
}

export function utf8(text: string): Hex {
  return bytesToHex(new TextEncoder().encode(text));
}

/** Left-pad to 32 bytes. Returns hex without prefix. */
export function word(hex: string): string {
  const h = strip(hex);
  if (h.length > 64) throw new Error("Value is longer than 32 bytes");
  return h.padStart(64, "0");
}

export function uintWord(value: bigint | number): string {
  const v = BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new Error("uint256 out of range");
  return v.toString(16).padStart(64, "0");
}

export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** EIP-55 checksum form. */
export function checksum(address: string): Address {
  const lower = strip(address);
  if (lower.length !== 40) throw new Error("Invalid address");
  const hash = strip(keccak(utf8(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out as Address;
}

/** Rejects mixed-case addresses with a wrong checksum. */
export function parseAddress(value: string): Address | null {
  const v = value.trim();
  if (!isAddress(v)) return null;
  const body = v.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksum(v) !== v) return null;
  return checksum(v);
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && strip(a) === strip(b);
}

export function toBigInt(hex: string): bigint {
  const h = strip(hex);
  return h === "" ? 0n : BigInt("0x" + h);
}

export function toQuantity(value: bigint | number): Hex {
  return ("0x" + BigInt(value).toString(16)) as Hex;
}
