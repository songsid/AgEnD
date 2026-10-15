/**
 * #1629 r4 §3: owner CSS — one raw CSS text per human, for that human's own screens. This module is its gate:
 * a CSS Syntax Level 3 tokenizer (no dependency), the rules a stored text must pass, and the serialiser the route
 * serves from. The server re-serialises from tokens, so the bytes served are never the bytes uploaded; the CSP
 * (`style-src 'self'`, `img-src 'self' data: blob:`, `font-src 'self' data:`) is the first wall, this the second
 * and the one that says why at save time.
 *
 * Refused: `@import` / `@namespace` / `@charset`; any `url(…)` or `src(…)` except `url("asset:<id>")` (or the
 * unquoted `url(asset:<id>)`) naming an asset stored with this CSS; `image-set`, `-webkit-image-set`, `cross-fade`,
 * `element`, `-moz-element`, `paint`, `expression`; the properties `behavior` and `-moz-binding`; `javascript:` and
 * `vbscript:` anywhere. Escapes are decoded before any check (`\75 rl(` is `url(`).
 */

export const OWNER_CSS_MAX_BYTES = 64 * 1024;
export const OWNER_CSS_ASSET_ID = /^[0-9a-f]{32}$/;
/** What an `asset:` reference becomes when served. */
export const ownerCssAssetUrl = (id: string) => `/ui/owner-css/asset/${id}`;

export type CssTokenType =
  | "ident" | "function" | "at" | "hash" | "string" | "bad-string" | "url" | "bad-url" | "delim"
  | "number" | "percentage" | "dimension" | "ws" | "cdo" | "cdc" | ":" | ";" | "," | "[" | "]" | "(" | ")" | "{" | "}";

export interface CssToken {
  type: CssTokenType;
  /** Decoded: an ident/function/at/hash name, a string's or url's contents, a delim's character, a number's text. */
  value: string;
  /** dimension: its unit, decoded. */
  unit?: string;
  /** hash: "id" when its name would start an identifier (Syntax §4.3.1) — what makes it an ID selector. */
  hashType?: "id" | "unrestricted";
  /** ws: whether it held a newline (kept so the served text keeps its lines). */
  newline?: boolean;
}

const isNameStart = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c >= 0x80;
const isName = (c: number) => isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a;
const isNonPrintable = (c: number) => (c >= 0 && c <= 8) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;

/** The CSS Syntax §3.3 preprocessing: CRLF/CR/FF → LF, NUL and surrogates → U+FFFD. Code points, not UTF-16 units. */
function preprocess(text: string): number[] {
  const out: number[] = [];
  const s = text.replace(/\r\n|\r|\f/g, "\n");
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out.push(c === 0 || (c >= 0xd800 && c <= 0xdfff) ? 0xfffd : c);
  }
  return out;
}

