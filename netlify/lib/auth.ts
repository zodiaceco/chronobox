// Password gate for the private preview. The cookie holds an HMAC of a fixed label keyed with the
// password, so changing CHRONOBOX_PASSWORD in Netlify signs everyone out. The password is never stored.
export const COOKIE = "cb_preview";

export async function token(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("chronobox-preview-v1"));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function cookieValue(req: Request): string {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([a-f0-9]+)"));
  return m ? m[1] : "";
}

export async function authorized(req: Request, password: string | undefined): Promise<boolean> {
  if (!password) return false;
  return same(cookieValue(req), await token(password));
}
