# Zodiac Chronobox

A vault that nobody can empty quickly.

You connect a wallet, pick a delay (24 hours, 48 hours, 7 days, 30 days or your own; 48 hours unless you choose another), and Chronobox creates a Safe that has no owner. The only way out is a time lock that your wallet controls. Every withdrawal waits the full delay on chain. Nobody can make it faster: not you, not Zodiac, not a person who has your wallet.

**Status: experimental.** The contracts it uses are audited. This app is not. Read "Limits" before you use it.

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
| SafeModuleSetup 0.3.0 (only with the recovery) | `0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47` |

A finished Chronobox has four parts:

- **Your hot wallet**: the control unit. It is the only module of the Vault Delay. It can queue any transaction, and it can cancel what is in the queue.
- **Vault Delay**: the only way to move funds or to change the vault. Owner, avatar and target are the Safe. The cooldown is the delay you picked. A queued transaction can be executed for 7 days after the cooldown, then it expires.
- **Roles**: the cancel permission. A Zodiac Roles modifier (2.1.1) on the Safe with one rule: your wallet may call `setTxNonce` on the Vault Delay. An optional guardian adds a second rule (see below). It cannot move funds and it cannot change the delay. Its owner is the Safe, so the rule can only change through the Vault Delay.
- **Safe**: holds the funds. The owner is `0x…dEaD`, an address with no key and no code. No guard, no fallback handler.

So everything waits the full delay: a withdrawal, a new delay, a new wallet. One thing does not wait: cancel, and a cancel moves nothing.

Setup takes two transactions from your wallet:

1. **Create** a 1 of 1 Safe owned by your wallet.
2. **Lock**: one Safe transaction deploys the Vault Delay and the cancel permission, enables them, makes your wallet the only module of the Vault Delay, and replaces your wallet as owner with the burn address. All of it happens together or not at all.

### The contribution

The hosted app can ask for a one-time contribution when a Chronobox is created. It is voluntary: the suggested amount is selected, "Change" shows lower amounts (down to nothing) and one larger amount, and 0 is allowed. Chronobox is free software, and anybody can run it without this.

- The amount is in US dollars. The app turns it into the coin of the network with a Chainlink price feed, which it reads through the wallet. If there is no fresh price, the app does not ask. On a test network it does not ask either.
- The coin rides in the lock transaction: the wallet sends it along, and the same batch that locks the vault passes it on. Either the vault is locked and the contribution arrives, or neither happens. A plain wallet gets no third prompt.
- The receiver is `CONTRIBUTION_RECEIVER` in `src/lib/chains.ts`, an address of Zodiac. If you host the app yourself, set it to `null` and the app asks for nothing, or set your own address. The suggested amounts are in `CONTRIBUTION_STEPS`, scaling from $1 at $100 up to $50 at $5,000.
- All contributions go to one address, so that address is a public list of vaults that contributed.

### Cancel, and why it needs a second contract

In the Vault Delay, only the owner can remove a queued transaction (`setTxNonce`). The owner can also set the delay to zero and add wallets, at once. So the hot wallet must not be the owner: the owner is the Safe, and the Safe acts only through the queue.

To give the hot wallet cancel and nothing else, a Zodiac Roles modifier sits beside the Vault Delay as a second module of the Safe. It has one permission: the hot wallet can make the Safe call `setTxNonce` on the Vault Delay. Its owner is the Safe, so the permission can change only through the queue.

- The queue is first in, first out. A cancel removes one item and every item before it.
- Cancel cannot move funds, change the delay, or add anybody.

The Roles contract has no function that lists its permissions, so the app proves "cancel only" from the contract's whole event history: it accepts only the exact cancel setup: the hot wallet as the one member, or the hot wallet and the guardian setup described below. This needs old logs. If the wallet's RPC does not serve them, the vault shows as **unverified**: withdrawals and cancel work, but the app tells you not to deposit until the check passes.

### What the hot wallet can queue

The Vault Delay lets the hot wallet queue any transaction. The app builds three, and shows anything else in the queue with a warning:

- **Withdraw**: funds go back to the hot wallet.
- **Change the delay**: the Safe calls `setTxCooldown` on the Vault Delay.
- **Change the wallet**: the Safe enables the new wallet on the Vault Delay and disables the old one, and moves the right to cancel the same way, in one step. After it executes, only the new wallet controls the vault. The new wallet does not find the vault by itself, so keep its address.

