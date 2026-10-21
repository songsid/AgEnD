/** The selector displays host state and writes ids/null only. It never fetches Worker code or starts playback. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent } from "./helpers/mini-dom.js";
const fx = vi.hoisted(() => ({ entry: null as any }));
vi.mock("/ui/js/app-effects.js", () => ({ getAppEffects: () => fx.entry }));
const A = "a".repeat(32), B = "b".repeat(32), E = "e".repeat(16), g = globalThis as any;
const KEYS = ["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"];
const manifest = { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "snow", title: "Snow", regions: ["sidebar", "header", "page", "box"], layer: "behind", wants: [], box: { anchor: "center", width: 100, height: 100, offset: 0 }, cursor: { hotspot: [0, 0] } };
const catalog = { canWrite: true, effects: [{ id: A, manifest }] };
const empty = () => Object.fromEntries(KEYS.map(k => [k, { status: "none", id: null }]));
const response = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
let p: AppPage | null = null, calls: Array<{ url: string; init: any }> = [], view: any, rev = 1;
let override: ((url: string, init: any) => any) | null = null;
const ticks = async () => { await settle(); await settle(); };
afterEach(async () => { if (p) { await p.unmount(); p.restore(); p = null; } delete g.fetch; fx.entry = null; });
async function mount(opts: { canWrite?: boolean; slots?: any; lang?: string; fail?: number; operator?: boolean } = {}) {
  p = page({ url: "http://127.0.0.1:19280/settings/appearance" });
  (await import("/assets/app-store.js")).appStore.set({ canvasWorker: true });
  p.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {}, ownerEpoch: E, ownerScope: "person" }));
  calls = []; rev++; view = opts.slots || empty(); override = null;
  g.fetch = async (url: string, init: any = {}) => {
    calls.push({ url, init }); if (override) return override(url, init);
    if (opts.fail) return response(opts.fail, {});
    if (init.method === "POST") {
      const body = JSON.parse(init.body); rev++;
      for (const [key, id] of Object.entries(body.set)) view[key] = id === null ? { status: "none", id: null } : { status: "available", id, manifest };
      return response(200, { rev, ownerEpoch: E, ownerScope: "person", values: Object.fromEntries(Object.entries(view).filter(([, v]: any) => v.id !== null).map(([k, v]: any) => [k, v.id])) });
    }
    return response(200, { rev, slots: view });
  };
  (await import("/assets/app-i18n.js")).setLang(opts.lang || "en", { store: false });
  const owner = await import("/assets/owner-effect-prefs.js"); owner.ownerEffectsStore.set({ scope: opts.operator ? "operator" : "person", revoked: false });
  const { OwnerEffects } = await import("/ui/js/settings-owner-effects.js");
  await p.mount(h(OwnerEffects, { catalog: { ...catalog, canWrite: opts.canWrite !== false } })); await ticks();
}
const $ = (selector: string) => p!.root.querySelector(selector);
const text = () => p!.root.textContent;
const change = async (key: string, value: string) => { const el = $(`[data-owner-slot="${key}"]`); el.value = value; el.dispatchEvent(new MiniEvent("change", { bubbles: true })); await ticks(); };
function runtime() {
  const listeners = new Set<any>(), ends = new Set<any>(), snapshot: any = { slots: empty(), rows: [{ id: A, slot: "fx.page", phase: "running", verdict: "active", reason: null }] };
  const entry: any = { dead: false, gates: () => ({ enabled: true, show: true, transportReady: true, optIn: true }), subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); }, onEnd: (fn: any) => { ends.add(fn); return () => ends.delete(fn); } };
  entry.api = { ownerSnapshot: () => snapshot, changedOwner: vi.fn(), pauseOwner: vi.fn((key: string) => { snapshot.rows[0].reason = "paused"; for (const fn of [...listeners]) fn(); return key === "fx.page"; }), resumeOwner: vi.fn((_key: string) => true) }; fx.entry = entry;
  return { entry, snapshot, listeners, ends, changed() { for (const fn of [...listeners]) fn(); } };
}
describe("owner effect selectors", () => {
  it("rerenders an external authoritative selection after a previous Clear", async () => {
    const live = runtime(); await mount({ slots: { ...empty(), "fx.page": { id: A, status: "available", manifest } } });
    $('[data-owner-clear="fx.page"]').click(); await ticks();
    const module = await import("/assets/owner-effect-prefs.js"); module.ownerEffectsStore.set({ slots: { ...empty(), "fx.header": { id: A, status: "available", manifest } } });
    live.snapshot.slots = { ...empty(), "fx.header": { id: A, status: "available", manifest } }; live.snapshot.rows = [{ id: A, slot: "fx.header", phase: "running" }]; live.changed(); await ticks();
    expect($('[data-owner-slot="fx.header"]').value).toBe(A); expect($('[data-owner-pause="fx.header"]')).not.toBeNull(); $('[data-owner-pause="fx.header"]').click(); await ticks(); expect(live.entry.api.pauseOwner).toHaveBeenCalledExactlyOnceWith("fx.header");
  });
  it("runtime status and Pause/Resume use the exact slot without writing preferences or creating playback", async () => {
    const live = runtime(); await mount({ slots: { ...empty(), "fx.page": { id: A, status: "available", manifest } } });
    expect($('[data-owner-runtime="fx.page"]').textContent).toBe("Running"); calls = [];
    $('[data-owner-pause="fx.page"]').click(); await ticks(); expect(live.entry.api.pauseOwner).toHaveBeenCalledExactlyOnceWith("fx.page"); expect($('[data-owner-runtime="fx.page"]').textContent).toBe("Paused");
    $('[data-owner-resume="fx.page"]').click(); await ticks(); expect(live.entry.api.resumeOwner).toHaveBeenCalledExactlyOnceWith("fx.page"); expect(calls).toEqual([]); expect(p!.root.querySelectorAll("iframe,canvas")).toHaveLength(0);
    live.snapshot.rows[0].reason = "host_budget"; live.changed(); await ticks(); expect(text()).toContain("Paused to keep the page responsive.");
    live.entry.api.resumeOwner.mockReturnValueOnce(false); $('[data-owner-resume="fx.page"]').click(); await ticks(); expect(text()).toContain("This effect cannot resume");
    await p!.unmount(); expect(live.listeners.size).toBe(0); expect(live.ends.size).toBe(0);
  });
  it("a runtime-only unavailable selection retains Clear and never silently edits the saved id", async () => {
    const live = runtime(); live.snapshot.slots["fx.page"] = { id: A, status: "unavailable" }; await mount({ slots: { ...empty(), "fx.page": { id: A, status: "available", manifest } }, lang: "zh-TW" });
    expect(text()).toContain("已無法使用"); expect($('[data-owner-clear="fx.page"]')).not.toBeNull(); expect($('[data-owner-pause="fx.page"]')).toBeNull(); expect(calls.some(c => c.init.method === "POST")).toBe(false);
    $('[data-owner-clear="fx.page"]').click(); await ticks(); expect(JSON.parse(calls.find(c => c.init.method === "POST")!.init.body).set).toEqual({ "fx.page": null });
  });
  it("explicit Reload and successful Save invalidate runtime metadata, without trusting the Settings GET as its answer", async () => {
    const live = runtime(); await mount(); live.entry.api.changedOwner.mockClear();
    const reload = p!.root.querySelectorAll("button").find((b: any) => b.textContent === "Reload choices"); reload.click(); await ticks(); expect(live.entry.api.changedOwner).toHaveBeenCalledOnce();
    await change("fx.page", A); expect(live.entry.api.changedOwner).toHaveBeenCalledTimes(2); expect(live.snapshot.slots["fx.page"]).toEqual({ status: "none", id: null });
  });
  it("filters manifest declarations for four regions plus host cursor without granting Worker access", async () => {
    await mount();
    const { ownerEffectFits: fits } = await import("/ui/js/settings-owner-effects.js");
    expect(KEYS.map(k => fits(manifest, k))).toEqual([true, true, true, true, true]);
    expect(fits({ regions: ["chat"] }, "fx.page")).toBe(false); expect(fits({ regions: ["box"] }, "fx.box")).toBe(false);
    expect(fits({}, "fx.cursor")).toBe(false); expect(fits(manifest, "fx.other")).toBe(false);
  });
  it("shows five choices, platform scope and playback gates; saves only exact id and epoch", async () => {
    await mount(); expect(p!.root.querySelectorAll("[data-owner-slot]")).toHaveLength(5);
    expect(text()).toContain("Follows your sign-in; Discord and Telegram are separate."); expect(text()).toContain("Effects don't require HTML-preview permission.");
    await change("fx.page", A);
    const posts = calls.filter(c => c.init.method === "POST"); expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.init.body)).toEqual({ set: { "fx.page": A }, ownerEpoch: E });
    expect($('[data-owner-slot="fx.page"]').value).toBe(A); expect(text()).toContain("Saved.");
    expect(calls.every(c => /^\/ui\/(?:prefs$|effects\/owner\?ownerEpoch=)/.test(c.url))).toBe(true);
    expect(p!.root.querySelectorAll("iframe, canvas")).toHaveLength(0);
  });
  it("explicit host operator scope is labelled shared, in both languages", async () => {
    await mount({ operator: true }); expect(text()).toContain("Shared by everyone signed in as the host.");
    (await import("/assets/app-i18n.js")).setLang("zh-TW", { store: false });
    (await import("/assets/owner-effect-prefs.js")).ownerEffectsStore.set({ scope: "operator" }); await ticks();
    expect(text()).toContain("所有以主機身分登入的人共用。");
    expect(text()).toContain("效果不需要 HTML 預覽權限。");
  });
  it("unavailable choices retain their id, show a clear action and clear only by explicit click", async () => {
    await mount({ slots: { ...empty(), "fx.page": { status: "unavailable", id: B } }, lang: "zh-TW" });
    expect(text()).toContain("已無法使用"); expect($('[data-owner-slot="fx.page"]').value).toBe(B);
    expect(calls.filter(c => c.init.method === "POST")).toHaveLength(0);
    $('[data-owner-clear="fx.page"]').click(); await ticks();
    expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
    expect(JSON.parse(calls.find(c => c.init.method === "POST")!.init.body)).toEqual({ set: { "fx.page": null }, ownerEpoch: E });
    expect($('[data-owner-clear="fx.page"]')).toBeNull(); expect(text()).toContain("已儲存。");
  });
  it("read-only selection and Clear are disabled; unknown state offers reload without synthesizing empty choices", async () => {
    await mount({ canWrite: false, slots: { ...empty(), "fx.page": { status: "unavailable", id: B } } });
    expect($('[data-owner-slot="fx.page"]').disabled).toBe(true); expect($('[data-owner-clear="fx.page"]').disabled).toBe(true);
    expect(text()).toContain("Sign in as an admin"); await change("fx.page", A); expect(calls.some(c => c.init.method === "POST")).toBe(false);
    const owner = await import("/assets/owner-effect-prefs.js"); override = () => response(503, {}); await owner.refreshOwnerEffects(); await ticks();
    expect(p!.root.querySelectorAll("[data-owner-slot]")).toHaveLength(0); expect(text()).toContain("Choices are unavailable.");
  });
  it("claims a write synchronously and discards messages after unmount; no second intent is sent", async () => {
    await mount(); let release!: (v: any) => void;
    override = () => new Promise(r => { release = r; });
    await change("fx.page", A); await change("fx.header", A); expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
    await p!.unmount(); release(response(200, { rev: 2, ownerEpoch: E, ownerScope: "person", values: { "fx.page": A } })); await ticks();
    expect(p!.root.textContent).toBe(""); expect(calls.filter(c => c.init.method === "POST")).toHaveLength(1);
  });
});


describe("cursor status remains a selector, never another runtime", () => {
  it("shows current cursor status and Clear without Worker Pause/Resume or a code read", async () => {
    const live = runtime(), state = { id: A, status: "running" }; live.entry.cursorSnapshot = () => state;
    await mount({ slots: { ...empty(), "fx.cursor": { id: A, status: "available", manifest } } }); expect($('[data-owner-runtime="fx.cursor"]').textContent).toBe("Running"); expect($('[data-owner-pause="fx.cursor"]')).toBeNull(); expect($('[data-owner-resume="fx.cursor"]')).toBeNull();
    state.status = "unavailable"; live.changed(); await ticks(); expect(text()).toContain("The cursor could not be applied here"); expect($('[data-owner-clear="fx.cursor"]')).not.toBeNull(); expect(calls.every(c => !c.url.includes("/resource/") && !c.url.includes("/image/"))).toBe(true);
    $('[data-owner-clear="fx.cursor"]').click(); await ticks(); expect($('[data-owner-slot="fx.cursor"]').value).toBe(""); expect(calls.filter(c => c.init.method === "POST").map(c => JSON.parse(c.init.body))).toContainEqual({ set: { "fx.cursor": null }, ownerEpoch: E });
  });
});
