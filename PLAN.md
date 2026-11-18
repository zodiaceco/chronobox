# Zodiac Timebox: PoC plan

Status: PoC built 2026-11-17 (phases 0 to 3 in section 6). Fork-tested, not yet run with a real wallet or real funds. See README.md for how to run it. Not built yet: everything in section 7.

Changes from this plan while building:
- Toolchain: Node + esbuild instead of Deno (Node was already there and runs TypeScript directly). Runtime dependencies as planned: Preact and @noble/hashes.
- The vault address depends only on the wallet and a counter, so the app finds a wallet's vaults again on any device.
- The burn owner is 0x…dEaD (no key, no code), not a precompile address.
- Logo: Jo chose "Horizon dial" (brand/horizon-dial). The other three concepts stay in brand/concepts.html.
- Cancel is built (was section 7, item 1), on stock contracts: a Zodiac Roles v2 modifier with one frozen permission, setTxNonce on the Delay. The wallet can cancel, plus an optional guardian set at creation. The app proves the permission from the event history of the Roles contract. Not built from that item: on-chain destination limit, guardian replacement, recovery.
- Contribution added (Jo, 2026-11-17): a voluntary one-time payment in dollars ($50 suggested, "Donate less" shows $25, $10 and a free field where 0 is allowed), turned into the network's coin by a Chainlink feed and sent inside the lock transaction. The receiver address is not set yet, so a production build does not ask.
- Cancel restored (Jo, 2026-11-17): after the removal below, Jo asked for cancel again. It is back through the Roles modifier, owned by the Safe, and it moves with the wallet on a wallet change.
- Roles and cancel removed (Jo, 2026-11-17, later the same day): Jo wants only the Safe, the Delay and the setup wallet. The Delay lets the setup wallet queue any transaction, so the app now offers three queued actions: withdraw, change the delay, change the wallet. Nothing can be cancelled. Where this plan says "cancel" or "Roles", read it as history.
- Guardian removed (Jo, 2026-11-17): the optional second canceller and the idea of a recovery agent are out. Both add their own risks and few users have a good setup for a second key. Only the wallet can cancel, and the checks reject a vault where another address can. Where this plan says "guardian", read it as history.
- Updates: Jo did not like a consent prompt for updates (2026-11-17). The service worker and the prompt are gone. The page updates like a website, the footer shows version and build hash, the build stays reproducible, and a build can be pinned by hosting it at a fixed or content address. The earlier lines in this plan about an "immutable service worker" no longer apply.
- Known limit of cancel: any canceller can block all withdrawals for as long as it keeps cancelling. Recovery is the answer and is the next design step.

## 1. What it is

A vault that nobody can empty quickly. You connect a wallet, pick a delay (12 h, 1 day, 1 week, custom), and the app creates a Safe with no usable owner. The only way out is a Zodiac Delay modifier that your wallet controls. Every withdrawal waits the full delay on-chain. No person and no server can shorten it.

The promise in one line: **"Even with a gun to your head, you cannot move this money today."**

## 2. What the delay does and does not protect against

This shapes the whole product, so it comes first.

| Threat | Stock Safe + Delay | What closes the gap |
|---|---|---|
| Home invasion, attacker wants funds now | Stopped. Nothing leaves before the delay ends. | Nothing needed |
| Attacker forces you to queue a withdrawal, then leaves | Not stopped. The transfer executes after the delay. | Cancel by a second key (guardian) |
| Attacker steals the seed or device and queues a withdrawal later | Not stopped, only delayed. You hold the same key, so you cannot win a race. | Notification + guardian cancel |
| Phishing or a fake UI makes you queue a transfer to a wrong address | Delayed, not stopped | On-chain destination limit, notification |
| You lose the wallet | Funds are locked forever | Recovery address (later) |

Two consequences:

1. **A delay only buys time. Time is worth nothing unless somebody is told and somebody can act.** Notifications and a cancel path are the core of the product, not extras. The PoC proves the vault and the UX; the next phase must add "act".
2. In the stock Delay contract, only the Delay's owner can cancel (`setTxNonce` is `onlyOwner`). In our setup the owner is the Safe, so a cancel is itself delayed and sits behind the transfer in the queue. **The PoC has no cancel.** The copy must say so.

## 3. Contract design (PoC: zero new Solidity)

Only audited, already deployed contracts: Safe 1.4.1, SafeProxyFactory, MultiSend, Zodiac ModuleProxyFactory, Zodiac Delay. We write no contract, so there is nothing new to audit.

**End state**

