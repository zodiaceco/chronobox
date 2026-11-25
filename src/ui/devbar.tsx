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
            {Array.from({ length: 10 }, (_, i) => (
              <option value={String(i)} key={i}>
                {i}
              </option>
            ))}
          </optgroup>
          <optgroup label="Real mainnet account, on the fork">
            {REAL.map((r) => (
              <option value={r.address} key={r.address}>
                {r.label}
              </option>
            ))}
            {account.startsWith("0x") && !REAL.some((r) => r.address === account) ? <option value={account}>{`${account.slice(0, 6)}…${account.slice(-4)}`}</option> : null}
          </optgroup>
        </select>
      </label>
    </aside>
  );
}