/** CSS Syntax Level 3 §4 tokenizer. Comments are consumed (they are not tokens). */
export function tokenizeCss(text: string): CssToken[] {
  const cp = preprocess(text);
  const n = cp.length;
  let i = 0;
  const at = (k: number) => (k < n ? cp[k]! : -1);
  const tokens: CssToken[] = [];

  const validEscape = (a: number, b: number) => a === 0x5c && b !== 0x0a && b !== -1;
  const startsIdent = (a: number, b: number, c: number) =>
    a === 0x2d ? isNameStart(b) || b === 0x2d || validEscape(b, c) : isNameStart(a) ? true : a === 0x5c ? validEscape(a, b) : false;
  const startsNumber = (a: number, b: number, c: number) =>
    a === 0x2b || a === 0x2d ? isDigit(b) || (b === 0x2e && isDigit(c)) : a === 0x2e ? isDigit(b) : isDigit(a);

  /** After a backslash (already consumed). */
  const consumeEscape = (): number => {
    if (i >= n) return 0xfffd;
    const c = cp[i++]!;
    if (isHex(c)) {
      let hex = String.fromCodePoint(c);
      while (hex.length < 6 && i < n && isHex(cp[i]!)) hex += String.fromCodePoint(cp[i++]!);
      if (i < n && isWs(cp[i]!)) i++;
      const v = parseInt(hex, 16);
      return v === 0 || (v >= 0xd800 && v <= 0xdfff) || v > 0x10ffff ? 0xfffd : v;
    }
    return c;
  };
  const consumeName = (): string => {
    let s = "";
    for (;;) {
      const c = at(i);
      if (c !== -1 && isName(c)) { s += String.fromCodePoint(c); i++; }
      else if (validEscape(c, at(i + 1))) { i++; s += String.fromCodePoint(consumeEscape()); }
      else return s;
    }
  };
  const consumeNumber = (): string => {
    let s = "";
    if (at(i) === 0x2b || at(i) === 0x2d) s += String.fromCodePoint(cp[i++]!);
    while (isDigit(at(i))) s += String.fromCodePoint(cp[i++]!);
    if (at(i) === 0x2e && isDigit(at(i + 1))) { s += "."; i++; while (isDigit(at(i))) s += String.fromCodePoint(cp[i++]!); }
    const e = at(i);
    if ((e === 0x45 || e === 0x65) && (isDigit(at(i + 1)) || ((at(i + 1) === 0x2b || at(i + 1) === 0x2d) && isDigit(at(i + 2))))) {
      s += String.fromCodePoint(cp[i++]!);
      if (at(i) === 0x2b || at(i) === 0x2d) s += String.fromCodePoint(cp[i++]!);
      while (isDigit(at(i))) s += String.fromCodePoint(cp[i++]!);
    }
    return s;
  };
  const consumeNumeric = (): CssToken => {
    const value = consumeNumber();
    if (startsIdent(at(i), at(i + 1), at(i + 2))) return { type: "dimension", value, unit: consumeName() };
    if (at(i) === 0x25) { i++; return { type: "percentage", value }; }
    return { type: "number", value };
  };
  const consumeString = (quote: number): CssToken => {
    let s = "";
    for (;;) {
      const c = at(i);
      if (c === -1) return { type: "string", value: s };
      i++;
      if (c === quote) return { type: "string", value: s };
      if (c === 0x0a) { i--; return { type: "bad-string", value: s }; }
      if (c === 0x5c) {
        if (at(i) === -1) continue;
        if (at(i) === 0x0a) { i++; continue; }
        s += String.fromCodePoint(consumeEscape());
      } else s += String.fromCodePoint(c);
    }
  };
  const consumeBadUrlRemnants = () => {
    for (;;) {
      const c = at(i);
      if (c === -1) return;
      i++;
      if (c === 0x29) return;
      if (validEscape(c, at(i))) consumeEscape();
    }
  };
  const consumeUrl = (): CssToken => {
    let s = "";
    while (isWs(at(i))) i++;
    for (;;) {
      const c = at(i);
      if (c === -1) return { type: "url", value: s };
      i++;
      if (c === 0x29) return { type: "url", value: s };
      if (isWs(c)) {
        while (isWs(at(i))) i++;
        if (at(i) === 0x29) { i++; return { type: "url", value: s }; }
        if (at(i) === -1) return { type: "url", value: s };
        consumeBadUrlRemnants(); return { type: "bad-url", value: s };
      }
      if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) { consumeBadUrlRemnants(); return { type: "bad-url", value: s }; }
      if (c === 0x5c) {
        if (validEscape(c, at(i))) { s += String.fromCodePoint(consumeEscape()); continue; }
        consumeBadUrlRemnants(); return { type: "bad-url", value: s };
      }
      s += String.fromCodePoint(c);
    }
  };
  const consumeIdentLike = (): CssToken => {
    const name = consumeName();
    if (name.toLowerCase() === "url" && at(i) === 0x28) {
      i++;
      while (isWs(at(i)) && isWs(at(i + 1))) i++;
      const a = at(i), b = at(i + 1);
      if (a === 0x22 || a === 0x27 || (isWs(a) && (b === 0x22 || b === 0x27))) return { type: "function", value: name };
      return consumeUrl();
    }
    if (at(i) === 0x28) { i++; return { type: "function", value: name }; }
    return { type: "ident", value: name };
  };

  while (i < n) {
    const c = cp[i]!;
    if (c === 0x2f && at(i + 1) === 0x2a) {                          // a comment: consumed, not a token
      i += 2;
      while (i < n && !(cp[i] === 0x2a && at(i + 1) === 0x2f)) i++;
      i = Math.min(n, i + 2);
      continue;
    }
    if (isWs(c)) {
      let newline = false;
      while (isWs(at(i))) { if (cp[i] === 0x0a) newline = true; i++; }
      // A comment between two runs of whitespace leaves them adjacent: one whitespace token, as the text reads.
      const prev = tokens[tokens.length - 1];
      if (prev?.type === "ws") prev.newline = prev.newline || newline;
      else tokens.push({ type: "ws", value: " ", newline });
      continue;
    }
    if (c === 0x22 || c === 0x27) { i++; tokens.push(consumeString(c)); continue; }
    if (c === 0x23) {
      if (isName(at(i + 1)) || validEscape(at(i + 1), at(i + 2))) {
        const hashType = startsIdent(at(i + 1), at(i + 2), at(i + 3)) ? "id" : "unrestricted";
        i++; tokens.push({ type: "hash", value: consumeName(), hashType }); continue;
      }
      i++; tokens.push({ type: "delim", value: "#" }); continue;
    }
    if (c === 0x28 || c === 0x29 || c === 0x2c || c === 0x3a || c === 0x3b || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i++; tokens.push({ type: String.fromCodePoint(c) as CssTokenType, value: String.fromCodePoint(c) }); continue;
    }
    if (c === 0x2b || c === 0x2e) {
      if (startsNumber(c, at(i + 1), at(i + 2))) { tokens.push(consumeNumeric()); continue; }
      i++; tokens.push({ type: "delim", value: String.fromCodePoint(c) }); continue;
    }
    if (c === 0x2d) {
      if (startsNumber(c, at(i + 1), at(i + 2))) { tokens.push(consumeNumeric()); continue; }
      if (at(i + 1) === 0x2d && at(i + 2) === 0x3e) { i += 3; tokens.push({ type: "cdc", value: "-->" }); continue; }
      if (startsIdent(c, at(i + 1), at(i + 2))) { tokens.push(consumeIdentLike()); continue; }
      i++; tokens.push({ type: "delim", value: "-" }); continue;
    }
    if (c === 0x3c && at(i + 1) === 0x21 && at(i + 2) === 0x2d && at(i + 3) === 0x2d) { i += 4; tokens.push({ type: "cdo", value: "<!--" }); continue; }
    if (c === 0x40) {
      if (startsIdent(at(i + 1), at(i + 2), at(i + 3))) { i++; tokens.push({ type: "at", value: consumeName() }); continue; }
      i++; tokens.push({ type: "delim", value: "@" }); continue;
    }
    if (c === 0x5c) {
      if (validEscape(c, at(i + 1))) { tokens.push(consumeIdentLike()); continue; }
      i++; tokens.push({ type: "delim", value: "\\" }); continue;
    }
    if (isDigit(c)) { tokens.push(consumeNumeric()); continue; }
    if (isNameStart(c)) { tokens.push(consumeIdentLike()); continue; }
    i++; tokens.push({ type: "delim", value: String.fromCodePoint(c) });
  }
  return tokens;
}

