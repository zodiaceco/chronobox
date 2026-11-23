# Chronobox watcher

A Chronobox is a Safe. Everything goes through a Zodiac Delay, controlled by one wallet, and waits the full delay: a withdrawal, a change of the delay, a change of the wallet. The wallet can cancel what waits, through a Zodiac Roles modifier with that one permission. Cancel is worth nothing if nobody knows that something waits. That is what this watcher is for.

The watcher reads the chain every minute and sends a message when something happens. It is a project of its own, in this folder. It is not part of the Chronobox website and has its own `package.json`. It runs in three ways:

- **As the alert service on Vercel.** It watches every Chronobox on one or more networks and runs a Telegram bot. A person opens the bot from the Chronobox app, presses Start, and gets the alerts of that Chronobox in Telegram. Nothing has to stay on: Vercel Cron starts a poll every minute, and Telegram calls a webhook with each message to the bot. The state is in Upstash Redis. See "The alert service on Vercel".
- **As the same alert service on a machine that stays on (`--all`).** The CLI, with the state in files. The bot asks Telegram for its messages, so it needs no domain and no open port.
- **For one Chronobox.** The CLI watches the address you give it and posts every alert to a webhook of yours.

If the app shows the button "Get alerts in Telegram" and no watcher runs, the bot does not answer and nobody gets an alert.

It has no runtime dependencies and needs no keys of a wallet. It needs Node.js 22.18 or newer. `npm run build` makes two things: the functions for Vercel in `.vercel/output/`, and the CLI as one file, `dist/watch.mjs`. Run `node dist/watch.mjs --help` (or `node src/cli.ts --help`) for all settings of the CLI. Each setting works as an environment variable (`POLL_SECONDS=30`) or as a flag (`--poll-seconds 30`).

```sh
npm install
npm test          # unit tests, with stand-ins for the chain, Telegram and Redis
npm run check     # TypeScript
npm run build     # .vercel/output/ and dist/watch.mjs
```

`npm run test:fork:alerts` in the folder above runs the alert service against the real contracts on a fork.

## What it reports

The messages use the words of the Chronobox app. No message has a link in it.

- **New request**: somebody asked the Chronobox for something. The message says what it is, when its wait ends, and what to do if it was not you. A withdrawal to the wallet of the Chronobox is the quiet kind. Money that would go to another address is marked. Every change of the Chronobox is the loudest kind: a new delay, a new wallet, a guardian, or anything that the app does not make.
- **Wait over**: the wait of a request is over, and it can be finished.
- **Ends soon**: 24 hours before a request becomes void (or halfway through its time if that is shorter than 48 hours).
- **Too late**: a request was not finished in time and is void.
- **Cancelled**: a request was cancelled.
- **Done**, **Removed** or **Closed**: a request is gone without a cancel. The message says if it was carried out, or if it was too late and was removed.
- **This Chronobox changed**: the delay, the wallet, who can cancel, or the parts of the Chronobox are different from the last look. This comes from the state of the contracts, so it also catches a change that was not announced by a request.
- **All quiet**: once a day, without a sound, so that silence is different from a broken watcher.
- **Alerts can be late**: the watcher could not read the chain for 3 polls in a row. **Alerts work again** follows when it can.

Each message is sent once, also across restarts. A message that could not be delivered is tried again on the next poll.

The watcher names three requests of the app by their shape: a new wallet, a new guardian, and the end of a guardian. It reads what the request contains, but it cannot prove that the request is exactly the one the app builds. The app can, because it builds the request again and compares every byte. So these messages say "open your Chronobox to check that the request is what it looks like", and they are always the loudest kind.

## The alert service on Vercel

The service is a second Vercel project, made from the same repository. The website stays a static site with no backend.

```
Vercel Cron, every minute ──▶ /api/poll       reads every network, sends the alerts
Telegram, each message ──────▶ /api/telegram   answers /start, /stop, /list, /privacy
an uptime monitor ───────────▶ /api/health     503 when the polls stopped
                                    │
                              Upstash Redis: what the watcher knows, the sealed list of chats, the locks
```

### Set it up

