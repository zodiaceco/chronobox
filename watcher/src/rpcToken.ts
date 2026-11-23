// A token for the internal RPC of Zodiac (rpc.zodiac.eco). That host answers only callers with
// `Authorization: Bearer <token>`: a short-lived HS256 JWT signed with its RPC_TOKEN_SECRET, the same as
// `signRpcToken` in @zodiac/rpc/auth (zodiac-os, packages/rpc/src/rpcToken.ts). A `server` token gets the
// rate limit of our own servers. A fallback RPC on another host never gets the token.
import * as crypto from 'node:crypto';

const ISSUER = 'zodiac-app';
const AUDIENCE = 'zodiac-rpc';
export const RPC_TOKEN_TTL_SECONDS = 10 * 60;
/** A token is made anew this long before it runs out, so that no request goes out with one that just expired. */
const RENEW_BEFORE_SECONDS = 60;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** A signed `server` token for `subject`, valid for `ttlSeconds` from `now` (seconds since 1970). */
export function signRpcToken(secret: string, subject: string, now = Math.floor(Date.now() / 1000), ttlSeconds = RPC_TOKEN_TTL_SECONDS): string {
  const head = b64(JSON.stringify({ alg: 'HS256' }));
  const body = b64(JSON.stringify({ scope: 'server', iss: ISSUER, aud: AUDIENCE, sub: subject, iat: now, exp: now + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export type RpcAuth = {
  /** The token goes only to RPC URLs on this host (with or without the port). */
  host: string;
  secret: string;
  subject: string;
};

/** The current token per secret and subject. Every watcher of one process shares it. */
const cache = new Map<string, { token: string; exp: number }>();

/** The headers for one RPC URL: a token for the internal host, nothing for any other. */
export function rpcAuthHeaders(auth: RpcAuth | undefined, url: string): Record<string, string> {
  if (!auth) return {};
  let u: URL;
  try { u = new URL(url); } catch { return {}; }
  if (u.host !== auth.host && u.hostname !== auth.host) return {};
  const key = `${auth.secret}\0${auth.subject}`;
  const now = Math.floor(Date.now() / 1000);
  let entry = cache.get(key);
  if (!entry || entry.exp - RENEW_BEFORE_SECONDS <= now) {
    entry = { token: signRpcToken(auth.secret, auth.subject, now), exp: now + RPC_TOKEN_TTL_SECONDS };
    cache.set(key, entry);
  }
  return { authorization: `Bearer ${entry.token}` };
}