const BANNED_AT = new Set(["import", "namespace", "charset"]);
const BANNED_FUNCTIONS = new Set(["src", "image-set", "-webkit-image-set", "cross-fade", "-webkit-cross-fade", "element", "-moz-element", "paint", "expression"]);
const BANNED_IDENTS = new Set(["behavior", "-moz-binding"]);
const SCHEMES = /(?:java|vb)script:/i;

export interface OwnerCssProblem { problem: string; detail?: string }

const assetIdOf = (ref: string): string | null => {
  const m = /^asset:([0-9a-f]{32})$/.exec(ref);
  return m ? m[1]! : null;
};

/**
 * The checks (§3). `assets`: the ids stored with this CSS. Returns the tokens to serve from, or the first problem.
 * Run before storing and again before serving.
 */
export function checkOwnerCss(text: string, assets: ReadonlySet<string>): { ok: true; tokens: CssToken[] } | { ok: false; error: OwnerCssProblem } {
  if (typeof text !== "string") return { ok: false, error: { problem: "not_text" } };
  if (Buffer.byteLength(text, "utf8") > OWNER_CSS_MAX_BYTES) return { ok: false, error: { problem: "too_large", detail: `at most ${OWNER_CSS_MAX_BYTES} bytes` } };
  if (text.includes("\u0000")) return { ok: false, error: { problem: "nul" } };
  if (SCHEMES.test(text)) return { ok: false, error: { problem: "script_scheme" } };
  const tokens = tokenizeCss(text);
  const assetRef = (ref: string): OwnerCssProblem | null => {
    const id = assetIdOf(ref);
    if (!id) return { problem: "url", detail: "only url(\"asset:<id>\") of an asset stored with this CSS" };
    return assets.has(id) ? null : { problem: "unknown_asset", detail: id };
  };
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    const lower = (tok.value + (tok.unit ?? "")).toLowerCase();
    if (SCHEMES.test(lower)) return { ok: false, error: { problem: "script_scheme" } };
    switch (tok.type) {
      case "bad-string": case "bad-url": return { ok: false, error: { problem: "malformed", detail: tok.type } };
      case "at": if (BANNED_AT.has(lower)) return { ok: false, error: { problem: "at_rule", detail: `@${lower}` } }; break;
      case "ident": if (BANNED_IDENTS.has(lower)) return { ok: false, error: { problem: "property", detail: lower } }; break;
      case "url": { const p = assetRef(tok.value); if (p) return { ok: false, error: p }; break; }
      case "function":
        if (BANNED_FUNCTIONS.has(lower)) return { ok: false, error: { problem: "function", detail: `${lower}(` } };
        if (lower === "url") {
          // url( <ws>* <string> <ws>* ) — exactly one string argument, an asset of this CSS.
          let j = k + 1;
          while (tokens[j]?.type === "ws") j++;
          const arg = tokens[j];
          let close = j + 1;
          while (tokens[close]?.type === "ws") close++;
          if (arg?.type !== "string" || tokens[close]?.type !== ")") return { ok: false, error: { problem: "url", detail: "only url(\"asset:<id>\") of an asset stored with this CSS" } };
          const p = assetRef(arg.value);
          if (p) return { ok: false, error: p };
        }
        break;
      case "delim": if (tok.value === "\\") return { ok: false, error: { problem: "malformed", detail: "stray backslash" } }; break;
      default: break;
    }
  }
  return { ok: true, tokens };
}

