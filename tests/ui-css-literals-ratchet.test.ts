/**
 * docs/design/ui-style-guide.md rule 4, as a ratchet (leader, cid-ui-style-guide): colours and font sizes in the web UI's
 * stylesheets come from tokens.css. The literals that exist today are listed in ui-css-literals-allowlist.json, counted
 * per file and declaration; a NEW literal colour (#hex, rgb(), rgba(), hsl(), hsla()) or font-size in px fails here. The
 * list only shrinks: removing a literal also fails until its count is lowered, so the next change can't quietly spend it.
 *
 *   After replacing literals with tokens, regenerate the list:
 *   UPDATE_CSS_LITERALS=1 npx vitest run tests/ui-css-literals-ratchet.test.ts
 *
 * tokens.css (where the literals are defined) and vendor/ (third-party CSS) are not scanned.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const UI = join(ROOT, "src", "ui");
const LIST = join(import.meta.dirname, "ui-css-literals-allowlist.json");

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const PX = /\d(?:\.\d+)?px\b/;

/** Every declaration in the innermost blocks of a stylesheet, comments removed: [property, value]. */
export function declarations(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    for (const decl of block[1]!.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase(), value = decl.slice(i + 1).trim().replace(/\s+/g, " ");
      if (prop && value) out.push([prop, value]);
    }
  }
  return out;
}

/** The literal colours and px font sizes of one stylesheet, counted by `<kind> <property>: <value>`. */
export function literals(css: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [prop, value] of declarations(css)) {
    const keys: string[] = [];
    if (COLOUR.test(value)) keys.push(`colour ${prop}: ${value}`);
    if ((prop === "font-size" || prop === "font") && PX.test(value)) keys.push(`font-px ${prop}: ${value}`);
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

describe("stylesheet literals ratchet (style guide rule 4)", () => {
  if (process.env.UPDATE_CSS_LITERALS === "1") writeFileSync(LIST, JSON.stringify(scan(), null, 2) + "\n");
  const allowed: Record<string, Record<string, number>> = JSON.parse(readFileSync(LIST, "utf8"));
  const now = scan();

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
  it("the scanner itself: colours in any notation and px font sizes count; tokens, comments and other px don't", () => {
    const css = `/* #fff in a comment */ .a { color: #fff; background: rgba(0, 0, 0, .5); border: 1px solid var(--border); }
      @media (max-width: 899px) { .b { font-size: 13px; color: var(--text, #222); } }
      .c { font: 600 12px/1.4 var(--font-ui); padding: 4px; } .d { color: hsl(10 20% 30%); font-size: var(--fs-sm); }`;
    expect(literals(css)).toEqual({
      "colour color: #fff": 1, "colour background: rgba(0, 0, 0, .5)": 1, "font-px font-size: 13px": 1,
      "colour color: var(--text, #222)": 1, "font-px font: 600 12px/1.4 var(--font-ui)": 1, "colour color: hsl(10 20% 30%)": 1 });
  });
});
