// The Telegram bot of --all.
//
// A second way to get the alerts of --all, for people who do not want another app. A person opens
// https://t.me/<bot>?start=<chain id>-<vault address> and presses Start. From then on the bot sends the
// alerts of that vault to that chat. The bot keeps, per chat, the number of the chat and the vaults it follows, with
// since when. That is all this watcher stores about a person. It keeps no name, no username and no message, and it
// does not write the number of a chat to the log.
//
// The stored list of chats is encrypted with ALERTS_KEY (AES-256-GCM; TELEGRAM_KEY is its older name). The key is a setting and is not
// stored with the list, so the file or the Redis database, a copy of it or a backup show nobody who
// follows what. This does not protect against a person who controls the running watcher: it holds the
// list and the key.
//
// The bot gets its messages in one of two ways. The CLI asks Telegram for them (long polling, `run`).
// The service on Vercel gets each one as a request to its webhook (`handleUpdate`). A bot can do only
// one of the two at a time.

import * as crypto from 'node:crypto';
import { ADDRESS_RE, type Config } from './config.ts';
import { APP_URL, boxLink, networkName, shortAddr } from './format.ts';
import { type Notice, type Peer, type StopKind, NOTICE_MIN_FOLLOW_MS, addStop, claimNotices, noticeDue, stopText } from './notices.ts';
import { FileStore, type Store } from './store.ts';
import type { Alert } from './types.ts';
import { ConfigError, type FetchFn, type Log, defaultLog, errText } from './util.ts';

/** The text after "start=" in the link to the bot. The same rule is in the app (src/lib/alerts.ts). */
export function telegramStart(chainId: number, vault: string): string {
  return `${chainId}-${vault.toLowerCase()}`;
}

export class TelegramError extends Error {
  code: number;
  retryAfter?: number;
  migrateTo?: number;
  constructor(method: string, code: number, description: string, parameters?: { retry_after?: number; migrate_to_chat_id?: number }) {
    super(`Telegram ${method}: ${code} ${description}`);
    this.code = code;
    this.retryAfter = parameters?.retry_after;
    this.migrateTo = parameters?.migrate_to_chat_id;
  }
}

/** What the bot needs from the watcher of one network. */
export type Network = {
  chainId: number;
  /** Starts to watch the vault if it is a Chronobox. False if it is not one. Throws if the chain cannot be read. */
  adopt(vault: string): Promise<boolean>;
  /** What waits in the vault now, one line per item. Null if the watcher could not read it yet: not known, not empty. */
  pending(vault: string): Promise<string[] | null>;
};

type TelegramState = {
  offset?: number;
  /** For each chat, the Chronoboxes it follows ("<chain id>-<address>"). */
  chats: Record<string, string[]>;
  /** When a chat began to follow a Chronobox (ms), by "<chat> <chain id>-<address>". Missing: before this was kept. */
  since: Record<string, number>;
  /** Stops that the other followers of a Chronobox are still to be told of, and when they were told last (ms). */
  notices: Record<string, Notice>;
};
/** What is stored: the list of chats as one sealed block (base64 of nonce, tag and ciphertext). The offset is no secret. */
type TelegramFile = { version: 3; offset?: number; sealed: string };
const SEAL_LABEL = 'chronobox-telegram-chats-v2';

/** One chat cannot follow more Chronoboxes than this. */
export const TELEGRAM_MAX_PER_CHAT = 20;
/** Starts with an address that one chat may send in an hour. Each one can make the watcher read the chain. */
export const TELEGRAM_STARTS_PER_HOUR = 30;

const TG_HOW = 'To get alerts, open the Chronobox, tap "Get told" and then "Telegram". That brings you back here with the right address.';
const TG_HELP = `${TG_HOW}\n\n/list shows what this chat follows.\n/stop ends the alerts.\n/privacy says what I keep.`;
/** The one link that the bot sends is the page of the Chronobox in the app. The bot says so, so that any other link stands out. */
const tgNever = (app: string) =>
  `The only link that I send leads to the Chronobox at ${new URL(app).host}. I never ask for a key, a password or money. A message that does is not from me.`;
const TG_KEEP = 'I keep the number of this chat, the address of the Chronobox, and since when this chat follows it. I keep nothing else. /stop deletes it.';
const TG_PRIVACY =
  'I keep the number of this chat, the addresses of the Chronoboxes that it follows, and since when it follows each one. ' +
  'I do not keep your name, your username or your messages.\n\n' +
  'The list is stored encrypted. /stop deletes everything about this chat.\n\n' +
  'Telegram can read the messages that I send you. What they say is public on the blockchain. That this chat follows a Chronobox is not.';
