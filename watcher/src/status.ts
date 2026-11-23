// When a request can be finished, when it is void, and why it left the queue.
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

/** The new nonce if this call is setTxNonce(n) on the Delay, else null. */
function setTxNonceOf(call: { to: string; data: string }, delay: string): number | null {
  const d = call.data.toLowerCase();
  if (call.to.toLowerCase() !== delay || !d.startsWith(SET_TX_NONCE) || d.length !== 2 + 8 + 64) return null;
  const n = BigInt('0x' + d.slice(10));
  return n > 1_000_000_000n ? null : Number(n);
}

/**
 * Why each request that waited at the last poll left the queue. The Safe of a Chronobox (SafeL2) logs every call of
 * a module before it runs and its result after it, in the order of the chain. So the watcher replays them from the
 * txNonce of the last poll:
 *
 * - The Delay calls the Safe: the request at the head of the queue was carried out. Requests before it whose time
 *   had run out were removed first (skipExpired logs nothing, and the Delay refuses to carry out such a request).
 * - setTxNonce(n) on the Delay that worked (from the cancel contract, or from the Delay as a request of its own):
 *   every request before n was cancelled.
 * - A call that failed changed nothing.
 *
 * Several of these can be in one block. Reading the state of the block before would take a request that was carried
 * out for one that was cancelled. What the replay cannot explain (a call that does not match the request, a result
 * without its call, a request without a log) is "carried out or cancelled", never "no money moved".
 */
export function replayQueue(args: {
  /** txNonce at the last poll, and now. */
  from: number;
  to: number;
  events: VaultEvent[];
  delay: string;
  items: Map<number, QueueTx>;
  cooldown: bigint;
  expiration: bigint;
  /** The time of each block that has a result in `events`. */
  timeOf: (block: number) => bigint;
  now: bigint;
}): Map<number, CloseReason> {
  const { delay, items, cooldown, expiration } = args;
  const reasons = new Map<number, CloseReason>();
  const expiredAt = (n: number, ts: bigint) => {
    const it = items.get(n);
    return it !== undefined && itemStatus(it.createdAt, cooldown, expiration, ts).status === 'expired';
  };
  const same = (it: QueueTx | undefined, c: { to: string; value: bigint; data: string; operation: number }) =>
    it === undefined || it.to === undefined ||
    (it.to.toLowerCase() === c.to.toLowerCase() && BigInt(it.value ?? '0') === c.value &&
      (it.data ?? '0x').toLowerCase() === c.data.toLowerCase() && (it.operation ?? 0) === c.operation);
  let cur = args.from;
  let sure = true;
  const open: Extract<VaultEvent, { kind: 'call' }>[] = [];
  const cancel = (n: number, block: number, ts: bigint) => {
    for (; cur < n; cur++) reasons.set(cur, { how: 'cancelled', block, ts });
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
      while (cur < args.to && expiredAt(cur, ts)) reasons.set(cur++, { how: 'expired' });
      if (cur >= args.to || !same(items.get(cur), call)) { sure = false; break; }
      reasons.set(cur++, { how: 'executed', block: e.block });
    }
    const n = setTxNonceOf(call, delay);
    if (n !== null) {
      if (n < cur || n > args.to) { sure = false; break; }
      cancel(n, e.block, ts);
    }
  }
  // The rest left without a log: removed because its time ran out. If its time did not run out, something is not as
  // the replay thinks.
  for (let n = cur; n < args.to; n++) {
    reasons.set(n, sure && expiredAt(n, args.now) ? { how: 'expired' } : { how: 'executed_or_cancelled' });
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
