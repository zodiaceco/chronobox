# Chronobox key mechanism

*Draft for independent review, 2026-11-25. Model: [`chronobox.qnt`](chronobox.qnt) (Quint). Results: [`RESULTS.md`](RESULTS.md).*

This document describes who controls a Chronobox vault, how control moves when a key leaks or is lost, and which properties hold. It covers the **mechanism**: how stock contracts are wired together. It does not cover the contracts themselves. Safe 1.4.1, Zodiac Delay and Zodiac Roles are taken to behave as their documentation specifies (see "Contract behaviour assumed").

## Design goals

This is a game-theoretic problem: the setup is public onchain, so an attacker can work out in advance what pays off.

1. **Life before funds.** Nothing an attacker does to the owner may ever get them the funds: no coercion of any length, and no harm that keeps the owner from signing again. If hurting the owner cannot pay off, there is no reason to try.
2. **Lost before stolen.** Where funds cannot be kept reachable, they should end up blocked or lost, never with the attacker. A blocked vault pays the attacker nothing.

## Setups

All setups keep the funds in a **Vault Safe** whose only owner is `0x…dEaD` (no key), so the vault acts only through its modules.

**One setting: the delay.** Every queue waits the same delay. The app offers 24 h, 48 h (preselected), 7 days, 30 days or a custom length. The model is checked at 48 h and 72 h. Everything below is relative to it.