const TG_LATER = 'I cannot read the network right now. Try again in a few minutes.';

/**
 * An alert as a Telegram message: plain text, no mark for how grave it is (the words say it), and at the end the one
 * link: the page of the Chronobox in the app. A long alert is cut before the link, never in it.
 */
export function telegramText(a: Alert, chainId: number, vault: string, app: string = APP_URL): string {
  const link = boxLink(app, chainId, vault);
  const foot = `\n\nChronobox ${shortAddr(vault)} on ${networkName(chainId)}${link ? `\n${link}` : ''}`;
  const text = `${a.title}\n\n${a.message}`;
  const room = 4000 - foot.length;
  return `${text.length > room ? `${text.slice(0, room - 1)}…` : text}${foot}`;
}

/** The derived key, per secret. scrypt is slow on purpose, and a warm function needs it one time only. */
const sealKeys = new Map<string, Buffer>();
function sealKey(secret: string): Buffer {
  let key = sealKeys.get(secret);
  if (!key) {
    // A slow step, so that a short secret is not guessed from a stolen copy of the list by trying.
    key = crypto.scryptSync(secret, SEAL_LABEL, 32);
    sealKeys.set(secret, key);
  }
  return key;
}

const WEBHOOK_LABEL = 'chronobox-telegram-webhook';
const DELIVERY_LABEL = 'chronobox-telegram-delivery';
/** For the names of the counters of Starts: a chat is never named in the store, only sealed (see `startsOf`). */
const STARTS_LABEL = 'chronobox-telegram-starts';

export type TelegramOptions = {
  fetch?: FetchFn;
  log?: Log;
  /** Where the list of chats is kept, under the key "telegram". Default: STATE_DIR. */
  store?: Store;
  /** The time in ms. Tests set it. */
  clock?: () => number;
};

export class Telegram implements Peer {
  /** The name of the bot, from Telegram. Empty until `start` worked. */
  username = '';
  /** The other ways to get alerts. They are told too when a chat stops (see notices.ts). */
  peers: Peer[] = [];
  /** The list of chats as last read or written. A change reads the stored list again first (`edit`). */
  state: TelegramState = { chats: {}, since: {}, notices: {} };
  private token: string;
  private secret: string;
  private key: Buffer;
  private deliveryKey: Buffer;
  private startsKey: Buffer;
  private api: string;
  private app: string;
  private expected: number;
  private fetchFn: FetchFn;
  private log: Log;
  private store: Store;
  private loading: Promise<void> | null = null;
  private clock: () => number;
  private networks = new Map<number, Network>();

  constructor(cfg: Config, opts: TelegramOptions = {}) {
    if (!cfg.telegramToken) throw new ConfigError('TELEGRAM_TOKEN is not set.');
    this.token = cfg.telegramToken;
    if (!cfg.alertsKey || cfg.alertsKey.length < 32) throw new ConfigError('ALERTS_KEY must be a secret of 32 characters or more.');
    this.secret = cfg.alertsKey;
    this.key = sealKey(cfg.alertsKey);
    this.deliveryKey = crypto.createHmac('sha256', cfg.alertsKey).update(DELIVERY_LABEL).digest();
    this.startsKey = crypto.createHmac('sha256', cfg.alertsKey).update(STARTS_LABEL).digest();
    this.api = cfg.telegramApi;
    this.app = cfg.appUrl;
    this.expected = cfg.networks.length;
    this.fetchFn = opts.fetch ?? fetch;
    const out = opts.log ?? defaultLog;
    this.log = (m: string) => out(this.redact(m));
    this.store = opts.store ?? new FileStore(cfg.stateDir);
    this.clock = opts.clock ?? Date.now;
  }

  /** A bot with its list of chats read. Throws a ConfigError if ALERTS_KEY does not open the list. */
  static async open(cfg: Config, opts: TelegramOptions = {}): Promise<Telegram> {
    const t = new Telegram(cfg, opts);
    await t.ready();
    return t;
  }

  /** Reads the list of chats, the first time only. */
  ready(): Promise<void> {
    this.loading ??= this.load().then((s) => { this.state = s; });
    return this.loading;
  }

  redact(msg: string): string { return msg.split(this.token).join('[telegram token]').split(this.secret).join('[alerts key]'); }