### Money in the setup

The setup has a step "Put money in now?". It lists what the wallet holds, by dollar value where the app has a price (Chainlink feeds, read through the wallet), with five rows first and ten more for each "See more". Each row has a field and a slider with stops at 25%, 50%, 75% and everything. The slider gives round amounts. The step can be skipped ("Deposit later").

A token moves only when its holder calls it, or when a spender that the holder approved calls it. During the setup the vault still belongs to the wallet and runs the setup batch, so it can collect tokens in that batch. After the lock it can act only through the delay. So for a plain wallet the setup is the one moment when money goes in without a transaction of its own:

- **The coin** rides on the lock transaction and stays in the vault.
- **A token that takes a signed message** (EIP-3009 `receiveWithAuthorization`, or an EIP-2612 `permit`) costs one free signature. The lock batch collects it. The app reads the way in from the token itself and offers a signature only when the token's own domain separator is the one it would sign for. It asks for the signature after the vault exists, because a wallet warns its owner about an approval for an address with nothing behind it. It tries each signature against the token before it sends the lock.
- **Every other token** (USDT, WETH, WBTC and DAI on Ethereum, for example) is a plain transfer after the safety checks, one confirmation each.

If the lock fails, no money moves. A token that refuses its signature falls back to a plain transfer. A permit that somebody else has used first does not stop the setup, also when they send it while the lock waits to be mined: the batch sends the permit through Multicall3's `aggregate3` with `allowFailure`, so a used permit fails alone, and the `transferFrom` after it, which must succeed, uses the approval that is in place. Without an approval the transfer fails, and the whole lock with it.

The coin never goes in whole. The wallet is the only way to withdraw or to cancel, and both cost a network fee, so a wallet with no coin could do neither. "Max" of the coin leaves two things in the wallet: the fees of the setup (about half as much again as it really costs), and coin for a few transactions later (`keep` for each network in `src/lib/chains.ts`, more when fees are high, and never more than a quarter of what the wallet holds, so that a wallet with a few dollars can still try the app).

The contribution follows the money. The app suggests an amount by how many dollars go in (`CONTRIBUTION_STEPS` in `src/lib/chains.ts`: nothing below $100, $1 from $100, up to $50 from $5,000 and never more). When nothing goes in yet, it counts what the wallet holds. The suggestion shows on the same screen as the amounts, under the total, and "Change" opens the choices: nothing, two smaller amounts, the suggestion, and one larger amount. So "Max" hides nothing. The contribution is a part of the money that goes in: it is taken from a dollar token (ten dollars are ten tokens), or from the coin. When neither goes in during the setup, the wallet pays it on top in coin. If nothing can pay it, the setup goes on without a contribution. It never stops the setup.

`npm run test:fork:deposit` proves this against the real tokens: which tokens on the Ethereum list take a signature, a setup with coin, USDC and USDS, the contribution out of a dollar token, a used permit, and a failing pull that moves nothing.

### One transaction for wallets that can batch

Some wallets can send several calls as one transaction: a Safe, or an account with EIP-7702 code. The app asks the wallet (`wallet_getCapabilities`, EIP-5792). If the answer is yes, the create screen sends create, lock and any number of deposits as one atomic batch (`wallet_sendCalls`). If one part fails, nothing happens. About 1,000,000 gas with two deposits. Other wallets keep the two-transaction setup. That includes a plain account that the wallet offers to upgrade to a smart account (status `ready`): the app does not start that upgrade.

This is detected, not configured. It was tested on the fork with a Safe as the wallet and in the browser with a test wallet that acts as a Safe. It was not tested with Rabby, Zodiac Pilot, Safe{Wallet} or a MetaMask smart account. With a Safe as the wallet, withdrawals go back to the Safe, and a cancel is only as fast as the Safe's signers.

The app shows the deposit address only after it has checked the finished vault on chain. It runs the same checks every time you open a vault, and anybody can open any vault by address.

The address of your nth vault depends only on your wallet address and n. The app finds your vaults again on any device, without a server.

### The optional guardian

