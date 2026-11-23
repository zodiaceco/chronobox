// When somebody stops the alerts of a Chronobox, the others who follow it are told: in Telegram and by email.
//
// A person who is forced to stop the alerts on their phone has others who still listen. Anybody can follow a
// public Chronobox, though, so a stranger could follow and stop again and again to ring everybody's phone. So
// only a follow of a day or more tells the others, and they are told once an hour at most; the stops in between
// come together in the next message. A stop is never dropped, so a stranger cannot hide a real one for more than
// an hour.
//
// Each way to get the alerts (Telegram, email) keeps its own notices, in its own sealed list, and sends them to
// its own followers. A stop in one way is noted in the other ways too (`Peer`).
import { fmtWhen, networkName, shortAddr } from './format.ts';

export const NOTICE_MIN_FOLLOW_MS = 24 * 3600_000;
export const NOTICE_GAP_MS = 3600_000;

/**
 * The stops of one Chronobox that its followers were not told of yet, and when they were told last (ms).
 * `stopped` counts chats, `emails` counts email addresses.
 */
export type Notice = { stopped: number; emails?: number; firstAt: number; lastSent?: number };
export type StopKind = 'chat' | 'email';

/** Another way to get the alerts. It is told when somebody stops in this one. */
export interface Peer {
  /** Notes stops of these Chronoboxes ("<chain id>-<address>") for the followers in this way. */
  noteStops(keys: string[], kind: StopKind): Promise<void>;
  /** Sends the notices that are due. */
  sendNotices(): Promise<void>;
}

const total = (n: Notice) => n.stopped + (n.emails ?? 0);

/** One more stop of the Chronobox `key`. */
export function addStop(notices: Record<string, Notice>, key: string, kind: StopKind, now: number): void {
  const n = (notices[key] ??= { stopped: 0, firstAt: now });
  if (total(n) === 0) n.firstAt = now;
  if (kind === 'chat') n.stopped++;
  else n.emails = (n.emails ?? 0) + 1;
}

/** True if a notice can go out now. */
export function noticeDue(n: Notice, now: number): boolean {
  return total(n) > 0 && (n.lastSent === undefined || now - n.lastSent >= NOTICE_GAP_MS);
}

/** Takes the notices that are due and marks them as sent, and drops the ones that are done. Call it under the lock of the list. */
export function claimNotices(notices: Record<string, Notice>, now: number): [string, Notice][] {
  const claimed: [string, Notice][] = [];
  for (const [key, n] of Object.entries(notices)) {
    if (noticeDue(n, now)) {
      claimed.push([key, { ...n }]);
      notices[key] = { stopped: 0, firstAt: now, lastSent: now };
    } else if (total(n) === 0 && (n.lastSent === undefined || now - n.lastSent >= NOTICE_GAP_MS)) {
      delete notices[key];
    }
  }
  return claimed;
}

/** What the others are told. `here` is " here" in Telegram. */
export function stopText(key: string, n: Notice, here: string): string {
  const [id, vault] = key.split('-');
  const of = `the alerts of the Chronobox ${shortAddr(vault)} on ${networkName(Number(id))}`;
  const chats = n.stopped;
  const emails = n.emails ?? 0;
  const still = `You still get them${here}.`;
  if (chats + emails === 1) return `${chats ? 'A chat' : 'An email address'} that got ${of} has stopped them. ${still}`;
  const who = [
    chats ? `${chats} chat${chats === 1 ? '' : 's'}` : '',
    emails ? `${emails} email address${emails === 1 ? '' : 'es'}` : '',
  ].filter(Boolean).join(' and ');
  return `${who} that got ${of} have stopped them since ${fmtWhen(Math.floor(n.firstAt / 1000))}. ${still}`;
}