- Safe: owner = burn address (no key, no code), threshold 1, one module = the Delay, no guard, no fallback handler.
- Delay: owner = avatar = target = the Safe. Cooldown = the chosen delay. Expiration = 7 days (see decision D5). One module = the connected wallet.
- Result: every change to the Safe or to the Delay (shorter cooldown, new module, new owner) must go through the Delay and waits the full cooldown.

**Setup in two wallet transactions** (verified against the sources)

A one-transaction setup is not possible with stock contracts: the Safe address depends on the Delay address and the reverse.

1. *Create*: `SafeProxyFactory.createProxyWithNonce`, owner = the wallet, 1/1. The Safe holds nothing yet.
2. *Lock*: the wallet calls `execTransaction` (pre-approved signature, no extra signing prompt) with a MultiSend batch: deploy the Delay, `safe.enableModule(delay)`, `delay.enableModule(wallet)`, `safe.swapOwner(wallet -> burn address)`.

The app shows the deposit address only after step 2 and after the check below is green.

**Verify, do not trust.** On every load the app reads the chain and checks: Safe singleton, owners, threshold, module list, guard slot, fallback handler slot, Delay master copy, Delay owner/avatar/target, Delay module list, cooldown, expiration. Any mismatch shows a red state and hides the deposit address. Any Timebox opens by URL (`#/eth:0x…`), so anyone can check anyone's vault.

**Delay facts that drive the UI** (read from `Delay.sol`)

- The queue is first in, first out. Only the head can execute.
- `executeNextTx` is public. Anyone can execute a transfer whose delay has passed. The wallet that queued it is not needed.
- After cooldown + expiration a transfer is dead. `skipExpired` is public.
- The wallet can queue any transaction, not only transfers (for example "set cooldown to 0"). It still waits the full delay, but the queue view and the notifier must decode and flag such entries loudly.

**"Withdraw only to the setup wallet"**

The stock Delay cannot enforce a destination. In the PoC the app builds only two transaction shapes (native transfer to the wallet, `token.transfer(wallet, amount)`) and the README says plainly that this is a UI rule, not a contract rule. For the threat model it is not load-bearing: an attacker who holds the key also holds the destination wallet. On-chain enforcement comes with the guardian phase (section 7).

## 4. App

**Principles**

- Static site, no backend, MIT, self-hostable. Hash routing, so paths never reach a server.
- Immutable service worker: files are content-hashed and precached; an update installs only after the user confirms. A hacked host cannot silently swap the code for existing users.
- `referrer: no-referrer`, no analytics, no third-party requests.
- One screen, one headline, two or three pill buttons, black and white, automatic dark mode.
- The user can rename the installed app and change its icon, so it does not look like a wallet on the home screen. Good fit for our threat model, later.
- Few dependencies, each chosen on its own merit.

**Stack (recommendation)**

- TypeScript, Preact (no transitive dependencies), `@noble/hashes` for keccak. Two runtime dependencies, both pinned.
- No viem, no wagmi, no WalletConnect in the PoC. Wallets connect through EIP-6963 / EIP-1193 (browser extensions and in-wallet mobile browsers). ABI encoding for the ten or so calls we need is hand-written and tested against known vectors.
- Build with Deno (TypeScript, bundle, lint, test in one binary, no `node_modules`). Fallback if `deno bundle` falls short: esbuild as the single dev dependency.
- **All chain reads go through the connected wallet's provider.** The page itself makes no network request, so the CSP can be `connect-src 'none'`. No RPC or API learns more than the wallet's own RPC already knows.
- No indexer. Balances: native + a short pinned token list per chain + "add token by address". Queue: `TransactionAdded` logs, with the block range narrowed by `txCreatedAt`, plus a local cache.
- Local state (known vaults, added tokens) in `localStorage`. A backup link restores it on another device.

**Screens**

1. *Start*: headline, Connect wallet.
2. *Create*: network, delay (12 h / 1 day / 1 week / custom), two transactions with a clear step indicator. Warning: "If you lose this wallet, the funds are lost."
3. *Timebox*: balance, deposit address + QR, verification state, queue.
4. *Withdraw*: token and amount only (destination is fixed). Confirmation, draft copy:
   > **This withdrawal takes 7 days.** Nobody can make it faster. Not you, not Zodiac, not a person who has your wallet. You can execute it from Tue 24 Nov, 19:04. It expires on Tue 1 Dec, 19:04. You cannot cancel it.
5. *Queue item*: Waiting (countdown + exact date), Ready (Execute button, expiry date), Executed, Expired (Skip).

