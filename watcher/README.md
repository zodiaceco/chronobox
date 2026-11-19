# Chronobox watcher

A Chronobox vault is a Safe. Everything goes through a Zodiac Delay, controlled by one setup wallet, and waits the full delay: a withdrawal, a change of the delay, a change of the wallet. The setup wallet can cancel what is in the queue, through a Zodiac Roles modifier with that one permission. Cancel is worth nothing if nobody knows that something is waiting. That is what this watcher is for.

The vault only protects you if somebody hears about a withdrawal in time. This watcher checks your vault every minute and sends a message to your phone (through ntfy) or to any webhook when something happens.

It reports:

- **Queued**: a new transaction is waiting in the vault. It says what the transaction does, when it can execute and when it expires. If the vault has cancel, it says that the transaction can be cancelled until it is executed. A transfer to an address other than your wallet is marked as unusual. A transaction that is not a withdrawal (for example one that changes the cooldown, or a call to the Safe, the Delay or the Roles modifier) gets the highest priority.
- **Ready**: a queued transaction can be executed now.
- **Expires soon**: 24 hours before a transaction expires (or halfway through the window if it is shorter than 48 hours).
- **Expired**: a transaction can no longer execute.
- **Cancelled**: a queued transaction was cancelled. Nothing moved.
- **Closed**: a transaction left the queue without a cancel. The message says if it was executed, or if it had expired and was removed.
- **Settings changed**: cooldown, expiration, owner wallet, vault modules, or who can cancel are different. It names the change, for example "A new address can now cancel: 0x…".
- **All quiet**: a daily heartbeat, so you can tell silence from a broken watcher.
- **Watcher problems**: the watcher could not read the chain for 3 polls in a row, and again when it recovers.

Each message is sent once, also across restarts. A message that could not be delivered is tried again on the next poll.

## What it needs

- Node.js 22.18 or newer. Nothing else: one file, no packages, no keys.
- Your vault address (`CHRONOBOX`). It is public.
- An RPC URL for the vault's chain (`RPC_URL`). You can give several, separated by commas. The watcher uses the next one when one fails.
- Somewhere to send messages: `NTFY_URL` and/or `WEBHOOK_URL`.

Run `node watch.ts --help` for all settings. Each setting works as an environment variable (`POLL_SECONDS=30`) or as a flag (`--poll-seconds 30`).

## Pick an ntfy topic

Install the ntfy app on your phone. Anybody who knows a topic name on ntfy.sh can read its messages, so use a long random name:

```sh
node -e "console.log('chronobox-' + crypto.randomUUID())"
```

Subscribe to that topic in the app and set `NTFY_URL=https://ntfy.sh/<that-name>`. Give the topic to a second person too (partner, friend, lawyer). An alert helps most when it reaches somebody other than you.

To keep the messages away from ntfy.sh, run your own ntfy server and point `NTFY_URL` at it. If your server needs a login, set `NTFY_TOKEN`.

## Run it

Test your setup first. `--dry-run` prints the messages instead of sending them:

```sh
RPC_URL=https://your-rpc CHRONOBOX=0xYourVault node watch.ts --once --dry-run
```

### 1. In a terminal

```sh
export RPC_URL=https://your-rpc,https://backup-rpc
export CHRONOBOX=0xYourVault
export NTFY_URL=https://ntfy.sh/chronobox-your-long-random-topic
node watch.ts
```

The first run sends one "Watching the vault" message with the current queue. It also says whether the vault has cancel and which addresses can cancel. The watcher remembers what it sent in `chronobox-watch-state.json` in the current folder (change it with `STATE_FILE`).

### 2. As a systemd service (Raspberry Pi, VPS)

Put `watch.ts` in `/opt/chronobox-watcher/` and create `/etc/systemd/system/chronobox-watcher.service`:

```ini
[Unit]
Description=Chronobox watcher
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/chronobox-watcher
Environment=RPC_URL=https://your-rpc,https://backup-rpc
Environment=CHRONOBOX=0xYourVault
Environment=NTFY_URL=https://ntfy.sh/chronobox-your-long-random-topic
Environment=STATE_FILE=/var/lib/chronobox-watcher/state.json
ExecStart=/usr/bin/node /opt/chronobox-watcher/watch.ts
Restart=always
RestartSec=30
DynamicUser=yes
StateDirectory=chronobox-watcher

[Install]
WantedBy=multi-user.target
```