  /** The secret that Telegram sends with each update to the webhook. It comes from ALERTS_KEY, so it needs no setting of its own. */
  webhookSecret(): string {
    return crypto.createHmac('sha256', this.secret).update(WEBHOOK_LABEL).digest('base64url');
  }

  /** True if a request to the webhook carries the secret of this bot. */
  isFromTelegram(header: string | null | undefined): boolean {
    const want = Buffer.from(this.webhookSecret());
    const got = Buffer.from(header ?? '');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

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
    const chats = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (typeof chats !== 'object' || chats === null) throw new Error('unknown format');
    return chats;
  }

  private async load(): Promise<TelegramState> {
    const text = await this.store.get('telegram');
    let f: any;
    if (text === null) return { chats: {}, since: {}, notices: {} };
    try { f = JSON.parse(text); } catch (e) {
      throw new ConfigError(`The stored list of Telegram chats is not valid (${errText(e)}). Fix or remove it; removing it ends every subscription.`);
    }
    if (f?.version === 1 && typeof f.chats === 'object' && f.chats !== null) {
      // A list from before the encryption. It is written again, sealed, right now.
      const state: TelegramState = { offset: f.offset, chats: f.chats, since: {}, notices: {} };
      await this.save(state);
      this.log('telegram: the list of chats was in plain form and is encrypted now');
      return state;
    }
    if ((f?.version !== 2 && f?.version !== 3) || typeof f.sealed !== 'string') {
      throw new ConfigError('The stored list of Telegram chats is not valid (unknown format). Fix or remove it; removing it ends every subscription.');
    }
    try {
      const content = this.open(f.sealed);
      // Version 2 sealed the chats alone. Their follows are older than this, so they count as a day or more.
      if (f.version === 2) return { offset: f.offset, chats: content, since: {}, notices: {} };
      if (typeof content.chats !== 'object' || content.chats === null) throw new Error('unknown format');
      return { offset: f.offset, chats: content.chats, since: content.since ?? {}, notices: content.notices ?? {} };
    } catch {
      throw new ConfigError(
        'ALERTS_KEY does not open the stored list of Telegram chats. Use the key that the list was written with. ' +
        'Without that key the list is lost: remove it (telegram.json, or the key "telegram" in Redis), and every person must press Start again.',
      );
    }
  }

  private async save(state: TelegramState): Promise<void> {
    const out: TelegramFile = { version: 3, offset: state.offset, sealed: this.seal({ chats: state.chats, since: state.since, notices: state.notices }) };
    await this.store.set('telegram', JSON.stringify(out) + '\n');
  }

  /**
   * Changes the list of chats. Under a lock, and from the newest stored list, because the webhook and a poll
   * can change it at the same time. `fn` returns false to change nothing.
   */
  async edit(fn: (s: TelegramState) => boolean | void): Promise<boolean> {
    return this.store.lock('telegram', async () => {
      const s = await this.load();
      this.state = s;
      if (fn(s) === false) return false;
      await this.save(s);
      return true;
    }, { waitMs: 20_000 });
  }

  /** The watcher of a network says that it is there. Before that, the bot cannot check a vault on that network. */
  addNetwork(n: Network): void { this.networks.set(n.chainId, n); }

  /** The chats that follow a vault. Call `ready` first. */
  subscribers(chainId: number, vault: string): string[] {
    const key = telegramStart(chainId, vault);
    return Object.keys(this.state.chats).filter((chat) => this.state.chats[chat].includes(key));
  }

