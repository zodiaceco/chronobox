/**
 * Every state of the vault page, one link each, as the owner, the guardian or a stranger.
 * Only in the dev server: `npm run scenarios` puts the states on the local fork and writes the
 * list that this page reads. The test wallet acts as any address (?as=), and can misbehave on
 * purpose (?fault=), so each link shows the real page, read from the chain by the real code.
 */
import { useEffect, useState } from "preact/hooks";
import { shortAddress } from "../lib/format.ts";
import type { Address } from "../lib/hex.ts";

type Scenario = {
  id: string;
  title: string;
  about: string;
  safe: Address;
  roles: { owner: Address; guardian?: Address; viewer: Address };
  fault?: string;
};
type List = { run: string; chain: string; createdAt: string; scenarios: Scenario[] };

/** What the test wallet can do wrong. The names are the ones it knows. */
const FAULTS: { id: string; label: string }[] = [
  { id: "", label: "None" },
  { id: "slow", label: "Slow network" },
  { id: "queue", label: "The line cannot be read" },
  { id: "busy", label: "Rate limited" },
  { id: "down", label: "Network down" },
  { id: "nologs", label: "No old logs" },
  { id: "reject", label: "Wallet says no" },
  { id: "hang", label: "Wallet never answers" },
];

function href(as: string, hash: string, fault: string): string {
  const query = new URLSearchParams({ as });
  if (fault) query.set("fault", fault);
  return `/?${query}#${hash}`;
}

export function StatesPage() {
  const [list, setList] = useState<List | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fault, setFault] = useState("");

  useEffect(() => {
    fetch("/scenarios.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then(setList, () => setProblem("No scenarios yet."));
  }, []);

  return (
    <section class="page states">
      <h1>Every state of a Chronobox</h1>
      <p class="lead">Each link opens the real page, read from the local fork, as one of the wallets of that Chronobox.</p>
      {problem ? (
        <div class="states-empty">
          <p>{problem} With the fork running, make them:</p>
          <pre>
            npm run fork{"\n"}npm run scenarios
          </pre>
          <p class="hint">Then reload this page. Every run makes new vaults, so it can run again on the same fork.</p>
        </div>
      ) : null}
      {list ? (
        <>
          <label class="states-fault">
            <span>The network and the wallet</span>
            <select value={fault} onChange={(e) => setFault((e.target as HTMLSelectElement).value)}>
              {FAULTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <ul class="states-list">
            {list.scenarios.map((s) => {
              const use = s.fault ?? fault;
              const path = `/v/${list.chain}:${s.safe}`;
              const links: [string, string][] = [["Owner", s.roles.owner], ...(s.roles.guardian ? [["Guardian", s.roles.guardian] as [string, string]] : []), ["Stranger", s.roles.viewer]];
              return (
                <li key={s.id}>
                  <div>
                    <b>{s.title}</b>
                    <small>
                      {s.about}
                      {s.fault ? ` Always with the fault "${s.fault}".` : ""}
                    </small>
                    <small class="mono">{shortAddress(s.safe)}</small>
                  </div>
                  <span class="states-links">
                    {links.map(([label, as]) => (
                      <a key={label} class="button button-plain button-small" href={href(as, path, use)}>
                        {label}
                      </a>
                    ))}
                  </span>
                </li>
              );
            })}
            <li>
              <div>
                <b>The start and a new Chronobox</b>
                <small>As the first test wallet, which has coins on the fork.</small>
              </div>
              <span class="states-links">
                <a class="button button-plain button-small" href={`/?account=0${fault ? `&fault=${fault}` : ""}#/`}>
                  Start
                </a>
                <a class="button button-plain button-small" href={`/?account=0${fault ? `&fault=${fault}` : ""}#/new`}>
                  Create
                </a>
              </span>
            </li>
          </ul>
          <p class="hint">
            Made {new Date(list.createdAt).toLocaleString()} (run {list.run}). The fork's clock moves on: in a week, what waits now is ready. Run the scenarios again for
            fresh ones.
          </p>
        </>
      ) : null}
    </section>
  );
}
