/**
 * M-3212 (the user, 11-16): the phone's drawer width is a choice — 自訂 → 顯示 → 手機側欄: 滿版 (the default, M-3211) or 窄版
 * (the drawer before M-3211, the page beside it). This browser's own (localStorage), not a synced pref. On a phone the
 * 自訂 menu opens from an icon beside the drawer's filter (its list header, with the chip, is hidden there, M-3166).
 * The real Shell and InstanceNav in the mini DOM; what a phone draws is the PR's smoke.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const mounted: AppPage[] = [];
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });
const Stub = (name: string) => ({ Component: () => h("div", { class: `stub-${name}` }) });
const PANELS = new Map([["chat", Stub("chat")], ["view", Stub("view")], ["fleet", Stub("fleet")], ["settings", Stub("settings")], ["needs", Stub("needs")]]);

async function app(storage: Record<string, string> = {}) {
  const pg = page({ url: "http://127.0.0.1:19280/ui/fleet/org", storage: { agend_tour_done: "1", agend_lang: "en", ...storage }, matchNarrow: true });
  mounted.push(pg);
  pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));   // prefs readable: 自訂 is offered
  (globalThis as any).fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { startRouter } = await import("/assets/app-nav.js");
  const { applyStatus } = await import("/assets/app-store.js");
  const { Shell } = await import("/assets/app-shell.js");
  const nav = await import("/assets/instance-nav.js");
  const i18n = await import("/assets/app-i18n.js");
  i18n.setLang(storage.agend_lang ?? "en", { store: false });
  nav.navStore.set({ filter: { q: "", status: [], cli: [] }, collapsed: new Set(), favorites: [], sort: { mode: "custom", favs: "fixed" } });
  // The store reads this browser's choice when the module loads; a test page starts from what its storage says.
  nav.phoneDrawerStore.set({ value: storage.agend_phone_drawer === "narrow" ? "narrow" : "full" });
  startRouter(pg.window);
  applyStatus({ instances: [{ name: "alpha", status: "running", backend: "claude-code" }, { name: "beta", status: "running", backend: "codex" }] });
  await pg.mount(h(Shell, { panels: PANELS, onNewInstance() {} }));
  await settle(3);
  const aside = () => pg.root.querySelector("#sidebar") as any;
  const narrow = () => aside().classList.contains("drawer-narrow");
  const phoneBtn = () => pg.root.querySelector(".v-filter .nav-sort-phone > .nav-sort-btn") as any;
  const menu = () => pg.root.querySelector(".nav-sort-phone .nav-sort-menu") as any;
  const radio = (v: string) => [...(menu()?.querySelectorAll("input") ?? [])].find((i: any) => (i.name ?? i.getAttribute("name")) === "nav-sort-drawer" && (i.value ?? i.getAttribute("value")) === v) as any;
  return { pg, nav, aside, narrow, phoneBtn, menu, radio };
}

describe("M-3212: 手機側欄 — 滿版 or 窄版, this browser's own", () => {
  it("滿版 by default; the phone's 自訂 icon sits in the filter row and opens the menu; 顯示 holds the density and 手機側欄", async () => {
    const a = await app();
    expect(a.narrow()).toBe(false);
    expect(a.phoneBtn()?.getAttribute("aria-label")).toBe("Sort the list: Custom");
    fire(a.phoneBtn(), "click"); await settle(2);
    const display = [...a.menu().querySelectorAll("fieldset")].find((f: any) => f.querySelector("legend")?.textContent === "Display") as any;
    const drawer = display.querySelector("fieldset.nav-sort-drawer");
    expect([drawer?.querySelector("legend")?.textContent, ...[...drawer.querySelectorAll("label.nav-sort-opt")].map((l: any) => l.textContent)]).toEqual(["Phone sidebar", "Full width", "Narrow"]);
    expect([a.radio("full").checked, a.radio("narrow").checked]).toEqual([true, false]);
  });

  it("窄版 at once and kept in this browser; 滿版 again forgets it", async () => {
    const a = await app();
    fire(a.phoneBtn(), "click"); await settle(2);
    a.radio("narrow").checked = true; fire(a.radio("narrow"), "change"); await settle(2);
    expect([a.narrow(), (globalThis as any).localStorage.getItem("agend_phone_drawer"), !!a.menu()]).toEqual([true, "narrow", true]);
    a.radio("full").checked = true; fire(a.radio("full"), "change"); await settle(2);
    expect([a.narrow(), (globalThis as any).localStorage.getItem("agend_phone_drawer")]).toEqual([false, null]);
  });

  it("a browser that chose 窄版 opens on it", async () => {
    const a = await app({ agend_phone_drawer: "narrow" });
    expect(a.narrow()).toBe(true);
  });

  it("reads 手機側欄 / 滿版 / 窄版 in Chinese", async () => {
    const a = await app({ agend_lang: "zh-TW" });
    fire(a.phoneBtn(), "click"); await settle(2);
    const drawer = a.menu().querySelector("fieldset.nav-sort-drawer");
    expect([drawer.querySelector("legend").textContent, ...[...drawer.querySelectorAll("label.nav-sort-opt")].map((l: any) => l.textContent)]).toEqual(["手機側欄", "滿版", "窄版"]);
  });

  it("the stylesheet: 滿版's rules are 滿版's alone, 窄版 is the 300 px drawer, the icon and 手機側欄 are a phone's only, the list follows 文字大小", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    expect(css).toContain(".sidebar.fleet-side:not(.drawer-narrow) { width: 100vw;");
    expect(css).toContain(".sidebar.fleet-side.drawer-narrow { width: 300px; }");
    expect(css).not.toMatch(/\n {2}\.sidebar\.fleet-side \.v-inst \.av \{ width: 54px/);   // no 滿版 size left unscoped
    expect(css).toContain(".nav-sort-phone { display: none; }");
    expect(css).toContain("  .sidebar.fleet-side .nav-sort-phone { display: block; flex: none; }");
    expect(css).toContain("@media (min-width: 900px) { .nav-sort-menu .nav-sort-drawer { display: none; } }");
    expect(css).toContain("  .sidebar.fleet-side .inst-nav {\n    --fs-xs: calc(var(--fs-xs-base) * var(--text-scale));");   // M-3216: the base the phone raises
  });
});
