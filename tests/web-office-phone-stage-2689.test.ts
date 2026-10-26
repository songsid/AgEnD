/**
 * #2689: on a phone, Fleet → Org chart → Office zoomed in could not reach the bottom of the scene. The phone's stage had
 * `min-height: max(300px, calc(100dvh - 300px))`, a guess at the bars above it; with the Office bar wrapped (five rows at
 * 375 px) the stage ran ~150 px under the tab bar, the panel body scrolled, and the stage's touches (its own: pan and
 * pinch) could not scroll it. The stage now takes the panel's height left under the bars, with a fixed floor low enough
 * for a 375 × 667 phone (215 px left there).
 *
 * The layout itself is measured in a real browser by scripts/manual/smoke/smoke-2689-office-phone.mts (375 × 667, the
 * bar wrapped, zoomed 2× and panned to the limit: the scene's bottom on screen; a short screen; desktop; fullscreen).
 * The DOM here has no layout engine, so this pins the stylesheet the smoke measured.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
/** The body of the `@media` block that starts at `at` (balanced braces). */
function block(at: number): string {
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced");
}
const phoneBlocks = [...css.matchAll(/@media \(max-width: 640px\) \{/g)].map((m) => block(m.index!));
const officePhone = phoneBlocks.find((b) => b.includes(".oo-mini { display: none; }"))!;
/** Every rule whose selector list is exactly `sel` (top level or inside a block), its declarations. */
const rules = (src: string, sel: string) => [...src.matchAll(new RegExp(`(?:^|[\\n;}]) *${sel.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")} \\{([^}]*)\\}`, "g"))].map((m) => m[1]);

describe("#2689 the Office stage on a phone", () => {
  it("takes the height left in the panel: a fixed floor (no guess at the bars from the window's height), low enough for 375 × 667", () => {
    expect(officePhone).toBeTruthy();
    const stage = rules(officePhone, ".oo-stage");
    expect(stage).toHaveLength(1);
    expect(stage[0]).not.toMatch(/dvh|vh|calc|max\(/);
    const floor = Number(stage[0].match(/min-height: (\d+)px/)![1]);
    expect(floor).toBeGreaterThanOrEqual(160);                         // still a usable stage on a short screen
    expect(floor).toBeLessThanOrEqual(215);                            // 375 × 667, the Office bar on five rows: 215 px left
  });
  it("no rule sizes the stage from the window: the containers above it grow into the panel and it fills what they leave", () => {
    for (const d of rules(css, ".oo-stage")) expect(d).not.toMatch(/(?:^|[^-])(?:min-)?height: [^;]*(?:dvh|vh)/);
    // The column, .oc-office and .oo grow (flex-grow 1) and set no height of their own; the stage grows in .oo.
    const grow = (d: string) => /flex: 1 [01] auto/.test(d) && !/(?:^|[^-])(?:min-|max-)?height:/.test(d);
    expect(grow(rules(css, ".p-fleet .panel-body > .col:has(> .oc-office)")[0])).toBe(true);
    expect(grow(rules(css, ".oc-office")[0])).toBe(true);
    expect(grow(rules(css, ".oo")[0])).toBe(true);
    expect(rules(css, ".oo-stage")[0]).toContain("flex: 1 1 auto");
    expect(rules(css, ".p-fleet .panel-body:has(> .col > .oc-office)")[0]).toContain("flex-direction: column");
    for (const b of phoneBlocks) for (const sel of [".oc-office", ".oo", ".p-fleet .panel-body > .col:has(> .oc-office)"]) expect(rules(b, sel)).toEqual([]);
  });
  it("its zoom controls fit that stage: a row along its top on a phone (a column is ~240 px), the column kept in fullscreen", () => {
    expect(rules(officePhone, ".oo:not(.fs) .oo-zoom")).toEqual([" flex-direction: row; "]);
    expect(rules(officePhone, ".oo:not(.fs) .oo-zoom .icon-btn + .icon-btn")[0]).toMatch(/border-top: 0;.*border-left: 1px/);
    // Nothing turns the controls on the fullscreen stage: no phone rule names .oo-zoom without :not(.fs).
    expect(officePhone.match(/^[^{}]*\.oo-zoom[^{}]*\{/gm)!.filter((sel) => !sel.includes(":not(.fs)")).map((s) => s.trim())).toEqual([".oo-zoom .icon-btn {"]);
    expect(rules(css, ".oc-zoom")[0]).toContain("flex-direction: column");       // desktop and fullscreen: the column
  });
  it("the stage's touches stay its own (pan and pinch): touch-action pan-y broke both in a real browser", () => {
    for (const sel of [".oo-stage", ".oo-canvas"]) expect(rules(css, sel)[0]).toContain("touch-action: none");
    expect(css).not.toMatch(/\.oo-(?:stage|canvas)[^{]*\{[^}]*touch-action: pan-y/);
  });
});
