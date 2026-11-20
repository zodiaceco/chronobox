// The wallet and its network are not ours. These tests give the app a wallet that misbehaves.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnits, plainNumber } from "../src/lib/format.ts";
import { Replaced, StoppedWaiting, changeWalletTx, sendAndWait } from "../src/lib/chronobox.ts";
import { readFileSync } from "node:fs";
import { CHAINS, CONTRACTS } from "../src/lib/chains.ts";
import { parseTokenList, plainSymbol, publicRpc } from "../src/lib/lookup.ts";
import { BatchUnknown, type Provider, RpcTimeout, WalletMoved, assertWallet, errorText, isTemporary, rpcOf, canBatch, sendBatch } from "../src/lib/wallet.ts";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const HASH = "0x" + "ab".repeat(32);

function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

/** A provider made of one function per method. */
function provider(handlers: Record<string, (params: any[]) => unknown>): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      const handler = handlers[method];
      if (!handler) throw rpcError(-32601, `Method ${method} not found`);
      return handler((params ?? []) as any[]);
    },
  };
}

test("an amount that can be read in two ways is refused", () => {
  assert.equal(plainNumber("1,5"), "1.5");
  assert.equal(plainNumber("0,25"), "0.25");
  assert.equal(plainNumber("1,234,567.5"), "1234567.5");
  assert.equal(plainNumber("1,234,567"), "1234567");
  assert.equal(plainNumber("1 000.5"), "1000.5");
  assert.equal(plainNumber("1,000"), null, "one, or one thousand");
  assert.equal(plainNumber("12,500"), null);
  assert.equal(plainNumber("1,00,0"), null);
  assert.equal(parseUnits("1,000", 6), null);
  assert.equal(parseUnits("1,5", 6), 1_500_000n);
  assert.equal(parseUnits("1,000.00", 6), 1_000_000_000n);
  assert.equal(parseUnits("0,001", 6), 1_000n);
});

test("temporary failures are told from final ones", () => {
  assert.equal(isTemporary(new RpcTimeout("eth_call")), true);
  assert.equal(isTemporary(rpcError(-32005, "Request rate exceeded")), true);
  assert.equal(isTemporary(rpcError(-32603, "Internal JSON-RPC error: 503 Service Unavailable")), true);
  assert.equal(isTemporary(new TypeError("Failed to fetch")), true);
  assert.equal(isTemporary(rpcError(4001, "User rejected the request.")), false);
  assert.equal(isTemporary(rpcError(3, "execution reverted: Transaction is still in cooldown")), false);
  assert.equal(isTemporary(rpcError(-32000, "insufficient funds for gas * price + value")), false);
  assert.equal(isTemporary(rpcError(-32005, "query returned more than 10000 results"), "eth_getLogs"), false, "asking again does not help");
  assert.equal(isTemporary(rpcError(-32602, "eth_getLogs is limited to a 10,000 range"), "eth_getLogs"), false);
});

test("a read is tried again after a temporary failure, and a send is never repeated", async () => {
  let reads = 0;
  let sends = 0;
  const p = provider({
    eth_call: () => {
      if (++reads < 3) throw rpcError(-32005, "rate limit");
      return "0x01";
    },
    eth_sendTransaction: () => {
      sends++;
      throw rpcError(-32005, "rate limit");
    },
  });
  const rpc = rpcOf(p, { waitMs: 1 });
  assert.equal(await rpc("eth_call", [{}]), "0x01");
  assert.equal(reads, 3);
  await assert.rejects(rpc("eth_sendTransaction", [{}]));
  assert.equal(sends, 1, "the wallet may have sent it");
});

test("a read that gets no answer ends, and a revert is not tried again", async () => {
  let asked = 0;
  const silent = provider({ eth_getBalance: () => new Promise(() => undefined) });
  await assert.rejects(rpcOf(silent, { timeoutMs: 20, tries: 2, waitMs: 1 })("eth_getBalance", [A]), RpcTimeout);
  assert.equal(silent.calls.length, 2);
  const reverting = provider({
    eth_estimateGas: () => {
      asked++;
      throw rpcError(3, "execution reverted: Module transaction failed");
    },
  });
  await assert.rejects(rpcOf(reverting, { waitMs: 1 })("eth_estimateGas", [{}]));
  assert.equal(asked, 1);
});

