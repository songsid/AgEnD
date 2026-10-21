/** Owner choices never enter the shared host cache, and every operation belongs to the boot session. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthRequest, isServedAsset } from "../src/auth-api.js";
import { parseWebEffectManifest } from "../src/web-effect.js";
import { installDom, type MiniPage } from "./helpers/mini-dom.js";
const A = "a".repeat(32), B = "b".repeat(32), E = "e".repeat(16);
const KEYS = ["fx.sidebar", "fx.header", "fx.page", "fx.box", "fx.cursor"];
const slots = (id: string | null = A, status = "available") => Object.fromEntries(KEYS.map(key => [key, id === null ? { status: "none", id: null } : status === "available" ? { status, id, manifest: { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "canvas", title: "Canvas", regions: ["sidebar", "header", "page", "box"], layer: "behind", wants: [], box: { anchor: "center", width: 64, height: 64, offset: 0 }, cursor: { hotspot: [0, 0] } } } : { status, id }]));
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const held = () => { let release!: (r: any) => void; const p = new Promise<any>(r => { release = r; }); return { p, release }; };
const ticks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe("owner-effect client", () => {
  it("serves the static client and reviewed host runtime through the fixed asset map", () => {
    expect(isServedAsset("owner-effect-prefs.js")).toBe(true); expect(isServedAsset("effect-registry.js")).toBe(true);
    let status = 0, text = ""; const headers: Record<string, string> = {};
    const res = { setHeader(k: string, v: string) { headers[k] = v; }, writeHead(n: number) { status = n; }, end(s: string) { text = String(s); } };
    const url = new URL("http://127.0.0.1:19280/assets/owner-effect-prefs.js");
    expect(handleAuthRequest({ method: "GET", url: url.pathname, headers: {} } as any, res as any, url, { fleetConfig: { web: { experimental: { canvas_worker: true } } } } as any)).toBe(true);
    expect(status).toBe(200); expect(text).toContain("export function watchOwnerEffects");
  });
  let pg: MiniPage, now: number, requests: Array<{ url: string; init: any }>, stop: (() => void) | undefined;
  let respond: (url: string, init: any) => Promise<any>;
  beforeEach(() => { vi.resetModules(); now = 100; requests = []; vi.spyOn(performance, "now").mockImplementation(() => now); });
  afterEach(() => { stop?.(); stop = undefined; pg?.restore(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
  async function boot(opts: { scope?: string; epoch?: string | null; public?: boolean; view?: boolean; unreadable?: boolean } = {}) {
    pg = installDom({ storage: { "fx.page": B, agend_fx_page: B, agend_prefs_synced: "1" } });
    pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: { "fx.page": B, theme: "dark" }, ownerScope: opts.scope ?? "person", ownerEpoch: opts.epoch === undefined ? E : opts.epoch, unreadable: opts.unreadable }));
    if (opts.public) pg.document.body.setAttribute("data-public-link", "1");
    if (opts.view) pg.document.body.setAttribute("data-mode", "view-only");
    respond = async () => reply(200, { rev: 1, slots: slots() });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { requests.push({ url, init }); return respond(url, init); }));
    return import("/assets/owner-effect-prefs.js");
  }
  it("does no I/O until watched; exact slot and epoch authorize URLs, cursor never grants code", async () => {
    const m = await boot(); expect(requests).toEqual([]); expect(m.ownerEffectUrl("fx.page", A)).toBeNull();
    stop = m.watchOwnerEffects(); await ticks();
    expect(requests.map(r => r.url)).toEqual([`/ui/effects/owner?ownerEpoch=${E}`]);
    expect(m.ownerEffectUrl("fx.page", A)).toBe(`/ui/effects/resource/${A}?slot=fx.page&ownerEpoch=${E}`);
    expect(m.ownerEffectUrl("fx.page", B)).toBeNull(); expect(m.ownerEffectUrl("bad", A)).toBeNull();
    expect(m.ownerEffectUrl("fx.cursor", A)).toBeNull(); expect(m.ownerEffectUrl("fx.cursor", A, "cursor")).toContain("/cursor.png?slot=fx.cursor");
    expect([...pg.storage.values()]).toContain(B); // neither consumes nor rewrites an old device's stray owner data
  });
  it.each([{ scope: "none", epoch: null }, { public: true }, { view: true }, { epoch: "wrong" }])("no owner capability on unsupported boot %j", async opts => {
    const m = await boot(opts); stop = m.watchOwnerEffects(); await ticks(); expect(requests).toEqual([]);
    expect(await m.saveOwnerEffects({ "fx.page": A })).toEqual({ ok: false, error: "busy_or_unavailable" });
  });
  it.each(["👨‍👩‍👧".repeat(40), "x\u0301".repeat(40)])("actual watched selections accept a server-valid combined title", async title => {
    const m = await boot(), source = slots();
    for (const row of Object.values(source) as any[]) { const parsed = parseWebEffectManifest({ ...row.manifest, title }); expect(parsed.ok).toBe(true); if (!parsed.ok) throw Error("fixture"); row.manifest = parsed.manifest; }
    respond = async () => reply(200, { rev: 1, slots: source }); stop = m.watchOwnerEffects(); await ticks();
    expect(m.ownerEffectsStore.get().status).toBe("known"); expect(m.ownerEffectsStore.get().slots["fx.page"].manifest.title).toBe(title);
    expect(m.ownerEffectUrl("fx.page", A)).not.toBeNull(); expect(requests).toHaveLength(1);
  });
  it("explicit operator mode stays available and visibly distinguishable from a platform person", async () => {
    const m = await boot({ scope: "operator" }); stop = m.watchOwnerEffects(); await ticks();
    expect(m.ownerEffectsStore.get().scope).toBe("operator"); expect(m.ownerEffectsStore.get().status).toBe("known");
  });
  it("unreadable boot choices are never accepted as selections; only a fresh authorized response may recover", async () => {
    const m = await boot({ unreadable: true }); expect(m.ownerEffectsStore.get().status).toBe("unknown");
    respond = async () => reply(503, { error: "prefs_unreadable" }); stop = m.watchOwnerEffects(); await ticks();
    expect(m.ownerEffectsStore.get().status).toBe("unknown"); expect(m.ownerEffectUrl("fx.page", B)).toBeNull();
  });
  it.each([401, 403, 409])("%i revokes old-session work with no automatic retries", async code => {
    const m = await boot(); respond = async () => reply(code, {}); stop = m.watchOwnerEffects(); await ticks();
    expect(m.ownerEffectsStore.get().revoked).toBe(true); expect(await m.refreshOwnerEffects()).toBe(false);
    expect(await m.saveOwnerEffects({ "fx.page": A })).toEqual({ ok: false, error: "busy_or_unavailable" }); expect(requests).toHaveLength(1);
  });
  it("unknown errors retry only after five seconds of existing status activity; no private timer polling", async () => {
    const m = await boot(), app = await import("/assets/app-store.js"); respond = async () => reply(503, {});
    stop = m.watchOwnerEffects(); await ticks(); expect(requests).toHaveLength(1);
    now += 4999; app.appStore.set({ prefsRev: 1 }); await ticks(); // a new revision is an explicit invalidation
    expect(requests).toHaveLength(2);
    app.appStore.set({ connection: "open" }); await ticks(); expect(requests).toHaveLength(2);
    now += 5000; respond = async () => reply(200, { rev: 1, slots: slots() }); app.appStore.set({ connection: "open" }); await ticks();
    expect(requests).toHaveLength(3); expect(m.ownerEffectsStore.get().status).toBe("known");
  });
  it("one held physical read coalesces activity and is not replaced until it settles, even after unwatch/remount", async () => {
    const m = await boot(), app = await import("/assets/app-store.js"), h = held(); respond = () => h.p;
    stop = m.watchOwnerEffects(); app.appStore.set({ prefsRev: 2 }); app.appStore.set({ prefsRev: 3 });
    expect(requests).toHaveLength(1); stop!(); stop = m.watchOwnerEffects(); expect(requests).toHaveLength(1);
    respond = async () => reply(200, { rev: 3, slots: slots(B) }); h.release(reply(200, { rev: 1, slots: slots(A) })); await ticks();
    expect(requests).toHaveLength(2); expect(m.ownerEffectsStore.get().slots["fx.page"].id).toBe(B);
  });
  it.each([10000, 10001])("delayed timers cannot admit a resource answer at %ims", async delay => {
    const m = await boot(), h = held(); respond = () => h.p; stop = m.watchOwnerEffects(); now += delay;
    h.release(reply(200, { rev: 1, slots: slots() })); await ticks();
    expect(m.ownerEffectsStore.get().status).toBe("unknown"); expect(m.ownerEffectUrl("fx.page", A)).toBeNull();
  });
  it("9999ms answer is accepted; a clock rollback is refused", async () => {
    const m = await boot(), h = held(); respond = () => h.p; stop = m.watchOwnerEffects(); now += 9999;
    h.release(reply(200, { rev: 1, slots: slots() })); await ticks(); expect(m.ownerEffectsStore.get().status).toBe("known");
    const h2 = held(); respond = () => h2.p; const read = m.refreshOwnerEffects(); now--;
    h2.release(reply(200, { rev: 2, slots: slots(B) })); await read; expect(m.ownerEffectsStore.get().status).toBe("unknown");
  });
  it("a timed-out physical fetch stays reserved until settlement and cannot publish late", async () => {
    vi.useFakeTimers(); vi.spyOn(performance, "now").mockImplementation(() => now); const m = await boot(), h = held(); respond = () => h.p; stop = m.watchOwnerEffects();
    await vi.advanceTimersByTimeAsync(10000); expect(requests[0]!.init.signal.aborted).toBe(true);
    const second = m.saveOwnerEffects({ "fx.page": B }); await ticks(); expect(requests).toHaveLength(1);
    expect(await second).toEqual({ ok: false, error: "busy_or_unavailable" });
    h.release(reply(200, { rev: 2, slots: slots(B) })); await ticks(); expect(m.ownerEffectsStore.get().status).toBe("unknown"); expect(requests).toHaveLength(1);
  });
  it("writes snapshot the patch, never optimistically select, and read back only after matching acknowledgement", async () => {
    const m = await boot(); stop = m.watchOwnerEffects(); await ticks(); const h = held(); respond = () => h.p;
    const patch = { "fx.page": B }; const write = m.saveOwnerEffects(patch); patch["fx.page"] = A;
    expect(JSON.parse(requests[1]!.init.body)).toEqual({ set: { "fx.page": B }, ownerEpoch: E });
    expect(m.ownerEffectsStore.get().slots["fx.page"].id).toBe(A);
    const second = m.saveOwnerEffects({ "fx.page": A }); await ticks(); expect(requests).toHaveLength(2);
    expect(await second).toEqual({ ok: false, error: "busy_or_unavailable" });
    respond = async () => reply(200, { rev: 2, slots: slots(B) }); h.release(reply(200, { rev: 2, ownerEpoch: E, ownerScope: "person", values: { "fx.page": B } }));
    expect(await write).toEqual({ ok: true, saved: true, error: null }); expect(m.ownerEffectsStore.get().slots["fx.page"].id).toBe(B);
  });
  it.each(["epoch", "scope", "value", "revision", "unreadable"])("bad %s acknowledgement cannot start a follow-up read", async fault => {
    const m = await boot(); stop = m.watchOwnerEffects(); await ticks(); const body: any = { rev: 2, ownerEpoch: E, ownerScope: "person", values: { "fx.page": B } };
    if (fault === "epoch") body.ownerEpoch = "f".repeat(16); if (fault === "scope") body.ownerScope = "operator";
    if (fault === "value") body.values["fx.page"] = A; if (fault === "revision") body.rev = -1; if (fault === "unreadable") body.unreadable = true;
    respond = async () => reply(200, body); expect((await m.saveOwnerEffects({ "fx.page": B })).ok).toBe(false);
    expect(requests).toHaveLength(2); expect(m.ownerEffectsStore.get().status).toBe("unknown");
    if (["epoch", "scope"].includes(fault)) { expect(m.ownerEffectsStore.get().revoked).toBe(true); expect(await m.refreshOwnerEffects()).toBe(false); expect(requests).toHaveLength(2); }
  });
  it("an unavailable slot retains its id and can be cleared without a code fetch", async () => {
    const m = await boot(); stop = m.watchOwnerEffects(); await ticks(); m.markOwnerEffectUnavailable("fx.page", A);
    expect(m.ownerEffectsStore.get().slots["fx.page"]).toEqual({ status: "unavailable", id: A }); expect(m.ownerEffectUrl("fx.page", A)).toBeNull();
    respond = async (_url, init) => init.method === "POST" ? reply(200, { rev: 2, ownerEpoch: E, ownerScope: "person", values: {} }) : reply(200, { rev: 2, slots: slots(null) });
    expect(await m.saveOwnerEffects({ "fx.page": null })).toEqual({ ok: true, saved: true, error: null }); expect(m.ownerEffectsStore.get().slots["fx.page"]).toEqual({ status: "none", id: null });
    expect(requests.some(r => /resource|image/.test(r.url))).toBe(false);
  });
  it("closed response fields and invalid inputs stay unknown without requesting anything", async () => {
    const m = await boot(); expect(m.checkOwnerSlots({ rev: 0, slots: slots(null) })).not.toBeNull();
    for (const bad of [{ rev: -1, slots: slots() }, { rev: 0, slots: {} }, { rev: 0, slots: { ...slots(), "fx.page": { status: "available", id: A, manifest: { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "canvas", title: "Canvas", regions: ["sidebar", "header", "page", "box"], layer: "behind", wants: [], box: { anchor: "center", width: 64, height: 64, offset: 0 }, cursor: { hotspot: [0, 0] } }, private: true } } }]) expect(m.checkOwnerSlots(bad)).toBeNull();
    stop = m.watchOwnerEffects(); await ticks();
    for (const bad of [{ "theme": "dark" }, { "fx.page": "bad" }, {}, []]) expect((await m.saveOwnerEffects(bad)).ok).toBe(false);
    expect(requests).toHaveLength(1);
  });
  it("generic host preferences cannot cache, read, migrate or write owner keys", async () => {
    await boot(); const host = await import("/assets/app-prefs.js");
    expect(host.OWNER_EFFECT_PREF_KEYS).toEqual(KEYS); expect(host.SYNCED["fx.page"].ls).toBeNull(); expect(Object.isFrozen(host.SYNCED)).toBe(true); expect(Object.isFrozen(host.SYNCED["fx.page"])).toBe(true);
    expect(host.hostPref("fx.page")).toBeUndefined(); expect(host.prefInForce("fx.page")).toBeNull();
    vi.useFakeTimers(); host.savePref("fx.page", A); await vi.advanceTimersByTimeAsync(500); await ticks(); expect(requests).toEqual([]);
  });
});
