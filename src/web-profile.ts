/**
 * #1827: the name a web person shows agents and chats, instead of "web-user". Design: #1827 issuecomment-6169960931.
 *
 * - A web person is whoever a session was signed in for: the chat user a `/dashboard` code was sent to privately
 *   (`<connection>:<user id>`, recorded on the session), or — a code from `agend web`, a session from before — the host
 *   operator. They keep one name and one id on every device; the id is random (web-prefs.ts), never the name.
 * - The name is self-asserted display text. It grants nothing: web messages stay `via web` with no verified actor
 *   (#1756). What it must not do is pose as something else — a platform header, a mention, an instance, AgEnD itself —
 *   so it is refused (never silently rewritten) unless it is plain: letters, marks, digits, spaces, emoji, `. - _ ' ·`.
 * - A stored name is checked again where it is used (the file can be edited, an instance can be named after it later):
 *   one that no longer passes reads as "web-user".
 */
import { OPERATOR } from "./web-prefs.js";

export const WEB_NAME_FALLBACK = "web-user";
export const WEB_NAME_MAX_GRAPHEMES = 32;

/** The bound account a session was signed in as (its sign-in code's owner); none is the host operator. */
export interface WebAccount { readonly adapterId: string; readonly userId: string }
/** A web person's key in the web preferences: their account (connection and user id), or the operator. */
export function webPersonKey(owner: WebAccount | undefined): string {
  return owner ? `person:${owner.adapterId}:${owner.userId}` : OPERATOR;
}

// Bidi controls (ALM, LRM/RLM, embeddings and overrides, isolates) and zero-width / invisible formatting characters.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/**
 * What a name may contain. Letters, combining marks, digits, spaces; emoji (pictographs with variation selectors, skin
 * tones and keycaps — not joined sequences: a zero-width joiner is invisible, refused above); and `. - _ ' ·`. Everything else — `[ ] < > @ : , # / \` among it — is refused:
 * those are what a `[user:… via …, id:…]` header, a `<@id>` mention or a path would be forged with.
 */
const ALLOWED = /^(?:[\p{L}\p{M}\p{N} ._'\u00b7-]|\p{Extended_Pictographic}|[\ufe0e\ufe0f]|[\u{1f3fb}-\u{1f3ff}]|\u20e3)+$/u;

/**
 * Default-ignorable characters render as nothing (or leave what they follow unchanged): a name spelled with one looks
 * like a name it is not ("Pri"+CGJ+"sm" is not "prism" to a comparison, and reads as it). They are refused everywhere —
 * bidi and zero-width ones included — except an emoji's own presentation selector: VS15/VS16 on a pictograph, or in a
 * keycap (digit, # or * + VS16 + U+20E3). (#1833 review.)
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const VS15 = String.fromCharCode(0xfe0e), VS16 = String.fromCharCode(0xfe0f), KEYCAP = String.fromCharCode(0x20e3);
export function hasStrayInvisible(s: string): boolean {
  const cps = Array.from(s);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (!DEFAULT_IGNORABLE.test(c)) continue;
    const prev = cps[i - 1] ?? "";
    if ((c === VS15 || c === VS16) && (PICTOGRAPH.test(prev) || (/^[0-9#*]$/.test(prev) && cps[i + 1] === KEYCAP))) continue;
    return true;
  }
  return false;
}
/** A name's UTF-16 length: well under what web-prefs.json keeps (256), so every accepted name loads back. */
export const WEB_NAME_MAX_UNITS = 128;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export function graphemeCount(s: string): number {
  if (segmenter) { let n = 0; for (const _ of segmenter.segment(s)) n++; return n; }
  return Array.from(s).length;
}

/**
 * A name as a person typed it: NFC, trimmed, inner whitespace one space; then checked. `reserved` says whether a name
 * (compared case-insensitively) belongs to something else here — an instance, its display name, a bot.
 */
export function validateWebName(raw: unknown, reserved: (lowered: string) => boolean = () => false): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "name: text" };
  if (CONTROL.test(raw)) return { ok: false, error: "name: one line, without control characters" };
  if (INVISIBLE.test(raw) || hasStrayInvisible(raw)) return { ok: false, error: "name: no invisible or text-direction characters" };
  const name = raw.normalize("NFC").trim().replace(/\s+/gu, " ");
  const n = graphemeCount(name);
  if (n < 1) return { ok: false, error: "name: at least one character" };
  if (n > WEB_NAME_MAX_GRAPHEMES) return { ok: false, error: `name: at most ${WEB_NAME_MAX_GRAPHEMES} characters (${n} given)` };
  if (name.length > WEB_NAME_MAX_UNITS) return { ok: false, error: "name: too long (too many accents or joined marks)" };
  if (!ALLOWED.test(name)) return { ok: false, error: "name: letters, digits, spaces, emoji and . - _ ' · only" };
  const lowered = name.toLocaleLowerCase("en-US");
  if (/(^|[\s._'\u00b7-])via($|[\s._'\u00b7-])/u.test(lowered)) return { ok: false, error: "name: the word \"via\" is reserved (it would read as a platform)" };
  if (lowered === WEB_NAME_FALLBACK || lowered === "general" || lowered.startsWith("agend")) {
    return { ok: false, error: "name: reserved by AgEnD" };
  }
  if (reserved(lowered)) return { ok: false, error: "name: already the name of an agent or bot here" };
  return { ok: true, name };
}

/** The name to show for a stored one: itself if it still passes, else the fallback. */
export function webNameInUse(stored: unknown, reserved: (lowered: string) => boolean = () => false): string {
  if (typeof stored !== "string") return WEB_NAME_FALLBACK;
  const v = validateWebName(stored, reserved);
  return v.ok && v.name === stored ? v.name : WEB_NAME_FALLBACK;
}

/**
 * An account's display name as a web name: what the rules refuse is dropped (a grapheme at a time), whitespace is
 * collapsed, and it is cut to the maximum. What is left must then pass in full (no "via", nothing reserved); if it does
 * not, or nothing is left, it is the fallback.
 */
export function safeWebName(raw: unknown, reserved: (lowered: string) => boolean = () => false): string {
  if (typeof raw !== "string") return WEB_NAME_FALLBACK;
  let kept = "";
  const pieces = segmenter ? Array.from(segmenter.segment(raw.normalize("NFC")), (p) => p.segment) : Array.from(raw.normalize("NFC"));
  let n = 0;
  for (const g of pieces) {
    if (n >= WEB_NAME_MAX_GRAPHEMES) break;
    if (/\s/u.test(g)) { if (kept && !kept.endsWith(" ")) { kept += " "; n++; } continue; }
    if (CONTROL.test(g) || INVISIBLE.test(g) || hasStrayInvisible(g) || !ALLOWED.test(g)) continue;
    kept += g; n++;
  }
  const v = validateWebName(kept, reserved);
  return v.ok ? v.name : WEB_NAME_FALLBACK;
}
