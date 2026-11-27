// The chain: pinned constants, ABI helpers, and a JSON-RPC client with fallbacks.
import { type RpcAuth, rpcAuthHeaders } from './rpcAuth.ts';
import { type FetchFn, errText } from './util.ts';

// ---------------------------------------------------------------------------
// Constants (selectors are keccak256 prefixes, computed offline and pinned)

export const SENTINEL = '0x0000000000000000000000000000000000000001';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const TOPIC_TRANSACTION_ADDED = '0x4c8a9c748e976c17c2eb2c2bc50da76eac9cd90ff529f0fe900e0c10a179f031';
export const TOPIC_TX_NONCE_SET = '0xb80aa44b2e3f25cf4fbdf2a6c561d9a3d961528ccfc2097da3741fdf941d6d13'; // TxNonceSet(uint256)
// SafeModuleTransaction(address module, address to, uint256 value, bytes data, uint8 operation), from a SafeL2.
// The Delay 1.0.1 that Chronobox pins has no TxNonceSet event, so a cancel is read from the vault: it shows
// every call a module made, and a cancel is the call setTxNonce on the Delay.
export const TOPIC_SAFE_MODULE_TRANSACTION = '0xb648d3644f584ed1c2232d53c46d87e693586486ad0d1175f8656013110b714e';
// ExecutionFromModuleSuccess(address indexed module) and ExecutionFromModuleFailure(address indexed module): the
// result of each call of a module, right after it. Every Safe from 1.3 on logs them.
export const TOPIC_MODULE_SUCCESS = '0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8';
export const TOPIC_MODULE_FAILURE = '0xacd2c8702804128fdb0db2bb49f6d127dd0181c13fd45dbfe16de0930e2bd375';
export const SET_TX_NONCE = '0x46ba2307';
// EnabledModule(address) and DisabledModule(address) of a Zodiac modifier: a wallet that comes or goes on the Delay.
export const TOPIC_ENABLED_MODULE = '0xecdf3a3effea5783a3c4c2140e677577666428d44ed9d474a0b3a4c9943f8440';
export const TOPIC_DISABLED_MODULE = '0xaab4fa2b463f581b2b32cb3b7e3b704b9ce37cc209b5fb4d77e593ace4054276';
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';
/** Safe 1.4.1 guard storage slot: keccak256("guard_manager.guard.address"). */
export const SAFE_GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
/** SafeL2 1.4.1 singleton address. */
export const SAFE_L2_SINGLETON = '0x29fcb43b46531bca003ddc8fcb67ffe91900c762';
/** keccak256 of the runtime code of SafeProxy 1.4.1 (without 0x). */
export const SAFE_PROXY_CODE_HASH = 'd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c';
// ModuleProxyCreation(address indexed proxy, address indexed masterCopy), from the Zodiac ModuleProxyFactory.
export const TOPIC_MODULE_PROXY_CREATION = '0x2150ada912bf189ed721c44211199e270903fc88008c2a1e1e889ef30fe67c5f';
export const MODULE_PROXY_FACTORY = '0x000000000000addb49795b0f9ba5bc298cdda236';

// Both modules are EIP-1167 minimal proxies; the master copy tells them apart.
export const MASTER_COPY = {
  delay: '0xd54895b1121a2ee3f37b502f507631fa1331bed6',
  roles: '0xf2964ce6161ce0e75964fe7927ce114cb0b283d5', // Roles modifier 2.1.1 (2.1.0 is on Zodiac's list of faulty contracts)
} as const;
export const proxyCode = (masterCopy: string) =>
  '0x363d3d373d3d3d363d73' + masterCopy.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';

export const SEL = {
  txCooldown: '0xdcafac09',
  txExpiration: '0x605df59c',
  txNonce: '0xc66323e5',
  queueNonce: '0xde8dd91d',
  getTxCreatedAt: '0x3aa76906',
  getTxHash: '0x6b0a4cf6',
  owner: '0x8da5cb5b',
  avatar: '0x5aef7de6',
  target: '0xd4b83992',
  getModulesPaginated: '0xcc2f8452',
  getOwners: '0xa0e67e2b',
  getThreshold: '0xe75235b8',
  getGuard: '0xc9106389',
  transfer: '0xa9059cbb',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
} as const;

// Calls on the Delay modifier that change how the vault is protected.
export const DELAY_FUNCTIONS: Record<string, string> = {
  '0xebb2b4a2': 'setTxCooldown(uint256)',
  '0x9b56d5be': 'setTxExpiration(uint256)',
  '0x46ba2307': 'setTxNonce(uint256)',
  '0x610b5925': 'enableModule(address)',
  '0xe009cfde': 'disableModule(address,address)',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  '0x776d1a01': 'setTarget(address)',
  '0x086cfca8': 'setAvatar(address)',
};

