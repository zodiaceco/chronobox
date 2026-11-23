// Alerts by email, for --all and the service on Vercel.
//
// A person gives an email address on a page of this watcher (/api/email), gets one email with a link, and confirms
// on a second page (double opt-in). Only then do the alerts go to that address. Every alert ends with a link that
// stops them. The emails go out through Resend, as plain text and as HTML (mail.tsx, rendered with react-email).
//
// The list of addresses is sealed with ALERTS_KEY, like the list of Telegram chats, and kept in the same store
// (the key "email"). The watcher does not write an address to its log. Resend sees every address and every text
// that it sends.
//
// The pages are one handler (`handle`) that takes a plain request and gives a page (pages.tsx). The service on
// Vercel serves it as the function /api/email (service.ts), the CLI on a port of its own (`servePages`). Which step
// a request is stands in its query or its form (`?confirm=…`, `?stop=…`), so that one path is enough and no rewrite
// is needed. The route table in `handle` lists every step.
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { Config } from './config.ts';
import { networkName, shortAddr } from './format.ts';
import { alertHtml, confirmHtml } from './mail.tsx';
import * as pages from './pages.tsx';
import { EMAIL_PATH, type Page } from './pages.tsx';
import { type Notice, type Peer, type StopKind, NOTICE_MIN_FOLLOW_MS, addStop, claimNotices, noticeDue, stopText } from './notices.ts';
import { FileStore, type Store } from './store.ts';
import { type Network, telegramStart } from './telegram.ts';
import type { Alert } from './types.ts';
import { ConfigError, type FetchFn, type Log, defaultLog, errText } from './util.ts';

/** One address that follows one Chronobox, or asked to. `token` is in the link of that address. `at` in ms. */
export type EmailEntry = { email: string; box: string; token: string; at: number };
type EmailState = {
  /** Confirmed: these get the alerts. */
  entries: EmailEntry[];
  /** Asked, not confirmed yet. Deleted after EMAIL_PENDING_MS. */
  pending: EmailEntry[];
  notices: Record<string, Notice>;
};
type EmailFile = { version: 1; sealed: string };

const SEAL_LABEL = 'chronobox-email-list-v1';
const DELIVERY_LABEL = 'chronobox-email-delivery';
const VISITOR_LABEL = 'chronobox-email-visitor';