After setup, the wallet can add a guardian: a second wallet, on another device or held by a person you trust. Adding it waits the full delay, like every change. The app checks the result every time you open the vault.

- The guardian gets the role "cancel" in the Roles modifier: it can call `setTxNonce` on the Vault Delay and nothing else.
- A second role, "council", goes to a 2 of 2 Safe of wallet and guardian. It can call `enableModule` and `disableModule` on the Vault Delay, and `assignRoles` and `disableModule` on the Roles modifier. So wallet and guardian together can move the vault to a new wallet without the wait. Neither can do it alone.
- The guardian cannot withdraw. It can cancel every withdrawal, and the wallet can remove the guardian only through the queue, where the guardian can cancel that too.
- A guardian alone is not a backup. A wallet change by both needs the wallet. For a lost wallet, turn the recovery on.

### The optional recovery

With a guardian, the wallet can turn a recovery on: a way back in when the wallet is lost. It can go on in the same step as the guardian, or later. Turning it on waits the full delay, and the guardian can cancel it.

- The **guardian starts** a recovery, and **chooses the new wallet** at that time. The owner does not have to know that wallet in advance.
- A recovery waits a long time. The owner chooses how long: 90, 180 or 365 days, or an own length from 30 to 730 days, and never shorter than the delay. 180 days unless they choose another time.
- The **wallet can stop** a recovery at once while it waits. So can the guardian. When the wait is over, anybody can carry it out for 30 days, and the new wallet is the wallet of the Chronobox. After those 30 days it is void. No money moves.
- The alert service tells everybody who follows the Chronobox when a recovery starts, 7 days and 1 day before its wait ends, when its wait is over, and when it is stopped or carried out. When the wait ends, anybody can carry the recovery out at once, so stop it before then.
- The cost: if the owner does not stop a recovery in time, the guardian can take the Chronobox. After the recovery the new wallet still waits the delay for every withdrawal. A good guardian for this is a second device of the owner, or the person who gets the money when the owner is gone.

How it is built:

| Part | What it is | What it can do |
| --- | --- | --- |
| Recovery Delay | A second Delay, at an address that depends only on the Chronobox. The Safe owns it. It is never a module of the Safe. | It acts on the Council Safe. Its one module is the guardian. |
| Council Safe | The 2 of 2 Safe of wallet and guardian, in a second form: it has the Recovery Delay as its one module from its first moment. | What it could do before: change the wallet. It cannot move money. |
| Role "cancel" | Covers `setTxNonce` on the Recovery Delay too. | The wallet and the guardian empty the line of the recovery at once. |

- A recovery is the same step that wallet and guardian sign together to change the wallet at once. The guardian puts it into the line of the Recovery Delay. After the wait, that Delay makes the Council Safe run it. So the guardian alone, after the wait, can do what both can do together at once, and nothing more.
- The Council Safe gets its module in its own setup, through Safe's `SafeModuleSetup` 0.3.0. Its address can hold only that one Safe, and anybody can make it. The Recovery Delay is made the same way, before the step that turns the recovery on, so nobody can make that step fail by making it first.
- Turning the recovery off takes the guardian off the Recovery Delay and points that Delay back at the Safe, where it can do nothing. A recovery that waited at that moment can never run. Turning it on again first throws out what is left in that line.
- The app checks all of this each time: the Recovery Delay is owned by the Safe, acts on the Council Safe, has the guardian as its only module, waits, and can be stopped. One more address on the Recovery Delay makes the Chronobox fail its checks.

`npm run test:fork:recovery` proves it against the real contracts on a fork.

## Limits

Read these. They are the honest edge of what a delay can do.

