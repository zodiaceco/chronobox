/**
 * A bar for the dev server only: which kind of wallet the test wallet is, and
 * which account it has.
 *
 * The three kinds take different paths through the app:
 *   - plain:    one confirmation per step, no batching,
 *   - batching: a plain account that can send several calls as one (EIP-5792),
 *   - safe:     a Safe as the wallet, which batches too.
 *
 * The account is one of anvil's own (empty but for test ETH), or a real account
 * of Ethereum mainnet that the fork lets the test wallet act as. A real account
 * has real tokens, so the list has something to show, and the third-party
 * lookup finds the same tokens that the fork holds. Nothing here touches the
 * real account: every transaction stays on the local fork.
 *
 * The choice lives in the address of the page (?wallet=, ?account=, ?as=), which
 * the test wallet reads when the page loads. So a change loads the page again.
 */
import "../devbar.css";
import { useEffect, useState } from "preact/hooks";
import { chainById } from "../lib/chains.ts";
import { type Rpc, chronoboxOf, inspect, predictSafe, queueLength, readBalances } from "../lib/chronobox.ts";
import { shortAmount } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";

import { ANVIL_ACCOUNTS, SAFE_INDEX } from "../dev-accounts.ts";
import { assetsOf } from "./common.tsx";

/** The local fork, asked directly: the dev bar must not wait for, or disturb, the test wallet. */
const fork: Rpc = async (method, params = []) => {
  const res = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const out = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (out.error) throw new Error(out.error.message);
  return out.result;
};

/**
 * What an account's Chronobox is like on the fork, in a few words: none, a setup that stopped,
 * empty, or what is locked in it, and how many withdrawals wait.
 */
async function stateOf(wallet: Address): Promise<string> {
  const safe = chronoboxOf(wallet);
  const code = (await fork("eth_getCode", [safe, "latest"])) as string;
  if (!code || code === "0x") return "no Chronobox";
  const inspection = await inspect(fork, safe);
  if (inspection.state === "open") return "setup not finished";
  if (inspection.state === "invalid" || inspection.state === "missing") return "Chronobox, needs a look";
  const chain = chainById(1);
  const assets = chain ? assetsOf(chain).filter((a) => a.main) : [];
  const { balances } = await readBalances(fork, safe, assets);
  const held = assets.map((a, i) => ({ a, b: balances[i] ?? 0n })).filter((h) => h.b > 0n);
  const locked = held.length === 0 ? "empty" : `${held.map((h) => `${shortAmount(h.b, h.a.decimals, 2)} ${h.a.symbol}`).join(", ")} locked`;
  const waiting = queueLength(inspection);
  return `Chronobox, ${locked}${waiting > 0n ? `, ${waiting} waiting` : ""}`;
}

/** The address the test wallet acts as, for a choice in the list and the kind of wallet. */
function walletOf(choice: string, kind: string): Address | null {
  const owner = choice.startsWith("0x") ? (choice as Address) : (ANVIL_ACCOUNTS[Number(choice)] as Address | undefined);
  if (!owner) return null;
  return kind === "safe" ? predictSafe(owner, SAFE_INDEX) : owner;
}

const KINDS = [
  { id: "plain", label: "Plain", hint: "An account without batching: one confirmation per step" },
  { id: "batch", label: "Batching", hint: "An account that sends several calls as one (EIP-5792)" },
  { id: "safe", label: "Safe", hint: "A Safe as the wallet. It batches too" },
] as const;

/** Plain accounts of mainnet with ETH and tokens, and how long the token index took for each (20 Nov 2026). */
const REAL = [
  { address: "0x5555763613a12D8F3e73be831DFf8598089d3dCa", label: "0x5555…3dCa · 85 tokens" },
  { address: "0x983110309620D911731Ac0932219af06091b6744", label: "0x9831…6744 · 208 tokens" },
  { address: "0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5", label: "0xb8c2…67d5 · 309 tokens" },
  { address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B", label: "0xAb58…eC9B · 3,982 tokens, slow index" },
] as const;

export function DevBar() {
  const params = new URLSearchParams(location.search);
  const kind = params.get("wallet") ?? (params.get("safe") === "1" ? "safe" : "plain");
  const account = params.get("as") ?? params.get("account") ?? "0";
  // The state of every account's Chronobox, read from the fork when the bar opens.
  const choices = [...ANVIL_ACCOUNTS.map((_, i) => String(i)), ...REAL.map((r) => r.address)];
  const [states, setStates] = useState<Record<string, string>>({});
  useEffect(() => {
    let stale = false;
    for (const choice of choices) {
      const wallet = walletOf(choice, kind);
      if (!wallet) continue;
      stateOf(wallet).then(
        (text) => !stale && setStates((all) => ({ ...all, [choice]: text })),
        () => !stale && setStates((all) => ({ ...all, [choice]: "could not read" })),
      );
    }
    return () => {
      stale = true;
    };
  }, [kind]);
  const named = (choice: string, base: string) => `${base} · ${states[choice] ?? "…"}`;
  const go = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(location.search);
    next.delete("safe");
    change(next);
    const query = next.toString();
    location.assign(`${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  };
  return (
    <aside class="devbar" aria-label="Dev tools">
      <span class="devbar-tag">Dev</span>
      <span class="devbar-label">Test wallet</span>
      <div class="devbar-kinds" role="radiogroup" aria-label="Kind of test wallet">
        {KINDS.map((k) => (
          <button type="button" role="radio" aria-checked={kind === k.id} title={k.hint} class={kind === k.id ? "devbar-kind devbar-kind-on" : "devbar-kind"} key={k.id} onClick={() => go((next) => next.set("wallet", k.id))}>
            {k.label}
          </button>
        ))}
      </div>
      <label class="devbar-account">
        Account
        <select
          value={account}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value;
            go((next) => {
              next.delete("as");
              next.delete("account");
              if (value.startsWith("0x")) next.set("as", value);
              else next.set("account", value);
            });
          }}
        >
          <optgroup label="Anvil, test ETH only">
            {ANVIL_ACCOUNTS.map((_, i) => (
              <option value={String(i)} key={i}>
                {named(String(i), kind === "safe" ? `Safe of ${i}` : String(i))}
              </option>
            ))}
          </optgroup>
          <optgroup label="Real mainnet account, on the fork">
            {REAL.map((r) => (
              <option value={r.address} key={r.address}>
                {named(r.address, kind === "safe" ? `Safe of ${r.label}` : r.label)}
              </option>
            ))}
            {account.startsWith("0x") && !REAL.some((r) => r.address === account) ? <option value={account}>{`${account.slice(0, 6)}…${account.slice(-4)}`}</option> : null}
          </optgroup>
        </select>
      </label>
    </aside>
  );
}
