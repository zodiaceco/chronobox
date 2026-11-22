/**
 * What every sheet that puts something into the line shares.
 */
import type { Chain } from "../lib/chains.ts";
import { shortAddress } from "../lib/format.ts";
import { sameAddress } from "../lib/hex.ts";
import { type DelayTx, type Receipt, type VaultParts, Replaced, StoppedWaiting, delayTxHash, queueTx, queuedInReceipt, sendAndWait } from "../lib/chronobox.ts";
import { txCache } from "../lib/store.ts";
import { Button, Modal, type Session, type Waiting } from "./common.tsx";

/** The parts of the Chronobox on the page. With a guardian: who it is, and the Safe that the guardian shares with the wallet. */
export type VaultRef = VaultParts;

/**
 * Puts one item into the line. Null means that the outcome is not known: the person stopped
 * waiting, or the wallet replaced the transaction. Then the line on the page has the answer,
 * and the form must not invite a second try.
 */
export async function queueItem(session: Session, chain: Chain, vault: VaultRef, tx: DelayTx, waiting: Waiting): Promise<Receipt | null> {
  if (!sameAddress(vault.controller, session.account)) {
    throw new Error(`Your wallet is on another account now. Only the wallet ${shortAddress(vault.controller)} can do this.`);
  }
  try {
    const receipt = await sendAndWait(session.rpc, session.account, queueTx(vault.delay, tx), { chainId: chain.id, chainName: chain.name, ...waiting });
    // Remember what just went into the line, so the vault page does not have to scan logs for it.
    const cache = txCache(chain.id, vault.delay);
    for (const one of queuedInReceipt(receipt, vault.delay)) cache.set(one.nonce, delayTxHash(one.tx), one.tx);
    return receipt;
  } catch (e) {
    if (e instanceof Replaced || e instanceof StoppedWaiting) return null;
    throw e;
  }
}

/** After a send whose outcome is not known. */
export function UnknownSheet(props: { onClose: () => void }) {
  return (
    <Modal title="Look at the line" onClose={props.onClose}>
      <p>
        Your wallet sent the request, but this page did not see it arrive. That can happen when the network is slow, or when the request was
        changed in the wallet.
      </p>
      <p>
        Close this and look under "Waiting". If it is there, the wait has started. If it is not there after a few minutes, ask again. Do not ask
        twice before you have looked.
      </p>
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

