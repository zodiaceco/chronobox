// The guardian of a Chronobox, the Safe that the guardian shares with the wallet, and the line of the recovery.
//
// With a guardian, the cancel contract (Roles) has three members: the wallet, the guardian, and a 2 of 2 Safe of the
// two (the "council"). Together, wallet and guardian can hand the Chronobox to a new wallet at once. With the
// recovery on, a second Delay (the recovery Delay) acts on that Safe, and the guardian is its one module: the guardian
// alone can put a wallet change into its line, and after a long wait anybody can carry it out. The wallet and the
// guardian can empty that line at once. The addresses are fixed for each Chronobox, as in the app (src/lib/chronobox.ts).
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  MASTER_COPY, MODULE_PROXY_FACTORY, RevertError, SAFE_L2_SINGLETON, SAFE_PROXY_CODE_HASH, ZERO_ADDRESS,
  encAddr, encUint, strip, toAddr, toBig,
} from './chain.ts';
import { batchCalls } from './describe.ts';

export const SAFE_PROXY_FACTORY = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67';
/** keccak256 of the SafeProxy 1.4.1 creation code with the SafeL2 singleton. The same as in the app. */
const SAFE_PROXY_INIT_CODE_HASH = 'e298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee';
/** SafeModuleSetup 0.3.0: the shared Safe of a recovery enables the recovery Delay with it in its setup. */
const SAFE_MODULE_SETUP = '0x2dd68b007b46fbe91b9a7c3eda5a7a1063cb5b47';
export const DEFAULT_RECOVERY_WAIT = 180n * 86400n;
export const RECOVERY_EXPIRATION = 30n * 86400n;

const enc = new TextEncoder();
const fromHex = (h: string) => Uint8Array.from(Buffer.from(strip(h), 'hex'));
/** keccak256 of hex bytes, as hex without 0x. */
export const keccakHex = (h: string) => Buffer.from(keccak_256(fromHex(h))).toString('hex');
const keccakText = (s: string) => Buffer.from(keccak_256(enc.encode(s))).toString('hex');
const selector = (sig: string) => keccakText(sig).slice(0, 8);
export const topicOf = (sig: string) => '0x' + keccakText(sig);

/** The salt of the Chronobox app: the nth vault of a wallet uses SALT_BASE + n, the recovery Delay SALT_BASE + 1. */
const SALT_BASE = BigInt('0x' + keccakText('zodiac-timebox:v1'));

const create2 = (deployer: string, salt: string, initCodeHash: string) =>
  toAddr(keccakHex('ff' + strip(deployer) + salt + initCodeHash));

/** The recovery Delay of a Chronobox. Anybody can make it, always at this address. It may not be made yet. */
export function predictRecoveryDelay(vault: string): string {
  const v = encAddr(vault);
  const params = v + v + v + encUint(DEFAULT_RECOVERY_WAIT) + encUint(RECOVERY_EXPIRATION);
  const initializer = selector('setUp(bytes)') + encUint(32) + encUint(params.length / 2) + params;
  const salt = keccakHex(keccakHex(initializer) + encUint(SALT_BASE + 1n));
  const initCode = '602d8060093d393df3' + '363d3d373d3d3d363d73' + strip(MASTER_COPY.delay) + '5af43d82803e903d91602b57fd5bf3';
  return create2(MODULE_PROXY_FACTORY, salt, keccakHex(initCode));
}

/**
 * The 2 of 2 Safe of wallet and guardian, as the app makes it. Two forms: without a module, or with the recovery
 * Delay as its one module from its first moment. A wallet change by the two together keeps the address of the Safe
 * (it swaps the owner), so a Safe that is made is also known by its owners (see `readGuard`).
 */
export function predictCouncil(vault: string, wallet: string, guardian: string, withRecovery: boolean): string {
  const z = encAddr(ZERO_ADDRESS);
  const data = withRecovery ? selector('enableModules(address[])') + encUint(32) + encUint(1) + encAddr(predictRecoveryDelay(vault)) : '';
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  const initializer = selector('setup(address[],uint256,address,bytes,address,address,uint256,address)') +
    encUint(0x100) + encUint(2) + (withRecovery ? encAddr(SAFE_MODULE_SETUP) : z) + encUint(0x160) + z + z + encUint(0) + z +
    encUint(2) + encAddr(wallet) + encAddr(guardian) +
    encUint(data.length / 2) + padded;
  const councilSalt = keccakHex(encUint(SALT_BASE) + encAddr(vault));
  const salt = keccakHex(keccakHex(initializer) + councilSalt);
  return create2(SAFE_PROXY_FACTORY, salt, SAFE_PROXY_INIT_CODE_HASH);
}

// ---------------------------------------------------------------------------
// What a step in the line of the recovery does

