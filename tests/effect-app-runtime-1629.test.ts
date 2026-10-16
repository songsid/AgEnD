/** Unmounted host owner/contribution tests. Registry/loader are mocked here; their physical/cap suites are separate. */
import { describe, expect, it, vi } from "vitest";
import { isServedAsset } from "../src/auth-api.js";
const { createAppEffectRuntime } = await import(new URL("../src/ui/shared/effect-app-runtime.js", import.meta.url).href);
const { createEffectRuntimeLoader } = await import(new URL("../src/ui/shared/effect-runtime-loader.js", import.meta.url).href);
const id = "a".repeat(32), epoch = "b".repeat(16);
const held = () => { let resolve: (v?: any) => void = () => {}; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function rig(prepare: (h: any) => void = () => {}) {
  let now = 0, live = true, ended = false, seq = 0, options: any, rows: any[] = [];
  const listeners = new Set<() => void>(), events = new Map<string, () => void>(), timers = new Map<number, () => void>(), values: any = { ownerEpoch: epoch, ownerScope: "person" };
  const host: any = { document: { body: { dataset: { mode: "full", previewOrigin: "https://preview.invalid", previewBoot: "c".repeat(32) } }, documentElement: { getAttribute: () => JSON.stringify(values) } },
    AgendAuth: { sessionEnded: () => ended, onSessionEnd: vi.fn((fn: () => void) => { listeners.add(fn); if (ended) fn(); return () => listeners.delete(fn); }) }, performance: { now: () => now },
    AbortController, localStorage: {}, crypto: {}, fetch: vi.fn(async () => ({ ok: true, body: { cancel: async () => {} } })),
    setTimeout(fn: () => void) { timers.set(++seq, fn); return seq; }, clearTimeout(n: number) { timers.delete(n); },
    addEventListener: vi.fn((type: string, fn: () => void) => events.set(type, fn)), removeEventListener: vi.fn((type: string) => events.delete(type)),
  };
  const placement = { id, by: "agent", at: 1, manifest: { title: "Effect", regions: ["chat"], layer: "front" }, params: { n: 1 } };
  const loader = { ok: true, placementsSettled: vi.fn(async () => ({ rev: 1, effects: [placement] })), resourceSettled: vi.fn(async () => ({ id, params: { n: 1 } })), dispose: vi.fn() };
  const registry = { ok: true, update: vi.fn((ds: any[]) => { rows = ds.map(d => ({ ...d, verdict: "active", phase: "running" })); }), snapshot: () => rows, resume: vi.fn(() => true), publish: vi.fn(), dispose: vi.fn() };
  const collectors: any[] = [], collect = () => { const c = { ok: true, add: vi.fn(), report: vi.fn(() => ({ profile: { v: 1, device: "standard" } })), dispose: vi.fn() }; collectors.push(c); return c; };
  const context: any = { safe: false, publicLink: false, reducedMotion: false, saveData: false, hidden: false, enabled: true, show: true, previewReady: true, optIn: true, constrained: false, modal: false, openInstance: "caller-not-authority" };
  const observation: any = { context, ownerCss: "off", mode: "light" }, globalChange = vi.fn();
  const h: any = { host, values, loader, registry, collectors, context, observation, globalChange, placement, listeners, events, at(t: number) { now = t; }, stale() { live = false; }, signOut() { ended = true; for (const fn of [...listeners]) fn(); }, options: () => options };
  prepare(h);
  h.factories = { loader: vi.fn((o: any) => h.realLoader ? createEffectRuntimeLoader(o) : loader), registry: vi.fn((o: any) => { options = o; return registry; }), safety: vi.fn(), stock: vi.fn(() => ({ ok: true })), collector: collect };
  h.api = createAppEffectRuntime({ window: host, current: () => h.current ? h.current() : live, observe: () => h.observe ? h.observe() : observation, onChange: globalChange, factories: h.factories });
  h.chat = (name = "own", patch: any = {}) => { const part: any = { element: { isConnected: true }, current: () => true, observe: () => ({ state: "working" }), onChange: vi.fn(), ...patch }; part.api = h.api.attachChat({ name, ...part }); return part; };
  return h;
}
describe("#1629 one unmounted app-owned effect pool", () => {
  it("serves the static core for the session-only app bridge", () => expect(isServedAsset("effect-app-runtime.js")).toBe(true));
  it.each(["public", "poll", "view", "header", "epoch", "auth", "ended"])("%s cannot create participants", fault => {
    const h = rig(h => {
      if (fault === "public") h.host.document.body.dataset.publicLink = "1"; if (fault === "poll") h.host.document.body.dataset.webTransport = "poll";
      if (fault === "view") h.host.document.body.dataset.mode = "view-only"; if (fault === "header") h.values.ownerScope = "none"; if (fault === "epoch") h.values.ownerEpoch = "unknown";
      if (fault === "auth") delete h.host.AgendAuth.onSessionEnd; if (fault === "ended") h.host.AgendAuth.onSessionEnd = (fn: () => void) => { fn(); return () => {}; };
    });
    expect(h.api.ok).toBe(false); expect(h.factories.loader).not.toHaveBeenCalled(); expect(h.factories.registry).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("creates exactly one pool across route detach/replace and never reads with no Chat contributor", async () => {
    const h = rig(); h.api.sync(); expect(h.loader.placementsSettled).not.toHaveBeenCalled();
    const a = h.chat("a"); await flush(); const key = a.api.snapshot().rows[0].key;
    h.api.detachChat(); const b = h.chat("b"); await flush(); a.api.dispose();
    expect(h.factories.loader).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce(); expect(h.registry.dispose).not.toHaveBeenCalled(); expect(h.loader.dispose).not.toHaveBeenCalled();
    expect(b.api.snapshot().rows[0].key).not.toBe(key); expect(b.api.snapshot().rows[0]).toMatchObject({ instance: "b", id, by: "agent", params: { n: 1 } });
    expect(h.registry.update.mock.calls.at(-1)[1].openInstance).toBe("b"); h.api.dispose();
  });
  it("waits for old physical metadata settlement before admitting the next route read", async () => {
    const h = rig(), first = held(); h.loader.placementsSettled.mockImplementationOnce(() => first.promise); const a = h.chat("a"); await flush();
    const signal = h.loader.placementsSettled.mock.calls[0][1]; a.api.dispose(); const b = h.chat("b"); await flush();
    expect(signal.aborted).toBe(true); expect(h.loader.placementsSettled).toHaveBeenCalledTimes(1); expect(b.api.snapshot()).toMatchObject({ error: null, effects: [], loading: true });
    first.resolve({ rev: 0, effects: [{ ...h.placement, by: "human" }] }); await flush();
    expect(h.loader.placementsSettled).toHaveBeenCalledTimes(2); expect(h.loader.placementsSettled.mock.calls[1][0]).toBe("b"); expect(b.api.snapshot().effects[0].by).toBe("agent");
    expect(h.registry.update.mock.calls.some((c: any) => c[0].some((d: any) => d.by === "human"))).toBe(false); h.api.dispose();
  });
  it("a changed current revision aborts but does not overlap its old metadata; stale answer cannot repopulate", async () => {
    const h = rig(), first = held(); h.loader.placementsSettled.mockImplementationOnce(() => first.promise); const a = h.chat(); await flush(); a.api.changed();
    expect(h.registry.update.mock.calls.at(-1)[0]).toEqual([]); expect(h.loader.placementsSettled).toHaveBeenCalledTimes(1);
    first.resolve({ rev: 0, effects: [{ ...h.placement, by: "human" }] }); await flush(); expect(a.api.snapshot().effects[0].by).toBe("agent"); expect(h.loader.placementsSettled).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it("resource dispatch requires the exact current host key, never the id alone", async () => {
    const h = rig(), a = h.chat("a /&"); await flush(); const row = a.api.snapshot().rows[0];
    expect(await h.options().load({ id }, new AbortController().signal)).toBeNull(); expect(h.loader.resourceSettled).not.toHaveBeenCalled();
    expect(await h.options().load(row, new AbortController().signal)).toMatchObject({ id }); expect(h.loader.resourceSettled).toHaveBeenCalledWith({ id, instance: "a /&" }, expect.any(AbortSignal));
    expect(await h.options().load({ ...row, id: "f".repeat(32) }, new AbortController().signal)).toBeNull(); expect(h.loader.resourceSettled).toHaveBeenCalledTimes(1); h.api.dispose();
  });
  it.each([null, { id }])("a late old resource cannot publish or fail the next route with the same content id (%s)", async result => {
    const h = rig(), a = h.chat("a"); await flush(); const first = held(); h.loader.resourceSettled.mockImplementationOnce(() => first.promise);
    const read = h.options().load(a.api.snapshot().rows[0], new AbortController().signal); const b = h.chat("b"); await flush(); first.resolve(result);
    expect(await read).toBeNull(); expect(b.api.snapshot().error).toBeNull(); expect(b.api.snapshot().effects).toHaveLength(1); expect(h.registry.dispose).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("failed resources latch only their contribution; another route reuses the healthy app pool", async () => {
    const h = rig(), a = h.chat("a"); await flush(); h.loader.resourceSettled.mockResolvedValueOnce(null); expect(await h.options().load(a.api.snapshot().rows[0], new AbortController().signal)).toBeNull();
    expect(a.api.snapshot().error).toBe("resource_unavailable"); a.api.changed(); a.api.sync(); expect(h.loader.placementsSettled).toHaveBeenCalledTimes(1);
    const b = h.chat("b"); await flush(); expect(b.api).not.toBeNull(); expect(b.api.snapshot().error).toBeNull(); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it.each(["signout", "pagehide", "page", "dispose"])("%s ends the page episode once, fencing held answers and stale handles", async fault => {
    const h = rig(), first = held(); h.loader.placementsSettled.mockImplementationOnce(() => first.promise); const a = h.chat(); await flush();
    if (fault === "signout") h.signOut(); if (fault === "pagehide") h.events.get("pagehide")(); if (fault === "page") { h.stale(); h.api.sync(); } if (fault === "dispose") h.api.dispose();
    expect(h.loader.dispose).toHaveBeenCalledOnce(); expect(h.registry.dispose).toHaveBeenCalledOnce(); first.resolve({ rev: 0, effects: [h.placement] }); await flush();
    expect(h.api.attachChat({ name: "b", ...a })).toBeNull(); expect(a.api.snapshot().effects).toEqual([]); h.api.dispose(); expect(h.registry.dispose).toHaveBeenCalledOnce();
  });
  it.each(["stale", "detached"])("%s Chat retires just the contribution, preserving the app owner", async fault => {
    const h = rig(); let live = true; const a = h.chat("a", { current: () => live }); await flush(); if (fault === "stale") live = false; else a.element.isConnected = false;
    h.api.sync(); expect(h.registry.update.mock.calls.at(-1)[0]).toEqual([]); expect(h.registry.dispose).not.toHaveBeenCalled(); expect(a.api.snapshot().effects).toEqual([]); h.api.dispose();
  });
  it("pause state and params survive unrelated revisions; Resume uses the contribution key", async () => {
    const h = rig(), a = h.chat(); await flush(); expect(a.api.pause(id)).toBe(true); const key = a.api.snapshot().rows[0].key;
    a.api.changed(); await flush(); expect(a.api.snapshot().rows[0]).toMatchObject({ paused: true, by: "agent", params: { n: 1 } });
    expect(a.api.resume(id)).toBe(true); expect(h.registry.resume).toHaveBeenCalledWith(key); h.api.dispose();
  });
  it("reply/state belong only to the currently live contributor; no mention or event content", async () => {
    const h = rig(), a = h.chat("a"); await flush(); const b = h.chat("b"); await flush(); h.registry.publish.mockClear();
    a.api.reply({ instance: "a", text: "secret" }); b.api.reply({ instance: "a", text: "secret" }); expect(h.registry.publish).not.toHaveBeenCalled();
    b.api.reply({ instance: "b", text: "secret", targets: ["private"] }); expect(h.registry.publish).toHaveBeenCalledExactlyOnceWith("reply", {}, "b"); h.registry.publish.mockClear();
    b.api.sync(); expect(h.registry.publish).toHaveBeenCalledWith("state", { state: "working" }, "b"); expect(h.registry.publish.mock.calls.some((c: any) => JSON.stringify(c).includes("secret") || c[0] === "mention")).toBe(false); h.api.dispose();
  });
  it("profiles are bound to the exact current receipt/key and its captured instance scope", async () => {
    const h = rig(), a = h.chat("a /&"); await flush(); const row = a.api.snapshot().rows[0], owner = { ...row, device: "standard", current: () => true };
    h.options().onMount(owner); h.at(10000); h.options().onProfile({ verdict: "ok" }, owner); await flush();
    expect(h.host.fetch).toHaveBeenCalledWith(`/ui/effects/profile/${id}?instance=a%20%2F%26&ownerEpoch=${epoch}`, expect.objectContaining({ method: "POST", body: JSON.stringify({ v: 1, device: "standard" }) }));
    h.chat("b"); await flush(); h.at(20000); h.options().onProfile({ verdict: "paused" }, owner); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(1); h.api.dispose();
  });
  it("a disposed Window episode cannot create another app owner, including BFCache reinitialization", () => {
    const h = rig(); h.api.dispose(); const create = () => createAppEffectRuntime({ window: h.host, current: () => true, observe: () => h.observation, factories: h.factories });
    expect(create().ok).toBe(false); expect(h.factories.loader).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce();
  });
  it("reentrant route attachment during retirement survives the older sync pass", async () => {
    const h = rig(), a = h.chat("a"); await flush(); const ordinary = h.registry.update.getMockImplementation(); let nested: any = null, once = true;
    h.registry.update.mockImplementation((ds: any[], context: any) => { ordinary(ds, context); if (!ds.length && once) { once = false; nested = h.chat("b"); } });
    h.api.detachChat(); await flush(); expect(nested.api.snapshot().effects).toHaveLength(1); expect(nested.api.snapshot().rows[0].instance).toBe("b");
    a.api.dispose(); expect(nested.api.snapshot().rows[0].instance).toBe("b"); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a lease predicate that disposes cannot return a valid old contributor", async () => {
    const h = rig(); let stop = false; const a = h.chat("a", { current: () => { if (stop) h.api.dispose(); return true; } }); await flush();
    h.registry.update.mockClear(); h.registry.publish.mockClear(); stop = true; a.api.sync();
    expect(h.registry.update).not.toHaveBeenCalled(); expect(h.registry.publish).not.toHaveBeenCalled(); expect(a.api.snapshot().effects).toEqual([]);
  });
  it("an observer that replaces the route cannot publish old metadata or scope", async () => {
    const h = rig(), a = h.chat("a"); await flush(); let once = true, nested: any;
    h.observe = () => { if (once) { once = false; nested = h.chat("b"); } return h.observation; };
    h.api.sync(); await flush(); expect(nested.api.snapshot().rows[0].instance).toBe("b"); expect(a.api.snapshot().effects).toEqual([]); h.api.dispose();
  });
  it("an old Remove completion cannot invalidate the newer contributor", async () => {
    const h = rig(), a = h.chat("a"); await flush(); const answer = held(); h.host.fetch.mockImplementationOnce(() => answer.promise);
    const remove = a.api.remove(id); await flush(); const b = h.chat("b"); await flush(); answer.resolve({ ok: true, body: { cancel: async () => {} } });
    expect(await remove).toBe(false); expect(b.api.snapshot().effects).toHaveLength(1); expect(h.loader.placementsSettled).toHaveBeenCalledTimes(2); h.api.dispose();
  });

  it("real loader integration: old late-body cancellation retains the one metadata lane across Chat handoff", async () => {
    const first = held(), cancellation = held(), cancel = vi.fn(() => cancellation.promise);
    const manifest = { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat"], layer: "behind", wants: [] };
    const answer = { rev: 1, effects: [{ id, by: "agent", at: 1, manifest, params: {} }] };
    const h = rig(h => { h.realLoader = true; h.host.fetch.mockImplementation(async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } })); h.host.fetch.mockImplementationOnce(() => first.promise); });
    const a = h.chat("a"); await flush(); const b = h.chat("b"); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(1); expect(a.api.snapshot().effects).toEqual([]);
    first.resolve({ ok: true, status: 200, body: { cancel } }); await flush(); expect(cancel).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledTimes(1); expect(b.api.snapshot().loading).toBe(true);
    cancellation.resolve(); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(2); expect(h.host.fetch.mock.calls[1][0]).toBe(`/ui/effects/placements?instance=b&ownerEpoch=${epoch}`);
    expect(b.api.snapshot().rows[0]).toMatchObject({ instance: "b", id }); h.api.dispose();
  });

  it("one throwing participant cannot prevent the rest of page cleanup", async () => {
    const h = rig(), a = h.chat(); await flush(); h.registry.dispose.mockImplementation(() => { throw Error("inert registry failure"); });
    expect(() => h.api.dispose()).not.toThrow(); expect(h.loader.dispose).toHaveBeenCalledOnce(); expect(h.listeners.size).toBe(0); expect(h.events.size).toBe(0); expect(a.api.snapshot().effects).toEqual([]);
  });
  it.each(["subscribe", "pagehide"])("a throwing %s setup is unavailable and leaks no participant", fault => {
    const h = rig(h => { if (fault === "subscribe") h.host.AgendAuth.onSessionEnd = () => { throw Error("inert subscription failure"); }; else h.host.addEventListener = () => { throw Error("inert event failure"); }; });
    expect(h.api.ok).toBe(false); expect(h.factories.loader).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0); h.api.dispose();
  });

  it("claims the Window before a current/auth callback can recursively create another owner", () => {
    let nested: any = null;
    const h = rig(h => { h.current = () => { if (!nested) nested = createAppEffectRuntime({ window: h.host, current: () => true, observe: () => h.observation, factories: h.factories }); return true; }; });
    expect(nested.ok).toBe(false); expect(h.api.ok).toBe(true); expect(h.factories.loader).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });

  it("page-level revision/reply forwarding targets only the current Chat contribution", async () => {
    const h = rig(), a = h.chat("a"); await flush(); const b = h.chat("b"); await flush(); h.registry.publish.mockClear();
    h.api.reply({ instance: "a" }); expect(h.registry.publish).not.toHaveBeenCalled(); h.api.reply({ instance: "b", text: "secret" }); expect(h.registry.publish).toHaveBeenCalledExactlyOnceWith("reply", {}, "b");
    h.api.changedChat(); await flush(); expect(h.loader.placementsSettled).toHaveBeenCalledTimes(3); expect(h.loader.placementsSettled.mock.calls[2][0]).toBe("b");
    h.api.detachChat(); h.registry.publish.mockClear(); h.api.reply({ instance: "b" }); h.api.changedChat(); expect(h.registry.publish).not.toHaveBeenCalled(); expect(a.api.snapshot().effects).toEqual([]); h.api.dispose();
  });

  it("a current predicate attaching B cannot make the outer pass discard B instead of A", async () => {
    const h = rig(); let replace = false, nested: any = null;
    const a = h.chat("a", { current: () => { if (replace) { replace = false; nested = h.chat("b"); } return true; } }); await flush();
    replace = true; a.api.sync(); await flush(); expect(nested.api).not.toBeNull();
    expect(nested.api.snapshot().effects).toHaveLength(1); expect(nested.api.snapshot().rows[0]).toMatchObject({ instance: "b", id });
    a.api.dispose(); expect(nested.api.snapshot().rows[0].instance).toBe("b"); expect(h.factories.registry).toHaveBeenCalledOnce(); expect(h.factories.loader).toHaveBeenCalledOnce(); h.api.dispose();
  });

});
