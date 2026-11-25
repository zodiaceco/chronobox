// What a request does, in the words of the Chronobox app.
import {
  APPROVE_SELECTOR, DELAY_FUNCTIONS, NATIVE_SYMBOLS, ROLES_FUNCTIONS, SAFE_FUNCTIONS, SEL, strip, toAddr, toBig, word,
} from './chain.ts';
import { fmtDuration, fmtUnits, shortAddr } from './format.ts';
import type { Kind } from './types.ts';

export type TokenMeta = { symbol: string; decimals: number } | null;
export type DescribeCtx = {
  chainId: number;
  delay: string;
  vault: string;
  controllers: string[];
  roles?: string;
  /** The delay of the vault now, in seconds. */
  cooldown?: bigint;
  /** The Recovery Delay of the vault, and how long a recovery waits now. Only known with CHRONOBOX. */
  recoveryDelay?: string;
  recoveryWait?: bigint;
  tokenMeta?: TokenMeta;
};

function argsText(sig: string, data: string): string {
  const types = sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean);
  const body = strip(data).slice(8);
  const out: string[] = [];
  types.forEach((t, i) => {
    const w = body.slice(i * 64, (i + 1) * 64);
    if (w.length < 64) return;
    if (t === 'address') out.push(toAddr(w));
    else out.push(toBig(w).toString());
  });
  return out.join(', ');
}

// The contract that the Chronobox app uses to make several changes in one step, and what the app puts in it.
const MULTI_SEND = '0x38869bf66a61cf6bdb996a6ae40d5853fd43b526';
const MULTI_SEND_SELECTOR = '8d80ff0a'; // multiSend(bytes)
const ENABLE_MODULE = '0x610b5925';
const DISABLE_MODULE = '0xe009cfde';
const SET_TX_COOLDOWN = '0xebb2b4a2';
const ASSIGN_ROLES = '0x957ed2b3'; // assignRoles(address,bytes32[],bool[])
const SET_RECOVERY_WAIT = SET_TX_COOLDOWN;
const CANCEL_ROLE = '63616e63656c'.padEnd(64, '0'); // bytes32("cancel")

/** The calls of a MultiSend batch. Null when the transaction is not a batch of plain calls that send no coin. */
export function batchCalls(tx: { to: string; value: bigint; data: string; operation: number }): { to: string; data: string }[] | null {
  if (tx.operation !== 1 || tx.to.toLowerCase() !== MULTI_SEND || tx.value !== 0n) return null;
  const d = strip(tx.data.toLowerCase());
  if (d.slice(0, 8) !== MULTI_SEND_SELECTOR) return null;
  const body = d.slice(8);
  const off = Number(toBig(body.slice(0, 64))) * 2;
  const len = Number(toBig(body.slice(off, off + 64)));
  if (!(len > 0 && len <= 100000)) return null;
  const bytes = body.slice(off + 64, off + 64 + len * 2);
  if (bytes.length !== len * 2) return null;
  const calls: { to: string; data: string }[] = [];
  for (let at = 0; at < bytes.length; ) {
    if (bytes.length - at < 170 || calls.length >= 50) return null;
    const length = Number(toBig(bytes.slice(at + 106, at + 170)));
    // Each item: operation (1 byte, 0 = call), to (20), value (32), length (32), data.
    if (bytes.slice(at, at + 2) !== '00' || toBig(bytes.slice(at + 42, at + 106)) !== 0n) return null;
    if (!(length <= 100000) || bytes.length < at + 170 + length * 2) return null;
    calls.push({ to: '0x' + bytes.slice(at + 2, at + 42), data: '0x' + bytes.slice(at + 170, at + 170 + length * 2) });
    at += 170 + length * 2;
  }
  return calls;
}

/** assignRoles(module, roleKeys, memberOf): who gets or loses which role. */
function decodeAssign(data: string): { module: string; grants: { key: string; on: boolean }[] } | null {
  const b = strip(data).slice(8);
  const keysAt = Number(toBig(b.slice(64, 128))) * 2;
  const boolsAt = Number(toBig(b.slice(128, 192))) * 2;
  const n = Number(toBig(b.slice(keysAt, keysAt + 64)));
  if (!(n >= 1 && n <= 10) || Number(toBig(b.slice(boolsAt, boolsAt + 64))) !== n) return null;
  const grants: { key: string; on: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const key = b.slice(keysAt + 64 + i * 64, keysAt + 128 + i * 64);
    const on = b.slice(boolsAt + 64 + i * 64, boolsAt + 128 + i * 64);
    if (key.length !== 64 || on.length !== 64) return null;
    grants.push({ key, on: toBig(on) !== 0n });
  }
  return { module: toAddr(b.slice(0, 64)), grants };
}

