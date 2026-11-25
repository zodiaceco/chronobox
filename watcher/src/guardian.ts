// The guardian of a Chronobox, the Safe that the guardian shares with the wallet, and the line of the recovery.
//
// With a guardian, the cancel contract (Roles) has three members: the wallet, the guardian, and a 2 of 2 Safe of the
// two (the "council"). Together, wallet and guardian can hand the Chronobox to a new wallet at once. With the
// recovery on, a second Delay (the recovery Delay) acts on that Safe, and the guardian is its one module: the guardian
// alone can put a wallet change into its line, and after a long wait anybody can carry it out. The wallet and the
// guardian can empty that line at once. The addresses are fixed for each Chronobox, as in the app (src/lib/chronobox.ts).
import { keccak_256 } from '@noble/hashes/sha3.js';
import { MASTER_COPY, MODULE_PROXY_FACTORY, ZERO_ADDRESS, encAddr, encUint, strip, toAddr, toBig } from './chain.ts';
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
const SWAP_OWNER = selector('swapOwner(address,address,address)');
const COUNCIL_ROLE = Buffer.from('council').toString('hex').padEnd(64, '0');

/**
 * The new wallet of a recovery as the app makes it: a batch of the shared Safe whose first call uses the role
 * "council" to enable the new wallet on the Delay of the Chronobox, and whose last call swaps that wallet in among
 * the owners of the shared Safe. Null for anything else. This reads the shape. The app compares it byte for byte.
 */
export function recoveryWallet(tx: { to: string; value: bigint; data: string; operation: number }, delay: string, roles: string): string | null {
  const calls = batchCalls(tx);
  if (!calls || calls.length < 2) return null;
  const first = calls[0];
  const last = calls[calls.length - 1];
  const b = strip(first.data.toLowerCase());
  if (first.to !== roles || b.slice(0, 8) !== WITH_ROLE) return null;
  const args = b.slice(8);
  if (toAddr(args.slice(0, 64)) !== delay || toBig(args.slice(64, 128)) !== 0n || args.slice(256, 320) !== COUNCIL_ROLE) return null;
  const at = Number(toBig(args.slice(128, 192))) * 2;
  const len = Number(toBig(args.slice(at, at + 64)));
  const inner = args.slice(at + 64, at + 64 + len * 2);
  if (len !== 36 || inner.slice(0, 8) !== ENABLE_MODULE) return null;
  const wallet = toAddr(inner.slice(8, 72));
  const swap = strip(last.data.toLowerCase());
  if (swap.slice(0, 8) !== SWAP_OWNER || toAddr(swap.slice(136, 200)) !== wallet) return null;
  return wallet;
}

// ---------------------------------------------------------------------------
// Reading it from the chain

export type Reader = {
  code(addr: string): Promise<string>;
  owners(safe: string): Promise<string[]>;
  threshold(safe: string): Promise<bigint>;
  modules(of: string): Promise<string[]>;
};

/** The guardian and the shared Safe, as read now. */
export type GuardInfo = { guardian: string; council: string; made: boolean; owners: string[]; threshold: string; modules: string[] };

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
      if (predicted) return { guardian, council, made: false, owners: [], threshold: '0', modules: [] };
      continue;
    }
    let owners: string[];
    try { owners = await r.owners(council); } catch { continue; }
    const both = owners.length === 2 && owners.includes(wallet) && owners.includes(guardian);
    if (!predicted && !both) continue;
    const [threshold, modules] = await Promise.all([r.threshold(council).catch(() => 0n), r.modules(council).catch(() => [] as string[])]);
    return { guardian, council, made: true, owners, threshold: threshold.toString(), modules };
  }
  return null;
}
