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
  type SwapRequest,
  addGuardianTx,
  councilApproveTx,
  councilCompatible,
  councilCreateTx,
  DEFAULT_RECOVERY_WAIT,
  councilExecTx,
  councilHash,
  councilOwners,
  councilApproved,
  cancelTx,
  councilSwapTx,
  delayNonces,
  readSwapCoverage,
  type SwapCoverage,
  removeGuardianTx,
  sendAndWait,
} from "../lib/chronobox.ts";
import { errorText } from "../lib/wallet.ts";
import { AddressText, Button, Choice, Modal, Notice, type Session, SlowNote, copyText, useAction } from "./common.tsx";
import { QrCode } from "./deposit.tsx";
import { UnknownSheet, type VaultRef, queueItem } from "./queue.tsx";
import { RecoverySheet, type RecoveryWaiting, StartRecoverySheet, type WaitPick, WaitPicker, defaultCustomDays, ensureRecoveryDelay, pickedWait, recoveryPromise } from "./recovery.tsx";

/** The page of this Chronobox, as a link for another person. `request`: with a request for a new wallet. */
export function guardianLink(chain: Chain, safe: Address, request?: SwapRequest): string {
  return `${location.origin}${location.pathname}#/v/${chain.short}:${safe}${request ? `?to=${request.to}&upTo=${request.upTo}` : ""}`;
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
  /** With that guardian: how long a recovery waits. Null when it comes without a recovery. */
  waitingRecovery: bigint | null;
  /** A recovery change that is in the line and has not started yet. */
  recoveryWaiting: RecoveryWaiting;
  /** True while something waits in the line of the recovery. */
  recoveryStarted: boolean;
  onClose: () => void;
}) {
  const { vault, inspection, chain } = props;
  const wait = formatDuration(inspection.cooldown);
  const link = guardianLink(chain, vault.safe);
  const recovery = inspection.recovery;

  if (props.role === "guardian") return <OwnSheet {...props} />;

  if (inspection.guardian) {
    return props.role === "owner" ? (
      <ManageSheet {...props} guardian={inspection.guardian} link={link} wait={wait} />
    ) : (
      <Modal title="Guardian" onClose={props.onClose}>
        <p>
          This Chronobox has a guardian: <AddressText address={inspection.guardian} />. The guardian can stop a withdrawal while it waits. The guardian cannot withdraw.
        </p>
        {recovery ? (
          <p>
            The guardian can also start a recovery, for when the owner has lost the wallet. A recovery moves this Chronobox to a new wallet that the guardian chooses. It waits{" "}
            {formatDuration(recovery.wait)}, and the owner can stop it in that time.
          </p>
        ) : null}
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
        {props.waitingRecovery !== null ? <p>Your guardian can also bring this Chronobox back when you lose your wallet. A recovery waits {formatDuration(props.waitingRecovery)}.</p> : null}
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

/** What the guardian sees: what the role is for, and the way to start a recovery. */
function OwnSheet(props: { session: Session; chain: Chain; vault: VaultRef; inspection: Inspection; recoveryStarted: boolean; onClose: () => void }) {
  const { chain, inspection } = props;
  const [starting, setStarting] = useState(false);
  const recovery = inspection.recovery;
  if (starting && recovery) return <StartRecoverySheet {...props} recovery={recovery} onBack={() => setStarting(false)} />;
  return (
    <Modal title="You are the guardian" lead="The owner of this Chronobox trusts you to say stop." onClose={props.onClose}>
      <ul class="plain-list">
        <li>When a withdrawal waits here, call the owner.</li>
        <li>If you cannot reach them, or they did not ask for it, stop it. A wrong stop costs little: the owner can ask again.</li>
        {recovery ? <li>If the owner has lost the wallet, you can start a recovery. After {formatDuration(recovery.wait)} it moves this Chronobox to the owner's new wallet.</li> : null}
        <li>You cannot withdraw.</li>
      </ul>
      <p class="hint">Keep the link of this page. To stop something, your wallet needs a little {chain.native.symbol} for the fee.</p>
      {recovery && props.recoveryStarted ? <p class="hint">A recovery waits now. Its state is at the top of this page.</p> : null}
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Done
        </Button>
        {recovery && !props.recoveryStarted ? (
          <Button kind="quiet" onClick={() => setStarting(true)}>
            Start a recovery
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}

function AddSheet(props: { session: Session; chain: Chain; vault: VaultRef; inspection: Inspection; onClose: () => void; link: string; wait: string }) {
  const { session, chain, vault, wait } = props;
  // One idea per screen: who, then what happens when you lose your wallet, then a review before anything is sent.
  const [stage, setStage] = useState<"intro" | "who" | "lost" | "review" | "done" | "unknown">("intro");
  const [text, setText] = useState("");
  // One promise, on the review screen. Its words depend on the choice, so a new choice asks again.
  const [promised, setPromised] = useState(false);
  // Null until the owner chose: with a recovery, or without.
  const [recovers, setRecovers] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<WaitPick>(null);
  const [customDays, setCustomDays] = useState(() => defaultCustomDays(props.inspection.cooldown));
  const [delayMade, setDelayMade] = useState(Boolean(vault.recoveryDelay?.deployed));
  const [isContract, setIsContract] = useState(false);
  const [incompatible, setIncompatible] = useState(false);
  const action = useAction();
  const guardian = parseAddress(text);
  const base = vault.roles ? { safe: vault.safe, delay: vault.delay, roles: vault.roles, controller: vault.controller } : null;
  const parts = vault.recoveryDelay ?? null;
  const recoveryWait = recovers ? pickedWait(picked, customDays, props.inspection.cooldown).wait : null;
  // The address alone decides whether it can be a guardian. The recovery does not.
  const possible = guardian && base ? addGuardianTx(base, guardian) !== null : false;
  const tx = !guardian || !base || recovers === null ? null : !recovers ? addGuardianTx(base, guardian) : parts && recoveryWait !== null ? addGuardianTx(base, guardian, { parts, wait: recoveryWait }) : null;
  const choose = (value: boolean) => {
    setRecovers(value);
    // A recovery starts with the wait that most people want. The owner can pick another.
    if (value && picked === null) setPicked(DEFAULT_RECOVERY_WAIT);
    setPromised(false);
  };
  useEffect(() => {
    setIsContract(false);
    setIncompatible(false);
    if (!guardian || !possible) return;
    let stale = false;
    session.rpc("eth_getCode", [guardian, "latest"]).then(
      (code: string) => !stale && setIsContract(typeof code === "string" && code.length > 2),
      () => undefined,
    );
    // With a recovery the shared Safe is another one, at another address.
    councilCompatible(session.rpc, vault.safe, vault.controller, guardian, recovers === true).then(
      (ok) => !stale && setIncompatible(!ok),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [guardian, possible, recovers === true, session.rpc, vault.safe, vault.controller]);
  const problem =
    text.trim() === ""
      ? null
      : !guardian
        ? "This is not a wallet address."
        : sameAddress(guardian, vault.controller)
          ? "This is your own wallet. A guardian is another wallet."
          : sameAddress(guardian, vault.safe)
            ? "This is the address of the Chronobox itself. Enter the address of your guardian's wallet."
            : !possible
              ? "Nobody can sign with this address. Enter the address of a wallet."
              : incompatible
                ? "This guardian address was used with this Chronobox before and cannot be added again. Use another wallet address."
                : null;
  const submit = () =>
    action.run("queue", async (waiting) => {
      if (recovers) {
        if (!(await ensureRecoveryDelay(session, chain, vault.safe, parts, waiting))) return setStage("unknown");
        setDelayMade(true);
      }
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
          <Button kind="primary" onClick={() => setStage("who")}>
            Choose my guardian
          </Button>
        </div>
      </Modal>
    );
  }
  if (stage === "who") {
    return (
      <Modal title="Who is your guardian?" lead={`Paste the address of their wallet on ${chain.name}.`} onClose={props.onClose}>
        <input
          class="input"
          placeholder="Address of your guardian's wallet"
          aria-label="Address of your guardian's wallet"
          autocomplete="off"
          spellcheck={false}
          value={text}
          onInput={(event) => setText((event.target as HTMLInputElement).value)}
        />
        {problem ? <p class="field-error">{problem}</p> : null}
        {isContract && !problem ? <p class="hint">This address is a contract, not a plain wallet. That is right only if it is a wallet such as a Safe, and your guardian controls it on {chain.name}.</p> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!guardian || !possible || !!problem} onClick={() => setStage("lost")}>
            Continue
          </Button>
          <Button kind="quiet" onClick={() => setStage("intro")}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }
  if (stage === "lost") {
    const waitProblem = recovers ? pickedWait(picked, customDays, props.inspection.cooldown).problem : null;
    return (
      <Modal title="If you lose your wallet" lead="What can your guardian do then? You can change this later." onClose={props.onClose}>
        <div class="wiz-list" role="radiogroup" aria-label="If you lose your wallet">
          <Choice role="radio" on={recovers === false} title="Nobody can bring it back" text="Your guardian can only say stop. If you lose your wallet, the money in this Chronobox is lost." onClick={() => choose(false)} />
          <Choice
            role="radio"
            on={recovers === true}
            title="My guardian can bring it back"
            text="After a long wait, to a wallet that your guardian chooses. While it waits, you can stop it at once."
            onClick={() => choose(true)}
          />
        </div>
        {recovers ? (
          <>
            <p class="field-label">How long a recovery waits</p>
            <WaitPicker picked={picked} onPick={setPicked} customDays={customDays} onCustomDays={setCustomDays} cooldown={props.inspection.cooldown} disabled={false} />
          </>
        ) : null}
        {incompatible ? <p class="field-error">This guardian address was used with this Chronobox before and cannot be added again. Use another wallet address.</p> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!tx || incompatible || !!waitProblem} onClick={() => setStage("review")}>
            Continue
          </Button>
          <Button kind="quiet" onClick={() => setStage("who")}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }
  const promise = recovers
    ? recoveryPromise(recoveryWait)
    : { title: "My guardian can stop every withdrawal.", text: "I can remove my guardian only when my guardian lets it happen. My guardian is not a backup. If I lose my wallet, the money in this Chronobox is lost." };
  return (
    <Modal title="Check it" lead={`Check the address of your guardian letter by letter, with your guardian. Until it starts, you can cancel it under "Waiting".`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
      <dl class="wiz-summary">
        <div>
          <dt>Guardian</dt>
          <dd class="mono">{guardian ? <AddressText address={guardian} full /> : null}</dd>
        </div>
        <div>
          <dt>If you lose your wallet</dt>
          <dd>{recovers && recoveryWait !== null ? `Your guardian can bring it back after ${formatDuration(recoveryWait)}` : "Nobody can bring it back"}</dd>
        </div>
        <div>
          <dt>Starts</dt>
          <dd>In {wait}</dd>
        </div>
      </dl>
      <div class="wiz-list">
        <Choice role="checkbox" on={promised} title={promise.title} text={promise.text} disabled={!!action.busy} onClick={() => setPromised(!promised)} />
      </div>
      {recovers && parts && !delayMade ? <p class="hint">Your wallet asks two times. The first makes the line that a recovery waits in.</p> : null}
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!tx || !!problem || incompatible || !promised} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
        <Button
          kind="quiet"
          onClick={() => {
            action.clearError();
            setStage("lost");
          }}
          disabled={!!action.busy}
        >
          Back
        </Button>
      </div>
    </Modal>
  );
}

function ManageSheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  recoveryWaiting: RecoveryWaiting;
  recoveryStarted: boolean;
  onClose: () => void;
  guardian: Address;
  link: string;
  wait: string;
}) {
  const { session, chain, vault, wait } = props;
  const [stage, setStage] = useState<"show" | "recovery" | "remove" | "done" | "unknown">("show");
  const recovery = props.inspection.recovery;
  const action = useAction();
  const tx =
    vault.roles && vault.council && vault.members
      ? removeGuardianTx({
          roles: vault.roles,
          guardian: props.guardian,
          council: vault.council,
          members: vault.members,
          safe: vault.safe,
          recoveryDelay: vault.recoveryDelay,
          recoveryOn: vault.recoveryOn,
        })
      : null;
  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, chain, vault, tx!, waiting);
      setStage(receipt ? "done" : "unknown");
    });
  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "recovery") {
    return <RecoverySheet session={session} chain={chain} vault={vault} inspection={props.inspection} waiting={props.recoveryWaiting} started={props.recoveryStarted} onBack={() => setStage("show")} onClose={props.onClose} />;
  }
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
        <p>
          After it, only your wallet can cancel a withdrawal, and nobody can help you move to a new wallet at once.
          {vault.recoveryOn ? " The recovery goes off with it: after that, nobody can bring this Chronobox back when you lose your wallet." : ""}
        </p>
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!tx} busy={action.busy === "queue"} onClick={submit}>
            {action.busy ? "Confirm in your wallet" : "Start the wait"}
          </Button>
          <Button
            kind="quiet"
            onClick={() => {
              action.clearError();
              setStage("show");
            }}
            disabled={!!action.busy}
          >
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
        <li>
          {recovery
            ? `Can bring this Chronobox back when you lose your wallet: a recovery to a new wallet, which waits ${formatDuration(recovery.wait)} and which you can stop.`
            : "Cannot bring this Chronobox back when you lose your wallet."}
        </li>
        <li>Cannot withdraw.</li>
      </ul>
      <p class="hint">The link for your guardian. It opens this Chronobox for them.</p>
      <CopyLine text={props.link} />
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Done
        </Button>
        <Button kind="quiet" onClick={() => setStage("recovery")}>
          {recovery ? "Recovery" : props.recoveryWaiting ? "Recovery" : "Let my guardian recover"}
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

/** Reads the request from the chain every few seconds: what both sign, and whether the guardian agreed. */
function useSwap(rpc: Rpc, vault: VaultRef, request: { to: Address; upTo: bigint | null }): { swap: Swap; retry: () => void } {
  const [swap, setSwap] = useState<Swap>({ state: "loading" });
  const [round, setRound] = useState(0);
  const reading = useRef(false);
  const { council, guardian, roles, members } = vault;
  const { to, upTo } = request;
  useEffect(() => {
    // A link without a point of the line is from an older version: it cannot be agreed to.
    if (!council || !guardian || !roles || !members || upTo === null) return setSwap({ state: "bad" });
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
        // The change cancels the line up to the point fixed in the request. Both sides build the same
        // transaction from it, whatever the line does meanwhile. What a lost wallet queues after that
        // point is caught after the change (see SwapDoneSheet).
        const tx = councilSwapTx({ ...vault, roles, guardian, council, members }, owners, to, upTo);
        if (!tx) {
          hadAnswer = true;
          return !stale && setSwap({ state: "bad" });
        }
        const hash = await councilHash(rpc, council, tx);
        const agreed = await councilApproved(rpc, council, guardian, hash);
        hadAnswer = true;
        if (!stale) setSwap({ state: "ready", tx, hash, owners, agreed });
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
  }, [rpc, vault.safe, vault.controller, council, guardian, roles, members?.join(","), to, upTo, round]);
  return { swap, retry: () => setRound((r) => r + 1) };
}

/**
 * The first step of the owner: make the shared Safe if nobody has yet. It is one transaction,
 * once. After it, asking the guardian costs the owner nothing.
 */
export async function prepareSwap(session: Session, chain: Chain, vault: VaultRef, waiting: { onSlow: () => void; shouldStop: () => boolean }): Promise<void> {
  const code = (await session.rpc("eth_getCode", [vault.council!, "latest"])) as string;
  if (typeof code === "string" && code.length > 2) return;
  await sendAndWait(session.rpc, session.account, councilCreateTx(vault.safe, vault.controller, vault.guardian!, Boolean(vault.councilRecovery)), { chainId: chain.id, chainName: chain.name, ...waiting });
}

type Line = { state: "loading" } | { state: "error"; message: string } | { state: "read"; txNonce: bigint; queueNonce: bigint; waiting: bigint };

/** What is still in the line of the Delay. Read again on request. */
function useLine(rpc: Rpc, delay: Address, active = true): { line: Line; retry: () => void } {
  const [line, setLine] = useState<Line>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stale = false;
    setLine({ state: "loading" });
    delayNonces(rpc, delay).then(
      ({ txNonce, queueNonce }) => !stale && setLine({ state: "read", txNonce, queueNonce, waiting: queueNonce - txNonce }),
      (e) => !stale && setLine({ state: "error", message: errorText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [rpc, delay, round, active]);
  return { line, retry: () => setRound((r) => r + 1) };
}

type Coverage = { state: "loading" } | { state: "error"; message: string } | { state: "read"; coverage: SwapCoverage };

/** What the request does to the line now, read again on request. */
function useCoverage(rpc: Rpc, delay: Address, upTo: bigint | null): { coverage: Coverage; retry: () => void } {
  const [coverage, setCoverage] = useState<Coverage>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (upTo === null) return;
    let stale = false;
    setCoverage({ state: "loading" });
    readSwapCoverage(rpc, delay, upTo).then(
      (c) => !stale && setCoverage({ state: "read", coverage: c }),
      (e) => !stale && setCoverage({ state: "error", message: errorText(e) }),
    );
    return () => {
      stale = true;
    };
  }, [rpc, delay, upTo, round]);
  return { coverage, retry: () => setRound((r) => r + 1) };
}

/** When an item can run at the earliest, as a time of day for people. */
function runsAtText(runsAt: bigint): string {
  return new Date(Number(runsAt) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * After the change. The change cancels what waited, but something that the lost wallet queued
 * after the owner asked can still be in the line, and it would run after the wait. The guardian
 * may agree with such items left (see swapCoverage): from now on nobody but the new wallet can
 * queue, so one cancel removes them for good. The
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
export function AskGuardianSheet(props: { session: Session; chain: Chain; vault: VaultRef; request: SwapRequest; onDrop: () => void; onClose: () => void }) {
  const { session, chain, vault, request } = props;
  const { to } = request;
  const { swap, retry } = useSwap(session.rpc, vault, request);
  const [done, setDone] = useState(false);
  const action = useAction();
  const link = guardianLink(chain, vault.safe, request);

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
          Change the wallet now: it happens at once. If something was queued after you asked, cancel it with the new wallet afterwards.
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
export function AgreeSheet(props: { session: Session; chain: Chain; vault: VaultRef; request: { to: Address; upTo: bigint | null }; onClose: () => void }) {
  const { session, chain, vault, request } = props;
  const { to } = request;
  const { swap, retry } = useSwap(session.rpc, vault, request);
  const { coverage: read, retry: readLine } = useCoverage(session.rpc, vault.delay, request.upTo);
  // A second, separate read once the change has happened. The read above is from before the
  // agreement: a lost wallet can queue after it and then carry the change out itself.
  const changed = sameAddress(to, vault.controller) || swap.state === "done";
  const { line: after, retry: readAfter } = useLine(session.rpc, vault.delay, changed);
  const [spoke, setSpoke] = useState(false);
  const [sent, setSent] = useState(false);
  const action = useAction();
  const sending = { chainId: chain.id, chainName: chain.name };
  // What the request does to the line now. The link sets its point of the line, and the old wallet
  // can make a link. The guardian agrees when nothing that waits could run soon after the change:
  // what is left must be young, and is cancelled once the change is done (see swapCoverage).
  const coverage = read.state === "read" ? read.coverage : null;
  const clear = () =>
    action.run("clear", async (waiting) => {
      const now = await delayNonces(session.rpc, vault.delay);
      if (now.queueNonce > now.txNonce) await sendAndWait(session.rpc, session.account, cancelTx(vault.roles!, vault.delay, now.queueNonce - 1n), { ...sending, ...waiting });
      readLine();
      if (changed) readAfter();
    });
  const agree = () =>
    action.run("agree", async (waiting) => {
      if (swap.state !== "ready" || request.upTo === null) return;
      // Read again just before agreeing: the line may have changed since the page read it.
      const now = await readSwapCoverage(session.rpc, vault.delay, request.upTo);
      if (now.state !== "ok") {
        readLine();
        throw new Error(now.state === "impossible" ? "This link names a point of the line that does not exist. Ask the owner for a new link." : "A withdrawal waits that could run soon. Cancel everything that waits first.");
      }
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
  if (changed) {
    const waits = after.state === "read" && after.waiting > 0n;
    return (
      <Modal title="It is done." busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <p>
          The wallet <AddressText address={to} /> holds this Chronobox now. You are still its guardian.
        </p>
        {after.state === "loading" ? (
          <p class="muted" role="status">
            Checking that nothing of the old wallet still waits.
          </p>
        ) : after.state === "error" ? (
          <Notice kind="bad">
            We could not read the line: {after.message}{" "}
            <button type="button" class="link-button" onClick={readAfter}>
              Try again
            </button>
          </Notice>
        ) : waits ? (
          <Notice kind="risk" title={after.waiting === 1n ? "One item still waits in the line." : `${after.waiting} items still wait in the line.`}>
            Unless the new wallet queued them, they come from the old wallet, and they run after the wait. Ask the owner, and cancel them if they did not.
          </Notice>
        ) : null}
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        {waits ? (
          <div class="modal-actions">
            <Button kind="primary" busy={action.busy === "clear"} disabled={!!action.busy} onClick={clear}>
              {action.busy === "clear" ? "Confirm in your wallet" : "Cancel everything that waits"}
            </Button>
            <Button kind="quiet" onClick={readAfter} disabled={!!action.busy}>
              Check again
            </Button>
          </div>
        ) : (
          closeOnly
        )}
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
  if (coverage?.state === "impossible") {
    return (
      <Modal title="This link does not fit" onClose={props.onClose}>
        <p>It names a point of the line of this Chronobox that does not exist. Ask the owner for a new link.</p>
        {closeOnly}
      </Modal>
    );
  }
  if (swap.agreed || sent) {
    const left = coverage?.state === "ok" ? coverage.left : 0n;
    return (
      <Modal title="You agreed." onClose={props.onClose}>
        <p>The owner can change the wallet now.</p>
        {left > 0n && coverage?.state === "ok" && coverage.runsAt !== null ? (
          <Notice kind="risk" title={left === 1n ? "One item waits that the change does not cancel." : `${left} items wait that the change does not cancel.`}>
            Keep this page open. Once the owner changed the wallet, it asks you to cancel what is left, and then nobody can queue in its place. Do it before {runsAtText(coverage.runsAt)}.
          </Notice>
        ) : (
          <p class="muted">Once the owner changed the wallet, this page checks that nothing of the old wallet still waits.</p>
        )}
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
      {read.state === "error" ? (
        <Notice kind="bad">
          We could not read the line: {read.message}{" "}
          <button type="button" class="link-button" onClick={readLine}>
            Try again
          </button>{" "}
          You can still cancel everything that waits.
        </Notice>
      ) : coverage?.state === "uncovered" ? (
        <Notice kind="bad" title={coverage.left === 1n ? "One withdrawal waits that this change does not cancel." : `${coverage.left} withdrawals wait that this change does not cancel.`}>
          If the wallet of the owner is lost, they come from the person who has it, and they could run soon after the change. Cancel everything that waits first. It happens at once, and nothing moves.
        </Notice>
      ) : coverage?.state === "ok" && coverage.left > 0n && coverage.runsAt !== null ? (
        <Notice kind="risk" title={coverage.left === 1n ? "One item was queued after the owner asked." : `${coverage.left} items were queued after the owner asked.`}>
          The change does not cancel {coverage.left === 1n ? "it" : "them"}, but {coverage.left === 1n ? "it" : "they"} cannot run before {runsAtText(coverage.runsAt)}. After the change, the old wallet cannot queue or cancel any more, and this page asks you to cancel what is left. You can agree now.
        </Notice>
      ) : coverage?.state === "ok" && coverage.cancels > 0n ? (
        <p class="hint">The change also cancels the {coverage.cancels === 1n ? "withdrawal" : `${coverage.cancels} withdrawals`} that wait now.</p>
      ) : null}
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        {/* Cancelling reads the line itself, so it stays at hand when the check could not be read. */}
        {coverage?.state === "uncovered" || read.state === "error" ? (
          <Button kind="primary" busy={action.busy === "clear"} disabled={!!action.busy} onClick={clear}>
            {action.busy === "clear" ? "Confirm in your wallet" : "Cancel everything that waits"}
          </Button>
        ) : (
          <Button kind="primary" disabled={!spoke || coverage?.state !== "ok"} busy={action.busy === "agree"} onClick={agree}>
            {action.busy ? "Confirm in your wallet" : "Agree"}
          </Button>
        )}
        <Button kind="quiet" onClick={props.onClose} disabled={!!action.busy}>
          Not now
        </Button>
      </div>
    </Modal>
  );
}