// A change that is read from its shape, not proved. The app checks it byte for byte.
const LOOKS = 'Open your Chronobox to check that the request is what it looks like.';
const NOT_THE_APP = 'The Chronobox app does not make such a request.';

/** What a call on a part of the Chronobox does, in one plain sentence. `a`: its first address, `b`: its second. */
function meaning(part: 'delay' | 'vault' | 'roles' | 'recovery', fn: string | undefined, a: string, b: string, data: string): string {
  const name = fn ? fn.slice(0, fn.indexOf('(')) : '';
  if (part === 'roles') return 'It changes who can cancel, or what they can do.';
  if (part === 'recovery') {
    if (name === 'enableModule') return `It lets ${a} start a recovery: a change of the wallet of this Chronobox after a wait.`;
    return 'It changes the recovery of this Chronobox.';
  }
  if (part === 'delay') {
    if (name === 'disableModule') return `It takes this Chronobox away from the wallet ${b}.`;
    if (name === 'setTxExpiration') {
      const v = toBig(strip(data).slice(8, 72));
      return `It changes how long a request stays open after its wait: ${v === 0n ? 'no limit' : fmtDuration(v)}.`;
    }
    if (name === 'setTxNonce') return 'It removes requests that wait.';
    return 'It changes what the delay protects.';
  }
  if (name === 'enableModule') return `It lets ${a} move the money without the wait.`;
  if (name === 'swapOwner' || name === 'addOwnerWithThreshold') return 'It gives the Chronobox an owner who can move the money without the wait.';
  if (name === 'setGuard') return `It lets ${a} block everything that this Chronobox does.`;
  return 'It changes how this Chronobox is built.';
}

/**
 * What a request does, in the words of the Chronobox app. `summary` starts with a verb ("Withdraw 1 ETH"),
 * so that it reads after "Somebody asked this Chronobox to ...". `detail` is one or more whole sentences.
 */
