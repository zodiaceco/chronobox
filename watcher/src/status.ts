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

/** A TxNonceSet log: the new nonce, where it happened, and txNonce one block before (null if the RPC has no such old state). */
export type NonceSet = { nonce: number; block: number; ts: bigint; before: number | null };

export type CloseReason =
  | { how: 'cancelled'; block: number; ts: bigint }
  | { how: 'executed_or_cancelled'; block: number }
  | { how: 'executed' | 'expired' | 'executed_or_expired' };

/**
 * Why a queue item that was pending at the last poll is gone now.
 * An execution and skipExpired emit no Delay event. A cancel (setTxNonce) is read from the vault's module calls,
 * and from TxNonceSet on a Delay that has that event.
 */
export function closeReason(
  nonce: number, createdAt: bigint, sets: NonceSet[], cooldown: bigint, expiration: bigint, lastTs: bigint, now: bigint,
): CloseReason {
  const set = sets.find((l) => nonce < l.nonce);
  if (set && (set.before === null || nonce >= set.before)) {
    // Without the old txNonce, only an item that could not execute at that time is surely cancelled.
    if (set.before === null && itemStatus(createdAt, cooldown, expiration, set.ts).status === 'ready') {
      return { how: 'executed_or_cancelled', block: set.block };
    }
    return { how: 'cancelled', block: set.block, ts: set.ts };
  }
  if (itemStatus(createdAt, cooldown, expiration, lastTs).status === 'expired') return { how: 'expired' };
  if (itemStatus(createdAt, cooldown, expiration, now).status === 'expired') return { how: 'executed_or_expired' };
  return { how: 'executed' };
}

/** One request that waits, as a line: what it is, and where its wait stands. */
export function waitLine(summary: string, st: Status): string {
  const when = st.status === 'waiting' ? `Its wait ends on ${fmtWhen(st.readyAt)}.`
    : st.status === 'ready' ? 'Its wait is over.'
    : 'It was not finished in time and is void.';
  return `${summary}. ${when}`;
}
