import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { parseWebPrefsPatch } from "../src/web-prefs.js";

let p: AppPage, nav: any, shell: any, prefs: any, i18n: any, release: () => void;
let host: Record<string, unknown> = {}, rev = 1;
const items = [
  { name: "agent-alpha", display_name: "Atlas", backend: "codex", status: "running" },
  { name: "agent-beta", backend: "claude-code", status: "running" },
  { name: "agent-native", display_name: "Beacon", runtime: "windows", backend: "codex", status: "running" },
];
function Preview() { return h("div", {}, h(shell.DevicePrefs, { labels: true, fields: ["density", "compactName"] }), h(nav.InstanceNav, { route: { panel: "chat", instance: "agent-alpha" }, items })); }
const row = (name = "agent-alpha") => p.root.querySelector(`[data-agent-row="${name}"] a.inst`) as any;
const label = (name?: string) => row(name)?.querySelector(".inst-name")?.textContent;
const control = () => p.root.querySelector("#pref-compact-name") as any;
const radios = () => [...p.root.querySelectorAll('input[name="nav-sort-compact-name"]')] as any[];
async function menu() { fire(p.root.querySelector(".nav-sort-btn"), "click"); await settle(2); }
async function select(value: string) { const input = [...control().querySelectorAll("input")].find((r: any) => r.value === value); fire(input, "change"); await settle(3); }

beforeAll(async () => {
  p = page({ storage: { agend_lang: "en" } });
  p.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev, values: {} }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any = {}) => {
    if (init.body) { Object.assign(host, JSON.parse(init.body).set); rev++; }
    return { ok: true, json: async () => ({ rev, values: { ...host } }) };
  }));
  nav = await import("/assets/instance-nav.js"); shell = await import("/assets/app-shell.js");
  prefs = await import("/assets/app-prefs.js"); i18n = await import("/assets/app-i18n.js");
});
beforeEach(async () => {
  host = {}; rev++; await prefs.refresh(); release = prefs.holdPrefs();
  i18n.setLang("en", { store: false });
  nav.navStore.set({ filter: { q: "", status: [], cli: [] }, collapsed: new Set(), favorites: [], sort: { mode: "custom", favs: "fixed" } });
  nav.setSidebarDensity("compact"); await p.mount(h(Preview));
});
afterEach(async () => { prefs.discardHeldPrefs(); release(); await p.unmount(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });

describe("M-3269 compact rows show exactly one chosen name", () => {
  it("offers exactly two exclusive choices beside density, in Customize and This device", async () => {
    expect(control(), "This device has the compact name control").not.toBeNull();
    expect(control().textContent).toBe("Display nameInstance name");
    await menu(); expect(radios().map(r => r.value)).toEqual(["nickname", "instance"]);
    expect(radios().filter(r => r.checked).map(r => r.value)).toEqual(["nickname"]);
  });
  it("preserves the existing leading-name preference until an explicit compact choice", async () => {
    expect(label()).toBe("Atlas"); nav.setNamesPrimary("instance"); await settle(3);
    expect(label()).toBe("agent-alpha"); expect(label("agent-native")).toBe("Beacon");
    await select("nickname"); nav.setNamesPrimary("instance"); await settle(3); expect(label()).toBe("Atlas");
  });
  it("changes only compact labels, including native agents; missing display names fall back", async () => {
    await select("instance");
    expect([label(), label("agent-beta"), label("agent-native")]).toEqual(["agent-alpha", "agent-beta", "agent-native"]);
    expect(row().querySelector(".inst-alt")).toBeNull();
    nav.setSidebarDensity("detailed"); await settle(3); expect(label()).toBe("Atlas");
    nav.setSidebarDensity("compact"); await settle(3); expect(label()).toBe("agent-alpha");
  });
  it("keeps both names in the tooltip and accessible name and searches either", async () => {
    await select("instance");
    expect(row().getAttribute("title")).toContain("Atlas");
    expect(row().getAttribute("title")).toContain("agent-alpha");
    expect(row().getAttribute("aria-label")).toContain("Atlas");
    expect(row().getAttribute("aria-label")).toContain("agent-alpha");
    for (const q of ["Atlas", "agent-alpha"]) { nav.setNavFilter({ q }); await settle(3); expect(label()).toBe("agent-alpha"); expect(row("agent-beta")).toBeNull(); }
    nav.setNavFilter({ q: "" }); await select("nickname");
    expect(row().getAttribute("aria-label")).toContain("agent-alpha");
  });
  it("shares one synced choice and follows host changes without changing density", async () => {
    await menu(); fire(radios().find(r => r.value === "instance"), "change"); await prefs.savePrefsHeld(); await settle(3);
    expect(host["nav.compactName"]).toBe("instance"); expect([...control().querySelectorAll("input")].find((r: any) => r.value === "instance").checked).toBe(true);
    host["nav.compactName"] = "nickname"; rev++; await prefs.refresh(); await settle(3);
    expect(label()).toBe("Atlas"); expect(radios().find(r => r.value === "nickname").checked).toBe(true);
    expect(nav.sidebarDensityStore.get().value).toBe("compact");
  });
  it("holds, saves and discards the choice with the other Settings preferences", async () => {
    await select("instance"); expect(host["nav.compactName"]).toBeUndefined(); expect(prefs.heldPrefsCount()).toBeGreaterThan(0);
    prefs.discardHeldPrefs(); await settle(3); expect(label()).toBe("Atlas");
    expect(prefs.HELD_KEYS.has("nav.compactName")).toBe(true);
    for (const v of ["nickname", "instance"]) expect(prefs.SYNCED["nav.compactName"].fromLocal(prefs.SYNCED["nav.compactName"].toLocal(v))).toBe(v);
  });
  it("validates the new key without widening accepted values", () => {
    for (const v of ["nickname", "instance", null]) expect(parseWebPrefsPatch({ "nav.compactName": v }).ok).toBe(true);
    for (const v of ["both", "", true, {}, ["instance"]]) expect(parseWebPrefsPatch({ "nav.compactName": v }).ok).toBe(false);
  });
  it("labels the single choice in Traditional Chinese", async () => {
    i18n.setLang("zh-TW", { store: false }); await settle(3); await menu();
    expect(control().getAttribute("aria-label")).toBe("精簡列名稱");
    expect(control().textContent).toBe("暱稱instance 名稱");
    expect(radios().map(r => r.parentNode.textContent)).toEqual(["暱稱", "instance 名稱"]);
  });
});
