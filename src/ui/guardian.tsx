/**
 * The guardian: a second person or device that can stop a withdrawal while it
 * waits, and that can move the Chronobox to a new wallet together with its
 * owner. A guardian is never part of the setup. It is added later, from the
 * page of a finished Chronobox, and it waits the delay like every change.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { formatDuration } from "../lib/format.ts";
import { type Address, type Hex, parseAddress, sameAddress } from "../lib/hex.ts";
import { setPendingSwap } from "../lib/store.ts";
import {
  type CouncilTx,
  type Inspection,
  type Rpc,
  addGuardianTx,
  councilApproveTx,
  councilApproved,
  councilCompatible,
  councilCreateTx,
  councilExecTx,
  councilHash,
  councilOwners,
  councilSwapTx,
  delayNonces,
  removeGuardianTx,
  sendAndWait,
} from "../lib/chronobox.ts";
import { errorText } from "../lib/wallet.ts";
import { AddressText, Button, Choice, Modal, Notice, type Session, SlowNote, copyText, useAction } from "./common.tsx";
import { QrCode } from "./deposit.tsx";
import { UnknownSheet, type VaultRef, queueItem } from "./queue.tsx";

/** The page of this Chronobox, as a link for another person. `to`: with a request for a new wallet. */
export function guardianLink(chain: Chain, safe: Address, to?: Address): string {
  return `${location.origin}${location.pathname}#/v/${chain.short}:${safe}${to ? `?to=${to}` : ""}`;
}

/** A line of text that is copied with one tap. */
function CopyLine(props: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!(await copyText(props.text))) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The text is on screen and can be selected by hand.
    }
  };
  return (
    <button type="button" class="deposit-address" onClick={copy}>
      <code>{props.text}</code>
      <span class="deposit-copy">{copied ? "Copied" : "Tap to copy"}</span>
    </button>
  );
}

const CAN = [
  "Your guardian can stop any withdrawal while it waits. If somebody has your wallet and you cannot cancel, your guardian can.",
  "Together you can move this Chronobox to a new wallet at once. That is for the day when the key of your wallet has leaked.",
  "Your guardian can never withdraw, and can never take your money.",
];

