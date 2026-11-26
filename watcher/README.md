# Chronobox watcher

A Chronobox is a Safe. Everything goes through a Zodiac Delay, controlled by one wallet, and waits the full delay: a withdrawal, a change of the delay, a change of the wallet. The wallet can cancel what waits, through a Zodiac Roles modifier with that one permission. Cancel is worth nothing if nobody knows that something waits. That is what this watcher is for.

The watcher reads the chain every minute and sends a message when something happens. It is a project of its own, in this folder. It is not part of the Chronobox website and has its own `package.json`. It runs in three ways:

- **As the alert service on Vercel.** It watches every Chronobox on one or more networks. A person gets the alerts of a Chronobox in Telegram (they open the bot from the Chronobox app and press Start) or by email (they give an address on a page of the service and confirm it). Nothing has to stay on: Vercel Cron starts a poll every minute, Telegram calls a webhook with each message to the bot, and the email pages are a function. The state is in Upstash Redis. See "The alert service on Vercel".
- **As the same alert service on a machine that stays on (`--all`).** The CLI, with the state in files. The bot asks Telegram for its messages, so Telegram needs no domain and no open port. Email does: see "Alerts by email".
- **For one Chronobox.** The CLI watches the address you give it and posts every alert to a webhook of yours.

If the app shows the button "Get alerts in Telegram" and no watcher runs, the bot does not answer and nobody gets an alert.

It needs no keys of a wallet, and Node.js 22.18 or newer. Its only runtime packages are react-email and React, for the HTML of the emails (`src/mail.tsx`) and of the email pages (`src/pages.tsx`). `npm run build` makes two things, each with those packages bundled in: the functions for Vercel in `.vercel/output/`, and the CLI as one file, `dist/watch.mjs`. Run `node dist/watch.mjs --help` (or `npm start -- --help`) for all settings of the CLI.

Node runs the sources as they are, by type stripping. That does not read JSX, so `jsx.mjs` lets esbuild compile the `.tsx` files as they load: `npm test` and `npm start` use it, and so does `node --import ./jsx.mjs src/cli.ts`. Each setting works as an environment variable (`POLL_SECONDS=30`) or as a flag (`--poll-seconds 30`).

```sh
npm install
npm test          # unit tests, with stand-ins for the chain, Telegram, Resend and Redis, and the property test below
npm run check     # TypeScript
npm run build     # .vercel/output/ and dist/watch.mjs; it renders one email from a bundle, to check the bundle
```

`npm run test:fork:alerts` in the folder above runs the alert service against the real contracts on a fork.

The property test plays 150 random runs on the stand-in chain: requests, time, executions, skipExpired, cancels, cancels that fail, timing changes, several of them in one block, polls at any point. The chain keeps what really happened to each request, and every message must fit it: a request that was carried out is never "Cancelled" or "Removed", and "Done" is said only of one that was. A failure prints its seed and steps. More runs, or others: `FUZZ_RUNS=5000 FUZZ_SEED=1 npm test`.

## Run it yourself

You do not need the alert service of anybody else. The watcher is open source, and you can run it yourself. Then it writes only to you (and to whoever you give your bot to), nobody else keeps a list that links you to your Chronobox, and it does not need us.

