# Chronobox watcher

A Chronobox is a Safe. Everything goes through a Zodiac Delay, controlled by one wallet, and waits the full delay: a withdrawal, a change of the delay, a change of the wallet. The wallet can cancel what waits, through a Zodiac Roles modifier with that one permission. Cancel is worth nothing if nobody knows that something waits. That is what this watcher is for.

The watcher reads the chain every minute and sends a message when something happens. It runs in two ways:

- **As an alert service (`--all`).** It watches every Chronobox on one or more networks and runs a Telegram bot. A person opens the bot from the Chronobox app, presses Start, and gets the alerts of that Chronobox in Telegram.
- **For one Chronobox.** It watches the address you give it and posts every alert to a webhook of yours.

The watcher is a program of its own. It is not part of the Chronobox website, and it does not start when the website is published. Somebody must run it on a machine that stays on: a small server, or a computer at home. A host that runs code only when a request comes in (Vercel, Netlify and others like them) cannot run it. If the app shows the button "Get alerts in Telegram" and no watcher runs, the bot does not answer and nobody gets an alert.

It is one file with no packages and no keys. It needs Node.js 22.18 or newer. Run `node watch.ts --help` for all settings. Each setting works as an environment variable (`POLL_SECONDS=30`) or as a flag (`--poll-seconds 30`).

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

## The alert service (`--all`)

1. In Telegram, write to [BotFather](https://t.me/BotFather): `/newbot`, a name, a username. It answers with a token.
2. Make a key for the list of chats. Do this one time, and keep the key:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

3. Start the watcher with the token and the key:

   ```sh
   export RPC_URL=https://your-rpc,https://backup-rpc
   export TELEGRAM_TOKEN=123456:AA...
   export TELEGRAM_KEY=<the key from step 2>
   export STATE_DIR=/var/lib/chronobox-watcher
   node watch.ts --all
   ```

4. Only when the watcher runs: in the Chronobox app, set `ALERTS_TELEGRAM` in `src/lib/chains.ts` to the username of the bot and build. A Chronobox then shows "Get told" with one button, "Get alerts in Telegram".

How it finds the Chronoboxes:

- A new Chronobox by the Delay that it deploys (the `ModuleProxyCreation` event of the Zodiac factory), and an older one when it asks for something (`TransactionAdded`, read from every contract on the chain), or when somebody presses Start for it.
- It accepts an address only if it is a Safe whose single owner is the burn address and whose modules are that Delay, or that Delay and a Roles modifier.
- A Chronobox where nothing waits cannot change until somebody asks for something. So the watcher reads a Chronobox only when something waits there, when something new was asked for, or when its "All quiet" message is due and a chat follows it. One log request per poll covers all quiet ones.
- The first start begins at the newest block. Set `START_BLOCK` to search from an older block.

How a person subscribes:

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

- The bot needs no domain and no open port. It asks Telegram for new messages (long polling).
- The RPC must answer `eth_getLogs` without an address filter. Lower `LOG_CHUNK` if it limits the block range.
- With `--once` the bot reads its messages one time per run, so an answer takes as long as the pause between two runs. Run the watcher as a service.
- `CHRONOBOX`, `DELAY` and `STATE_FILE` do not work with `--all`. `WEBHOOK_URL` works, and gets the alerts of every Chronobox.
- Not tested yet with the real Telegram. The checks are the unit tests and `npm run test:fork:alerts`, which runs the watcher against the real contracts on a fork with a stand-in for the Telegram API.

### What the service keeps

- Public chain data: the Chronoboxes it found and what waits in them.
- `STATE_DIR/telegram.json`: for each chat that pressed Start, the number of the chat and the Chronoboxes it follows. No name, no username, no phone number, no message.
- That list is personal data. It links a Telegram account to a Chronobox, and so to an amount of money.
- The list is encrypted on disk with `TELEGRAM_KEY` (AES-256-GCM). The file holds no address and no chat number that somebody can read without the key. So the file, a backup of it or the disk alone are worth nothing.
- Keep the key and the token away from `STATE_DIR` and its backups: in the secret store of your host, or in a file that only the service can read. With the list and the token, somebody could write to every person as the real bot.
- The key does not protect against a person who controls the running watcher. The watcher must know which chats follow a Chronobox when it sends an alert, so it holds the list and the key. Only a sealed enclave could hide the list from the person who runs the machine. That is not built.
- If the key is lost, the list is lost: remove `telegram.json`, and every person must press Start again. A wrong key stops the watcher with a clear message. It does not start with an empty list.
- The watcher does not write the number of a chat, the token or the key to its log.
- Telegram knows the phone number of each account and can read what the bot sends. What the bot sends is public on the chain. That an account follows a Chronobox is not.

### Try it on your machine

Make a test bot with BotFather, put its username in `ALERTS_TELEGRAM`, start the fork (`npm run fork`) and the app (`npm run dev`), and run:

```sh
RPC_URL=http://127.0.0.1:8545 TELEGRAM_TOKEN=123456:AA... TELEGRAM_KEY=<32 characters or more> node watch.ts --all
```

Then press "Get alerts in Telegram" in a Chronobox. On the local fork the network is Ethereum (chain 1), so the link starts with `1-`.

## One Chronobox, to a webhook

```sh
export RPC_URL=https://your-rpc,https://backup-rpc
export CHRONOBOX=0xYourChronobox
export WEBHOOK_URL=https://your-server.example/chronobox
node watch.ts
```

Test your setup first. `--dry-run` prints the messages and sends nothing:

```sh
RPC_URL=https://your-rpc CHRONOBOX=0xYourChronobox node watch.ts --once --dry-run
```

The first run sends one "Watching this Chronobox" message with what waits, the wallet, and who can cancel. The watcher remembers what it sent in `chronobox-watch-state.json` in the current folder (change it with `STATE_FILE`).

With `WEBHOOK_URL`, every alert is a JSON POST:

```json
{ "event": "queued", "title": "...", "message": "...", "priority": 3, "vault": "0x...", "delay": "0x...", "chainId": 1, "nonce": 4, "at": "2026-11-17T19:00:00.000Z" }
```

`event` is one of `watching`, `queued`, `ready`, `expires_soon`, `expired`, `cancelled`, `closed`, `settings_changed`, `heartbeat`, `watcher_problem`, `watcher_recovered`. `priority` goes from 2 (All quiet) to 5 (a change of the Chronobox). Any answer other than 2xx counts as failed and is tried again.

If you want the alerts of your own Chronobox in Telegram without anybody else's service, run the alert service above on your own machine with your own bot.

## Run it as a service

Put `watch.ts` in `/opt/chronobox-watcher/` and create `/etc/systemd/system/chronobox-watcher.service`:

```ini
[Unit]
Description=Chronobox watcher
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/chronobox-watcher
EnvironmentFile=/etc/chronobox-watcher.env
Environment=STATE_DIR=/var/lib/chronobox-watcher
ExecStart=/usr/bin/node /opt/chronobox-watcher/watch.ts --all
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
- The watcher never writes your RPC URL, your webhook URL, the bot token or the key of the chat list into a message or its log.
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