- **Your wallet controls it.** The app does not know what kind of wallet that is: one key, a Safe with several signers, or a smart account. Whatever protects your wallet also protects your Chronobox.
- **A stolen key is a standoff, not a loss.** A person who has your wallet can queue a withdrawal, a shorter delay or a new wallet. You can cancel it while it waits. They can queue again, and you can cancel again. This works only if you see it in time, so look at your Chronobox regularly. With a guardian, you and your guardian can move the Chronobox to a new wallet at once.
- **A stolen key can block.** A person who has your wallet can also cancel your withdrawals, again and again. Then the funds are frozen. A guardian ends this: you and your guardian move the Chronobox to a new wallet at once. Frozen funds are better than lost funds.
- **The destination is a rule of this app, not of the contract.** This app builds only withdrawals to the wallet that controls the vault. The Vault Delay itself lets that wallet queue any transaction. Other queued transactions show up in the queue with a warning, and can be cancelled.
- **Lost wallet, lost funds, unless the recovery is on.** If you can no longer sign with your wallet, nobody can withdraw for you, and a guardian alone cannot help. With the recovery on (above), your guardian can bring the Chronobox to a new wallet after a long wait. The recovery of your wallet itself (a seed phrase backup, the other signers of a Safe) still works too.
- **With the recovery on, your guardian can take over.** The guardian chooses the new wallet. If you do not stop a recovery in time, because you are away, ill or gone, that wallet holds your Chronobox. A long wait and the alerts are what protect you. Without the recovery, a guardian can never take anything.
- **A recovery does not end a standoff.** A person who has your wallet can stop every recovery, as they can cancel every withdrawal. The recovery is for a lost key, not for a stolen one.
- **The vault is public.** It is linked on chain to the wallet that created it. Chronobox protects against speed, not against being known.
- **No alerts by itself.** A web page cannot wake up when it is closed. Alerts need a service that watches the chain (below), deployed on its own, and a Telegram account. Without them, use the calendar file, and look at your Chronobox regularly.



## Privacy

- No server, no account, no analytics.
- The production page loads only its own files and makes no other network requests. The Content Security Policy is `connect-src 'none'`. All chain data comes through your wallet, so no extra party learns which vault you look at.
- Wallets connect through EIP-6963 in the page. There is no WalletConnect relay.
- No service worker and no update prompt. See "Updates" below.
- Alerts are the exception, and you choose them. Our alert service must know who follows a Chronobox to send an alert, and we can see that. If you do not want that, run the alert service yourself. See "Get told" below.

## Get told: calendar and alerts

Each queued withdrawal has an **Add to calendar** link: one reminder when it becomes ready, one before it expires. Many calendars copy their entries to a cloud, so the file holds no amount, no address and no link.

### Alerts in Telegram

Alerts have two parts. The app has one button. The alert service is a project of its own, in `watcher/`. It is not part of the website: it is deployed as a second Vercel project, with Vercel Cron, a Telegram webhook and Upstash Redis, and the website stays a static site. It can also run on a machine that stays on. Without it, the button leads to a bot that does not answer.

The alert service watches every Chronobox on one or more networks and runs a Telegram bot. It sends a message when somebody asks a Chronobox for something, when the wait is over, when a request is cancelled or carried out, when a guardian starts a recovery, and when the Chronobox itself changes: a new wallet, a guardian, the recovery on or off. The messages use the words of this app and hold no links. See `watcher/README.md`.

`ALERTS_TELEGRAM` in `src/lib/chains.ts` is the name of the bot: `zodiac_chronobox_bot`. It must be the bot that the alert service runs with. `null` turns the alerts off: a Chronobox then does not show "Get told". With a name set, "Get told" has the way "Telegram", with one button, "Get alerts in Telegram". It opens `https://t.me/<bot>?start=<chain id>-<address>`. The person presses Start in Telegram, and the bot sends the alerts of that Chronobox to that chat from then on.

The registration is in Telegram, not in this app. The app only builds the link, and `connect-src 'none'` stays as it is.

What this gives and what it does not:

- No second app for people who have Telegram, and no form to fill in.
- The alert service keeps, per chat, the number of the Telegram chat, the address of the Chronobox, and since when the chat follows it. It keeps no name, no username, no phone number and no message. `/stop` deletes all of it. This pair is personal data: it links a reachable account to a Chronobox. On disk the list is encrypted with a key that is not stored with it, so a copy of the file alone shows nothing. A person who controls the running service can still read it.
- Telegram knows the phone number of the account and can read what the bot sends. What the bot sends is public on the chain. That an account follows a Chronobox is not.
- A person with your wallet cannot stop the alerts: the subscription belongs to the Telegram chat, not to the wallet. When a chat that followed for a day or more stops, every other chat that follows the same Chronobox is told, once an hour at most. A stranger who follows and stops again cannot ring the phones of the others.
- The bot sends no links and asks for nothing. That makes a fake bot easier to spot. The link to the real bot is in the app, so nobody has to search for it.

