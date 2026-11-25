/**
 * M-3727: at 320–360 px the Office's bar on a phone (Find, Canvas / List / Office, ⋯) needed about 342 px (en) in one
 * unwrapped row, so ⋯ went off-screen. Under 370 px it now wraps: Find takes the first row, the view switch and ⋯ (at the
 * right) the second. The real-browser geometry (every control whole on screen at 320 / 360 / 375 px, en and zh-TW, light and
 * dark; the area pills reachable) is measured by scripts/manual/office-toolbar-narrow-m3727/capture.mts; this pins the rule.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/ui/shared/app.css", "utf8");
describe("M-3727: the Office's phone bar wraps under 370 px", () => {
  const block = css.match(/@media \(max-width: 369px\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  it("the rule is there, inside the Office's phone block (M-3253)", () => {
    expect(block).not.toBe("");
    const phone = css.indexOf("/* M-3253 (Argon's phone review)"), at = css.indexOf("@media (max-width: 369px)");
    expect(phone).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(phone);
  });
  it("the bar wraps, Find takes a whole row, ⋯ keeps to the right", () => {
    expect(block).toMatch(/\.oc-office \.oc-bar \.oc-tools:has\(\.oo-more-btn\) \{ flex-wrap: wrap;/);
    expect(block).toMatch(/\.oc-tools:has\(\.oo-more-btn\) \.oc-find \{ flex: 1 0 100%; \}/);
    expect(block).toMatch(/\.oc-tools \.oo-more-btn \{ margin-left: auto; \}/);
  });
  it("wider phones keep the one-row bar (M-3253's two rows above the office)", () => {
    expect(css).toMatch(/\.oc-office \.oc-bar \.oc-tools:has\(\.oo-more-btn\) \{ flex-wrap: nowrap;/);
  });
});