| | Alerts in Telegram | Alerts for your own tools |
|---|---|---|
| **What it is** | Your own Telegram bot sends you a message. | Every alert goes to a web address of yours (a webhook), as JSON. |
| **Good for** | You, on your phone. | A script, a home automation, the chat of a team. |
| **It watches** | Every Chronobox on the network. You follow yours with one message to your bot. | Only your Chronobox. |
| **You need** | A bot from BotFather, a key for the list of chats, and an RPC. | An RPC for the network of your Chronobox. |
| **How** | [The alert service on a machine](#the-alert-service-on-a-machine---all) | [One Chronobox, to a webhook](#one-chronobox-to-a-webhook) |

### What you need

- **A machine that stays on**: a small server, or a computer at home that never sleeps. A laptop that sleeps sends no alerts. Where it runs is your choice: any host that can run a Node.js program all the time, or start it every minute, will do.
- **A terminal** with git and Node.js 22.18 or newer.
- **An RPC** for the network of your Chronobox. A free public one is enough. An RPC sees your IP address and which Chronobox you read. So do not use an RPC of Zodiac (`rpc.zodiac.eco`, `public-rpc.zodiac.eco`) if we are to learn nothing about you.
- **For Telegram, a bot of your own** from [BotFather](https://t.me/BotFather). Telegram still sees that your account follows your Chronobox, and it can read what your bot sends. Only we are out of it. With a webhook, nobody but you and your RPC sees anything.

If an AI agent does such things for you, give it this page. Every step is a command that it can run. Two steps are yours: the bot from BotFather, and the choice of the machine.

### The short way

```sh
git clone https://github.com/zodiaceco/chronobox.git
cd chronobox/watcher
npm install
npm run build
RPC_URL=https://your-rpc CHRONOBOX=0xYourChronobox node dist/watch.mjs --once --dry-run
```

The last line sends nothing. It must print "Watching this Chronobox" with the delay and the wallet of your Chronobox. Then you know that the RPC and the address are right.

For alerts in Telegram, make the key for the list of chats one time and keep it. Without it the list is lost.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```sh
export RPC_URL=https://your-rpc
export TELEGRAM_TOKEN=<the token from BotFather>
export TELEGRAM_KEY=<the key from the line above>
export STATE_DIR=$HOME/chronobox-watcher
node dist/watch.mjs --all
```

When the line `telegram: the bot is @<your bot>` shows, write to your bot (see below). It answers within a few seconds.

That runs as long as the terminal is open. To keep it running, see [Run it as a service](#run-it-as-a-service).

### Your bot and the app

With your own bot, the button "Get alerts in Telegram" in the Chronobox app does not lead to it. Open your bot in Telegram and send it the network and the address of your Chronobox:

```
/start 1-0xYourChronobox
```

The number is the chain ID: 1 for Ethereum, 8453 for Base, 42161 for Arbitrum One, 100 for Gnosis. The bot answers with what waits in your Chronobox right now.

Where it runs: on a machine that stays on, in a terminal for a first try or [as a service](#run-it-as-a-service). With cron (`--once`), Telegram answers late; use cron for the webhook.

Before you rely on it:

- Try it first with `--dry-run`. It prints the messages and sends nothing.
- Ask your Chronobox for a small withdrawal and cancel it. You must get two messages.
- The watcher says "All quiet" once a day. In Telegram this is one pinned message that the bot edits, so it makes no sound and no unread mark. If its date gets old, the watcher has stopped. The webhook gets a `heartbeat` event.

## What it reports

The messages use the words of the Chronobox app. They speak to nobody as "you": the owner, the guardian and anybody else who follows a Chronobox get the same text. Each one ends with one link, to the page of that Chronobox in the app. An email also has the link that stops the alerts.

- **New request**: a request has started in the Chronobox. The message treats the normal case as the norm: it says what the request is and when its wait ends, and then, in one last line, what to do if the owner did not ask for it. Where a request is not one that the app makes (money to another address, a call that the app does not know), the message says so in words.
- **Wait over**: the wait of a request is over, and it can be finished.
- **Ends soon**: 24 hours before a request becomes void (or halfway through its time if that is shorter than 48 hours).
- **Too late**: a request was not finished in time and is void.
- **Cancelled**: a request was cancelled.
- **Done**, **Removed** or **Closed**: a request is gone without a cancel. The message says if it was carried out, or if it was too late and was removed.
- **This Chronobox changed**: the delay, the wallet, the guardian, the recovery, who can cancel, or the parts of the Chronobox are different from the last look. This comes from the state of the contracts, so it also catches a change that was not announced by a request, such as a new wallet that the wallet and the guardian set together at once.
- **Recovery started**: the guardian started a recovery. The message names the new wallet and when the wait ends. The wallet and the guardian can stop it until it is carried out.
- **Recovery line: N steps wait**: the line of the recovery is longer than the 5 steps that the alerts name. The rest is only counted, so a guardian cannot make the alert service too slow by filling the line. Told when it appears and each time it at least doubles. One stop removes all steps.
- **Recovery wait ends soon**: 7 days and 1 day before the wait of a recovery ends. When it ends, anybody can carry the recovery out at once, so this is the last safe moment to stop it.
- **Recovery wait over**, **Recovery ends soon**, **Recovery void**: as for a request, for the recovery.
- **Recovery stopped**, **Recovery done** or **Recovery closed**: the recovery left its line. Done means that the new wallet holds the Chronobox now.
- **All quiet**: once a day, so that silence is different from a broken watcher. In Telegram it is one pinned message that is edited, not a new message every day: a chat full of messages that say nothing is a chat that people mute, and then they miss the real alerts too.
- **Alerts can be late**: the watcher could not read the chain for 3 polls in a row. **Alerts work again** follows when it can.

Each message is sent once, also across restarts. A message that could not be delivered is tried again on the next poll.

The watcher names the requests of the app by their shape: a new wallet, a new guardian (with or without a recovery), the end of a guardian, and a recovery that is turned on, turned off, or given another wait. It reads a recovery in the line of the recovery the same way: the new wallet comes from its first and its last call. It reads what the request contains, but it cannot prove that the request is exactly the one the app builds. The app can, because it builds the request again and compares every byte. So these messages say "open the Chronobox to see the request in full".

## The alert service on Vercel

The service is a second Vercel project, made from the same repository. The website stays a static site with no backend.

```
Vercel Cron, every minute ──▶ /api/poll       reads every network, sends the alerts (Telegram, Resend, webhook)
Telegram, each message ──────▶ /api/telegram   answers /start, /stop, /list, /privacy
a person, in a browser ──────▶ /api/email      sign up for email, confirm, stop
an uptime monitor ───────────▶ /api/health     503 when the polls stopped
                                    │
                              Upstash Redis: what the watcher knows, the sealed lists of chats and of addresses, the locks
```

### Set it up

1. In Telegram, write to [BotFather](https://t.me/BotFather): `/newbot`, a name, a username. It answers with a token.
2. Make two secrets, one for the lists of chats and of email addresses (`ALERTS_KEY`) and one for Vercel Cron. Keep the first one: without it the lists are lost.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

3. In Vercel, make a new project from this repository. Set **Root Directory** to `watcher`. `vercel.json` sets the rest: no framework, `npm ci`, `npm run build`.
4. In the project, under Storage, connect an Upstash Redis database. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`).
5. Set the environment variables, for **Production only**. A preview deployment then has no secrets, cannot reach the bot, and answers every call with an error.

   | Variable | |
   |---|---|
   | `CHAINS` | The networks to watch, for example `1,100,8453,42161`. |
   | `RPC_URL` | Optional. The RPC for every network, with `{chainId}` where the chain id goes. A comma separates fallbacks. Default: the RPC of Zodiac (see below). |
   | `RPC_URL_<chain id>` | Optional. The RPC of one network, in place of `RPC_URL`, for a provider with a host name per chain. |
   | `TELEGRAM_TOKEN` | The token from step 1. |
   | `ALERTS_KEY` | The first secret from step 2. It encrypts the lists of chats and of email addresses. `TELEGRAM_KEY` is its older name, and still works. |
   | `RESEND_KEY` | Optional. With it, alerts by email: see "Alerts by email" below. |
   | `EMAIL_FROM` | With `RESEND_KEY`. The sender, for example `Chronobox alerts <alerts@example.org>`, on a domain that Resend has verified. |
   | `CRON_SECRET` | The second secret. Vercel Cron sends it with each call, and `/api/poll` refuses a call without it. |
   | `RPC_SERVICE_KEY` | Optional. The service key of chronobox for the internal RPC of Zodiac (see below). |
   | `RPC_SERVICE_HOST` | Optional. Where the key goes (default `rpc.zodiac.eco`). |
   | `WEBHOOK_URL` | Optional. Gets every alert of every Chronobox as a JSON POST. |
   | `START_BLOCK_<chain id>` | Optional. The first block to search for Chronoboxes. Default: the newest block at the first poll. |
   | `PUBLIC_URL` | Optional. The address where Telegram reaches the bot, and where the links in the emails lead. No path. Default: the production domain of the project. |
   | `APP_URL` | Optional. The Chronobox app. An alert ends with a link to the page of its Chronobox there. No path. Default: `https://www.chrono.box`. |
   | `HEARTBEAT_HOURS`, `FAIL_POLLS`, `LOG_CHUNK`, `MAX_SCAN_BLOCKS` | Optional, as in the CLI. |
   | `POLL_BUDGET_SECONDS` | Optional. After this time a poll reads no further Chronobox, and the next poll goes on (default 60). |
   | `HEALTH_MAX_AGE_SECONDS` | Optional. `/api/health` answers 503 when the last poll is older (default 300). |
   | `REDIS_PREFIX` | Optional. Every key starts with it (default `chronobox:`). |

6. Deploy to production. Within a minute the first poll runs. It tells Telegram to send the messages of the bot to `/api/telegram`, with a secret that Telegram sends back each time. The poll does that again when the address, the token or the key changes.
7. Open `/api/health`. It says when the last poll ran and if every network could be read.
8. Only then: in the Chronobox app, set `ALERTS_TELEGRAM` in `src/lib/chains.ts` to the username of the bot, and with email `ALERTS_EMAIL` to `<PUBLIC_URL>/api/email`, and build. With one way set, a Chronobox shows "Get told" with one button. With more, "Get told" first asks which way.
9. Point an uptime monitor at `/api/health`. Cloudflare can do it with a Worker on a cron trigger, or any uptime service can. It is on another provider than the service, so it also notices when Vercel or its cron stops. "All quiet" tells the people who follow a Chronobox that the alerts work. The monitor tells you.

### The RPC of Zodiac

Zodiac runs its own RPC (a Cloudflare Worker in front of Alchemy, `deployables/rpc` in zodiac-os), on two hosts:

- `rpc.zodiac.eco` answers only with `Authorization: Bearer <credential>`. Chronobox is one of its services: it sends a static key, the same value as the worker's `CHRONOBOX_SERVICE_KEY`. The worker reads with the Alchemy app of chronobox and counts the calls against the limit of chronobox (3000 calls a minute), not against the share of the Zodiac app. With `RPC_SERVICE_KEY` set, the watcher sends the key, and only to `RPC_SERVICE_HOST`.
- `public-rpc.zodiac.eco` answers anyone, with a limit per IP address. Vercel functions share their addresses with others, so it is the fallback, not the first choice.

Without `RPC_URL`, the service uses both: `https://rpc.zodiac.eco/{chainId},https://public-rpc.zodiac.eco/{chainId}` when `RPC_SERVICE_KEY` is set, else the public host only. So this is all it takes:

```
CHAINS=1,100,8453,42161
RPC_SERVICE_KEY=<the CHRONOBOX_SERVICE_KEY of the production worker>
```

Each RPC must be on the chain it is used for. The service checks that, and stops a network whose RPC is on another chain.

A refused key, or a service over its limit, does not stop the alerts: the watcher goes on with the fallback. The worker logs it (`limitedBy: service`, or a 401 without a subject). The key lets anybody draw on the limit of chronobox, so it is as sensitive as the other secrets: Production only. The dev worker (`rpc-dev.zodiac.eco`) has its own key. Use it with `RPC_SERVICE_HOST=rpc-dev.zodiac.eco` and an `RPC_URL` on that host.

### How it runs

- **One poll per minute** reads every network at the same time. A Chronobox where nothing waits is not read, so a poll is short. One poll searches `MAX_SCAN_BLOCKS` blocks at most. A service that is far behind (the first start with `START_BLOCK`, or after an outage) catches up over several polls.
- **Fair order.** A poll reads the Chronoboxes that waited longest first, and notes the time of each read before it begins. A poll that runs out of time (`POLL_BUDGET_SECONDS`) goes on there the next time, so Chronoboxes that always have something waiting cannot keep the others from being read, and one whose read kills the function goes to the back of the line. The poll reports how many it skipped and how long the oldest waits, and `/api/health` answers 503 when one waits longer than `HEALTH_MAX_AGE_SECONDS`.
- **One vault cannot stop the others.** Anybody can deploy a Safe that answers anything, and pass for a Chronobox. Answers that are not exactly the ABI (too short, an address that is no address) count as "not a Chronobox". A vault that cannot be read while the chain can is a problem of that vault: whoever follows it gets "Alerts can be late" after `FAIL_POLLS` tries, it waits 1, 2, 4 … minutes (an hour at most) between tries, and the poll reports it as `failing` without failing the network. A new Delay whose check fails goes to the back of the queue and is dropped after 3 tries.
- **Locks.** Vercel can start a poll while the last one still runs, and Telegram calls the webhook at any time. So a poll takes the lock of its network, and a poll that finds it taken stops at once: the one before it does the work. A Start waits for the lock (up to 30 seconds), because it reads the Chronobox. A change of the list of chats takes the lock of the list. A lock is a key in Redis that runs out after 130 seconds, longer than a function may run (`src/limits.ts`). A function that was killed blocks the next ones until then.
- **Email pages.** Each request to `/api/email` is a new function. The request that waits for a confirmation, the list of addresses and the limits per visitor are all in Redis, so the steps of one person can land in different functions.
- **Each message is answered once.** Telegram sends a message again when the answer was slow. The webhook notes each message for a day and does not answer it twice.
- **Each alert is sent once.** As in the CLI, a chat that got an alert is noted, and only the others are tried again. If a function is killed between sending and saving, a message can come twice. It is never lost.
- **The webhook and long polling exclude each other.** A bot can do only one. When the service sets its webhook, a CLI that reads the same bot gets an error (409). Give the service its own bot, or stop the CLI.

The functions are bundled by `build.mjs` and deployed as they are (the Build Output of Vercel). The cron job is in `.vercel/output/config.json`, made from `src/limits.ts`.

## Alerts by email

With `RESEND_KEY` the service also sends the alerts by email, through [Resend](https://resend.com). It works with the Telegram bot or without it, on Vercel and on a machine. Each email has a plain text part and an HTML part (`src/mail.tsx`, rendered with react-email).

```sh
RESEND_KEY=re_...
EMAIL_FROM="Chronobox alerts <alerts@example.org>"   # a domain that Resend has verified
PUBLIC_URL=https://alerts.example.org                 # where the service is on the web; the links in the emails start with it
ALERTS_KEY=<the key from step 2>
```

Then, only when the service runs: in the Chronobox app, set `ALERTS_EMAIL` in `src/lib/chains.ts` to `<PUBLIC_URL>/api/email` and build.

A person signs up in two steps (double opt-in). The app is not part of it: it only opens the first page.

1. The page `<PUBLIC_URL>/api/email?c=<chain id>-<address>` asks for an email address. The service checks on the chain that the address is a Chronobox.
2. The service sends one email with a link. Nothing else goes to that address yet.
3. The link opens a page with one button, "Confirm". Only the button confirms. A program that opens the links in an email for the person does not press it.
4. From then on the alerts of that Chronobox go to that address. Each one ends with a link that stops them, and mail programs show their own button for it (`List-Unsubscribe`, one click).

Things to know:

- **On a machine, email needs an address on the web. Telegram does not.** The CLI serves the pages on `127.0.0.1:PORT` (default 8787) at `/api/email`, so only a program on the same machine reaches them. Put a proxy with TLS there, for example Caddy or nginx, that adds the visitor to `X-Forwarded-For`. `GET /health` answers `ok`. With `--once` there is no page; the addresses on the list still get their alerts.
- **Only the proxy names the visitor.** The CLI reads `X-Forwarded-For` only from a trusted proxy: `127.0.0.1` and `::1` by default. From any other address, that address is the visitor, whatever the header says, so a client that reaches the port directly cannot pose as many visitors. A proxy on another machine: set `BIND_ADDRESS` (for example `0.0.0.0`) and name the proxy in `TRUSTED_PROXIES` (IP addresses, with commas).
- A request that nobody confirms is deleted after one day. The confirmation email also has a link "Not you? Cancel": it opens a page with a button that deletes every request to that address that is not confirmed. Only who reads that mailbox has the link. So a stranger who fills the three open requests of somebody else's address cannot block that person's own sign-up: they cancel, and ask again. Confirmed alerts stay as they are.
- The page gives the same answer for every address, so nobody can use it to find out who is on the list.
- Somebody can type the address of another person. That person gets one email and nothing more. An address gets one confirmation in ten minutes for a Chronobox and holds three open requests at most. One visitor can ask for ten an hour, and all visitors together for 300. The limits are counters in the store (Redis on Vercel), with a keyed hash of the visitor, not the IP address.
- The visitor is the last address in `X-Forwarded-For`: the one that the nearest proxy saw. On Vercel the platform sets that header, so it counts there. In the CLI it counts only from a trusted proxy (above).
- "All quiet" and "Watching" do not go out by email. An inbox is not the place for a message every day. So a person with email only does not notice when the service stops.
- When an address stops, the other addresses and the Telegram chats of that Chronobox are told, and the other way round, by the same rules as in Telegram: only a follow of a day or more counts, and once an hour at most.
- An alert that waits for an address notes who got it by a keyed hash, as for Telegram. That hash is also the idempotency key at Resend, so a retry is not sent twice.
- Not tested yet with the real Resend or a real inbox. The checks are the unit tests and `npm run test:fork:alerts`, with a stand-in for Resend.

## The alert service on a machine (`--all`)

1. Make a bot and a key, as in steps 1 and 2 above.
2. Start the watcher with the token and the key:

   ```sh
   export RPC_URL=https://your-rpc,https://backup-rpc
   export TELEGRAM_TOKEN=123456:AA...
   export ALERTS_KEY=<the key from step 2>
   export STATE_DIR=/var/lib/chronobox-watcher
   node dist/watch.mjs --all
   ```

3. Only when the watcher runs: set `ALERTS_TELEGRAM` in the app, as above.

How it finds the Chronoboxes (on Vercel too):

- A new Chronobox by the Delay that it deploys (the `ModuleProxyCreation` event of the Zodiac factory, for the master copy of the Delay), and any Chronobox when somebody presses Start or signs up for it.
- It reads logs only from contracts it chose: the factory, and the Delays of the Chronoboxes it knows. Anybody can deploy contracts that emit any event, so a search over every contract would let anybody fill a poll. That is why an older Chronobox is not found when it asks for something. Set `START_BLOCK` to the block of the first Chronobox to find them all from the factory.
- A new Delay waits in a queue until it is checked. The queue is saved together with the search, before any check, so a search is never done twice. Each poll checks a batch of 8 at least, and new Delays get a quarter of its time at most, so a flood of Delays from the factory cannot take the time of the Chronoboxes that are known. The queue holds 1000 at most; more is dropped and logged. A Chronobox among them is still found when somebody presses Start for it.
- It accepts an address only if it is a Safe whose single owner is the burn address and whose modules are that Delay, or that Delay and a Roles modifier.
- A Chronobox where nothing waits cannot change until somebody asks for something. So the watcher reads a Chronobox only when something waits there, when something new was asked for, or when its "All quiet" message is due and a chat follows it. One log request per poll (per 100 Chronoboxes) covers all quiet ones.
- The first start begins at the newest block. Set `START_BLOCK` to search from an older block.

How a person subscribes (on Vercel too):

- The app builds the link `https://t.me/<bot>?start=<chain id>-<address>`. Telegram shows the bot and a Start button. The bot gets `/start <chain id>-<address>` together with the number of the chat. Nobody fills in a form, and the app sends nothing.
- The bot checks on the chain that the address is a Chronobox. Then it keeps the pair (chat, Chronobox) and answers with what waits there right now.
- From then on every alert of that Chronobox goes to that chat. "All quiet" is one pinned message that the bot edits each day. A new one comes only if the person deleted it. /stop unpins it. No alert has a mark for how grave it is: the words say it.
- `/stop` ends all alerts of a chat and deletes it. `/stop <address>` ends one. `/list` shows what the chat follows. `/privacy` says what the bot keeps. A chat can follow 20 Chronoboxes at most.
- When a chat stops, every other chat and every email address that follows the same Chronobox is told. Alerts must not go off in silence. But anybody can follow a public Chronobox, so only a follow of a day or more tells the others, and they are told once an hour at most: more stops in that hour come together in the next message ("3 chats … have stopped them"), which the poll sends. A stop is never dropped, so a stranger cannot hide a real one for more than an hour.
- A chat that blocks the bot is removed. A message that fails is tried again on the next poll, and a chat that already got it does not get it twice.
- The bot works in a group too: add it to the group and send the same `/start` command there.

More than one network:

```sh
export RPC_URL="https://ethereum-rpc,https://ethereum-backup; https://base-rpc; https://gnosis-rpc"
```

A semicolon separates the networks, a comma the fallbacks of one network. Each network keeps its state in its own folder, `network-1`, `network-2` and so on, in the order of `RPC_URL`. Do not change the order later. One watcher reads all networks because only one program can read the messages of one bot.

Things to know:

- On a machine, the bot needs no domain and no open port. It asks Telegram for new messages (long polling). If the bot had a webhook (from the service on Vercel), remove it first: `curl https://api.telegram.org/bot<token>/deleteWebhook`.
- Lower `LOG_CHUNK` if the RPC limits the block range of `eth_getLogs`.
- With `--once` the bot reads its messages one time per run, so an answer takes as long as the pause between two runs. Run the watcher as a service.
- `CHRONOBOX`, `DELAY` and `STATE_FILE` do not work with `--all`. `WEBHOOK_URL` works, and gets the alerts of every Chronobox.
- The service on Vercel runs with the real Telegram. The checks of the CLI are the unit tests (with stand-ins for the chain, Telegram and Redis) and `npm run test:fork:alerts`, which runs the watcher against the real contracts on a fork with a stand-in for the Telegram API.

### What the service keeps

- Public chain data: the Chronoboxes it found and what waits in them.
- The list of chats (`STATE_DIR/telegram.json`, or the key `chronobox:telegram` in Redis): for each chat that pressed Start, the number of the chat, the Chronoboxes it follows, and since when. For each Chronobox, how many chats stopped that the others were not told of yet. No name, no username, no phone number, no message.
- The list of email addresses (`STATE_DIR/email.json`, or the key `chronobox:email` in Redis): for each address that confirmed, the address, the Chronobox, and since when; the requests of the last day that are not confirmed yet; and the stops that the others were not told of yet. Nothing else.
- These lists are personal data. They link a Telegram account or an email address to a Chronobox, and so to an amount of money.
- Resend gets every email address and the text of every email, because it sends them. Name it where you tell people what happens to their data.
- The lists are encrypted with `ALERTS_KEY` (AES-256-GCM). It holds no address and no chat number that somebody can read without the key. So the file, the Redis database, a backup of either, or the disk alone are worth nothing.
- Keep the key and the token away from where the list is: in the secret store of your host, or in a file that only the service can read. On Vercel the key is in the environment of the project, and the list is at Upstash, two different companies. With the list and the token, somebody could write to every person as the real bot.
- The key does not protect against a person who controls the running watcher. The watcher must know which chats follow a Chronobox when it sends an alert, so it holds the list and the key. Only a sealed enclave could hide the list from the person who runs the machine. That is not built.
- If the key is lost, the list is lost: remove `telegram.json` (or the key `chronobox:telegram` in Redis), and every person must press Start again. A wrong key stops the watcher with a clear message (on Vercel: every call answers 500 with it). It does not start with an empty list.
- An alert that waits for a chat or the webhook is kept with the state of its Chronobox, which is not encrypted. It notes which chats got it by a keyed hash of the alert, the Chronobox and the chat (made from `ALERTS_KEY`), never by the number of the chat. The same for an email address. Without the key nobody can tell which chats or addresses they are, and two alerts do not show that the same one got both.
- The watcher does not write the number of a chat, an email address, an IP address, the token or a key to its log.
- Telegram knows the phone number of each account and can read what the bot sends. What the bot sends is public on the chain. That an account follows a Chronobox is not.

### Try it on your machine

Make a test bot with BotFather, put its username in `ALERTS_TELEGRAM`, start the fork (`npm run fork`) and the app (`npm run dev`), and run:

```sh
RPC_URL=http://127.0.0.1:8545 TELEGRAM_TOKEN=123456:AA... ALERTS_KEY=<32 characters or more> npm start -- --all
```

Then press "Get alerts in Telegram" in a Chronobox. On the local fork the network is Ethereum (chain 1), so the link starts with `1-`.

## One Chronobox, to a webhook

```sh
export RPC_URL=https://your-rpc,https://backup-rpc
export CHRONOBOX=0xYourChronobox
export WEBHOOK_URL=https://your-server.example/chronobox
node dist/watch.mjs
```

Test your setup first. `--dry-run` prints the messages and sends nothing:

```sh
RPC_URL=https://your-rpc CHRONOBOX=0xYourChronobox node dist/watch.mjs --once --dry-run
```

The first run sends one "Watching this Chronobox" message with what waits, the wallet, and who can cancel. The watcher remembers what it sent in `chronobox-watch-state.json` in the current folder (change it with `STATE_FILE`).

With `WEBHOOK_URL`, every alert is a JSON POST:

```json
{ "event": "queued", "title": "...", "message": "...", "priority": 3, "vault": "0x...", "delay": "0x...", "chainId": 1, "nonce": 4, "at": "2026-11-17T19:00:00.000Z" }
```

`event` is one of `watching`, `queued`, `ready`, `expires_soon`, `expired`, `cancelled`, `closed`, `settings_changed`, `recovery_started`, `recovery_backlog`, `recovery_soon`, `recovery_ready`, `recovery_expires_soon`, `recovery_expired`, `recovery_stopped`, `recovery_done`, `recovery_closed`, `heartbeat`, `watcher_problem`, `watcher_recovered`. The `nonce` of a recovery event is its place in the line of the recovery, not in the line of withdrawals. `priority` goes from 2 (All quiet) to 5 (a change of the Chronobox). Only the webhook gets it. In Telegram and by email it shows nowhere, except that "All quiet" arrives without a sound. Any answer other than 2xx counts as failed and is tried again.

If you want the alerts of your own Chronobox in Telegram without anybody else's service, run the alert service above on your own machine with your own bot. See "Run it yourself".

## Run it as a service

Build (`npm run build`), put `dist/watch.mjs` in `/opt/chronobox-watcher/` and create `/etc/systemd/system/chronobox-watcher.service`:

```ini
[Unit]
Description=Chronobox watcher
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/chronobox-watcher
EnvironmentFile=/etc/chronobox-watcher.env
Environment=STATE_DIR=/var/lib/chronobox-watcher
ExecStart=/usr/bin/node /opt/chronobox-watcher/watch.mjs --all
Restart=always
RestartSec=30
DynamicUser=yes
StateDirectory=chronobox-watcher

[Install]
WantedBy=multi-user.target
```

Everybody on the machine can read a unit file, so the secrets go into `/etc/chronobox-watcher.env`, which only root can read (`chmod 600`):

```sh
RPC_URL=https://your-rpc,https://backup-rpc
TELEGRAM_TOKEN=123456:AA...
ALERTS_KEY=...
```

The state goes to `/var/lib/chronobox-watcher/`, the folder systemd creates for the service. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chronobox-watcher
journalctl -u chronobox-watcher -f
```

For one Chronobox with cron, `--once` checks one time and exits. Always run it from the same folder, so that it finds its state file. Exit code 0 means ok, 1 means the chain could not be read this time, 2 means a setting is wrong.

## Privacy

- Your RPC provider sees what the watcher reads and its IP address. Use your own node, or an RPC you trust, if that matters to you.
- The watcher never writes your RPC URL, your webhook URL, the bot token, the Resend key, the key of the lists, the Redis token or the cron secret into a message or its log.
- For the Telegram bot and email, see "What the service keeps" above.

## Limits

- The watcher trusts its RPC. A wrong or hostile RPC can hide a request. For redundancy, run two watchers on different machines with different RPC providers.
- It checks once per poll (default every 60 seconds), so it reports with that delay.
- It cannot stop or cancel anything itself. It only tells you, early enough to act.
- It names a new wallet, a new guardian and the end of a guardian by their shape, and does not prove them. See "What it reports".
- With only `DELAY` set (no `CHRONOBOX`) it does not look for the cancel contract and does not report who can cancel.
- It reports who can cancel, and who can change that. It does not read what the cancel contract allows them to do. The app checks that, from the whole history of the contract.
- The Delay of a Chronobox has no event for a cancel or for a request that was carried out. The watcher reads both from the Safe of the Chronobox, a SafeL2: it logs each call of a module (`SafeModuleTransaction`) and its result (`ExecutionFromModuleSuccess` or `…Failure`), in the order of the chain. The watcher replays them from the last poll, so a request that was carried out and a cancel in the same block are told apart, and a cancel that failed counts for nothing. The request that was carried out is the first one from the head that is exactly the call and still valid then; each one before it must have run out of time (two requests can be alike). A request it could not read (more than 50 waiting at the first start) proves nothing and matches nothing: it counts as removed only if its time had provably run out, and otherwise the replay is unsure. A request whose time had run out when a cancel covered it is "Removed": it was void either way. A request counts as removed only if its time had run out by the delay and the time to finish in force then; the replay follows each change of them in order, and they must end as the ones read now. It needs no old state from the RPC.
- What the replay cannot explain (a call that does not match the request, a Safe that is not a SafeL2) is reported as "carried out, or cancelled", never as "No money moved". For money, that message is as loud as money that goes to another address.
- All times in a message are UTC. The watcher does not know where the reader lives.

## The code

```
src/chain.ts       pinned contract constants, ABI helpers, JSON-RPC client with fallbacks
src/describe.ts    what a request does, in the words of the app
src/status.ts      when a request is ready or void, and why it left the queue
src/format.ts      names of networks, times, durations, amounts
src/watcher.ts     the watcher of one Chronobox: read, compare, alert, deliver
src/all.ts         --all: every Chronobox on one network
src/telegram.ts    the bot: the sealed list of chats, the commands, delivery
src/email.ts       email: the sealed list of addresses, the steps of the pages and their route table, delivery through Resend
src/pages.tsx      the pages of email (sign up, confirm, stop), rendered on the server, without script
src/mail.tsx       the HTML of the emails, with react-email
src/notices.ts     when somebody stops, the others are told: the rules, shared by Telegram and email
src/store.ts       where the state is kept: files, memory, dry run; and the locks
src/redis.ts       the same in Upstash Redis
src/config.ts      the settings of the CLI
src/cli.ts         the CLI (dist/watch.mjs)
src/service.ts     the service on Vercel: poll, telegram, email, health
src/vercel.ts      a handler of the service as a Vercel function
src/api/           the four functions
src/limits.ts      how long a function may run, and what depends on it
build.mjs          .vercel/output/ and dist/watch.mjs
jsx.mjs            lets Node run the .tsx files as they are (esbuild), for the tests and npm start
test/              unit tests, and stand-ins for the chain, Telegram, Resend and Redis
```
