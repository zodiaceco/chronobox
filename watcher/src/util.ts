/** A setting is wrong. The CLI stops with exit code 2, a function answers 500. Never retried. */
export class ConfigError extends Error {}

export type Log = (msg: string) => void;
export type FetchFn = typeof fetch;

export const defaultLog: Log = (m) => console.log(`${new Date().toISOString()} ${m}`);

export function errText(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as any).cause;
    return cause?.code ? `${e.message} (${cause.code})` : e.message;
  }
  return String(e);
}
