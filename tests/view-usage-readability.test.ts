/**
 * The AI-usage percentage was hard to read ("100%" at 12px over a 6px bar). These pin the readability floor so a later
 * style pass cannot quietly shrink it again. Ported from view.html (#1408 step 2): the percentage and its bar are
 * rendered by the usage dialog of ViewPanel and checked there; the sizes are the stylesheet's (app.css, with tokens.css
 * resolving the named sizes). The rendered result is verified manually (see the PR).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf-8");
// #1408 step 1: the dashboard's percentages and bars are the chat's details panel, styled by the app's stylesheet.
// #1523 N2: the instance's details (with its context and rate percentages) are a page now, panel-details.js.
const panelDetails = read("src", "ui", "panel-details.js");
const appCss = read("src", "ui", "shared", "app.css");
const appShell = read("src", "ui", "shared", "app-shell.js");
const tokens = read("src", "ui", "shared", "tokens.css");
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

const g = globalThis as any;
let p: AppPage;
let view: typeof import("/assets/panel-view.js");
let ai: unknown = { providers: [], fetchedAt: 0 };

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/view/alpha", storage: { agend_tour_done: "1" } });
  g.fetch = async (u: string) => {
    if (u === "/api/profiles") return { ok: true, status: 200, json: async () => [{ instance_name: "alpha", status: "running", backend: "codex", tags: ["G"], context_pct: 1, model: "m", has_avatar: false, description: "" }] };
    if (u.startsWith("/api/pane/")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    if (u.startsWith("/api/ai-usage")) return { ok: true, status: 200, json: async () => ai };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  g.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0", fontFamily: "monospace", fontSize: "1px", lineHeight: "1.2" });
  view = await import("/assets/panel-view.js");
});
afterAll(async () => { await p.unmount(); p.restore(); for (const k of ["fetch", "getComputedStyle"]) delete g[k]; });
afterEach(async () => { await p.unmount(); ai = { providers: [], fetchedAt: 0 }; });

async function openUsage(metrics: unknown[]) {
  ai = { fetchedAt: Date.parse("2026-10-06T00:00:00Z"), providers: [{ id: "codex", name: "Codex", status: "ok", metrics }] };
  await p.mount(h(view.ViewPanel, { route: { panel: "view", instance: "alpha" }, navKey: "view:alpha|1|en" }));
  await settle(6);
  p.root.querySelectorAll(".panel-actions .btn").find((b: any) => b.textContent.includes("Usage"))!.click();
  await settle(6);
}

describe("AI usage readability", () => {
  it("renders the percentage as a large, level-coloured number over a thick bar", async () => {
    await openUsage([{ label: "Session", type: "percent", used: 42 }]);
    const pct = p.root.querySelector(".u-pct")!;
    expect(pct.textContent).toBe("42%");
    expect(pct.className).toContain("u-pct");
    expect(p.root.querySelector(".u-fill")!.style.width).toBe("42%");       // the bar, sized through the CSSOM
    expect(px(appCss, ".u-pct", "font-size")).toBeGreaterThanOrEqual(22);
    expect(px(appCss, ".u-meter", "height")).toBeGreaterThanOrEqual(10);
    expect(resolved(appCss, ".u-row", "font-size")).toBeGreaterThanOrEqual(13);
  });

  it("the level colour follows the usage: warn from 70%, crit from 90%", async () => {
    await openUsage([{ label: "Session", type: "percent", used: 91 }]);
    expect(p.root.querySelector(".u-pct")!.className).toContain("crit");
    expect(p.root.querySelector(".u-status")!.textContent).toBe("near limit");
    await p.unmount();
    await openUsage([{ label: "Session", type: "percent", used: 75 }]);
    expect(p.root.querySelector(".u-pct")!.className).toContain("warn");
    expect(p.root.querySelector(".u-status")!.textContent).toBe("high");
  });

  it("keeps the dashboard's context and rate percentages bold with a visible bar", () => {
    expect(panelDetails.match(/<span class="pct">/g)?.length).toBe(3);
    expect(appCss).toMatch(/\.pct \{ font-weight: var\(--fw-semibold\);/);
    // The row is 13 px; the percentage itself keeps the old dashboard's floor of 15 px.
    expect(resolved(appCss, ".pct", "font-size")).toBeGreaterThanOrEqual(15);
    expect(px(appCss, ".progress-bar", "height")).toBeGreaterThanOrEqual(8);
  });

  it("the toolbar's usage and help buttons start with an inline SVG icon, so they render without an emoji font", async () => {
    await openUsage([]);
    const usage = p.root.querySelectorAll(".panel-actions .btn").find((b: any) => b.textContent.includes("Usage"))!;
    const help = p.root.querySelector('button[aria-label="Help"]')!;
    for (const [id, button] of [["usage", usage], ["help", help]] as const) {
      expect(button.children[0]!.localName, id).toBe("svg");
    }
  });

  it("the language switch is the shell's (Settings → This device, or the View reader's footer popover), not the panel's toolbar", async () => {
    await openUsage([]);
    expect(p.root.querySelector('select[aria-label="Language"]')).toBeNull();      // the shell's controls are not in this mount
    expect(appShell).toContain("export function DevicePrefs(");                    // #1604: one component, two places
    expect(appShell).toContain('aria-label=${t("app.language")}');
    expect(appShell).toContain("side-foot");
  });
});