test("the wallet is checked before something is sent", async () => {
  const on = (chain: string, account: string) => rpcOf(provider({ eth_chainId: () => chain, eth_accounts: () => [account] }));
  await assertWallet(on("0x1", A.toLowerCase()), A, 1);
  await assert.rejects(assertWallet(on("0x2105", A), A, 1, "Ethereum"), (e: Error) => e instanceof WalletMoved && /Ethereum/.test(e.message));
  await assert.rejects(assertWallet(on("0x1", B), A, 1), WalletMoved);
  await assert.rejects(assertWallet(rpcOf(provider({ eth_chainId: () => "0x1", eth_accounts: () => [] })), A, 1), WalletMoved);

  // On the wrong network nothing is estimated and nothing is sent.
  const p = provider({ eth_chainId: () => "0x89", eth_accounts: () => [A] });
  await assert.rejects(sendAndWait(rpcOf(p), A, { to: B, data: "0x" }, { chainId: 1 }), WalletMoved);
  assert.deepEqual(p.calls, ["eth_chainId"]);
});

test("a bad answer while waiting for a receipt is not a failure", async () => {
  let polls = 0;
  const p = provider({
    eth_estimateGas: () => "0x5208",
    eth_sendTransaction: () => HASH,
    eth_getTransactionReceipt: () => {
      polls++;
      if (polls <= 3) throw rpcError(4900, "The provider is disconnected from all chains.");
      return { transactionHash: HASH, blockNumber: "0x10", status: "0x1", logs: [] };
    },
    eth_getTransactionByHash: () => ({ nonce: "0x5" }),
  });
  const receipt = await sendAndWait(rpcOf(p, { waitMs: 1 }), A, { to: B, data: "0x" }, { pollMs: 5 });
  assert.equal(receipt.blockNumber, "0x10");
  assert.equal(p.calls.filter((m) => m === "eth_sendTransaction").length, 1);
});

test("a transaction that the wallet replaced is noticed", async () => {
  let asked = 0;
  const p = provider({
    eth_estimateGas: () => "0x5208",
    eth_sendTransaction: () => HASH,
    eth_getTransactionReceipt: () => null,
    // Known at first, then gone: the wallet sent another one with the same number.
    eth_getTransactionByHash: () => (++asked === 1 ? { nonce: "0x5" } : null),
    eth_getTransactionCount: () => "0x6",
  });
  await assert.rejects(sendAndWait(rpcOf(p, { waitMs: 1 }), A, { to: B, data: "0x" }, { pollMs: 5 }), Replaced);
});

test("a wait that never ends can be stopped, and a failed transaction says so", async () => {
  let stop = false;
  const p = provider({
    eth_estimateGas: () => "0x5208",
    eth_sendTransaction: () => HASH,
    eth_getTransactionReceipt: () => {
      stop = true;
      return null;
    },
  });
  await assert.rejects(sendAndWait(rpcOf(p), A, { to: B, data: "0x" }, { shouldStop: () => stop }), StoppedWaiting);

  const failed = provider({
    eth_estimateGas: () => "0x5208",
    eth_sendTransaction: () => HASH,
    eth_getTransactionReceipt: () => ({ transactionHash: HASH, blockNumber: "0x10", status: "0x0", logs: [] }),
  });
  await assert.rejects(sendAndWait(rpcOf(failed), A, { to: B, data: "0x" }), /failed on chain/);

  const noHash = provider({ eth_estimateGas: () => "0x5208", eth_sendTransaction: () => null });
  await assert.rejects(sendAndWait(rpcOf(noHash), A, { to: B, data: "0x" }), /did not confirm/);
});