Networks for the PoC: Sepolia and Gnosis for testing, then Ethereum, Base, Arbitrum. Addresses pinned in one file and checked by bytecode hash.

## 5. Notifications

What must be reported: a transaction was queued (the critical one), a queued item changes the timelock itself, ready to execute, about to expire, executed, deposit received.

Principles:

- The watcher needs only the vault address, which is public. No keys, no account.
- The sensitive link is person to vault (email, phone, IP). Default channels must not create it.
- Silence must be different from failure: watchers send a regular "all quiet" heartbeat.
- The alert must reach somebody other than the victim (partner, lawyer, friend).
- Turning notifications off must not be instant: either it takes the delay period, or it sends a last "notifications were turned off" alert to every channel.

Stages:

| Stage | What | Infra |
|---|---|---|
| N0, in PoC | In-app queue state, browser notification while the app is open, calendar file (.ics) for "ready" and "expires" | None |
| N1, in PoC | Self-hosted watcher: one Deno file, no dependencies, polls any RPC, posts to ntfy (self-hostable), a webhook, Matrix or Telegram. Runs on a Pi, a VPS or a cron job | The user's own |
| N2 | Hosted Zodiac watcher with Web Push: the app registers vault address + push subscription. No email, no account. Server stores a pseudonymous endpoint, payloads are end-to-end encrypted | Small service |
| N3 | Redundant and decentralized: several independent watcher operators, alerts published as encrypted Nostr events to many relays, optional contacts list, anyone can run a watcher from the same open-source file | Community |

Known limit: a web app cannot wake up by itself when it is closed. Real push needs a watcher somewhere. N1 gives that without trusting us.

## 6. Build phases

| Phase | Content | Done when |
|---|---|---|
| 0. Spike (about half a day) | Fork script (anvil): two-transaction setup, burn-owner test with every Safe signature type, early execute reverts, execute after time warp, expiry + skip. Toolchain check (Deno bundle, CSP with wallet-only reads, `eth_getLogs` through MetaMask and Rabby) | Script passes; stack confirmed or changed |
| 1. Core (2 to 3 days) | Connect, create + lock, verify, deposit, balances, withdraw with the strong message, queue, execute | Full flow on a fork in the browser, then on Gnosis with small funds |
| 2. Notifications N0 + N1 (about 1 day) | .ics, in-app alerts, watcher script with ntfy | A queued transfer on Gnosis raises a phone alert through a self-hosted watcher |
| 3. Hardening + open source (about 1 day) | Immutable service worker with update prompt, CSP, reproducible build + published hash, README with threat model and limits, MIT license, public repo | Fresh clone builds to the same hash |

Repo: new folder `zodiac-timebox/`, own git repo, local until you ask for a push.

## 7. After the PoC

1. **Guardian**: a second address (other device, other place, other person) that can cancel queued transfers at once but can never move funds. Needs either Roles in front of the Delay or one small custom module. The same step can enforce the destination on-chain and add a recovery address for a lost wallet. This is the design to get reviewed and audited.
2. Hosted push (N2), then Nostr and multi-operator (N3).
3. One-transaction setup through wallet batching (EIP-5792) where the wallet supports it.
4. Auto-execute relayer (possible because `executeNextTx` is public).
5. WalletConnect, IPFS hosting, app disguise (rename + icon).

## 8. Decisions for Jo

| # | Decision | Recommendation |
|---|---|---|
| D1 | PoC on stock contracts only, destination as a UI rule | Yes. Zero new Solidity is the strongest trust story for a first open-source release |
| D2 | Cancel / guardian in the PoC | No. First follow-up, with its own design review |
| D3 | Stack: Deno + Preact + noble (minimal) or the Zodiac house stack (Node, React, viem) | Deno + Preact + noble |
| D4 | Wallets: injected only in the PoC | Yes. WalletConnect later |
| D5 | Execution window after the delay ends | 7 days, fixed. A forgotten withdrawal lapses, which is the safe failure |
| D6 | Custom delay limits | Minimum 1 hour, maximum 90 days, warning above 30 days |
| D7 | Look: plain black and white with the Zodiac icon, or Zodiac app styling | Black and white with the Zodiac icon |

## 9. Risks to state openly

- Lost wallet = lost funds until a recovery path exists.
- The vault is publicly linked to the wallet that created it. Timebox protects against speed, not against being known. Funding from a KYC exchange links identity.
- Deterrence works only if attackers believe the delay. The public, verifiable setup is part of the product.
- A stolen key still wins after the delay in the PoC. The README must say this in the first screen of text.