| | Simple | With guardian | With guardian + recovery |
|---|---|---|---|
| Keys | Hot wallet H | H and guardian G | H and G |
| Queue anything on the vault, including a guardian change | H, on Vault Delay, waits the delay | same | same |
| Cancel on Vault Delay | H, instantly | H or G, instantly (G's veto covers its own replacement) | same |
| Council Safe (H and G, both sign) | none | instant key swaps through its Roles role: modules of Vault Delay, members of Roles | same; its one module is the Recovery Delay |
| Take over without H | — | — | G queues on Recovery Delay, waits the recovery period (default 180 days, at least 30 in the app); H or G cancel |

This is the wiring that this repository deploys (`src/lib/chronobox.ts`). There is no separate queue for guardian changes: they wait in the Vault Delay like everything else.

**Minimum recovery wait.** The app offers at least 30 days. The contracts accept any wait, so a Chronobox configured outside the app may have a shorter one.

Recovery of a lost key is out of scope for the mechanism. "Hot wallet" and "guardian" are addresses, not necessarily single keys: either can itself be a Safe or another smart account with its own recovery or multi-signature setup. The mechanism then treats that account as one key.

What the Council can never do: move funds, change the vault's delay, add other modules, or change the Recovery Delay (the Vault owns it). Those always go through H's queue and wait the delay. So when the guardian key leaks with recovery on, the Council's instant swap removes it from the Council and the cancel role, but it stays the Recovery Delay's module until H's "replace guardian" runs one delay later. Until then it can queue a recovery, which H or the new guardian cancels.

A recovery runs as the Council Safe itself, through its module. The app's recovery is the Council's key swap, so it reverts if the Council no longer holds its Roles role. A hostile guardian can instead queue a plain owner swap of the Council, which works either way; the model allows the attacker that.

## Who is involved

- **Defender:** the owner and the guardian, cooperating and following the response plan below.
- **Attacker:** holds the keys a scenario gives it, and may do anything those keys allow, in any order, including acting first.
- A **leaked** key is a copy: both sides hold it. A **hostile** guardian: only the attacker holds G. A **lost** key: nobody holds it.

## Response plan

These are the defender's rules, highest priority first. The model checker found the second and third rules necessary; without them, the setups fail in ways the plan can avoid.

1. **Cancel** foreign items before their delay runs out.
2. **Swap leaked keys right away**, before anything else waits. An attacker who re-queues after every cancel would otherwise keep the defender busy forever.
3. **Never cancel past your own pending item when the attacker cannot cancel it.** A cancel (`setTxNonce`) drops every item up to a point. If the attacker keeps queueing behind your key swap, cancelling would also drop your swap. Let your item execute first (oldest first), then cancel what is behind it. Where the attacker *can* cancel your items, do the opposite and cancel everything. Otherwise the attacker cancels only your item and executes its own matured item in the same moment.
4. **Replace a guardian that is missing, hostile or leaked:** H queues "replace guardian", which waits the delay and replaces it everywhere, including on the Recovery Delay. A hostile guardian can cancel that; this is accepted (see Results).
5. **Execute your own ready items promptly.** Then withdraw.

## Properties

Each property is checked for every setup and scenario, over every reachable state up to three delays (TLC, exhaustive), with the delay at 48 h and at 72 h.

- **P1 No theft:** the attacker never receives the funds.
- **P2 Recovers:** by the end of one delay (with recovery: of the recovery period), only the defender holds keys with any power again.
- **P3 Can withdraw:** by the end of one delay after that, the defender has the funds out.

"By the end": time moves in whole days, and an item that becomes ready at the deadline runs in that moment. The checker requires that time cannot move past the deadline before the property holds.

## Results

Generated by `npm run compare` (✅ holds in every reachable state; ❌ the checker found a counterexample, written to `results/` when you run it). The same holds with a 72 h delay (`RESULTS-72h.md`).

| Scenario | Simple | With guardian | With guardian + recovery |
|---|---|---|---|
| No incident | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw |
| Coercion (forced to sign with H, released with a day left to cancel) | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw |
| Hot key leaked | ✅ safe<br>❌ recovers<br>❌ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw |
| Hot key taken (only the attacker has it: long coercion, stolen without a backup, or the owner can never sign again) | ❌ safe<br>❌ recovers<br>❌ can withdraw | ✅ safe<br>❌ recovers<br>❌ can withdraw | ✅ safe<br>❌ recovers<br>❌ can withdraw |
| Hot key lost | ✅ safe<br>❌ recovers<br>❌ can withdraw | ✅ safe<br>❌ recovers<br>❌ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw |
| Guardian key leaked (a copy: the guardian still has it) | n/a | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw |
| Guardian hostile (only they hold the key) | n/a | ✅ safe<br>❌ recovers<br>❌ can withdraw | ✅ safe<br>❌ recovers<br>❌ can withdraw |
| Guardian lost | n/a | ✅ safe<br>✅ recovers<br>✅ can withdraw | ✅ safe<br>✅ recovers<br>✅ can withdraw |
| Guardian hostile and hot key lost | n/a | ✅ safe<br>❌ recovers<br>❌ can withdraw | ❌ safe<br>❌ recovers<br>❌ can withdraw |
| Both keys leaked | n/a | ❌ safe<br>❌ recovers<br>❌ can withdraw | ❌ safe<br>❌ recovers<br>❌ can withdraw |

How to read the failures:
- **Stalemate:** nobody can take the funds, and the defender cannot get them out either. The attacker can keep it going at the cost of gas.
- **Lost:** nobody holds the key, so the funds stay locked for good. Recovery is out of scope.
- **Theft:** the attacker can get the funds.

Each ❌ comes with a counterexample trace in `results/` after a run.

## Contract behaviour assumed

- **Zodiac Delay:**
  - Modules queue transactions.
  - Anyone executes the **oldest** item once `now − createdAt ≥ cooldown` and before `cooldown + expiration`. The cooldown that counts is the one at execution time.
  - Only the owner cancels, with `setTxNonce`, which drops a **prefix** of the queue.
  - Expired items can be skipped by anyone.
  - Removing a module does not remove its queued items.
- **The model keeps every right separate, as on chain:** the Vault Delay's module (the hot wallet), the members of the cancel role, the Council's owners, and the Recovery Delay's module. Each changes only through the call that changes it on chain.
- **Zodiac Roles:** a member can make exactly the calls its role allows.
  - The cancel role (H, G) allows `setTxNonce` on the Vault Delay, and with recovery on the Recovery Delay.
  - The Council's role allows `enableModule` / `disableModule` on the Vault Delay and `assignRoles` / `disableModule` on Roles. That is enough to replace keys, and to give itself the cancel role for one step.
- **Safe:** owners at the threshold act at once; modules act as the Safe.

## Abstractions, and what they leave out

- **Time** moves in whole days; the delay is a multiple of a day. "Before the delay runs out" means at the latest on the last day before an item becomes executable.
- **Funds:** the vault holds one balance and pays it out at once. Partial withdrawals don't change who can act.
- **Queued transactions** are reduced to the ones that matter for control: payout, delay change, removal of the Council's role, key swaps.
- **Recovery period:** modelled as four delays. What the properties depend on is only that it is longer than the delay. Its 30-day execution window is modelled like the Vault Delay's 7 days; both are longer than the time the model covers.
- **Queues** hold at most two items. Longer queues add no new behaviour, because a cancel drops a prefix either way.
- **Not modelled:**
  - **Alert delivery:** the plan assumes the defender learns about every item well within the delay.
  - **Gas and fees.**
  - **The guardian's location:** it's an assumption that a coercer can't reach the guardian.
  - **Social engineering of the guardian.**
  - **The contracts' own bugs.**

## Check it yourself

```sh
cd spec
npm ci
npm run typecheck
npm run compare          # needs Java 17+ on PATH; about 2 minutes; writes RESULTS.md and results/
node compare.mjs 72      # the same with a 72 h delay; writes RESULTS-72h.md
npx quint verify chronobox.qnt --backend=tlc \
  --init=init_guardianVeto_bothKeys --step=step --invariant=noTheft   # one check, with its counterexample
```

**How to review:**
- Change the delay (`node compare.mjs <hours>`) or the response plan in `defense`, and re-run.
- Add a scenario as one more `init_*` action, then add it to `compare.mjs`.
- The setups are named `simple`, `guardianVeto` (with guardian) and `guardianRecovery` in the model.