test("a batch is not sent twice, and an unknown outcome is not called a failure", async () => {
  const calls = [{ to: B as any, data: "0x" as any, value: 1n }];
  // The wallet fails after the owner may have approved: no second request.
  const broken = provider({ wallet_sendCalls: () => { throw rpcError(-32603, "Internal error"); } });
  await assert.rejects(sendBatch(broken, A as any, 1, calls));
  assert.equal(broken.calls.filter((m) => m === "wallet_sendCalls").length, 1);

  // A wallet that only knows the first draft gets it.
  let versions: string[] = [];
  const old = provider({
    wallet_sendCalls: ([request]) => {
      versions.push(request.version);
      if (request.version !== "1.0") throw rpcError(-32602, "Invalid params: version");
      return "0xbatch";
    },
    wallet_getCallsStatus: () => ({ status: "CONFIRMED", receipts: [{ blockNumber: "0x10", status: "0x1" }] }),
  });
  assert.deepEqual(await sendBatch(old, A as any, 1, calls), { blockNumber: 16n });
  assert.deepEqual(versions, ["2.0.0", "1.0"]);

  // A batch that ran in part is not "nothing happened".
  const partly = provider({ wallet_sendCalls: () => ({ id: "0xbatch" }), wallet_getCallsStatus: () => ({ status: 600 }) });
  await assert.rejects(sendBatch(partly, A as any, 1, calls), BatchUnknown);

  const reverted = provider({ wallet_sendCalls: () => ({ id: "0xbatch" }), wallet_getCallsStatus: () => ({ status: 500 }) });
  await assert.rejects(sendBatch(reverted, A as any, 1, calls), /failed on chain/);

  // A call that only sends coin carries no data field.
  let sent: any = null;
  const strict = provider({
    wallet_sendCalls: ([request]) => {
      sent = request;
      return { id: "0xbatch" };
    },
    wallet_getCallsStatus: () => ({ status: 200, receipts: [{ blockNumber: "0x1", status: "0x1" }] }),
  });
  await sendBatch(strict, A as any, 1, calls);
  assert.equal("data" in sent.calls[0], false);
  assert.equal(sent.atomicRequired, true);
});

test("only a wallet that can batch today gets the setup in one confirmation", async () => {
  const answers = (answer: unknown) => provider({ wallet_getCapabilities: () => answer });
  // EIP-5792 as it is now, and the first draft of it.
  assert.equal(await canBatch(answers({ "0x1": { atomic: { status: "supported" } } }), A as any, 1), true);
  assert.equal(await canBatch(answers({ "0x1": { atomicBatch: { supported: true } } }), A as any, 1), true);
  // The answer is for this network only.
  assert.equal(await canBatch(answers({ "0x2105": { atomic: { status: "supported" } } }), A as any, 1), false);
  // A plain account that the wallet would first turn into a smart account takes two confirmations.
  assert.equal(await canBatch(answers({ "0x1": { atomic: { status: "ready" } } }), A as any, 1), false);
  assert.equal(await canBatch(answers({ "0x1": { atomic: { status: "unsupported" } } }), A as any, 1), false);
  assert.equal(await canBatch(answers(null), A as any, 1), false);
  // A wallet that does not know the method, and the question as it is asked.
  assert.equal(await canBatch(provider({}), A as any, 1), false);
  let asked: any[] = [];
  await canBatch(provider({ wallet_getCapabilities: (params) => ((asked = params), {}) }), A as any, 8453);
  assert.deepEqual(asked, [A, ["0x2105"]]);
});