1. In Telegram, write to [BotFather](https://t.me/BotFather): `/newbot`, a name, a username. It answers with a token.
2. Make two secrets, one for the list of chats and one for Vercel Cron. Keep the first one: without it the list is lost.

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
   | `TELEGRAM_KEY` | The first secret from step 2. It encrypts the list of chats. |
   | `CRON_SECRET` | The second secret. Vercel Cron sends it with each call, and `/api/poll` refuses a call without it. |
   | `RPC_SERVICE_KEY` | Optional. The service key of chronobox for the internal RPC of Zodiac (see below). |
   | `RPC_SERVICE_HOST` | Optional. Where the key goes (default `rpc.zodiac.eco`). |
   | `WEBHOOK_URL` | Optional. Gets every alert of every Chronobox as a JSON POST. |
   | `START_BLOCK_<chain id>` | Optional. The first block to search for Chronoboxes. Default: the newest block at the first poll. |
   | `PUBLIC_URL` | Optional. The address where Telegram reaches the bot. Default: the production domain of the project. |
   | `HEARTBEAT_HOURS`, `FAIL_POLLS`, `LOG_CHUNK`, `MAX_SCAN_BLOCKS` | Optional, as in the CLI. |
   | `POLL_BUDGET_SECONDS` | Optional. After this time a poll reads no further Chronobox, and the next poll goes on (default 60). |
   | `HEALTH_MAX_AGE_SECONDS` | Optional. `/api/health` answers 503 when the last poll is older (default 300). |
   | `REDIS_PREFIX` | Optional. Every key starts with it (default `chronobox:`). |

6. Deploy to production. Within a minute the first poll runs. It tells Telegram to send the messages of the bot to `/api/telegram`, with a secret that Telegram sends back each time. The poll does that again when the address, the token or the key changes.
7. Open `/api/health`. It says when the last poll ran and if every network could be read.
8. Only then: in the Chronobox app, set `ALERTS_TELEGRAM` in `src/lib/chains.ts` to the username of the bot and build. A Chronobox then shows "Get told" with one button, "Get alerts in Telegram".
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
- **Locks.** Vercel can start a poll while the last one still runs, and Telegram calls the webhook at any time. So a poll takes the lock of its network, and a poll that finds it taken stops at once: the one before it does the work. A Start waits for the lock (up to 30 seconds), because it reads the Chronobox. A change of the list of chats takes the lock of the list. A lock is a key in Redis that runs out after 130 seconds, longer than a function may run (`src/limits.ts`). A function that was killed blocks the next ones until then.
- **Each message is answered once.** Telegram sends a message again when the answer was slow. The webhook notes each message for a day and does not answer it twice.
- **Each alert is sent once.** As in the CLI, a chat that got an alert is noted, and only the others are tried again. If a function is killed between sending and saving, a message can come twice. It is never lost.
- **The webhook and long polling exclude each other.** A bot can do only one. When the service sets its webhook, a CLI that reads the same bot gets an error (409). Give the service its own bot, or stop the CLI.

The functions are bundled by `build.mjs` and deployed as they are (the Build Output of Vercel). The cron job is in `.vercel/output/config.json`, made from `src/limits.ts`.

## The alert service on a machine (`--all`)

1. Make a bot and a key, as in steps 1 and 2 above.
2. Start the watcher with the token and the key:

   ```sh
   export RPC_URL=https://your-rpc,https://backup-rpc
   export TELEGRAM_TOKEN=123456:AA...
   export TELEGRAM_KEY=<the key from step 2>
   export STATE_DIR=/var/lib/chronobox-watcher
   node dist/watch.mjs --all
   ```

3. Only when the watcher runs: set `ALERTS_TELEGRAM` in the app, as above.

How it finds the Chronoboxes (on Vercel too):

- A new Chronobox by the Delay that it deploys (the `ModuleProxyCreation` event of the Zodiac factory, for the master copy of the Delay), and any Chronobox when somebody presses Start for it.
- It reads logs only from contracts it chose: the factory, and the Delays of the Chronoboxes it knows. Anybody can deploy contracts that emit any event, so a search over every contract would let anybody fill a poll. That is why an older Chronobox is not found when it asks for something. Set `START_BLOCK` to the block of the first Chronobox to find them all from the factory.
- A new Delay waits in a queue until it is checked. The queue is saved together with the search, before any check, so a search is never done twice. Each poll checks a batch of 8 at least, and new Delays get a quarter of its time at most, so a flood of Delays from the factory cannot take the time of the Chronoboxes that are known. The queue holds 1000 at most; more is dropped and logged. A Chronobox among them is still found when somebody presses Start for it.
- It accepts an address only if it is a Safe whose single owner is the burn address and whose modules are that Delay, or that Delay and a Roles modifier.
- A Chronobox where nothing waits cannot change until somebody asks for something. So the watcher reads a Chronobox only when something waits there, when something new was asked for, or when its "All quiet" message is due and a chat follows it. One log request per poll (per 100 Chronoboxes) covers all quiet ones.
- The first start begins at the newest block. Set `START_BLOCK` to search from an older block.

How a person subscribes (on Vercel too):

- The app builds the link `https://t.me/<bot>?start=<chain id>-<address>`. Telegram shows the bot and a Start button. The bot gets `/start <chain id>-<address>` together with the number of the chat. Nobody fills in a form, and the app sends nothing.
- The bot checks on the chain that the address is a Chronobox. Then it keeps the pair (chat, Chronobox) and answers with what waits there right now.
- From then on every alert of that Chronobox goes to that chat. "All quiet" arrives without a sound. Money to another address is marked with a warning sign, and a change of the Chronobox with an alarm sign, because Telegram cannot ring louder.
- `/stop` ends all alerts of a chat and deletes it. `/stop <address>` ends one. `/list` shows what the chat follows. `/privacy` says what the bot keeps. A chat can follow 20 Chronoboxes at most.
- When a chat stops, every other chat that follows the same Chronobox is told. Alerts must not go off in silence.
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
- Not tested yet with the real Telegram, and not deployed to Vercel yet. The checks are the unit tests (with stand-ins for the chain, Telegram and Redis) and `npm run test:fork:alerts`, which runs the watcher against the real contracts on a fork with a stand-in for the Telegram API.

### What the service keeps

- Public chain data: the Chronoboxes it found and what waits in them.
- The list of chats (`STATE_DIR/telegram.json`, or the key `chronobox:telegram` in Redis): for each chat that pressed Start, the number of the chat and the Chronoboxes it follows. No name, no username, no phone number, no message.
- That list is personal data. It links a Telegram account to a Chronobox, and so to an amount of money.
- The list is encrypted with `TELEGRAM_KEY` (AES-256-GCM). It holds no address and no chat number that somebody can read without the key. So the file, the Redis database, a backup of either, or the disk alone are worth nothing.
- Keep the key and the token away from where the list is: in the secret store of your host, or in a file that only the service can read. On Vercel the key is in the environment of the project, and the list is at Upstash, two different companies. With the list and the token, somebody could write to every person as the real bot.
- The key does not protect against a person who controls the running watcher. The watcher must know which chats follow a Chronobox when it sends an alert, so it holds the list and the key. Only a sealed enclave could hide the list from the person who runs the machine. That is not built.
- If the key is lost, the list is lost: remove `telegram.json` (or the key `chronobox:telegram` in Redis), and every person must press Start again. A wrong key stops the watcher with a clear message (on Vercel: every call answers 500 with it). It does not start with an empty list.
- The watcher does not write the number of a chat, the token or the key to its log.
- Telegram knows the phone number of each account and can read what the bot sends. What the bot sends is public on the chain. That an account follows a Chronobox is not.

### Try it on your machine

Make a test bot with BotFather, put its username in `ALERTS_TELEGRAM`, start the fork (`npm run fork`) and the app (`npm run dev`), and run:

```sh
RPC_URL=http://127.0.0.1:8545 TELEGRAM_TOKEN=123456:AA... TELEGRAM_KEY=<32 characters or more> node src/cli.ts --all
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

`event` is one of `watching`, `queued`, `ready`, `expires_soon`, `expired`, `cancelled`, `closed`, `settings_changed`, `heartbeat`, `watcher_problem`, `watcher_recovered`. `priority` goes from 2 (All quiet) to 5 (a change of the Chronobox). Any answer other than 2xx counts as failed and is tried again.

If you want the alerts of your own Chronobox in Telegram without anybody else's service, run the alert service above on your own machine with your own bot.

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
TELEGRAM_KEY=...
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
- The watcher never writes your RPC URL, your webhook URL, the bot token, the key of the chat list, the Redis token or the cron secret into a message or its log.
- For the Telegram bot, see "What the service keeps" above.

## Limits

- The watcher trusts its RPC. A wrong or hostile RPC can hide a request. For redundancy, run two watchers on different machines with different RPC providers.
- It checks once per poll (default every 60 seconds), so it reports with that delay.
- It cannot stop or cancel anything itself. It only tells you, early enough to act.
- It names a new wallet, a new guardian and the end of a guardian by their shape, and does not prove them. See "What it reports".
- With only `DELAY` set (no `CHRONOBOX`) it does not look for the cancel contract and does not report who can cancel.
- It reports who can cancel, and who can change that. It does not read what the cancel contract allows them to do. The app checks that, from the whole history of the contract.
- The Delay of a Chronobox has no event for a cancel. The watcher reads a cancel from the module calls of the Safe (`SafeModuleTransaction`, which a SafeL2 emits). A Safe that is not a SafeL2 has no such event, and a cancel there is reported as "Closed".
- To tell a cancel from a request that was carried out, it reads the state one block before each cancel. If your RPC no longer has that block, a request whose wait was over at the time is reported as "carried out, or cancelled".
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
src/store.ts       where the state is kept: files, memory, dry run; and the locks
src/redis.ts       the same in Upstash Redis
src/config.ts      the settings of the CLI
src/cli.ts         the CLI (dist/watch.mjs)
src/service.ts     the service on Vercel: poll, telegram, health
src/vercel.ts      a handler of the service as a Vercel function
src/api/           the three functions
src/limits.ts      how long a function may run, and what depends on it
build.mjs          .vercel/output/ and dist/watch.mjs
test/              unit tests, and stand-ins for the chain, Telegram and Redis
```
