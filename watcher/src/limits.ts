// How long the functions on Vercel may run, and the numbers that depend on it. build.mjs writes them into the
// Build Output, and the service uses them, so they cannot drift apart.

/** The Vercel functions: their path under /api and how long each may run (maxDuration, in seconds). */
export const FUNCTIONS = {
  poll: { maxDuration: 120 },
  telegram: { maxDuration: 60 },
  health: { maxDuration: 10 },
} as const;

/** Vercel Cron calls /api/poll this often. */
export const POLL_SCHEDULE = '* * * * *';

/**
 * A lock in Redis lives this long if its holder does not free it. Longer than any function may run, so that a
 * lock never runs out while its holder still works. A function that was killed blocks the next ones this long.
 */
export const LOCK_TTL_MS = (Math.max(...Object.values(FUNCTIONS).map((f) => f.maxDuration)) + 10) * 1000;

/** After this many seconds a poll reads no further vault. It must stay well below the maxDuration of the poll. */
export const DEFAULT_POLL_BUDGET_SECONDS = 60;
