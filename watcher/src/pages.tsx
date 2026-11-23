/** @jsxImportSource react */
// The pages of alerts by email (email.ts decides which one, and when). Rendered on the server to plain HTML: no
// script, so that the pages work with `default-src 'none'`, and for programs that open the links in an email. A
// button posts a form back to the same path.
//
// Every value goes in as a text child or an attribute, so React escapes it.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Where the pages are, on Vercel and in the CLI. */
export const EMAIL_PATH = '/api/email';

export type Page = { status: number; html: string };

const STYLE =
  'body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;color:#111;background:#f5f5f7}' +
  'main{max-width:400px;margin:8vh auto;padding:24px;background:#fff;border:1px solid #e3e3e6;border-radius:24px}' +
  '.mark{margin:0 0 18px;color:#111;font-size:.8rem;font-weight:600;letter-spacing:.14em}' +
  'h1{margin:0 0 8px;font-size:1.4rem;letter-spacing:-.015em}p{margin:0 0 14px;color:#555;overflow-wrap:anywhere}' +
  'input{box-sizing:border-box;width:100%;margin:0 0 12px;padding:13px 14px;border:1px solid #cfcfd4;border-radius:14px;background:#fff;color:#111;font:inherit}' +
  'button{width:100%;min-height:50px;border:0;border-radius:999px;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer}' +
  'small{display:block;margin-top:14px;color:#777;font-size:.85rem}.bad{color:#b3261e}' +
  '@media (max-width:460px){main{margin:0;min-height:100vh;border:0;border-radius:0}}' +
  '@media (prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}main{background:#151517;border-color:#2c2c2e}.mark,h1{color:#f5f5f7}p{color:#a1a1a6}' +
  'input{background:#000;border-color:#3a3a3c;color:#f5f5f7}button{background:#f5f5f7;color:#111}small{color:#8e8e93}}';

function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <style>{STYLE}</style>
      </head>
      <body>
        <main>
          <p className="mark">CHRONOBOX ALERTS</p>
          <h1>{title}</h1>
          {children}
        </main>
      </body>
    </html>
  );
}

/** A page with its status. */
function page(status: number, title: string, children: ReactNode): Page {
  return { status, html: '<!doctype html>' + renderToStaticMarkup(<Layout title={title}>{children}</Layout>) };
}

/** A form that posts one hidden field back, with one button. */
function Button({ name, value, label }: { name: string; value: string; label: string }) {
  return (
    <form method="post" action={EMAIL_PATH}>
      <input type="hidden" name={name} value={value} />
      <button type="submit">{label}</button>
    </form>
  );
}

/** What waits in the Chronobox right now, one paragraph per request. */
function Waits({ waits }: { waits: string[] | null }) {
  // Not read yet is not "nothing": the page must not reassure where it does not know.
  if (waits === null) return <p>We could not read yet what waits there. Open your Chronobox to see it. Alerts for what comes next arrive by email.</p>;
  if (waits.length === 0) return <p>Nothing waits there right now.</p>;
  return (
    <>
      <p>{`Right now ${waits.length === 1 ? 'one request waits' : `${waits.length} requests wait`} there:`}</p>
      {waits.map((w, i) => <p key={i}>{w}</p>)}
    </>
  );
}

// --- The steps. `box` is the Chronobox in words: "the Chronobox 0x5a5a…5a5a on Ethereum".

/** The first step: the address. `c` is "<chain id>-<address>", as in the link from the app. */
export const form = (o: { c: string; box: string; problem?: string }, status = 200) => page(status, 'Alerts by email', <>
  <p>For {o.box}.</p>
  {o.problem ? <p className="bad">{o.problem}</p> : null}
  <form method="post" action={EMAIL_PATH}>
    <input type="hidden" name="c" value={o.c} />
    <input type="email" name="email" placeholder="you@example.com" autoComplete="email" required autoFocus />
    <button type="submit">Send me the link</button>
  </form>
  <small>
    We send one email with a link. The alerts start when you open it and confirm. We keep your email address, the address of this
    Chronobox, and since when you follow it. Nothing else.
  </small>
</>);

/** After the first step. The same page for every address: it does not say who is on the list. */
export const sent = (email: string) => page(200, 'Look in your inbox', <>
  <p>We sent a link to {email}. Open it and confirm. It works for one day.</p>
  <small>
    Nothing more comes before you confirm. If no email arrives, look in the spam folder. If you got emails for a Chronobox that is not
    yours, open "Not you? Cancel" in one of them, and then ask again here.
  </small>
</>);

/** The link in the email. A program that reads the email for the person does not press the button. */
export const confirmAsk = (o: { box: string; email: string; token: string }) => page(200, 'Confirm the alerts', <>
  <p>For {o.box}, to {o.email}.</p>
  <Button name="confirm" value={o.token} label="Confirm" />
</>);

export const confirmed = (o: { box: string; waits: string[] | null }) => page(200, 'Done', <>
  <p>You now get the alerts of {o.box} by email.</p>
  <Waits waits={o.waits} />
  <small>To end the alerts, use the link at the end of any alert.</small>
</>);

/** The link at the end of every alert. */
export const stopAsk = (o: { box: string; email: string; token: string }) => page(200, 'Stop these alerts?', <>
  <p>The alerts of {o.box}, to {o.email}.</p>
  <Button name="stop" value={o.token} label="Stop the alerts" />
</>);

/** The cancel link in a confirmation email: every request to this address that is not confirmed. */
export const cancelAsk = (o: { email: string; count: number; token: string }) => page(200, 'Cancel these requests?', <>
  <p>{o.count === 1 ? 'One request for alerts waits' : `${o.count} requests for alerts wait`} for a confirmation from {o.email}.</p>
  <p>Cancel them, and no more email comes for them. Alerts that you confirmed before stay as they are.</p>
  <Button name="cancel" value={o.token} label="Cancel the requests" />
</>);

export const cancelled = () => page(200, 'Done', <>
  <p>We deleted every request to this address that was not confirmed.</p>
  <small>To get the alerts of your own Chronobox, open "Get told" there again.</small>
</>);

export const stopped = (box: string) => page(200, 'Done', <p>No more alerts of {box} to this address. We deleted it from our list.</p>);

// --- What can go wrong

export const incomplete = () => page(400, 'This link is not complete', <p>Open it again from your Chronobox: "Get told", then "Email".</p>);
export const gone = () => page(410, 'This link does not work any more', <p>It was used already, or it is too old. Start again from your Chronobox.</p>);
export const later = () => page(503, 'Try again in a few minutes', <p>We cannot read the network right now.</p>);
export const notWatched = (network: string) => page(404, 'Not a network that we watch', <p>Our alert service does not watch {network}.</p>);
export const notChronobox = (vault: string, network: string) =>
  page(404, 'This is not a Chronobox', <p>{vault} is not a Chronobox on {network}. Open the link again from your Chronobox.</p>);
export const tooMany = () => page(429, 'Too many requests', <p>Try again in an hour.</p>);
export const notSent = () => page(502, 'That did not work', <p>We could not send the email right now. Try again in a few minutes.</p>);
export const tooLong = () => page(413, 'That is too long', <p>Open the link again from your Chronobox.</p>);
export const nothingHere = (status = 404) => page(status, 'Nothing here', <p>Open the link again from your Chronobox or from an email.</p>);
export const broken = () => page(500, 'Something went wrong', <p>Try again in a few minutes.</p>);
