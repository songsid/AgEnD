import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(process.cwd(), "src", "ui", "view.html"), "utf-8");
// Comments stripped: they mention the properties they explain.
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>")).replace(/\/\*[\s\S]*?\*\//g, "");
const scrollbarRules = css.split("\n").filter(l => /scrollbar-(color|width)|::-webkit-scrollbar/.test(l));

describe("/view sidebar scrollbar", () => {
  it("styles the instance list's scrollbar for WebKit/Blink and Firefox", () => {
    expect(css).toMatch(/#list::-webkit-scrollbar \{ width: \d+px; \}/);
    expect(css).toContain("#list::-webkit-scrollbar-track { background: transparent; }");
    expect(css).toMatch(/#list::-webkit-scrollbar-thumb \{ background: color-mix\(in srgb, var\(--dim\)/);
    expect(css).toMatch(/#list::-webkit-scrollbar-thumb:hover \{ background: color-mix\(in srgb, var\(--dim\)/);
    expect(css).toContain("#list::-webkit-scrollbar-button { display: none; }");
    expect(css).toMatch(/@supports \(-moz-appearance: none\) \{\s*#list \{ scrollbar-width: thin; scrollbar-color: color-mix\(in srgb, var\(--dim\)/);
  });

  it("takes its colours from the page's own tokens, not new literals", () => {
    expect(scrollbarRules.length).toBeGreaterThan(0);
    for (const rule of scrollbarRules) {
      expect(rule, rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it("applies only to #list — the terminal's own scrollbar is untouched", () => {
    for (const rule of scrollbarRules) {
      expect(rule.trim(), rule).toMatch(/^(#list\b|@supports)/);
    }
    expect(css).not.toMatch(/#term[^{]*scrollbar-(color|width)/);
    expect(css).not.toMatch(/#term::-webkit-scrollbar/);
    // The terminal keeps the layout rule that stops resize→scrollbar→resize loops.
    expect(css).toContain("#term { flex: 1; background: #000; overflow: auto; scrollbar-gutter: stable;");
  });

  it("does not set scrollbar-color for Chromium, which would switch off the ::-webkit-scrollbar styling", () => {
    // Any scrollbar-color/-width outside the Firefox-only @supports block wins over the pseudo-elements in Chromium 121+.
    const outside = css.replace(/@supports \(-moz-appearance: none\) \{[\s\S]*?\n  \}\n/, "");
    expect(outside).not.toMatch(/scrollbar-(color|width)\s*:/);
  });
});
