# Zodiac Chronobox

A vault that nobody can empty quickly.

You connect a wallet, pick a delay (12 hours, 1 day, 1 week or your own), and Chronobox creates a Safe that has no owner. The only way out is a time lock that your wallet controls. Every withdrawal waits the full delay on chain. Nobody can make it faster: not you, not Zodiac, not a person who has your wallet.

**Status: proof of concept.** Tested on a local fork of Ethereum mainnet. Not yet run with real funds. Read "Limits" before you use it.

## Why

People who hold crypto are targets. Leaked customer lists and tax data put names and addresses next to balances, and home invasions follow. An attacker in your home wants the funds now. If the funds cannot move today, the attack has no payoff.

## How it works

Chronobox adds no contract of its own. It uses contracts that are audited and already deployed at the same addresses on every supported chain:

| Contract | Address |
|---|---|
| SafeProxyFactory 1.4.1 | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |
| SafeL2 1.4.1 | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` |
| MultiSend 1.4.1 | `0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526` |
| Zodiac ModuleProxyFactory | `0x000000000000aDdB49795b0f9bA5BC298cDda236` |
| Zodiac Delay | `0xd54895B1121A2eE3f37b502F507631FA1331BED6` |
| Zodiac Roles 2.1.1 | `0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5` |

A finished Chronobox has four parts:

- **Your setup wallet**: the control unit. It is the only module of the Delay. It can queue any transaction, and it can cancel what is in the queue.
- **Delay**: the only way to move funds or to change the vault. Owner, avatar and target are the Safe. The cooldown is the delay you picked. A queued transaction can be executed for 7 days after the cooldown, then it expires.
- **Roles**: the cancel permission. A Zodiac Roles modifier (2.1.1) on the Safe with one rule: your wallet may call `setTxNonce` on the Delay. It cannot move funds and it cannot change the delay. Its owner is the Safe, so the rule can only change through the Delay.
- **Safe**: holds the funds. The owner is `0x…dEaD`, an address with no key and no code. No guard, no fallback handler.

So everything waits the full delay: a withdrawal, a new delay, a new wallet. One thing does not wait: cancel, and a cancel moves nothing.

Setup takes two transactions from your wallet:

1. **Create** a 1 of 1 Safe owned by your wallet.
2. **Lock**: one Safe transaction deploys the Delay and the cancel permission, enables them, makes your wallet the only module of the Delay, and replaces your wallet as owner with the burn address. All of it happens together or not at all.

### The contribution

The hosted app can ask for a one-time contribution when a Chronobox is created. It is voluntary: the suggested amount is selected, "Donate less" shows lower amounts and a free field, and 0 is allowed. Chronobox is free software, and anybody can run it without this.

- The amount is in US dollars. The app turns it into the coin of the network with a Chainlink price feed, which it reads through the wallet. If there is no fresh price, the app does not ask.
- The coin rides in the lock transaction: the wallet sends it along, and the same batch that locks the vault passes it on. Either the vault is locked and the contribution arrives, or neither happens. A plain wallet gets no third prompt.
- The receiver is `CONTRIBUTION_RECEIVER` in `src/lib/chains.ts`. It is `null` in the source, so a build asks for nothing until somebody sets it. The amounts are in `CONTRIBUTION_USD`.
- All contributions go to one address, so that address is a public list of vaults that contributed.

### Cancel, and why it needs a second contract

In the Delay, only the owner can remove a queued transaction (`setTxNonce`). The owner can also set the delay to zero and add wallets, at once. So the setup wallet must not be the owner: the owner is the Safe, and the Safe acts only through the queue.

To give the setup wallet cancel and nothing else, a Zodiac Roles modifier sits beside the Delay as a second module of the Safe. It has one permission: the setup wallet can make the Safe call `setTxNonce` on the Delay. Its owner is the Safe, so the permission can change only through the queue.

- The queue is first in, first out. A cancel removes one item and every item before it.
- Cancel cannot move funds, change the delay, or add anybody.

The Roles contract has no function that lists its permissions, so the app proves "cancel only" from the contract's whole event history: it accepts only the exact cancel setup, with the setup wallet as the one member. This needs old logs. If the wallet's RPC does not serve them, the vault shows as **unverified**: withdrawals and cancel work, but the app tells you not to deposit until the check passes.

### What the setup wallet can queue

The Delay lets the setup wallet queue any transaction. The app builds three, and shows anything else in the queue with a warning:

- **Withdraw**: funds go back to the setup wallet.
- **Change the delay**: the Safe calls `setTxCooldown` on the Delay.
- **Change the wallet**: the Safe enables the new wallet on the Delay and disables the old one, and moves the right to cancel the same way, in one step. After it executes, only the new wallet controls the vault. The new wallet does not find the vault by itself, so keep its address.

### One transaction for wallets that can batch

Some wallets can send several calls as one transaction: a Safe, or an account with EIP-7702 code. The app asks the wallet (`wallet_getCapabilities`, EIP-5792). If the answer is yes, the create screen sends create, lock and any number of deposits as one atomic batch (`wallet_sendCalls`). If one part fails, nothing happens. About 1,000,000 gas with two deposits. Other wallets keep the two-transaction setup. That includes a plain account that the wallet offers to upgrade to a smart account (status `ready`): the app does not start that upgrade.

This is detected, not configured. It was tested on the fork with a Safe as the wallet and in the browser with a test wallet that acts as a Safe. It was not tested with Rabby, Zodiac Pilot, Safe{Wallet} or a MetaMask smart account. With a Safe as the wallet, withdrawals go back to the Safe, and a cancel is only as fast as the Safe's signers.

The app shows the deposit address only after it has checked the finished vault on chain. It runs the same checks every time you open a vault, and anybody can open any vault by address.

The address of your nth vault depends only on your wallet address and n. The app finds your vaults again on any device, without a server.

## Limits

Read these. They are the honest edge of what a delay can do.

- **A stolen key is a standoff, not a loss.** A person who has your wallet can queue a withdrawal, a shorter delay or a new wallet. You can cancel it while it waits. They can queue again, and you can cancel again. This works only if you see it in time, so look at your Chronobox regularly.
- **A stolen key can block.** A person who has your wallet can also cancel your withdrawals, again and again. Then the funds are frozen. Frozen funds are better than lost funds.
- **One wallet.** There is no second key, no guardian and no recovery.
- **The destination is a rule of this app, not of the contract.** This app builds only withdrawals to the wallet that controls the vault. The Delay itself lets that wallet queue any transaction. Other queued transactions show up in the queue with a warning, and can be cancelled.
- **Lost wallet, lost funds.** There is no recovery.
- **The vault is public.** It is linked on chain to the wallet that created it. Chronobox protects against speed, not against being known.
- **No alerts.** A web page cannot wake up when it is closed, and this version has no alert service. Use the calendar file (below), and look at your Chronobox regularly.



## Privacy

- No server, no account, no analytics.
- The production page makes no network requests. The Content Security Policy is `connect-src 'none'`. All chain data comes through your wallet, so no extra party learns which vault you look at.
- Wallets connect through EIP-6963 in the page. There is no WalletConnect relay.
- No service worker and no update prompt. See "Updates" below.

## Get told: calendar

Each queued withdrawal has an **Add to calendar** link: one reminder when it becomes ready, one before it expires. Many calendars copy their entries to a cloud, so the file holds no amount, no address and no link.

Alerts to a phone when something is queued are not part of this version yet.

## Run it

Needs Node 22.18 or later.

```bash
npm ci --ignore-scripts
npm run dev          # http://localhost:3130, with a test wallet for a local fork
npm run fork         # in a second terminal: anvil fork of Ethereum mainnet on :8545
```

The dev build injects a test wallet ("Anvil test wallet") that signs with anvil's unlocked accounts. Add `?account=1` for another account, or `?safe=1` to make it act as a Safe that can batch. It does not exist in the production build. In the browser console, `__anvil.warp(seconds)` moves the fork's clock.

```bash
npm test             # unit tests
npm run test:fork    # the full flow against the real contracts on the fork
npm run check        # TypeScript
npm run build        # production build in out/, prints the build hash
```

`npm run test:fork` proves, against the deployed contracts:

- the predicted addresses, both setup transactions and every check
- nobody can act as owner (five signature types), and the wallet cannot change the Delay directly
- through the Roles modifier the wallet can cancel and nothing else (nine other attempts fail)
- deposit, queue, early execution fails, execution after the delay, cancel, expiry and skip
- a change of the delay and a change of the wallet, each after its own wait; the old wallet can then neither queue nor cancel, and the new one can
- a contribution sent with the lock transaction arrives, and the vault stays empty
- a Safe as the wallet: create, lock and two deposits in one transaction; a batch that cannot pay its deposit creates nothing
- ten tampered setups (for example a second module, a second wallet that can queue, a hidden second role, a second address that can cancel, a delay of zero, a guard on the Delay) are all rejected by the checks
- a vault is "unverified", not "locked", when the RPC cannot serve the event history

## Updates

The page updates like any website: you get the current version when you open it. There is no update prompt.

An earlier version asked for consent before each update. That was removed. A prompt cannot stop a host that has been taken over, because the browser always lets the host replace the code that shows the prompt. It only slowed down honest fixes. Chronobox also holds no keys: every transaction is signed in your wallet.

What you get instead:

- **The footer shows the version and the first 8 characters of the build hash.** After an update it also says "updated since your last visit".
- **The build is reproducible.** `npm run build` prints one build hash and writes `out/build.json` with the sha256 of every file. Two people who build the same commit get the same hash, so anybody can check that a site serves the published code.
- **You can pin a version.** A build is a folder of static files with relative paths. It works from any address: your own server, a folder on a server, or IPFS. A copy at an address that you control, or at a content address, changes only when you change it.

The build hash is the sha256 over the sorted lines `<path> <sha256>` of every file in `out/` except `build.json`, with `index.html` hashed while it still has the placeholder `__BUILD_HASH__` where the hash goes. `build.mjs` explains why.

## Host it

`out/` is the whole site. `out/_headers` sets the response headers on Netlify and Cloudflare Pages. On another host, set the same headers yourself:

- `index.html` must not be cached (`Cache-Control: no-cache`), so that a fix reaches people on their next visit. The files in `assets/` have a content hash in the name and can be cached for ever.
- `Content-Security-Policy: frame-ancestors 'none'` stops other sites from showing Chronobox in a frame. This one cannot be set from inside the page.

A possible later step: publish each release on IPFS under an ENS name whose content can be changed only through a Zodiac Delay. Then every update is public and waits before it goes live.

### A private preview on Netlify

`netlify.toml` builds the app and `netlify/edge-functions/gate.ts` puts a password page in front of every file. Set `CHRONOBOX_PASSWORD` in the site's environment variables. Without it the site serves nothing. To change the password, change the variable; that signs everyone out. The gate protects the preview only. The app still has no account and no server.

## Tokens

A Chronobox can hold any ERC-20 token. The app shows the ones it knows:

- The main tokens of each network, in `src/lib/chains.ts`. The pickers always show these.
- A long list for each network, in `src/lib/token-list.ts`. A token from it shows only when your Chronobox or your wallet holds some.
- Tokens that you add by their address. Your browser remembers them.

The app reads all balances in a few requests through your wallet, with the Multicall3 contract. It does not ask a token service, so nobody learns which address you look at. A token that is in none of the lists is not shown until you add it. It is still in your Chronobox.

`npm run tokens:list -- <tokens.json>` writes the long list again from a ranked list of tokens and checks each one against the real chain. `npm run test:tokens` checks the main tokens.

## Dependencies

Runtime: `preact` (UI), `@noble/hashes` (keccak-256) and `qrcode-generator` (the QR code of the deposit address). None has dependencies of its own, and all are pinned to exact versions.

Development: `esbuild`, `typescript`, `@types/node`, `@foundry-rs/anvil`.

The ABI encoder, the wallet connection and the dev server are small files in this repository, written for exactly what Chronobox needs.

## Layout

```
src/lib/chronobox.ts   setup transactions, checks, queue, withdrawals
src/lib/abi.ts       minimal ABI encoder and decoder
src/lib/chains.ts    contract addresses, networks, main tokens
src/lib/token-list.ts  the long token list (written by tools/token-list.ts)
src/lib/wallet.ts    EIP-6963 discovery, EIP-1193 wrapper
src/ui/              screens
build.mjs            build, dev server, build hash
test/fork.ts         end-to-end proof on a fork
brand/               logo concepts
```

## License

MIT. See `LICENSE`.
