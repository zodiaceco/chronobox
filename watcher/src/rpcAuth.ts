// The key of the watcher for the internal RPC of Zodiac (rpc.zodiac.eco, deployables/rpc in zodiac-os). That
// host answers only callers with `Authorization: Bearer <credential>`. Chronobox is one of its services: it sends
// a static key, the worker's CHRONOBOX_SERVICE_KEY. The worker then reads with the Alchemy app of chronobox and
// counts the calls against the limit of chronobox, not against the share of the app. A fallback RPC on another
// host never gets the key.

export type RpcAuth = {
  /** The key goes only to RPC URLs on this host (with or without the port). */
  host: string;
  key: string;
};

/** The headers for one RPC URL: the key for the internal host, nothing for any other. */
export function rpcAuthHeaders(auth: RpcAuth | undefined, url: string): Record<string, string> {
  if (!auth) return {};
  let u: URL;
  try { u = new URL(url); } catch { return {}; }
  if (u.host !== auth.host && u.hostname !== auth.host) return {};
  return { authorization: `Bearer ${auth.key}` };
}
