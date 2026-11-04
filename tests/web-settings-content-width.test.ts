/** This device's Settings width: real Shell/SettingsPanel, isolated DOM/storage and inert network effects. */
import { afterEach, describe, expect, it } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";

const g = globalThis as any;
const realFetch = g.fetch;
const schema = buildSettingsImpactSchema();
let pg: AppPage | null = null;
let writes: string[] = [];
let restoreStorage: (() => void) | null = null;

async function close() {
  if (pg) { await pg.unmount(); restoreStorage?.(); restoreStorage = null; pg.restore(); pg = null; }
}
afterEach(async () => { await close(); g.fetch = realFetch; });

async function boot(storage: Record<string, string> = {}) {
  writes = [];
  pg = page({ url: "http://127.0.0.1:19280/settings/look", storage: { agend_tour_done: "1", agend_prefs_synced: "1", ...storage } });
  pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
  pg.document.body.dataset.mode = "full";
  g.fetch = async (path: string, init: any = {}) => {
    if (init.method && init.method !== "GET") writes.push(`${init.method} ${path}`);
    const value = path === "/api/settings/schema" ? schema
      : path === "/api/settings/fleet/raw" ? { defaults: {}, instances: {}, channels: [], web: {} }
      : path === "/api/settings/classic" ? { channels: {}, defaults: {} }
      : path === "/api/fleet" ? { version: "2.3.5-alpha", instances: [] }
      : path === "/ui/profile" ? { name: "", shown: "web-user", id: "test", bound: false }
      : path === "/ui/prefs" ? { values: {}, rev: 1 }
      : path === "/ui/mods" ? { mods: [], proposals: [] }
      : path === "/ui/owner-css/state" ? { active: null, pending: null, text: "", versions: [], assets: [], limits: { maxAssets: 16 } }
      : {};
    return { ok: true, status: 200, json: async () => value };
  };
  const shell = await import("/assets/app-shell.js");
  const nav = await import("/assets/app-nav.js");
  const { appStore } = await import("/assets/app-store.js");
  const { setLang } = await import("/assets/app-i18n.js");
  const { SettingsPanel } = await import("/ui/js/panel-settings.js");
  setLang("en", { store: false });
  nav.startRouter(pg.window);
  appStore.set({ ready: true, instances: [], needs: [], startup: null, connections: 0 });
  await pg.mount(h(shell.Shell, { panels: new Map([["settings", { Component: SettingsPanel }]]), onNewInstance() {} }));
  await settle(12);
  return shell;
}
const cssWidth = () => (pg!.document.documentElement.style as any)["--settings-width"];
const choice = () => pg!.root.querySelector("#settings-content-width") as any;
async function choose(width: number) { choice().value = String(width); fire(choice(), "change"); await settle(6); }

describe("Settings content width belongs to this device", () => {
  it("applies through the real Shell, saves immediately without dirty/POST, and restores on a fresh page", async () => {
    const shell = await boot();
    expect([cssWidth(), Number(choice().value)]).toEqual(["1200px", 1200]);
    await choose(1440);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect([cssWidth(), pg!.storage.get(shell.SETTINGS_CONTENT_WIDTH_KEY), !!pg!.root.querySelector(".s-pending"), writes])
      .toEqual(["1440px", "1440", false, []]);
    const saved = Object.fromEntries(pg!.storage);
    await close();
    await boot(saved);
    expect([cssWidth(), Number(choice().value), !!pg!.root.querySelector(".s-pending")]).toEqual(["1440px", 1440, false]);
  });

  it("treats unsupported stored widths as the default and rejects unsupported setter values", async () => {
    const shell = await boot({ agend_settings_content_width: "2000" });
    expect([cssWidth(), Number(choice().value)]).toEqual(["1200px", 1200]);
    for (const width of [0, -1, 1201, Infinity, NaN, "1440"] as any[]) shell.setSettingsContentWidth(width);
    expect([cssWidth(), pg!.storage.get(shell.SETTINGS_CONTENT_WIDTH_KEY), shell.settingsContentWidthStore.get().width])
      .toEqual(["1200px", "2000", 1200]);
    await choose(1000);
    expect([cssWidth(), pg!.storage.get(shell.SETTINGS_CONTENT_WIDTH_KEY)]).toEqual(["1000px", "1000"]);
  });

  it("falls back when storage operations throw while keeping a new choice usable for this page", async () => {
    const shell = await boot();
    const old = g.localStorage;
    g.localStorage = { getItem() { throw new Error("blocked read"); }, setItem() { throw new Error("quota"); } };
    restoreStorage = () => { g.localStorage = old; };
    shell.initSettingsContentWidth();
    expect(cssWidth()).toBe("1200px");
    await choose(1000);
    expect([cssWidth(), Number(choice().value), shell.settingsContentWidthStore.get().width, !!pg!.root.querySelector(".s-pending"), writes])
      .toEqual(["1000px", 1000, 1000, false, []]);
    shell.initSettingsContentWidth(); // A new page cannot recover an unpersisted choice.
    expect(cssWidth()).toBe("1200px");
  });

  it("also handles browsers that throw when obtaining localStorage itself", async () => {
    const shell = await boot();
    const descriptor = Object.getOwnPropertyDescriptor(g, "localStorage")!;
    Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new Error("storage disabled"); } });
    restoreStorage = () => Object.defineProperty(g, "localStorage", descriptor);
    expect(() => shell.initSettingsContentWidth()).not.toThrow();
    await choose(1440);
    expect([cssWidth(), Number(choice().value), !!pg!.root.querySelector(".s-pending"), writes]).toEqual(["1440px", 1440, false, []]);
  });
});
