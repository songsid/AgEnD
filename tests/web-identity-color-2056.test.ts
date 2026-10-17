/**
 * #2056 (the user, 2026-10-17): the sidebar's identity bar is a plain straight line, inset so it never crosses the
 * selected or hover highlight's rounded corners; and where nobody chose, the colour shows in all three places.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PLACEMENTS } from "../src/web-identity-palette.js";

const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
const tokens = readFileSync(join(process.cwd(), "src/ui/shared/tokens.css"), "utf8");
const rule = (sel: string) => { const i = css.indexOf(`${sel} {`); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf("}", i)); };
const px = (token: string) => Number(new RegExp(`--${token}: (\\d+)px`).exec(tokens)![1]);

describe("#2056: the sidebar's identity bar", () => {
  it("a straight line of its own (a pseudo-element), not an inset shadow that follows the row's corners", () => {
    expect(css).not.toMatch(/\.idc\.id-bar\s*\{[^}]*box-shadow/);
    const bar = rule(".idc.id-bar::before");
    expect(bar).toContain("position: absolute");
    expect(bar).toContain("left: 0");
    expect(bar).toContain("width: 3px");
    expect(bar).not.toMatch(/border-radius/);
    expect(rule(".idc.id-bar")).toContain("position: relative");
  });
  it("inset top and bottom by at least the row's corner radius: it never runs into the rounded highlight", () => {
    const bar = rule(".idc.id-bar::before");
    const inset = (side: "top" | "bottom") => { const m = new RegExp(`${side}: var\\(--([a-z0-9-]+)\\)`).exec(bar)!; return px(m[1]!); };
    const row = /border-radius: var\(--([a-z0-9-]+)\)/.exec(rule(".inst"))!;
    expect(Math.min(inset("top"), inset("bottom"))).toBeGreaterThanOrEqual(px(row[1]!));
  });
});

describe("#2056: where the colour shows by default", () => {
  it("all three — name, bar and ring — where nobody chose", () => {
    expect([...DEFAULT_PLACEMENTS]).toEqual(["name", "bar", "ring"]);
  });
});
