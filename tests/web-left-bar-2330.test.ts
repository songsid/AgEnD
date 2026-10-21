/**
 * #2330: a coloured left edge on a rounded box is a straight bar (`.lbar`, drawn like the instance bar `.idc.id-bar`),
 * never a `border-left`: a 3px border curves into the box's rounded corners, which the user found ugly. This keeps it
 * from coming back anywhere in the web UI's own sheets: a rule giving an element a wide border-left (or its colour)
 * while any rule that applies to the same element rounds its corners fails.
 *
 * "Applies to the same element" is judged on the selector's last compound: a rounding rule whose last compound's tag
 * and classes are all in the accent rule's last compound (`.p-log .log-item` rounds what `.p-log .log-item.k-error`
 * borders). Connectors and dividers on square boxes (the markdown blockquote, the status line, the org-team tree line,
 * 1px panel dividers) are not accents and pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Rule = { selector: string; body: string };

/** Innermost `selector { declarations }` blocks of a sheet, comments dropped, at-rule wrappers flattened. */
export function rulesOf(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") {
      stack.push(src.slice(start, i).trim().split(/[;}]/).pop()!.trim());
      start = i + 1;
    } else if (src[i] === "}") {
      const selector = stack.pop() ?? "";
      const body = src.slice(start, i);
      if (!selector.startsWith("@") && !body.includes("{")) rules.push({ selector, body });
      start = i + 1;
    }
  }
  return rules;
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1]!.trim() : null;
};

