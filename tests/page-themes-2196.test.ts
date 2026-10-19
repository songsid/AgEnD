/**
 * #2196: an agent's theme can colour the whole page — the sidebar, the header, the usage rail (a phone: the drawer, the
 * header, the tabs) — while its Chat, View, Log or Details is open. The user's decisions: on by default once the agent
 * sets `page`, the header follows the page, a phone's tabs follow too.
 * - The host's check: `page` is closed and typed; with page.on the sidebar must read (text, text2, accent) and AgEnD's
 *   status colours must read on it and on the background (refused otherwise); the status colours are the stylesheet's.
 * - The page: colour tokens on the shell for the open agent only, switched in the render that opens it; a person's
 *   choice (theme.pageByInstance) wins; off with agents' themes off or ?safe=1; never an unreadable palette; names in
 *   identity colours read on it; the ⋯ menu's Page colours radio items.
 * Real store, prefs, router, themes and Shell in a mini DOM.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTheme, applyThemePatch, pagePalette, STATUS_COLORS, THEME_DEFAULTS } from "../src/web-theme.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const ctx = { assets: new Set<string>() };
// Two agents' themes (the mockup's Harbor and Amber): readable on their own pages.
const HARBOR = {
  colors: { light: { bg: "#f3f9f8", surface: "#ffffff", text: "#0c1f1d", text2: "#3a5a56", accent: "#0f766e" },
    dark: { bg: "#0f1f1e", surface: "#16302d", text: "#e2f3f0", text2: "#9cc7c1", accent: "#2dd4bf" } },
  page: { on: true, sidebar: { light: "#e2f0ed", dark: "#0a1716" } },
};
const AMBER = {
  colors: { light: { bg: "#fdf8f0", surface: "#fffdf8", text: "#24180a", text2: "#6a5233", accent: "#b45309" },
    dark: { bg: "#1d150b", surface: "#2b1f10", text: "#f6ead8", text2: "#d2b78f", accent: "#f59e0b" } },
  page: { on: true },
};

describe("the host's check of `page`", () => {
  it("a readable page theme is kept, canonical (sidebar per mode, on as a boolean)", () => {
    const r = checkTheme({ ...HARBOR, page: { sidebar: { dark: "#0A1716", light: "#e2f0ed" }, on: true } }, ctx);
    expect(r.ok && r.theme.page).toEqual({ on: true, sidebar: { light: "#e2f0ed", dark: "#0a1716" } });
    expect(r.ok && pagePalette(r.theme, "dark")).toMatchObject({ sidebar: "#0a1716", bg: "#0f1f1e" });
    const amber = checkTheme(AMBER, ctx);
    expect(amber.ok && pagePalette(amber.theme, "light").sidebar).toBe("#fdf8f0");   // no sidebar of its own: its bg
  });
  it("closed and typed: unknown keys, a non-boolean on, a sidebar that is not #rrggbb or not light/dark", () => {
    const bad = [{ page: { on: "yes" } }, { page: { glow: true } }, { page: { sidebar: { light: "teal" } } }, { page: { sidebar: { dusk: "#000000" } } }, { page: [] }];
    expect(bad.map((t) => { const r = checkTheme({ ...HARBOR, ...t }, ctx); return r.ok ? "accepted" : r.errors[0]!.path; }))
      .toEqual(["page.on", "page.glow", "page.sidebar.light", "page.sidebar.dusk", "page"]);
  });
  it("with page.on the sidebar must read — text, text2 and accent — or nothing is stored, naming it", () => {
    const r = checkTheme({ ...HARBOR, page: { on: true, sidebar: { light: "#0c1f1d" } } }, ctx);   // the sidebar the colour of its text
    expect(r.ok).toBe(false);
    const named = r.ok ? [] : r.errors.filter((e) => e.path === "page.sidebar.light").map((e) => e.problem.split(" is ")[0]);
    expect(named.slice(0, 2)).toEqual(["contrast text on the sidebar", "contrast text2 on the sidebar"]);
    // An accent that fails there too is named: a sidebar the colour of the accent.
    const acc = checkTheme({ ...HARBOR, page: { on: true, sidebar: { light: "#0f766e" } } }, ctx);
    expect(!acc.ok && acc.errors.some((e) => e.path === "page.sidebar.light" && e.problem.startsWith("contrast accent on the sidebar"))).toBe(true);
    expect(checkTheme(HARBOR, ctx).ok).toBe(true);
  });
  it("AgEnD's status colours must read on its sidebar and background: a red page hides the Needs you count — refused", () => {
    const red = { colors: { light: { bg: "#c42a2b", surface: "#c42a2b", text: "#ffffff", text2: "#ffffff", accent: "#ffffff", userBubble: "#c42a2b", agentBubble: "#c42a2b" } }, page: { on: true } };
    const r = checkTheme(red, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.some((e) => /AgEnD's dangerFill colour on the sidebar/.test(e.problem))).toBe(true);
    // The same colours only in its chat (page.on false or absent): no page check — as before #2196.
    expect(checkTheme({ ...red, page: { on: false } }, ctx).ok).toBe(true);
    expect(checkTheme({ colors: red.colors }, ctx).ok).toBe(true);
  });
  it("#2202 review: a sidebar colour of its own is checked even with page off (a person may turn the page on for it)", () => {
    const r = checkTheme({ ...HARBOR, page: { on: false, sidebar: { light: "#0c1f1d" } } }, ctx);
    expect(!r.ok && r.errors.some((e) => e.path === "page.sidebar.light" && e.problem.startsWith("contrast text on the sidebar"))).toBe(true);
    // …but not its background against the status colours: a chat-only theme keeps the freedom it had before #2196.
    const red = { colors: { light: { bg: "#c42a2b", surface: "#c42a2b", text: "#ffffff", text2: "#ffffff", accent: "#ffffff", userBubble: "#c42a2b", agentBubble: "#c42a2b" } } };
    expect(checkTheme({ ...red, page: { on: false } }, ctx).ok).toBe(true);
    // A readable sidebar of its own with page off: its background is not held to the status colours (page.on is).
    const darkRed = { colors: { dark: { bg: "#c9372c", text: "#ffffff", text2: "#ffffff", accent: "#ffffff" } }, page: { on: false, sidebar: { dark: "#101010" } } };
    const on = checkTheme({ ...darkRed, page: { ...darkRed.page, on: true } }, ctx);
    expect([checkTheme(darkRed, ctx).ok, !on.ok && on.errors.every((e) => /on the page background/.test(e.problem))]).toEqual([true, true]);
  });
  it("…and on its background, where the sidebar reads but the page is the colour of the Needs you count", () => {
    const t = { colors: { light: { bg: "#e05555", surface: "#ffffff", text: "#000000", text2: "#000000", accent: "#000000" } }, page: { on: true, sidebar: { light: "#ffffff" } } };
    const r = checkTheme(t, ctx);
    expect(r.ok ? [] : [...new Set(r.errors.map((e) => `${e.path} ${/on the page background/.test(e.problem)}`))]).toEqual(["colors.light.bg true"]);
  });
  it("set and clear through set_web_theme's patch; `clear: [\"page\"]` takes it away", () => {
    const set = applyThemePatch({ v: 1 }, { set: HARBOR }, ctx);
    expect(set.ok && set.theme.page?.on).toBe(true);
    const cleared = set.ok ? applyThemePatch(set.theme, { clear: ["page"] }, ctx) : null;
    expect(cleared && cleared.ok && cleared.theme.page).toBeUndefined();
  });
  it("the status colours, and the defaults a page goes over, are the stylesheet's (tokens.css), both modes", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/tokens.css"), "utf8");
    const block = (start: string) => { const i = css.indexOf(start); return css.slice(i, css.indexOf("}", i)); };
    const read = (b: string, v: string) => new RegExp(`--${v}:\\s*(#[0-9a-f]{6})`).exec(b)?.[1];
    const map = { ok: "ok", warn: "warn", danger: "danger", dangerFill: "danger-fill", focus: "focus" } as const;
    for (const [mode, b] of [["dark", block(":root {")], ["light", block(':root[data-theme="light"] {')]] as const) {
      expect(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, read(b, v)])), mode).toEqual(STATUS_COLORS[mode]);
      expect({ bg: read(b, "bg"), text: read(b, "text") }, mode).toEqual({ bg: THEME_DEFAULTS[mode].bg, text: THEME_DEFAULTS[mode].text });
    }
  });
});

// ── The page ──
const mounted: AppPage[] = [];
let host: Record<string, unknown> = {}, rev = 1;
afterEach(async () => {
  // Only after a page test: importing the page's modules with no page yet would load app-prefs without its host view.
  if (!mounted.length) return;
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  (await import("/assets/app-themes.js")).themesStore.set({ themes: {}, shown: true });
});
const I = (name: string) => ({ name, status: "running", backend: "claude-code", tags: ["ops"] });
async function shell(path: string, opts: { themes?: Record<string, unknown>; choices?: Record<string, string>; mode?: "light" | "dark"; narrow?: boolean; safe?: boolean; fxOff?: boolean } = {}) {
  host = { ...(opts.choices ? { "theme.pageByInstance": opts.choices } : {}), ...(opts.fxOff ? { "fx.show": false } : {}) }; rev += 10;
  const pg = page({ url: `http://127.0.0.1:19280${path}${opts.safe ? "?safe=1" : ""}`, storage: { agend_tour_done: "1" }, matchNarrow: opts.narrow });
  mounted.push(pg);
  pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  (globalThis as any).AgendTheme = { get: () => opts.mode ?? "light", onChange: () => () => {} };
  (globalThis as { fetch?: unknown }).fetch = async (_url: string, init: any = {}) => {
    if (init.method === "POST") { const b = JSON.parse(init.body); Object.assign(host, b.set); rev++; }
    return { ok: true, status: 200, json: async () => ({ values: { ...host }, rev }) };
  };
  await import("/ui/js/chat-strings.js");                                       // as panel-chat and panel-details do
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  const themes = await import("/assets/app-themes.js");
  await (await import("/assets/app-prefs.js")).refresh();
  themes.themesStore.set({ rev: 1, themes: opts.themes ?? { harbor: { v: 1, ...HARBOR }, amber: { v: 1, ...AMBER }, plain: { v: 1, colors: HARBOR.colors } }, shown: themes.themesShown() });
  startRouter(pg.window);
  applyStatus({ instances: [I("harbor"), I("amber"), I("plain"), I("bare")] });
  await pg.mount(h(Shell, { panels: new Map(), onNewInstance() {} }));
  await settle(3);
  return { pg, themes };
}
const root = (pg: AppPage) => pg.root.querySelector(".shell") as any;
const look = (pg: AppPage) => { const s = root(pg); return s.classList.contains("th-page") ? { sidebar: s.style["--bg-sidebar"], bg: s.style["--bg"], text: s.style["--text"], accent: s.style["--accent"] } : null; };
const go = async (path: string) => { (await import("/assets/app-nav.js")).navigate(path); await settle(3); };

describe("the page: the open agent's colours on the shell", () => {
  it("its Chat, View, Log and Details take its page colours; another agent its own; one without page, Fleet and Settings the page's own", async () => {
    const { pg } = await shell("/ui/chat/harbor");
    const seen: unknown[] = [];
    for (const p of ["/ui/chat/harbor", "/view/harbor", "/ui/log/harbor", "/ui/fleet/agent/harbor", "/ui/chat/amber", "/ui/chat/plain", "/ui/chat/bare", "/ui/fleet/org", "/settings", "/ui/chat/harbor"]) {
      await go(p); seen.push([p, look(pg)]);
    }
    const H = { sidebar: "#e2f0ed", bg: "#f3f9f8", text: "#0c1f1d", accent: "#0f766e" }, A = { sidebar: "#fdf8f0", bg: "#fdf8f0", text: "#24180a", accent: "#b45309" };
    expect(seen).toEqual([["/ui/chat/harbor", H], ["/view/harbor", H], ["/ui/log/harbor", H], ["/ui/fleet/agent/harbor", H], ["/ui/chat/amber", A],
      ["/ui/chat/plain", null], ["/ui/chat/bare", null], ["/ui/fleet/org", null], ["/settings", null], ["/ui/chat/harbor", H]]);
    // Cleared, not left behind: no page token on the shell where none is drawn.
    await go("/settings");
    expect(["--bg", "--bg-sidebar", "--text", "--accent", "--border", "--on-accent"].map((k) => root(pg).style[k] ?? "")).toEqual(["", "", "", "", "", ""]);
  });
  it("dark mode takes the dark palette; the derived tokens follow (tint, borders, the colour on the accent)", async () => {
    const { pg } = await shell("/ui/chat/harbor", { mode: "dark" });
    const s = root(pg).style;
    expect([look(pg), s["--text-3"], s["--on-accent"], /^rgba\(45, 212, 191, 0\.14\)$/.test(s["--accent-dim"]), /^#[0-9a-f]{6}$/.test(s["--border"])])
      .toEqual([{ sidebar: "#0a1716", bg: "#0f1f1e", text: "#e2f3f0", accent: "#2dd4bf" }, "#9cc7c1", "#0d0d0d", true, true]);
  });
  it("switching is in the same render as the route: no frame of the old look after a navigation settles", async () => {
    const { pg } = await shell("/ui/chat/harbor");
    const { navigate, navStore } = await import("/assets/app-nav.js");
    navigate("/ui/chat/amber"); await settle(1);
    expect([navStore.get().route.instance, look(pg)?.accent]).toEqual(["amber", "#b45309"]);
  });
  it("a person's choice wins: only its chat (page off), or on the whole page for one that never asked", async () => {
    const { pg } = await shell("/ui/chat/harbor", { choices: { harbor: "chat", plain: "page" } });
    const a = look(pg);
    await go("/ui/chat/plain");
    expect([a, look(pg)]).toEqual([null, { sidebar: "#f3f9f8", bg: "#f3f9f8", text: "#0c1f1d", accent: "#0f766e" }]);
  });
  it("the viewer's switch off: the page's own look (and the chat's)", async () => {
    const off = await shell("/ui/chat/harbor", { fxOff: true });
    expect(look(off.pg)).toBeNull();
  });
  it("never an unreadable page: a person's 'on the whole page' for colours that fail (a red page) draws nothing", async () => {
    const red = { v: 1, colors: { light: { bg: "#c42a2b", surface: "#c42a2b", text: "#ffffff", text2: "#ffffff", accent: "#ffffff" } } };
    const { pg, themes } = await shell("/ui/chat/red", { themes: { red }, choices: { red: "page" } });
    expect([look(pg), themes.pageReadable(themes.pagePalette(themes.themeFor("red"), "light"), "light")]).toEqual([null, false]);
  });
  it("#2202 review: the page checks the sidebar itself — a stored theme with page off and an unreadable sidebar, put on the page by a person: nothing drawn, the choice unavailable", async () => {
    // As an older host might have stored it (today's refuses it, above): page off, a sidebar the colour of its text.
    const dim = { v: 1, ...HARBOR, page: { on: false, sidebar: { light: "#0c1f1d" } } };
    const { pg, themes } = await shell("/ui/chat/dim", { themes: { dim }, choices: { dim: "page" } });
    const item = themes.themeMenuItems("dim").find((i: any) => i.key === "page-page");
    expect([look(pg), themes.pageNow("light"), themes.pageReadable(themes.pagePalette(themes.themeFor("dim"), "light"), "light")]).toEqual([null, null, false]);
    expect([item.checked, item.disabled]).toEqual([true, false]);           // chosen already: it stays choosable (to leave)
    const p = mounted.pop()!; await p.unmount(); p.restore();
    const again = await shell("/ui/chat/dim", { themes: { dim } });
    expect(again.themes.themeMenuItems("dim").find((i: any) => i.key === "page-page").disabled).toBe(true);
  });
  it("#2202 review: the page's sidebar check is its own — secondary text that fails only on the sidebar keeps the page in its own look", async () => {
    // Everything reads but text2 on the sidebar (3.9:1): as an older host might have stored it, with page off.
    const t = { v: 1, colors: { dark: { bg: "#000000", surface: "#000000", text: "#e2f3f0", text2: "#6b7b79", accent: "#2dd4bf" } }, page: { on: false, sidebar: { dark: "#1a1a1a" } } };
    const { pg, themes } = await shell("/ui/chat/t2", { themes: { t2: t }, choices: { t2: "page" }, mode: "dark" });
    expect([look(pg), themes.pageNow("dark")]).toEqual([null, null]);
  });
  it("#2199: body[data-agent] is the agent open now — on its Chat, View, Log and Details, gone elsewhere — themes shown or not", async () => {
    const { pg } = await shell("/ui/chat/harbor", { fxOff: true });
    const seen: unknown[] = [];
    for (const p of ["/ui/chat/harbor", "/view/amber", "/ui/log/plain", "/ui/fleet/agent/bare", "/ui/fleet/org", "/settings", "/ui/needs", "/ui/chat/harbor"]) {
      await go(p); seen.push([p, pg.document.body.dataset.agent ?? null]);
    }
    expect(seen).toEqual([["/ui/chat/harbor", "harbor"], ["/view/amber", "amber"], ["/ui/log/plain", "plain"], ["/ui/fleet/agent/bare", "bare"],
      ["/ui/fleet/org", null], ["/settings", null], ["/ui/needs", null], ["/ui/chat/harbor", "harbor"]]);
    const { navigate } = await import("/assets/app-nav.js");
    navigate("/ui/chat/amber"); await settle(1);
    expect([pg.document.body.dataset.agent, look(pg)]).toEqual(["amber", null]);   // the same render; themes off: no colours
  });
  it("#2202 review: only an agent's own pages — Chat, View, Log, Details — take its colours; no other route that names it", async () => {
    const { themes } = await shell("/ui/chat/harbor");
    const on = (route: Record<string, unknown> | null) => themes.pageNow("light", route) !== null;
    expect([{ panel: "chat", instance: "harbor" }, { panel: "view", instance: "harbor" }, { panel: "log", instance: "harbor" }, { panel: "details", instance: "harbor" },
      { panel: "fleet", instance: "harbor" }, { panel: "settings", instance: "harbor" }, { panel: "needs", instance: "harbor" }, { panel: "chat" }, null].map(on))
      .toEqual([true, true, true, true, false, false, false, false, false]);
  });
  it("names in identity colours read on the page's sidebar and background while it is drawn", async () => {
    await shell("/ui/chat/harbor", { mode: "light" });
    const { readableShade, contrast } = await import("/assets/identity-color.js");
    const { pageNow } = await import("/assets/app-themes.js");
    const p = pageNow("light");
    const shade = readableShade("#14b8a6", "light", p);   // a teal name on a teal page
    expect([p.sidebar, contrast(shade, p.sidebar) >= 4.5, contrast(shade, p.bg) >= 4.5, readableShade("#14b8a6", "light") === shade]).toEqual(["#e2f0ed", true, true, false]);
    // …as a row's identity is drawn (identityOf): its name shade is the page's while the page is themed.
    const { identityOf } = await import("/assets/identity-color.js");
    expect(identityOf({ name: "x", color: { person: "#14b8a6" } }).nameLight).toBe(shade);
  });
  it("the header follows the page, not the chat: the stylesheet gives a chat's header the shell's colours back", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    expect(css).toContain(".shell { --chrome-bg: var(--bg); --chrome-surface: var(--surface); --chrome-text: var(--text); --chrome-text-2: var(--text-2); --chrome-accent: var(--accent); }");
    expect(css).toContain(".p-chat > .panel-head { --bg: var(--chrome-bg); --surface: var(--chrome-surface); --text: var(--chrome-text); --text-2: var(--chrome-text-2); --accent: var(--chrome-accent); background: var(--bg); color: var(--text); }");
    expect(css).toContain(".shell.th-page { background: var(--bg); color: var(--text); }");
  });
});

describe("⋯ → Page colours", () => {
  it("a heading and three choices, the one in force ticked; 'on the whole page' unavailable when its colours would not read", async () => {
    const { themes } = await shell("/ui/chat/harbor", { themes: { harbor: { v: 1, ...HARBOR }, red: { v: 1, colors: { light: { bg: "#c42a2b", surface: "#c42a2b", text: "#ffffff", text2: "#ffffff", accent: "#ffffff" } } } } });
    const items = (n: string) => themes.themeMenuItems(n).filter((i: any) => i.key.startsWith("page-")).map((i: any) => [i.key, i.heading ? "heading" : i.checked, i.label, !!i.disabled]);
    expect(items("harbor")).toEqual([["page-heading", "heading", "Page colours", false], ["page-agent", true, "The agent's choice (on)", false],
      ["page-page", false, "On the whole page", false], ["page-chat", false, "Only its chat", false]]);
    expect(items("red").map((i: any[]) => [i[0], i[3]])).toEqual([["page-heading", false], ["page-agent", false], ["page-page", true], ["page-chat", false]]);
    expect(themes.themeMenuItems("nobody").some((i: any) => i.key.startsWith("page-"))).toBe(false);   // no theme: nothing to choose
  });
  it("choosing writes the host's preference (another instance's choice kept, 'the agent's' clears its own); the page follows at once", async () => {
    const { pg, themes } = await shell("/ui/chat/harbor", { choices: { amber: "chat" } });
    themes.themeMenuItems("harbor").find((i: any) => i.key === "page-chat").onSelect(); await settle(3);
    const off = look(pg);
    await new Promise((r) => setTimeout(r, 450));
    const written = host["theme.pageByInstance"];
    themes.themeMenuItems("harbor").find((i: any) => i.key === "page-agent").onSelect(); await settle(3);
    await new Promise((r) => setTimeout(r, 450));
    expect([off, written, host["theme.pageByInstance"], look(pg)?.accent]).toEqual([null, { amber: "chat", harbor: "chat" }, { amber: "chat" }, "#0f766e"]);
  });
  it("the menu draws a heading (not focusable) and radio items (aria-checked), and the arrow keys reach the radios", async () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    const { Menu } = await import("/assets/ui-menu.js");
    await pg.mount(h(Menu, { items: [{ key: "h", heading: true, label: "Page colours" }, { key: "a", checked: true, label: "A", onSelect() {} }, { key: "b", checked: false, label: "B", onSelect() {} }, { key: "x", label: "Other", onSelect() {} }] }));
    pg.root.querySelector(".menu > button").click(); await settle();
    const list = pg.root.querySelector(".menu-list");
    expect([...list.children].map((c: any) => [c.getAttribute("role"), c.getAttribute("aria-checked"), c.textContent.trim()]))
      .toEqual([["presentation", null, "Page colours"], ["menuitemradio", "true", "A"], ["menuitemradio", "false", "B"], ["menuitem", null, "Other"]]);
    fire(list, "keydown", { key: "Home" });
    expect(pg.document.activeElement?.textContent.trim()).toBe("A");
  });
});

// Last in the file: safe mode is read when the modules load, so it needs its own (and nothing mounts after this).
describe("?safe=1", () => {
  it("no page colours, whatever the agent or a person chose", async () => {
    vi.resetModules();
    const pg = page({ url: "http://127.0.0.1:19280/ui/chat/harbor?safe=1", storage: { agend_tour_done: "1" } });
    mounted.push(pg);
    const themes = await import("/assets/app-themes.js");
    themes.themesStore.set({ themes: { harbor: { v: 1, ...HARBOR } }, shown: true });
    expect([themes.themesShown(), themes.pageNow("light", { panel: "chat", instance: "harbor" })]).toEqual([false, null]);
  });
});
