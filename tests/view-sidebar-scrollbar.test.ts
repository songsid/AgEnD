import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The sidebar's scrolling list (View's roster is one, in the app shell) and the stylesheet that the page loads.
const appCss = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf-8");
// Comments stripped: they mention the properties they explain. (#1408 step 5: shell.css is retired.)
const css = [appCss].map(src => src.replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
const LIST = ".side-section";
const scrollbarRules = css.split("\n").filter(l => /scrollbar-(color|width)|::-webkit-scrollbar/.test(l));

describe("/view sidebar scrollbar", () => {
  // Intent (view.html, #999 era): the sidebar's list scroller gets thin, dark-theme-matched scrollbars. In the app the
  // scroller is the roster's section (.side-section, overflow-y: auto); no stylesheet of the page styles it yet, so
  // the browser's light default bar with arrows shows on the dark sidebar.
  it("styles the sidebar list's scrollbar for WebKit/Blink and Firefox", () => {
    expect(css).toMatch(new RegExp(`${LIST.replace(".", "\\.")}::-webkit-scrollbar \\{ width: \\d+px; \\}`));
    expect(css).toContain(`${LIST}::-webkit-scrollbar-track { background: transparent; }`);
    expect(css).toMatch(new RegExp(`${LIST.replace(".", "\\.")}::-webkit-scrollbar-thumb \\{ background: color-mix\\(in srgb, var\\(--text-3\\)`));
    expect(css).toMatch(new RegExp(`${LIST.replace(".", "\\.")}::-webkit-scrollbar-thumb:hover \\{ background: color-mix\\(in srgb, var\\(--text-3\\)`));
    expect(css).toContain(`${LIST}::-webkit-scrollbar-button { display: none; }`);
    expect(css).toMatch(new RegExp(`@supports \\(-moz-appearance: none\\) \\{\\s*${LIST.replace(".", "\\.")} \\{ scrollbar-width: thin; scrollbar-color: color-mix\\(in srgb, var\\(--text-3\\)`));
  });

  it("takes its colours from the page's own tokens, not new literals", () => {
    expect(scrollbarRules.length).toBeGreaterThan(0);
    for (const rule of scrollbarRules) {
      expect(rule, rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it("applies only to the sidebar list: the terminal's own scrollbar is untouched", () => {
    for (const rule of scrollbarRules) {
      expect(rule.trim(), rule).toMatch(new RegExp(`^(${LIST.replace(".", "\\.")}\\b|@supports)`));
    }
    expect(css).not.toMatch(/\.v-term[^{]*scrollbar-(color|width)/);
    expect(css).not.toMatch(/\.v-term::-webkit-scrollbar/);
    // The terminal keeps the layout rule that stops resize→scrollbar→resize loops.
    expect(appCss).toMatch(/\.v-term \{ flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable;/);
  });

  it("does not set scrollbar-color for Chromium, which would switch off the ::-webkit-scrollbar styling", () => {
    // Any scrollbar-color/-width outside the Firefox-only @supports block wins over the pseudo-elements in Chromium 121+.
    const outside = css.replace(/@supports \(-moz-appearance: none\) \{[\s\S]*?\n  \}\n/, "");
    expect(outside).not.toMatch(/scrollbar-(color|width)\s*:/);
  });
});
