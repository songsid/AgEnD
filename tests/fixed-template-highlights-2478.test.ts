/**
 * #2478 item 7 (the user: "we have a fixed design: no rounded filled highlights"; the #2330 rule, #2332): a selected,
 * hovered or keyboard-focused row is the straight 3 px bar (#2330's shared `.lbar` bar) and a flat background at most.
 * Never a rounded fill, a curved inset edge (an inset box-shadow on a radiused box) or a rounded focus ring. Pinned for
 * the surfaces added since #2332: search's results, recent searches and context lines, the task board's lines, usage's
 * compact rows and the Office editor's desk chip.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1]!.split(",").map((x) => x.trim()), body: m[2]! }));
const bodyOf = (sel: string) => rules.filter((r) => r.sels.includes(sel)).map((r) => r.body).join(";");
const decl = (sel: string, prop: string) => { const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bodyOf(sel)); return m ? m[1]!.trim() : null; };
const barHosts = rules.find((r) => r.sels.includes(".lbar") && /position:\s*relative/.test(r.body))!.sels;
const bars = rules.find((r) => r.sels.includes(".lbar::before"))!.sels;

describe("#2478: the fixed template — the straight bar and a flat background, nothing rounded", () => {
  const ROWS: Array<[host: string, states: string[]]> = [
    [".search-row", [".search-row.on"]],
    [".search-recent-item", [".search-recent-item:hover", ".search-recent-item:focus-visible"]],
    [".search-ctx-line", [".search-ctx-line.here"]],
    [".tw-line", [".tw-line:hover", ".tw-line:focus-visible"]],
    [".u-crow", [".u-crow:focus-visible"]],
    // #2347: Settings' section nav and its search results.
    [".p-settings .s-nav .seg-item", [".p-settings .s-nav .seg-item.active"]],
    [".s-find-item", [".s-find-item.on"]],
  ];
  it.each(ROWS)("%s: square; its states host and draw the shared bar", (host, states) => {
    expect([null, "0"], `${host} radius: ${decl(host, "border-radius")}`).toContain(decl(host, "border-radius"));
    for (const st of states) {
      expect(barHosts, `${st} hosts the bar`).toContain(st);
      expect(bars, `${st} draws the shared bar`).toContain(`${st}::before`);
      // A flat background at most; no curved inset edge, no rounded ring.
      const shadow = decl(st, "box-shadow");
      expect(shadow === null || /^inset 0 -2px 0 var\(--focus\)$/.test(shadow), `${st} box-shadow: ${shadow}`).toBe(true);
      expect([null, "none"], `${st} has no ring: ${decl(st, "outline")}`).toContain(decl(st, "outline"));
    }
  });
  it("keyboard focus stays visible: the bar plus a straight underline, not a ring", () => {
    for (const st of [".search-recent-item:focus-visible", ".tw-line:focus-visible", ".oo-desk:focus-visible"]) {
      expect([st, decl(st, "outline"), decl(st, "box-shadow")]).toEqual([st, "none", "inset 0 -2px 0 var(--focus)"]);
    }
    // Prism r1: the compact usage rows are inside .u-cgroup (rounded, overflow hidden): the bar alone marks focus, moved
    // clear of the 12 px corners, with no full-width underline whose ends the corner would round.
    expect([decl(".u-crow:focus-visible", "outline"), decl(".u-crow:focus-visible", "box-shadow"), decl(".u-crow:focus-visible", "--lbar-left"), decl(".u-crow:focus-visible", "--lbar-inset")])
      .toEqual(["none", null, "var(--s-1)", "6px"]);
    expect([decl(".u-cgroup", "overflow"), decl(".u-cgroup", "border-radius")]).toEqual(["hidden", "var(--r-md)"]);
  });
  it("#2347: Settings' sections are square at every width (the wide column's 8 px radius too)", () => {
    const wide = css.slice(css.indexOf("@media (min-width: 1100px)"));
    expect(wide).toMatch(/\.p-settings > \.s-nav \.seg-item\s*\{\s*border-radius:\s*0;/);
    // Fable r1: the narrow (phone) rule itself — without it the base `.seg-item` radius (r-full) is the pill again.
    expect(decl(".p-settings .s-nav .seg-item", "border-radius")).toBe("0");
    expect(decl(".p-settings .s-nav .seg-item.active", "background")).toBe("var(--surface-2)");
  });
  it("search's selected row: a flat background, no inset accent edge (it curved into the corners)", () => {
    expect([decl(".search-row.on", "background"), decl(".search-row.on", "box-shadow"), decl(".search-ctx-line.here", "box-shadow")]).toEqual(["var(--surface-2)", null, null]);
  });
});
