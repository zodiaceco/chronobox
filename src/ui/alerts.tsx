/**
 * Alerts for one Chronobox: a sheet with one button that opens the Telegram
 * bot with this Chronobox. The person presses Start there. That is the whole
 * setup, and it happens in Telegram, not here.
 *
 * Without ALERTS_TELEGRAM there is no alert service, and the Chronobox page
 * does not show this sheet.
 */
import { telegramLink } from "../lib/alerts.ts";
import { ALERTS_TELEGRAM, type Chain } from "../lib/chains.ts";
import type { Address } from "../lib/hex.ts";
import { Modal } from "./common.tsx";

/** The dev server shows the sheet with a bot name that is only a stand-in. Put the name of your test bot in ALERTS_TELEGRAM. */
export const BOT: string | null = ALERTS_TELEGRAM ?? (__DEV__ ? "chronobox_alerts_dev_bot" : null);

export function AlertsSheet(props: { chain: Chain; safe: Address; onClose: () => void }) {
  if (!BOT) return null;
  return (
    <Modal title="Get told" lead="The wait protects you only if you hear about a withdrawal in time." onClose={props.onClose}>
      <div class="modal-actions">
        <a class="button button-primary" href={telegramLink(BOT, props.chain.id, props.safe)} target="_blank" rel="noreferrer noopener">
          Get alerts in Telegram
        </a>
      </div>
      <p class="deposit-note">
        Telegram opens. Press Start there. The alert service keeps the number of your Telegram chat, the address of this Chronobox, and
        since when you follow it. Nothing else.
      </p>
    </Modal>
  );
}
