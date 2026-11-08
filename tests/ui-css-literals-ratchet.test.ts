/**
 * docs/design/ui-style-guide.md rule 4, as a ratchet (leader, cid-ui-style-guide): colours and font sizes in the web UI's
 * stylesheets come from tokens.css. The literals that exist today are listed in ui-css-literals-allowlist.json, counted
 * per file and declaration; a NEW literal colour (#hex, rgb(), rgba(), hsl(), hsla()) or font-size in px fails here. The
 * list only shrinks: removing a literal also fails until its count is lowered, so the next change can't quietly spend it.
 *
 *   After replacing literals with tokens, lower the list (it refuses, writing nothing, if any count would rise):
 *   UPDATE_CSS_LITERALS=1 npx vitest run tests/ui-css-literals-ratchet.test.ts
 *   UPDATE_CSS_LITERALS=reset adopts the current sheets as a new baseline — a branch's first list only, reviewed as such.
 *
 * tokens.css (where the literals are defined) and vendor/ (third-party CSS) are not scanned.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const UI = join(ROOT, "src", "ui");
const LIST = join(import.meta.dirname, "ui-css-literals-allowlist.json");

// CSS function names and units are case-insensitive (RGB(), 15PX) (Prism #3417 P2).
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;
const PX = /\d(?:\.\d+)?px\b/i;
/** A CSS string with its escapes (`"a\"b"`), the same rule the lexer below uses. */
const STRING = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;

/**
 * Every declaration of a stylesheet at any depth, comments removed: [property, value]. A rule's own declarations count
 * even when it also holds nested rules (`.a { color: #123; &:hover { … } }`, Prism #3417 P2): text is split at `;`, `{`
 * and `}` outside quotes; a piece ending at `{` is a selector or at-rule prelude, any other piece inside a block is a
 * declaration.
 */
export function declarations(css: string): Array<[string, string]> {
  // One pass (Prism #3417 r2): a comment is only a comment outside a string, and a backslash inside a string escapes the
  // next character (`"\""`, `'\''`), so neither can hide a later declaration.
  const out: Array<[string, string]> = [];
  let depth = 0, buf = "", quote = "";
  const take = () => {
    const decl = buf; buf = "";
    if (depth === 0) return;
    const i = decl.indexOf(":");
    if (i < 0) return;
    const prop = decl.slice(0, i).trim().toLowerCase(), value = decl.slice(i + 1).trim().replace(/\s+/g, " ");
    if (prop && value) out.push([prop, value]);
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]!;
    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < css.length) buf += css[++i];
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") { const close = css.indexOf("*/", i + 2); i = close < 0 ? css.length : close + 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "{") { buf = ""; depth++; continue; }
    if (ch === "}") { take(); depth = Math.max(0, depth - 1); continue; }
    if (ch === ";") { take(); continue; }
    buf += ch;
  }
  return out;
}

/** The literal colours and px font sizes of one stylesheet, counted by `<kind> <property>: <value>`. */
export function literals(css: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [prop, value] of declarations(css)) {
    const keys: string[] = [], bare = value.replace(STRING, '""');   // text in a string is not a colour
    if (COLOUR.test(bare)) keys.push(`colour ${prop}: ${value}`);
    if ((prop === "font-size" || prop === "font") && PX.test(bare)) keys.push(`font-px ${prop}: ${value}`);
    for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function sheets(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "vendor") sheets(p, out); }
    else if (name.endsWith(".css") && name !== "tokens.css") out.push(p);
  }
  return out;
}

function scan(): Record<string, Record<string, number>> {
  const all: Record<string, Record<string, number>> = {};
  for (const p of sheets(UI)) {
    const found = literals(readFileSync(p, "utf8"));
    if (Object.keys(found).length) all[relative(ROOT, p)] = Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
  }
  return all;
}

type Counts = Record<string, Record<string, number>>;
/** What the list may become: the new counts, unless any count rises (then nothing is written: the list only shrinks). */
export function regenerate(listed: Counts, found: Counts): { write: boolean; increases: string[] } {
  const increases: string[] = [];
  for (const [file, ks] of Object.entries(found)) for (const [k, n] of Object.entries(ks)) {
    const was = listed[file]?.[k] ?? 0;
    if (n > was) increases.push(`${file}: ${k} (${was} → ${n})`);
  }
  return { write: increases.length === 0, increases };
}