/** The asset ids a checked text names (decoded: url("\\61sset:<id>") counts as asset:<id>). */
export function ownerCssAssetRefs(tokens: readonly CssToken[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) if (t.type === "url" || t.type === "string") { const id = assetIdOf(t.value); if (id) out.add(id); }
  return out;
}

// ── Serialising: canonical text the route serves ──

const hex = (c: number) => `\\${c.toString(16)} `;
function escapeIdent(name: string): string {
  if (name === "--") return "-\\-";                                   // "--" then ">" would read back as "-->" (CDC)
  let out = "";
  const cps = [...name].map(ch => ch.codePointAt(0)!);
  cps.forEach((c, k) => {
    if (c === 0) out += "�";
    else if ((c >= 1 && c <= 0x1f) || c === 0x7f) out += hex(c);
    else if (k === 0 && isDigit(c)) out += hex(c);
    else if (k === 1 && isDigit(c) && cps[0] === 0x2d) out += hex(c);
    else if (k === 0 && c === 0x2d && cps.length === 1) out += "\\-";
    else if (c >= 0x80 || c === 0x2d || c === 0x5f || isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) out += String.fromCodePoint(c);
    else out += `\\${String.fromCodePoint(c)}`;
  });
  return out;
}
/** A name sequence (no identifier-start rule): only what is not a name character is escaped. */
function escapeName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c === 0) out += "\ufffd";
    else if ((c >= 1 && c <= 0x1f) || c === 0x7f) out += hex(c);
    else if (isName(c)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}
function escapeString(value: string): string {
  let out = "\"";
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c === 0) out += "�";
    else if ((c >= 1 && c <= 0x1f) || c === 0x7f) out += hex(c);
    else if (c === 0x22 || c === 0x5c) out += `\\${ch}`;
    else if (c === 0x3c) out += hex(c);                                   // "<": never "</style" or "<!--" in served text
    else out += ch;
  }
  return out + "\"";
}
/** An unquoted url token's contents: whitespace, quotes, parentheses, backslash and non-printables escaped. */
function escapeUrl(value: string): string {
  let out = "";
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (isWs(c) || isNonPrintable(c) || c === 0x0d || c === 0x0c || c === 0x3c) out += hex(c);
    else if (c === 0x22 || c === 0x27 || c === 0x28 || c === 0x29 || c === 0x5c) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}