/** The row "Guardian" opens this. What it shows depends on who looks, and on whether there is a guardian. */
export function GuardianSheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  role: "owner" | "guardian" | "viewer";
  /** A guardian that is in the line and has not started yet. */
  waiting: Address | null;
  onClose: () => void;
}) {
  const { vault, inspection, chain } = props;
  const wait = formatDuration(inspection.cooldown);
  const link = guardianLink(chain, vault.safe);

  if (props.role === "guardian") {
    return (
      <Modal title="You are the guardian" lead="The owner of this Chronobox trusts you to say stop." onClose={props.onClose}>
        <ul class="plain-list">
          <li>When a withdrawal waits here, call the owner.</li>
          <li>If you cannot reach them, or they did not ask for it, stop it. A wrong stop costs little: the owner can ask again.</li>
          <li>You cannot withdraw, and you cannot take the money.</li>
        </ul>
        <p class="hint">Keep the link of this page. To stop something, your wallet needs a little {chain.native.symbol} for the fee.</p>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  if (inspection.guardian) {
    return props.role === "owner" ? (
      <ManageSheet {...props} guardian={inspection.guardian} link={link} wait={wait} />
    ) : (
      <Modal title="Guardian" onClose={props.onClose}>
        <p>
          This Chronobox has a guardian: <AddressText address={inspection.guardian} />. The guardian can stop a withdrawal while it waits. The guardian cannot withdraw.
        </p>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  if (props.waiting) {
    return (
      <Modal title="Your guardian starts soon" lead={`The wait has started. When it ends, apply it under "Waiting".`} onClose={props.onClose}>
        <p>
          Guardian: <AddressText address={props.waiting} full />
        </p>
        <p class="hint">Send your guardian this link now. It opens your Chronobox for them.</p>
        <CopyLine text={link} />
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }

  return <AddSheet {...props} link={link} wait={wait} />;
}

function AddSheet(props: { session: Session; chain: Chain; vault: VaultRef; onClose: () => void; link: string; wait: string }) {
  const { session, chain, vault, wait } = props;
  const [stage, setStage] = useState<"intro" | "form" | "done" | "unknown">("intro");
  const [text, setText] = useState("");
  const [stops, setStops] = useState(false);
  const [noBackup, setNoBackup] = useState(false);
  const [isContract, setIsContract] = useState(false);
  const [incompatible, setIncompatible] = useState(false);
  const action = useAction();
  const guardian = parseAddress(text);
  const tx = guardian && vault.roles ? addGuardianTx({ safe: vault.safe, delay: vault.delay, roles: vault.roles, controller: vault.controller }, guardian) : null;
  useEffect(() => {
    setIsContract(false);
    setIncompatible(false);
    if (!guardian || !tx) return;
    let stale = false;
    session.rpc("eth_getCode", [guardian, "latest"]).then(
      (code: string) => !stale && setIsContract(typeof code === "string" && code.length > 2),
      () => undefined,
    );
    councilCompatible(session.rpc, vault.safe, vault.controller, guardian).then(
      (ok) => !stale && setIncompatible(!ok),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [guardian, !!tx, session.rpc, vault.safe, vault.controller]);
  const problem =
    text.trim() === ""
      ? null
      : !guardian
        ? "This is not a wallet address."
        : sameAddress(guardian, vault.controller)
          ? "This is your own wallet. A guardian is another wallet."
          : sameAddress(guardian, vault.safe)
            ? "This is the address of the Chronobox itself. Enter the address of your guardian's wallet."
            : !tx
              ? "Nobody can sign with this address. Enter the address of a wallet."
              : incompatible
                ? "This guardian address was used with this Chronobox before and cannot be added again. Use another wallet address."
                : null;
  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, chain, vault, tx!, waiting);
      setStage(receipt ? "done" : "unknown");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done") {
    return (
      <Modal title="The wait has started." lead={`In ${wait} you can switch your guardian on. Send them this link now. It opens your Chronobox for them.`} onClose={props.onClose}>
        <CopyLine text={props.link} />
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }
  if (stage === "intro") {
    return (
      <Modal title="Add a guardian" lead="One more person who can say stop." onClose={props.onClose}>
        <ul class="plain-list">
          {CAN.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p class="hint">A good guardian is a second device of your own in another place, or a person close to you.</p>
        <div class="modal-actions">
          <Button kind="primary" onClick={() => setStage("form")}>
            Choose my guardian
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Who is your guardian?"
      lead={`Paste the address of their wallet on ${chain.name}. Your guardian starts after ${wait}, like every change here.`}
      busy={action.busy !== null && !action.slow}
      onClose={props.onClose}
    >
      <input
        class="input"
        placeholder="Address of your guardian's wallet"
        aria-label="Address of your guardian's wallet"
        autocomplete="off"
        spellcheck={false}
        value={text}
        disabled={!!action.busy}
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
      />
      {problem ? <p class="field-error">{problem}</p> : null}
      {isContract && !problem ? <p class="hint">This address is a contract, not a plain wallet. That is right only if it is a wallet such as a Safe, and your guardian controls it on {chain.name}.</p> : null}
      <div class="wiz-list">
        <Choice
          role="checkbox"
          on={stops}
          title="My guardian can stop every withdrawal."
          text="I can remove my guardian only when my guardian lets it happen."
          disabled={!!action.busy}
          onClick={() => setStops(!stops)}
        />
        <Choice
          role="checkbox"
          on={noBackup}
          title="My guardian is not a backup."
          text="If I lose my wallet, the money in this Chronobox is lost."
          disabled={!!action.busy}
          onClick={() => setNoBackup(!noBackup)}
        />
      </div>
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!tx || incompatible || !stops || !noBackup} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
        <Button kind="quiet" onClick={() => setStage("intro")} disabled={!!action.busy}>
          Back
        </Button>
      </div>
    </Modal>
  );
}

function ManageSheet(props: { session: Session; chain: Chain; vault: VaultRef; onClose: () => void; guardian: Address; link: string; wait: string }) {
  const { session, chain, vault, wait } = props;
  const [stage, setStage] = useState<"show" | "remove" | "done" | "unknown">("show");
  const action = useAction();
  const tx = vault.roles && vault.council && vault.members ? removeGuardianTx({ roles: vault.roles, guardian: props.guardian, council: vault.council, members: vault.members }) : null;
  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, chain, vault, tx!, waiting);
      setStage(receipt ? "done" : "unknown");
    });
  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done") {
    return (
      <Modal title="The wait has started." lead={`In ${wait} you can apply it. Until then your guardian can still stop everything, and this too.`} onClose={props.onClose}>
        <div class="modal-actions">
          <Button kind="primary" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  }
  if (stage === "remove") {
    return (
      <Modal title="Remove your guardian?" lead={`This waits ${wait}, and your guardian can stop it in that time.`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <p>After it, only your wallet can cancel a withdrawal, and nobody can help you move to a new wallet at once.</p>
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!tx} busy={action.busy === "queue"} onClick={submit}>
            {action.busy ? "Confirm in your wallet" : "Start the wait"}
          </Button>
          <Button kind="quiet" onClick={() => setStage("show")} disabled={!!action.busy}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Your guardian" onClose={props.onClose}>
      <p class="big-line">
        <AddressText address={props.guardian} full />
      </p>
      <ul class="plain-list">
        <li>Can stop any withdrawal while it waits.</li>
        <li>Can move this Chronobox to a new wallet, together with you.</li>
        <li>Cannot withdraw, and cannot take your money.</li>
      </ul>
      <p class="hint">The link for your guardian. It opens this Chronobox for them.</p>
      <CopyLine text={props.link} />
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Done
        </Button>
        <Button kind="quiet" onClick={() => setStage("remove")}>
          Remove my guardian
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A new wallet at once: the owner asks, the guardian agrees, the owner changes
// ---------------------------------------------------------------------------

type Swap =
  | { state: "loading" }
  /** The 2 of 2 Safe of wallet and guardian is not made yet. The owner makes it with the first request. */
  | { state: "not-made" }
  /** The new wallet already owns the shared Safe: the hand-over happened on chain. */
  | { state: "done" }
  /** The address cannot hold this Chronobox. */
  | { state: "bad" }
  /** The first read failed. */
  | { state: "error"; message: string }
  | { state: "ready"; tx: CouncilTx; hash: Hex; owners: Address[]; agreed: boolean };

/** How many earlier points of the line an agreement of the guardian is looked for at. */
const SNAPSHOTS = 4n;

/** Reads the request from the chain every few seconds: what both sign, and whether the guardian agreed. */
function useSwap(rpc: Rpc, vault: VaultRef, to: Address): { swap: Swap; retry: () => void } {
  const [swap, setSwap] = useState<Swap>({ state: "loading" });
  const [round, setRound] = useState(0);
  const reading = useRef(false);
  const { council, guardian, roles, members } = vault;
  useEffect(() => {
    if (!council || !guardian || !roles || !members) return setSwap({ state: "bad" });
    let stale = false;
    let hadAnswer = false;
    setSwap({ state: "loading" });
    const read = async () => {
      if (reading.current) return;
      reading.current = true;
      try {
        const code = (await rpc("eth_getCode", [council, "latest"])) as string;
        if (typeof code !== "string" || code.length <= 2) {
          hadAnswer = true;
          return !stale && setSwap({ state: "not-made" });
        }
        const owners = await councilOwners(rpc, council);
        if (owners.some((o) => sameAddress(o, to))) {
          hadAnswer = true;
          return !stale && setSwap({ state: "done" });
        }
        // The change also cancels the whole line, up to where it stands now. If something was queued
        // after the guardian agreed, the signed change names an earlier point: look a few back for it.
        // Whatever it leaves behind is caught after the change (see LeftInLine).
        const { queueNonce } = await delayNonces(rpc, vault.delay);
        let found: { tx: CouncilTx; hash: Hex; agreed: boolean } | null = null;
        for (let upTo = queueNonce; upTo >= 0n && queueNonce - upTo < SNAPSHOTS; upTo--) {
          const tx = councilSwapTx({ ...vault, roles, guardian, council, members }, owners, to, upTo);
          if (!tx) {
            hadAnswer = true;
            return !stale && setSwap({ state: "bad" });
          }
          const hash = await councilHash(rpc, council, tx);
          const agreed = await councilApproved(rpc, council, guardian, hash);
          if (!found || agreed) found = { tx, hash, agreed };
          if (agreed) break;
        }
        hadAnswer = true;
        if (!stale && found) setSwap({ state: "ready", ...found, owners });
      } catch (e) {
        // After a first good read, a temporary failure keeps the last answer and asks again next round.
        if (!stale && !hadAnswer) setSwap({ state: "error", message: errorText(e) });
      } finally {
        reading.current = false;
      }
    };
    read();
    const timer = setInterval(() => document.visibilityState === "visible" && read(), 5000);
    return () => {
      stale = true;
      reading.current = false;
      clearInterval(timer);
    };
  }, [rpc, vault.safe, vault.delay, vault.controller, council, guardian, roles, members?.join(","), to, round]);
  return { swap, retry: () => setRound((r) => r + 1) };
}

/**
 * The first step of the owner: make the shared Safe if nobody has yet. It is one transaction,
 * once. After it, asking the guardian costs the owner nothing.
 */
export async function prepareSwap(session: Session, chain: Chain, vault: VaultRef, waiting: { onSlow: () => void; shouldStop: () => boolean }): Promise<void> {
  const code = (await session.rpc("eth_getCode", [vault.council!, "latest"])) as string;
  if (typeof code === "string" && code.length > 2) return;
  await sendAndWait(session.rpc, session.account, councilCreateTx(vault.safe, vault.controller, vault.guardian!), { chainId: chain.id, chainName: chain.name, ...waiting });
}

type Line = { state: "loading" } | { state: "error"; message: string } | { state: "read"; waiting: bigint };

/** What is still in the line of the Delay. Read again on request. */
function useLine(rpc: Rpc, delay: Address, active = true): { line: Line; retry: () => void } {
  const [line, setLine] = useState<Line>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stale = false;
    setLine({ state: "loading" });
    delayNonces(rpc, delay).then(
      ({ txNonce, queueNonce }) => !stale && setLine({ state: "read", waiting: queueNonce - txNonce }),
      (e) => !stale && setLine({ state: "error", message: errorText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [rpc, delay, round, active]);
  return { line, retry: () => setRound((r) => r + 1) };
}

/**
 * After the change. The change cancels what waited, but something that the lost wallet queued
 * after the guardian agreed can still be in the line, and it would run after the wait. The
 * owner is told it is over only when the line is empty.
 */
function SwapDoneSheet(props: { rpc: Rpc; vault: VaultRef; onClose: () => void }) {
  const { line, retry } = useLine(props.rpc, props.vault.delay);
  const close = (
    <div class="modal-actions">
      <Button kind="primary" onClick={props.onClose}>
        Done
      </Button>
    </div>
  );
  if (line.state === "loading") {
    return (
      <Modal title="Checking the line" onClose={props.onClose}>
        <p class="muted">The new wallet holds this Chronobox. One moment: we check that nothing the old wallet asked for still waits.</p>
      </Modal>
    );
  }
  if (line.state === "error" || line.waiting > 0n) {
    const count = line.state === "read" ? (line.waiting === 1n ? "One item is" : `${line.waiting} items are`) : null;
    return (
      <Modal title="Not finished: cancel what waits." lead="The new wallet holds this Chronobox. But the old wallet can still get money out through what it queued before." onClose={props.onClose}>
        {line.state === "error" ? (
          <Notice kind="bad">
            We could not read the line: {line.message}{" "}
            <button type="button" class="link-button" onClick={retry}>
              Try again
            </button>
          </Notice>
        ) : (
          <Notice kind="bad" title={`${count} still in the line.`}>
            Unless your new wallet queued them, they come from the old wallet, and they run after the wait. Open this Chronobox with your new wallet, or ask your guardian, and cancel them now. This wallet cannot cancel any more.
          </Notice>
        )}
        <CopyLine text={props.vault.safe} />
        <div class="modal-actions">
          <Button kind="primary" onClick={retry}>
            Check again
          </Button>
          <Button kind="quiet" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="The new wallet holds this Chronobox."
      lead="Nothing waits in the line, so nothing the old wallet asked for can run. This wallet can do nothing here any more. Keep the address of the Chronobox: the new wallet needs it to open it."
      onClose={props.onClose}
    >
      <CopyLine text={props.vault.safe} />
      {close}
    </Modal>
  );
}

/** The owner's side while the guardian decides. */
export function AskGuardianSheet(props: { session: Session; chain: Chain; vault: VaultRef; to: Address; onDrop: () => void; onClose: () => void }) {
  const { session, chain, vault, to } = props;
  const { swap, retry } = useSwap(session.rpc, vault, to);
  const [done, setDone] = useState(false);
  const action = useAction();
  const link = guardianLink(chain, vault.safe, to);

  useEffect(() => {
    if (swap.state === "done") {
      setPendingSwap(chain.id, vault.safe, null);
      setDone(true);
    }
  }, [swap.state, chain.id, vault.safe]);

  const change = () =>
    action.run("change", async (waiting) => {
      if (swap.state !== "ready") return;
      await sendAndWait(session.rpc, session.account, councilExecTx(vault.council!, swap.tx, swap.owners), { chainId: chain.id, chainName: chain.name, ...waiting });
      setPendingSwap(chain.id, vault.safe, null);
      setDone(true);
    });
  if (done || swap.state === "done") {
    return <SwapDoneSheet rpc={session.rpc} vault={vault} onClose={props.onClose} />;
  }
  const agreed = swap.state === "ready" && swap.agreed;
  return (
    <Modal title="Ask your guardian" lead="Send this link to your guardian, and call them. Your guardian checks the address of the new wallet and agrees." busy={action.busy !== null && !action.slow} onClose={props.onClose}>
      <p class="swap-to">
        <span class="swap-to-label">New wallet</span>
        <code>{to}</code>
      </p>
      <CopyLine text={link} />
      <div class="swap-qr">
        <QrCode text={link} label="QR code of the link for your guardian" />
      </div>
      {swap.state === "bad" ? (
        <Notice kind="bad">This wallet cannot hold the Chronobox. Drop this request and start again with another address.</Notice>
      ) : swap.state === "not-made" ? (
        <Notice kind="risk">The shared Safe with your guardian is not on chain yet. Drop this request and start it again.</Notice>
      ) : swap.state === "error" ? (
        <Notice kind="bad">
          {swap.message}{" "}
          <button type="button" class="link-button" onClick={retry}>
            Try again
          </button>
        </Notice>
      ) : agreed ? (
        <Notice kind="good" title="Your guardian agreed.">
          You can change the wallet now. It happens at once.
        </Notice>
      ) : (
        <p class="swap-waiting" role="status">
          <span class="spinner" aria-hidden="true" />
          Waiting for your guardian
        </p>
      )}
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!agreed} busy={action.busy === "change"} onClick={change}>
          {action.busy ? "Confirm in your wallet" : "Change the wallet now"}
        </Button>
        <Button kind="quiet" onClick={props.onDrop} disabled={!!action.busy}>
          Drop this request
        </Button>
      </div>
    </Modal>
  );
}

/** The guardian's side: a link from the owner asks for a new wallet. */
export function AgreeSheet(props: { session: Session; chain: Chain; vault: VaultRef; to: Address; onClose: () => void }) {
  const { session, chain, vault, to } = props;
  const { swap, retry } = useSwap(session.rpc, vault, to);
  const changed = sameAddress(to, vault.controller) || swap.state === "done";
  const { line } = useLine(session.rpc, vault.delay, changed);
  const [spoke, setSpoke] = useState(false);
  const [sent, setSent] = useState(false);
  const action = useAction();
  const agree = () =>
    action.run("agree", async (waiting) => {
      if (swap.state !== "ready") return;
      await sendAndWait(session.rpc, session.account, councilApproveTx(vault.council!, swap.hash), { chainId: chain.id, chainName: chain.name, ...waiting });
      setSent(true);
    });
  const closeOnly = (
    <div class="modal-actions">
      <Button kind="primary" onClick={props.onClose}>
        Close
      </Button>
    </div>
  );
  if (sameAddress(to, vault.controller) || swap.state === "done") {
    return (
      <Modal title="It is done." onClose={props.onClose}>
        <p>
          The wallet <AddressText address={to} /> holds this Chronobox now. You are still its guardian.
        </p>
        {line.state === "read" && line.waiting > 0n ? (
          <Notice kind="risk" title="Something still waits in the line.">
            Unless the new wallet queued it, it comes from the old wallet, and it runs after the wait. Ask the owner, and cancel it if they did not.
          </Notice>
        ) : null}
        {closeOnly}
      </Modal>
    );
  }
  if (swap.state === "loading") {
    return (
      <Modal title="Reading the request" onClose={props.onClose}>
        <p class="muted">One moment.</p>
      </Modal>
    );
  }
  if (swap.state === "error") {
    return (
      <Modal title="We could not read the request" onClose={props.onClose}>
        <Notice kind="bad">{swap.message}</Notice>
        <div class="modal-actions">
          <Button kind="primary" onClick={retry}>
            Try again
          </Button>
          <Button kind="quiet" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </Modal>
    );
  }
  if (swap.state === "not-made") {
    return (
      <Modal title="The request is not ready yet" onClose={props.onClose}>
        <p>The owner has not finished asking. When their page says "Waiting for your guardian", open this link again.</p>
        {closeOnly}
      </Modal>
    );
  }
  if (swap.state === "bad") {
    return (
      <Modal title="This link does not fit" onClose={props.onClose}>
        <p>It does not name a wallet that can hold this Chronobox. Ask the owner for a new link.</p>
        {closeOnly}
      </Modal>
    );
  }
  if (swap.agreed || sent) {
    return (
      <Modal title="You agreed." onClose={props.onClose}>
        <p>The owner can change the wallet now. You do not need to do anything more.</p>
        {closeOnly}
      </Modal>
    );
  }
  return (
    <Modal title="Agree to a new wallet?" lead="The owner of this Chronobox asks to move it to this wallet. It happens at once, without the wait." busy={action.busy !== null && !action.slow} onClose={props.onClose}>
      <p class="swap-to">
        <span class="swap-to-label">New wallet</span>
        <code>{to}</code>
      </p>
      <Notice kind="risk" title="Call the owner first.">
        Agree only if they tell you this address themselves. A message is not enough: a person who has their wallet can write to you too.
      </Notice>
      <Choice role="checkbox" on={spoke} title="I spoke to the owner, and the address is the same." disabled={!!action.busy} onClick={() => setSpoke(!spoke)} />
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!spoke} busy={action.busy === "agree"} onClick={agree}>
          {action.busy ? "Confirm in your wallet" : "Agree"}
        </Button>
        <Button kind="quiet" onClick={props.onClose} disabled={!!action.busy}>
          Not now
        </Button>
      </div>
    </Modal>
  );
}