const WITH_ROLE = selector('execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool)');
const ENABLE_MODULE = selector('enableModule(address)');
const DISABLE_MODULE = selector('disableModule(address,address)');
const SET_TX_NONCE = selector('setTxNonce(uint256)');
const ASSIGN_ROLES = selector('assignRoles(address,bytes32[],bool[])');
const SWAP_OWNER = selector('swapOwner(address,address,address)');
const CANCEL_ROLE = Buffer.from('cancel').toString('hex').padEnd(64, '0');
const COUNCIL_ROLE = Buffer.from('council').toString('hex').padEnd(64, '0');

type WithRoleCall = { target: string; data: string; role: string; shouldRevert: boolean };

function decodeWithRole(call: { to: string; data: string }, roles: string): WithRoleCall | null {
  const b = strip(call.data.toLowerCase());
  if (call.to !== roles || b.slice(0, 8) !== WITH_ROLE) return null;
  const args = b.slice(8);
  if (args.length < 384) return null;
  const target = toAddr(args.slice(0, 64));
  const value = toBig(args.slice(64, 128));
  const op = toBig(args.slice(192, 256));
  if (value !== 0n || op !== 0n) return null;
  const role = args.slice(256, 320);
  const revWord = toBig(args.slice(320, 384));
  if (revWord !== 0n && revWord !== 1n) return null;
  const at = Number(toBig(args.slice(128, 192))) * 2;
  if (!Number.isSafeInteger(at) || at < 384 || at + 64 > args.length) return null;
  const len = Number(toBig(args.slice(at, at + 64)));
  if (!Number.isSafeInteger(len) || at + 64 + len * 2 > args.length) return null;
  return { target, data: args.slice(at + 64, at + 64 + len * 2), role, shouldRevert: revWord === 1n };
}

/** Decodes a single-role `assignRoles(module, [role], [flag])` calldata (without 0x). */
function decodeSingleAssign(data: string): { module: string; role: string; on: boolean } | null {
  if (data.slice(0, 8) !== ASSIGN_ROLES) return null;
  const a = data.slice(8);
  if (a.length < 192) return null;
  const module = toAddr(a.slice(0, 64));
  const kOff = Number(toBig(a.slice(64, 128))) * 2;
  const fOff = Number(toBig(a.slice(128, 192))) * 2;
  if (kOff + 128 > a.length || fOff + 128 > a.length) return null;
  if (toBig(a.slice(kOff, kOff + 64)) !== 1n || toBig(a.slice(fOff, fOff + 64)) !== 1n) return null;
  const flag = toBig(a.slice(fOff + 64, fOff + 128));
  if (flag !== 0n && flag !== 1n) return null;
  return { module, role: a.slice(kOff + 64, kOff + 128), on: flag === 1n };
}

/**
 * The new wallet of a recovery as the app makes it: the exact 9-call `councilSwapTx` batch of the
 * shared Safe. Every call, target, role, and address relationship is verified so a rogue guardian
 * cannot spoof the alerted destination wallet while executing different middle calls.
 * Null for anything else.
 */
