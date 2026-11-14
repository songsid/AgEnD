import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { parseWebPrefsPatch } from "../src/web-prefs.js";

let releasePrefs: () => void;
let hostValues: Record<string, unknown> = {}, rev = 1;
let p: AppPage, nav: any, shell: any, prefs: any, i18n: any;
const items = [
  { name: "alpha", display_name: "Alpha", backend: "codex", status: "running", teams: ["Dev"], avatar: { kind: "emoji", text: "🛡️" }, context_pct: 48, last_reply: new Date(Date.now() - 180000).toISOString() },
  { name: "beta", display_name: "Beta", backend: "claude-code", status: "running", teams: ["Dev"], context_pct: 22, last_reply: new Date(Date.now() - 600000).toISOString() },
];
function Preview() { return h("div", {}, h(shell.DevicePrefs, { labels: true, fields: ["density"] }), h(nav.InstanceNav, { route: { panel: "chat", instance: "alpha" }, items, exec: { alpha: "working" }, awaiting: { beta: "Please approve" } })); }
const row = (name: string) => p.root.querySelector(`[data-agent-row="${name}"] a.inst`) as any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/settings/preferences", storage: { agend_lang: "en" } });
  p.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any = {}) => { if (init.body) { Object.assign(hostValues, JSON.parse(init.body).set); rev++; } return { ok: true, json: async () => ({ rev, values: { ...hostValues } }) }; }));
  nav = await import("/assets/instance-nav.js"); shell = await import("/assets/app-shell.js"); prefs = await import("/assets/app-prefs.js"); i18n = await import("/assets/app-i18n.js");
});
beforeEach(async () => {
  i18n.setLang("en", { store: false });
  nav.navStore.set({ filter: { q: "", status: [], cli: [] }, collapsed: new Set(), favorites: [], sort: { mode: "custom", favs: "fixed" } });
  releasePrefs = prefs.holdPrefs(); nav.setSidebarDensity?.("detailed");
});
afterEach(async () => { prefs.discardHeldPrefs(); releasePrefs(); await p.unmount(); });
afterAll(() => { p.restore(); vi.unstubAllGlobals(); });

describe("M-3129 sidebar density", () => {
  it("validates both stored choices and rejects other shapes", () => {
    for (const value of ["detailed", "compact", null]) expect(parseWebPrefsPatch({ "nav.density": value }).ok).toBe(true);
    for (const value of [true, "small", {}, ["compact"]]) expect(parseWebPrefsPatch({ "nav.density": value }).ok).toBe(false);
  });
  it("defaults to detailed and switches the live list through the actual Settings control", async () => {
    await p.mount(h(Preview));
    const select = p.root.querySelector("#pref-density") as any;
    expect(select).not.toBeNull(); expect(select.value).toBe("detailed");
    expect(row("alpha").querySelector(".av")).not.toBeNull(); expect(row("alpha").textContent).toContain("48%");
    select.value = "compact"; fire(select, "change"); await settle(4);
    expect(p.root.querySelector(".inst-nav.compact")).not.toBeNull();
    expect(row("alpha").querySelector(".av")).toBeNull(); expect(row("alpha").querySelector(".dot.busy")).not.toBeNull();
    expect(row("alpha").querySelector(".dot").getAttribute("aria-label")).toBe("working");
    expect(row("alpha").querySelector(".inst-when").textContent).toContain("3");
    expect(row("alpha").querySelector(".v-meta,.inst-alt,.inst-sub")).toBeNull();
    expect(row("alpha").getAttribute("title")).toContain("48%");
    expect(row("beta").querySelector(".badge-await")).toBeNull();
    expect(p.root.querySelector(".v-filter")).not.toBeNull(); expect(p.root.textContent).toContain("Dev");
    select.value = "detailed"; fire(select, "change"); await settle(3);
    expect(row("alpha").querySelector(".av")).not.toBeNull(); expect(row("beta").querySelector(".badge-await")).not.toBeNull();
  });
  it("uses the existing held Save/discard lifecycle and bilingual labels", async () => {
    const release = prefs.holdPrefs();
    try {
      await p.mount(h(Preview)); nav.setSidebarDensity("compact"); await settle(3);
      expect(prefs.heldPrefsCount()).toBeGreaterThan(0);
      prefs.discardHeldPrefs(); await settle(3); expect(nav.sidebarDensityStore.get().value).toBe("detailed");
      i18n.setLang("zh-TW", { store: false }); await p.mount(h(Preview));
      expect(p.root.querySelector("#pref-density").textContent).toBe("詳細精簡");
    } finally { release(); }
  });
  it("saves the choice and follows another device's update without losing the list", async () => {
    await p.mount(h(Preview)); nav.setSidebarDensity("compact"); await prefs.savePrefsHeld(); await settle(3);
    expect(hostValues["nav.density"]).toBe("compact");
    expect(p.root.querySelector(".inst-nav.compact")).not.toBeNull();
    hostValues["nav.density"] = "detailed"; rev++; await prefs.refresh(); await settle(3);
    expect(p.root.querySelector(".inst-nav.compact")).toBeNull(); expect(row("alpha").querySelector(".av")).not.toBeNull();
  });
  it("keeps filtering, favorites, sorting, folding and native keyboard links on compact rows", async () => {
    nav.setSidebarDensity("compact"); await p.mount(h(Preview));
    const link = row("alpha"); expect(link.tagName.toLowerCase()).toBe("a"); expect(link.getAttribute("href")).toBe("/ui/chat/alpha"); expect(link.getAttribute("aria-current")).toBe("page");
    fire(link, "click", { ctrlKey: true, button: 0 }); expect(link.getAttribute("href")).toBe("/ui/chat/alpha");
    nav.navStore.set({ favorites: ["beta"] }); await settle(3); expect(p.root.querySelector('.v-fav [data-agent-row="beta"]')).not.toBeNull();
    nav.setNavFilter({ q: "Alpha" }); await settle(3); expect(row("alpha")).not.toBeNull(); expect(row("beta")).toBeNull();
    nav.setNavFilter({ q: "" }); nav.navStore.set({ favorites: [], sort: { mode: "recent", favs: "fixed" } }); await settle(3);
    expect([...p.root.querySelectorAll(".v-li")].map((r: any) => r.getAttribute("data-agent-row"))).toEqual(["alpha", "beta"]);
    nav.navStore.set({ sort: { mode: "custom", favs: "fixed" }, collapsed: new Set([nav.TEAM_GROUP + "Dev"]) }); await settle(3);
    expect(row("alpha")).toBeNull(); expect(p.root.querySelector('.v-group-head[aria-expanded="false"]')).not.toBeNull();
  });
});