export function describeTx(
  tx: { to: string; value: bigint; data: string; operation: number },
  ctx: DescribeCtx,
): { kind: Kind; summary: string; detail: string; priority: number } {
  const native = NATIVE_SYMBOLS[ctx.chainId] ?? 'native coin';
  const to = tx.to.toLowerCase();
  const data = tx.data.toLowerCase();
  const toController = ctx.controllers.includes(to);
  const selector = data.length >= 10 ? data.slice(0, 10) : '';
  const elsewhere = (recipient: string) => `The money goes to ${recipient}. That is not the wallet of this Chronobox. ${NOT_THE_APP}`;

  if (tx.operation === 0 && data === '0x' && tx.value > 0n) {
    const amount = `${fmtUnits(tx.value, 18)} ${native}`;
    if (toController) {
      return { kind: 'withdrawal', summary: `Withdraw ${amount}`, detail: `The money goes to the wallet of this Chronobox, ${to}.`, priority: 3 };
    }
    return { kind: 'transfer_other', summary: `Send ${amount} to ${shortAddr(to)}`, detail: elsewhere(to), priority: 4 };
  }
  if (tx.operation === 0 && selector === SEL.transfer && strip(data).length === 8 + 128 && tx.value === 0n) {
    const recipient = toAddr(word('0x' + strip(data).slice(8), 0));
    const raw = toBig(word('0x' + strip(data).slice(8), 1));
    const meta = ctx.tokenMeta;
    const amount = meta ? `${fmtUnits(raw, meta.decimals)} ${meta.symbol}` : `${raw} units of the token ${shortAddr(to)}`;
    const token = ` The token is ${to}.`;
    if (ctx.controllers.includes(recipient)) {
      return { kind: 'withdrawal', summary: `Withdraw ${amount}`, detail: `The money goes to the wallet of this Chronobox, ${recipient}.${token}`, priority: 3 };
    }
    return { kind: 'transfer_other', summary: `Send ${amount} to ${shortAddr(recipient)}`, detail: `${elsewhere(recipient)}${token}`, priority: 4 };
  }

  // The delay: one call, and the request says all of it.
  if (tx.operation === 0 && to === ctx.delay && tx.value === 0n && selector === SET_TX_COOLDOWN && strip(data).length === 72) {
    const next = toBig(strip(data).slice(8));
    const now = ctx.cooldown;
    const note = now === undefined || next === now ? ''
      : next < now ? ` It is ${fmtDuration(now)} now. A shorter delay gives you less time to stop a thief.`
      : ` It is ${fmtDuration(now)} now. A longer delay makes every withdrawal wait longer.`;
    if (next === 0n) {
      return { kind: 'delay', summary: 'Remove the delay', detail: 'After this, a withdrawal does not wait at all. A person who has your wallet can take the money at once.', priority: 5 };
    }
    return { kind: 'delay', summary: `Change the delay to ${fmtDuration(next)}`, detail: `After this, every withdrawal waits ${fmtDuration(next)}.${note}`, priority: 5 };
  }

  // A new wallet. Alone, or as the first part of a batch.
  const handover = (next: string, removes: boolean) => ({
    kind: 'handover' as const, summary: `Hand over to ${shortAddr(next)}`, priority: 5,
    detail: `After this, the wallet ${next} holds this Chronobox${removes ? ', and the wallet of today does not' : ' too'}. It can withdraw all the money. ${LOOKS}`,
  });
  if (tx.operation === 0 && to === ctx.delay && tx.value === 0n && selector === ENABLE_MODULE && strip(data).length === 72) {
    return handover(toAddr(strip(data).slice(8)), false);
  }
  // The recovery: how long it waits, alone.
  const rd = ctx.recoveryDelay;
  if (rd && tx.operation === 0 && to === rd && tx.value === 0n && selector === SET_RECOVERY_WAIT && strip(data).length === 72) {
    const next = toBig(strip(data).slice(8));
    if (next === 0n) {
      return {
        kind: 'recovery_wait', summary: 'Remove the recovery wait', priority: 5,
        detail: 'After this, a recovery does not wait at all. The guardian can hand this Chronobox to another wallet at once.',
      };
    }
    const now = ctx.recoveryWait;
    return {
      kind: 'recovery_wait', summary: `Change the recovery wait to ${fmtDuration(next)}`, priority: 5,
      detail: `After this, a recovery waits ${fmtDuration(next)} before it can be carried out.${now === undefined || now === next ? '' : ` It is ${fmtDuration(now)} now.`}`,
    };
  }
  const calls = batchCalls(tx);
  if (calls) {
    const onDelay = calls.filter((c) => c.to === ctx.delay);
    const onRoles = ctx.roles ? calls.filter((c) => c.to === ctx.roles) : [];
    const onRecovery = rd ? calls.filter((c) => c.to === rd) : [];
    // How long a recovery waits after this batch: what it sets, else what it is now.
    const waitCall = onRecovery.find((c) => c.data.startsWith(SET_RECOVERY_WAIT) && strip(c.data).length === 72);
    const wait = waitCall ? toBig(strip(waitCall.data).slice(8)) : ctx.recoveryWait;
    const recoveryOn = onRecovery.find((c) => c.data.startsWith(ENABLE_MODULE) && strip(c.data).length === 72);
    const recoveryOff = onRecovery.some((c) => c.data.startsWith(DISABLE_MODULE));
    const waits = wait === undefined
      ? ''
      : wait === 0n
        ? ' Warning: the recovery wait is zero, so a recovery can be carried out at once.'
        : ` A recovery waits ${fmtDuration(wait)}, and the wallet and the guardian can stop it in that time.`;
    const enable = onDelay.find((c) => c.data.startsWith(ENABLE_MODULE) && strip(c.data).length === 72);
    if (enable && onDelay.length + onRoles.length + onRecovery.length === calls.length) {
      const removes = onDelay.some((c) => c.data.startsWith(DISABLE_MODULE) && ctx.controllers.includes(toAddr(strip(c.data).slice(72, 136))));
      return handover(toAddr(strip(enable.data).slice(8)), removes);
    }
    if (onRoles.length + onRecovery.length === calls.length && onRoles.length > 0) {
      const assigns = onRoles.filter((c) => c.data.startsWith(ASSIGN_ROLES)).map((c) => decodeAssign(c.data)).filter((a) => a !== null);
      const added = assigns.find((a) => a.grants.some((g) => g.on && g.key === CANCEL_ROLE));
      if (added) {
        return {
          kind: 'guardian_add', summary: `Add the guardian ${shortAddr(added.module)}${recoveryOn ? ' with a recovery' : ''}`, priority: 5,
          detail: `After this, ${added.module} can stop every withdrawal. Together with the wallet of this Chronobox, it can hand the Chronobox to a new wallet at once.` +
            (recoveryOn ? ` The guardian can also start a recovery to a new wallet that the guardian chooses.${waits}` : '') + ` ${LOOKS}`,
        };
      }
      const removed = assigns.find((a) => !ctx.controllers.includes(a.module) && a.grants.some((g) => !g.on && g.key === CANCEL_ROLE));
      if (removed) {
        return {
          kind: 'guardian_remove', summary: 'Remove the guardian', priority: 5,
          detail: `After this, ${removed.module} cannot stop a withdrawal any more. Only the wallet of this Chronobox can cancel.${recoveryOff ? ' The recovery goes too.' : ''} ${LOOKS}`,
        };
      }
      if (recoveryOn) {
        return {
          kind: 'recovery_on', summary: 'Turn on the recovery', priority: 5,
          detail: `After this, the guardian ${toAddr(strip(recoveryOn.data).slice(8))} can start a recovery to a new wallet that the guardian chooses.${waits} ${LOOKS}`,
        };
      }
    }
    if (recoveryOff && onRecovery.length === calls.length) {
      return {
        kind: 'recovery_off', summary: 'Turn off the recovery', priority: 5,
        detail: `After this, the guardian cannot start a recovery. A recovery that waits then can never be carried out. ${LOOKS}`,
      };
    }
    const targets = [...new Set(calls.map((c) => c.to))].join(', ');
    return {
      kind: 'call', summary: 'Change this Chronobox in a way that the app does not know', priority: 5,
      detail: `It makes ${calls.length} change${calls.length === 1 ? '' : 's'} in one step. ${NOT_THE_APP} Technical detail: a batch of calls to ${targets}.`,
    };
  }

  // Anything else is a call that the app does not make.
  let part: 'delay' | 'vault' | 'roles' | 'recovery' | null = null;
  let where = `the contract ${to}`;
  let fn: string | undefined;
  if (to === ctx.delay) { part = 'delay'; where = `the delay contract ${to}`; fn = DELAY_FUNCTIONS[selector]; }
  else if (to === ctx.vault) { part = 'vault'; where = `the Safe of the Chronobox ${to}`; fn = SAFE_FUNCTIONS[selector]; }
  else if (ctx.roles && to === ctx.roles) { part = 'roles'; where = `the cancel contract ${to}`; fn = ROLES_FUNCTIONS[selector]; }
  else if (rd && to === rd) { part = 'recovery'; where = `the recovery contract ${to}`; fn = DELAY_FUNCTIONS[selector]; }
  const approve = !fn && selector === APPROVE_SELECTOR;
  if (approve) fn = 'approve(address,uint256)';
  const name = fn ? fn.slice(0, fn.indexOf('(')) : selector ? `the function ${selector}` : 'no function';
  const call = fn ? `${name}(${argsText(fn, data)})` : name;
  const a = toAddr(strip(data).slice(8, 72));
  const b = toAddr(strip(data).slice(72, 136));
  const parts: string[] = [];
  let summary: string;
  if (part) {
    summary = 'Change this Chronobox in a way that the app does not know';
    parts.push(meaning(part, fn, a, b, data));
  } else if (approve) {
    summary = `Let ${shortAddr(a)} take tokens`;
    parts.push(`It lets ${a} take the token ${to} out of this Chronobox later, without the wait.`);
  } else {
    summary = 'Do something that the app does not know';
    parts.push(`It uses ${where}.`);
  }
  if (tx.value > 0n) parts.push(`It sends ${fmtUnits(tx.value, 18)} ${native} with it.`);
  if (tx.operation === 1) parts.push('It runs the code of another contract with full control of this Chronobox.');
  parts.push(NOT_THE_APP);
  parts.push(`Technical detail: ${tx.operation === 1 ? 'a delegate call of' : 'a call of'} ${call} on ${where}.`);
  return { kind: 'call', summary, detail: parts.join(' '), priority: 5 };
}
