/**
 * #1665, the page's side: the host's values applied before paint (theme.js, the dictionary), copied into this browser's
 * cache before any panel reads it, a device's first upload (once, onlyIfUnset) then adopting the host's values, a change
 * sent to the host (never from the public link), and another device's change taken at the next status frame. The real
 * modules in a mini DOM (theme.js in a vm realm, as the page loads it), fetch stubbed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fire, installDom, settle, type MiniPage } from "./helpers/mini-dom.js";

const THEME_JS = readFileSync(join(__dirname, "..", "src", "ui", "shared", "theme.js"), "utf8");
const prefsAttr = (values: Record<string, unknown>, rev = 1) => JSON.stringify({ rev, values });

describe("theme.js: the host's theme before the first paint", () => {
  function load(attr: string | null, cached: string | null) {
    const attrs = new Map<string, string>(attr === null ? [] : [["data-prefs", attr]]);
    const ls = new Map<string, string>(cached === null ? [] : [["agend_theme", cached]]);
    const documentElement = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => { attrs.set(k, v); }, removeAttribute: (k: string) => { attrs.delete(k); } };
    const localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v); }, removeItem: (k: string) => { ls.delete(k); } };
    const window: Record<string, unknown> = {};
    vm.runInNewContext(THEME_JS, { document: { documentElement }, localStorage, window });
    return { theme: attrs.get("data-theme") ?? null, cached: ls.get("agend_theme") ?? null };
  }
  it("the host's value wins over this browser's copy, which it refreshes — applied while the script runs, before paint", () => {
    expect([
      load(prefsAttr({ theme: "dark" }), "light"),
      load(prefsAttr({ theme: "light" }), null),          // a new device: nothing cached, still no flash
      load(prefsAttr({ theme: "system" }), "dark"),
    ]).toEqual([{ theme: "dark", cached: "dark" }, { theme: "light", cached: "light" }, { theme: null, cached: null }]);
  });
  it("no host value (sign-in page, anonymous reader, nothing chosen yet) or an unreadable one: the browser's copy, as before", () => {
    expect([load(null, "light"), load(prefsAttr({}), "dark"), load("{not json", "light"), load(prefsAttr({ theme: "blue" }), "dark")])
      .toEqual([{ theme: "light", cached: "light" }, { theme: "dark", cached: "dark" }, { theme: "light", cached: "light" }, { theme: "dark", cached: "dark" }]);
  });
});

describe("the app's modules", () => {
  let pg: MiniPage;
  let requests: Array<{ method: string; url: string; body: any }>;
  let hostValues: Record<string, unknown>, hostRev: number, failPost: boolean, offline: boolean;
  const realFetch = globalThis.fetch;
  beforeEach(() => { vi.resetModules(); requests = []; hostValues = {}; hostRev = 0; failPost = false; offline = false; });
  afterEach(() => { pg?.restore(); globalThis.fetch = realFetch; delete (globalThis as any).AgendTheme; delete (globalThis as any).AgendPreview; });

  /** A page at load: this browser's storage, and the host's values as the server put them on <html>. */
  async function boot(opts: { storage?: Record<string, string>; host?: Record<string, unknown> | null; rev?: number; publicLink?: boolean }) {
    pg = installDom({ storage: opts.storage ?? {} });
    if (opts.host !== null) {
      hostValues = { ...(opts.host ?? {}) }; hostRev = opts.rev ?? 1;
      pg.document.documentElement.setAttribute("data-prefs", prefsAttr(hostValues, hostRev));
    }
    if (opts.publicLink) pg.document.body.setAttribute("data-public-link", "1");
    globalThis.fetch = (async (url: string, init: any = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ method, url, body });
      if (offline) throw new TypeError("network");
      if (method === "POST") {
        if (failPost) return { ok: false, status: 400, json: async () => ({ error: "nope" }) };
        const changed: string[] = [];
        for (const [k, v] of Object.entries(body.set)) {
          if (body.onlyIfUnset && Object.hasOwn(hostValues, k)) continue;
          if (v === null) delete hostValues[k]; else hostValues[k] = v;
          changed.push(k);
        }
        if (changed.length) hostRev++;
        return { ok: true, status: 200, json: async () => ({ values: { ...hostValues }, rev: hostRev, changed }) };
      }
      return { ok: true, status: 200, json: async () => ({ values: { ...hostValues }, rev: hostRev }) };
    }) as never;
    return await import("/assets/app-prefs.js");
  }
  const ls = (k: string) => pg.storage.get(k) ?? null;
  const posts = () => requests.filter((r) => r.method === "POST").map((r) => r.body);

  it("the dictionary takes the host's language the same way", async () => {
    pg = installDom({ storage: { agend_lang: "en" }, lang: "en" });
    pg.document.documentElement.setAttribute("data-prefs", prefsAttr({ lang: "zh-TW" }));
    const i18n = await import("/assets/app-i18n.js");
    expect([i18n.lang(), ls("agend_lang")]).toEqual(["zh-TW", "zh-TW"]);
  });

  it("on import, the host's values are in this browser's cache before any panel reads its key; other keys untouched", async () => {
    await boot({ storage: { agend_instance_collapsed: '["Old"]', agend_text_size: "l", agend_tour_done: "1" }, host: { "nav.collapsed": ["Ops"], "preview.optIn": true, theme: "dark" } });
    expect([ls("agend_instance_collapsed"), ls("agend_html_preview"), ls("agend_theme"), ls("agend_text_size"), ls("agend_tour_done"), requests.length])
      .toEqual(['["Ops"]', "on", "dark", "l", "1", 0]);
  });

  it("first load on a device: what it had uploads once (onlyIfUnset, key by key), then it adopts the host's values", async () => {
    const m = await boot({ storage: { agend_theme: "dark", agend_lang: "zh-TW", agend_tour_done: "1", agend_html_preview: "on", agend_instance_filter: '{"q":"x","status":[],"cli":[]}' },
      host: { theme: "light" } });
    expect(ls("agend_theme")).toBe("light");   // the host had one: it won at import, and it is not uploaded
    await m.migratePrefs();
    expect(posts()).toEqual([
      { set: { lang: "zh-TW" }, onlyIfUnset: true },
      { set: { "nav.filter": { q: "x", status: [], cli: [] } }, onlyIfUnset: true },
      { set: { "preview.optIn": true }, onlyIfUnset: true },
    ]);                                         // the tour this device has seen stays its own: never uploaded
    expect([hostValues.theme, hostValues.lang, ls("agend_prefs_synced")]).toEqual(["light", "zh-TW", "1"]);
    // Uploaded once: the next run (the next load) sends nothing.
    requests.length = 0;
    expect([await m.migratePrefs(), requests.length]).toEqual([false, 0]);
  });

  it("another device got there first: this one adopts, it does not overwrite", async () => {
    const m = await boot({ storage: { agend_lang: "en" }, host: {} });
    hostValues.lang = "zh-TW"; hostRev = 2;                  // set meanwhile by another device
    await m.migratePrefs();
    expect([posts(), hostValues.lang, ls("agend_lang")]).toEqual([[{ set: { lang: "en" }, onlyIfUnset: true }], "zh-TW", "zh-TW"]);
  });

  it("no answer from the host: the device is not marked, so the next load tries again", async () => {
    const m = await boot({ storage: { agend_lang: "zh-TW" }, host: {} });
    offline = true;
    expect([await m.migratePrefs(), ls("agend_prefs_synced")]).toEqual([false, null]);
  });

  it("a change is cached at once and sent to the host (a burst is one write)", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: {} });
    m.savePref("nav.filter", { q: "a", status: [], cli: [] });
    m.savePref("nav.filter", { q: "ab", status: [], cli: [] });
    m.savePref("theme", "dark");
    expect([ls("agend_instance_filter"), ls("agend_theme"), requests.length]).toEqual(['{"q":"ab","status":[],"cli":[]}', "dark", 0]);
    await new Promise((r) => setTimeout(r, 450));
    expect(posts()).toEqual([{ set: { "nav.filter": { q: "ab", status: [], cli: [] }, theme: "dark" } }]);
  });

  it("a change not sent yet is not undone by another device's revision arriving meanwhile", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light", lang: "en" } });
    m.savePref("theme", "dark");                      // still in the 400 ms burst window
    hostValues = { theme: "light", lang: "zh-TW" }; hostRev = 7;
    await m.refresh();
    expect([ls("agend_theme"), ls("agend_lang")]).toEqual(["dark", "zh-TW"]);
    await new Promise((r) => setTimeout(r, 450));
    expect(posts()).toEqual([{ set: { theme: "dark" } }]);
  });

  it("refused by the host: the page reads the host's value back, rather than show a choice no other device sees", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" } });
    failPost = true;
    m.savePref("theme", "dark");
    expect(ls("agend_theme")).toBe("dark");
    await new Promise((r) => setTimeout(r, 450));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect([ls("agend_theme"), requests.map((r) => r.method)]).toEqual(["light", ["POST", "GET"]]);
  });

  it("the public link writes nothing to the host: no upload, no change sent (the browser keeps its own)", async () => {
    const m = await boot({ storage: { agend_lang: "zh-TW" }, host: {}, publicLink: true });
    await m.migratePrefs();
    m.savePref("theme", "dark");
    await new Promise((r) => setTimeout(r, 450));
    expect([m.prefsWritable(), posts(), ls("agend_theme")]).toEqual([false, [], "dark"]);
  });

  it("the anonymous reader (no host values on the page): nothing is read or sent", async () => {
    const m = await boot({ storage: {}, host: null });
    await m.migratePrefs();
    m.savePref("theme", "dark");
    await new Promise((r) => setTimeout(r, 450));
    expect([m.prefsWritable(), requests.length]).toEqual([false, 0]);
  });

  it("the sidebar: its filter, folds and drag order are sent as nav.*; another device's arrangement is taken at once", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { "nav.collapsed": ["Ops"] }, rev: 2 });
    const nav = await import("/assets/instance-nav.js");
    expect([...nav.navStore.get().collapsed]).toEqual(["Ops"]);   // the host's, read when the list was made
    nav.setNavFilter({ q: "rev" });
    await new Promise((r) => setTimeout(r, 450));
    expect(posts()).toEqual([{ set: { "nav.filter": { q: "rev", status: [], cli: [] } } }]);
    hostValues = { ...hostValues, "nav.collapsed": ["Ops", "Web"] }; hostRev = 9;
    await m.refresh();
    expect([...nav.navStore.get().collapsed]).toEqual(["Ops", "Web"]);
  });

  it("every place a synced choice is made sends it: theme and language (Preferences), previews — the tour and the first-run card stay on the device", async () => {
    const themes: string[] = [];
    (globalThis as any).AgendTheme = { get: () => "system", set: (v: string) => themes.push(v) };
    await boot({ storage: { agend_prefs_synced: "1" }, host: {} });
    const { h, render } = await import("/assets/app-html.js");
    const { DevicePrefs } = await import("/assets/app-shell.js");
    const root = pg.document.createElement("div"); pg.document.body.appendChild(root);
    render(h(DevicePrefs, { labels: true }), root); await settle();
    const theme = root.querySelector('select[aria-label="Theme"]') as any, language = root.querySelector('select[aria-label="Language"]') as any;
    theme.value = "dark"; fire(theme, "change"); language.value = "zh-TW"; fire(language, "change"); await settle();
    // @ts-expect-error — a JS module of the app, with no types
    const chat = await import("../src/ui/panel-chat.js");      // brings the real preview.js
    const { confirmStore, answerConfirm } = await import("/assets/ui-confirm.js");
    const allowing = chat.setPreviewOptIn(true);
    await settle();
    answerConfirm(confirmStore.get().queue[0].id, true);         // the app's question, answered Allow
    await allowing;
    // @ts-expect-error — a JS module of the app, with no types
    (await import("../src/ui/chat-tour.js")).endTour();
    // @ts-expect-error — a JS module of the app, with no types
    (await import("../src/ui/first-run.js")).dismissFirstRun();
    await new Promise((r) => setTimeout(r, 450));
    expect([themes, posts(), ls("agend_tour_done"), ls("agend_firstrun_dismissed")])
      .toEqual([["dark"], [{ set: { theme: "dark", lang: "zh-TW", "preview.optIn": true } }], "1", "1"]);
    render(null, root);
  });

  it("another device's change: the next status frame's prefs_rev re-reads the host and applies it here", async () => {
    const theme = vi.fn();
    (globalThis as any).AgendTheme = { set: theme, get: () => "system" };
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" }, rev: 4 });
    const store = await import("/assets/app-store.js");
    const seen: string[][] = [];
    m.onPrefsChanged((keys: Set<string>) => seen.push([...keys]));
    m.bootPrefs();
    store.applyStatus({ instances: [], prefs_rev: 4 });     // the revision this page already has: nothing read
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(requests.length).toBe(0);
    hostValues = { theme: "dark", "nav.collapsed": ["Ops"] }; hostRev = 5;
    store.applyStatus({ instances: [], prefs_rev: 5 });
    store.applyStatus({ instances: [], prefs_rev: 5 });     // the same revision again: read once
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect([requests.map((r) => r.method), ls("agend_theme"), ls("agend_instance_collapsed"), theme.mock.calls, seen])
      .toEqual([["GET"], "dark", '["Ops"]', [["dark"]], [["theme", "nav.collapsed"]]]);
  });
});