export { EMAIL_PATH, type Page };
/** One address cannot follow more Chronoboxes than this. */
export const EMAIL_MAX_PER_ADDRESS = 20;
/** A request that is not confirmed is deleted after this time. */
export const EMAIL_PENDING_MS = 24 * 3600_000;
// Somebody can type the address of another person. These limits keep that from becoming a flood.
/** No second confirmation for the same address and Chronobox within this time. */
const EMAIL_AGAIN_MS = 600_000;
const EMAIL_PENDING_PER_ADDRESS = 3;
export const EMAIL_PER_VISITOR_HOUR = 10;
export const EMAIL_PER_HOUR = 300;
/** A form of ours is short. */
const MAX_FORM = 4096;
const EMAIL_RE = /^[^\s@<>"'`,;:\\()[\]]+@[^\s@<>"'`,;:\\()[\]]+\.[^\s@<>"'`,;:\\()[\]]{2,}$/;
const BOX_RE = /^(\d{1,12})-(0x[0-9a-fA-F]{40})$/;

export class ResendError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`Resend: ${code} ${message}`);
    this.code = code;
  }
}

/**
 * A request to the pages, as the service and the CLI hand it over. `visitor` is who sent it, for the limit per
 * visitor: the CLI knows it from the socket (`servePages`). Without it, the last address in X-Forwarded-For counts,
 * which is right only behind a proxy that sets that header itself: Vercel does.
 */
export type PageRequest = { method: string; url: string; headers: Record<string, string | undefined>; body: string; visitor?: string };

export const PAGE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // The pages load nothing and send a form only to this service. A link in them carries a token, so no referrer.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex',
};

/** The Chronobox of "<chain id>-<address>", in words. */
const boxText = (box: string) => {
  const [id, vault] = box.split('-');
  return `the Chronobox ${shortAddr(vault)} on ${networkName(Number(id))}`;
};

/** The derived key, per secret. scrypt is slow on purpose, and a warm function needs it one time only. */
const sealKeys = new Map<string, Buffer>();
function sealKey(secret: string): Buffer {
  let key = sealKeys.get(secret);
  if (!key) {
    key = crypto.scryptSync(secret, SEAL_LABEL, 32);
    sealKeys.set(secret, key);
  }
  return key;
}

/** The last address in X-Forwarded-For: the one that the nearest proxy saw. What comes before it, the visitor wrote. */
function lastForwarded(headers: Record<string, string | undefined>): string | undefined {
  return (headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1);
}

/** "::ffff:127.0.0.1" is 127.0.0.1. */
const plainIp = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/** The proxies that the CLI trusts by default: one on the same machine. */
export const LOOPBACK = ['127.0.0.1', '::1'];

/**
 * The visitor of a request that came to the CLI: the address of the socket, unless that is a trusted proxy. Only
 * then does X-Forwarded-For count. Anybody else could write any address into it, and get a new limit each time.
 */
export function visitorFromSocket(remote: string | undefined, headers: Record<string, string | undefined>, trusted: string[]): string {
  const peer = plainIp(remote ?? '');
  if (!trusted.map(plainIp).includes(peer)) return peer;
  return lastForwarded(headers) ?? peer;
}

function visitorOf(req: PageRequest): string {
  return req.visitor ?? lastForwarded(req.headers) ?? '';
}

export type EmailOptions = {
  fetch?: FetchFn;
  log?: Log;
  /** Where the list is kept, under the key "email". Default: STATE_DIR. */
  store?: Store;
  /** The time in ms. Tests set it. */
  clock?: () => number;
};

export class Email implements Peer {
  /** The list as last read or written. A change reads the stored list again first (`edit`). */
  state: EmailState = { entries: [], pending: [], notices: {} };
  /** The other ways to get alerts. They are told too when an address stops. */
  peers: Peer[] = [];
  private secret: string;
  private key: Buffer;
  private deliveryKey: Buffer;
  private visitorKey: Buffer;
  private resendKey: string;
  private api: string;
  private from: string;
  private pages: string;
  private expected: number;
  private fetchFn: FetchFn;
  private log: Log;
  private store: Store;
  private clock: () => number;
  private loading: Promise<void> | null = null;
  private networks = new Map<number, Network>();

  constructor(cfg: Config, opts: EmailOptions = {}) {
    if (!cfg.resendKey || !cfg.emailFrom || !cfg.publicUrl) throw new ConfigError('RESEND_KEY, EMAIL_FROM and PUBLIC_URL are required for alerts by email.');
    if (!cfg.alertsKey || cfg.alertsKey.length < 32) throw new ConfigError('ALERTS_KEY must be a secret of 32 characters or more.');
    this.resendKey = cfg.resendKey;
    this.api = cfg.resendApi;
    this.from = cfg.emailFrom;
    this.pages = `${cfg.publicUrl}${EMAIL_PATH}`;
    this.secret = cfg.alertsKey;
    this.key = sealKey(cfg.alertsKey);
    this.deliveryKey = crypto.createHmac('sha256', cfg.alertsKey).update(DELIVERY_LABEL).digest();
    this.visitorKey = crypto.createHmac('sha256', cfg.alertsKey).update(VISITOR_LABEL).digest();
    this.expected = cfg.networks.length;
    this.fetchFn = opts.fetch ?? fetch;
    const out = opts.log ?? defaultLog;
    this.log = (m: string) => out(this.redact(m));
    this.store = opts.store ?? new FileStore(cfg.stateDir);
    this.clock = opts.clock ?? Date.now;
  }

  /** The list read. Throws a ConfigError if ALERTS_KEY does not open it. */
  static async open(cfg: Config, opts: EmailOptions = {}): Promise<Email> {
    const e = new Email(cfg, opts);
    await e.ready();
    return e;
  }

  /** Reads the list, the first time only. */
  ready(): Promise<void> {
    this.loading ??= this.load().then((s) => { this.state = s; });
    return this.loading;
  }

  redact(msg: string): string { return msg.split(this.resendKey).join('[resend key]').split(this.secret).join('[alerts key]'); }

  private seal(content: unknown): string {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(SEAL_LABEL));
    const body = Buffer.concat([cipher.update(JSON.stringify(content), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
  }

  /** Throws when the key is not the one that sealed the block, or when the block was changed. */
  private open(sealed: string): any {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(SEAL_LABEL));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  }

  private async load(): Promise<EmailState> {
    const text = await this.store.get('email');
    if (text === null) return { entries: [], pending: [], notices: {} };
    let f: any;
    try { f = JSON.parse(text); } catch { f = null; }
    if (f?.version !== 1 || typeof f.sealed !== 'string') {
      throw new ConfigError('The stored list of email addresses is not valid (unknown format). Fix or remove it; removing it ends every subscription by email.');
    }
    try {
      const s = this.open(f.sealed);
      if (!Array.isArray(s?.entries) || !Array.isArray(s?.pending)) throw new Error('unknown format');
      return { entries: s.entries, pending: s.pending, notices: s.notices ?? {} };
    } catch {
      throw new ConfigError(
        'ALERTS_KEY does not open the stored list of email addresses. Use the key that the list was written with. ' +
        'Without that key the list is lost: remove it (email.json, or the key "email" in Redis), and every person must sign up again.',
      );
    }
  }

  private async save(state: EmailState): Promise<void> {
    const out: EmailFile = { version: 1, sealed: this.seal(state) };
    await this.store.set('email', JSON.stringify(out) + '\n');
  }

  /** Changes the list, under a lock and from the newest stored list. `fn` returns false to change nothing. */
  private async edit(fn: (s: EmailState) => boolean | void): Promise<boolean> {
    return this.store.lock('email', async () => {
      const s = await this.load();
      this.state = s;
      if (fn(s) === false) return false;
      await this.save(s);
      return true;
    }, { waitMs: 20_000 });
  }

  /** The newest stored list, for a page that only reads. */
  private async fresh(): Promise<EmailState> {
    this.state = await this.load();
    this.loading = Promise.resolve();
    return this.state;
  }

  /** The watcher of a network says that it is there. Before that, nobody can sign up for a vault on that network. */
  addNetwork(n: Network): void { this.networks.set(n.chainId, n); }

  /** The addresses that follow a vault. Call `ready` first. */
  subscribers(chainId: number, vault: string): EmailEntry[] {
    const box = telegramStart(chainId, vault);
    return this.state.entries.filter((e) => e.box === box);
  }

  /** Requests that nobody confirmed in time are deleted. True if one was. */
  private purge(s: EmailState): boolean {
    const now = this.clock();
    const kept = s.pending.filter((e) => now - e.at < EMAIL_PENDING_MS);
    const changed = kept.length !== s.pending.length;
    s.pending = kept;
    return changed;
  }

  /** One email through Resend. `idem` makes a second try of the same email harmless: Resend sends it one time. */
  private async send(to: string, subject: string, text: string, html: string, extra: { stop?: string; idem?: string } = {}): Promise<void> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json', 'user-agent': 'chronobox-watcher',
    };
    if (extra.idem) headers['idempotency-key'] = extra.idem.slice(0, 256);
    const body: Record<string, unknown> = { from: this.from, to: [to], subject, text, html };
    // Mail programs show their own "unsubscribe" with these two headers. It is one POST to the same link.
    if (extra.stop) body.headers = { 'List-Unsubscribe': `<${extra.stop}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    let res: Response;
    try {
      res = await this.fetchFn(`${this.api}/emails`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new Error(this.redact(`Resend: ${errText(e)}`));
    }
    if (!res.ok) {
      let j: any = null;
      try { j = await res.json(); } catch { /* not JSON */ }
      throw new ResendError(res.status, this.redact(String(j?.message ?? j?.name ?? `HTTP ${res.status}`)));
    }
    await res.arrayBuffer().catch(() => undefined);
  }

  private stopLink(e: EmailEntry): string { return `${this.pages}?stop=${e.token}`; }

  /** Which Chronobox, in the foot of every email that goes to an address on the list. */
  private boxLine(e: EmailEntry): string {
    const [id, vault] = e.box.split('-');
    return `Chronobox ${shortAddr(vault)} on ${networkName(Number(id))}`;
  }

  /** The same lines under every email that goes to an address on the list. */
  private foot(e: EmailEntry): string {
    return `\n\n${this.boxLine(e)}\n\nTo stop these alerts, open this link:\n${this.stopLink(e)}`;
  }

  /** An email to an address on the list: the text, and the same as HTML, both with the stop link. */
  private async sendTo(e: EmailEntry, subject: string, title: string, message: string, idem?: string): Promise<void> {
    const html = await alertHtml({ title, message, box: this.boxLine(e), stop: this.stopLink(e) });
    await this.send(e.email, subject, `${message}${this.foot(e)}`, html, { stop: this.stopLink(e), idem });
  }

  /**
   * The mark in `a.done` that says that this address got this alert. The state of the vault is not encrypted, so
   * the mark is a keyed hash: without ALERTS_KEY nobody can tell which address it is, and the marks of two alerts
   * do not show that the same address got both. It is also the key that makes Resend send an alert one time.
   */
  private deliveryTag(a: Alert, chainId: number, vault: string, email: string): string {
    return 'em:' + crypto.createHmac('sha256', this.deliveryKey).update(`${chainId}|${vault}|${a.id}|${email}`).digest('base64url').slice(0, 22);
  }

  /**
   * Sends an alert to every address that follows the vault. An address that got it is marked in `a.done`, so a
   * second try does not send it twice. Throws if an email could not be sent and should be tried again.
   */
  async deliver(chainId: number, vault: string, a: Alert): Promise<void> {
    // No "Watching", and no "All quiet": an inbox is not the place for a message every day.
    if (a.event === 'watching' || a.priority <= 2) return;
    await this.ready();
    const mark = a.priority >= 5 ? '\u{1F6A8} ' : a.priority >= 4 ? '⚠️ ' : '';
    let failed: string | null = null;
    for (const e of this.subscribers(chainId, vault)) {
      const done = this.deliveryTag(a, chainId, vault, e.email);
      if (a.done.includes(done)) continue;
      try {
        await this.sendTo(e, `${mark}${a.title}`, a.title, a.message, done);
        a.done.push(done);
      } catch (err) {
        if (err instanceof ResendError && (err.code === 400 || err.code === 422)) {
          // Resend does not take this email, and will not take it later.
          this.log(`email: "${a.title}" was refused: ${err.message}`);
          a.done.push(done);
        } else {
          failed = errText(err);
          // Too many requests, or the key is not accepted: stop here, the next poll goes on.
          if (err instanceof ResendError) break;
        }
      }
    }
    if (failed) throw new Error(failed);
  }

  /** Somebody stopped in another way (Telegram). The addresses that follow these Chronoboxes are told. */
  async noteStops(keys: string[], kind: StopKind): Promise<void> {
    await this.ready();
    const followed = (s: EmailState, key: string) => s.entries.some((e) => e.box === key);
    if (!keys.some((key) => followed(this.state, key))) return;
    const now = this.clock();
    await this.edit((s) => {
      const mine = keys.filter((key) => followed(s, key));
      if (!mine.length) return false;
      for (const key of mine) addStop(s.notices, key, kind, now);
    });
  }

  /** Tells the followers of each Chronobox that others stopped, once an hour at most (see notices.ts). The poll calls this. */
  async sendNotices(): Promise<void> {
    await this.ready();
    const now = this.clock();
    if (!Object.values(this.state.notices).some((n) => noticeDue(n, now))) return;
    let claimed: [string, Notice][] = [];
    await this.edit((s) => { claimed = claimNotices(s.notices, now); });
    for (const [key, n] of claimed) {
      const text = stopText(key, n, '');
      for (const e of this.state.entries.filter((x) => x.box === key)) {
        await this.sendTo(e, 'Somebody stopped the alerts of your Chronobox', 'Somebody stopped the alerts', text)
          .catch((err) => this.log(`email: could not tell an address that another one stopped: ${errText(err)}`));
      }
    }
  }

  // --- The pages

  private formPage(c: string, problem?: string, status = 200): Page {
    const m = BOX_RE.exec(c);
    if (!m) return pages.incomplete();
    const box = `${Number(m[1])}-${m[2].toLowerCase()}`;
    return pages.form({ c: box, box: boxText(box), problem }, status);
  }

  /** The first step: an address asks for the alerts of a vault. It gets one email with a link. */
  private async signUp(c: string, address: string, visitor: string): Promise<Page> {
    const m = BOX_RE.exec(c);
    if (!m) return this.formPage(c);
    const chainId = Number(m[1]);
    const vault = m[2].toLowerCase();
    const box = `${chainId}-${vault}`;
    const email = address.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return this.formPage(box, 'This does not look like an email address.', 400);

    // Per visitor first, so that one visitor over the limit does not use up the limit of everybody. The visitor is
    // a keyed hash: no IP address is stored.
    const who = crypto.createHmac('sha256', this.visitorKey).update(visitor).digest('base64url').slice(0, 22);
    if ((await this.store.hit(`email-hits:${who}`, 3600)) > EMAIL_PER_VISITOR_HOUR || (await this.store.hit('email-hits', 3600)) > EMAIL_PER_HOUR) {
      return pages.tooMany();
    }

    const net = this.networks.get(chainId);
    if (!net) {
      // A watcher that could not read its chain yet has not said which network it is.
      return this.networks.size < this.expected ? pages.later() : pages.notWatched(networkName(chainId));
    }
    let found: boolean;
    try {
      found = await net.adopt(vault);
    } catch (e) {
      this.log(`email: could not check ${vault} on chain ${chainId}: ${errText(e)}`);
      return pages.later();
    }
    if (!found) return pages.notChronobox(vault, networkName(chainId));

    // The same answer in every case from here on. It does not say whether an address is on the list.
    const sent = pages.sent(email);
    const now = this.clock();
    const made: EmailEntry[] = [];
    await this.edit((s) => {
      const purged = this.purge(s);
      const mine = s.entries.filter((e) => e.email === email);
      const waiting = s.pending.filter((e) => e.email === email);
      if (mine.some((e) => e.box === box) || mine.length >= EMAIL_MAX_PER_ADDRESS) return purged;
      if (waiting.some((e) => e.box === box && now - e.at < EMAIL_AGAIN_MS) || waiting.length >= EMAIL_PENDING_PER_ADDRESS) return purged;
      const entry: EmailEntry = { email, box, token: crypto.randomBytes(24).toString('base64url'), at: now };
      s.pending = s.pending.filter((e) => !(e.email === email && e.box === box));
      s.pending.push(entry);
      made.push(entry);
    });
    const entry = made[0];
    if (!entry) return sent;
    try {
      const link = `${this.pages}?confirm=${entry.token}`;
      // The same token cancels: only who reads this mailbox has it. So a stranger who asks for alerts to somebody
      // else's address cannot hold its requests (EMAIL_PENDING_PER_ADDRESS) for a day.
      const cancel = `${this.pages}?cancel=${entry.token}`;
      await this.send(email, 'Confirm the alerts for your Chronobox',
        `Somebody asked for alerts for the Chronobox ${vault} on ${networkName(chainId)} to this address.\n\n` +
        `Was it you? Then open this link and confirm:\n${link}\n\n` +
        'If it was not you, do nothing: we delete this request after one day.\n\n' +
        `Not you? Cancel this request, and every other one to this address, now:\n${cancel}`,
        await confirmHtml({ vault, network: networkName(chainId), link, cancel }),
        { idem: `confirm-${entry.token}` });
    } catch (e) {
      await this.edit((s) => {
        const before = s.pending.length;
        s.pending = s.pending.filter((p) => p.token !== entry.token);
        return s.pending.length !== before;
      });
      this.log(`email: could not send a confirmation: ${errText(e)}`);
      return pages.notSent();
    }
    this.log(`email: a confirmation went out for ${vault} on chain ${chainId}`);
    return sent;
  }

  private findPending(s: EmailState, token: string): EmailEntry | undefined {
    const now = this.clock();
    return token ? s.pending.find((e) => e.token === token && now - e.at < EMAIL_PENDING_MS) : undefined;
  }

  /** The link in the email opens this page. A program that reads the email for the person does not press the button. */
  private async confirmPage(token: string): Promise<Page> {
    const p = this.findPending(await this.fresh(), token);
    if (!p) return pages.gone();
    return pages.confirmAsk({ box: boxText(p.box), email: p.email, token });
  }

  /** The second step: the person confirmed. From now on the alerts go to the address. */
  private async confirm(token: string): Promise<Page> {
    let p: EmailEntry | undefined;
    await this.edit((s) => {
      const purged = this.purge(s);
      p = this.findPending(s, token);
      if (!p) return purged;
      const done = p;
      s.pending = s.pending.filter((e) => e !== done);
      const mine = s.entries.filter((e) => e.email === done.email);
      if (!mine.some((e) => e.box === done.box) && mine.length < EMAIL_MAX_PER_ADDRESS) {
        // A new token: the one in the confirmation email stops nothing.
        s.entries.push({ email: done.email, box: done.box, token: crypto.randomBytes(24).toString('base64url'), at: this.clock() });
      }
    });
    if (!p) return pages.gone();
    const [id, vault] = p.box.split('-');
    this.log(`email: an address follows ${vault} on chain ${id}`);
    const waits = (await this.networks.get(Number(id))?.pending(vault)) ?? null;
    return pages.confirmed({ box: boxText(p.box), waits });
  }

  /** The cancel link in a confirmation email. A page with a button, as for confirm. */
  private async cancelPage(token: string): Promise<Page> {
    const s = await this.fresh();
    const p = this.findPending(s, token);
    if (!p) return pages.gone();
    return pages.cancelAsk({ email: p.email, count: s.pending.filter((e) => e.email === p.email && this.findPending(s, e.token)).length, token });
  }

  /** Deletes every request to the address of this token that is not confirmed. Its slots are free again at once. */
  private async cancel(token: string): Promise<Page> {
    let found = false;
    await this.edit((s) => {
      const purged = this.purge(s);
      const p = this.findPending(s, token);
      if (!p) return purged;
      found = true;
      s.pending = s.pending.filter((e) => e.email !== p.email);
    });
    if (!found) return pages.gone();
    this.log('email: an address cancelled its requests');
    return pages.cancelled();
  }

  private async stopPage(token: string): Promise<Page> {
    const e = token ? (await this.fresh()).entries.find((x) => x.token === token) : undefined;
    if (!e) return pages.gone();
    return pages.stopAsk({ box: boxText(e.box), email: e.email, token });
  }

  private async stop(token: string): Promise<Page> {
    let e: EmailEntry | undefined;
    let counted = false;
    await this.edit((s) => {
      e = token ? s.entries.find((x) => x.token === token) : undefined;
      if (!e) return false;
      const gone = e;
      s.entries = s.entries.filter((x) => x !== gone);
      // A follow of less than a day tells nobody: else anybody could fill the inboxes and phones of all followers.
      counted = this.clock() - gone.at >= NOTICE_MIN_FOLLOW_MS;
      if (counted && s.entries.some((x) => x.box === gone.box)) addStop(s.notices, gone.box, 'email', this.clock());
    });
    if (!e) return pages.gone();
    this.log('email: an address stopped');
    // Alerts must not go off in silence: a person who is forced to stop them has others who still listen.
    if (counted) {
      for (const p of this.peers) await p.noteStops([e.box], 'email').catch((err) => this.log(`email: could not note a stop for Telegram: ${errText(err)}`));
    }
    await this.sendNotices().catch((err) => this.log(`email: could not send the notices of stops: ${errText(err)}`));
    for (const p of this.peers) await p.sendNotices().catch((err) => this.log(`email: could not send the notices of stops in Telegram: ${errText(err)}`));
    return pages.stopped(boxText(e.box));
  }

  /**
   * Every step of the pages: the method, and which of the fields `stop`, `confirm`, `cancel` (in the query or the form) the
   * request has. Without either, it is the sign-up. A GET only shows; only a POST (a button) changes something.
   * The one-click stop of a mail program posts "List-Unsubscribe=One-Click" to the stop link, so it is "POST stop".
   */
  private routes: Record<`${'GET' | 'POST'} ${'signup' | 'confirm' | 'cancel' | 'stop'}`, (r: Route) => Page | Promise<Page>> = {
    'GET signup': (r) => this.formPage(r.field('c')),
    'POST signup': (r) => this.signUp(r.field('c'), r.form.get('email') ?? '', r.visitor),
    'GET confirm': (r) => this.confirmPage(r.field('confirm')),
    'POST confirm': (r) => this.confirm(r.field('confirm')),
    'GET cancel': (r) => this.cancelPage(r.field('cancel')),
    'POST cancel': (r) => this.cancel(r.field('cancel')),
    'GET stop': (r) => this.stopPage(r.field('stop')),
    'POST stop': (r) => this.stop(r.field('stop')),
  };

  /** One request to the pages. Never throws: a problem is a page, and the log says what it was. */
  async handle(req: PageRequest): Promise<Page> {
    try {
      const url = new URL(req.url || '/', 'http://local');
      if (url.pathname.replace(/\/+$/, '') !== EMAIL_PATH) return pages.nothingHere();
      if (req.body.length > MAX_FORM) return pages.tooLong();
      const form = req.method === 'POST' ? new URLSearchParams(req.body) : new URLSearchParams();
      const field = (k: string) => form.get(k) ?? url.searchParams.get(k) ?? '';
      const step = field('stop') ? 'stop' : field('confirm') ? 'confirm' : field('cancel') ? 'cancel' : 'signup';
      const route = this.routes[`${req.method} ${step}` as keyof Email['routes']];
      if (!route) return pages.nothingHere(405);
      return await route({ field, form, visitor: visitorOf(req) });
    } catch (e) {
      this.log(`email: a request failed: ${e instanceof ConfigError ? 'configuration error: ' : ''}${errText(e)}`);
      return pages.broken();
    }
  }
}

