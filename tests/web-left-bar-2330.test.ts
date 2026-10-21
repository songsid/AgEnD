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

/** Tag and classes of a selector's last compound, or null for a pseudo-element (another box). */
function subject(selector: string): { tag: string; classes: string[] } | null {
  const last = selector.trim().split(/\s*[>+~]\s*|\s+/).pop()!;
  if (/::|:(before|after)\b/.test(last)) return null;
  const bare = last.replace(/:[a-z-]+(\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "");
  return { tag: /^[a-z][a-z0-9-]*/i.exec(bare)?.[0] ?? "", classes: bare.match(/\.[\w-]+/g) ?? [] };
}

const NO_COLOUR = /^(transparent|none|0|initial|inherit|unset)$/;
/** The coloured left edge a rule gives, or null: a border-left 2px or wider, or a border-left colour. */
function leftAccent(body: string): string | null {
  const border = decl(body, "border-left") ?? decl(body, "border-inline-start");
  if (border) {
    const width = /(\d+(?:\.\d+)?)px/.exec(border);
    if (width && Number(width[1]) >= 2 && !/\btransparent\b/.test(border)) return border;
  }
  const colour = decl(body, "border-left-color") ?? decl(body, "border-inline-start-color");
  return colour && !NO_COLOUR.test(colour) ? colour : null;
}
const rounds = (body: string) => {
  const r = decl(body, "border-radius");
  return !!r && !/^0(px)?$/.test(r);
};

/** Accent rules whose element some rule rounds: "<accent selector> ← rounded by <rounding selector>". */
export function roundedAccents(css: string): string[] {
  const rules = rulesOf(css);
  const rounders = rules.filter((r) => rounds(r.body)).flatMap((r) => r.selector.split(",").map((s) => ({ s: s.trim(), sub: subject(s) })));
  const out: string[] = [];
  for (const r of rules) {
    if (!leftAccent(r.body)) continue;
    for (const s of r.selector.split(",").map((x) => x.trim())) {
      const sub = subject(s);
      if (!sub) continue;
      const by = rounders.find((x) => x.sub && (x.sub.tag || x.sub.classes.length)
        && (!x.sub.tag || x.sub.tag === sub.tag) && x.sub.classes.every((c) => sub.classes.includes(c)));
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
    const bar = rulesOf(css).find((r) => r.selector.split(",").map((s) => s.trim()).includes(".lbar::before"));
    expect(bar, ".lbar::before").toBeDefined();
    // Straight, inset like .idc.id-bar::before: absolute, 3px wide, short of both ends, no rounding of its own.
    for (const [prop, value] of [["position", "absolute"], ["left", "var(--lbar-left, 0)"], ["width", "3px"], ["top", "var(--lbar-inset, var(--s-2))"],
      ["bottom", "var(--lbar-inset, var(--s-2))"], ["background", "var(--lbar-color, var(--accent))"]]) expect(decl(bar!.body, prop), prop).toBe(value);
    expect(decl(bar!.body, "border-radius")).toBeNull();
    const selectors = bar!.selector.split(",").map((s) => s.trim());
    for (const place of [".reply-bar", ".msg-quote", ".p-log .log-item.k-error", ".p-log .log-item.s-failed", ".org-node", ".us-basis",
      ".us-partial", ".cmd-card.bad", ".tb-tile"]) expect(selectors, place).toContain(`${place}::before`);
    // Its box is the bar's containing block.
    const host = rulesOf(css).find((r) => r.selector.split(",").map((s) => s.trim()).includes(".lbar") && decl(r.body, "position") === "relative");
    expect(host?.selector.split(",").map((s) => s.trim())).toEqual(selectors.map((s) => s.replace(/::before$/, "")));
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
    it("passes square boxes, thin dividers, uniform borders and other boxes", () => {
      expect(roundedAccents(".msg .md blockquote { border-left: 3px solid var(--border-strong); }")).toEqual([]);
      expect(roundedAccents(".rail { border-left: 1px solid var(--border); border-radius: 8px; }")).toEqual([]);
      expect(roundedAccents(".t { border: 1px solid var(--border); border-radius: 8px; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 8px; }\n.b { border-left: 3px solid red; }")).toEqual([]);
      expect(roundedAccents(".a::before { border-radius: 2px; }\n.a { border-left: 3px solid red; }")).toEqual([]);
      expect(roundedAccents(".a { border-radius: 0; border-left: 3px solid red; }")).toEqual([]);
    });
  });
});
