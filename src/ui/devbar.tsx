/**
 * A bar for the dev server only: which kind of wallet the test wallet is.
 * The three kinds take different paths through the app:
 *   - plain:    one confirmation per step, no batching,
 *   - batching: a plain account that can send several calls as one (EIP-5792),
 *   - safe:     a Safe as the wallet, which batches too.
 * The choice lives in the address of the page (?wallet=), which the test wallet
 * reads when the page loads. So a change loads the page again.
 */
const KINDS = [
  { id: "plain", label: "Plain", hint: "An account without batching: one confirmation per step" },
  { id: "batch", label: "Batching", hint: "An account that sends several calls as one (EIP-5792)" },
  { id: "safe", label: "Safe", hint: "A Safe as the wallet. It batches too" },
] as const;

export function DevBar() {
  const params = new URLSearchParams(location.search);
  const kind = params.get("wallet") ?? (params.get("safe") === "1" ? "safe" : "plain");
  const account = params.get("account") ?? "0";
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
        <select value={account} onChange={(event) => go((next) => next.set("account", (event.target as HTMLSelectElement).value))}>
          {Array.from({ length: 10 }, (_, i) => (
            <option value={String(i)} key={i}>
              {i}
            </option>
          ))}
        </select>
      </label>
    </aside>
  );
}
