// Every request passes this gate, static files included. Without CHRONOBOX_PASSWORD set, nothing is served.
// This protects the preview site only. The app itself has no account and no server.
import { authorized, COOKIE, same, token } from "../lib/auth.ts";

declare const Netlify: { env: { get(name: string): string | undefined } };

const MARK = `<svg viewBox="2 2 60 60" width="56" height="56" aria-hidden="true"><defs><clipPath id="t"><rect x="2" y="2" width="60" height="60" rx="15.5"/></clipPath><radialGradient id="s" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(31.83 96.21) scale(104.07 99.1)"><stop offset="0.596" stop-color="#B1D3F2"/><stop offset="0.803" stop-color="#469CED"/><stop offset="1" stop-color="#286CB2"/></radialGradient></defs><g clip-path="url(#t)"><rect x="2" y="2" width="60" height="60" fill="url(#s)"/><path d="M15.58 45.4A17 17 0 0 1 24.02 25.99" fill="none" stroke="#fff" stroke-width="2.6"/><path d="M24.02 25.99A17 17 0 0 1 48.42 45.4" fill="none" stroke="#fff" stroke-width="2.6" opacity="0.45"/><circle cx="31.83" cy="96.21" r="61.01" fill="#469CED"/><circle cx="24.02" cy="25.99" r="6" fill="#fff"/></g></svg>`;

const page = (error: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Chronobox</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0b0b0c;--muted:#6a6a70;--line:#c9c9ce;--bad:#9b1c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--fg:#f4f4f5;--muted:#9a9aa2;--line:#3a3a40;--bad:#f5b5b5}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--fg);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
form{display:grid;justify-items:center;gap:14px;width:100%;max-width:320px;text-align:center}
h1{margin:6px 0 0;font-size:15px;font-weight:600;letter-spacing:.16em}
p{margin:0;color:var(--muted)}
input,button{width:100%;height:48px;border-radius:999px;font:inherit}
input{padding:0 18px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg);text-align:center}
input:focus-visible{outline:2px solid #469CED;outline-offset:2px}
button{border:0;background:var(--fg);color:var(--bg);font-weight:600;cursor:pointer}
.e{color:var(--bad);font-size:14px}
</style></head><body><form method="post" action="/login">
${MARK}
<h1>CHRONOBOX</h1>
<p>This preview is private.</p>
<input type="password" name="password" placeholder="Password" aria-label="Password" autocomplete="current-password" autofocus required>
${error ? `<p class="e" role="alert">${error}</p>` : ""}
<button type="submit">Open</button>
</form></body></html>`;

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });

export default async (req: Request, context: { next: () => Promise<Response> }) => {
  const password = Netlify.env.get("CHRONOBOX_PASSWORD");
  if (!password) return new Response("Not configured", { status: 503 });
  const url = new URL(req.url);

  if (url.pathname === "/login" && req.method === "POST") {
    const form = await req.formData();
    const given = String(form.get("password") || "");
    if (!same(await token(given), await token(password))) {
      await new Promise((r) => setTimeout(r, 600));
      return html(page("Wrong password."), 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": `${COOKIE}=${await token(password)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  if (!(await authorized(req, password))) return html(page(""), 401);
  const res = await context.next();
  const out = new Response(res.body, res);
  out.headers.set("x-robots-tag", "noindex");
  return out;
};

export const config = { path: "/*" };
