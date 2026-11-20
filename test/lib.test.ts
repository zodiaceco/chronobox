import assert from "node:assert/strict";
import { test } from "node:test";
import { call, decode, encode, selector } from "../src/lib/abi.ts";
import { calendarFile } from "../src/lib/ics.ts";
import { formatAmount, formatDuration, formatUnits, parseUnits } from "../src/lib/format.ts";
import { checksum, keccak, parseAddress, utf8 } from "../src/lib/hex.ts";
import { addGuardianTx, councilSwapTx, predictCouncil, removeGuardianTx, CANCEL_ROLE, readBalances, cancelTx, usdToCoin, changeDelayTx, changeWalletTx, classify, delayTxHash, itemStatus, lockTx, predictDelay, predictRoles, predictSafe, withdrawalTx } from "../src/lib/chronobox.ts";

const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SAFE = "0x56020d8f8a39fCbE58c27ec287eE8e9805563b71";
const WEEK = 7n * 86_400n;

test("keccak and checksum match known vectors", () => {
  assert.equal(keccak("0x"), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak(utf8("abc")), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(checksum("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(parseAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB49"), null, "bad address");
  assert.equal(parseAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606Eb48"), null, "wrong checksum is rejected");
  assert.equal(parseAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
});

test("ABI encoding matches known calldata", () => {
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(
    call("transfer(address,uint256)", [WALLET, 1_000_000n]),
    "0xa9059cbb000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000000000000000000000000000000000000000f4240",
  );
  // Dynamic types: offsets, lengths and padding.
  assert.equal(
    encode(["uint256", "bytes", "address[]"], [1n, "0x1234", [WALLET]]),
    "0x" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000060" +
      "00000000000000000000000000000000000000000000000000000000000000a0" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "1234000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
  const types = ["address", "uint256", "bytes", "uint8", "address[]", "bool", "string"];
  const values = [WALLET, 2n ** 255n, "0x", 1n, [WALLET, SAFE], true, "USD₮0"];
  assert.deepEqual(decode(types, encode(types, values as any)), values);
  assert.throws(() => encode(["uint8"], [256n]));
  assert.throws(() => decode(["uint256"], "0x1234"));
  assert.throws(() => decode(["bytes"], "0x" + "f".repeat(64)));
});

test("amounts are exact", () => {
  assert.equal(parseUnits("1.5", 18), 1_500_000_000_000_000_000n);
  assert.equal(parseUnits("0.000001", 6), 1n);
  assert.equal(parseUnits("0.0000001", 6), null, "too many decimals");
  assert.equal(parseUnits("1e3", 6), null);
  assert.equal(parseUnits("-1", 6), null);
  assert.equal(parseUnits("", 6), null);
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits(parseUnits("123456.789", 18)!, 18), "123456.789");
  assert.equal(formatAmount(1_234_567_890_000n, 6), "1,234,567.89");
  assert.equal(formatAmount(1n, 18), "< 0.000001");
  assert.equal(formatAmount(0n, 18), "0");
});

test("durations read well", () => {
  assert.equal(formatDuration(WEEK), "7 days");
  assert.equal(formatDuration(12n * 3600n), "12 hours");
  assert.equal(formatDuration(86_400 + 3600), "1 day 1 hour");
  assert.equal(formatDuration(59), "59 seconds");
  assert.equal(formatDuration(-5), "0 seconds");
});

test("addresses are predicted as on the fork", () => {
  // The same values the fork test saw the real factories produce.
  assert.equal(predictSafe(WALLET, 0), SAFE);
  assert.equal(predictDelay(SAFE, WEEK, WEEK), "0x4Bc1F5bDd8ac14ffEc0e91441913E428579708f7");
  assert.notEqual(predictSafe(WALLET, 1), SAFE);
  assert.throws(() => lockTx(WALLET, SAFE, 0n));
});

test("only a transfer to the controller is a withdrawal", () => {
  const vault = { safe: SAFE, delay: "0x4Bc1F5bDd8ac14ffEc0e91441913E428579708f7", controller: WALLET } as const;
  const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  assert.deepEqual(classify(withdrawalTx(WALLET, null, 5n), vault), { kind: "withdraw", token: null, amount: 5n });
  assert.deepEqual(classify(withdrawalTx(WALLET, token, 5n), vault), { kind: "withdraw", token, amount: 5n });
  assert.equal(classify(withdrawalTx(other, null, 5n), vault).kind, "transfer-elsewhere");
  assert.equal(classify(withdrawalTx(other, token, 5n), vault).kind, "transfer-elsewhere");
  // A delegatecall is never a withdrawal, whatever the data says.
  assert.equal(classify({ ...withdrawalTx(WALLET, null, 5n), operation: 1 }, vault).kind, "unknown");
  // Value sent along with a token transfer is not a plain withdrawal.
  assert.equal(classify({ ...withdrawalTx(WALLET, token, 5n), value: 1n }, vault).kind, "unknown");
  // Extra calldata after the transfer arguments is not a plain withdrawal.
  const padded = withdrawalTx(WALLET, token, 5n);
  assert.equal(classify({ ...padded, data: `${padded.data}00` }, vault).kind, "unknown");
  assert.deepEqual(classify({ to: vault.delay, value: 0n, data: call("setTxCooldown(uint256)", [0n]), operation: 0 }, vault), {
    kind: "settings",
    label: "Changes the delay",
  });
  assert.equal(classify({ to: SAFE, value: 0n, data: "0xdeadbeef", operation: 0 }, vault).kind, "settings");
  assert.equal(classify({ to: token, value: 0n, data: call("approve(address,uint256)", [other, 1n]), operation: 0 }, vault).kind, "unknown");
});

test("the two settings changes are recognised, and only in their exact form", () => {
  const delay = predictDelay(SAFE, WEEK, WEEK);
  const vault = { safe: SAFE, delay, controller: WALLET } as const;
  const other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  assert.deepEqual(classify(changeDelayTx(delay, 86_400n), vault), { kind: "change-delay", cooldown: 86_400n });
  assert.throws(() => changeDelayTx(delay, 0n));
  // A delay of zero is never shown as a plain change.
  assert.equal(classify({ to: delay, value: 0n, data: call("setTxCooldown(uint256)", [0n]), operation: 0 }, vault).kind, "settings");
  const swap = changeWalletTx(delay, WALLET, other)!;
  assert.equal(swap.operation, 1);
  assert.deepEqual(classify(swap, vault), { kind: "change-wallet", to: other });
  assert.equal(changeWalletTx(delay, WALLET, WALLET), null);
  assert.equal(changeWalletTx(delay, WALLET, null), null);
  // A hand-over to the vault itself would lock it for ever. It is never shown as a clean hand-over.
  assert.equal(changeWalletTx(delay, WALLET, SAFE, null, SAFE), null);
  assert.equal(classify(changeWalletTx(delay, WALLET, SAFE)!, vault).kind, "unknown");
  // The same batch for another vault's Delay, or with extra bytes, is not a clean hand-over.
  assert.equal(classify(changeWalletTx(SAFE, WALLET, other)!, vault).kind, "unknown");
  assert.equal(classify({ ...swap, data: `${swap.data}00` }, vault).kind, "unknown");
  assert.equal(classify({ ...swap, operation: 0 }, vault).kind, "unknown");
  assert.notEqual(lockTx(WALLET, SAFE, WEEK).data, lockTx(WALLET, SAFE, 86_400n).data);
  // Cancel is one fixed role, and a hand-over moves it with the wallet.
  const roles = predictRoles(SAFE);
  assert.equal(CANCEL_ROLE, "0x63616e63656c0000000000000000000000000000000000000000000000000000");
  const cancel = cancelTx(roles, delay, 4n);
  assert.equal(cancel.to, roles);
  assert.ok(cancel.data.includes("46ba2307" + "5".padStart(64, "0")));
  const withRoles = { ...vault, roles };
  assert.deepEqual(classify(changeWalletTx(delay, WALLET, other, roles)!, withRoles), { kind: "change-wallet", to: other });
  assert.equal(classify(swap, withRoles).kind, "unknown", "a hand-over that leaves the cancel right behind");
  assert.equal(classify({ to: roles, value: 0n, data: "0x12345678", operation: 0 }, withRoles).kind, "settings");
  // bytes4 and mixed arrays.
  assert.equal(
    encode(["bytes4", "bool[]"], ["0x46ba2307", [true, false]]),
    "0x46ba230700000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000000",
  );
  assert.deepEqual(decode(["bytes4", "bool[]"], encode(["bytes4", "bool[]"], ["0x46ba2307", [true, false]])), ["0x46ba2307", [true, false]]);
  assert.throws(() => encode(["bytes4"], ["0x46ba23"]));
});

test("a contribution in dollars becomes the right amount of coin", () => {
  // $50 at $2,000 per ETH is 0.025 ETH. $5 where the coin is one dollar is 5 coins.
  assert.equal(usdToCoin(5000n, 2000_00000000n), 25_000_000_000_000_000n);
  assert.equal(usdToCoin(500n, 1_00000000n), 5n * 10n ** 18n);
  assert.equal(usdToCoin(1n, 1_00000000n), 10n ** 16n);
  assert.equal(usdToCoin(0n, 1814_05509781n), 0n);
});

test("queue item phases", () => {
  const item = { createdAt: 1000n };
  assert.equal(itemStatus(item, 100n, 50n, 1099n).phase, "waiting");
  assert.equal(itemStatus(item, 100n, 50n, 1100n).phase, "ready");
  assert.equal(itemStatus(item, 100n, 50n, 1150n).phase, "ready");
  assert.equal(itemStatus(item, 100n, 50n, 1151n).phase, "expired");
  assert.equal(itemStatus(item, 100n, 0n, 10n ** 12n).phase, "ready", "no expiration");
  assert.equal(delayTxHash(withdrawalTx(WALLET, null, 1n)).length, 66);
});

test("calendar file is well formed", () => {
  const text = calendarFile([{ uid: "a@chronobox", at: 1_800_000_000, title: "Ready; now", description: "Line 1\nLine 2" }], 1_799_000_000);
  assert.match(text, /BEGIN:VCALENDAR\r\n/);
  assert.match(text, /DTSTART:20270115T080000Z\r\n/);
  assert.ok(text.includes("SUMMARY:Ready" + String.fromCharCode(92) + "; now"), "semicolons are escaped");
  assert.ok(text.includes("DESCRIPTION:Line 1" + String.fromCharCode(92) + "nLine 2"), "line breaks are escaped");
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
});

test("many balances come from one read, and a failed read is not a balance of zero", async () => {
  const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
  // What Multicall3 answers for three calls: 5, a failed call, and an address with no token behind it.
  const entries = [w(1) + w(64) + w(32) + w(5), w(0) + w(64) + w(0), w(1) + w(64) + w(0)];
  const offsets = [96, 96 + 128, 96 + 128 + 96];
  const answer = "0x" + w(32) + w(3) + offsets.map(w).join("") + entries.join("");
  let requests = 0;
  const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const assets = [{ token: null, main: true }, { token: TOKEN, main: true }, { token: SAFE }] as const;
  const good = await readBalances(async () => (requests++, answer), WALLET, assets);
  assert.deepEqual(good, { balances: [5n, null, null], complete: true });
  assert.equal(requests, 1);

  // The network has no Multicall3: the main assets are read one by one, the others stay unknown.
  const without = await readBalances(
    async (method, params: any[] = []) => {
      if (method === "eth_getBalance") return "0x7";
      if (params[0].to === TOKEN) return "0x" + w(9);
      return "0x";
    },
    WALLET,
    assets,
  );
  assert.deepEqual(without, { balances: [7n, 9n, null], complete: false });
});

test("guardian changes are recognised, and nothing close to them is", () => {
  const delay = predictDelay(SAFE, WEEK, WEEK);
  const roles = predictRoles(SAFE);
  const guardian = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
  const next = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
  const plain = { safe: SAFE, delay, roles, controller: WALLET } as const;
  const council = predictCouncil(SAFE, WALLET, guardian);
  // The address of the shared Safe depends on the Chronobox, the wallet and the guardian, in that order.
  assert.notEqual(council, predictCouncil(SAFE, guardian, WALLET));
  assert.notEqual(council, predictCouncil(delay, WALLET, guardian));

  const adding = addGuardianTx(plain, guardian)!;
  assert.deepEqual(classify(adding, plain), { kind: "add-guardian", guardian });
  // As a plain call it does nothing, and it is not what this app builds.
  assert.equal(classify({ ...adding, operation: 0 }, plain).kind, "unknown");
  for (const bad of [WALLET, SAFE, delay, roles] as `0x${string}`[]) assert.equal(addGuardianTx(plain, bad), null);

  // The contract keeps its members newest first: the shared Safe, the guardian, the wallet.
  const guarded = { ...plain, guardian, council, members: [council, guardian, WALLET] as `0x${string}`[] };
  // With a guardian, the same batch is not "add a guardian" any more.
  assert.equal(classify(adding, guarded).kind, "unknown");
  assert.deepEqual(classify(removeGuardianTx(guarded)!, guarded), { kind: "remove-guardian", guardian });
  assert.equal(classify(removeGuardianTx(guarded)!, plain).kind, "unknown");
  const alone = changeWalletTx(delay, WALLET, next, roles, SAFE, guarded)!;
  assert.deepEqual(classify(alone, guarded), { kind: "change-wallet", to: next });
  // The hand-over of a Chronobox without a guardian leaves the shared Safe as it is, so it is not the right one here.
  assert.equal(classify(changeWalletTx(delay, WALLET, next, roles, SAFE)!, guarded).kind, "unknown");
  assert.equal(changeWalletTx(delay, WALLET, guardian, roles, SAFE, guarded), null);

  // Wallet and guardian together: never to the guardian, the shared Safe or the wallet itself.
  for (const bad of [WALLET, guardian, council, SAFE] as `0x${string}`[]) assert.equal(councilSwapTx(guarded, [WALLET, guardian], bad), null);
  assert.ok(councilSwapTx(guarded, [WALLET, guardian], next));
  assert.equal(councilSwapTx(guarded, [guardian], next), null, "the wallet must be an owner of the shared Safe");
});
