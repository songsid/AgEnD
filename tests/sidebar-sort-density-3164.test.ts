import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

// M-3164: the sidebar's sort popover has a third section, Display, with the same synced density choice as Settings (nav.density, M-3129).
let releasePrefs: () => void;
let hostValues: Record<string, unknown> = {}, rev = 1;
let p: AppPage, nav: any, shell: any, prefs: any, i18n: any;
const items = [
  { name: "alpha", display_name: "Alpha", backend: "codex", status: "running", teams: ["Dev"], context_pct: 48, last_reply: new Date(Date.now() - 180000).toISOString() },
  { name: "beta", display_name: "Beta", backend: "claude-code", status: "running", teams: ["Dev"], context_pct: 22, last_reply: new Date(Date.now() - 600000).toISOString() },
];
function Preview() { return h("div", {}, h(shell.DevicePrefs, { labels: true, fields: ["density"] }), h(nav.InstanceNav, { route: { panel: "chat", instance: "alpha" }, items, exec: {}, awaiting: {} })); }
const menu = () => p.root.querySelector(".nav-sort-menu") as any;
const openMenu = async () => { if (!menu()) { fire(p.root.querySelector(".nav-sort-btn"), "click"); await settle(2); } expect(menu()).not.toBeNull(); };
// The Display fieldset (M-3212 nests the phone drawer's width inside it): its own options are the density radios.
const section = () => [...menu().querySelectorAll("fieldset")].find((f: any) => f.parentNode === menu() && [...f.querySelectorAll("input")].some((i: any) => (i.name ?? i.getAttribute("name")) === "nav-sort-density")) as any;
const own = (f: any) => [...f.querySelectorAll("label.nav-sort-opt")].filter((l: any) => l.parentNode === f).map((l: any) => l.textContent);
const radio = (value: string) => [...menu().querySelectorAll("input")].find((i: any) => (i.name ?? i.getAttribute("name")) === "nav-sort-density" && (i.value ?? i.getAttribute("value")) === value) as any;
const select = () => p.root.querySelector("#pref-density") as any;
const compactList = () => p.root.querySelector(".inst-nav.compact") !== null;

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/preferences", storage: { agend_lang: "en" } });
  p.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any = {}) => { if (init.body) { Object.assign(hostValues, JSON.parse(init.body).set); rev++; } return { ok: true, json: async () => ({ rev, values: { ...hostValues } }) }; }));
  nav = await import("/assets/instance-nav.js"); shell = await import("/assets/app-shell.js"); prefs = await import("/assets/app-prefs.js"); i18n = await import("/assets/app-i18n.js");
});
beforeEach(async () => {
  i18n.setLang("en", { store: false });
  nav.navStore.set({ filter: { q: "", status: [], cli: [] }, collapsed: new Set(), favorites: [], sort: { mode: "custom", favs: "fixed" } });
  releasePrefs = prefs.holdPrefs(); nav.setSidebarDensity("detailed");
});
afterEach(async () => { prefs.discardHeldPrefs(); releasePrefs(); await p.unmount(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });

describe("M-3164 Display in the sort popover", () => {
  it("is the third section, below Sort and Favorites, with Detailed and Compact as radios like theirs", async () => {
    await p.mount(h(Preview)); await openMenu();
    expect([...menu().querySelectorAll("legend")].map((l: any) => l.textContent)).toEqual(["Sort the list", expect.any(String), "Display", "Phone sidebar"]);
    expect(own(section())).toEqual(["Detailed", "Compact"]);
    expect(radio("detailed").checked).toBe(true); expect(radio("compact").checked).toBe(false);
  });
  it("a click in the popover changes the list at once and is the Settings choice", async () => {
    await p.mount(h(Preview)); await openMenu();
    radio("compact").checked = true; fire(radio("compact"), "change"); await settle(3);
    expect(compactList()).toBe(true); expect(select().value).toBe("compact");
    expect(nav.sidebarDensityStore.get().value).toBe("compact"); expect(prefs.heldPrefsCount()).toBeGreaterThan(0);
    expect(menu()).not.toBeNull(); expect(radio("compact").checked).toBe(true);
    radio("detailed").checked = true; fire(radio("detailed"), "change"); await settle(3);
    expect(compactList()).toBe(false); expect(select().value).toBe("detailed");
  });
  it("a change in Settings shows in the open popover", async () => {
    await p.mount(h(Preview)); await openMenu();
    select().value = "compact"; fire(select(), "change"); await settle(3);
    expect(radio("compact").checked).toBe(true); expect(radio("detailed").checked).toBe(false); expect(compactList()).toBe(true);
  });
  it("is saved as nav.density and follows another device's change", async () => {
    await p.mount(h(Preview)); await openMenu();
    radio("compact").checked = true; fire(radio("compact"), "change"); await prefs.savePrefsHeld(); await settle(3);
    expect(hostValues["nav.density"]).toBe("compact");
    hostValues["nav.density"] = "detailed"; rev++; await prefs.refresh(); await settle(3);
    await openMenu(); expect(radio("detailed").checked).toBe(true); expect(compactList()).toBe(false);
  });
  it("reads 顯示 / 詳細 / 精簡 in Chinese", async () => {
    i18n.setLang("zh-TW", { store: false }); await p.mount(h(Preview)); await openMenu();
    expect(section().querySelector("legend").textContent).toBe("顯示");
    expect(own(section())).toEqual(["詳細", "精簡"]);
  });
});
