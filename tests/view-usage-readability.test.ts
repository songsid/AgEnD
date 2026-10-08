/**
 * The AI-usage percentage was hard to read ("100%" at 12px over a 6px bar).
 * These pin the readability floor so a later style pass cannot quietly shrink
 * it again; the rendered result is verified manually (see the PR).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const view = readFileSync(join(process.cwd(), "src", "ui", "view.html"), "utf-8");
// #1408 step 1: the dashboard's percentages and bars are the chat's details panel, styled by the app's stylesheet.
const panelChat = readFileSync(join(process.cwd(), "src", "ui", "panel-chat.js"), "utf-8");
const appCss = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf-8");
const tokens = readFileSync(join(process.cwd(), "src", "ui", "shared", "tokens.css"), "utf-8");
// A size that names a token (font-size: var(--fs-sm)) resolves to its px value in tokens.css.
const resolved = (css: string, selector: string, prop: string) => {
  const direct = px(css, selector, prop);
  if (!Number.isNaN(direct)) return direct;
  const token = css.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{[^}]*${prop}:\\s*var\\((--[\\w-]+)\\)`))?.[1];
  const value = token ? tokens.match(new RegExp(`${token}:\\s*(\\d+)px`))?.[1] : undefined;
  return value ? Number(value) : NaN;
};
const px = (css: string, selector: string, prop: string) => {
  const rule = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  const value = rule?.[1].match(new RegExp(`${prop}:\\s*(\\d+)px`));
  return value ? Number(value[1]) : NaN;
};

describe("AI usage readability", () => {
  it("renders the percentage as a large, level-coloured number over a thick bar", () => {
    expect(view).toContain('`<span class="u-val u-pct ${cls}">${pct.toFixed(0)}<span class="u-unit">%</span></span></div>`');
    expect(px(view, ".u-row .u-val.u-pct", "font-size")).toBeGreaterThanOrEqual(22);
    expect(px(view, ".u-meter", "height")).toBeGreaterThanOrEqual(10);
    expect(px(view, ".u-row", "font-size")).toBeGreaterThanOrEqual(13);
  });

  it("keeps the dashboard's context and rate percentages bold with a visible bar", () => {
    expect(panelChat.match(/<span class="pct">/g)?.length).toBe(3);
    expect(appCss).toMatch(/\.pct \{ font-weight: var\(--fw-semibold\);/);
    // The row is 13 px; the percentage itself keeps the old dashboard's floor of 15 px.
    expect(resolved(appCss, ".pct", "font-size")).toBeGreaterThanOrEqual(15);
    expect(px(appCss, ".progress-bar", "height")).toBeGreaterThanOrEqual(8);
  });

  it("uses inline SVG icons for the toolbar so they render without an emoji font", () => {
    for (const id of ["usageBtn", "langBtn", "helpBtn"]) {
      const button = view.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`))?.[1] ?? "";
      expect(button, id).toMatch(/^<svg /);
    }
  });
});
