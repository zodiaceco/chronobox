/**
 * The recovery: a way back in when the wallet of a Chronobox is lost. The owner sets a recovery
 * wallet and a wait. The guardian can start the recovery, the owner can stop it while it waits,
 * and when the wait is over the Chronobox goes to the recovery wallet. No money moves.
 *
 * A recovery is never part of the setup. It needs a guardian, and like every change it is set
 * from the page of a finished Chronobox and waits the delay.
 */
import { useEffect, useState } from "preact/hooks";
import type { Chain } from "../lib/chains.ts";
import { formatDate, formatDuration, shortAddress } from "../lib/format.ts";
import { type Address, parseAddress, sameAddress } from "../lib/hex.ts";
import {
  type Inspection,
  type ItemStatus,
  MAX_RECOVERY_WAIT,
  MIN_COOLDOWN,
  type Recovery,
  type RecoveryItem,
  Replaced,
  StoppedWaiting,
  type TxRequest,
  cancelTx,
  executeTx,
  itemStatus,
  removeRecoveryTx,
  sendAndWait,
  setRecoveryTx,
  skipExpiredTx,
  startRecoveryTx,
} from "../lib/chronobox.ts";
import { AddressText, Button, Choice, Modal, Notice, type Session, SlowNote, type Waiting, useAction } from "./common.tsx";
import { UnknownSheet, type VaultRef, queueItem } from "./queue.tsx";

const DAY = 86_400n;
const WAIT_CHOICES: { label: string; text: string; seconds: bigint }[] = [
  { label: "30 days", text: "Short. Look at your Chronobox often", seconds: 30n * DAY },
  { label: "90 days", text: "A good start", seconds: 90n * DAY },
  { label: "180 days", text: "The most time to notice", seconds: 180n * DAY },
];

/** A recovery change that is in the line and has not started yet. */
export type RecoveryWaiting = { kind: "set"; wallet: Address; wait: bigint } | { kind: "remove" } | null;

type Guarded = Parameters<typeof setRecoveryTx>[0];

