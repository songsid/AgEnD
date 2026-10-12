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
  function load(attr: string | null, cached: string | null, opts: { inStep?: boolean; full?: boolean } = {}) {
    const attrs = new Map<string, string>(attr === null ? [] : [["data-prefs", attr]]);
    const ls = new Map<string, string>([...(cached === null ? [] : [["agend_theme", cached]]), ...(opts.inStep ? [["agend_prefs_synced", "1"]] : [])] as Array<[string, string]>);
    const documentElement = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => { attrs.set(k, v); }, removeAttribute: (k: string) => { attrs.delete(k); } };
    // `full`: a storage that refuses every write (QuotaExceededError) — the copy is best effort, the paint is not.
    const quota = () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); };
    const localStorage = { getItem: (k: string) => ls.get(k) ?? null, setItem: opts.full ? quota : (k: string, v: string) => { ls.set(k, v); }, removeItem: opts.full ? quota : (k: string) => { ls.delete(k); } };
    const window: Record<string, any> = {};
    vm.runInNewContext(THEME_JS, { document: { documentElement }, localStorage, window });
    return { theme: attrs.get("data-theme") ?? null, cached: ls.get("agend_theme") ?? null, current: window.AgendTheme.get() };
  }
  it("the host's value wins over this browser's copy, which it refreshes — applied while the script runs, before paint", () => {
    expect([
      load(prefsAttr({ theme: "dark" }), "light"),
      load(prefsAttr({ theme: "light" }), null),          // a new device: nothing cached, still no flash
      load(prefsAttr({ theme: "system" }), "dark"),
    ]).toEqual([{ theme: "dark", cached: "dark", current: "dark" }, { theme: "light", cached: "light", current: "light" }, { theme: null, cached: null, current: "system" }]);
  });
  it("#1669 r1 P2-7: storage that refuses the copy still paints the host's theme (and holds it as the choice)", () => {
    expect(load(prefsAttr({ theme: "dark" }), "light", { full: true })).toEqual({ theme: "dark", cached: "light", current: "dark" });
  });
  it("#1669 r1 P2-4: in step with the host and none chosen there: the default, the stale copy cleared; not in step: its own", () => {
    expect([load(prefsAttr({}), "dark", { inStep: true }), load(prefsAttr({}), "dark")])
      .toEqual([{ theme: null, cached: null, current: "system" }, { theme: "dark", cached: "dark", current: "dark" }]);
  });
  it("no host value (sign-in page, anonymous reader, nothing chosen yet) or an unreadable one: the browser's copy, as before", () => {
    expect([load(null, "light"), load(prefsAttr({}), "dark"), load("{not json", "light"), load(prefsAttr({ theme: "blue" }), "dark")])
      .toEqual([{ theme: "light", cached: "light", current: "light" }, { theme: "dark", cached: "dark", current: "dark" }, { theme: "light", cached: "light", current: "light" }, { theme: "dark", cached: "dark", current: "dark" }]);
  });
});

