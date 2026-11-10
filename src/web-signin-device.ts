/**
 * #3486: the two cookies of the authenticator sign-in (`POST /auth/totp`), neither of which is a credential.
 *
 * - **The browser's id** (`agend_signin_browser`): a random 128-bit id the first answer to /auth/totp hands out. It only tells the
 *   wrong-code limiter which browser is typing, so that one person's typos pause that browser and no one else (web-remote-access.ts
 *   `signIn`). A browser that drops it is a new browser to this limiter — which is why the shared ceilings exist.
 * - **The known-device mark** (`agend_signin_known`): handed out after a browser signs in as an admin with a correct code. Up to four
 *   entries `<expiry>.<HMAC>`, each the signature (keyed from `web.token`) of ONE admin's identity: who they are, which authenticator
 *   they have now (the enrolment id, which changes when the app is replaced or removed), the revocation epoch, and the expiry. It grants
 *   nothing: it only lets that browser, signing in as that same admin with a correct code, skip the SHARED pauses that someone else's
 *   wrong codes started. An entry names no one (the HMAC is checked against the admin the typed name resolves to), so the cookie reveals
 *   nothing to whoever reads it. Demotion (the name no longer resolves), a replaced or removed app (another enrolment id), a revocation
 *   (the epoch moved) and `agend web-token rotate` (another key) each make it fail to verify, with nothing to clean up.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fleetCookieName } from "./web-cookie-names.js";

export const SIGNIN_BROWSER_COOKIE = "agend_signin_browser";
export const SIGNIN_BROWSER_COOKIE_SECURE = "__Host-agend_signin_browser";
export const SIGNIN_KNOWN_COOKIE = "agend_signin_known";
export const SIGNIN_KNOWN_COOKIE_SECURE = "__Host-agend_signin_known";
export const SIGNIN_KNOWN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const SIGNIN_KNOWN_MAX_ENTRIES = 4;

/** The cookie's value among the request's, by its base name (the secure name first; the plain one never over a public link). */
export function readSigninCookie(cookieHeader: string | undefined, kind: "browser" | "known", publicLink: boolean, webToken: string | null | undefined): string | undefined {
  const jar = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const [plain, secure] = kind === "browser" ? [SIGNIN_BROWSER_COOKIE, SIGNIN_BROWSER_COOKIE_SECURE] : [SIGNIN_KNOWN_COOKIE, SIGNIN_KNOWN_COOKIE_SECURE];
  for (const name of [fleetCookieName(secure, webToken), ...(publicLink ? [] : [fleetCookieName(plain, webToken)])]) { const v = jar.get(name); if (v) return v; }
  return undefined;
}
export function buildSigninCookie(kind: "browser" | "known", value: string, secure: boolean, webToken: string | null | undefined, maxAgeMs = SIGNIN_KNOWN_MAX_AGE_MS): string {
  const [plain, sec] = kind === "browser" ? [SIGNIN_BROWSER_COOKIE, SIGNIN_BROWSER_COOKIE_SECURE] : [SIGNIN_KNOWN_COOKIE, SIGNIN_KNOWN_COOKIE_SECURE];
  return [`${fleetCookieName(secure ? sec : plain, webToken)}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export const newSigninBrowserId = (): string => randomBytes(16).toString("hex");
export const isSigninBrowserId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);

const macOf = (webToken: string, who: string, enrollment: string, epoch: number, expiry: number): string =>
  createHmac("sha256", createHmac("sha256", webToken).update("agend signin known device v1").digest())
    .update(`${who}\0${enrollment}\0${epoch}\0${expiry}`).digest("hex").slice(0, 32);

/**
 * An entry in its one written form, or null: an expiry of 10–16 digits with no leading zero or other spelling (`String(Number(x)) === x`:
 * not `0001234`, `0x4d2`, `1e3`, `12.0`) and a lowercase 32-hex signature. Every mark is counted by the string this returns, so one mark
 * cannot be written as several to be counted several times.
 */
function canonicalEntry(entry: string): { expiry: number; mac: string; text: string } | null {
  const dot = entry.indexOf("."), expiryText = entry.slice(0, dot), mac = entry.slice(dot + 1);
  if (dot < 1 || !/^[1-9][0-9]{9,15}$/.test(expiryText) || String(Number(expiryText)) !== expiryText || !/^[0-9a-f]{32}$/.test(mac)) return null;
  const expiry = Number(expiryText);
  return Number.isSafeInteger(expiry) ? { expiry, mac, text: `${expiryText}.${mac}` } : null;
}

/** Whether one entry of the cookie is this admin's, for the app they have now, under this epoch, and not run out. */
function entryValid(webToken: string, entry: string, who: string, enrollment: string, epoch: number, now: number): boolean {
  const e = canonicalEntry(entry);
  if (!e || e.expiry <= now) return false;
  return timingSafeEqual(Buffer.from(macOf(webToken, who, enrollment, epoch, e.expiry)), Buffer.from(e.mac));
}
const entriesOf = (value: string | undefined): string[] => (value ?? "").split("~").filter(e => e.length > 0 && e.length <= 80).slice(0, SIGNIN_KNOWN_MAX_ENTRIES);

/** The entry of the browser's mark that vouches for `who` — the admin the typed name resolved to — as their app and the epoch stand now; null when none does. */
export function findSigninKnownEntry(webToken: string | null | undefined, value: string | undefined, who: string | null, enrollment: string | null, epoch: number, now: number): string | null {
  if (!webToken || !who || !enrollment) return null;
  const found = entriesOf(value).find(e => entryValid(webToken, e, who, enrollment, epoch, now));
  return found ? canonicalEntry(found)!.text : null;
}
export const signinKnownDevice = (webToken: string | null | undefined, value: string | undefined, who: string | null, enrollment: string | null, epoch: number, now: number): boolean =>
  findSigninKnownEntry(webToken, value, who, enrollment, epoch, now) !== null;
/** The mark after a correct sign-in as `who`: their entry renewed, the others kept while they run out (at most four, newest last). */
export function addSigninKnownDevice(webToken: string, value: string | undefined, who: string, enrollment: string, epoch: number, now: number): string {
  const expiry = now + SIGNIN_KNOWN_MAX_AGE_MS;
  const kept = entriesOf(value).filter(e => !entryValid(webToken, e, who, enrollment, epoch, now) && (canonicalEntry(e)?.expiry ?? 0) > now);
  return [...kept, `${expiry}.${macOf(webToken, who, enrollment, epoch, expiry)}`].slice(-SIGNIN_KNOWN_MAX_ENTRIES).join("~");
}