/** The Chronobox with a guardian, in the form that the recovery builders want. Null without a guardian. */
function guarded(vault: VaultRef): Guarded | null {
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

const Done = (props: { onClose: () => void }) => (
  <div class="modal-actions">
    <Button kind="primary" onClick={props.onClose}>
      Done
    </Button>
  </div>
);

/** The row "Recovery" opens this. What it shows depends on who looks, and on what is set. */
export function RecoverySheet(props: {
  session: Session;
  chain: Chain;
  vault: VaultRef;
  inspection: Inspection;
  role: "owner" | "guardian" | "viewer";
  waiting: RecoveryWaiting;
  /** A guardian that is in the line and has not started yet. */
  guardianWaiting: boolean;
  /** True while something waits in the line of the recovery. */
  started: boolean;
  onGuardian: () => void;
  onClose: () => void;
}) {
  const { inspection, vault } = props;
  const recovery = inspection.recovery;
  const delay = formatDuration(inspection.cooldown);

  if (props.role !== "owner") {
    if (!recovery) {
      return (
        <Modal title="Recovery" onClose={props.onClose}>
          <p>The owner of this Chronobox has not set a recovery. If the owner loses the wallet, nobody can get the money out.</p>
          <Done onClose={props.onClose} />
        </Modal>
      );
    }
    if (props.role === "guardian" && recovery.fits && !props.started) return <StartSheet {...props} recovery={recovery} />;
    const mine = sameAddress(recovery.wallet, props.session.account);
    return (
      <Modal title="Recovery" onClose={props.onClose}>
        <p>
          {mine ? "Your wallet is the recovery wallet of this Chronobox." : "This Chronobox has a recovery."} The guardian can start it. After{" "}
          {formatDuration(recovery.wait)} the Chronobox goes to the recovery wallet <AddressText address={recovery.wallet} />. The owner can stop it in that time.
        </p>
        {!recovery.fits ? <Notice kind="risk">The owner changed the wallet or the guardian after this recovery was set. It does nothing until the owner sets it again.</Notice> : null}
        {props.started ? <p class="hint">A recovery waits now. Its state is at the top of this page.</p> : null}
        <Done onClose={props.onClose} />
      </Modal>
    );
  }

  if (!inspection.guardian) {
    return (
      <Modal title="Recovery" lead="A way back in when your wallet is lost." onClose={props.onClose}>
        <ul class="plain-list">
          <li>You choose a recovery wallet: a second key of yours that you keep in another place.</li>
          <li>If you lose your wallet, your guardian starts the recovery. After a long wait, your Chronobox goes to the recovery wallet.</li>
          <li>While it waits you can stop it. Your guardian can never choose where your Chronobox goes.</li>
        </ul>
        <p class="hint">{props.guardianWaiting ? "Your guardian starts soon. Come back here after that." : "A recovery needs a guardian to start it. Add a guardian first."}</p>
        <div class="modal-actions">
          {props.guardianWaiting ? (
            <Button kind="primary" onClick={props.onClose}>
              Done
            </Button>
          ) : (
            <Button kind="primary" onClick={props.onGuardian}>
              Add a guardian
            </Button>
          )}
        </div>
      </Modal>
    );
  }

  if (props.waiting?.kind === "set") {
    return (
      <Modal title="Your recovery starts soon" lead={`The wait has started. When it ends, apply it under "Waiting".`} onClose={props.onClose}>
        <p>
          Recovery wallet: <AddressText address={props.waiting.wallet} full />
        </p>
        <p>A recovery waits {formatDuration(props.waiting.wait)}.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  if (props.waiting?.kind === "remove") {
    return (
      <Modal title="Your recovery goes off soon" lead={`The wait has started. When it ends, apply it under "Waiting".`} onClose={props.onClose}>
        <p>Until then your guardian can still start a recovery.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }

  const parts = guarded(vault);
  if (!parts) return null;
  return recovery ? <ManageSheet {...props} vault={parts} recovery={recovery} delay={delay} /> : <SetSheet {...props} vault={parts} current={null} delay={delay} onBack={null} />;
}

/** The owner sets the recovery, or changes it. */
function SetSheet(props: {
  session: Session;
  chain: Chain;
  vault: Guarded;
  inspection: Inspection;
  current: Recovery | null;
  delay: string;
  onBack: (() => void) | null;
  onClose: () => void;
}) {
  const { session, chain, vault, inspection, current } = props;
  const [stage, setStage] = useState<"intro" | "form" | "done" | "unknown">(current ? "form" : "intro");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<bigint | "custom" | null>(null);
  const [customDays, setCustomDays] = useState("60");
  const [keeps, setKeeps] = useState(false);
  const [watches, setWatches] = useState(false);
  const [isContract, setIsContract] = useState(false);
  const action = useAction();
  const wallet = parseAddress(text);

  const custom = /^\d{1,3}$/.test(customDays) ? BigInt(customDays) * DAY : null;
  const shortest = inspection.cooldown > MIN_COOLDOWN ? inspection.cooldown : MIN_COOLDOWN;
  const waitProblem =
    picked !== "custom"
      ? null
      : custom === null || custom === 0n
        ? "Enter a whole number of days."
        : custom < shortest
          ? `A recovery waits at least as long as a withdrawal: ${formatDuration(shortest)}.`
          : custom > MAX_RECOVERY_WAIT
            ? `The longest wait is ${formatDuration(MAX_RECOVERY_WAIT)}.`
            : null;
  const wait = picked === "custom" ? (waitProblem ? null : custom) : picked;
  const tx = wallet && wait !== null ? setRecoveryTx(vault, wallet, wait) : null;
  // The address alone decides whether it can be a recovery wallet. The wait does not.
  const possible = wallet ? setRecoveryTx(vault, wallet, 90n * DAY) !== null : false;

  useEffect(() => {
    setIsContract(false);
    if (!wallet) return;
    let stale = false;
    session.rpc("eth_getCode", [wallet, "latest"]).then(
      (code: string) => !stale && setIsContract(typeof code === "string" && code.length > 2),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [wallet, session.rpc]);

  const problem =
    text.trim() === ""
      ? null
      : !wallet
        ? "This is not a wallet address."
        : sameAddress(wallet, vault.controller)
          ? "This is the wallet of this Chronobox. A recovery wallet is another wallet."
          : sameAddress(wallet, vault.guardian)
            ? "This is your guardian's wallet. Your guardian starts the recovery, so the recovery wallet must be another one."
            : sameAddress(wallet, vault.safe)
              ? "This is the address of the Chronobox itself. Enter the address of your recovery wallet."
              : !possible
                ? "Nobody can sign with this address. Enter the address of a wallet."
                : current && sameAddress(wallet, current.wallet) && wait === current.wait && current.fits
                  ? "That is the recovery now."
                  : null;

  const submit = () =>
    action.run("queue", async (waiting) => {
      const receipt = await queueItem(session, chain, vault, tx!, waiting);
      setStage(receipt ? "done" : "unknown");
    });

  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done") {
    return (
      <Modal
        title="The wait has started."
        lead={`In ${props.delay} you can switch your recovery on. Tell your guardian that they can start it when you have lost your wallet.`}
        onClose={props.onClose}
      >
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  if (stage === "intro") {
    return (
      <Modal title="Set a recovery" lead="A way back in when your wallet is lost." onClose={props.onClose}>
        <ul class="plain-list">
          <li>You choose a recovery wallet: a second key of yours that you keep in another place.</li>
          <li>If you lose your wallet, your guardian starts the recovery. After a long wait, your Chronobox goes to the recovery wallet.</li>
          <li>While it waits you can stop it. Your guardian can never choose where your Chronobox goes, and no money moves.</li>
        </ul>
        <p class="hint">The recovery wallet alone can do nothing. It gets your Chronobox only after a recovery that nobody stopped.</p>
        <div class="modal-actions">
          <Button kind="primary" onClick={() => setStage("form")}>
            Choose my recovery wallet
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={current ? "Change the recovery" : "Your recovery wallet"}
      lead={`Paste the address of a wallet of yours on ${chain.name} that is not this one. The change starts after ${props.delay}, like every change here.`}
      busy={action.busy !== null && !action.slow}
      onClose={props.onClose}
    >
      <input
        class="input"
        placeholder="Address of your recovery wallet"
        aria-label="Address of your recovery wallet"
        autocomplete="off"
        spellcheck={false}
        value={text}
        disabled={!!action.busy}
        onInput={(event) => setText((event.target as HTMLInputElement).value)}
      />
      {problem ? <p class="field-error">{problem}</p> : null}
      {isContract && !problem ? <p class="hint">This address is a contract, not a plain wallet. That is right only if it is a wallet such as a Safe, and you control it on {chain.name}.</p> : null}
      <p class="field-label">How long a recovery waits</p>
      <div class="wiz-list" role="radiogroup" aria-label="How long a recovery waits">
        {WAIT_CHOICES.filter((c) => c.seconds >= shortest).map((c) => (
          <Choice key={c.label} role="radio" on={picked === c.seconds} title={c.label} text={c.text} disabled={!!action.busy} onClick={() => setPicked(c.seconds)} />
        ))}
        <Choice role="radio" on={picked === "custom"} title="Another length" text="In days, up to 365" disabled={!!action.busy} onClick={() => setPicked("custom")} />
      </div>
      {picked === "custom" ? (
        <div class="custom-delay">
          <input class="input" inputMode="numeric" aria-label="Days" disabled={!!action.busy} value={customDays} onInput={(event) => setCustomDays((event.target as HTMLInputElement).value.trim())} />
          <span class="custom-unit">days</span>
        </div>
      ) : null}
      {waitProblem ? <p class="field-error">{waitProblem}</p> : null}
      <div class="wiz-list">
        <Choice
          role="checkbox"
          on={keeps}
          title="I keep the recovery wallet safe, and away from my wallet."
          text="It is my second key. If I lose both, the money in this Chronobox is lost."
          disabled={!!action.busy}
          onClick={() => setKeeps(!keeps)}
        />
        <Choice
          role="checkbox"
          on={watches}
          title="My guardian can start a recovery at any time."
          text="I look at my Chronobox, or I turn the alerts on, so that I can stop one that I did not ask for."
          disabled={!!action.busy}
          onClick={() => setWatches(!watches)}
        />
      </div>
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!tx || !!problem || !keeps || !watches} busy={action.busy === "queue"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the wait"}
        </Button>
        <Button kind="quiet" onClick={props.onBack ?? (() => setStage("intro"))} disabled={!!action.busy}>
          Back
        </Button>
      </div>
    </Modal>
  );
}

/** The owner looks at the recovery that is on. */
function ManageSheet(props: { session: Session; chain: Chain; vault: Guarded; inspection: Inspection; recovery: Recovery; delay: string; started: boolean; onClose: () => void }) {
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
    <Modal title="Your recovery" onClose={props.onClose}>
      {!recovery.fits ? (
        <Notice kind="risk" title="Set your recovery again.">
          The wallet or the guardian of this Chronobox changed after you set it. As it is, a recovery does nothing.
        </Notice>
      ) : null}
      <p class="hint">Recovery wallet</p>
      <p class="big-line">
        <AddressText address={recovery.wallet} full />
      </p>
      <ul class="plain-list">
        <li>Your guardian can start a recovery. It waits {formatDuration(recovery.wait)}.</li>
        <li>You can stop it while it waits.</li>
        <li>Then this Chronobox goes to your recovery wallet. No money moves, and your guardian gets nothing.</li>
      </ul>
      {props.started ? <p class="hint">A recovery waits now. Its state is at the top of this page.</p> : null}
      <div class="modal-actions">
        <Button kind="primary" onClick={props.onClose}>
          Done
        </Button>
        <Button kind="quiet" onClick={() => setStage("change")}>
          {recovery.fits ? "Change it" : "Set it again"}
        </Button>
        <Button kind="quiet" onClick={() => setStage("remove")}>
          Turn it off
        </Button>
      </div>
    </Modal>
  );
}

/** The guardian starts the recovery. */
function StartSheet(props: { session: Session; chain: Chain; vault: VaultRef; recovery: Recovery; onClose: () => void }) {
  const { session, chain, vault, recovery } = props;
  const [stage, setStage] = useState<"ask" | "done" | "unknown">("ask");
  const [asked, setAsked] = useState(false);
  const action = useAction();
  const wait = formatDuration(recovery.wait);
  const submit = () =>
    action.run("start", async (waiting) => {
      const sent = await send(session, chain, startRecoveryTx(vault.roles!, recovery), waiting);
      setStage(sent ? "done" : "unknown");
    });
  if (stage === "unknown") return <UnknownSheet onClose={props.onClose} />;
  if (stage === "done") {
    return (
      <Modal title="The recovery waits." lead={`In ${wait} anybody can carry it out, from this page. Until then the owner can stop it.`} onClose={props.onClose}>
        <p class="hint">Tell the person who holds the recovery wallet. After the recovery, that wallet is the key of this Chronobox.</p>
        <Done onClose={props.onClose} />
      </Modal>
    );
  }
  return (
    <Modal title="Start the recovery?" lead="Only when the owner has lost the wallet of this Chronobox." busy={action.busy !== null && !action.slow} onClose={props.onClose}>
      <ul class="plain-list">
        <li>Talk to the owner first. If they still have their wallet, they do not need this.</li>
        <li>It waits {wait}. The owner can stop it in that time.</li>
        <li>
          Then this Chronobox goes to the recovery wallet <AddressText address={recovery.wallet} />, which the owner chose. No money moves, and you get nothing.
        </li>
      </ul>
      <div class="wiz-list">
        <Choice
          role="checkbox"
          on={asked}
          title="The owner asked me to, or I cannot reach the owner."
          text={`Your wallet needs a little ${chain.native.symbol} for the fee.`}
          disabled={!!action.busy}
          onClick={() => setAsked(!asked)}
        />
      </div>
      <SlowNote action={action} />
      {action.error ? <Notice kind="bad">{action.error}</Notice> : null}
      <div class="modal-actions">
        <Button kind="primary" disabled={!asked} busy={action.busy === "start"} onClick={submit}>
          {action.busy ? "Confirm in your wallet" : "Start the recovery"}
        </Button>
        <Button kind="quiet" onClick={props.onClose} disabled={!!action.busy}>
          Not now
        </Button>
      </div>
    </Modal>
  );
}

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
  const { session, chain, vault, recovery, item, role } = props;
  const action = useAction();
  const status: ItemStatus = itemStatus(item, recovery.wait, recovery.expiration, props.now);
  const canStop = role !== "viewer" && !!vault.roles;
  const wallet = shortAddress(recovery.wallet);
  const run = (name: string, tx: TxRequest) =>
    action.run(name, async (waiting) => {
      await send(session, chain, tx, waiting);
      props.onChanged();
    });
  const stop = () => run("stop", cancelTx(vault.roles!, recovery.delay, item.nonce));

  // Something in that line that is not the recovery of now: an old one, or one that this app did not make.
  if (!item.isRecovery || !recovery.fits) {
    return (
      <Notice kind="risk" title="Something waits in the recovery line that does nothing now.">
        It was started for a recovery that is no longer set. It cannot move this Chronobox.
        {canStop ? (
          <div class="notice-actions">
            <Button small busy={action.busy === "stop"} onClick={stop}>
              Clear it
            </Button>
          </div>
        ) : null}
        <SlowNote action={action} />
        {action.error ? <p class="field-error">{action.error}</p> : null}
      </Notice>
    );
  }

  const title = status.phase === "waiting" ? "A recovery waits." : status.phase === "ready" ? "The recovery is ready." : "A recovery ran out.";
  const text =
    status.phase === "expired"
      ? "Nobody carried it out in time. It does nothing now. The guardian can start a new one."
      : status.phase === "ready"
        ? `Anybody can carry it out now${status.expiresAt ? `, until ${formatDate(status.expiresAt)}` : ""}. Then the wallet ${wallet} is the key of this Chronobox.`
        : role === "owner"
          ? `Your guardian started it. On ${formatDate(status.readyAt)} this Chronobox goes to your recovery wallet ${wallet}. If you still have this wallet, stop it.`
          : role === "guardian"
            ? `You started it. On ${formatDate(status.readyAt)} anybody can carry it out. Then the wallet ${wallet} is the key of this Chronobox. The owner can stop it until then.`
            : `The guardian started it. On ${formatDate(status.readyAt)} this Chronobox goes to the recovery wallet ${wallet}. The owner can stop it until then.`;
  return (
    <Notice kind={role === "owner" && status.phase !== "expired" ? "risk" : "info"} title={title}>
      {text}
      <div class="notice-actions">
        {status.phase === "ready" ? (
          <Button small kind={role === "owner" ? "plain" : "primary"} busy={action.busy === "finish"} disabled={!!action.busy} onClick={() => run("finish", executeTx(recovery.delay, recovery.batch))}>
            Carry it out
          </Button>
        ) : null}
        {status.phase === "expired" ? (
          <Button small busy={action.busy === "clear"} disabled={!!action.busy} onClick={() => run("clear", skipExpiredTx(recovery.delay))}>
            Clear it
          </Button>
        ) : canStop ? (
          <Button small kind={role === "owner" ? "primary" : "plain"} busy={action.busy === "stop"} disabled={!!action.busy} onClick={stop}>
            Stop it
          </Button>
        ) : null}
      </div>
      <SlowNote action={action} />
      {action.error ? <p class="field-error">{action.error}</p> : null}
    </Notice>
  );
}