  private async call(method: string, body: unknown, timeoutMs = 20000): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.api}/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(this.redact(`Telegram ${method}: ${errText(e)}`));
    }
    let j: any = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !j?.ok) throw new TelegramError(method, Number(j?.error_code ?? res.status), String(j?.description ?? `HTTP ${res.status}`), j?.parameters);
    return j.result;
  }

  private say(chat: string | number, text: string, silent = false): Promise<unknown> {
    return this.call('sendMessage', { chat_id: Number(chat), text, disable_notification: silent, link_preview_options: { is_disabled: true } });
  }

  /** Checks the token, learns the name of the bot and sets its list of commands. A token that Telegram does not accept is a configuration error. */
  async start(): Promise<void> {
    try {
      const me = await this.call('getMe', {});
      this.username = String(me?.username ?? '');
    } catch (e) {
      if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) throw new ConfigError('Telegram does not accept TELEGRAM_TOKEN.');
      throw e;
    }
    await this.call('setMyCommands', {
      commands: [
        { command: 'list', description: 'What this chat follows' },
        { command: 'stop', description: 'End the alerts and delete this chat' },
        { command: 'privacy', description: 'What I keep' },
      ],
    }).catch((e) => this.log(`telegram: could not set the command list: ${errText(e)}`));
  }

  /** Tells Telegram to send every new message to `url`, with the secret of this bot. Long polling stops working then. */
  async setWebhook(url: string): Promise<void> {
    await this.call('setWebhook', { url, secret_token: this.webhookSecret(), allowed_updates: ['message'] });
  }

  /**
   * Tells the followers of each Chronobox that other chats stopped, once an hour at most per Chronobox (see
   * NOTICE_GAP_MS). A notice is claimed under the lock before it is sent, so two places never send it twice. The
   * poll calls this, so that a notice that had to wait goes out.
   */
  async sendNotices(): Promise<void> {
    await this.ready();
    const now = this.clock();
    if (!Object.values(this.state.notices).some((n) => noticeDue(n, now))) return;
    let claimed: [string, Notice][] = [];
    await this.edit((s) => { claimed = claimNotices(s.notices, now); });
    for (const [key, n] of claimed) {
      const [id, vault] = key.split('-');
      const text = stopText(key, n, ' here');
      for (const other of this.subscribers(Number(id), vault)) {
        await this.say(other, text).catch((e) => this.log(`telegram: could not tell a chat that another one stopped: ${errText(e)}`));
      }
    }
  }

  /**
   * Sends an alert to every chat that follows the vault. A chat that got it is marked in `a.done`, so a
   * second try does not send it twice. Throws if a chat could not be reached and should be tried again.
   */
  async deliver(chainId: number, vault: string, a: Alert): Promise<void> {
    // "Watching" is for the person who runs the watcher. A chat gets the state of the vault when it subscribes.
    if (a.event === 'watching') return;
    await this.ready();
    const text = telegramText(a, chainId, vault, this.app);
    let failed: string | null = null;
    // Marks from before the tags held the number of the chat: they count, and become tags now.
    a.done = a.done.map((m) => (/^tg:-?\d+$/.test(m) ? this.deliveryTag(a, chainId, vault, m.slice(3)) : m));
    for (const chat of this.subscribers(chainId, vault)) {
      const mark = this.deliveryTag(a, chainId, vault, chat);
      if (a.done.includes(mark)) continue;
      try {
        await this.say(chat, text, a.priority <= 2);
        a.done.push(mark);
      } catch (e) {
        if (!(e instanceof TelegramError)) { failed = errText(e); continue; }
        if (e.migrateTo !== undefined) {
          // A group became a supergroup and has a new number. The next poll sends to it.
          const to = String(e.migrateTo);
          await this.edit((s) => {
            if (!s.chats[chat]) return false;
            s.chats[to] = [...new Set([...(s.chats[to] ?? []), ...s.chats[chat]])];
            for (const key of s.chats[chat]) {
              const since = s.since[`${chat} ${key}`];
              if (since !== undefined) s.since[`${to} ${key}`] ??= since;
              delete s.since[`${chat} ${key}`];
            }
            delete s.chats[chat];
          });
          failed = 'a group has a new number';
        } else if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
          // The person blocked the bot or deleted the chat. That is a /stop.
          await this.forget(chat);
        } else if (e.code === 400) {
          // Telegram does not take this message, and will not take it later.
          this.log(`telegram: "${a.title}" was refused: ${e.message}`);
          a.done.push(mark);
        } else {
          failed = e.message;
          // Too many messages: stop here, the next poll goes on.
          if (e.code === 429) break;
        }
      }
    }
    if (failed) throw new Error(failed);
  }

  /**
   * The mark in `a.done` that says that this chat got this alert. An alert that waits for another channel is stored
   * with the state of the vault, which is not encrypted, so the mark must not show the chat: it is a keyed hash of
   * the alert, the vault and the chat. Without TELEGRAM_KEY nobody can tell which chat it is, and the marks of two
   * alerts do not show that the same chat got both.
   */
  private deliveryTag(a: Alert, chainId: number, vault: string, chat: string): string {
    return 'tg:' + crypto.createHmac('sha256', this.deliveryKey).update(`${chainId}|${vault}|${a.id}|${chat}`).digest('base64url').slice(0, 22);
  }

  /** Somebody stopped in another way (email). The chats that follow these Chronoboxes are told, as with a chat that stops. */
  async noteStops(keys: string[], kind: StopKind): Promise<void> {
    await this.ready();
    const followed = (s: TelegramState, key: string) => Object.values(s.chats).some((list) => list.includes(key));
    if (!keys.some((key) => followed(this.state, key))) return;
    const now = this.clock();
    await this.edit((s) => {
      const mine = keys.filter((key) => followed(s, key));
      if (!mine.length) return false;
      for (const key of mine) addStop(s.notices, key, kind, now);
    });
  }

  private async forget(chat: string): Promise<void> {
    const removed = await this.edit((s) => {
      if (!(chat in s.chats)) return false;
      for (const key of s.chats[chat]) delete s.since[`${chat} ${key}`];
      delete s.chats[chat];
    });
    if (removed) this.log('telegram: a chat was removed');
  }

  /** The CLI: reads the new messages one time and answers them. `waitSeconds`: how long Telegram holds the request open. */
  async pump(waitSeconds = 0): Promise<number> {
    await this.ready();
    const updates: any[] = await this.call(
      'getUpdates', { offset: this.state.offset, timeout: waitSeconds, allowed_updates: ['message'] }, (waitSeconds + 15) * 1000,
    );
    let offset = this.state.offset;
    for (const u of updates) {
      try {
        await this.handleUpdate(u);
      } catch (e) {
        this.log(`telegram: could not answer a message: ${errText(e)}`);
      }
      // Every message is read one time, also when the answer failed. The person can send it again.
      if (typeof u?.update_id === 'number') offset = u.update_id + 1;
    }
    if (updates.length) await this.edit((s) => { s.offset = offset; });
    return updates.length;
  }

  /** The CLI: reads messages until `stopped` says so. A failed request waits longer each time, up to a minute. */
  async run(stopped: () => boolean = () => false): Promise<void> {
    let wait = 1;
    while (!stopped()) {
      try {
        await this.pump(50);
        wait = 1;
      } catch (e) {
        this.log(e instanceof TelegramError && e.code === 409
          ? 'telegram: another program reads the messages of this bot, or the bot has a webhook. Only one reader works.'
          : `telegram: cannot get messages: ${errText(e)}`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        wait = Math.min(wait * 2, 60);
      }
    }
  }

  /** Answers one update: a message that somebody sent to the bot. */
  async handleUpdate(update: any): Promise<void> {
    await this.ready();
    const m = update?.message;
    const chat = m?.chat?.id;
    if (typeof chat !== 'number' || typeof m?.text !== 'string') return;
    const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s+(\S+))?/i.exec(m.text.trim());
    if (!cmd) {
      // In a group, the bot answers commands only.
      if (m.chat.type === 'private') await this.say(chat, TG_HELP);
      return;
    }
    const name = cmd[1].toLowerCase();
    const arg = cmd[2] ?? '';
    if (name === 'start' && arg) return this.subscribe(chat, arg);
    if (name === 'stop') return this.unsubscribe(chat, arg);
    if (name === 'list') {
      const mine = this.state.chats[chat] ?? [];
      const lines = mine.map((key) => { const [id, vault] = key.split('-'); return `${vault} on ${networkName(Number(id))}`; });
      await this.say(chat, lines.length ? `This chat follows:\n${lines.join('\n')}\n\n/stop ends all of them. /stop and an address ends one.` : `This chat follows no Chronobox.\n\n${TG_HOW}`);
      return;
    }
    if (name === 'privacy') { await this.say(chat, TG_PRIVACY); return; }
    await this.say(chat, TG_HELP);
  }

  /**
   * The name of the counter of Starts of one chat. Which chats use the bot is kept sealed with ALERTS_KEY, so the name
   * of a key in the store must not say it either: it is a keyed hash of the chat, which nobody without the key can
   * match to a chat.
   */
  private startsOf(chat: number): string {
    return 'telegram-starts:' + crypto.createHmac('sha256', this.startsKey).update(String(chat)).digest('base64url').slice(0, 22);
  }

  private async subscribe(chat: number, arg: string): Promise<void> {
    const p = /^(\d{1,12})-(0x[0-9a-fA-F]{40})$/.exec(arg);
    if (!p) { await this.say(chat, TG_HELP); return; }
    const chainId = Number(p[1]);
    const vault = p[2].toLowerCase();
    const net = this.networks.get(chainId);
    if (!net) {
      // A watcher that could not read its chain yet has not said which network it is.
      await this.say(chat, this.networks.size < this.expected ? TG_LATER : `I do not watch ${networkName(chainId)}.`);
      return;
    }
    const key = telegramStart(chainId, vault);
    const full = (s: TelegramState) => { const mine = s.chats[chat] ?? []; return !mine.includes(key) && mine.length >= TELEGRAM_MAX_PER_CHAT; };
    const LIMIT = `This chat follows ${TELEGRAM_MAX_PER_CHAT} Chronoboxes already. That is the limit. /list shows them.`;
    if (full(this.state)) { await this.say(chat, LIMIT); return; }
    // A chat that follows this vault already needs no check: the answer comes from what the watcher read last.
    const follows = (this.state.chats[chat] ?? []).includes(key);
    if (!follows && (await this.store.hit(this.startsOf(chat), 3600)) > TELEGRAM_STARTS_PER_HOUR) {
      await this.say(chat, 'This chat asked for many Chronoboxes in the last hour. Try again later.');
      return;
    }
    let found: boolean;
    try {
      found = follows || (await net.adopt(vault));
    } catch (e) {
      this.log(`telegram: could not check ${vault} on chain ${chainId}: ${errText(e)}`);
      await this.say(chat, TG_LATER);
      return;
    }
    if (!found) {
      await this.say(chat, `${vault} is not a Chronobox on ${networkName(chainId)}.\n\n${TG_HOW}`);
      return;
    }
    let limit = false;
    const added = await this.edit((s) => {
      if ((s.chats[chat] ?? []).includes(key)) return false;
      if (full(s)) { limit = true; return false; }
      s.chats[chat] = [...(s.chats[chat] ?? []), key];
      s.since[`${chat} ${key}`] = this.clock();
    });
    if (limit) { await this.say(chat, LIMIT); return; }
    if (added) this.log(`telegram: a chat follows ${vault} on chain ${chainId}`);
    const waits = await net.pending(vault);
    const now = waits === null ? 'I could not read yet what waits there. Open the Chronobox to see it. Alerts for what comes next arrive here.'
      : waits.length === 0 ? 'Nothing waits there right now.'
      : `Right now ${waits.length === 1 ? 'one request waits' : `${waits.length} requests wait`} there:\n${waits.join('\n')}`;
    await this.say(chat, `You now get the alerts of the Chronobox ${shortAddr(vault)} on ${networkName(chainId)}.\n\n${now}\n\n${TG_KEEP}\n\n${tgNever(this.app)}`);
  }

  private async unsubscribe(chat: number, arg: string): Promise<void> {
    const one = ADDRESS_RE.test(arg) ? arg.toLowerCase() : null;
    let mine: string[] = [];
    let left: string[] = [];
    let counted: string[] = [];
    const changed = await this.edit((s) => {
      counted = [];
      mine = s.chats[chat] ?? [];
      left = one ? mine.filter((key) => !key.endsWith(`-${one}`)) : [];
      if (left.length === mine.length) return false;
      if (left.length) s.chats[chat] = left; else delete s.chats[chat];
      const now = this.clock();
      for (const key of mine.filter((k) => !left.includes(k))) {
        const since = s.since[`${chat} ${key}`];
        delete s.since[`${chat} ${key}`];
        // A follow of less than a day tells nobody: else anybody could ring the phones of all followers.
        if (since !== undefined && now - since < NOTICE_MIN_FOLLOW_MS) continue;
        addStop(s.notices, key, 'chat', now);
        counted.push(key);
      }
    });
    if (!changed) {
      await this.say(chat, mine.length ? `This chat does not follow ${one}. /list shows what it follows.` : 'This chat follows no Chronobox.');
      return;
    }
    this.log('telegram: a chat stopped');
    // Alerts must not go off in silence: a person who is forced to stop them has others who still listen.
    for (const p of this.peers) {
      if (counted.length) await p.noteStops(counted, 'chat').catch((e) => this.log(`telegram: could not note a stop for email: ${errText(e)}`));
    }
    await this.sendNotices();
    for (const p of this.peers) await p.sendNotices().catch((e) => this.log(`telegram: could not send the notices of stops by email: ${errText(e)}`));
    await this.say(chat, left.length
      ? `Done. No more alerts for ${one} here. /list shows what this chat still follows.`
      : 'Done. You get no more alerts here, and I deleted this chat from my list.');
  }
}
