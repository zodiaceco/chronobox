// When a request can be finished, when it is void, and why it left the queue.
import { batchCalls } from './describe.ts';
import { fmtWhen } from './format.ts';

export type Status = { status: 'waiting' | 'ready' | 'expired'; readyAt: bigint; expiresAt: bigint | null };

export function itemStatus(createdAt: bigint, cooldown: bigint, expiration: bigint, now: bigint): Status {
  const readyAt = createdAt + cooldown;
  const expiresAt = expiration === 0n ? null : readyAt + expiration;
  if (now < readyAt) return { status: 'waiting', readyAt, expiresAt };
  if (expiresAt !== null && now > expiresAt) return { status: 'expired', readyAt, expiresAt };
  return { status: 'ready', readyAt, expiresAt };
}

export function expiryLead(expiration: bigint): bigint {
  return expiration < 172800n ? expiration / 2n : 86400n;
}

export type CloseReason =
  | { how: 'cancelled'; block: number; ts: bigint }
  | { how: 'executed'; block: number }
  | { how: 'expired' }
  /** The alert service could not see what happened. It never says that no money moved then. */
  | { how: 'executed_or_cancelled' };

/** A log of the Safe of a vault, in the order of the chain (block, then log index). */
export type VaultEvent =
  /** SafeModuleTransaction (SafeL2): a module asks the Safe to do something. Its result follows. */
  | { kind: 'call'; block: number; index: number; module: string; to: string; value: bigint; data: string; operation: number }
  /** ExecutionFromModuleSuccess or ExecutionFromModuleFailure: how the last call of that module went. */
  | { kind: 'result'; block: number; index: number; module: string; success: boolean };

/** What the watcher knows about a request that left the queue. */
export type QueueTx = { createdAt: bigint; to?: string; value?: string; data?: string; operation?: number };

const SET_TX_NONCE = '0x46ba2307';
const SET_TX_COOLDOWN = '0xebb2b4a2';
const SET_TX_EXPIRATION = '0x9b56d5be';

/** The number that a one-argument call on the Delay sets, if this is that call. */
function argOf(call: { to: string; data: string }, delay: string, selector: string): bigint | null {
  const d = call.data.toLowerCase();
  if (call.to.toLowerCase() !== delay || !d.startsWith(selector) || d.length !== 2 + 8 + 64) return null;
  return BigInt('0x' + d.slice(10));
}

/** The timing of the Delay. Each request is judged by the timing in force when it was carried out or removed. */
export type Timing = { cooldown: bigint; expiration: bigint };

/**
 * Why each request that waited at the last poll left the queue. The Safe of a Chronobox (SafeL2) logs every call of
 * a module before it runs and its result after it, in the order of the chain. So the watcher replays them from the
 * txNonce and the timing of the last poll:
 *
 * - The Delay calls the Safe: a request was carried out. It is the first one from the head that is exactly that call
 *   and still valid then; every request before it ran out of time and was removed (skipExpired logs nothing).
 * - setTxNonce(n) on the Delay that worked (from the cancel contract, from the Delay as a request of its own, or in
 *   a batch): every request before n was cancelled, or removed if its time had run out already.
 * - setTxCooldown or setTxExpiration on the Delay that worked: the timing changes from there on.
 * - A call that failed changed nothing.
 *
 * Several of these can be in one block. What the replay cannot explain (a call that matches no request, a result
 * without its call, a delegate call it cannot read, a timing at the end that is not the one read now, a request
 * without a log) is "carried out or cancelled", never "no money moved".
 */
