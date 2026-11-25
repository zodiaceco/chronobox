/**
 * The recovery: a way back in when the wallet of a Chronobox is lost. It is a power of the
 * guardian. With it on, the guardian alone can move the Chronobox to a new wallet, and the
 * guardian chooses that wallet when the recovery starts. A recovery waits a long time, and the
 * owner can stop it at once. No money moves.
 *
 * A recovery is never part of the setup. The owner turns it on together with the guardian, or
 * later from the guardian's sheet, and like every change that waits the delay.
 */
import { useEffect, useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { formatDate, formatDuration } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import { calendarFile, download } from "../lib/ics.ts";
import { txCache } from "../lib/store.ts";
import {
  type Inspection,
  type ItemStatus,
  MAX_RECOVERY_WAIT,
  MIN_RECOVERY_WAIT,
  type Receipt,
  type Recovery,
  type RecoveryItem,
  type RecoveryParts,
  Replaced,
  StoppedWaiting,
  type TxRequest,
  cancelAllTx,
  cancelTx,
  councilCompatible,
  councilCreateTx,
  councilOwnersNow,
  delayNonces,
  delayTxHash,
  executeTx,
  itemStatus,
  queueTx,
  queuedInReceipt,
  recoveryDelayCreateTx,
  recoveryTx,
  removeRecoveryTx,
  sendAndWait,
  setRecoveryTx,
  skipExpiredTx,
} from "../lib/chronobox.ts";
import { AddressText, Button, Choice, Modal, Notice, type Session, SlowNote, type Waiting, useAction } from "./common.tsx";
import { UnknownSheet, type VaultRef, queueItem } from "./queue.tsx";

const DAY = 86_400n;
// Plain lengths, without a word on which is better: the owner knows what is right for them.
const WAIT_CHOICES: { label: string; seconds: bigint }[] = [
  { label: "90 days", seconds: 90n * DAY },
  { label: "180 days", seconds: 180n * DAY },
  { label: "365 days", seconds: 365n * DAY },
];

/** A recovery change that is in the line and has not started yet. */
export type RecoveryWaiting = { kind: "set"; wait: bigint } | { kind: "remove" } | null;

export type Guarded = Parameters<typeof setRecoveryTx>[0];

/** The Chronobox with a guardian, in the form that the recovery builders want. Null without a guardian. */
export function guarded(vault: VaultRef): Guarded | null {
  return vault.roles && vault.guardian && vault.council && vault.members ? (vault as Guarded) : null;
}

/** Sends a transaction that is not an item of the line. Null means that the outcome is not known. */
async function send(session: Session, chain: Chain, tx: TxRequest, waiting: Waiting): Promise<Receipt | null> {
  try {
    return await sendAndWait(session.rpc, session.account, tx, { chainId: chain.id, chainName: chain.name, ...waiting });
  } catch (e) {
    if (e instanceof Replaced || e instanceof StoppedWaiting) return null;
    throw e;
  }
}

const hasCode = async (session: Session, address: Address) => {
  const code = (await session.rpc("eth_getCode", [address, "latest"])) as string;
  return typeof code === "string" && code.length > 2;
};

/**
 * The recovery Delay must be there before a step that turns the recovery on can run. Anybody can
 * make it, so this is a transaction of its own, never a part of the step: then nobody can make
 * the step fail by making the Delay first. False means that the outcome is not known.
 */
export async function ensureRecoveryDelay(session: Session, chain: Chain, safe: Address, parts: RecoveryParts | null | undefined, waiting: Waiting): Promise<boolean> {
  if (!parts || parts.deployed || (await hasCode(session, parts.delay))) return true;
  return (await send(session, chain, recoveryDelayCreateTx(safe), waiting)) !== null;
}

/** The shared Safe must be there before a recovery can run. Anybody can make it. False means that the outcome is not known. */
async function ensureCouncil(session: Session, chain: Chain, vault: Guarded, waiting: Waiting): Promise<boolean> {
  if (await hasCode(session, vault.council)) return true;
  return (await send(session, chain, councilCreateTx(vault.safe, vault.controller, vault.guardian, true), waiting)) !== null;
}

const Done = (props: { onClose: () => void }) => (
  <div class="modal-actions">
    <Button kind="primary" onClick={props.onClose}>
      Done
    </Button>
  </div>
);

// ---------------------------------------------------------------------------
// How long a recovery waits
// ---------------------------------------------------------------------------

export type WaitPick = bigint | "custom" | null;

/** The shortest wait for this Chronobox: never shorter than a withdrawal waits. */
const shortestWait = (cooldown: bigint) => (cooldown > MIN_RECOVERY_WAIT ? cooldown : MIN_RECOVERY_WAIT);

/** Starting value for the custom days input: at least the shortest allowed wait. */
export const defaultCustomDays = (cooldown: bigint): string => String(Math.max(120, Number(shortestWait(cooldown) / DAY)));

/** The wait that was picked, or what is wrong with it. */
export function pickedWait(picked: WaitPick, customDays: string, cooldown: bigint): { wait: bigint | null; problem: string | null } {
  if (picked !== "custom") return { wait: picked, problem: null };
  if (customDays.trim() === "") return { wait: null, problem: null };
  const custom = /^\d{1,3}$/.test(customDays) ? BigInt(customDays) * DAY : null;
  const shortest = shortestWait(cooldown);
  const problem =
    custom === null || custom === 0n
      ? "Enter a whole number of days."
      : custom < shortest
        ? `The shortest wait is ${formatDuration(shortest)}.`
        : custom > MAX_RECOVERY_WAIT
          ? `The longest wait is ${formatDuration(MAX_RECOVERY_WAIT)}.`
          : null;
  return { wait: problem ? null : custom, problem };
}

export function WaitPicker(props: {
  picked: WaitPick;
  onPick: (picked: WaitPick) => void;
  customDays: string;
  onCustomDays: (days: string) => void;
  cooldown: bigint;
  disabled: boolean;
}) {
  const { picked, disabled } = props;
  const { problem } = pickedWait(picked, props.customDays, props.cooldown);
  const choices = WAIT_CHOICES.filter((c) => c.seconds >= shortestWait(props.cooldown));
  const note = picked === "custom" ? `In days, from ${shortestWait(props.cooldown) / DAY} to ${MAX_RECOVERY_WAIT / DAY}.` : null;
  // One row of pills, not a list of cards: the wait is a setting, not a promise.
  const pill = (on: boolean, label: string, pick: WaitPick) => (
    <button type="button" role="radio" aria-checked={on} key={label} class={on ? "fund-stop fund-stop-on" : "fund-stop"} disabled={disabled} onClick={() => props.onPick(pick)}>
      {label}
    </button>
  );
  return (
    <>
      <div class="wait-pills" role="radiogroup" aria-label="How long a recovery waits">
        {choices.map((c) => pill(picked === c.seconds, c.label, c.seconds))}
        {pill(picked === "custom", "Other", "custom")}
      </div>
      {note ? <p class="hint">{note}</p> : null}
      {picked === "custom" ? (
        <div class="custom-delay">
          <input class="input" inputMode="numeric" aria-label="Days" disabled={disabled} value={props.customDays} onInput={(event) => props.onCustomDays((event.target as HTMLInputElement).value.trim())} />
          <span class="custom-unit">days</span>
        </div>
      ) : null}
      {problem ? <p class="field-error">{problem}</p> : null}
    </>
  );
}

/**
 * What the owner accepts with a recovery, as one promise: the guardian can take over, and so the owner
 * watches. The same words when the guardian is added, and when the recovery is turned on later.
 */
export function recoveryPromise(wait: bigint | null): { title: string; text: string } {
  const time = wait === null ? "the wait" : formatDuration(wait);
  return {
    title: "My guardian can take over this Chronobox.",
    text: `If I do not stop a recovery within ${time}, the wallet that my guardian chose holds it. So I turn the alerts on, or I look at my Chronobox more often than that.`,
  };
}

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

/** The owner's sheet for the recovery. It opens from the guardian's sheet. */
export function RecoverySheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  waiting: RecoveryWaiting;
  /** True while something waits in the line of the recovery. */
  started: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const { inspection, vault } = props;
  const recovery = inspection.recovery;
  const delay = formatDuration(inspection.cooldown);

  if (props.waiting?.kind === "set") {
    return (
      <Modal title={recovery ? "The wait of a recovery changes soon" : "The recovery goes on soon"} lead={`The wait has started. When it ends, apply it under "Waiting".`} onClose={props.onClose}>
        <p>After that, a recovery waits {formatDuration(props.waiting.wait)}.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  if (props.waiting?.kind === "remove") {
    return (
      <Modal title="The recovery goes off soon" lead={`The wait has started. When it ends, apply it under "Waiting".`} onClose={props.onClose}>
        <p>Until then your guardian can still start a recovery.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }

  const parts = guarded(vault);
  if (!parts) return null;
  return recovery ? <ManageSheet {...props} vault={parts} recovery={recovery} delay={delay} /> : <SetSheet {...props} vault={parts} current={null} delay={delay} />;
}

/** The owner turns the recovery on, or changes how long it waits. */
function SetSheet(props: { session: Session; chain: Chain; vault: Guarded; inspection: Inspection; current: Recovery | null; delay: string; onBack: () => void; onClose: () => void }) {
  const { session, chain, vault, inspection, current } = props;
  const [stage, setStage] = useState<"intro" | "form" | "review" | "done" | "unknown">(current ? "form" : "intro");
  const [picked, setPicked] = useState<WaitPick>(null);
  const [customDays, setCustomDays] = useState(() => defaultCustomDays(inspection.cooldown));
  const [promised, setPromised] = useState(false);
  const [delayMade, setDelayMade] = useState(Boolean(vault.recoveryDelay?.deployed));
  const [incompatible, setIncompatible] = useState(false);
  const action = useAction();
  const { wait } = pickedWait(picked, customDays, inspection.cooldown);
  const same = current !== null && wait === current.wait;
  const tx = wait !== null && !same ? setRecoveryTx(vault, wait) : null;
  const makesDelay = !current && !delayMade;

  useEffect(() => {
    setIncompatible(false);
    if (vault.councilRecovery) return;
    let stale = false;
    councilCompatible(session.rpc, vault.safe, vault.controller, vault.guardian, true).then(
      (ok) => !stale && setIncompatible(!ok),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [vault.councilRecovery, vault.safe, vault.controller, vault.guardian, session.rpc]);

  const submit = () =>
    action.run("queue", async (waiting) => {
      if (!(await ensureRecoveryDelay(session, chain, vault.safe, vault.recoveryDelay, waiting))) return setStage("unknown");
      setDelayMade(true);
      const receipt = await queueItem(session, chain, vault, tx!, waiting);
      setStage(receipt ? "done" : "unknown");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done") {
    return (
      <Modal
        title="The wait has started."
        lead={current ? `In ${props.delay} you can apply the new wait.` : `In ${props.delay} you can switch the recovery on. Tell your guardian what a recovery is for.`}
        onClose={props.onClose}
      >
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  if (stage === "intro") {
    return (
      <Modal title="Let your guardian recover" lead="A way back in when your wallet is lost." onClose={props.onClose}>
        <ul class="plain-list">
          <li>If you lose your wallet, your guardian starts a recovery and enters the address of your new wallet.</li>
          <li>It waits a long time. In that time you can stop it at once.</li>
          <li>After the wait, the new wallet is the key of this Chronobox. No money moves.</li>
        </ul>
        <Notice kind="risk" title="Your guardian chooses the new wallet.">
          If you do not stop a recovery in time, your guardian can take this Chronobox. A good guardian for this is a second device of your own, or the person who gets your money when you are gone.
        </Notice>
        <div class="modal-actions">
          <Button kind="primary" onClick={() => setStage("form")}>
            Choose the wait
          </Button>
          <Button kind="quiet" onClick={props.onBack}>
            Back
          </Button>
        </div>
      </Modal>
    );
  }
  if (stage === "review") {
    const promise = recoveryPromise(wait);
    return (
      <Modal title="Check it" lead={`Check the address of your guardian letter by letter. Until it starts, you and your guardian can stop it.`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <dl class="wiz-summary">
          <div>
            <dt>Guardian</dt>
            <dd class="mono">
              <AddressText address={vault.guardian} full />
            </dd>
          </div>
          <div>
            <dt>{current ? "A recovery will wait" : "If you lose your wallet"}</dt>
            <dd>{current ? formatDuration(wait!) : `Your guardian can bring it back after ${formatDuration(wait!)}`}</dd>
          </div>
          <div>
            <dt>Starts</dt>
            <dd>In {props.delay}</dd>
          </div>
        </dl>
        <div class="wiz-list">
          <Choice role="checkbox" on={promised} title={promise.title} text={promise.text} disabled={!!action.busy} onClick={() => setPromised(!promised)} />
        </div>
        {makesDelay ? <p class="hint">Your wallet asks two times. The first makes the line that a recovery waits in.</p> : null}
        <SlowNote action={action} />
        {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
        <div class="modal-actions">
          <Button kind="primary" disabled={!tx || incompatible || !promised} busy={action.busy === "queue"} onClick={submit}>
            {action.busy ? "Confirm in your wallet" : "Start the wait"}
          </Button>
          <Button
            kind="quiet"
            onClick={() => {
              action.clearError();
              setStage("form");
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
    <Modal
      title="How long a recovery waits"
      lead={`Long enough that you notice it, also when you are away or ill. The change starts after ${props.delay}, like every change here.`}
      onClose={props.onClose}
    >
      <WaitPicker picked={picked} onPick={setPicked} customDays={customDays} onCustomDays={setCustomDays} cooldown={inspection.cooldown} disabled={false} />
      {same ? <p class="field-error">That is the wait now.</p> : null}
      {incompatible ? (
        <Notice kind="bad">
          The shared Safe for a recovery with this wallet and guardian was used before with different owners. Hand over to a new wallet first, or use another guardian.
        </Notice>
      ) : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!tx || incompatible} onClick={() => setStage("review")}>
          Continue
        </Button>
        <Button kind="quiet" onClick={() => (current ? props.onBack() : setStage("intro"))}>
          Back
        </Button>
      </div>
    </Modal>
  );
}

/** The owner looks at the recovery that is on. */
function ManageSheet(props: {
  session: Session;
  chain: Chain;
  vault: Guarded;
  inspection: Inspection;
  recovery: Recovery;
  delay: string;
  started: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const { session, chain, vault, recovery, delay } = props;
  const [stage, setStage] = useState<"show" | "change" | "remove" | "done" | "unknown">("show");
  const action = useAction();
  const tx = removeRecoveryTx(vault);
  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, chain, vault, tx!, waiting);
      setStage(receipt ? "done" : "unknown");
    });
  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "change") return <SetSheet {...props} current={recovery} onBack={() => setStage("show")} />;
  if (stage === "done") {
    return (
      <Modal title="The wait has started." lead={`In ${delay} you can apply it. Until then your guardian can still start a recovery, and can stop this.`} onClose={props.onClose}>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  if (stage === "remove") {
    return (
      <Modal title="Turn the recovery off?" lead={`This waits ${delay}, and your guardian can stop it in that time.`} busy={action.busy !== null && !action.slow} onClose={props.onClose}>
        <p>After it, nobody can bring this Chronobox back when you lose your wallet. Your guardian stays, and can still stop a withdrawal.</p>
        {props.started ? <p class="hint">A recovery waits now. Stop it at the top of this page: that works at once.</p> : null}
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
    <Modal title="Recovery" lead={`Your guardian can bring this Chronobox back. A recovery waits ${formatDuration(recovery.wait)}.`} onClose={props.onClose}>
      <ul class="plain-list">
        <li>Your guardian starts it, and chooses the new wallet.</li>
        <li>You can stop it at once while it waits. So can your guardian.</li>
        <li>After the wait, the new wallet is the key of this Chronobox. No money moves.</li>
      </ul>
      {props.started ? <p class="hint">A recovery waits now. Its state is at the top of this page.</p> : null}
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Done
        </Button>
        <Button kind="quiet" onClick={() => setStage("change")}>
          Change the wait
        </Button>
        <Button kind="quiet" onClick={() => setStage("remove")}>
          Turn it off
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The guardian
// ---------------------------------------------------------------------------

/** The guardian starts a recovery, and chooses the wallet that gets the Chronobox. */
export function StartRecoverySheet(props: { session: Session; chain: Chain; vault: VaultRef; inspection: Inspection; recovery: Recovery; onBack: () => void; onClose: () => void }) {
  const { session, chain, inspection, recovery } = props;
  const vault = guarded(props.vault);
  const [stage, setStage] = useState<"ask" | "done" | "unknown">("ask");
  const [text, setText] = useState("");
  const [sure, setSure] = useState(false);
  const [councilMade, setCouncilMade] = useState(inspection.councilMade);
  const [isContract, setIsContract] = useState(false);
  const action = useAction();
  const wait = formatDuration(recovery.wait);
  const wallet = parseAddress(text);
  // Whether the address can take the Chronobox does not depend on the line. The real step is built when it is sent.
  const possible = vault && wallet ? recoveryTx(vault, [vault.controller, vault.guardian], wallet, 0n) !== null : false;

  useEffect(() => {
    setIsContract(false);
    if (!wallet) return;
    let stale = false;
    hasCode(session, wallet).then(
      (code) => !stale && setIsContract(code),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [wallet, session.rpc]);

  if (!vault) return null;
  const problem =
    text.trim() === ""
      ? null
      : !wallet
        ? "This is not a wallet address."
        : sameAddress(wallet, vault.controller)
          ? "This is the wallet that the Chronobox has now. Enter the new one."
          : sameAddress(wallet, vault.guardian)
            ? "This is your own wallet, the guardian. The new wallet must be another one."
            : sameAddress(wallet, vault.safe)
              ? "This is the address of the Chronobox itself. Enter the address of the new wallet."
              : !possible
                ? "Nobody can sign with this address. Enter the address of a wallet."
                : null;

  const submit = () =>
    action.run("start", async (waiting) => {
      // The recovery takes out what waits in the line of the Chronobox now: the lost wallet may have asked for a withdrawal.
      const [{ queueNonce }, owners] = await Promise.all([delayNonces(session.rpc, vault.delay), councilOwnersNow(session.rpc, vault, councilMade)]);
      const step = recoveryTx(vault, owners, wallet, queueNonce);
      if (!step) throw new Error("This wallet cannot take the Chronobox. Enter another one.");
      if (!(await ensureCouncil(session, chain, vault, waiting))) return setStage("unknown");
      setCouncilMade(true);
      const receipt = await send(session, chain, queueTx(recovery.delay, step), waiting);
      if (receipt) {
        const cache = txCache(chain.id, recovery.delay);
        for (const item of queuedInReceipt(receipt, recovery.delay)) cache.set(item.nonce, delayTxHash(item.tx), item.tx);
      }
      setStage(receipt ? "done" : "unknown");
    });

  if (stage === "unknown") {
    return (
      <Modal title="Look at this page again" onClose={props.onClose}>
        <p>Your wallet sent the request, but this page did not see it arrive. Close this. If a recovery waits, it shows at the top of the page. If it does not show after a few minutes, start it again.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  if (stage === "done") {
    return (
      <Modal title="The recovery waits." lead={`In ${wait} anybody can carry it out, from this page. Until then the owner can stop it, and so can you.`} onClose={props.onClose}>
        <p class="hint">Tell the person who holds the new wallet. After the recovery, that wallet is the key of this Chronobox.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  return (
    <Modal title="Start a recovery?" lead="Only when the owner has lost the wallet of this Chronobox." busy={action.busy !== null && !action.slow} onClose={props.onClose}>
      <ul class="plain-list">
        <li>Talk to the owner first. If they still have their wallet, they do not need this.</li>
        <li>Enter the address of the owner's new wallet on {chain.name}. After the recovery, that wallet is the key of this Chronobox.</li>
        <li>It waits {wait}. The owner can stop it in that time, and so can you. No money moves.</li>
      </ul>
      <input
        class="input"
        placeholder="Address of the new wallet"
        aria-label="Address of the new wallet"
        autocomplete="off"
        spellcheck={false}
        value={text}
        disabled={!!action.busy}
        onInput={(event) => {
          setText((event.target as HTMLInputElement).value);
          setSure(false);
        }}
      />
      {problem ? <p class="field-error">{problem}</p> : null}
      {isContract && !problem ? <p class="hint">This address is a contract, not a plain wallet. That is right only if it is a wallet such as a Safe, and its holder controls it on {chain.name}.</p> : null}
      <div class="wiz-list">
        <Choice
          role="checkbox"
          on={sure}
          title="This is the wallet of the owner, or of the person who takes over for the owner."
          text="I checked the address with them, letter by letter."
          disabled={!!action.busy}
          onClick={() => setSure(!sure)}
        />
      </div>
      <p class="hint">
        Your wallet needs a little {chain.native.symbol} for the fee.{councilMade ? "" : " It asks two times. The first makes the Safe that you share with the owner."}
      </p>
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!wallet || !!problem || !sure} busy={action.busy === "start"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the recovery"}
        </Button>
        <Button
          kind="quiet"
          onClick={() => {
            action.clearError();
            props.onBack();
          }}
          disabled={!!action.busy}
        >
          Back
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// What waits
// ---------------------------------------------------------------------------

/** Calendar reminders for a waiting recovery: ready and expires soon. No address, amount or link. */
function saveRecoveryReminders(nonce: bigint, status: ItemStatus, now: bigint) {
  const base = `chronobox-recovery-${status.readyAt}-${nonce}`;
  const reminders = [
    {
      uid: `${base}-ready@chronobox`,
      at: Number(status.readyAt),
      title: "Chronobox: a recovery is ready",
      description: "The recovery wait has ended. Open the Chronobox to carry it out.",
    },
  ];
  if (status.expiresAt !== null) {
    const before = status.expiresAt - status.readyAt >= 172_800n ? 86_400n : (status.expiresAt - status.readyAt) / 2n;
    reminders.push({
      uid: `${base}-expires@chronobox`,
      at: Number(status.expiresAt - before),
      title: "Chronobox: a recovery expires soon",
      description: `It expires on ${formatDate(status.expiresAt)}. After that a new recovery must start and wait again.`,
    });
  }
  download("chronobox-recovery-reminder.ics", calendarFile(reminders, Number(now)));
}

/**
 * Everything waiting in the line of the recovery, at the top of the page. Always renders when
 * `waitingCount > 0n` (even while reading or if reading failed) so an active recovery is never
 * hidden by an RPC error or masked behind an expired head item.
 */
export function RecoverySection(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  recovery: Recovery;
  items: RecoveryItem[];
  waitingCount: bigint;
  readState: "reading" | "done" | "failed";
  now: bigint;
  role: "owner" | "guardian" | "viewer";
  onChanged: () => void;
}) {
  const { session, chain, recovery, items, waitingCount, readState, role } = props;
  const vault = guarded(props.vault);
  const action = useAction();
  const [unknown, setUnknown] = useState(false);
  const canStop = role !== "viewer" && !!vault;
  const unshown = waitingCount > BigInt(items.length) ? waitingCount - BigInt(items.length) : 0n;

  if (waitingCount === 0n) return null;

  const stopAll = () =>
    action.run("stop-all", async (waiting) => {
      setUnknown(false);
      try {
        const tx = cancelAllTx(vault!.roles, recovery.delay, recovery);
        if (!tx) return;
        const receipt = await send(session, chain, tx, waiting);
        if (!receipt) setUnknown(true);
      } finally {
        props.onChanged();
      }
    });

  return (
    <div class="recovery-list">
      {items.length === 0 ? (
        <Notice kind={role === "owner" ? "risk" : "info"} title={waitingCount === 1n ? "A recovery waits." : `${waitingCount} items wait in the line of the recovery.`}>
          {readState === "failed"
            ? `Its details could not be read from your wallet's network now.${canStop ? " You can still stop it at once." : ""}`
            : "Reading what waits…"}
          {canStop || readState === "failed" ? (
            <div class="notice-actions">
              {canStop ? (
                <Button small kind="primary" busy={action.busy === "stop-all"} disabled={!!action.busy} onClick={stopAll}>
                  {action.busy === "stop-all" ? "Confirm in your wallet" : waitingCount === 1n ? "Stop it" : `Stop all ${waitingCount}`}
                </Button>
              ) : null}
              {readState === "failed" ? (
                <Button small disabled={!!action.busy} onClick={props.onChanged}>
                  Try again
                </Button>
              ) : null}
            </div>
          ) : null}
          <SlowNote action={action} />
          {unknown ? <p class="hint">Your wallet sent or replaced the transaction, but this page did not see it confirm. Look in your wallet and refresh.</p> : null}
          {action.error ? <p class="field-error">{action.error}</p> : null}
        </Notice>
      ) : (
        <>
          {items.map((item, index) => (
            <RecoveryCard
              key={String(item.nonce)}
              session={session}
              chain={chain}
              vault={props.vault}
              recovery={recovery}
              item={item}
              first={index === 0}
              moreAfter={waitingCount > 1n}
              now={props.now}
              role={role}
              onChanged={props.onChanged}
            />
          ))}
          {unshown > 0n ? (
            <Notice kind="risk" title={unshown === 1n ? "1 more item waits in the line of the recovery." : `${unshown} more items wait in the line of the recovery.`}>
              Only the first {items.length} are shown.{canStop ? " You can stop everything in the recovery line at once." : ""}
              {canStop ? (
                <div class="notice-actions">
                  <Button small kind="primary" busy={action.busy === "stop-all"} disabled={!!action.busy} onClick={stopAll}>
                    {action.busy === "stop-all" ? "Confirm in your wallet" : `Stop all ${waitingCount}`}
                  </Button>
                </div>
              ) : null}
              <SlowNote action={action} />
              {unknown ? <p class="hint">Your wallet sent or replaced the transaction, but this page did not see it confirm. Look in your wallet and refresh.</p> : null}
              {action.error ? <p class="field-error">{action.error}</p> : null}
            </Notice>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * One item waiting in the line of the recovery, at the top of the page. Everybody sees it.
 * The owner and the guardian can stop it, and when it is ready anybody can carry it out.
 */
export function RecoveryCard(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  recovery: Recovery;
  item: RecoveryItem;
  first?: boolean;
  moreAfter?: boolean;
  now: bigint;
  role: "owner" | "guardian" | "viewer";
  onChanged: () => void;
}) {
  const { session, chain, recovery, item, role } = props;
  const first = props.first ?? true;
  const moreAfter = props.moreAfter ?? false;
  const vault = guarded(props.vault);
  const action = useAction();
  const [unknown, setUnknown] = useState(false);
  const [confirm, setConfirm] = useState<"stop" | "finish" | null>(null);
  const [leftover, setLeftover] = useState<bigint | null>(null);
  const status: ItemStatus = itemStatus(item, recovery.wait, recovery.expiration, props.now);
  const canStop = role !== "viewer" && !!vault;

  const run = (name: string, work: (waiting: Waiting) => Promise<boolean | void>) =>
    action.run(name, async (waiting) => {
      setUnknown(false);
      let holdRefresh = false;
      try {
        holdRefresh = (await work(waiting)) === true;
      } finally {
        if (!holdRefresh) props.onChanged();
      }
    });

  // Everything in that line goes, not only the first item.
  const doStop = () =>
    run("stop", async (waiting) => {
      setConfirm(null);
      const receipt = await send(session, chain, cancelAllTx(vault!.roles, recovery.delay, recovery) ?? cancelTx(vault!.roles, recovery.delay, item.nonce), waiting);
      if (!receipt) setUnknown(true);
    });
  const clear = () =>
    run("clear", async (waiting) => {
      const receipt = await send(session, chain, skipExpiredTx(recovery.delay), waiting);
      if (!receipt) setUnknown(true);
    });
  const doFinish = () =>
    run("finish", async (waiting) => {
      setConfirm(null);
      if (vault && !(await ensureCouncil(session, chain, vault, waiting))) {
        setUnknown(true);
        return;
      }
      const receipt = await send(session, chain, executeTx(recovery.delay, item.tx!), waiting);
      if (!receipt) {
        setUnknown(true);
        return;
      }
      if (vault) {
        try {
          const line = await delayNonces(session.rpc, vault.delay);
          if (line.queueNonce > line.txNonce) {
            setLeftover(line.queueNonce - line.txNonce);
            return true;
          }
        } catch {
          // Vault refresh below still shows the main queue.
        }
      }
    });

  const onStopClick = () => {
    action.clearError();
    if (role === "guardian") setConfirm("stop");
    else doStop();
  };
  const onFinishClick = () => {
    action.clearError();
    if (role === "owner") setConfirm("finish");
    else doFinish();
  };

  const errors = (
    <>
      <SlowNote action={action} />
      {unknown ? <p class="hint">Your wallet sent or replaced the transaction, but this page did not see it confirm. Look in your wallet and refresh.</p> : null}
      {action.error ? <p class="field-error">{action.error}</p> : null}
    </>
  );

  const modals = (
    <>
      {confirm === "stop" ? (
        <Modal title="Stop the recovery?" lead="Stopping removes the recovery from the line. The elapsed wait is lost, and a new recovery would wait the full time again." onClose={() => setConfirm(null)}>
          <div class="modal-actions">
            <Button kind="primary" onClick={doStop}>
              Stop the recovery
            </Button>
            <Button kind="quiet" onClick={() => setConfirm(null)}>
              Keep it waiting
            </Button>
          </div>
        </Modal>
      ) : null}
      {confirm === "finish" ? (
        <Modal title="Carry out this recovery?" lead="This hands your Chronobox to the new wallet at once. Your current wallet can then do nothing here." onClose={() => setConfirm(null)}>
          {item.wallet ? (
            <p class="big-line">
              <AddressText address={item.wallet} full />
            </p>
          ) : null}
          <div class="modal-actions">
            <Button kind="primary" onClick={doStop}>
              Stop it instead
            </Button>
            <Button kind="quiet" onClick={doFinish}>
              Carry it out
            </Button>
          </div>
        </Modal>
      ) : null}
      {leftover !== null ? (
        <Modal
          title="Not finished: cancel what waits."
          lead="The new wallet holds this Chronobox now. Items that were queued after the recovery started still wait in the main line."
          onClose={() => {
            setLeftover(null);
            props.onChanged();
          }}
        >
          <Notice kind="bad" title={leftover === 1n ? "One item still waits in the line." : `${leftover} items still wait in the line.`}>
            Unless the new wallet queued them, they come from the old wallet and will run after the wait. Cancel them from the main page with the new wallet or the guardian.
          </Notice>
          <div class="modal-actions">
            <Button
              kind="primary"
              onClick={() => {
                setLeftover(null);
                props.onChanged();
              }}
            >
              View waiting items
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );

  if (status.phase === "expired") {
    return (
      <>
        <Notice kind={moreAfter && role === "owner" ? "risk" : "info"} title="A recovery ran out.">
          Nobody carried it out in time. It does nothing now.
          {moreAfter ? " More items wait behind it in the recovery line." : " The guardian can start a new one after this one is cleared."}
          {first || (moreAfter && canStop) ? (
            <div class="notice-actions">
              {first ? (
                <Button small busy={action.busy === "clear"} disabled={!!action.busy} onClick={clear}>
                  {action.busy === "clear" ? "Confirm in your wallet" : "Clear it"}
                </Button>
              ) : null}
              {moreAfter && canStop ? (
                <Button small kind="primary" busy={action.busy === "stop"} disabled={!!action.busy} onClick={doStop}>
                  {action.busy === "stop" ? "Confirm in your wallet" : "Stop all"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {errors}
        </Notice>
        {modals}
      </>
    );
  }

  // Not a recovery as this app makes it for the Chronobox as it is now. It may do nothing, and it may do something else.
  if (!item.wallet || !item.tx) {
    return (
      <>
        <Notice kind="risk" title="Something waits in the line of the recovery.">
          This app cannot tell what it does. It can run from {formatDate(status.readyAt)}. {canStop ? "Stop it, unless you know what it is." : "The owner and the guardian can stop it."}
          {canStop ? (
            <div class="notice-actions">
              <Button small kind="primary" busy={action.busy === "stop"} disabled={!!action.busy} onClick={doStop}>
                {action.busy === "stop" ? "Confirm in your wallet" : "Stop it"}
              </Button>
            </div>
          ) : null}
          {errors}
        </Notice>
        {modals}
      </>
    );
  }

  const mine = sameAddress(item.wallet, session.account);
  const walletNode = mine ? "your wallet" : <>the wallet <AddressText address={item.wallet} /></>;
  const ready = status.phase === "ready";
  const waiting = status.phase === "waiting";
  const title = ready ? "The recovery is ready." : role === "owner" ? "Your guardian started a recovery." : role === "guardian" ? "You started a recovery." : "A recovery waits.";
  const until = ready
    ? first
      ? `Anybody can carry it out now${status.expiresAt ? `, until ${formatDate(status.expiresAt)}` : ""}.`
      : `Ready now, waiting behind an earlier item${status.expiresAt ? ` (until ${formatDate(status.expiresAt)})` : ""}.`
    : `Ready in ${formatDuration(status.readyAt - props.now)}, on ${formatDate(status.readyAt)}.`;
  const showActions = (ready && first) || canStop || waiting;

  return (
    <>
      <Notice kind={role === "owner" ? "risk" : "info"} title={title}>
        <span>
          {until} Then {walletNode}
          {role === "owner" ? ", which your guardian chose," : ""} is the key of this Chronobox.{" "}
          {role === "owner"
            ? "If you still have your wallet, stop it."
            : role === "guardian"
              ? "The owner can stop it until then, and so can you."
              : "The owner and the guardian can stop it until then."}
        </span>
        {showActions ? (
          <div class="notice-actions">
            {ready && first ? (
              <Button small kind={role === "owner" ? "plain" : "primary"} busy={action.busy === "finish"} disabled={!!action.busy} onClick={onFinishClick}>
                {action.busy === "finish" ? "Confirm in your wallet" : "Carry it out"}
              </Button>
            ) : null}
            {canStop ? (
              <Button small kind={role === "owner" ? "primary" : "plain"} busy={action.busy === "stop"} disabled={!!action.busy} onClick={onStopClick}>
                {action.busy === "stop" ? "Confirm in your wallet" : "Stop it"}
              </Button>
            ) : null}
            {waiting ? (
              <Button small kind="plain" disabled={!!action.busy} onClick={() => saveRecoveryReminders(item.nonce, status, props.now)}>
                Add to calendar
              </Button>
            ) : null}
          </div>
        ) : null}
        {errors}
      </Notice>
      {modals}
    </>
  );
}
