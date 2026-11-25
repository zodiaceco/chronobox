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
import { formatDate, formatDuration, shortAddress } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import {
  type Inspection,
  type ItemStatus,
  MAX_RECOVERY_WAIT,
  MIN_RECOVERY_WAIT,
  type Recovery,
  type RecoveryItem,
  type RecoveryParts,
  Replaced,
  StoppedWaiting,
  type TxRequest,
  cancelAllTx,
  cancelTx,
  councilCreateTx,
  councilOwnersNow,
  delayNonces,
  executeTx,
  itemStatus,
  queueTx,
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
const WAIT_CHOICES: { label: string; text: string; seconds: bigint }[] = [
  { label: "90 days", text: "Short. Look at your Chronobox often", seconds: 90n * DAY },
  { label: "180 days", text: "A good start", seconds: 180n * DAY },
  { label: "365 days", text: "The most time to notice", seconds: 365n * DAY },
];

/** A recovery change that is in the line and has not started yet. */
export type RecoveryWaiting = { kind: "set"; wait: bigint } | { kind: "remove" } | null;

export type Guarded = Parameters<typeof setRecoveryTx>[0];

/** The Chronobox with a guardian, in the form that the recovery builders want. Null without a guardian. */
export function guarded(vault: VaultRef): Guarded | null {
  return vault.roles && vault.guardian && vault.council && vault.members ? (vault as Guarded) : null;
}

/** Sends a transaction that is not an item of the line. Null means that the outcome is not known. */
async function send(session: Session, chain: Chain, tx: TxRequest, waiting: Waiting): Promise<boolean | null> {
  try {
    await sendAndWait(session.rpc, session.account, tx, { chainId: chain.id, chainName: chain.name, ...waiting });
    return true;
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
  return (await send(session, chain, recoveryDelayCreateTx(safe), waiting)) === true;
}

/** The shared Safe must be there before a recovery can run. Anybody can make it. False means that the outcome is not known. */
async function ensureCouncil(session: Session, chain: Chain, vault: Guarded, waiting: Waiting): Promise<boolean> {
  if (await hasCode(session, vault.council)) return true;
  return (await send(session, chain, councilCreateTx(vault.safe, vault.controller, vault.guardian, true), waiting)) === true;
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

/** The wait that was picked, or what is wrong with it. */
export function pickedWait(picked: WaitPick, customDays: string, cooldown: bigint): { wait: bigint | null; problem: string | null } {
  if (picked !== "custom") return { wait: picked, problem: null };
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
  return (
    <>
      <div class="wiz-list" role="radiogroup" aria-label="How long a recovery waits">
        {WAIT_CHOICES.filter((c) => c.seconds >= shortestWait(props.cooldown)).map((c) => (
          <Choice key={c.label} role="radio" on={picked === c.seconds} title={c.label} text={c.text} disabled={disabled} onClick={() => props.onPick(c.seconds)} />
        ))}
        <Choice role="radio" on={picked === "custom"} title="Another length" text={`In days, from ${shortestWait(props.cooldown) / DAY} to ${MAX_RECOVERY_WAIT / DAY}`} disabled={disabled} onClick={() => props.onPick("custom")} />
      </div>
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

/** What the owner accepts with a recovery. The same words when the guardian is added, and when it is turned on later. */
export const TAKE_OVER = {
  title: "My guardian can take over this Chronobox.",
  text: "If I do not stop a recovery in that time, the wallet that my guardian chose is its key.",
};

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
  const [stage, setStage] = useState<"intro" | "form" | "done" | "unknown">(current ? "form" : "intro");
  const [picked, setPicked] = useState<WaitPick>(null);
  const [customDays, setCustomDays] = useState("120");
  const [takesOver, setTakesOver] = useState(false);
  const [watches, setWatches] = useState(false);
  const action = useAction();
  const { wait } = pickedWait(picked, customDays, inspection.cooldown);
  const same = current !== null && wait === current.wait;
  const tx = wait !== null && !same ? setRecoveryTx(vault, wait) : null;
  const makesDelay = !current && !vault.recoveryDelay?.deployed;

  const submit = () =>
    action.run("queue", async (waiting) => {
      if (!(await ensureRecoveryDelay(session, chain, vault.safe, vault.recoveryDelay, waiting))) return setStage("unknown");
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
  return (
    <Modal
      title="How long a recovery waits"
      lead={`Long enough that you notice it, also when you are away or ill. The change starts after ${props.delay}, like every change here.`}
      busy={action.busy !== null && !action.slow}
      onClose={props.onClose}
    >
      <WaitPicker picked={picked} onPick={setPicked} customDays={customDays} onCustomDays={setCustomDays} cooldown={inspection.cooldown} disabled={!!action.busy} />
      {same ? <p class="field-error">That is the wait now.</p> : null}
      <div class="wiz-list">
        <Choice role="checkbox" on={takesOver} title={TAKE_OVER.title} text={TAKE_OVER.text} disabled={!!action.busy} onClick={() => setTakesOver(!takesOver)} />
        <Choice
          role="checkbox"
          on={watches}
          title="I will notice a recovery."
          text="I turn the alerts on, or I look at my Chronobox more often than a recovery waits."
          disabled={!!action.busy}
          onClick={() => setWatches(!watches)}
        />
      </div>
      {makesDelay ? <p class="hint">Your wallet asks two times. The first makes the line that a recovery waits in.</p> : null}
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!tx || !takesOver || !watches} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
        <Button kind="quiet" onClick={current ? props.onBack : () => setStage("intro")} disabled={!!action.busy}>
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
          <Button kind="quiet" onClick={() => setStage("show")} disabled={!!action.busy}>
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
      const [{ queueNonce }, owners] = await Promise.all([delayNonces(session.rpc, vault.delay), councilOwnersNow(session.rpc, vault, inspection.councilMade)]);
      const step = recoveryTx(vault, owners, wallet, queueNonce);
      if (!step) throw new Error("This wallet cannot take the Chronobox. Enter another one.");
      if (!(await ensureCouncil(session, chain, vault, waiting))) return setStage("unknown");
      const sent = await send(session, chain, queueTx(recovery.delay, step), waiting);
      setStage(sent ? "done" : "unknown");
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
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
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
        Your wallet needs a little {chain.native.symbol} for the fee.{inspection.councilMade ? "" : " It asks two times. The first makes the Safe that you share with the owner."}
      </p>
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!wallet || !!problem || !sure} busy={action.busy === "start"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the recovery"}
        </Button>
        <Button kind="quiet" onClick={props.onBack} disabled={!!action.busy}>
          Back
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// What waits
// ---------------------------------------------------------------------------

/**
 * What waits in the line of the recovery, at the top of the page. Everybody sees it. The owner
 * and the guardian can stop it, and when it is ready anybody can carry it out.
 */
export function RecoveryCard(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  recovery: Recovery;
  item: RecoveryItem;
  now: bigint;
  role: "owner" | "guardian" | "viewer";
  onChanged: () => void;
}) {
  const { session, chain, recovery, item, role } = props;
  const vault = guarded(props.vault);
  const action = useAction();
  const status: ItemStatus = itemStatus(item, recovery.wait, recovery.expiration, props.now);
  const canStop = role !== "viewer" && !!vault;
  const run = (name: string, work: (waiting: Waiting) => Promise<unknown>) =>
    action.run(name, async (waiting) => {
      try {
        await work(waiting);
      } finally {
        props.onChanged();
      }
    });
  // Everything in that line goes, not only the first item.
  const stop = () => run("stop", (waiting) => send(session, chain, cancelAllTx(vault!.roles, recovery.delay, recovery) ?? cancelTx(vault!.roles, recovery.delay, item.nonce), waiting));
  const clear = () => run("clear", (waiting) => send(session, chain, skipExpiredTx(recovery.delay), waiting));
  const finish = () =>
    run("finish", async (waiting) => {
      if (vault && !(await ensureCouncil(session, chain, vault, waiting))) return;
      await send(session, chain, executeTx(recovery.delay, item.tx!), waiting);
    });
  const errors = (
    <>
      <SlowNote action={action} />
      {action.error ? <p class="field-error">{action.error}</p> : null}
    </>
  );

  if (status.phase === "expired") {
    return (
      <Notice kind="info" title="A recovery ran out.">
        Nobody carried it out in time. It does nothing now. The guardian can start a new one after this one is cleared.
        <div class="notice-actions">
          <Button small busy={action.busy === "clear"} disabled={!!action.busy} onClick={clear}>
            Clear it
          </Button>
        </div>
        {errors}
      </Notice>
    );
  }

  // Not a recovery as this app makes it for the Chronobox as it is now. It may do nothing, and it may do something else.
  if (!item.wallet || !item.tx) {
    return (
      <Notice kind="risk" title="Something waits in the line of the recovery.">
        This app cannot tell what it does. It can run from {formatDate(status.readyAt)}. {canStop ? "Stop it, unless you know what it is." : "The owner and the guardian can stop it."}
        {canStop ? (
          <div class="notice-actions">
            <Button small kind="primary" busy={action.busy === "stop"} disabled={!!action.busy} onClick={stop}>
              Stop it
            </Button>
          </div>
        ) : null}
        {errors}
      </Notice>
    );
  }

  const mine = sameAddress(item.wallet, session.account);
  const wallet = mine ? "your wallet" : `the wallet ${shortAddress(item.wallet)}`;
  const ready = status.phase === "ready";
  const title = ready ? "The recovery is ready." : role === "owner" ? "Your guardian started a recovery." : role === "guardian" ? "You started a recovery." : "A recovery waits.";
  const until = ready ? `Anybody can carry it out now${status.expiresAt ? `, until ${formatDate(status.expiresAt)}` : ""}.` : `On ${formatDate(status.readyAt)} anybody can carry it out.`;
  const text =
    role === "owner"
      ? `${until} Then ${wallet}, which your guardian chose, is the key of this Chronobox. If you still have your wallet, stop it.`
      : role === "guardian"
        ? `${until} Then ${wallet} is the key of this Chronobox. The owner can stop it until then, and so can you.`
        : `${until} Then ${wallet} is the key of this Chronobox. The owner and the guardian can stop it until then.`;
  return (
    <Notice kind={role === "owner" ? "risk" : "info"} title={title}>
      {text}
      <div class="notice-actions">
        {ready ? (
          <Button small kind={role === "owner" ? "plain" : "primary"} busy={action.busy === "finish"} disabled={!!action.busy} onClick={finish}>
            Carry it out
          </Button>
        ) : null}
        {canStop ? (
          <Button small kind={role === "owner" ? "primary" : "plain"} busy={action.busy === "stop"} disabled={!!action.busy} onClick={stop}>
            Stop it
          </Button>
        ) : null}
      </div>
      {errors}
    </Notice>
  );
}
