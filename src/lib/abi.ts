/**
 * A small ABI encoder and decoder. It supports only the types that Chronobox
 * uses: address, bool, uintN, bytesN, bytes, string and arrays of static types.
 * Tuples and nested arrays are not supported on purpose.
 */
import { type Address, type Hex, checksum, keccak, size, strip, toBigInt, uintWord, utf8, word } from "./hex.ts";

type Value = string | bigint | number | boolean | readonly (string | boolean)[];

function isDynamic(type: string): boolean {
  return type === "bytes" || type === "string" || type.endsWith("[]");
}

function padRight(hex: string): string {
  const h = strip(hex);
  return h.padEnd(Math.ceil(h.length / 64) * 64, "0");
}

function encodeStatic(type: string, value: Value): string {
  if (type === "address") {
    const h = strip(value as string);
    if (h.length !== 40) throw new Error("Invalid address");
    return word(h);
  }
  if (type === "bool") return uintWord(value ? 1n : 0n);
  const fixed = /^bytes([1-9]|[12]\d|3[0-2])$/.exec(type);
  if (fixed) {
    const h = strip(value as string);
    if (h.length !== Number(fixed[1]) * 2) throw new Error(`${type} has the wrong length`);
    return h.padEnd(64, "0");
  }
  if (/^uint(8|16|32|64|128|256)$/.test(type)) {
    const bits = BigInt(type.slice(4));
    const v = BigInt(value as bigint | number);
    if (v < 0n || v >= 1n << bits) throw new Error(`${type} out of range`);
    return uintWord(v);
  }
  throw new Error(`Unsupported type ${type}`);
}

function encodeDynamic(type: string, value: Value): string {
  if (type === "bytes") return uintWord(size(value as string)) + padRight(value as string);
  if (type === "string") return encodeDynamic("bytes", utf8(value as string));
  if (type.endsWith("[]")) {
    const inner = type.slice(0, -2);
    if (isDynamic(inner)) throw new Error("Nested dynamic arrays are not supported");
    const items = value as readonly (string | boolean)[];
    return uintWord(items.length) + items.map((v) => encodeStatic(inner, v)).join("");
  }
  throw new Error(`Unsupported type ${type}`);
}

/** Standard ABI encoding of a parameter list. */
export function encode(types: readonly string[], values: readonly Value[]): Hex {
  if (types.length !== values.length) throw new Error("Type and value count differ");
  const tails: string[] = [];
  const heads: (string | null)[] = types.map((t, i) => {
    if (!isDynamic(t)) return encodeStatic(t, values[i]);
    tails.push(encodeDynamic(t, values[i]));
    return null;
  });
  let offset = types.length * 32;
  let tailIndex = 0;
  let head = "";
  for (const h of heads) {
    if (h !== null) {
      head += h;
    } else {
      head += uintWord(offset);
      offset += tails[tailIndex++].length / 2;
    }
  }
  return ("0x" + head + tails.join("")) as Hex;
}

function parseSignature(signature: string): string[] {
  const open = signature.indexOf("(");
  if (open < 0 || !signature.endsWith(")")) throw new Error(`Bad signature ${signature}`);
  const inner = signature.slice(open + 1, -1);
  return inner === "" ? [] : inner.split(",");
}

export function selector(signature: string): Hex {
  return keccak(utf8(signature)).slice(0, 10) as Hex;
}

export function topic(signature: string): Hex {
  return keccak(utf8(signature));
}

/** Calldata for a function call, for example `call("transfer(address,uint256)", [to, amount])`. */
export function call(signature: string, values: readonly Value[] = []): Hex {
  return (selector(signature) + strip(encode(parseSignature(signature), values))) as Hex;
}

export type Decoded = Address | bigint | boolean | Hex | string | Address[] | Hex[] | boolean[];

/** Decodes ABI data. Throws when the data is too short or an offset is out of range. */
export function decode(types: readonly string[], data: string): Decoded[] {
  const h = strip(data);
  const read = (byteOffset: number): string => {
    const s = h.slice(byteOffset * 2, byteOffset * 2 + 64);
    if (s.length !== 64) throw new Error("ABI data is too short");
    return s;
  };
  const readLength = (byteOffset: number): number => {
    const n = toBigInt(read(byteOffset));
    if (n > BigInt(h.length / 2)) throw new Error("ABI length is out of range");
    return Number(n);
  };
  const staticValue = (type: string, w: string): Decoded => {
    if (type === "address") {
      if (!/^0{24}/.test(w)) throw new Error("Address has dirty high bytes");
      return checksum(w.slice(24));
    }
    if (type === "bool") return toBigInt(w) !== 0n;
    const fixed = /^bytes([1-9]|[12]\d|3[0-2])$/.exec(type);
    if (fixed) {
      const length = Number(fixed[1]) * 2;
      if (!/^0*$/.test(w.slice(length))) throw new Error(`${type} has dirty low bytes`);
      return ("0x" + w.slice(0, length)) as Hex;
    }
    if (type.startsWith("uint")) return toBigInt(w);
    throw new Error(`Unsupported type ${type}`);
  };
  return types.map((type, i) => {
    if (!isDynamic(type)) return staticValue(type, read(i * 32));
    const at = readLength(i * 32);
    const length = readLength(at);
    if (type === "bytes" || type === "string") {
      const body = h.slice((at + 32) * 2, (at + 32 + length) * 2);
      if (body.length !== length * 2) throw new Error("ABI data is too short");
      if (type === "bytes") return ("0x" + body) as Hex;
      return new TextDecoder().decode(Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16)));
    }
    const inner = type.slice(0, -2);
    const out: Decoded[] = [];
    for (let k = 0; k < length; k++) out.push(staticValue(inner, read(at + 32 + k * 32)));
    return out as Address[] | Hex[] | boolean[];
  });
}