// Calls on the Roles modifier (the cancel module) that every Zodiac modifier has.
export const ROLES_FUNCTIONS: Record<string, string> = {
  '0x610b5925': 'enableModule(address)',
  '0xe009cfde': 'disableModule(address,address)',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  '0x776d1a01': 'setTarget(address)',
  '0x086cfca8': 'setAvatar(address)',
};

// Calls on the Safe (the vault itself).
export const SAFE_FUNCTIONS: Record<string, string> = {
  '0x610b5925': 'enableModule(address)',
  '0xe009cfde': 'disableModule(address,address)',
  '0xe318b52b': 'swapOwner(address,address,address)',
  '0x0d582f13': 'addOwnerWithThreshold(address,uint256)',
  '0xf8dc5dd9': 'removeOwner(address,address,uint256)',
  '0x694e80c3': 'changeThreshold(uint256)',
  '0xe19a9dd9': 'setGuard(address)',
  '0xf08a0323': 'setFallbackHandler(address)',
};

export const APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256) on any token

export const NATIVE_SYMBOLS: Record<number, string> = {
  1: 'ETH', 10: 'ETH', 8453: 'ETH', 42161: 'ETH', 11155111: 'ETH', 17000: 'ETH', 560048: 'ETH',
  100: 'xDAI', 137: 'POL', 56: 'BNB', 43114: 'AVAX',
};

export const hex = (n: number | bigint) => '0x' + n.toString(16);
export const strip = (h: string) => (h.startsWith('0x') ? h.slice(2) : h);
export const encUint = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
export const encAddr = (a: string) => strip(a).toLowerCase().padStart(64, '0');
export const word = (data: string, i: number) => strip(data).slice(i * 64, (i + 1) * 64);
export const wordAtByte = (data: string, byte: number) => strip(data).slice(byte * 2, byte * 2 + 64);
export const toBig = (w: string) => (w ? BigInt('0x' + w) : 0n);
export const toAddr = (w: string) => '0x' + w.slice(-40).toLowerCase();

/** The 32-byte word at `byte` of an answer, or BadAnswerError when the answer is too short. */
function wordAt(r: string, byte: number, what: string): string {
  const w = r.slice(byte * 2, byte * 2 + 64);
  if (w.length !== 64) throw new BadAnswerError(`${what}: the answer is too short`);
  return w;
}

/** An address word: 12 zero bytes, then 20 bytes. Anything else is not an address. */
export function addressWord(w: string, what = 'address'): string {
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(w)) throw new BadAnswerError(`${what}: not an address`);
  return '0x' + w.slice(24).toLowerCase();
}

/** An offset or a length in an answer: small, and inside it. */
function sizeAt(r: string, byte: number, what: string, max: number): number {
  const v = toBig(wordAt(r, byte, what));
  if (v > BigInt(max)) throw new BadAnswerError(`${what}: ${v} is out of range`);
  return Number(v);
}

/** The address[] at byte `off` of an answer, with at most `max` entries. */
function addressList(r: string, off: number, max: number, what: string): string[] {
  if (off % 32 !== 0) throw new BadAnswerError(`${what}: the offset is not a whole word`);
  const len = sizeAt(r, off, what, max);
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(addressWord(wordAt(r, off + 32 + i * 32, what), what));
  return out;
}

/** The answer of getModulesPaginated: (address[] array, address next). The watcher asks for 100 at most. */
export function decodeAddressArray(ret: string): { array: string[]; next: string } {
  const r = strip(ret);
  const off = sizeAt(r, 0, 'modules', r.length / 2);
  const next = addressWord(wordAt(r, 32, 'modules'), 'modules');
  return { array: addressList(r, off, 100, 'modules'), next };
}

/** A returned address[] (for example Safe.getOwners). */
export function decodeAddresses(ret: string): string[] {
  const r = strip(ret);
  return addressList(r, sizeAt(r, 0, 'addresses', r.length / 2), 1000, 'addresses');
}

/** The first word of an answer as a number. */
export function decodeUint(ret: string): bigint {
  return toBig(wordAt(strip(ret), 0, 'number'));
}

/** The first word of an answer as an address. */
export function decodeAddress(ret: string): string {
  return addressWord(wordAt(strip(ret), 0, 'address'));
}