describe("the app's modules", () => {
  let pg: MiniPage;
  let requests: Array<{ method: string; url: string; body: any }>;
  let hostValues: Record<string, unknown>, hostRev: number, failPost: boolean, offline: boolean;
  /** A test's own answer for a request (a held one, a server error); undefined: the fake host answers. */
  let intercept: ((method: string, body: any) => Promise<any> | undefined) | null = null;
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  /** A request held until the test lets it answer. */
  const held = () => { let release!: (r: unknown) => void; const p = new Promise((r) => { release = r; }); return { p, release }; };
  const realFetch = globalThis.fetch;
  beforeEach(() => { vi.resetModules(); requests = []; hostValues = {}; hostRev = 0; failPost = false; offline = false; intercept = null; });
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
      const own = intercept?.(method, body);
      if (own) return own;
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

  // ── #1669 review r1 ──
  const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
  it("P2-2 ①: a read answered while this page's write is still out does not undo it, nor does the write's own answer", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" }, rev: 1 });
    const write = held();
    intercept = (method) => (method === "POST" ? write.p as Promise<any> : undefined);
    m.savePref("theme", "dark");
    await new Promise((r) => setTimeout(r, 450));          // the write is out, unanswered
    hostRev = 2;                                           // the host as it was before it: light, a newer revision
    expect(await m.refresh()).toBe(true);
    expect([ls("agend_theme"), m.hostPref("theme")]).toEqual(["dark", "light"]);
    write.release(reply(200, { values: { theme: "dark" }, rev: 3 }));
    await ticks();
    expect([ls("agend_theme"), m.hostPref("theme")]).toEqual(["dark", "dark"]);
  });
  it("r2: another device's newer value, held back while this page's write was out, is shown once that write ends — even if its answer is older", async () => {
    const theme = vi.fn();
    (globalThis as any).AgendTheme = { set: theme, get: () => "light" };
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" }, rev: 1 });
    const write = held();
    intercept = (method) => (method === "POST" ? write.p as Promise<any> : undefined);
    m.savePref("theme", "dark");
    await new Promise((r) => setTimeout(r, 450));           // dark is out (committed on the host as rev 2; its answer held)
    hostValues = { theme: "light" }; hostRev = 3;           // another device put light back: rev 3
    await m.refresh();
    const during = [ls("agend_theme"), m.hostPref("theme")];
    write.release(reply(200, { values: { theme: "dark" }, rev: 2 }));
    await ticks();
    expect([during, ls("agend_theme"), m.hostPref("theme"), theme.mock.calls]).toEqual([["dark", "light"], "light", "light", [["light"]]]);
  });
  it("r2 controls: a write answered normally keeps this page's value; a key changed again while its write was out stays this page's", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" }, rev: 1 });
    m.savePref("theme", "dark");
    await new Promise((r) => setTimeout(r, 450)); await ticks();
    const normal = [ls("agend_theme"), m.hostPref("theme")];
    const write = held();
    intercept = (method) => (method === "POST" ? write.p as Promise<any> : undefined);
    m.savePref("lang", "zh-TW");
    await new Promise((r) => setTimeout(r, 450));           // lang zh-TW is out
    hostValues = { ...hostValues, lang: "en" }; hostRev = 9;
    await m.refresh();
    m.savePref("lang", "en");                               // changed here again (pending) …
    m.savePref("lang", "zh-TW");                            // … to zh-TW: this page's choice
    write.release(reply(200, { values: { theme: "dark", lang: "zh-TW" }, rev: 3 }));
    await ticks();
    expect([normal, ls("agend_lang")]).toEqual([["dark", "dark"], "zh-TW"]);
    intercept = null;
    await new Promise((r) => setTimeout(r, 450)); await ticks();
    expect([posts().at(-1), ls("agend_lang")]).toEqual([{ set: { lang: "zh-TW" } }, "zh-TW"]);
  });
  it("P2-2 ②: an older read answering last does not replace a newer one", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" }, rev: 1 });
    const older = held();
    let n = 0;
    intercept = (method) => (method === "GET" && n++ === 0 ? older.p as Promise<any> : undefined);
    const first = m.refresh();                              // A: held
    hostValues = { theme: "dark" }; hostRev = 3;
    await m.refresh();                                      // B: rev 3, dark — taken
    older.release(reply(200, { values: { theme: "light" }, rev: 2 }));
    await first;
    expect([ls("agend_theme"), m.hostPref("theme")]).toEqual(["dark", "dark"]);
  });
  it("P2-2 ③: an older write's answer arriving last does not replace a newer view", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { lang: "en" }, rev: 1 });
    const write = held();
    intercept = (method) => (method === "POST" ? write.p as Promise<any> : undefined);
    m.savePref("lang", "zh-TW");
    await new Promise((r) => setTimeout(r, 450));
    intercept = (method) => (method === "POST" ? write.p as Promise<any> : undefined);
    hostValues = { lang: "zh-TW", theme: "dark" }; hostRev = 3;
    await m.refresh();                                      // B: rev 3 (the lang key is still this page's own)
    write.release(reply(200, { values: { lang: "zh-TW" }, rev: 2 }));
    await ticks();
    expect([m.hostPref("theme"), ls("agend_theme")]).toEqual(["dark", "dark"]);
  });
  it("P2-3: migration is marked only after real answers — a server error, an unreadable store or a failed read leaves it to the next load", async () => {
    const outcomes: unknown[] = [];
    for (const failure of ["post500", "post503", "post401", "get500", "getUnreadable", "none-400"] as const) {
      vi.resetModules(); requests = []; hostValues = {}; hostRev = 0;
      const m = await boot({ storage: { agend_lang: "zh-TW", agend_theme: "dark" }, host: {} });
      intercept = (method) => {
        if (method === "POST" && failure.startsWith("post")) return Promise.resolve(reply(Number(failure.slice(4)), { error: "x" }));
        if (method === "POST" && failure === "none-400") return Promise.resolve(reply(400, { error: "bad value" }));
        if (method === "GET" && failure === "get500") return Promise.resolve(reply(500, { error: "x" }));
        if (method === "GET" && failure === "getUnreadable") return Promise.resolve(reply(200, { values: {}, rev: 0, unreadable: true }));
        return undefined;
      };
      outcomes.push([failure, await m.migratePrefs(), ls("agend_prefs_synced")]);
      pg.restore();
    }
    expect(outcomes).toEqual([["post500", false, null], ["post503", false, null], ["post401", false, null], ["get500", false, null], ["getUnreadable", false, null], ["none-400", true, "1"]]);
    // Nothing to upload and the read fails: not marked either.
    vi.resetModules();
    const m = await boot({ storage: {}, host: {} });
    intercept = (method) => (method === "GET" ? Promise.resolve(reply(503, {})) : undefined);
    expect([await m.migratePrefs(), ls("agend_prefs_synced")]).toEqual([false, null]);
  });
  it("P2-3: a revision whose read failed is read again at a later frame (at most every 5 s), then taken", async () => {
    let clock = 1000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light" }, rev: 1 });
      const store = await import("/assets/app-store.js");
      m.bootPrefs();
      hostValues = { theme: "dark" }; hostRev = 2;
      intercept = (method) => (method === "GET" ? Promise.resolve(reply(503, {})) : undefined);
      store.applyStatus({ instances: [], prefs_rev: 2 }); await ticks();
      intercept = null;
      clock += 1000; store.applyStatus({ instances: [], prefs_rev: 2 }); await ticks();   // too soon: not again yet
      const early = [requests.filter((r) => r.method === "GET").length, ls("agend_theme")];
      clock += 5000; store.applyStatus({ instances: [], prefs_rev: 2 }); await ticks();
      expect([early, requests.filter((r) => r.method === "GET").length, ls("agend_theme")]).toEqual([[1, "light"], 2, "dark"]);
    } finally { spy.mockRestore(); }
  });
  it("a revision announced while a read is out is read right after it — and a newer one soon after a success is not held back", async () => {
    let clock = 1000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { "nav.collapsed": ["A"] }, rev: 1 });
      const store = await import("/assets/app-store.js");
      m.bootPrefs();
      const first = held();
      let n = 0;
      intercept = (method) => (method === "GET" && n++ === 0 ? first.p as Promise<any> : undefined);
      store.applyStatus({ instances: [], prefs_rev: 2 });           // read 1: held
      hostValues = { "nav.collapsed": ["A", "B"] }; hostRev = 3;
      store.applyStatus({ instances: [], prefs_rev: 3 });           // announced while read 1 is out
      first.release(reply(200, { values: { "nav.collapsed": ["A"] }, rev: 2 }));
      await ticks(60);
      const afterBoth = [requests.filter((r) => r.method === "GET").length, ls("agend_instance_collapsed")];
      clock += 100; hostValues = { "nav.collapsed": ["C"] }; hostRev = 4;
      store.applyStatus({ instances: [], prefs_rev: 4 }); await ticks(60);
      expect([afterBoth, ls("agend_instance_collapsed")]).toEqual([[2, '["A","B"]'], '["C"]']);
    } finally { spy.mockRestore(); }
  });
  it("P2-4: on a device in step with the host, a key the host does not have is the default — the stale copy goes", async () => {
    await boot({ storage: { agend_prefs_synced: "1", agend_instance_collapsed: '["Old"]', agend_html_preview: "on", agend_lang: "zh-TW" }, host: { theme: "dark" } });
    expect([ls("agend_instance_collapsed"), ls("agend_html_preview"), ls("agend_lang"), ls("agend_theme")]).toEqual([null, null, null, "dark"]);
  });
  it("P2-4: not in step yet, this device's own values stay (to be uploaded)", async () => {
    await boot({ storage: { agend_instance_collapsed: '["Mine"]', agend_lang: "zh-TW" }, host: {} });
    expect([ls("agend_instance_collapsed"), ls("agend_lang")]).toEqual(['["Mine"]', "zh-TW"]);
  });
  it("P2-4: the host's language cleared elsewhere: this page goes back to the device's own, live, with no copy kept", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { lang: "zh-TW" } });
    const i18n = await import("/assets/app-i18n.js");
    expect(i18n.lang()).toBe("zh-TW");
    hostValues = {}; hostRev = 2;
    await m.refresh();
    expect([i18n.lang(), ls("agend_lang")]).toEqual(["en", null]);
  });
  it("P2-4: the dictionary on a device in step, with no language on the host: the device's own (its stale copy cleared)", async () => {
    pg = installDom({ storage: { agend_prefs_synced: "1", agend_lang: "zh-TW" }, lang: "en" });
    pg.document.documentElement.setAttribute("data-prefs", prefsAttr({}));
    const i18n = await import("/assets/app-i18n.js");
    expect([i18n.lang(), ls("agend_lang")]).toEqual(["en", null]);
  });
  it("P3: an open Preferences shows the theme and language in force as they change", async () => {
    const m = await boot({ storage: { agend_prefs_synced: "1" }, host: { theme: "light", lang: "en" } });
    new Function(THEME_JS).call(pg.window);
    (globalThis as any).AgendTheme = pg.window.AgendTheme;
    const { h, render } = await import("/assets/app-html.js");
    const { DevicePrefs } = await import("/assets/app-shell.js");
    const root = pg.document.createElement("div"); pg.document.body.appendChild(root);
    render(h(DevicePrefs, { labels: true }), root); await settle();
    const sel = (l: string) => (root.querySelector(`select[aria-label="${l}"]`) as any);
    const before = [sel("Theme").value, sel("Language").value];
    hostValues = { theme: "dark", lang: "zh-TW" }; hostRev = 2;
    await m.refresh(); await settle();
    expect([before, sel("主題")?.value ?? sel("Theme")?.value, (root.querySelectorAll("select")[1] as any).value]).toEqual([["light", "en"], "dark", "zh-TW"]);
    render(null, root);
  });

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
    // What reached the host, whatever the number of writes (a slow import can split the 400 ms burst in two).
    const sentSets = posts().map((p) => { expect(Object.keys(p)).toEqual(["set"]); return p.set; });
    expect([themes, Object.assign({}, ...sentSets), ls("agend_tour_done"), ls("agend_firstrun_dismissed")])
      .toEqual([["dark"], { theme: "dark", lang: "zh-TW", "preview.optIn": true }, "1", "1"]);
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