/** What a step of the pages gets from its request. */
type Route = { field: (name: string) => string; form: URLSearchParams; visitor: string };

export type ServeOptions = {
  /** 0: any free one. */
  port: number;
  /** Where to listen. The proxy with TLS in front of it is on the same machine, so the default is loopback only. */
  host?: string;
  /** The peers whose X-Forwarded-For counts (see visitorFromSocket). Default: loopback. */
  trustedProxies?: string[];
};

/**
 * The CLI: serves the pages at EMAIL_PATH, and "ok" at /health. Put a proxy with TLS in front of it. Resolves with
 * the address and the port that it listens on, and a function that closes the server.
 */
export function servePages(email: Email, opts: ServeOptions): Promise<{ host: string; port: number; close: () => void }> {
  const trusted = opts.trustedProxies ?? LOOPBACK;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
      return;
    }
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      // What is too long is not kept, but read to its end, so that the visitor gets an answer. Far too long: no answer.
      if (body.length <= MAX_FORM) body += chunk.slice(0, MAX_FORM + 1 - body.length);
      if (size > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      const visitor = visitorFromSocket(req.socket.remoteAddress, headers, trusted);
      const out = await email.handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body, visitor });
      res.writeHead(out.status, PAGE_HEADERS).end(out.html);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve({
      host: (server.address() as { address: string }).address,
      port: (server.address() as { port: number }).port,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}
