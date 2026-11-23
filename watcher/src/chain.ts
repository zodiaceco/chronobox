// The chain: pinned constants, ABI helpers, and a JSON-RPC client with fallbacks.
import { type RpcAuth, rpcAuthHeaders } from './rpcToken.ts';
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
export const SET_TX_NONCE = '0x46ba2307';
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dead';
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

export function decodeAddressArray(ret: string): { array: string[]; next: string } {
  const off = Number(toBig(word(ret, 0)));
  const next = toAddr(word(ret, 1));
  const len = Number(toBig(wordAtByte(ret, off)));
  const array: string[] = [];
  // The watcher asks for 100 at most. A longer list is not the answer of a Safe.
  if (!(len <= 100)) return { array, next: ZERO_ADDRESS };
  for (let i = 0; i < len; i++) array.push(toAddr(wordAtByte(ret, off + 32 + i * 32)));
  return { array, next };
}

/** A returned address[] (for example Safe.getOwners). */
export function decodeAddresses(ret: string): string[] {
  const off = Number(toBig(word(ret, 0)));
  const len = Number(toBig(wordAtByte(ret, off)));
  const out: string[] = [];
  if (!(len <= 1000)) return out;
  for (let i = 0; i < len; i++) out.push(toAddr(wordAtByte(ret, off + 32 + i * 32)));
  return out;
}

/** The new nonce if this SafeModuleTransaction log is the call setTxNonce on the Delay, else null. */
export function decodeCancel(log: { data: string }, delay: string): number | null {
  const d = log.data;
  if (toAddr(word(d, 1)) !== delay) return null;
  const off = Number(toBig(word(d, 3)));
  const len = Number(toBig(wordAtByte(d, off)));
  const data = '0x' + strip(d).slice((off + 32) * 2, (off + 32 + len) * 2);
  if (len !== 36 || !data.toLowerCase().startsWith(SET_TX_NONCE)) return null;
  return Number(toBig(data.slice(10)));
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
  const off = Number(toBig(r.slice(0, 64)));
  const len = Number(toBig(wordAtByte(r, off)));
  return utf8(r.slice((off + 32) * 2, (off + 32 + len) * 2));
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

export class Rpc {
  urls: string[];
  idx = 0;
  id = 0;
  timeoutMs: number;
  fetchFn: FetchFn;
  auth?: RpcAuth;
  constructor(urls: string[], fetchFn: FetchFn = fetch, timeoutMs = 20000, auth?: RpcAuth) {
    this.urls = urls;
    this.auth = auth;
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
  }
  async call(method: string, params: unknown[] = []): Promise<any> {
    let lastErr = 'no RPC configured';
    for (let i = 0; i < this.urls.length; i++) {
      const k = (this.idx + i) % this.urls.length;
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