export function replayQueue(args: {
  /** txNonce at the last poll, and now. */
  from: number;
  to: number;
  events: VaultEvent[];
  delay: string;
  items: Map<number, QueueTx>;
  /** The timing at the last poll, and as read now. */
  before: Timing;
  after: Timing;
  /** The time of each block that has a result in `events`. */
  timeOf: (block: number) => bigint;
  now: bigint;
}): Map<number, CloseReason> {
  const { delay, items } = args;
  const reasons = new Map<number, CloseReason>();
  let timing = { ...args.before };
  const expiredAt = (n: number, ts: bigint) => {
    const it = items.get(n);
    return it !== undefined && itemStatus(it.createdAt, timing.cooldown, timing.expiration, ts).status === 'expired';
  };
  // Only a request whose contents the watcher knows can be proved by a call. One it could not read (a first start
  // with more than FIRST_START_LOOKUP_LIMIT waiting) proves nothing, and matches nothing.
  const same = (it: QueueTx | undefined, c: { to: string; value: bigint; data: string; operation: number }) =>
    it !== undefined && it.to !== undefined && it.data !== undefined &&
    it.to.toLowerCase() === c.to.toLowerCase() && BigInt(it.value ?? '0') === c.value &&
    it.data.toLowerCase() === c.data.toLowerCase() && (it.operation ?? 0) === c.operation;
  let cur = args.from;
  let sure = true;
  const open: Extract<VaultEvent, { kind: 'call' }>[] = [];
  /** What one call that worked does to the queue and the timing. False if the replay cannot know. */
  const apply = (c: { to: string; data: string }, block: number, ts: bigint): boolean => {
    const n = argOf(c, delay, SET_TX_NONCE);
    if (n !== null) {
      if (n < BigInt(cur) || n > BigInt(args.to)) return false;
      // A request whose time had run out was void anyway: removed by skipExpired before (no log), or by this cancel.
      // Either way "removed" is true, and the logs cannot tell which.
      for (; cur < Number(n); cur++) reasons.set(cur, expiredAt(cur, ts) ? { how: 'expired' } : { how: 'cancelled', block, ts });
    }
    const cooldown = argOf(c, delay, SET_TX_COOLDOWN);
    if (cooldown !== null) timing = { ...timing, cooldown };
    const expiration = argOf(c, delay, SET_TX_EXPIRATION);
    if (expiration !== null) timing = { ...timing, expiration };
    return true;
  };
  /** A call of the Safe that worked: its own effect, and the effect of each call in it, in order. */
  const effects = (c: { to: string; value: bigint; data: string; operation: number }, block: number, ts: bigint): boolean => {
    if (c.operation === 0) return apply(c, block, ts);
    // A delegate call runs other code as the Safe. Only a batch of plain calls can be read.
    const calls = batchCalls(c);
    if (!calls) return false;
    return calls.every((inner) => apply(inner, block, ts));
  };
  for (const e of args.events) {
    if (e.kind === 'call') { open.push(e); continue; }
    // The result belongs to the last open call of the same module (a call can contain another one).
    const at = open.map((c) => c.module).lastIndexOf(e.module);
    const call = at >= 0 ? open.splice(at, 1)[0] : undefined;
    if (!e.success) continue;
    if (!call) { sure = false; break; }
    const ts = args.timeOf(e.block);
    if (e.module === delay) {
      // Which request did the Delay carry out? The Delay carries out only the head, and only while its time has not
      // run out; skipExpired removed the void ones before it (no log). So: the first request from the head on that is
      // exactly the call and still valid then. Each one before it must be void then, also one that is the same call
      // (two requests can be alike). The first that is neither void nor the call (a request the watcher could not
      // read, or something else) leaves the replay unsure. The timing is the one in force then: the replay follows
      // each change of it, and it must end as the one read now.
      let j = cur;
      for (; j < args.to; j++) {
        const gone = expiredAt(j, ts);
        if (!gone && same(items.get(j), call)) break;
        if (!gone) { j = args.to; break; }
      }
      if (j >= args.to) { sure = false; break; }
      for (; cur < j; cur++) reasons.set(cur, { how: 'expired' });
      reasons.set(j, { how: 'executed', block: e.block });
      cur = j + 1;
    }
    if (!effects(call, e.block, ts)) { sure = false; break; }
  }
  // The timing at the end must be the one read now. Else something changed it that the replay did not see.
  if (timing.cooldown !== args.after.cooldown || timing.expiration !== args.after.expiration) sure = false;
  // The rest left without a log: removed because its time ran out. If its time did not run out, something is not as
  // the replay thinks. Without certainty, no request keeps a "removed" or a "cancelled": only what the logs proved
  // was carried out stays.
  for (let n = cur; n < args.to; n++) {
    reasons.set(n, sure && expiredAt(n, args.now) ? { how: 'expired' } : { how: 'executed_or_cancelled' });
  }
  if (!sure) {
    for (const [n, r] of reasons) if (r.how !== 'executed') reasons.set(n, { how: 'executed_or_cancelled' });
  }
  return reasons;
}

/** One request that waits, as a line: what it is, and where its wait stands. */
export function waitLine(summary: string, st: Status): string {
  const when = st.status === 'waiting' ? `Its wait ends on ${fmtWhen(st.readyAt)}.`
    : st.status === 'ready' ? 'Its wait is over.'
    : 'It was not finished in time and is void.';
  return `${summary}. ${when}`;
}
