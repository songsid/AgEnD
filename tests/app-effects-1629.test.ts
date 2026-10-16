/** App bridge ownership tests: real driver, modeled stores/host, injected core (not frame/cap evidence). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const env = vi.hoisted(() => {
  function store(value: any) {
    const listeners = new Set<any>();
    return { get: () => value, set(patch: any) { value = { ...value, ...patch }; for (const fn of [...listeners]) fn(value); }, subscribe(fn: any) { listeners.add(fn); return () => listeners.delete(fn); }, listeners, reset(v: any) { value = v; listeners.clear(); } };
  }
  return { app: store({}), nav: store({}), css: store({}), themes: store({}), prefs: new Set<any>(), values: {} as any, safe: false, mode: "light" };
});
vi.mock("/assets/app-store.js", () => ({ appStore: env.app }));
vi.mock("/assets/app-nav.js", () => ({ navStore: env.nav }));
vi.mock("/assets/app-prefs.js", () => ({ onPrefsChanged: (fn: any) => { env.prefs.add(fn); return () => env.prefs.delete(fn); }, prefInForce: (key: string) => ({ value: env.values[key] }) }));
vi.mock("/assets/app-themes.js", () => ({ resolvedMode: () => env.mode, themesStore: env.themes }));
vi.mock("/assets/owner-css.js", () => ({ safeMode: () => env.safe, ownerCssLifecycle: env.css }));
function target(extra: any = {}) {
  const listeners = new Map<string, Set<any>>();
  return { ...extra, addEventListener(type: string, fn: any) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); }, removeEventListener(type: string, fn: any) { listeners.get(type)?.delete(fn); }, emit(type: string) { for (const fn of [...listeners.get(type) ?? []]) fn(); }, listeners };
}
async function rig(prepare: (h: any) => void = () => {}) {
  const { startAppEffects, getAppEffects } = await import(new URL("../src/ui/app-effects.js", import.meta.url).href);
  const doc = target({ body: { dataset: { mode: "full" } }, documentElement: { getAttribute: () => JSON.stringify({ ownerScope: "person", ownerEpoch: "e".repeat(16) }) }, visibilityState: "visible", querySelector: () => null });
  const media = target({ matches: false }), coarse = target({ matches: false }), preview = { availability: () => ({ ok: true }), optedIn: () => true, never: () => false, onChange: vi.fn(() => vi.fn()) };
  const observer: any = { observe: vi.fn(), disconnect: vi.fn() };
  const host: any = target({ document: doc, AgendAuth: { onSessionEnd: vi.fn(), sessionEnded: () => false }, AgendPreview: preview,
    navigator: { connection: target({ saveData: false }), hardwareConcurrency: 8, deviceMemory: 8 }, innerWidth: 1366,
    OffscreenCanvas: function () {}, Worker: function () {}, ResizeObserver: function () {}, MutationObserver: vi.fn(function (fn: any) { observer.fn = fn; return observer; }), matchMedia: (q: string) => q.includes("coarse") ? coarse : media });
  const replies = new Set<any>(), store = { onAgentReply: vi.fn((fn: any) => { replies.add(fn); return () => replies.delete(fn); }) };
  let options: any;
  const parts: any[] = [], api: any = { ok: true, sync: vi.fn(), detachChat: vi.fn(), changedChat: vi.fn(), reply: vi.fn(), dispose: vi.fn(() => options.onDispose()), attachChat: vi.fn((o: any) => { parts.push(o); return { ok: true, dispose: vi.fn() }; }) };
  const runtime = vi.fn((o: any) => { options = o; return api; });
  const h: any = { host, doc, media, coarse, preview, observer, replies, store, parts, api, runtime, options: () => options, startAppEffects, getAppEffects };
  prepare(h); h.entry = startAppEffects({ window: host, store, factories: { runtime } }); return h;
}
beforeEach(() => { vi.resetModules(); env.app.reset({ themesRev: 1, connection: "live" }); env.nav.reset({ seq: 1, route: { panel: "fleet" } }); env.css.reset({ state: "off" }); env.themes.reset({}); env.prefs.clear(); env.values = { "fx.show": true, "preview.optIn": true }; env.safe = false; env.mode = "light"; });
describe("#1629 app lifetime effect bridge", () => {
  it("boots on Fleet once, keeps one reply subscription/pool across Chat A→B→Fleet, and fences old route predicates", async () => {
    const h = await rig(); expect(h.entry).not.toBeNull(); expect(h.runtime).toHaveBeenCalledOnce(); expect(h.replies.size).toBe(1);
    expect(h.entry.attachChat({ name: "a", current: () => true })).toBeNull();
    env.nav.set({ seq: 2, route: { panel: "chat", instance: "a" } }); h.api.detachChat.mockClear();
    const a = h.entry.attachChat({ name: "a", element: {}, current: () => true }); expect(a.ok).toBe(true); expect(h.parts[0].current()).toBe(true);
    env.nav.set({ seq: 3, route: { panel: "chat", instance: "b" } }); expect(h.api.detachChat).toHaveBeenCalledOnce(); expect(h.parts[0].current()).toBe(false);
    h.entry.attachChat({ name: "b", element: {}, current: () => true }); env.nav.set({ seq: 4, route: { panel: "fleet" } }); expect(h.parts[1].current()).toBe(false);
    expect(h.startAppEffects({ window: h.host, store: h.store, factories: { runtime: h.runtime } })).toBe(h.entry); expect(h.runtime).toHaveBeenCalledOnce(); expect(h.store.onAgentReply).toHaveBeenCalledOnce(); expect(h.api.dispose).not.toHaveBeenCalled(); h.entry.dispose();
  });
  it("only themesRev invalidates metadata; existing status/theme/prefs/preview activity only syncs gates", async () => {
    const h = await rig(); h.api.sync.mockClear(); env.app.set({ connection: "live" }); env.app.set({ themesRev: 2 }); env.css.set({ state: "on" }); env.themes.set({ mode: "dark" }); for (const fn of env.prefs) fn(); h.host.emit("resize");
    expect(h.api.changedChat).toHaveBeenCalledOnce(); expect(h.api.sync).toHaveBeenCalledTimes(5); expect(h.options().observe()).toMatchObject({ ownerCss: "on", mode: "light" }); h.entry.dispose();
  });
  it("same-name navigation invalidates the older sequence before a replacement component commits", async () => {
    const h = await rig(); env.nav.set({ seq: 2, route: { panel: "chat", instance: "a" } }); h.entry.attachChat({ name: "a", current: () => true }); const old = h.parts[0];
    env.nav.set({ seq: 3, route: { panel: "chat", instance: "a" } }); expect(old.current()).toBe(false); expect(h.api.detachChat).toHaveBeenCalledTimes(3); h.entry.dispose();
  });
  it("the global barrier observer syncs once per actual modal transition and retains optional device gates", async () => {
    const h = await rig(); h.api.sync.mockClear(); h.doc.querySelector = () => ({}); h.observer.fn(); h.observer.fn(); expect(h.api.sync).toHaveBeenCalledOnce(); expect(h.entry.gates().modal).toBe(true);
    h.doc.querySelector = () => null; h.observer.fn(); expect(h.api.sync).toHaveBeenCalledTimes(2); h.media.matches = true; h.host.navigator.connection.saveData = true; env.safe = true;
    expect(h.entry.gates()).toMatchObject({ modal: false, reducedMotion: true, saveData: true, safe: true }); h.entry.dispose();
  });
  it("a replacement Chat store unsubscribes the old reply source without a new core", async () => {
    const h = await rig(), old = [...h.replies][0], fresh = new Set<any>(), store = { onAgentReply: vi.fn((fn: any) => { fresh.add(fn); return () => fresh.delete(fn); }) };
    h.startAppEffects({ window: h.host, store, factories: { runtime: h.runtime } }); expect(h.replies.size).toBe(0); old({ instance: "old" }); expect(h.api.reply).not.toHaveBeenCalled();
    [...fresh][0]({ instance: "a" }); expect(h.api.reply).toHaveBeenCalledExactlyOnceWith({ instance: "a" }); expect(h.runtime).toHaveBeenCalledOnce(); h.entry.dispose(); expect(fresh.size).toBe(0);
  });
  it.each(["public", "poll", "view", "header", "epoch", "auth"])("%s has no app owner or observers", async fault => {
    const h = await rig(h => { if (fault === "public") h.doc.body.dataset.publicLink = "1"; if (fault === "poll") h.doc.body.dataset.webTransport = "poll"; if (fault === "view") h.doc.body.dataset.mode = "view-only"; if (fault === "header") h.doc.documentElement.getAttribute = () => '{}'; if (fault === "epoch") h.doc.documentElement.getAttribute = () => '{"ownerScope":"person","ownerEpoch":"bad"}'; if (fault === "auth") delete h.host.AgendAuth.onSessionEnd; });
    expect(h.entry).toBeNull(); expect(h.runtime).not.toHaveBeenCalled(); expect(env.app.listeners.size).toBe(0); expect(h.replies.size).toBe(0);
  });
  it("an already ended stream cannot start an owner while the Chat module was loading", async () => {
    const h = await rig(() => env.app.set({ connection: "ended" })); expect(h.entry).toBeNull(); expect(h.runtime).not.toHaveBeenCalled(); expect(h.replies.size).toBe(0);
  });
  it("a minimal browser facade disables playback without throwing or touching bare browser globals", async () => {
    const h = await rig(h => { delete h.host.navigator; delete h.host.innerWidth; delete h.host.matchMedia; delete h.host.Worker; delete h.host.OffscreenCanvas; delete h.host.MutationObserver; delete h.host.ResizeObserver; });
    expect(h.entry.gates()).toMatchObject({ enabled: false, reducedMotion: true, saveData: false }); h.entry.dispose();
  });
  it.each(["core", "connection", "manual"])("%s termination releases every observer once and cannot start another Window episode", async fault => {
    const h = await rig(), ended = vi.fn(); h.entry.onEnd(ended); if (fault === "core") h.options().onDispose(); if (fault === "connection") env.app.set({ connection: "ended" }); if (fault === "manual") h.entry.dispose();
    expect(h.api.dispose).toHaveBeenCalledOnce(); expect(h.observer.disconnect).toHaveBeenCalledOnce(); expect(h.replies.size).toBe(0); expect(env.app.listeners.size).toBe(0); expect(env.nav.listeners.size).toBe(0); expect(env.css.listeners.size).toBe(0); expect(env.themes.listeners.size).toBe(0); expect(env.prefs.size).toBe(0); expect(ended).toHaveBeenCalledOnce(); expect(h.getAppEffects(h.host)).toBeNull();
    expect(h.startAppEffects({ window: h.host, store: h.store, factories: { runtime: h.runtime } })).toBeNull(); expect(h.runtime).toHaveBeenCalledOnce(); h.entry.dispose(); expect(ended).toHaveBeenCalledOnce();
  });
  it("setup refusal and throws release partial ownership without affecting Chat", async () => {
    const h = await rig(h => { h.runtime.mockImplementation((o: any) => { h.options = () => o; return { ok: false, dispose: h.api.dispose }; }); });
    expect(h.entry).toBeNull(); expect(h.replies.size).toBe(0); expect(env.nav.listeners.size).toBe(0);
  });
  it.each(["media", "observe"])("%s setup exception tears down partial app ownership", async fault => {
    const h = await rig(h => { if (fault === "media") h.host.matchMedia = () => { throw Error("media"); }; else h.observer.observe.mockImplementation(() => { throw Error("observer"); }); });
    expect(h.entry).toBeNull(); expect(h.getAppEffects(h.host)).toBeNull(); expect(env.app.listeners.size).toBe(0); expect(env.nav.listeners.size).toBe(0); expect(h.replies.size).toBe(0);
    if (fault === "media") expect(h.runtime).not.toHaveBeenCalled(); else { expect(h.api.dispose).toHaveBeenCalledOnce(); expect(h.observer.disconnect).toHaveBeenCalledOnce(); }
  });
  it("disposal during a reply subscription immediately releases its late unsubscribe", async () => {
    let off: any; const h = await rig(h => { off = vi.fn(); h.store.onAgentReply.mockImplementation(() => { h.options().onDispose(); return off; }); });
    expect(h.entry).toBeNull(); expect(off).toHaveBeenCalledOnce(); expect(h.api.dispose).toHaveBeenCalledOnce(); expect(env.nav.listeners.size).toBe(0);
  });
  it("a core callback during construction never installs global observers", async () => {
    const h = await rig(h => { h.runtime.mockImplementation((o: any) => { o.onDispose(); return { ok: false, dispose: vi.fn() }; }); });
    expect(h.entry).toBeNull(); expect(h.observer.observe).not.toHaveBeenCalled(); expect(h.replies.size).toBe(0); expect(env.app.listeners.size).toBe(0);
  });
  it("cleanup continues when one subscriber release and one end listener throw", async () => {
    const h = await rig(); const finish = vi.fn(); h.entry.onEnd(() => { throw Error("listener"); }); h.entry.onEnd(finish); h.preview.onChange.mock.results[0].value.mockImplementation(() => { throw Error("release"); });
    expect(() => h.entry.dispose()).not.toThrow(); expect(finish).toHaveBeenCalledOnce(); expect(h.observer.disconnect).toHaveBeenCalledOnce(); expect(env.app.listeners.size).toBe(0); expect(env.prefs.size).toBe(0);
  });
  it("committed Chat currentness includes the caller lease and document identity", async () => {
    const h = await rig(); env.nav.set({ seq: 2, route: { panel: "chat", instance: "a" } }); let live = true; h.entry.attachChat({ name: "a", current: () => live }); expect(h.parts[0].current()).toBe(true); live = false; expect(h.parts[0].current()).toBe(false); live = true; h.host.document = {}; expect(h.parts[0].current()).toBe(false); h.entry.dispose();
  });
  it("the real full-app boot starts the driver after preview setup; the public entry imports neither it nor Chat directly", () => {
    const panel = readFileSync(new URL("../src/ui/panel-chat.js", import.meta.url), "utf8"), app = readFileSync(new URL("../src/ui/shared/app.js", import.meta.url), "utf8");
    expect(panel.indexOf("startAppEffects({ store })")).toBeGreaterThan(panel.indexOf("P().init(bootData")); expect(app).not.toContain('from "/ui/js/app-effects.js"'); expect(app).not.toContain('from "/ui/js/panel-chat.js"');
  });
});