test("errors reach the person in plain words", () => {
  const plain = (code: number | undefined, message: string) => errorText(code === undefined ? new Error(message) : rpcError(code, message));
  assert.match(plain(4001, "MetaMask Tx Signature: User denied transaction signature."), /You rejected/);
  assert.match(plain(-32002, "Request of type 'wallet_requestPermissions' already pending"), /already has a request open/);
  assert.match(plain(4900, "The provider is disconnected from all chains."), /not connected/);
  assert.match(plain(-32005, "Too Many Requests"), /busy/);
  assert.match(plain(-32000, "insufficient funds for gas * price + value: balance 0"), /does not have enough/);
  assert.match(plain(-32000, "nonce too low: next nonce 7, tx nonce 5"), /another transaction in progress/);
  assert.match(plain(3, "execution reverted: Transaction is still in cooldown"), /still waiting/);
  assert.match(plain(3, "execution reverted: Module transaction failed"), /cannot be carried out now/);
  assert.match(plain(-32603, "execution reverted"), /would fail on chain/);
  assert.match(plain(3, "execution reverted: Some new reason"), /would fail: Some new reason/);
  assert.match(errorText(new RpcTimeout("eth_call")), /did not answer in time/);
  assert.match(errorText(new WalletMoved("Your wallet is on another network now.")), /another network/);
  assert.match(errorText(new Replaced()), /replaced this transaction/);
  // A sentence the app wrote itself passes. What a node or a broken answer says does not.
  assert.equal(plain(undefined, "Your wallet has only 3 USDC."), "Your wallet has only 3 USDC.");
  assert.match(errorText(new SyntaxError("Cannot convert 0xzz to a BigInt")), /did not answer as expected/);
  assert.match(plain(-32603, "Internal JSON-RPC error. stack: at foo (bar.js:1)"), /did not answer as expected/);
  assert.match(errorText("weird"), /did not answer as expected/);
});

test("a Chronobox cannot be handed to an address that nobody can sign with", () => {
  const delay = "0x1111111111111111111111111111111111111111" as any;
  const roles = "0x2222222222222222222222222222222222222222" as any;
  const safe = "0x3333333333333333333333333333333333333333" as any;
  assert.notEqual(changeWalletTx(delay, A as any, B as any, roles, safe), null);
  for (const dead of [safe, delay, roles, CONTRACTS.burn, A, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000001"]) {
    assert.equal(changeWalletTx(delay, A as any, dead as any, roles, safe), null, dead);
  }
});

test("the balance lookup reads only, and takes nothing from an index on trust", async () => {
  // The page may talk to exactly the hosts of the lookup. The policy in index.html names each of them.
  const policy = /connect-src ([^;]+);/.exec(readFileSync(new URL("../src/index.html", import.meta.url), "utf8"))![1].split(" ");
  const wanted = CHAINS.flatMap((c) => [c.publicRpc, ...(c.indexer ? [c.indexer] : [])]).map((url) => new URL(url).origin);
  assert.deepEqual([...policy].sort(), [...new Set(wanted)].sort());

  // A public node is never asked to send anything.
  await assert.rejects(publicRpc(CHAINS[0])("eth_sendTransaction", [{}]), /not a read/);
  await assert.rejects(publicRpc(CHAINS[0])("eth_getLogs", [{}]), /not a read/);

  const token = (over: Record<string, unknown>, value: unknown = "5") => ({ token: { address_hash: B, type: "ERC-20", decimals: "6", symbol: "USDX", ...over }, value });
  assert.deepEqual(parseTokenList([token({})]), [{ address: B, symbol: "USDX", decimals: 6 }]);
  // An older index names the field "address".
  assert.equal(parseTokenList([{ token: { address: B, type: "ERC-20", decimals: "18", symbol: "T" }, value: "1" }]).length, 1);
  // Not a token with a balance, marked as a scam, the same address twice, or not a list at all.
  assert.deepEqual(parseTokenList([token({ type: "ERC-721" }), token({ reputation: "scam" }), token({}, "0"), token({ decimals: "99" }), token({ address_hash: "0x12" }), token({}, "x")]), []);
  assert.equal(parseTokenList([token({}), token({})]).length, 1);
  assert.deepEqual(parseTokenList({ items: [] }), []);
  assert.deepEqual(parseTokenList(null), []);
  // A name is somebody else's text.
  assert.equal(plainSymbol("US DC\u200b<b>"), "USDC<b>");
  assert.equal(plainSymbol("A".repeat(40)).length, 12);
  assert.equal(plainSymbol(7), "?");
});
