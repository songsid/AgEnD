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
vi.mock("/assets/app-themes.js", () => ({ resolvedMode: () => env.mode, themesShown: () => env.values["fx.show"] !== false, themesStore: env.themes }));
vi.mock("/assets/owner-css.js", () => ({ safeMode: () => env.safe, ownerCssLifecycle: env.css }));
function target(extra: any = {}) {
  const listeners = new Map<string, Set<any>>();
  return { ...extra, addEventListener(type: string, fn: any) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); }, removeEventListener(type: string, fn: any) { listeners.get(type)?.delete(fn); }, emit(type: string) { for (const fn of [...listeners.get(type) ?? []]) fn(); }, listeners };
}
async function rig(prepare: (h: any) => void = () => {}) {
  const { startAppEffects, getAppEffects } = await import(new URL("../src/ui/app-effects.js", import.meta.url).href);
  const doc = target({ body: { dataset: { mode: "full", effectScope: "owner", effectEpoch: "e".repeat(16), effectBoot: "a".repeat(32) } }, documentElement: { getAttribute: () => JSON.stringify({ ownerScope: "person", ownerEpoch: "e".repeat(16) }) }, visibilityState: "visible", querySelector: () => null, querySelectorAll: () => [] });
  const media = target({ matches: false }), coarse = target({ matches: false }), preview = { availability: () => ({ ok: true }), optedIn: () => true, never: () => false, onChange: vi.fn(() => vi.fn()) };
  const observer: any = { observe: vi.fn(), disconnect: vi.fn() };
  const host: any = target({ document: doc, location: { origin: "http://localhost" }, AgendAuth: { onSessionEnd: vi.fn(), sessionEnded: () => false }, AgendPreview: preview,
    navigator: { connection: target({ saveData: false }), hardwareConcurrency: 8, deviceMemory: 8 }, innerWidth: 1366,
    OffscreenCanvas: function () {}, Worker: function () {}, ResizeObserver: function () {}, MutationObserver: vi.fn(function (fn: any) { observer.fn = fn; return observer; }), matchMedia: (q: string) => q.includes("coarse") ? coarse : media });
  const replies = new Set<any>(), store = { onAgentReply: vi.fn((fn: any) => { replies.add(fn); return () => replies.delete(fn); }) };
  let options: any;
  const parts: any[] = [], api: any = { ok: true, sync: vi.fn(), detachChat: vi.fn(), changedChat: vi.fn(), changedOwner: vi.fn(), reply: vi.fn(), dispose: vi.fn(() => options.onDispose()), attachChat: vi.fn((o: any) => { parts.push(o); return { ok: true, dispose: vi.fn() }; }) };
  api.cursorSelection = vi.fn(() => ({ id: "a".repeat(32), generation: 1, hotspot: [0, 0] })); api.cursorImageSettled = vi.fn(async () => new Uint8Array([1]));
  const cursor = { ok: true, update: vi.fn(), snapshot: vi.fn(() => ({ id: "a".repeat(32), status: "running" })), dispose: vi.fn() }, cursorFactory = vi.fn(() => cursor);
  const runtime = vi.fn((o: any) => { options = o; return api; }), regions = { ok: true, resolve: vi.fn(() => ({})), dispose: vi.fn() }, regionFactory = vi.fn(() => regions);
  const h: any = { host, doc, media, coarse, preview, observer, replies, store, parts, api, runtime, regions, regionFactory, cursor, cursorFactory, options: () => options, startAppEffects, getAppEffects };
  prepare(h); h.entry = startAppEffects({ window: host, store, factories: { runtime, regions: regionFactory, cursor: cursorFactory, trialController: h.trialController } }); return h;
}
beforeEach(() => { vi.resetModules(); env.app.reset({ themesRev: 1, prefsRev: 1, connection: "live" }); env.nav.reset({ seq: 1, route: { panel: "fleet" } }); env.css.reset({ state: "off" }); env.themes.reset({}); env.prefs.clear(); env.values = { "fx.show": true, "preview.optIn": true }; env.safe = false; env.mode = "light"; });
describe("#1629 app lifetime effect bridge", () => {
  it("termination during target construction immediately releases its late returned helper", async () => {
    const h = await rig(h => h.regionFactory.mockImplementation(() => { h.options().onDispose(); return h.regions; }));
    expect(h.entry).toBeNull(); expect(h.regions.dispose).toHaveBeenCalledOnce(); expect(h.observer.observe).not.toHaveBeenCalled(); expect(env.app.listeners.size).toBe(0);
  });
  it("passes only a fixed stock-region resolver, mapping box declaration without inventing scope", async () => {
    const h = await rig(), proof = { ok: true }, box = { width: 100 };
    expect(h.regionFactory).toHaveBeenCalledOnce(); expect(h.options().resolveOwnerTarget("fx.box", { box }, proof)).not.toBeNull();
    expect(h.regions.resolve).toHaveBeenCalledExactlyOnceWith("fx.box", box, proof); h.entry.dispose(); expect(h.regions.dispose).toHaveBeenCalledOnce();
    expect(h.options().resolveOwnerTarget("fx.box", { box }, proof)).toBeNull();
  });
  it("preference revisions invalidate only owner metadata, including a simultaneous Chat revision", async () => {
    const h = await rig(); env.app.set({ prefsRev: 2 }); expect(h.api.changedOwner).toHaveBeenCalledOnce(); expect(h.api.changedChat).not.toHaveBeenCalled();
    env.app.set({ prefsRev: 3, themesRev: 2 }); expect(h.api.changedOwner).toHaveBeenCalledTimes(2); expect(h.api.changedChat).toHaveBeenCalledOnce();
    env.app.set({ prefsRev: 3, connection: "live" }); expect(h.api.changedOwner).toHaveBeenCalledTimes(2); h.entry.dispose();
  });
  it("late stock panel commits reproject once, but body effect-root mutations do not self-schedule", async () => {
    const h = await rig(); h.api.sync.mockClear(); const inside = { closest: (q: string) => q === "#app" ? {} : null }, outside = { closest: () => null };
    h.observer.fn([{ target: inside }]); h.observer.fn([{ target: inside }]); expect(h.api.sync).not.toHaveBeenCalled(); await Promise.resolve(); expect(h.api.sync).toHaveBeenCalledOnce();
    h.observer.fn([{ target: outside }]); await Promise.resolve(); expect(h.api.sync).toHaveBeenCalledOnce();
    h.observer.fn([{ target: inside }]); h.entry.dispose(); await Promise.resolve(); expect(h.api.sync).toHaveBeenCalledOnce();
  });
  it("owner update subscriptions isolate throws, unsubscribe and end without granting new ownership", async () => {
    const h = await rig(), first = vi.fn(), last = vi.fn(); h.entry.subscribe(() => { throw Error("UI"); }); const off = h.entry.subscribe(first); h.entry.subscribe(last);
    h.options().onChange(); expect(first).toHaveBeenCalledOnce(); expect(last).toHaveBeenCalledOnce(); off(); h.options().onChange(); expect(first).toHaveBeenCalledOnce(); expect(last).toHaveBeenCalledTimes(2);
    h.entry.dispose(); h.options().onChange(); expect(last).toHaveBeenCalledTimes(2);
  });
  it("unavailable personal target construction leaves the Chat pool available and releases the partial helper", async () => {
    const h = await rig(h => { h.regions.ok = false; }); expect(h.entry).not.toBeNull(); expect(h.options().resolveOwnerTarget("fx.page", {}, {})).toBeNull(); expect(h.api.dispose).not.toHaveBeenCalled(); h.entry.dispose(); expect(h.regions.dispose).toHaveBeenCalledOnce();
  });
  it("boots on Fleet once, keeps one reply subscription/pool across Chat A→B→Fleet, and fences old route predicates", async () => {
    const h = await rig(); expect(h.entry).not.toBeNull(); expect(h.runtime).toHaveBeenCalledOnce(); expect(h.replies.size).toBe(1);
    expect(h.entry.attachChat({ name: "a", current: () => true })).toBeNull();
    env.nav.set({ seq: 2, route: { panel: "chat", instance: "a" } }); h.api.detachChat.mockClear();
    const a = h.entry.attachChat({ name: "a", element: {}, current: () => true }); expect(a.ok).toBe(true); expect(h.parts[0].current()).toBe(true);
    env.nav.set({ seq: 3, route: { panel: "chat", instance: "b" } }); expect(h.api.detachChat).toHaveBeenCalledOnce(); expect(h.parts[0].current()).toBe(false);
    h.entry.attachChat({ name: "b", element: {}, current: () => true }); env.nav.set({ seq: 4, route: { panel: "fleet" } }); expect(h.parts[1].current()).toBe(false);
    expect(h.startAppEffects({ window: h.host, store: h.store, factories: { runtime: h.runtime } })).toBe(h.entry); expect(h.runtime).toHaveBeenCalledOnce(); expect(h.store.onAgentReply).toHaveBeenCalledOnce(); expect(h.api.dispose).not.toHaveBeenCalled(); h.entry.dispose();
  });
  it("theme revision invalidates Chat metadata; other activity only syncs gates", async () => {
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
    expect(h.entry.gates()).toMatchObject({ modal: false, reducedMotion: false, saveData: true, safe: true }); h.entry.dispose();
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
    expect(h.entry.gates()).toMatchObject({ enabled: false, reducedMotion: false, saveData: false }); h.entry.dispose();
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
    const h = await rig(); const finish = vi.fn(); h.entry.onEnd(() => { throw Error("listener"); }); h.entry.onEnd(finish); h.observer.disconnect.mockImplementation(() => { throw Error("release"); });
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


describe("actual app cursor ownership", () => {
  it("constructs one controller with exact source snapshot/shared read and current device motion choice", async () => {
    const h = await rig(); expect(h.cursorFactory).toHaveBeenCalledOnce(); const options = h.cursorFactory.mock.calls[0][0], c = h.api.cursorSelection(); expect(h.cursor.update).toHaveBeenLastCalledWith(c, true); const signal = new AbortController().signal; expect(await options.readImage(c, signal)).toEqual(new Uint8Array([1])); expect(h.api.cursorImageSettled).toHaveBeenCalledExactlyOnceWith(c, signal);
    h.media.matches = true; h.media.emit("change"); expect(h.cursor.update).toHaveBeenLastCalledWith(c, true);
    const motion = await import("/assets/fx-motion.js"); motion.setFollowsReducedMotion(true); expect(h.cursor.update).toHaveBeenLastCalledWith(c, false);
    motion.setFollowsReducedMotion(false); expect(h.cursor.update).toHaveBeenLastCalledWith(c, true); h.entry.dispose(); expect(h.cursor.dispose).toHaveBeenCalledOnce(); expect(options.current()).toBe(false);
  });
  it("unsupported or throwing cursor setup leaves the shared Chat/owner runtime intact", async () => {
    for (const kind of ["unsupported", "throw"]) { const h = await rig(h => { if (kind === "unsupported") h.cursor.ok = false; else h.cursorFactory.mockImplementation(() => { throw Error("unsupported"); }); }); expect(h.entry).not.toBeNull(); expect(h.entry.cursorSnapshot().status).toBe("unavailable"); expect(h.api.dispose).not.toHaveBeenCalled(); h.entry.dispose(); }
  });
  it("late cursor helper after synchronous termination is disposed without observers", async () => {
    const h = await rig(h => h.cursorFactory.mockImplementation(() => { h.options().onDispose(); return h.cursor; })); expect(h.entry).toBeNull(); expect(h.cursor.dispose).toHaveBeenCalledOnce(); expect(h.observer.observe).not.toHaveBeenCalled();
  });
  it("cursor status notification is deduplicated and does not re-read metadata or re-enter controller updates", async () => {
    const h = await rig(), changed = vi.fn(), notify = h.cursorFactory.mock.calls[0][0].onChange; h.entry.subscribe(changed); const prior = h.cursor.update.mock.calls.length; notify({ status: "running", id: "a".repeat(32) }); notify({ status: "running", id: "a".repeat(32) }); expect(changed).toHaveBeenCalledOnce(); expect(h.cursor.update).toHaveBeenCalledTimes(prior); expect(h.api.changedOwner).not.toHaveBeenCalled(); h.entry.dispose();
  });
});

it("stock sidebar dragging closes only the cursor gate and restores it on the observed end", async () => {
  let dragging = false; const h = await rig(h => { h.doc.body.classList = { contains: (key: string) => key === "side-resizing" && dragging }; });
  const c = h.api.cursorSelection(); dragging = true; h.observer.fn([{ target: h.doc.body }]); expect(h.cursor.update).toHaveBeenLastCalledWith(c, false); dragging = false; h.observer.fn([{ target: h.doc.body }]); expect(h.cursor.update).toHaveBeenLastCalledWith(c, true); expect(h.cursorFactory).toHaveBeenCalledOnce(); h.entry.dispose();
});
it.each(["safe", "hidden", "transport", "show", "modal", "unsupported"])("cursor follows existing %s gate without another metadata reader", async fault => {
  const h = await rig(); if (fault === "safe") env.safe = true; if (fault === "hidden") h.doc.visibilityState = "hidden"; if (fault === "transport") h.doc.body.dataset.effectBoot = ""; if (fault === "show") env.values["fx.show"] = false; if (fault === "modal") h.doc.querySelector = () => ({}); if (fault === "saveData") h.host.navigator.connection.saveData = true; if (fault === "unsupported") delete h.host.Worker;
  h.host.emit("resize"); expect(h.cursor.update).toHaveBeenLastCalledWith(h.api.cursorSelection(), false); expect(h.api.changedOwner).not.toHaveBeenCalled(); expect(h.cursorFactory).toHaveBeenCalledOnce(); h.entry.dispose();
});


// Real app bridge + real control lane; injected core/stage protocol, not native clip/cap evidence.
const trialOffer = () => ({ v: 1, offer: "b".repeat(32), id: "a".repeat(32), title: "Fixture", expiresAt: 600000 });
const trialMessage = () => ({ sender: "agend", role: "status", instance: "own", effectTrial: trialOffer() });
const trialReply = () => ({ trial: "c".repeat(32), offer: trialOffer(), remainingMs: 600000,
  manifest: { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["page"], layer: "front", wants: ["theme"] }, params: {} });
const trialResponse = () => new Response(JSON.stringify(trialReply()), { headers: { "content-type": "application/json" } });
async function trialFlush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function trialRig() {
  let mono = 0; const timers = new Map(), sourceStop = vi.fn();
  const h = await rig(h => {
    h.host.location = { href: "http://localhost/", origin: "http://localhost" }; h.doc.body.dataset.previewOrigin = "http://localhost:3001"; h.doc.body.dataset.previewBoot = "b".repeat(32);
    h.doc.hasFocus = () => true; h.host.Date = { now: () => 0 }; h.host.performance = { now: () => mono }; h.host.AbortController = AbortController;
    h.host.setTimeout = vi.fn((fn: any, ms: number) => { const id = {}; timers.set(id, { fn, ms }); return id; }); h.host.clearTimeout = (id: any) => timers.delete(id);
    h.host.AgendAuth.trialSession = vi.fn(async () => ({ epoch: "e".repeat(16), localAdmin: true }));
    h.host.fetch = vi.fn(async () => trialResponse()); h.api.attachTrial = vi.fn(() => ({ stop: sourceStop }));
  });
  env.nav.set({ seq: 2, route: { panel: "chat", instance: "own" } }); h.entry.attachChat({ name: "own", current: () => true });
  await trialFlush(); h.panel = await import("/ui/js/preview-panel.js"); h.sourceStop = sourceStop; h.at = (v: number) => { mono = v; }; return h;
}
describe("#1629 product Trial bridge with protocol core", () => {
  it("replacement is silent in the card just as it is in the console", async () => {
    const h = await trialRig(); try { expect(await h.entry.startTrial(trialMessage())).toBe(true); h.panel.panelStore.get().open.handle.stop("replaced"); await trialFlush(); expect(h.entry.trialFailure(trialMessage())).toBeNull(); } finally { h.entry.dispose(); }
  });
  it("returns the same offer's exact terminal reason after the panel closes", async () => {
    const h = await trialRig(); try {
      expect(await h.entry.startTrial(trialMessage())).toBe(true); const open = h.panel.panelStore.get().open;
      open.handle.stop("stock_marker_limit"); await trialFlush();
      expect(h.entry.trialFailure(trialMessage())).toBe("stock_marker_limit");
      expect(h.entry.trialFailure({ ...trialMessage(), effectTrial: { ...trialOffer(), offer: "f".repeat(32) } })).toBeNull();
      expect(h.panel.panelStore.get().open).toBeNull();
    } finally { h.entry.dispose(); }
  });
  it("does not auto-start; explicit admission uses the current Chat and own panel slot, never an HTML run token", async () => {
    const h = await trialRig(); try {
      expect(h.entry.canTry(trialMessage())).toBe(true); expect(h.host.fetch).not.toHaveBeenCalled(); expect(h.entry.canTry({ ...trialMessage(), instance: "other" })).toBe(false);
      expect(await h.entry.startTrial(trialMessage())).toBe(true); const open = h.panel.panelStore.get().open;
      expect(open.kind).toBe("trial"); expect(h.panel.panelStore.get().run).toBe(0); expect(open.binding).toMatchObject({ id: "a".repeat(32), run: "c".repeat(32), instance: "own", generation: 1 }); expect(Object.isFrozen(open.binding)).toBe(true);
      const stage = { receipt: {}, dispose: vi.fn(), hide: vi.fn() }; open.onStage(stage); expect(h.api.attachTrial).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reply: trialReply(), startedAt: 0, stage }));
      expect(h.entry.canTry(trialMessage())).toBe(false); open.handle.stop(); await trialFlush(); expect(stage.dispose).toHaveBeenCalledOnce(); expect(h.sourceStop).toHaveBeenCalledOnce(); expect(h.panel.panelStore.get().open).toBeNull();
      expect(h.runtime).toHaveBeenCalledOnce(); expect(h.host.fetch.mock.calls.map(([p]: any[]) => p)).toEqual([`/ui/effect-trials/start?ownerEpoch=${"e".repeat(16)}`, `/ui/effect-trials/${"c".repeat(32)}/stop?ownerEpoch=${"e".repeat(16)}`]);
    } finally { h.entry.dispose(); await trialFlush(); }
  });
  it("HTML preview refusal cannot block opaque Trial, cursor or ordinary playback", async () => {
    const h = await trialRig(); try {
      env.values["preview.optIn"] = false; h.preview.optedIn = () => false; h.preview.never = () => true; h.preview.availability = () => ({ ok: false });
      env.css.set({ state: "on" });
      expect(h.entry.gates()).toMatchObject({ transportReady: true });
      expect(h.entry.canTry(trialMessage())).toBe(true); expect(await h.entry.startTrial(trialMessage())).toBe(true);
      expect(env.values["preview.optIn"]).toBe(false); expect(h.cursor.update.mock.calls.at(-1)[1]).toBe(true);
    } finally { h.entry.dispose(); await trialFlush(); }
  });
  it.each(["navigation", "same-name-chat", "new-store"])("%s cancels a pending Start before a late reply can mount", async fault => {
    const h = await trialRig(); let resolve: any; h.host.fetch.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    try {
      const pending = h.entry.startTrial(trialMessage()); await trialFlush();
      if (fault === "navigation") env.nav.set({ seq: 3, route: { panel: "chat", instance: "own" } });
      if (fault === "same-name-chat") h.entry.attachChat({ name: "own", current: () => true });
      if (fault === "new-store") h.entry.bindStore({ onAgentReply: () => () => {} });
      expect(await pending).toBe(false); resolve(trialResponse()); await trialFlush(); expect(h.panel.panelStore.get().open).toBeNull(); expect(h.api.attachTrial).not.toHaveBeenCalled(); expect(h.host.fetch).toHaveBeenCalledTimes(2);
    } finally { h.entry.dispose(); await trialFlush(); }
  });
  it.each(["on", "loading", "unknown"])("CSS %s remains active without stopping the isolated trial", async css => {
    const h = await trialRig(); try { expect(await h.entry.startTrial(trialMessage())).toBe(true); env.css.set({ state: css }); await trialFlush(); expect(h.panel.panelStore.get().open.kind).toBe("trial"); expect(h.panel.panelStore.get().open.handle.current()).toBe(true); expect(h.host.fetch).toHaveBeenCalledTimes(1); } finally { h.entry.dispose(); await trialFlush(); }
  });
  it("a late stage callback is disposed without attaching or closing a newer owner", async () => {
    const h = await trialRig(); try {
      expect(await h.entry.startTrial(trialMessage())).toBe(true); const old = h.panel.panelStore.get().open; old.handle.stop(); await trialFlush();
      expect(await h.entry.startTrial(trialMessage())).toBe(true); const current = h.panel.panelStore.get().open, stage = { receipt: {}, dispose: vi.fn(), hide: vi.fn() }; old.onStage(stage);
      expect(stage.dispose).toHaveBeenCalledOnce(); expect(h.api.attachTrial).not.toHaveBeenCalled(); expect(h.panel.panelStore.get().open).toBe(current); expect(current.handle.current()).toBe(true);
    } finally { h.entry.dispose(); await trialFlush(); }
  });
  it("a refused source attach disposes its stage and closes only its own panel", async () => {
    const h = await trialRig(); h.api.attachTrial.mockReturnValue(null); try {
      expect(await h.entry.startTrial(trialMessage())).toBe(true); const open = h.panel.panelStore.get().open, stage = { receipt: {}, dispose: vi.fn(), hide: vi.fn() }; open.onStage(stage); await trialFlush(); expect(stage.dispose).toHaveBeenCalled(); expect(h.panel.panelStore.get().open).toBeNull(); expect(h.host.fetch).toHaveBeenCalledTimes(2);
    } finally { h.entry.dispose(); await trialFlush(); }
  });
  it("redraws the real card when a false gate changes reason, while unchanged priority remains deduplicated", async () => {
    const h = await trialRig(), { installDom } = await import("./helpers/mini-dom.js"), dom = installDom({});
    const { createThread } = await import("/ui/js/chat-thread.js"), { t, setLang } = await import("/assets/app-i18n.js"); await import("/ui/js/chat-strings.js"); setLang("en", { store:false });
    const list = dom.document.createElement("div"), scroller = dom.document.createElement("div"); scroller.append(list); dom.document.body.append(scroller);
    const row = { ...trialMessage(), boot:"aa", id:1, ts:"2026-10-17T00:00:00Z", text:"Host offer" };
    const thread = createThread(list,scroller,{t,tf:t,isUser:()=>false,serverNow:()=>0,onJump(){},onEmpty(){},effectTrialStatus:(x:any)=>h.entry.trialStatus(x),canTryEffect:(x:any)=>h.entry.canTry(x),fixEffectTrial:vi.fn()});
    const draw = vi.fn(()=>thread.render([row])), off = h.entry.subscribeTrial(draw);
    try {
      const motion = await import("/assets/fx-motion.js"); motion.setFollowsReducedMotion(true);
      h.media.matches = true; h.doc.body.dataset.effectBoot = ""; h.host.emit("resize");
      expect(draw).toHaveBeenCalledTimes(1); expect(h.entry.canTry(row)).toBe(false); expect(list.textContent).toContain("Effects follow this device’s reduced-motion setting.");
      // Removing the higher-priority condition must redraw despite aggregate permission remaining false.
      h.media.matches = false; h.media.emit("change"); expect(draw).toHaveBeenCalledTimes(2); expect(h.entry.canTry(row)).toBe(false);
      expect(list.textContent).toContain("The isolated effect player is unavailable."); expect(list.textContent).not.toContain("reduced-motion");
      env.values["fx.show"] = false; for(const fn of env.prefs)fn(); expect(draw).toHaveBeenCalledTimes(3); expect(list.textContent).toContain("Turn on effects to Try.");
      h.media.matches = true; h.media.emit("change"); expect(draw).toHaveBeenCalledTimes(3); // hidden lower-priority changes do not redraw
      h.doc.body.dataset.effectBoot = "a".repeat(32); env.values["fx.show"] = true; for(const fn of env.prefs)fn(); expect(draw).toHaveBeenCalledTimes(4); expect(h.entry.canTry(row)).toBe(false);
      expect(list.textContent).toContain("Effects follow this device’s reduced-motion setting."); expect(list.textContent).not.toContain("Turn on effects");
      for(let i=0;i<100;i++)h.options().onChange(); expect(draw).toHaveBeenCalledTimes(4);
    } finally { off(); thread.dispose(); dom.restore(); h.entry.dispose(); await trialFlush(); }
  });
  it("repeated runtime observations do not repaint Trial eligibility until its value changes", async () => {
    const h = await trialRig(), fn = vi.fn(); try { const off = h.entry.subscribeTrial(fn); for (let i = 0; i < 100; i++) h.options().onChange(); expect(fn).not.toHaveBeenCalled(); env.css.set({ state: "on" }); expect(fn).not.toHaveBeenCalled(); (await import("/assets/fx-motion.js")).setFollowsReducedMotion(true); h.media.matches = true; h.host.emit("resize"); expect(fn).toHaveBeenCalledOnce(); off(); h.media.matches = false; h.host.emit("resize"); expect(fn).toHaveBeenCalledOnce(); } finally { h.entry.dispose(); }
  });
});


it.each([false, true])("#2118 Chat-only app owner constructs no personal, cursor or Trial driver (public=%s)", async publicLink => {
  const h = await rig(h => {
    Object.assign(h.doc.body.dataset, { effectScope: "chat", ...(publicLink ? { publicLink: "1", webTransport: "poll" } : { tier: "guest" }) });
    h.doc.documentElement.getAttribute = () => JSON.stringify({ ownerScope: "none", ownerEpoch: null }); h.trialController = vi.fn(); h.host.Date = { now: () => 0 };
  });
  expect(h.entry).not.toBeNull(); expect(h.regionFactory).not.toHaveBeenCalled(); expect(h.cursorFactory).not.toHaveBeenCalled(); expect(h.trialController).not.toHaveBeenCalled();
  expect(h.entry.trialStatus(trialMessage())).toBe("localAdmin"); h.entry.dispose();
});

it("#2118 guest proves absent owner CSS without installing it; unexpected styles stay unknown", async () => {
  const h = await rig(h => {Object.assign(h.doc.body.dataset,{tier:"guest",effectScope:"chat"}); env.css.reset({state:"unknown"});});
  expect(h.options().observe().ownerCss).toBe("off"); expect(h.preview.onChange).not.toHaveBeenCalled();
  h.doc.querySelectorAll=(q:string)=>q==='style'?[{sheet:{disabled:false}}]:[];
  expect(h.options().observe().ownerCss).toBe("unknown");
  h.doc.querySelectorAll=(q:string)=>q==='style'?[{sheet:null},{sheet:{disabled:true}}]:[];expect(h.options().observe().ownerCss).toBe("off");
  h.doc.querySelectorAll=(q:string)=>q.includes('link[')?[{getAttribute:()=>"/ui/owner-css.css?v=unowned"}]:[];
  expect(h.options().observe().ownerCss).toBe("unknown");
  h.doc.querySelectorAll=()=>[];h.doc.body.dataset.ownerCss="a".repeat(32); expect(h.options().observe().ownerCss).toBe("unknown"); h.entry.dispose();
});
it("#2118 guest status refreshes only the current Chat when its scoped placement content changes", async () => {
  const {guestStatus}=await import("../src/web-guest-access.js");
  env.nav.set({seq:2,route:{panel:"chat",instance:"own"}});
  const status=(own:string,peer:string)=>guestStatus({themes_rev:999,instances:[{name:"own",effect_chat_v:own},{name:"peer",effect_chat_v:peer}]},new Set(["own"]));
  const h=await rig(h=>Object.assign(h.doc.body.dataset,{tier:"guest",effectScope:"chat"}));h.api.changedChat.mockClear();
  const publish=(own:string,peer="c".repeat(32))=>env.app.set({...status(own,peer),themesRev:null,prefsRev:null});
  publish("a".repeat(32));expect(h.api.changedChat).toHaveBeenCalledTimes(1);
  publish("a".repeat(32),"d".repeat(32));expect(h.api.changedChat).toHaveBeenCalledTimes(1);
  publish("b".repeat(32));expect(h.api.changedChat).toHaveBeenCalledTimes(2);
  publish("e".repeat(32));expect(h.api.changedChat).toHaveBeenCalledTimes(3);h.entry.dispose();
});