/** A SafeModuleTransaction log: which module asked the Safe for what. Null if it is not that ABI. */
export function decodeModuleTransaction(log: { data: string }): { module: string; to: string; value: bigint; data: string; operation: number } | null {
  const d = strip(log.data);
  try {
    const module = addressWord(d.slice(0, 64));
    const to = addressWord(d.slice(64, 128));
    const value = toBig(d.slice(128, 192));
    const off = Number(toBig(d.slice(192, 256)));
    const operation = Number(toBig(d.slice(256, 320)));
    if (off !== 160 || d.length < (off + 32) * 2) return null;
    const len = Number(toBig(d.slice(off * 2, off * 2 + 64)));
    const data = d.slice((off + 32) * 2, (off + 32 + len) * 2);
    if (data.length !== len * 2 || operation > 1) return null;
    return { module, to, value, data: '0x' + data, operation };
  } catch {
    return null;
  }
}

export function decodeTransactionAdded(log: { topics: string[]; data: string; blockNumber: string }) {
  const d = log.data;
  const nonce = Number(BigInt(log.topics[1]));
  const to = toAddr(word(d, 0));
  const value = toBig(word(d, 1));
  const off = Number(toBig(word(d, 2)));
  const operation = Number(toBig(word(d, 3)));
  const len = Number(toBig(wordAtByte(d, off)));
  const data = '0x' + strip(d).slice((off + 32) * 2, (off + 32 + len) * 2);
  return { nonce, txHash: log.topics[2], to, value, data, operation, block: Number(BigInt(log.blockNumber)) };
}

export function decodeAbiString(ret: string): string {
  const r = strip(ret);
  if (r.length === 64) {
    // bytes32 symbol (older tokens)
    return utf8(r).replace(/\0+$/, '');
  }
  const off = sizeAt(r, 0, 'text', r.length / 2);
  const len = sizeAt(r, off, 'text', r.length / 2);
  const body = r.slice((off + 32) * 2, (off + 32 + len) * 2);
  if (body.length !== len * 2) throw new BadAnswerError('text: the answer is too short');
  return utf8(body);
}

function utf8(h: string): string {
  const bytes = new Uint8Array(Math.floor(h.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

export function cleanSymbol(s: string): string {
  return /^[A-Za-z0-9.$_+-]{1,16}$/.test(s) ? s : 'tokens';
}

// ---------------------------------------------------------------------------
// JSON-RPC client with fallbacks

/** A view call reverted: the address is not the contract the watcher thought. */
export class RevertError extends Error {}

/**
 * A contract answered something that is not the ABI it should answer. It counts as a revert: the address is not the
 * contract the watcher thought. Anybody can deploy a contract that answers anything.
 */
export class BadAnswerError extends RevertError {}

/** Requests sent to the RPC, by method. Each try counts, also one that failed and went on to the next endpoint. */
export type RpcCounts = Record<string, number>;

/** All requests in `counts`. */
export const totalCalls = (counts: RpcCounts) => Object.values(counts).reduce((a, b) => a + b, 0);

/** "eth_call 20, eth_getLogs 4": the methods, most requests first. */
export const callsByMethod = (counts: RpcCounts) =>
  Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([m, n]) => `${m} ${n}`).join(', ');

export class Rpc {
  urls: string[];
  idx = 0;
  id = 0;
  timeoutMs: number;
  fetchFn: FetchFn;
  auth?: RpcAuth;
  /** Where the requests are counted, if anywhere. */
  counts?: RpcCounts;
  constructor(urls: string[], fetchFn: FetchFn = fetch, timeoutMs = 20000, auth?: RpcAuth, counts?: RpcCounts) {
    this.urls = urls;
    this.auth = auth;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.counts = counts;
  }
  async call(method: string, params: unknown[] = []): Promise<any> {
    let lastErr = 'no RPC configured';
    for (let i = 0; i < this.urls.length; i++) {
      const k = (this.idx + i) % this.urls.length;
      if (this.counts) this.counts[method] = (this.counts[method] ?? 0) + 1;
      try {
        const res = await this.fetchFn(this.urls[k], {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...rpcAuthHeaders(this.auth, this.urls[k]) },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        if (j.error) {
          const msg = String(j.error.message ?? 'error');
          if (j.error.code === 3 || /revert/i.test(msg)) { this.idx = k; throw new RevertError(msg); }
          throw new Error(`RPC error ${j.error.code}: ${msg}`);
        }
        if (!('result' in j)) throw new Error('response without result');
        this.idx = k;
        return j.result;
      } catch (e) {
        if (e instanceof RevertError) throw e;
        lastErr = `RPC #${k + 1}: ${errText(e)}`;
      }
    }
    throw new Error(`all RPC endpoints failed (${method}); last: ${lastErr}`);
  }
}