### The choice, and what our alert service costs in privacy

"Get told" opens with one question: how do you want to hear about it?

- **Telegram**: a message from our alert service (`ALERTS_TELEGRAM`).
- **Email**: an email from our alert service (`ALERTS_EMAIL`). The row opens the page of the alert service where a person gives an email address. While `ALERTS_EMAIL_SOON` is true and `ALERTS_EMAIL` is `null`, the list shows email as "Coming soon", and it cannot be chosen.
- **Your own alert service**: one button that opens the guide "Run it yourself" in `watcher/README.md` (`ALERTS_GUIDE`).

Under the list, the sheet says it in plain words: our alert service is not private. To send an alert it must know who follows a Chronobox, and we can see that. With Telegram, we can see that a Telegram account follows a Chronobox, and Telegram can see it too. Encryption of the list protects a copy of it, not against us. A person who does not want that runs the alert service on their own. Then we learn nothing about them.

A way whose setting is `null` is not in the list. With one way left and `ALERTS_EMAIL_SOON` false, "Get told" opens on that way, without the question.

### Alerts by email

The same alert service can send the alerts by email, through Resend. `ALERTS_EMAIL` in `src/lib/chains.ts` is the page of the alert service where a person gives an email address (`<alert service>/api/email`). Here it is `https://watcher.chrono.box/api/email`. With it set, "Email" opens that page. With it `null`, "Get told" shows email as "Coming soon". The person confirms the address with a link in one email (double opt-in). The app never sees the address.

- The alert service keeps the email address, the address of the Chronobox and since when, encrypted like the list of chats. Resend gets the address and the text of each email, because it sends them.
- Every alert by email ends with a link that stops the alerts. It is the only link in it.

## Run it

Needs Node 22.18 or later.

```bash
npm ci --ignore-scripts
(cd watcher && npm ci --ignore-scripts)   # for npm run check and the alert tests: they read the alert service
npm run dev          # http://localhost:3130, with a test wallet for a local fork
npm run fork         # in a second terminal: anvil fork of Ethereum mainnet on :8545
```

The dev build injects a test wallet ("Anvil test wallet") that signs with anvil's unlocked accounts. Add `?account=1` for another account, or `?safe=1` to make it act as a Safe that can batch. It does not exist in the production build. In the browser console, `__anvil.warp(seconds)` moves the fork's clock.

```bash
npm test             # unit tests
npm run test:fork    # the full flow against the real contracts on the fork
npm run test:fork:alerts   # the alert service against the real contracts on the fork, with stand-ins for Telegram and Resend
npm run check        # TypeScript
npm run build        # production build in out/, prints the build hash
```

`npm run test:fork` proves, against the deployed contracts:

- the predicted addresses, both setup transactions and every check
- nobody can act as owner (five signature types), and the wallet cannot change the Vault Delay directly
- through the Roles modifier the wallet can cancel and nothing else (nine other attempts fail)
- deposit, queue, early execution fails, execution after the delay, cancel, expiry and skip
- a change of the delay and a change of the wallet, each after its own wait; the old wallet can then neither queue nor cancel, and the new one can
- a contribution sent with the lock transaction arrives, and the vault stays empty
- a Safe as the wallet: create, lock and two deposits in one transaction; a batch that cannot pay its deposit creates nothing
- ten tampered setups (for example a second module, a second wallet that can queue, a hidden second role, a second address that can cancel, a delay of zero, a guard on the Vault Delay) are all rejected by the checks
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

`out/` is the whole site. The live site is on Vercel, which reads the response headers from `vercel.json`. `out/_headers` sets the same headers on Netlify and Cloudflare Pages. On another host, set them yourself:

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
src/lib/alerts.ts    the link to the Telegram bot
src/ui/alerts.tsx    the sheet "Get told"
src/ui/              screens
watcher/             the alert service: a project of its own (Vercel functions, or a CLI)
build.mjs            build, dev server, build hash
test/fork.ts         end-to-end proof on a fork
test/alerts-fork.ts  the alert service on a fork (it uses watcher/src)
brand/               logo and icons
```

## License

MIT. See `LICENSE`.
