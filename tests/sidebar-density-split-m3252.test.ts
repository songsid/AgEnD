/**
 * M-3252 (the user, 11-16): the agent list's 詳細 / 精簡 is kept apart for the phone's drawer and the desktop's sidebar —
 * changing one changed the other, because both were one synced preference (nav.density, M-3129). nav.density stays the
 * desktop sidebar's; nav.densityPhone is the drawer's (a window under 900 px). The user's defaults: the desktop 精簡
 * (compact), the phone 詳細 (detailed); the split keeps a value already chosen as the desktop's, and the phone starts at
 * 詳細 until one is chosen there. The list's ⋯ (自訂) and Settings → This device show and change the layout's own. The
 * host's validator takes both.
 * Here: the real modules in the mini DOM (a window under 900 px is matchMedia's max-width), the host a scripted fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { parseWebPrefsPatch } from "../src/web-prefs.js";

const hostValues: Record<string, unknown> = { "nav.density": "compact" };
let rev = 1;
const writes: Array<Record<string, unknown>> = [];
let nav: any, shell: any, prefs: any, i18n: any;
const items = [{ name: "alpha", display_name: "Alpha", backend: "codex", status: "running", context_pct: 48 }];
function Preview() { return h("div", {}, h(shell.DevicePrefs, { labels: true, fields: ["density"] }), h(nav.InstanceNav, { route: { panel: "chat", instance: "alpha" }, items, exec: {}, awaiting: {} })); }
/** A page at a layout: a phone (the drawer, under 900 px) or a desktop. */
async function at(layout: "phone" | "desk"): Promise<AppPage> {
  const p = page({ url: "http://127.0.0.1:19280/settings/preferences", storage: { agend_lang: "en" }, matchNarrow: layout === "phone" });
  nav.refreshDensity(); await p.mount(h(Preview)); await settle(3);
  return p;
}
const compact = (p: AppPage) => !!p.root.querySelector(".inst-nav.compact");
const select = (p: AppPage) => p.root.querySelector("#pref-density") as any;
const menu = (p: AppPage) => p.root.querySelector(".nav-sort-menu") as any;
const radio = (p: AppPage, value: string) => [...menu(p).querySelectorAll("input")].find((i: any) => (i.name ?? i.getAttribute("name")) === "nav-sort-density" && (i.value ?? i.getAttribute("value")) === value) as any;
async function done(p: AppPage) { await p.unmount(); p.restore(); }
async function flush() { await new Promise((r) => setTimeout(r, 450)); await settle(4); }
async function hostChanged() { rev++; await prefs.refresh(); await settle(3); }

beforeAll(async () => {
  const p0 = page({ storage: { agend_lang: "en" } });
  // Today's value on the host, from before the split: the one shared value, 精簡 — on the phone and the desktop alike.
  p0.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: { ...hostValues } }));
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any = {}) => {
    if (init.body) { const set = JSON.parse(init.body).set; writes.push(set); Object.assign(hostValues, set); rev++; }
    return { ok: true, json: async () => ({ rev, values: { ...hostValues } }) };
  }));
  nav = await import("/assets/instance-nav.js"); shell = await import("/assets/app-shell.js"); prefs = await import("/assets/app-prefs.js"); i18n = await import("/assets/app-i18n.js");
  i18n.setLang("en", { store: false });
  p0.restore();
});
afterAll(() => vi.unstubAllGlobals());

describe("M-3252: the phone drawer and the desktop sidebar keep their own density", () => {
  it("the host takes nav.densityPhone as it takes nav.density", () => {
    for (const value of ["detailed", "compact", null]) expect(parseWebPrefsPatch({ "nav.densityPhone": value }).ok).toBe(true);
    for (const value of [true, "small", {}, ["compact"]]) expect(parseWebPrefsPatch({ "nav.densityPhone": value }).ok).toBe(false);
  });

  it("the split: today's chosen value is the desktop's; the phone starts at 詳細 (a shared 精簡 does not carry over)", async () => {
    for (const layout of ["desk", "phone"] as const) {
      const p = await at(layout);
      expect([layout, compact(p), select(p).value, nav.sidebarDensityStore.get().layout])
        .toEqual(layout === "desk" ? ["desk", true, "compact", "desk"] : ["phone", false, "detailed", "phone"]);
      await done(p);
    }
    // A desktop where 詳細 was chosen keeps it; one where nothing was chosen gets the new default, 精簡.
    hostValues["nav.density"] = "detailed"; await hostChanged();
    let p = await at("desk"); expect(select(p).value).toBe("detailed"); await done(p);
    delete hostValues["nav.density"]; await hostChanged();
    p = await at("desk"); expect([select(p).value, compact(p)]).toEqual(["compact", true]); await done(p);
    p = await at("phone"); expect([select(p).value, compact(p)]).toEqual(["detailed", false]); await done(p);
  });

  it("each layout writes only its own: the desktop's Settings change, the phone's ⋯ (自訂) change", async () => {
    writes.length = 0;
    let p = await at("desk");
    select(p).value = "detailed"; fire(select(p), "change"); await flush();
    expect(compact(p), "the desktop list follows its own choice").toBe(false);
    expect(writes.flatMap((w) => Object.entries(w))).toEqual([["nav.density", "detailed"]]);
    await done(p);
    p = await at("phone");
    expect([compact(p), select(p).value], "the phone: its own default").toEqual([false, "detailed"]);
    fire(p.root.querySelector(".nav-sort-btn"), "click"); await settle(2);
    expect(radio(p, "detailed").checked).toBe(true);
    fire(radio(p, "compact"), "change"); await flush();
    expect([compact(p), hostValues["nav.densityPhone"], hostValues["nav.density"]], "the phone's change: the desktop's untouched").toEqual([true, "compact", "detailed"]);
    await done(p);
    p = await at("desk");
    expect([compact(p), select(p).value], "back on the desktop: its own").toEqual([false, "detailed"]);
    await done(p);
  });

  it("another device's change arrives for its own layout only", async () => {
    let p = await at("desk");
    hostValues["nav.densityPhone"] = "detailed"; await hostChanged();
    expect(compact(p), "a phone's change does not move the desktop's list").toBe(false);
    hostValues["nav.density"] = "compact"; await hostChanged();
    expect(compact(p), "a desktop's does").toBe(true);
    await done(p);
    p = await at("phone");
    expect([compact(p), select(p).value]).toEqual([false, "detailed"]);
    await done(p);
  });

  it("Settings' Save/discard covers both (held keys); both values are cached (a choice is not the default)", () => {
    expect([prefs.HELD_KEYS.has("nav.density"), prefs.HELD_KEYS.has("nav.densityPhone")]).toEqual([true, true]);
    for (const key of ["nav.density", "nav.densityPhone"]) expect([prefs.SYNCED[key].toLocal("detailed"), prefs.SYNCED[key].toLocal("compact")]).toEqual(["detailed", "compact"]);
  });
});