describe("stylesheet literals ratchet (style guide rule 4)", () => {
  const listed: Counts = JSON.parse(readFileSync(LIST, "utf8"));
  const now = scan();
  // The updater lowers the list after literals are replaced; it never raises it (Prism #3417 P2): with any increase it
  // writes nothing, and the check below fails on that increase.
  if (process.env.UPDATE_CSS_LITERALS === "1" && regenerate(listed, now).write) writeFileSync(LIST, JSON.stringify(now, null, 2) + "\n");
  // "reset" adopts the current stylesheets as a new baseline: a branch's first list only, reviewed as such.
  if (process.env.UPDATE_CSS_LITERALS === "reset") writeFileSync(LIST, JSON.stringify(now, null, 2) + "\n");
  const allowed: Counts = JSON.parse(readFileSync(LIST, "utf8"));

  it("scans the web UI's stylesheets (tokens.css and vendor/ excluded)", () => {
    const names = sheets(UI).map((p) => relative(ROOT, p));
    expect(names).toContain("src/ui/shared/app.css");
    expect(names.some((n) => n.endsWith("tokens.css") || n.includes("/vendor/"))).toBe(false);
  });
  it("no new literal colour or px font size: use a token from tokens.css", () => {
    const added: string[] = [];
    for (const [file, found] of Object.entries(now)) for (const [k, n] of Object.entries(found)) {
      const was = allowed[file]?.[k] ?? 0;
      if (n > was) added.push(`${file}: ${k} (${n} now, ${was} allowed)`);
    }
    expect(added).toEqual([]);
  });
  it("the list only shrinks: a literal that is gone is taken off it (regenerate with UPDATE_CSS_LITERALS=1)", () => {
    const stale: string[] = [];
    for (const [file, found] of Object.entries(allowed)) for (const [k, n] of Object.entries(found)) {
      const is = now[file]?.[k] ?? 0;
      if (is < n) stale.push(`${file}: ${k} (${is} now, ${n} listed)`);
    }
    expect(stale).toEqual([]);
  });
  it("the updater lowers the list and refuses to raise it", () => {
    const listed: Counts = { "a.css": { "colour color: #fff": 2, "font-px font-size: 13px": 1 } };
    expect(regenerate(listed, { "a.css": { "colour color: #fff": 1 } })).toEqual({ write: true, increases: [] });   // fixed → lower
    expect(regenerate(listed, { "a.css": { "colour color: #fff": 3 } }).write).toBe(false);                          // one more
    expect(regenerate(listed, { "a.css": { "colour color: #fff": 2, "colour color: #123456": 1 } }).increases).toEqual(["a.css: colour color: #123456 (0 → 1)"]);
    expect(regenerate(listed, { "b.css": { "font-px font: 12px x": 1 } }).write).toBe(false);                         // a new file
  });
  it("a rule's own declarations count beside nested rules, and function names and units in any case", () => {
    expect(literals(`.a { color: #123456; &:hover { opacity: .9; } }`)).toEqual({ "colour color: #123456": 1 });
    expect(literals(`.a { &:hover { color: var(--text); } font-size: 15px; }`)).toEqual({ "font-px font-size: 15px": 1 });
    expect(literals(`@media (max-width: 899px) { .a { color: RGB(0 0 0); font-size: 15PX; .b { background: HSL(1 2% 3%); } } }`))
      .toEqual({ "colour color: RGB(0 0 0)": 1, "font-px font-size: 15PX": 1, "colour background: HSL(1 2% 3%)": 1 });
    expect(literals(`.a { color: var(--text); &:hover { color: var(--accent); .b { font-size: var(--fs-sm); } } }`)).toEqual({});
    expect(literals(`.a { content: "{ color: #fff; }"; color: var(--text); }`)).toEqual({});
  });
  it("strings with escaped quotes or comment markers never hide a later declaration (Prism #3417 r2)", () => {
    expect(literals(String.raw`.a { content: "\""; color: #123456; }`)).toEqual({ "colour color: #123456": 1 });
    expect(literals(String.raw`.a { content: '\''; font-size: 15px; }`)).toEqual({ "font-px font-size: 15px": 1 });
    expect(literals(`.a { content: "/*"; color: #123456; --literal-text: "*/"; }`)).toEqual({ "colour color: #123456": 1 });
    expect(literals(String.raw`.a { content: "a\" #fff \"b"; color: var(--text); } /* .b { color: #000; } */`)).toEqual({});
  });
  it("the scanner itself: colours in any notation and px font sizes count; tokens, comments and other px don't", () => {
    const css = `/* #fff in a comment */ .a { color: #fff; background: rgba(0, 0, 0, .5); border: 1px solid var(--border); }
      @media (max-width: 899px) { .b { font-size: 13px; color: var(--text, #222); } }
      .c { font: 600 12px/1.4 var(--font-ui); padding: 4px; } .d { color: hsl(10 20% 30%); font-size: var(--fs-sm); }`;
    expect(literals(css)).toEqual({
      "colour color: #fff": 1, "colour background: rgba(0, 0, 0, .5)": 1, "font-px font-size: 13px": 1,
      "colour color: var(--text, #222)": 1, "font-px font: 600 12px/1.4 var(--font-ui)": 1, "colour color: hsl(10 20% 30%)": 1 });
  });
});