/** Split at `sep` outside parentheses (a selector list, a compound chain). */
function splitTop(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0 && sep.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const selectorsOf = (list: string) => splitTop(list, /,/);

/**
 * Tag and classes of a selector's last compound, or null for a pseudo-element (another box). `:is()` / `:where()`
 * with one selector count as that selector's last compound; other pseudo-classes (`:not()`, `:hover`) add nothing.
 */
function subject(selector: string): { tag: string; classes: string[] } | null {
  const last = splitTop(selector.replace(/\s*([>+~])\s*/g, " "), /\s/).pop() ?? "";
  if (/::|:(before|after)\b/.test(last)) return null;
  const classes: string[] = [];
  const bare = last.replace(/:(is|where)\(([^()]*)\)/g, (_, _k, inner: string) => {
    const one = selectorsOf(inner);
    if (one.length === 1) classes.push(...(subject(one[0]!)?.classes ?? []));
    return "";
  }).replace(/:[a-z-]+(\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "");
  return { tag: /^[a-z][a-z0-9-]*/i.exec(bare)?.[0] ?? "", classes: [...classes, ...(bare.match(/\.[\w-]+/g) ?? [])] };
}

const NO_COLOUR = /^(transparent|none|0|initial|inherit|unset)$/;
/** A border width that draws a divider at most: 0, 1px, thin. Anything else (rem, em, medium, thick, var()) is wide. */
const THIN = /^(0|0?\.\d+px|1px|1\.0+px|thin|0[a-z%]*)$/;
const widthToken = (t: string) => /^(\d|\.\d|thin$|medium$|thick$|var\(|calc\(|min\(|max\(|clamp\()/.test(t);
/** The left value of a 1–4 value box shorthand (top right bottom left). */
const leftOf = (values: string[]) => values[values.length === 4 ? 3 : values.length === 1 ? 0 : 1];
/**
 * The coloured left edge a rule gives, or null: a border-left (or border-inline-start) wider than a divider, a
 * border-left colour, or a border-width whose left value is wider than its top.
 */
function leftAccent(body: string): string | null {
  const border = decl(body, "border-left") ?? decl(body, "border-inline-start");
  if (border && !/\b(transparent|none|hidden)\b/.test(border)) {
    const width = splitTop(border, /\s/).find(widthToken);
    // No width given is `medium` (3px).
    if (!width || !THIN.test(width)) return border;
  }
  const colour = decl(body, "border-left-color") ?? decl(body, "border-inline-start-color");
  if (colour && !NO_COLOUR.test(colour)) return colour;
  const widths = decl(body, "border-width");
  if (widths) {
    const values = splitTop(widths, /\s/);
    const left = leftOf(values)!, top = values[0]!;
    if (left !== top && !THIN.test(left) && !/\btransparent\b/.test(decl(body, "border-color") ?? decl(body, "border") ?? "")) return `border-width: ${widths}`;
  }
  return null;
}
const zero = (v: string | undefined) => !v || /^0([a-z%]+)?$/.test(v);
/** Whether a rule rounds a left corner: border-radius (top-left / bottom-left values) or a left corner longhand. */
const rounds = (body: string) => {
  for (const prop of ["border-top-left-radius", "border-bottom-left-radius", "border-start-start-radius", "border-end-start-radius"]) {
    const v = decl(body, prop);
    if (v && !zero(splitTop(v, /\s/)[0])) return true;
  }
  const r = decl(body, "border-radius");
  if (!r) return false;
  // Horizontal radii only (before any "/"): top-left is the first value, bottom-left the last of four (else the second).
  const v = splitTop(r.split("/")[0]!, /\s/);
  return !zero(v[0]) || !zero(leftOf(v));
};

type Subject = { tag: string; classes: string[] };
/** Whether one compound's tag and classes are all in the other's (and it names something). */
const within = (a: Subject, b: Subject) => (!!a.tag || a.classes.length > 0)
  && (!a.tag || a.tag === b.tag) && a.classes.every((c) => b.classes.includes(c));

/**
 * Accent rules whose element some rule rounds: "<accent selector> ← rounded by <rounding selector>". Either compound
 * may be the narrower one: `.a` rounded + `.a.bad` bordered, or `.a` bordered + `.a.big` rounded (`.a.big` gets both).
 */
export function roundedAccents(css: string): string[] {
  const rules = rulesOf(css);
  const rounders = rules.filter((r) => rounds(r.body)).flatMap((r) => selectorsOf(r.selector).map((s) => ({ s, sub: subject(s) })));
  const out: string[] = [];
  for (const r of rules) {
    if (!leftAccent(r.body)) continue;
    for (const s of selectorsOf(r.selector)) {
      const sub = subject(s);
      if (!sub) continue;
      const by = rounders.find((x) => x.sub && (within(x.sub, sub) || within(sub, x.sub)));
      if (by) out.push(`${s} ← rounded by ${by.s}`);
    }
  }
  return out;
}

const UI = join(process.cwd(), "src", "ui");
const sheets = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "vendor" ? [] : sheets(join(dir, e.name))) : e.name.endsWith(".css") ? [join(dir, e.name)] : []);

describe("rounded boxes get a straight left bar, never a coloured border-left (#2330)", () => {
  it("no sheet in src/ui gives a rounded box a coloured border-left", () => {
    const found = sheets(UI).flatMap((f) => roundedAccents(readFileSync(f, "utf8")).map((x) => `${f.slice(UI.length + 1)}: ${x}`));
    expect(found).toEqual([]);
  });

  it("the eight places of the issue draw the shared bar", () => {
    const css = readFileSync(join(UI, "shared", "app.css"), "utf8");
    const bar = rulesOf(css).find((r) => selectorsOf(r.selector).includes(".lbar::before"));
    expect(bar, ".lbar::before").toBeDefined();
    // Straight, inset like .idc.id-bar::before: absolute, 3px wide, short of both ends, no rounding of its own.
    for (const [prop, value] of [["position", "absolute"], ["left", "var(--lbar-left, 0)"], ["width", "3px"], ["top", "var(--lbar-inset, var(--s-2))"],
      ["bottom", "var(--lbar-inset, var(--s-2))"], ["background", "var(--lbar-color, var(--accent))"]]) expect(decl(bar!.body, prop), prop).toBe(value);
    expect(decl(bar!.body, "border-radius")).toBeNull();
    const selectors = selectorsOf(bar!.selector);
    for (const place of [".reply-bar", ".msg-quote", ".p-log .log-item.k-error", ".p-log .log-item.s-failed", ".org-node", ".us-basis",
      ".us-partial", ".cmd-card.bad", ".tb-tile"]) expect(selectors, place).toContain(`${place}::before`);
    // Its box is the bar's containing block.
    const host = rulesOf(css).find((r) => selectorsOf(r.selector).includes(".lbar") && decl(r.body, "position") === "relative");
    expect(host && selectorsOf(host.selector)).toEqual(selectors.map((s) => s.replace(/::before$/, "")));
  });

  describe("the check itself", () => {
    it("catches the shapes the issue lists", () => {
      expect(roundedAccents(".a { border-radius: 8px; border-left: 3px solid var(--accent); }")).toEqual([".a ← rounded by .a"]);
      expect(roundedAccents(".p .item { border-radius: 8px; }\n.p .item.k-error { border-left: 3px solid red; }"))
        .toEqual([".p .item.k-error ← rounded by .p .item"]);
      expect(roundedAccents(".n { border-radius: 8px; border-left: 3px solid transparent; }\n.n.st-x { border-left-color: var(--ok); }"))
        .toEqual([".n.st-x ← rounded by .n"]);
      expect(roundedAccents("@media (max-width: 700px) { .a { border-radius: 4px; } }\n.a.bad { border-inline-start: 3px solid red; }"))
        .toEqual([".a.bad ← rounded by .a"]);
    });
    // Fable's #2332 review: shapes the first matcher missed.
    it.each([
      ["a rem width", ".a { border-radius: 8px; border-left: 0.2rem solid red; }"],
      ["an em width", ".a { border-radius: 8px; border-left: .25em solid red; }"],
      ["a keyword width", ".a { border-radius: 8px; border-left: thick solid red; }"],
      ["no width (medium)", ".a { border-radius: 8px; border-left: solid red; }"],
      ["a var() width", ".a { border-radius: 8px; border-left: var(--bar) solid red; }"],
      ["the border-width shorthand", ".a { border-radius: 8px; border-width: 0 0 0 3px; border-style: solid; border-color: red; }"],
      ["a left corner longhand", ".a { border-top-left-radius: 8px; border-left: 3px solid red; }"],
      ["the bottom-left corner of four", ".a { border-radius: 0 0 0 8px; border-left: 3px solid red; }"],
      ["rounding on a narrower compound", ".a { border-left: 3px solid red; }\n.a.big { border-radius: 8px; }"],
      ["an accent inside :is()", ".a { border-radius: 8px; }\n:is(.a) { border-left: 3px solid red; }"],
      ["a rounder inside :where()", ":where(.a) { border-radius: 8px; }\n.a.bad { border-left-color: red; }"],
    ])("catches %s", (_, css) => expect(roundedAccents(css)).toHaveLength(1));
    it("passes square boxes, thin dividers, uniform borders and other boxes", () => {
      expect(roundedAccents(".msg .md blockquote { border-left: 3px solid var(--border-strong); }")).toEqual([]);
      expect(roundedAccents(".rail { border-left: 1px solid var(--border); border-radius: 8px; }")).toEqual([]);
      expect(roundedAccents(".t { border: 1px solid var(--border); border-radius: 8px; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 8px; }\n.b { border-left: 3px solid red; }")).toEqual([]);
      expect(roundedAccents(".a::before { border-radius: 2px; }\n.a { border-left: 3px solid red; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 0; border-left: 3px solid red; }")).toEqual([]);
      // Square on the left is the other honest fix; a divider-width border is not an accent.
      expect(roundedAccents(".a { border-radius: 0 8px 8px 0; border-left: 3px solid red; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 0 0 0 0; border-left: 3px solid red; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 8px; border-left: thin solid red; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 8px; border-width: 1px; border-color: red; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 8px; border-width: 0 0 0 3px; border-color: transparent; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 8px; }\n:not(.a) { border-left: 3px solid red; }")).toEqual([]);
    });
  });
});
