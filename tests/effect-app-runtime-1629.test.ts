/** Host owner/contribution tests. Registry/loader are mocked here; their physical/cap suites are separate. */
import { describe, expect, it, vi } from "vitest";
import { isServedAsset } from "../src/auth-api.js";
const { createAppEffectRuntime } = await import(new URL("../src/ui/shared/effect-app-runtime.js", import.meta.url).href);
const { createEffectRuntimeLoader } = await import(new URL("../src/ui/shared/effect-runtime-loader.js", import.meta.url).href);
const id = "a".repeat(32), epoch = "b".repeat(16);
const ownerSlots = ["fx.page", "fx.header", "fx.sidebar", "fx.box"];
const ownerBody = (selected = id, rev = 1) => ({ rev, slots: { ...Object.fromEntries(ownerSlots.map(slot => [slot, { id: selected, status: "available", manifest: { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat", "page", "header", "sidebar", "box"], layer: "front", wants: [], box: { anchor: "center", width: 100, height: 80, offset: 0 } } }])), "fx.cursor": { id: null, status: "none" } } });
const personal = (h: any) => { h.targets = Object.fromEntries(ownerSlots.map(slot => [slot, { isConnected: true }])); h.resolveOwnerTarget = vi.fn((slot: string) => h.targets[slot]); h.onOwnerUnavailable = vi.fn(); };
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
  const loader = { ok: true, ownerSettled: vi.fn(async (): Promise<any> => ownerBody()), placementsSettled: vi.fn(async () => ({ rev: 1, effects: [placement] })), resourceSettled: vi.fn(async () => ({ id, params: { n: 1 } })), cursorImageSettled: vi.fn(async (): Promise<any> => new Uint8Array([1, 2, 3])), dispose: vi.fn() };
  const registry = { ok: true, frameRoot: { isConnected: true }, update: vi.fn((ds: any[]) => { rows = ds.map(d => ({ ...d, verdict: "active", phase: "running" })); }), snapshot: () => rows, resume: vi.fn(() => true), publish: vi.fn(), dispose: vi.fn() };
  const collectors: any[] = [], collect = () => { const c = { ok: true, add: vi.fn(), report: vi.fn(() => ({ profile: { v: 1, device: "standard" } })), dispose: vi.fn() }; collectors.push(c); return c; };
  const context: any = { safe: false, publicLink: false, reducedMotion: false, saveData: false, hidden: false, enabled: true, show: true, previewReady: true, optIn: true, trialReady: true, constrained: false, modal: false, openInstance: "caller-not-authority" };
  const observation: any = { context, ownerCss: "off", mode: "light" }, globalChange = vi.fn();
  const h: any = { host, values, loader, registry, collectors, context, observation, globalChange, placement, listeners, events, at(t: number) { now = t; }, stale() { live = false; }, signOut() { ended = true; for (const fn of [...listeners]) fn(); }, options: () => options };
  prepare(h);
  h.factories = { ...(h.trialFactory ? { trialSource: h.trialFactory } : {}), loader: vi.fn((o: any) => { h.loaderOptions = o; return h.realLoader ? createEffectRuntimeLoader(o) : loader; }), registry: vi.fn((o: any) => { options = o; return registry; }), safety: vi.fn(), stock: vi.fn(() => ({ ok: true, front: true, agentFront: true, rects: [] })), collector: collect };
  h.api = createAppEffectRuntime({ window: host, current: () => h.current ? h.current() : live, observe: () => h.observe ? h.observe() : observation, onChange: globalChange, onDispose: h.onDispose, resolveOwnerTarget: h.resolveOwnerTarget, onOwnerUnavailable: h.onOwnerUnavailable, factories: h.factories });
  h.chat = (name = "own", patch: any = {}) => { const part: any = { element: { isConnected: true }, current: () => true, observe: () => ({ state: "working" }), onChange: vi.fn(), ...patch }; part.api = h.api.attachChat({ name, ...part }); return part; };
  return h;
}
describe("#1629 one app-owned effect pool", () => {
  it("serves the static core for the session-only app bridge", () => expect(isServedAsset("effect-app-runtime.js")).toBe(true));
  it.each(["public", "poll", "view", "header", "epoch", "auth", "ended"])("%s cannot create participants", fault => {
    const h = rig(h => {
      if (fault === "public") h.host.document.body.dataset.publicLink = "1"; if (fault === "poll") h.host.document.body.dataset.webTransport = "poll";
      if (fault === "view") h.host.document.body.dataset.mode = "view-only"; if (fault === "header") h.values.ownerScope = "none"; if (fault === "epoch") h.values.ownerEpoch = "unknown";
      if (fault === "auth") delete h.host.AgendAuth.onSessionEnd; if (fault === "ended") h.host.AgendAuth.onSessionEnd = (fn: () => void) => { fn(); return () => {}; };
    });
    expect(h.api.ok).toBe(false); expect(h.factories.loader).not.toHaveBeenCalled(); expect(h.factories.registry).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("a loader revocation ends the entire app episode rather than only a Chat source", async () => {
    const h = rig(), a = h.chat("a"); await flush(); h.loaderOptions.onRevoke({ reason: "authorization_rejected" });
    expect(h.registry.dispose).toHaveBeenCalledOnce(); expect(h.loader.dispose).toHaveBeenCalledOnce(); expect(h.api.attachChat({ name: "b", ...a })).toBeNull(); h.api.dispose(); expect(h.registry.dispose).toHaveBeenCalledOnce();
  });
  it("a real loader authorization rejection closes the app even without a global auth notification", async () => {
    const h = rig(h => { h.realLoader = true; }); h.host.fetch.mockResolvedValueOnce(new Response('{"error":"owner_changed"}', { status: 409, headers: { "content-type": "application/json" } }));
    const a = h.chat("a"); await flush(); expect(h.registry.dispose).toHaveBeenCalledOnce(); expect(h.api.snapshot().error).toBe("runtime_unavailable"); expect(h.api.attachChat({ name: "b", ...a })).toBeNull(); h.api.dispose();
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

  it("the app driver is notified exactly once after all participant cleanup, even if it throws", () => {
    const done = vi.fn(); const h = rig(h => { h.onDispose = () => { expect(h.registry.dispose).toHaveBeenCalledOnce(); expect(h.loader.dispose).toHaveBeenCalledOnce(); done(); throw Error("driver"); }; });
    h.api.dispose(); h.api.dispose(); expect(done).toHaveBeenCalledOnce();
  });
  it("a current predicate attaching B cannot make the outer pass discard B instead of A", async () => {
    const h = rig(); let replace = false, nested: any = null;
    const a = h.chat("a", { current: () => { if (replace) { replace = false; nested = h.chat("b"); } return true; } }); await flush();
    replace = true; a.api.sync(); await flush(); expect(nested.api).not.toBeNull();
    expect(nested.api.snapshot().effects).toHaveLength(1); expect(nested.api.snapshot().rows[0]).toMatchObject({ instance: "b", id });
    a.api.dispose(); expect(nested.api.snapshot().rows[0].instance).toBe("b"); expect(h.factories.registry).toHaveBeenCalledOnce(); expect(h.factories.loader).toHaveBeenCalledOnce(); h.api.dispose();
  });

});

describe("#1629 optional personal sources share the app pool", () => {
  it("real loader retains a cancelled personal body through cleanup before Chat and a fresh owner read", async () => {
    const first = held(), cancelled = held(), cancel = vi.fn(() => cancelled.promise);
    const h = rig(h => { personal(h); h.realLoader = true;
      h.host.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes("/owner?") ? ownerBody() : { rev: 1, effects: [{ id, by: "agent", at: 1, manifest: { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat"], layer: "behind", wants: [] }, params: {} }] }), { headers: { "content-type": "application/json" } }));
      h.host.fetch.mockImplementationOnce(() => first.promise);
    });
    h.api.sync(); const a = h.chat("a"); await flush(); h.api.changedOwner(); first.resolve({ ok: true, status: 200, body: { cancel } }); await flush();
    expect(cancel).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledOnce(); expect(a.api.snapshot().loading).toBe(true); expect(h.api.ownerSnapshot().rows).toEqual([]);
    cancelled.resolve(); await flush(); expect(h.host.fetch.mock.calls.map((c: any) => c[0])).toEqual([`/ui/effects/owner?ownerEpoch=${epoch}`, `/ui/effects/placements?instance=a&ownerEpoch=${epoch}`, `/ui/effects/owner?ownerEpoch=${epoch}`]);
    expect(a.api.snapshot().rows).toHaveLength(1); expect(h.api.ownerSnapshot().rows).toHaveLength(4); h.api.dispose();
  });
  it("keeps the product driver opt-out: a plain app core never reads personal metadata", async () => {
    const h = rig(); h.api.sync(); h.chat(); await flush(); expect(h.loader.ownerSettled).not.toHaveBeenCalled(); expect(h.api.ownerSnapshot().slots).toEqual({}); h.api.dispose();
  });
  it("aggregates four personal slots and same-id Chat in one registry with distinct scopes", async () => {
    const h = rig(personal); h.api.sync(); await flush(); const a = h.chat("a"); await flush(); const ds = h.registry.update.mock.calls.at(-1)[0];
    expect(ds.map((d: any) => d.region)).toEqual(["page", "header", "sidebar", "box", "chat"]); expect(new Set(ds.map((d: any) => d.key)).size).toBe(5);
    expect(h.api.ownerSnapshot().rows.map((r: any) => r.slot)).toEqual(ownerSlots); expect(a.api.snapshot().rows).toHaveLength(1); expect(h.factories.loader).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce();
    for (const row of ds) { expect(await h.options().load(row, new AbortController().signal)).toMatchObject({ id }); }
    expect(h.loader.resourceSettled.mock.calls.slice(0, 4).map((c: any) => c[0])).toEqual(ownerSlots.map(slot => ({ id, slot })));
    expect(h.loader.resourceSettled.mock.calls[4][0]).toEqual({ id, instance: "a" }); expect(await h.options().load({ id }, new AbortController().signal)).toBeNull();
    h.api.detachChat(); expect(h.api.ownerSnapshot().rows).toHaveLength(4); expect(h.registry.dispose).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("holds a personal metadata operation until settlement and fairly admits waiting Chat before a reread", async () => {
    const h = rig(personal), first = held(), order: string[] = []; h.loader.ownerSettled.mockImplementationOnce(() => { order.push("owner-old"); return first.promise; });
    h.loader.ownerSettled.mockImplementation(async () => { order.push("owner-new"); return ownerBody(id, 2); }); h.loader.placementsSettled.mockImplementation(async () => { order.push("chat"); return { rev: 1, effects: [h.placement] }; });
    h.api.sync(); const a = h.chat(); await flush(); h.api.changedOwner(); const admission = [...order]; if (admission.length !== 1) h.api.dispose(); expect(admission).toEqual(["owner-old"]); await flush(); expect(h.loader.ownerSettled.mock.calls[0][0].aborted).toBe(true); expect(order).toEqual(["owner-old"]);
    first.resolve(ownerBody("e".repeat(32))); await flush(); expect(order).toEqual(["owner-old", "chat", "owner-new"]); expect(a.api.snapshot().rows).toHaveLength(1); expect(h.api.ownerSnapshot().rows.every((r: any) => r.id === id)).toBe(true); h.api.dispose();
  });
  it("an in-flight Chat read excludes personal metadata without sharing its instance scope", async () => {
    const h = rig(personal), first = held(); h.context.enabled = false; const a = h.chat(); h.context.enabled = true;
    // Both need metadata; the first read is personal, then the held Chat read.
    h.loader.placementsSettled.mockImplementationOnce(() => first.promise); h.api.sync(); await flush(); expect(h.loader.placementsSettled).toHaveBeenCalledOnce(); h.api.changedOwner(); await flush(); expect(h.loader.ownerSettled).toHaveBeenCalledOnce();
    first.resolve({ rev: 1, effects: [h.placement] }); await flush(); expect(h.loader.ownerSettled).toHaveBeenCalledTimes(2); expect(a.api.snapshot().rows[0].instance).toBe("own"); h.api.dispose();
  });
  it("ordinary personal metadata failure latches until explicit invalidation and does not kill Chat", async () => {
    const h = rig(personal); h.loader.ownerSettled.mockResolvedValueOnce(null); const a = h.chat(); await flush(); expect(a.api.snapshot().rows).toHaveLength(1); expect(h.api.ownerSnapshot().error).toBe("unreadable");
    for (let i = 0; i < 3; i++) h.api.sync(); await flush(); expect(h.loader.ownerSettled).toHaveBeenCalledOnce(); h.api.changedOwner(); await flush(); expect(h.api.ownerSnapshot().rows).toHaveLength(4); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("personal refusal is slot-local even with the identical effect in another slot and Chat", async () => {
    const h = rig(personal), a = h.chat(); await flush(); const row = h.api.ownerSnapshot().rows[0]; h.loader.resourceSettled.mockResolvedValueOnce(null);
    expect(await h.options().load(row, new AbortController().signal)).toBeNull(); expect(h.api.ownerSnapshot().slots["fx.page"]).toEqual({ id, status: "unavailable" }); expect(h.api.ownerSnapshot().rows).toHaveLength(3);
    expect(a.api.snapshot().rows).toHaveLength(1); expect(a.api.snapshot().error).toBeNull(); expect(h.onOwnerUnavailable).toHaveBeenCalledExactlyOnceWith("fx.page", id); h.api.dispose();
  });
  it.each([null, { id }])("same-id personal target replacement fences an old held resource (%s)", async result => {
    const h = rig(personal); h.api.sync(); await flush(); const old = h.api.ownerSnapshot().rows[0], first = held(); h.loader.resourceSettled.mockImplementationOnce(() => first.promise);
    const job = h.options().load(old, new AbortController().signal); h.targets["fx.page"] = { isConnected: true }; h.api.sync(); const next = h.api.ownerSnapshot().rows[0]; expect(next.key).not.toBe(old.key);
    first.resolve(result); expect(await job).toBeNull(); expect(h.onOwnerUnavailable).not.toHaveBeenCalled(); expect(h.api.ownerSnapshot().rows[0].key).toBe(next.key); h.api.dispose();
  });
  it("unknown paint proof/registry root admits no personal descriptor, and recovery needs no new metadata", async () => {
    const h = rig(personal); h.registry.frameRoot = null; h.api.sync(); await flush(); expect(h.api.ownerSnapshot().rows).toEqual([]); expect(h.resolveOwnerTarget).not.toHaveBeenCalled();
    h.registry.frameRoot = {}; h.api.sync(); expect(h.api.ownerSnapshot().rows).toHaveLength(4); h.factories.stock.mockReturnValue({ ok: false }); h.api.sync(); expect(h.api.ownerSnapshot().rows).toEqual([]);
    h.factories.stock.mockReturnValue({ ok: true, front: true, agentFront: true, rects: [] }); h.api.sync(); expect(h.api.ownerSnapshot().rows).toHaveLength(4); expect(h.loader.ownerSettled).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a late appearing target is reprojected without changing metadata or replacing the pool", async () => {
    const h = rig(personal); h.targets["fx.header"] = null; h.api.sync(); await flush(); expect(h.api.ownerSnapshot().rows).toHaveLength(3); h.targets["fx.header"] = { isConnected: true }; h.api.sync();
    expect(h.api.ownerSnapshot().rows).toHaveLength(4); expect(h.loader.ownerSettled).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("personal Pause/Resume is slot-scoped and uses the registry's existing human safety resume", async () => {
    const h = rig(personal), a = h.chat(); await flush(); const page = h.api.ownerSnapshot().rows[0]; expect(h.api.pauseOwner("fx.page")).toBe(true);
    expect(h.api.ownerSnapshot().rows.filter((r: any) => r.paused).map((r: any) => r.region)).toEqual(["page"]); expect(a.api.snapshot().rows[0].paused).toBe(false);
    expect(h.api.resumeOwner("fx.page")).toBe(true); expect(h.registry.resume).toHaveBeenCalledExactlyOnceWith(page.key); expect(h.api.pauseOwner("fx.cursor")).toBe(false); h.api.dispose();
  });
  it("personal profile reports carry only the epoch; replaced targets cannot send a stale profile", async () => {
    const h = rig(personal); h.api.sync(); await flush(); const row = h.api.ownerSnapshot().rows[0], owner = { ...row, device: "standard", current: () => true }; h.options().onMount(owner); h.at(10000);
    h.options().onProfile({ verdict: "ok" }, owner); await flush(); expect(h.host.fetch).toHaveBeenCalledWith(`/ui/effects/profile/${id}?ownerEpoch=${epoch}`, expect.objectContaining({ method: "POST" }));
    h.targets["fx.page"] = { isConnected: true }; h.api.sync(); h.at(20000); h.options().onProfile({ verdict: "paused" }, owner); await flush(); expect(h.host.fetch).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("global loader revocation closes both kinds of contribution and fences a held personal resource", async () => {
    const h = rig(personal), a = h.chat(); await flush(); const first = held(); h.loader.resourceSettled.mockImplementationOnce(() => first.promise); const job = h.options().load(h.api.ownerSnapshot().rows[0], new AbortController().signal);
    h.loaderOptions.onRevoke({ reason: "authorization_rejected" }); first.resolve({ id }); expect(await job).toBeNull(); expect(h.api.ownerSnapshot().rows).toEqual([]); expect(a.api.snapshot().rows).toEqual([]); expect(h.registry.dispose).toHaveBeenCalledOnce(); expect(h.loader.dispose).toHaveBeenCalledOnce();
  });
  it.each(["enabled", "show", "previewReady", "optIn", "safe", "publicLink", "reducedMotion", "saveData", "hidden"])("the %s global gate applies before any personal read", async gate => {
    const h = rig(personal); h.context[gate] = ["enabled", "show", "previewReady", "optIn"].includes(gate) ? false : true; h.api.sync(); await flush(); expect(h.loader.ownerSettled).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("resolver reentry attaching a new Chat abandons the old aggregate pass", async () => {
    const h = rig(personal); let b: any; h.api.sync(); await flush(); h.resolveOwnerTarget.mockImplementationOnce((slot: string) => { b = h.chat("b"); return h.targets[slot]; }); h.api.sync(); await flush();
    expect(b.api.snapshot().rows[0].instance).toBe("b"); expect(h.registry.update.mock.calls.at(-1)[1].openInstance).toBe("b"); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });
});


describe("app cursor uses the same fifth-slot metadata and settled loader", () => {
  const cursor = (h: any, selected = id, rev = 1) => { personal(h); const body: any = ownerBody(selected, rev); body.slots["fx.cursor"] = { id: selected, status: "available", manifest: { ...body.slots["fx.page"].manifest, cursor: { hotspot: [0, 0] } } }; h.loader.ownerSettled.mockResolvedValue(body); };
  it("dispatches only an exact current generation to the existing binary lane, without Worker resources or extra participants", async () => {
    const h = rig(h => cursor(h)); h.api.sync(); await flush(); const c = h.api.cursorSelection(), signal = new AbortController().signal; expect(c).not.toBeNull();
    expect(await h.api.cursorImageSettled({ ...c, generation: c.generation + 1 }, signal)).toBeNull(); expect(h.loader.cursorImageSettled).not.toHaveBeenCalled();
    expect(await h.api.cursorImageSettled({ ...c, hotspot: [0, 0] }, signal)).toEqual(new Uint8Array([1, 2, 3])); expect(h.loader.cursorImageSettled).toHaveBeenCalledExactlyOnceWith(id, signal); expect(h.loader.resourceSettled).not.toHaveBeenCalled(); expect(h.registry.update.mock.calls.at(-1)[0]).toHaveLength(4); expect(h.factories.loader).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it.each([null, new Uint8Array([1])])("late same-id cursor %s cannot publish or poison a new generation", async answer => {
    const h = rig(h => cursor(h)); h.api.sync(); await flush(); const c = h.api.cursorSelection(), pending = held(); h.loader.cursorImageSettled.mockImplementationOnce(() => pending.promise); const read = h.api.cursorImageSettled(c);
    h.api.changedOwner(); await flush(); const next = h.api.cursorSelection(); expect(next.generation).not.toBe(c.generation); pending.resolve(answer); expect(await read).toBeNull(); expect(h.api.cursorSelection()).toBe(next); expect(h.onOwnerUnavailable).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("binary refusal stays local to cursor and preserves saved id plus four owner frames", async () => {
    const h = rig(h => cursor(h)); h.api.sync(); await flush(); h.loader.cursorImageSettled.mockResolvedValueOnce(null); expect(await h.api.cursorImageSettled(h.api.cursorSelection())).toBeNull();
    expect(h.api.ownerSnapshot().slots["fx.cursor"]).toEqual({ status: "unavailable", id }); expect(h.api.ownerSnapshot().rows).toHaveLength(4); expect(h.onOwnerUnavailable).toHaveBeenCalledExactlyOnceWith("fx.cursor", id); expect(h.registry.dispose).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("sign-out fences a physically late cursor and disposes the same loader/registry once", async () => {
    const h = rig(h => cursor(h)); h.api.sync(); await flush(); const pending = held(); h.loader.cursorImageSettled.mockImplementationOnce(() => pending.promise); const read = h.api.cursorImageSettled(h.api.cursorSelection()); h.signOut(); pending.resolve(new Uint8Array([1])); expect(await read).toBeNull(); expect(h.loader.dispose).toHaveBeenCalledOnce(); expect(h.registry.dispose).toHaveBeenCalledOnce(); h.api.dispose();
  });
});

it("cursor dispatch never reads an accessor id or an id-only guess", async () => {
  const h = rig(h => { personal(h); const b: any = ownerBody(); b.slots["fx.cursor"] = { id, status: "available", manifest: { ...b.slots["fx.page"].manifest, cursor: { hotspot: [0, 0] } } }; h.loader.ownerSettled.mockResolvedValue(b); }); h.api.sync(); await flush();
  const c = h.api.cursorSelection(), get = vi.fn(() => id); expect(await h.api.cursorImageSettled({ get id() { return get(); }, generation: c.generation, hotspot: [0, 0] })).toBeNull(); expect(await h.api.cursorImageSettled({ id })).toBeNull(); expect(get).not.toHaveBeenCalled(); expect(h.loader.cursorImageSettled).not.toHaveBeenCalled(); h.api.dispose();
});


describe("#1629 Trial contribution in the one app pool (protocol double)", () => {
  function trialRig() {
    let options: any, binding: any = null, chatOwner: any = null;
    const lease = { current: () => true, stop: vi.fn() }, protocol: any = {
      attach: vi.fn((_spec: any, owner: any) => { chatOwner = owner; binding = { kind: "trial", key: "trial:one", id, source: {}, generation: 1 }; options.onChange(); return lease; }),
      descriptors: () => binding ? [{ key: binding.key, id, by: "agent", region: "chat", layer: "front", order: 0, paused: false, visible: true, instance: "own", element: { isConnected: true }, generation: 1, trialStage: {} }] : [],
      binding: (key: string, content: string) => binding?.key === key && content === id ? binding : null,
      current: (b: any) => b === binding && binding !== null,
      load: vi.fn(async () => ({ id, code: "agend.ready()" })),
      stopFor: vi.fn((owner: any) => { if (owner !== chatOwner) return false; binding = null; return true; }),
      stop: vi.fn(() => { binding = null; options.onChange(); }), dispose: vi.fn(),
    };
    const factory = vi.fn((o: any) => { options = o; return protocol; }), h = rig(h => { h.trialFactory = factory; });
    return { ...h, protocol, factory, trialOptions: () => options, chatOwner: () => chatOwner };
  }
  it("does not admit without a live Chat; then contributes to the SAME registry with the captured owner", async () => {
    const h = trialRig(); expect(h.api.attachTrial({})).toBeNull(); expect(h.protocol.attach).not.toHaveBeenCalled(); const a = h.chat("own"); await flush();
    const input = { opaque: true }; expect(h.api.attachTrial(input)).toHaveProperty("stop");
    expect(h.protocol.attach).toHaveBeenCalledWith(input, expect.objectContaining({ name: "own" }));
    expect(h.registry.update.mock.calls.at(-1)[0].map((x: any) => x.key)).toContain("trial:one");
    expect(h.factories.loader).toHaveBeenCalledOnce(); expect(h.factories.registry).toHaveBeenCalledOnce(); expect(h.factory).toHaveBeenCalledOnce();
    expect(h.api.trialSnapshot().rows.map((x: any) => x.key)).toEqual(["trial:one"]); a.api.dispose(); expect(h.protocol.stopFor).toHaveBeenCalledWith(h.chatOwner()); h.api.dispose();
  });
  it.each(["on", "loading", "unknown"])("CSS %s stays on while the Trial retains its independent transport and safety gates", async css => {
    const h = trialRig(); h.chat(); await flush(); h.api.attachTrial({}); expect(h.trialOptions().current()).toBe(true);
    h.observation.ownerCss = css; expect(h.trialOptions().current()).toBe(true); h.context.previewReady = false; h.context.optIn = false; expect(h.trialOptions().current()).toBe(true);
    for (const key of ["enabled", "show", "trialReady"]) { h.context[key] = false; expect(h.trialOptions().current()).toBe(false); h.context[key] = true; }
    for (const key of ["safe", "publicLink", "reducedMotion", "saveData", "hidden"]) { h.context[key] = true; expect(h.trialOptions().current()).toBe(false); h.context[key] = false; }
    expect(h.trialOptions().current()).toBe(true); h.api.dispose();
  });
  it("dispatches a Trial read without touching the ordinary loader or failing Chat", async () => {
    const h = trialRig(), a = h.chat(); await flush(); h.api.attachTrial({}); const row = h.api.trialSnapshot().rows[0];
    expect(await h.options().load(row, new AbortController().signal)).toMatchObject({ id }); expect(h.protocol.load).toHaveBeenCalledOnce(); expect(h.loader.resourceSettled).not.toHaveBeenCalled();
    h.protocol.load.mockResolvedValueOnce(null); expect(await h.options().load(row, new AbortController().signal)).toBeNull(); expect(a.api.snapshot().error).toBeNull(); h.api.dispose();
  });
  it("Trial samples stay transient, while ordinary Chat profile POST remains functional", async () => {
    const h = trialRig(), a = h.chat(); await flush(); h.api.attachTrial({}); const row = h.api.trialSnapshot().rows[0], owner = { ...row, device: "standard", current: () => true };
    h.options().onMount(owner); h.at(10000); h.options().onProfile({ verdict: "paused" }, owner); await flush(); expect(h.collectors[0].add).toHaveBeenCalledOnce(); expect(h.host.fetch).not.toHaveBeenCalled();
    const chat = { ...a.api.snapshot().rows[0], device: "standard", current: () => true }; h.options().onMount(chat); h.at(20000); h.options().onProfile({ verdict: "paused" }, chat); await flush();
    expect(h.host.fetch).toHaveBeenCalledOnce(); expect(h.host.fetch.mock.calls[0][0]).toContain("/ui/effects/profile/"); h.api.dispose();
  });
  it("Trial stop reentry while discarding Chat A preserves newly attached Chat B", async () => {
    const h = trialRig(), a = h.chat("own"); await flush(); h.api.attachTrial({}); let next: any = null;
    h.protocol.stopFor.mockImplementationOnce(() => { h.protocol.stop(); next = h.chat("next"); return true; });
    a.api.dispose(); await flush(); expect(next?.api).not.toBeNull(); expect(next.api.snapshot().effects).toHaveLength(1); expect(h.registry.update.mock.calls.at(-1)[1].openInstance).toBe("next");
    a.api.dispose(); expect(next.api.snapshot().effects).toHaveLength(1); expect(h.factories.registry).toHaveBeenCalledOnce(); expect(h.factories.loader).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("old Chat owners become unavailable and global disposal releases all participants once", async () => {
    const h = trialRig(), a = h.chat(); await flush(); h.api.attachTrial({}); const old = h.chatOwner(); expect(h.trialOptions().ownerCurrent(old, "own")).toBe(true); expect(h.trialOptions().ownerCurrent(old, "other")).toBe(false);
    h.chat("next"); await flush(); expect(h.trialOptions().ownerCurrent(old, "own")).toBe(false); a.api.dispose(); h.api.dispose(); h.api.dispose(); expect(h.protocol.dispose).toHaveBeenCalledOnce(); expect(h.registry.dispose).toHaveBeenCalledOnce(); expect(h.loader.dispose).toHaveBeenCalledOnce();
  });
});
