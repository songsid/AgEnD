import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { GUEST_OWN_PREF_KEYS } from "../src/web-prefs.js";

let p: AppPage, nav: any, prefs: any, store: any, Shell: any, lang: any;
let values: Record<string, unknown> = {}, rev = 1;
const rows = [{ name: "agent-alpha", display_name: "Atlas", status: "running" }, { name: "agent-beta", display_name: "Beacon", status: "running" }, { name: "shared-room", display_name: "Shared room", status: "running" }];
const panels = new Map([["chat", { Component: () => h("div", { class: "fixture-chat" }) }]]);
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/chat/agent-beta", matchNarrow: true, storage: { agend_tour_done: "1", agend_lang: "en" } });
  p.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev, values: {} }));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => {
    if (String(url).includes("/auth/session")) return { ok: true, json: async () => ({ tier: p.document.body.dataset.tier }) };
    if (init.body) { Object.assign(values, JSON.parse(init.body).set); rev++; }
    return { ok: true, json: async () => ({ rev, values: { ...values } }) };
  }));
  ({ Shell } = await import("/assets/app-shell.js")); nav = await import("/assets/instance-nav.js"); prefs = await import("/assets/app-prefs.js"); store = await import("/assets/app-store.js"); lang = await import("/assets/app-i18n.js");
  const { startRouter } = await import("/assets/app-nav.js"); startRouter(p.window);
});
beforeEach(async () => {
  p.document.body.dataset.tier = "guest"; p.document.body.dataset.publicLink = "1";
  values = {}; rev++; await prefs.refresh(); lang.setLang("en", { store: false });
  nav.navStore.set({ filter: { q: "", status: [], cli: [] }, collapsed: new Set(), favorites: [], sort: { mode: "custom", favs: "fixed" } });
  nav.phoneDrawerStore.set({ value: "full" }); store.applyStatus({ instances: rows });
  await p.mount(h(Shell, { panels, onNewInstance() {} })); await settle(3);
});
afterEach(async () => { await p.unmount(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });
const aside = () => p.root.querySelector("#sidebar") as any;
const rowNames = () => [...p.root.querySelectorAll("[data-agent-row]")].map((x: any) => x.getAttribute("data-agent-row"));
async function openMenu() { if (!p.root.querySelector(".nav-sort-phone .nav-sort-menu")) fire(p.root.querySelector(".nav-sort-phone > .nav-sort-btn"), "click"); await settle(3); }
describe("M-3280 guest sidebar uses the shared controls", () => {
  it("uses the phone sidebar layout with filter and Custom, without admin navigation", () => {
    expect(aside().classList.contains("fleet-side")).toBe(true);
    expect(p.root.querySelector("#filterInput")).not.toBeNull();
    expect(p.root.querySelector(".nav-sort-phone > .nav-sort-btn")).not.toBeNull();
    expect(p.root.querySelector('.side-new')).toBeNull();
    expect(p.root.querySelector('a[href="/settings"]')).toBeNull();
    expect(rowNames()).toEqual(["agent-alpha", "agent-beta", "shared-room"]);
  });
  it("allows only the existing guest keys plus the three density/name choices", () => {
    expect([...prefs.GUEST_OWN_PREF_KEYS].sort()).toEqual([...GUEST_OWN_PREF_KEYS].sort());
    for (const k of ["nav.filter", "nav.sort", "nav.density", "nav.densityPhone", "nav.compactName"]) expect(prefs.prefsWritable(k), k).toBe(true);
    for (const k of ["nav.order", "nav.collapsed", "names.primary"]) expect(prefs.prefsWritable(k), k).toBe(false);
  });
  it("filters by either name and never creates a row outside the projected roster", async () => {
    for (const q of ["Beacon", "agent-beta"]) { nav.setNavFilter({ q }); await settle(3); expect(rowNames()).toEqual(["agent-beta"]); }
    nav.setNavFilter({ q: "Hidden helper" }); await settle(3);
    expect(rowNames()).toEqual(["agent-beta"]); // only the granted active row can be pinned
    expect(p.root.textContent).not.toContain("hidden-agent");
    await vi.waitFor(() => expect(values["nav.filter"]).toMatchObject({ q: "Hidden helper" }));
  });
  it("offers the existing exclusive density and compact-name choices in both locales", async () => {
    await openMenu();
    expect([...p.root.querySelectorAll('input[name="nav-sort-density"]')].map((x: any) => x.value)).toEqual(["detailed", "compact"]);
    const labels = () => [...p.root.querySelectorAll('input[name="nav-sort-compact-name"]')].map((x: any) => x.parentNode.textContent);
    expect(labels()).toEqual(["Display name", "Instance name"]);
    lang.setLang("zh-TW", { store: false }); await settle(3); await openMenu();
    expect(labels()).toEqual(["暱稱", "實際名稱"]);
  });
  it("keeps admin navigation layout and preference authority unchanged", async () => {
    p.document.body.dataset.tier = "admin"; p.document.body.dataset.publicLink = "0";
    await p.unmount(); await p.mount(h(Shell, { panels, onNewInstance() {} })); await settle(3);
    expect(aside().classList.contains("fleet-side")).toBe(true);
    expect(prefs.prefsWritable("nav.order")).toBe(true);
    expect(prefs.prefsWritable("nav.compactName")).toBe(true);
  });
});
