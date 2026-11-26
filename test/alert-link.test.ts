// An alert ends with a link to the page of its Chronobox in the app. The alert service has its own list of the
// network names in that link, so this test holds it together with the list of the app.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAINS } from "../src/lib/chains.ts";
import { APP_URL, boxLink } from "../watcher/src/format.ts";
import { telegramText } from "../watcher/src/telegram.ts";

const VAULT = `0x${"5a".repeat(20)}`;

test("the link in an alert is the page of the Chronobox, on every network of the app", () => {
  for (const chain of CHAINS) {
    assert.equal(boxLink(APP_URL, chain.id, VAULT), `https://www.chrono.box/#/v/${chain.short}:${VAULT}`, chain.name);
  }
  assert.equal(boxLink(APP_URL, 137, VAULT), null, "a network that the app does not have gets no link");
});

test("a long alert in Telegram is cut before the link, never in it", () => {
  const alert = { id: "1", event: "queued", title: "New request", message: "x".repeat(5000), priority: 3, at: 0, done: [] };
  const text = telegramText(alert as never, 1, VAULT);
  assert.ok(text.length <= 4000);
  assert.ok(text.endsWith(`…\n\nChronobox 0x5a5a…5a5a on Ethereum\nhttps://www.chrono.box/#/v/eth:${VAULT}`));
  assert.ok(telegramText({ ...alert, message: "short" } as never, 137, VAULT).endsWith("\n\nChronobox 0x5a5a…5a5a on Polygon"), "no link where the app is not");
});