The state file goes to `/var/lib/chronobox-watcher/`, the folder systemd creates for the service. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now chronobox-watcher
journalctl -u chronobox-watcher -f
```

### 3. With cron

`--once` checks one time and exits. This runs it every 5 minutes:

```cron
*/5 * * * * cd /home/me/chronobox && RPC_URL=https://your-rpc CHRONOBOX=0xYourVault NTFY_URL=https://ntfy.sh/chronobox-your-long-random-topic node watch.ts --once >> watch.log 2>&1
```

Always run it from the same folder, so it finds its state file. Exit code 0 means ok, 1 means the chain could not be read this time, 2 means a setting is wrong.

## Watch every Chronobox (`--all`)

With `--all` the watcher is an alert service for a whole chain. It needs no list of vaults and no list of people:

- It finds a new Chronobox by the Delay that the vault deploys (the `ModuleProxyCreation` event of the Zodiac factory), and an older one when it queues a transaction (`TransactionAdded`, read from every contract on the chain).
- It accepts a vault only if it is a Safe whose single owner is the burn address and whose modules are that Delay, or that Delay and a Roles modifier.
- It publishes the alerts of each vault to its own ntfy topic: `chronobox-<chain id>-<vault address in lower case>`. Anybody can work out the topic from the address, so nobody has to sign up. The Chronobox app shows the topic as a QR code.
- A vault with an empty queue cannot change until it queues something. So the watcher reads a vault only when something waits there, when it queued something new, or when its "all quiet" message is due. One log request per poll covers all quiet vaults.

```sh
export RPC_URL=https://your-rpc,https://backup-rpc
export NTFY_SERVER=https://alerts.example.org
export NTFY_TOKEN=tk_...            # the watcher's token, see below
export STATE_DIR=/var/lib/chronobox-watcher
node watch.ts --all
```

`CHRONOBOX`, `DELAY`, `NTFY_URL` and `STATE_FILE` do not work with `--all`. The first start begins at the newest block. Set `START_BLOCK` to find Chronoboxes that are already there. Run one watcher per chain, each with its own `STATE_DIR`. `WEBHOOK_URL` gets the alerts of all vaults.

The RPC must answer `eth_getLogs` without an address filter. Lower `LOG_CHUNK` if it limits the block range.

### The ntfy server

Run your own [ntfy](https://docs.ntfy.sh/install/) server, so that only the watcher can publish. In `server.yml`:

```yaml
base-url: "https://alerts.example.org"
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "read-only"       # everybody can listen, nobody can publish
cache-file: "/var/cache/ntfy/cache.db" # a phone that was offline gets the alerts of the last 12 hours
upstream-base-url: "https://ntfy.sh"   # needed for instant alerts on iPhones
```

Then give the watcher the right to publish, and a token:

```sh
ntfy user add watcher
ntfy access watcher "chronobox-*" write
ntfy token add watcher
```

Put the token in `NTFY_TOKEN`. If the watcher sends many alerts at once, add its address to `visitor-request-limit-exempt-hosts`.

In the Chronobox app, set `ALERTS_SERVER` in `src/lib/chains.ts` to the same URL and build.

### What the service knows

- It keeps public chain data only: the vaults it found and their queues. It has no accounts, no email addresses and no list of who listens.
- The ntfy server sees the internet address of each phone that listens, and the topic names the vault. Turn off access logs in ntfy and in the proxy in front of it. This is a promise to the users, not a proof.
- With `upstream-base-url`, ntfy.sh gets a hash of the topic and a message ID for each alert, to wake up iPhones. It does not get the text. A hash of a public topic can be matched to a vault.
- Not tested yet: a real ntfy server, real phones, a real chain. The checks so far are the unit tests and `npm run test:fork:alerts`, which runs the watcher against the real contracts on a fork with a stand-in for ntfy.

### Try it on your machine

The dev build of the app (`npm run dev`) points at `http://localhost:3133`:

```sh
docker run -p 3133:80 binwiederhier/ntfy serve
RPC_URL=http://127.0.0.1:8545 NTFY_SERVER=http://localhost:3133 node watch.ts --all
```

Create a Chronobox in the app, open "Get told", and open the topic at `http://localhost:3133/<topic>` in a browser.

## Webhook

With `WEBHOOK_URL`, every alert is a JSON POST:

```json
{ "event": "queued", "title": "...", "message": "...", "vault": "0x...", "delay": "0x...", "chainId": 1, "nonce": 4, "at": "2026-11-17T19:00:00.000Z" }
```

`event` is one of `watching`, `queued`, `ready`, `expires_soon`, `expired`, `cancelled`, `closed`, `settings_changed`, `heartbeat`, `watcher_problem`, `watcher_recovered`. Any answer other than 2xx counts as failed and is tried again.

## Privacy

- Your RPC provider sees which vault you watch and your IP address. Use your own node, or an RPC you trust, if that matters to you.
- ntfy.sh sees the message text (vault address, amounts, times). Self-host ntfy if you do not want that.
- The watcher never writes your RPC URL or ntfy topic into a message or its log.

## Limits

- The watcher trusts its RPC. A wrong or hostile RPC can hide a transaction. For redundancy, run two watchers on different machines with different RPC providers.
- It checks once per poll (default every 60 seconds), so it reports events with that delay.
- A batch transaction (for example through MultiSend) is reported as "not a withdrawal", even if it only moves funds. Check it in the Chronobox app before it can execute.
- It cannot stop or cancel anything itself. It only tells you, early enough to act. In a vault with cancel, your wallet can cancel. An older vault (only the Delay) has no cancel.
- It finds the Roles modifier only when you set `CHRONOBOX`. With only `DELAY` it does not report who can cancel.
- It checks who can cancel and that nobody can change that, not what the Roles modifier allows them to do.
- The Delay of a Chronobox has no event for a cancel. The watcher reads a cancel from the vault's module calls (`SafeModuleTransaction`, which a SafeL2 emits). A vault that is not a SafeL2 has no such event, and a cancel there is reported as "closed".
- To tell a cancel from an execution, it reads the queue position one block before each cancel. If your RPC no longer has that block, a transaction that was ready at the time is reported as "executed, or cancelled".
