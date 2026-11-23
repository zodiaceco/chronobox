/**
 * Alerts in Telegram.
 *
 * A watcher (watcher/watch.ts --all, with a Telegram bot) watches every
 * Chronobox on a network. A person opens the bot from here and presses Start,
 * and the bot sends the alerts of this Chronobox to that chat from then on.
 * The registration is in Telegram. This app sends nothing to anybody: it only
 * builds the link.
 */

/** What the link to the Telegram bot carries. The same rule is in watcher/watch.ts (telegramStart). */
export function telegramStart(chainId: number, safe: string): string {
  return `${chainId}-${safe.toLowerCase()}`;
}

/**
 * Opens the bot in Telegram with this Chronobox. The person presses Start there, and the bot then
 * keeps the number of that chat and the address. Telegram allows letters, digits, "-" and "_" after
 * "start=", up to 64 characters.
 */
export function telegramLink(bot: string, chainId: number, safe: string): string {
  return `https://t.me/${bot.replace(/^@/, "")}?start=${telegramStart(chainId, safe)}`;
}
