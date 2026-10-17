/**
 * #2044: an effect frame stays see-through under every theme. Its document declares no colour scheme (light); an
 * iframe whose own used colour scheme differs from its document's gets an opaque backdrop in Chromium, so the dark
 * theme's inherited `color-scheme: dark` painted a white box over the whole chat. The stylesheet pins the frame to
 * `normal`, and nothing later in it may set the frame's colour scheme again.
 * (Real-browser check: scripts/manual/smoke/smoke-mod-effects.mts, dark cases.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCanvasEffectShim } from "../src/web-effect-worker.js";

const css = readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].split(",").map(s => s.trim()), body: m[2] }));

describe("effect frame colour scheme (#2044)", () => {
  it("pins .agend-effect-frame to color-scheme: normal", () => {
    const own = rules.filter(r => r.selectors.includes(".agend-effect-frame"));
    expect(own.some(r => /(^|;)\s*color-scheme\s*:\s*normal\s*!important\s*(;|$)/.test(r.body))).toBe(true);
  });
  it("no other rule in the stylesheet sets a colour scheme on an iframe", () => {
    const others = rules.filter(r => /color-scheme/.test(r.body) && r.selectors.some(s => /iframe|agend-effect-frame/.test(s)) && !r.selectors.every(s => s === ".agend-effect-frame"));
    expect(others.map(r => r.selectors.join(","))).toEqual([]);
  });
  it("the frame document still declares no colour scheme (so `normal` is what it uses)", () => {
    const html = buildCanvasEffectShim("b".repeat(32), ["http://127.0.0.1:1"]);
    expect(html).not.toMatch(/color-scheme/i);
  });
});