export function recoveryWallet(
  tx: { to: string; value: bigint; data: string; operation: number },
  delay: string,
  roles: string,
  council?: string,
): string | null {
  const calls = batchCalls(tx);
  if (!calls || calls.length !== 9) return null;
  const c0 = decodeWithRole(calls[0], roles);
  const c1 = decodeWithRole(calls[1], roles);
  const c2 = decodeWithRole(calls[2], roles);
  const c3 = decodeWithRole(calls[3], roles);
  const c4 = decodeWithRole(calls[4], roles);
  const c5 = decodeWithRole(calls[5], roles);
  const c6 = decodeWithRole(calls[6], roles);
  const c7 = decodeWithRole(calls[7], roles);
  if (!c0 || !c1 || !c2 || !c3 || !c4 || !c5 || !c6 || !c7) return null;

  // 0: delay.enableModule(wallet)
  if (c0.target !== delay || c0.role !== COUNCIL_ROLE || !c0.shouldRevert || c0.data.length !== 72 || c0.data.slice(0, 8) !== ENABLE_MODULE) return null;
  const wallet = toAddr(c0.data.slice(8, 72));

  // 1: delay.disableModule(wallet, from)
  if (c1.target !== delay || c1.role !== COUNCIL_ROLE || !c1.shouldRevert || c1.data.length !== 136 || c1.data.slice(0, 8) !== DISABLE_MODULE) return null;
  if (toAddr(c1.data.slice(8, 72)) !== wallet) return null;
  const from = toAddr(c1.data.slice(72, 136));
  if (from === wallet) return null;

  // 2 & 4: temporarily grant/revoke CANCEL_ROLE on the shared Safe to clear the main Delay line.
  if (c2.target !== roles || c2.role !== COUNCIL_ROLE || !c2.shouldRevert) return null;
  if (c4.target !== roles || c4.role !== COUNCIL_ROLE || !c4.shouldRevert) return null;
  const a2 = decodeSingleAssign(c2.data);
  const a4 = decodeSingleAssign(c4.data);
  if (!a2 || !a4 || a2.role !== CANCEL_ROLE || !a2.on || a4.role !== CANCEL_ROLE || a4.on || a2.module !== a4.module) return null;
  const targetCouncil = a2.module;
  if (council && targetCouncil !== council) return null;

  // 3: delay.setTxNonce(cancelUpTo) with CANCEL_ROLE, shouldRevert = false
  if (c3.target !== delay || c3.role !== CANCEL_ROLE || c3.shouldRevert || c3.data.length !== 72 || c3.data.slice(0, 8) !== SET_TX_NONCE) return null;

  // 5 & 6: move CANCEL_ROLE from old wallet to new wallet
  if (c5.target !== roles || c5.role !== COUNCIL_ROLE || !c5.shouldRevert) return null;
  if (c6.target !== roles || c6.role !== COUNCIL_ROLE || !c6.shouldRevert) return null;
  const a5 = decodeSingleAssign(c5.data);
  const a6 = decodeSingleAssign(c6.data);
  if (!a5 || !a6 || a5.role !== CANCEL_ROLE || !a5.on || a5.module !== wallet) return null;
  if (a6.role !== CANCEL_ROLE || a6.on || a6.module !== from) return null;

  // 7: roles.disableModule(prevMember, from)
  if (c7.target !== roles || c7.role !== COUNCIL_ROLE || !c7.shouldRevert || c7.data.length !== 136 || c7.data.slice(0, 8) !== DISABLE_MODULE) return null;
  if (toAddr(c7.data.slice(72, 136)) !== from) return null;

  // 8: council.swapOwner(prevOwner, from, wallet)
  const swap = strip(calls[8].data.toLowerCase());
  if (calls[8].to !== targetCouncil || swap.length !== 200 || swap.slice(0, 8) !== SWAP_OWNER) return null;
  if (toAddr(swap.slice(72, 136)) !== from || toAddr(swap.slice(136, 200)) !== wallet) return null;
  return wallet;
}

// ---------------------------------------------------------------------------
// Reading it from the chain

export type Reader = {
  code(addr: string): Promise<string>;
  singleton?(addr: string): Promise<string>;
  guard?(addr: string): Promise<string>;
  owners(safe: string): Promise<string[]>;
  threshold(safe: string): Promise<bigint>;
  modules(of: string): Promise<string[]>;
};

/** The guardian and the shared Safe, as read now. */
export type GuardInfo = { guardian: string; council: string; made: boolean; owners: string[]; threshold: string; modules: string[]; guard: string };

/**
 * Which of the members of the cancel contract are the guardian and the shared Safe. A guardian is there when the
 * contract has three members: the wallet, and two more, one of which is the 2 of 2 Safe of the wallet and the other.
 * Null when it is not so: then the watcher names the members as they are.
 */
export async function readGuard(r: Reader, vault: string, wallet: string, members: string[]): Promise<GuardInfo | null> {
  const others = members.filter((m) => m !== wallet);
  if (others.length !== 2 || !members.includes(wallet)) return null;
  for (const [guardian, council] of [[others[0], others[1]], [others[1], others[0]]]) {
    const predicted = council === predictCouncil(vault, wallet, guardian, false) || council === predictCouncil(vault, wallet, guardian, true);
    const code = await r.code(council);
    if (code === '0x' || code === '') {
      if (predicted) return { guardian, council, made: false, owners: [], threshold: '0', modules: [], guard: ZERO_ADDRESS };
      continue;
    }
    // Verify genuine SafeProxy 1.4.1 + SafeL2 singleton before trusting contract answers.
    if (keccakHex(code) !== SAFE_PROXY_CODE_HASH) continue;
    if (r.singleton && (await r.singleton(council)) !== SAFE_L2_SINGLETON) continue;
    let owners: string[];
    try {
      owners = await r.owners(council);
    } catch (e) {
      if (e instanceof RevertError) continue;
      throw e;
    }
    const both = owners.length === 2 && owners.includes(wallet) && owners.includes(guardian);
    if (!predicted && !both) continue;
    const [threshold, modules, guard] = await Promise.all([
      r.threshold(council),
      r.modules(council),
      r.guard ? r.guard(council) : Promise.resolve(ZERO_ADDRESS),
    ]);
    return { guardian, council, made: true, owners, threshold: threshold.toString(), modules, guard };
  }
  return null;
}
