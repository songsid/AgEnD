import { afterEach, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
let pg: AppPage | null = null;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); if (pg) { await pg.unmount(); pg.restore(); pg = null; } });
async function fixture({ publicLink = true, guest = false, hostShow = true, storage = {}, safe = false } = {}) {
  vi.resetModules(); pg = page({ url: `http://localhost/ui/chat/own${safe ? "?safe=1" : ""}`, storage });
  pg.document.body.dataset.publicLink = publicLink ? "1" : "0";if(guest)pg.document.body.dataset.tier="guest";
  pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: { "fx.show": hostShow } }));
  const fetch = vi.spyOn(globalThis, "fetch"), module = await import("/assets/app-themes.js");
  return { ...module, fetch };
}
describe("#1629 public theme/effect switch is this browser's choice", () => {
  it.each([true, false])("host default %s does not override an explicit local off/on, including after a reload", async hostShow => {
    const m = await fixture({ hostShow }); expect(m.themesShown()).toBe(hostShow);
    const observed: boolean[] = [], off = m.themesStore.subscribe((s: any) => observed.push(s.shown));
    m.setThemesShown(false); expect(m.themesShown()).toBe(false); expect(m.themesStore.get().shown).toBe(false); expect(localStorage.getItem("agend_public_fx_show")).toBe("off");
    vi.resetModules(); const reload = await import("/assets/app-themes.js"); expect(reload.themesShown()).toBe(false);
    reload.setThemesShown(true); expect(reload.themesShown()).toBe(true); expect(localStorage.getItem("agend_public_fx_show")).toBe("on");
    expect(JSON.parse(pg!.document.documentElement.getAttribute("data-prefs")!).values["fx.show"]).toBe(hostShow); expect(m.fetch).not.toHaveBeenCalled(); expect(observed).toEqual([false]); off();
  });
  it.each([true,false])("a guest switch stays browser-local, survives reload, and cannot modify host default %s",async hostShow=>{
    const m=await fixture({publicLink:false,guest:true,hostShow});m.setThemesShown(false);expect(m.themesShown()).toBe(false);
    vi.resetModules();const again=await import("/assets/app-themes.js");expect(again.themesShown()).toBe(false);again.setThemesShown(true);expect(again.themesShown()).toBe(true);
    expect(m.fetch).not.toHaveBeenCalled();expect(JSON.parse(pg!.document.documentElement.getAttribute("data-prefs")!).values["fx.show"]).toBe(hostShow);
  });
  it("a public override never shadows local signed-in host choices", async () => {
    const m = await fixture({ publicLink: false, storage: { agend_public_fx_show: "off" } }); expect(m.themesShown()).toBe(true);
  });
  it("a refreshed host default cannot override the public viewer's explicit choice", async () => {
    const m = await fixture(), prefs = await import("/assets/app-prefs.js");
    m.setThemesShown(false); m.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rev: 2, values: { "fx.show": false } }) } as any);
    expect(await prefs.refresh()).toBe(true); expect(m.themesShown()).toBe(false);
    m.setThemesShown(true); m.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ rev: 3, values: { "fx.show": false } }) } as any);
    expect(await prefs.refresh()).toBe(true); expect(m.themesShown()).toBe(true);
    expect(m.fetch.mock.calls.every((call: any[]) => !call[1]?.method || call[1].method === "GET")).toBe(true);
  });
  it("safe mode wins over a stored public on", async () => {
    const m = await fixture({ safe: true, storage: { agend_public_fx_show: "on" } }); expect(m.themesShown()).toBe(false); m.setThemesShown(true); expect(m.themesShown()).toBe(false); expect(m.fetch).not.toHaveBeenCalled();
  });
  it("storage failure cannot undo the current page's explicit choice or create a host write", async () => {
    const m = await fixture(); vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw Error("quota"); });
    m.setThemesShown(false); expect(m.themesShown()).toBe(false); m.setThemesShown(true); expect(m.themesShown()).toBe(true); expect(m.fetch).not.toHaveBeenCalled();
  });
});
