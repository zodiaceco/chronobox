/**
 * Alerts without a sign-up.
 *
 * A watcher (watcher/watch.ts --all) watches every Chronobox on a chain and
 * publishes the alerts of each one to an ntfy topic. The topic follows from
 * the address, so the watcher needs no list of users and this app sends
 * nothing to anybody: it only shows where to listen.
 */
import type { Chain } from "./chains.ts";
import type { Address } from "./hex.ts";

/** The public topic of a Chronobox. The same rule is in watcher/watch.ts (alertTopic). */
export function alertTopic(chainId: number, safe: string): string {
  return `chronobox-${chainId}-${safe.toLowerCase()}`;
}

export type AlertLinks = {
  /** The server without the scheme, as the ntfy app wants it in "another server". */
  server: string;
  topic: string;
  /** The topic in a browser. */
  web: string;
  /** Opens the ntfy app and subscribes. Documented for Android only. */
  app: string;
};

export function alertLinks(server: string, chainId: number, safe: string): AlertLinks {
  const base = server.replace(/\/+$/, "");
  const topic = alertTopic(chainId, safe);
  const plain = base.replace(/^https?:\/\//i, "");
  const insecure = /^http:\/\//i.test(base);
  return {
    server: base,
    topic,
    web: `${base}/${topic}`,
    app: `ntfy://${plain}/${topic}${insecure ? "?secure=false" : ""}`,
  };
}

/** The route of the setup page for one Chronobox. It needs no wallet, so it works on any phone. */
export function alertsHref(chain: Chain, safe: Address): string {
  return `#/alerts/${chain.short}:${safe}`;
}