function serializeToken(t: CssToken): string {
  switch (t.type) {
    case "ident": return escapeIdent(t.value);
    case "function": return `${escapeIdent(t.value)}(`;
    case "at": return `@${escapeIdent(t.value)}`;
    // An "id" hash keeps its identifier spelling (#\31 23 stays an ID selector); an unrestricted one is a name
    // sequence, where a leading digit or "-" needs no escape.
    case "hash": return `#${t.hashType === "id" ? escapeIdent(t.value) : escapeName(t.value)}`;
    case "string": return escapeString(t.value);
    case "url": return `url(${escapeUrl(t.value)})`;
    case "number": return t.value;
    case "percentage": return `${t.value}%`;
    case "dimension": {
      // A unit that would read back as an exponent ("1e3" from 1 + "e3") is escaped.
      const unit = escapeIdent(t.unit ?? "");
      return t.value + (/^[eE][+-]?\d/.test(unit) ? `\\${unit[0]!.charCodeAt(0).toString(16)} ${unit.slice(1)}` : unit);
    }
    case "ws": return t.newline ? "\n" : " ";
    case "delim": return t.value === "\\" ? "\\\n" : t.value;
    default: return t.value;
  }
}
/** CSS Syntax §9 (serialization): pairs that would merge into one token if written back to back get a comment between. */
const NAMEISH = new Set<CssTokenType>(["ident", "function", "url", "bad-url", "number", "percentage", "dimension"]);
const isDelim = (t: CssToken | undefined, v: string) => t?.type === "delim" && t.value === v;
function needsComment(a: CssToken, b: CssToken): boolean {
  const bNameOrMinus = NAMEISH.has(b.type) || isDelim(b, "-");
  switch (a.type) {
    case "ident": return bNameOrMinus || b.type === "cdc" || b.type === "(";
    case "at": case "hash": case "dimension": return bNameOrMinus || b.type === "cdc";
    case "number": return NAMEISH.has(b.type) || isDelim(b, "%");
    case "delim":
      if (a.value === "#" || a.value === "-") return bNameOrMinus || (a.value === "-" && b.type === "cdc");
      if (a.value === "@") return b.type === "ident" || b.type === "function" || b.type === "url" || b.type === "bad-url" || isDelim(b, "-");
      if (a.value === "." || a.value === "+") return b.type === "number" || b.type === "percentage" || b.type === "dimension";
      if (a.value === "/") return isDelim(b, "*");
      return false;
    default: return false;
  }
}

/**
 * The served text: re-serialised from the checked tokens, `asset:<id>` rewritten to `/ui/owner-css/asset/<id>`.
 * Throws if the result does not tokenize back to the same tokens (it never should; the route then serves nothing).
 */
export function serializeOwnerCss(tokens: readonly CssToken[]): string {
  return serializeCssTokens(tokens.map(t => {
    if (t.type === "url" || t.type === "string") { const id = assetIdOf(t.value); return id ? { ...t, value: ownerCssAssetUrl(id) } : t; }
    return t;
  }));
}

/**
 * #1629: the generic serialiser (effects reuse it, B2): canonical text for these tokens, exactly as given (no asset
 * rewriting), with a comment between pairs that would merge. Throws if the text does not tokenize back to the same
 * tokens (type, value, unit, hash type; whitespace as whitespace).
 */
export function serializeCssTokens(tokens: readonly CssToken[]): string {
  const out: string[] = [];
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1];
    if (prev && needsComment(prev, t)) out.push("/**/");
    out.push(serializeToken(t));
  });
  const text = out.join("");
  const again = tokenizeCss(text);
  const same = again.length === tokens.length && again.every((t, k) => {
    const o = tokens[k]!;
    return t.type === o.type && (t.type === "ws" || (t.value === o.value && (t.unit ?? "") === (o.unit ?? "") && (t.hashType ?? "") === (o.hashType ?? "")));
  });
  if (!same) throw new Error("CSS did not re-serialise to the same tokens");
  return text;
}
