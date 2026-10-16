import { afterEach, describe, expect, it, vi } from "vitest";
const M = vi.hoisted(() => ({ calibrations: [] as any[], frames: [] as any[], geometries: [] as any[], APIs: [] as any[] }));
vi.mock("../src/ui/shared/effect-baseline.js", () => ({ captureEffectBaseline(options: any) {
  let resolve: (v: any) => void = () => {}; const promise = new Promise(r => { resolve = r; });
  const job = { options, promise, resolve, cancel: vi.fn(() => resolve({ ok: false, reason: "baseline_cancelled" })) }; M.calibrations.push(job); return job;
} }));
vi.mock("../src/ui/shared/effect-geometry.js", () => ({ hostEffectRect: (el: any) => el?.isConnected === true ? el.rect ?? null : null,
  createEffectGeometry(options: any) {
    const geo = { options, bindings: [] as any[], hide: vi.fn(), dispose: vi.fn(), bind: vi.fn((frame: any, _placement?: any) => { const b = { ok: true, frame, sync: vi.fn(() => true), hide: vi.fn(), remove: vi.fn() }; geo.bindings.push(b); return b; }) }; M.geometries.push(geo); return { ok: true, ...geo };
  },
}));
vi.mock("../src/ui/shared/effect-frame.js", async () => {
  const policy = await import(new URL("../src/ui/shared/effect-policy.js", import.meta.url).href);
  return { createEffectFrame(options: any) {
    let removed = false, ready = false; const element = options.window.document.createElement("iframe"); options.root.append(element);
    const api = { ok: true, element, options, ready() { if (removed) return; ready = true; options.onReady(); }, state: () => ({ ready, removed, loads: 1 }),
      remove: vi.fn((reason: string) => { if (removed) return; removed = true; element.remove(); options.onRemove(reason); }),
      send: vi.fn((e: any) => !removed && ready && policy.maySendEffectEvent(e, { instance: options.render.instance, wants: options.render.wants })) };
    M.frames.push(api); return api;
  } };
});
const { createEffectRegistry } = await import(new URL("../src/ui/shared/effect-registry.js", import.meta.url).href);
const id = (n: number) => n.toString(16).padStart(32, "0"), boot = "b".repeat(32);
const gates = (patch = {}) => ({ safe: false, publicLink: false, reducedMotion: false, saveData: false, hidden: false, enabled: true, show: true, previewReady: true, optIn: true, constrained: false, modal: false, openInstance: "own", ...patch });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function rig(options: any = {}) {
  let now = 0, seq = 0, tokens = 0;
  const rafs = new Map<number, () => void>(), timers = new Map<number, { fn: () => void; at: number; delay: number }>(), events = new Map<string, Set<(e?: any) => void>>(), mutations: any[] = [], resizes: any[] = [], trusted: any[] = [];
  const on = (type: string, fn: (e?: any) => void) => { if (!events.has(type)) events.set(type, new Set()); events.get(type)!.add(fn); }, off = (type: string, fn: (e?: any) => void) => events.get(type)?.delete(fn);
  const doc: any = { visibilityState: "visible", designMode: "off", addEventListener: on, removeEventListener: off };
  function node(tag = "DIV"): any {
    const n = { tagName: tag, ownerDocument: doc, isConnected: false, parentNode: null as any, children: [] as any[], id: "", className: "", rect: { x: 0, y: 0, width: 100, height: 80 }, isContentEditable: false,
      matches: vi.fn(() => false), closest: vi.fn(() => null), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      append(c: any) { n.children.push(c); c.parentNode = n; c.isConnected = true; }, remove: vi.fn(() => { n.isConnected = false; if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((x: any) => x !== n); n.parentNode = null; }) };
    return n;
  }
  doc.body = node("BODY"); doc.body.isConnected = true; doc.documentElement = node("HTML"); doc.documentElement.isConnected = true; doc.activeElement = doc.body;
  doc.createElement = vi.fn((tag: string) => node(tag.toUpperCase())); doc.querySelectorAll = vi.fn((q: string) => q === "[data-trust]" ? trusted : M.frames.filter(f => f.options.window === host && !f.state().removed).map(f => f.element)); doc.elementFromPoint = vi.fn(() => doc.body);
  const host: any = { document: doc, location: { origin: "https://dashboard.example" }, devicePixelRatio: 1, performance: { now: () => now }, AbortController,
    addEventListener: on, removeEventListener: off,
    requestAnimationFrame(fn: () => void) { rafs.set(++seq, fn); return seq; }, cancelAnimationFrame: vi.fn((id: number) => rafs.delete(id)),
    setTimeout(fn: () => void, delay: number) { timers.set(++seq, { fn, at: now + delay, delay }); return seq; }, clearTimeout: vi.fn((id: number) => timers.delete(id)),
    MutationObserver: class { cb: () => void; observe = vi.fn(); disconnect = vi.fn(); constructor(cb: () => void) { this.cb = cb; mutations.push(this); } },
    ResizeObserver: class { cb: () => void; observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); constructor(cb: () => void) { this.cb = cb; resizes.push(this); } },
  };
  const safety = { allowed: vi.fn((_id?: string, _device?: string) => true), begin: vi.fn((_spec?: any) => `token-${++tokens}`), finish: vi.fn((_token?: string, _reason?: string) => true), pause: vi.fn((_record?: any) => true), resume: vi.fn((_id?: string, _device?: string) => true) };
  const load = vi.fn(async (d: any, _signal?: AbortSignal) => ({ id: d.id, code: "agend.ready()", params: { ...d.params }, assets: [], wants: ["state", "reply", "mention", "theme", "pointer"] }));
  const change = vi.fn(), profile = vi.fn(), coverage = vi.fn(() => true);
  const { prepareHost, ...registryOptions } = options; prepareHost?.(host);
  const api = createEffectRegistry({ window: host, origin: "https://preview.example", boot, load, safety, trustComplete: coverage, onChange: change, onProfile: profile, ...registryOptions }); M.APIs.push(api);
  const descriptors = (n = 1, patch: any = {}) => Array.from({ length: n }, (_, i) => { const element = node(); element.isConnected = true; return { key: `effect-${i}`, id: id(i + 1), region: "chat", layer: "behind", by: "agent", order: i, paused: false, visible: true, instance: "own", params: {}, element, ...patch }; });
  return { api, host, doc, safety, load, coverage, change, profile, rafs, timers, events, mutations, resizes, trusted, descriptors, node,
    frames: () => M.frames.filter(f => f.options.window === host), cals: () => M.calibrations.filter(c => c.options.window === host), geo: () => M.geometries.find(g => g.options.window === host),
    at(t: number) { now = t; }, frame(t: number) { now = t; const callbacks = [...rafs.values()]; rafs.clear(); for (const fn of callbacks) fn(); },
    timer(t: number) { now = t; const due = [...timers].filter(([, v]) => v.at <= now); for (const [k, v] of due) { timers.delete(k); v.fn(); } },
    emit(type: string, data: any = {}) { for (const fn of [...events.get(type) ?? []]) fn(Object.assign(Object.create(data), { type })); },
    async admit(ds = descriptors(), ctx = gates()) { api.update(ds, ctx); const c = M.calibrations.filter(c => c.options.window === host).at(-1); if (c) c.resolve({ ok: true, baselineFps: 60 }); await flush(); return ds; },
  };
}
afterEach(() => { for (const a of M.APIs) a.dispose?.(); M.APIs.length = 0; M.frames.length = 0; M.calibrations.length = 0; M.geometries.length = 0; });
describe("#1629 shared Canvas Worker registry", () => {
  it("mounts nothing before a proven empty host baseline, retaining one calibration across notifications", async () => {
    const h = rig(), ds = h.descriptors(); h.api.update(ds, gates()); expect(h.load).not.toHaveBeenCalled(); expect(h.frames()).toHaveLength(0); expect(h.cals()).toHaveLength(1);
    expect(h.cals()[0].options.empty()).toBe(true); h.api.update(ds, gates()); h.mutations[0].cb(); h.resizes[0].cb(); expect(h.cals()).toHaveLength(1);
    h.cals()[0].resolve({ ok: true, baselineFps: 50 }); await flush(); expect(h.frames()).toHaveLength(1); expect(h.safety.begin).toHaveBeenCalledOnce();
  });
  it("admits only three frames and two front layers, queue has no load or iframe", async () => {
    const h = rig(), ds = h.descriptors(5); ds[0].layer = ds[1].layer = ds[2].layer = "front"; await h.admit(ds);
    expect(h.frames()).toHaveLength(3); expect(h.load).toHaveBeenCalledTimes(3); expect(h.api.snapshot().filter((r: any) => r.phase && ds.find(d => d.key === r.key)?.layer === "front")).toHaveLength(2);
    expect(h.api.snapshot().filter((r: any) => r.verdict === "queued")).toHaveLength(2); expect(h.api.snapshot().filter((r: any) => r.phase === "starting")).toHaveLength(3);
  });
  it("a constrained host has one frame even if many descriptors are eligible", async () => {
    const h = rig(); await h.admit(h.descriptors(4), gates({ constrained: true })); expect(h.frames()).toHaveLength(1); expect(h.load).toHaveBeenCalledTimes(1);
  });
  it.each([{ safe: true }, { publicLink: true }, { reducedMotion: true }, { saveData: true }, { enabled: false }, { show: false }, { previewReady: false }, { optIn: false }, { hidden: true }, { show: undefined }])("unknown/disabled viewer gate %j mounts nothing", async patch => {
    const h = rig(); await h.admit(h.descriptors(3), gates(patch)); expect(h.frames()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled();
  });
  it("the constrained front pool admits exactly one front effect", async () => {
    const h = rig(); await h.admit(h.descriptors(3, { layer: "front" }), gates({ constrained: true })); expect(h.frames()).toHaveLength(1); expect(h.geo().bind.mock.calls[0]![1]).toMatchObject({ layer: "front" });
  });
  it("duplicate descriptor keys cannot overwrite an admission or get any loader", async () => {
    const h = rig(), ds = h.descriptors(2); ds[1]!.key = ds[0]!.key; await h.admit(ds); expect(h.frames()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled();
  });
  it("missing provenance stays agent-restricted", async () => {
    const h = rig(); await h.admit(h.descriptors(1, { region: "page", by: undefined })); expect(h.frames()).toHaveLength(0);
  });
  it("unknown trust completeness mounts nothing", async () => {
    const h = rig(); h.coverage.mockReturnValue(false); h.api.update(h.descriptors(), gates()); await flush(); expect(h.frames()).toHaveLength(0); expect(h.cals()).toHaveLength(0);
  });
  it("new instances cannot bypass this window's one pool", () => {
    const h = rig(); expect(createEffectRegistry({ window: h.host, load: h.load, safety: h.safety, trustComplete: h.coverage })).toMatchObject({ ok: false });
  });
  it("scope, visibility, local pause and open-chat fences precede any loader", async () => {
    const h = rig(), ds = h.descriptors(4); ds[0].region = "page"; ds[1].visible = false; ds[2].paused = true; ds[3].instance = "other"; await h.admit(ds); expect(h.load).not.toHaveBeenCalled(); expect(h.frames()).toHaveLength(0);
  });
  it("human page placements win capacity ahead of open-chat placements", async () => {
    const h = rig(), ds = h.descriptors(5); ds[4].region = "page"; ds[4].by = "human"; await h.admit(ds, gates({ constrained: true })); expect(h.load.mock.calls[0]![0].key).toBe("effect-4"); expect(h.frames()[0].options.render.instance).toBeNull();
  });
  it("late load results after a route/identity replacement never mount", async () => {
    const h = rig(); let resolve: (v: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); const ds = await h.admit();
    h.api.update(ds, gates({ openInstance: "other" })); expect(h.load.mock.calls[0]![1]!.aborted).toBe(true);
    resolve({ id: ds[0]!.id, code: "agend.ready()", params: {}, assets: [], wants: [] }); await flush(); expect(h.frames()).toHaveLength(0); expect(h.safety.begin).not.toHaveBeenCalled();
  });
  it("aborted physical loads keep capacity until settlement, then the latest selected set starts", async () => {
    const h = rig(), pending: ((v: any) => void)[] = []; h.load.mockImplementation(() => new Promise(r => pending.push(r))); const ds = await h.admit(h.descriptors(3));
    const next = h.descriptors(3).map((d, i) => ({ ...d, key: "new-" + i, id: id(i + 20) })); h.api.update(next, gates()); await flush(); expect(h.load).toHaveBeenCalledTimes(3); expect(h.frames()).toHaveLength(0);
    for (const r of pending.splice(0)) r(null); await flush(); expect(h.load).toHaveBeenCalledTimes(6); expect(h.frames()).toHaveLength(0); expect(ds).toHaveLength(3);
  });
  it("a hung loader is aborted at ten monotonic seconds and cannot restart the same identity automatically", async () => {
    const h = rig(); h.load.mockImplementation(() => new Promise(() => {})); const ds = await h.admit(); expect([...h.timers.values()].some(t => t.delay === 10000)).toBe(true);
    h.timer(10000); expect(h.load.mock.calls[0]![1]!.aborted).toBe(true); h.api.update(ds, gates()); await flush(); expect(h.load).toHaveBeenCalledTimes(1); expect(h.frames()).toHaveLength(0);
  });
  it("no second pool is created while disposed physical loads remain unsettled", async () => {
    const h = rig(); let resolve: (v: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); await h.admit(); h.api.dispose();
    expect(createEffectRegistry({ window: h.host, load: h.load, safety: h.safety, trustComplete: h.coverage })).toMatchObject({ ok: false }); resolve(null); await flush();
    const next = createEffectRegistry({ window: h.host, load: h.load, safety: h.safety, trustComplete: h.coverage }); expect(next.ok).toBe(true); next.dispose();
  });
  it.each(["id", "params"])("a resource %s mismatch refuses before safety marker or factory", async field => {
    const h = rig(), ds = h.descriptors(); ds[0].params = { density: 2 } as any;
    h.load.mockImplementation(async d => ({ id: field === "id" ? id(99) : d.id, code: "agend.ready()", params: { density: field === "params" ? 3 : 2 }, assets: [], wants: [] })); await h.admit(ds);
    expect(h.frames()).toHaveLength(0); expect(h.safety.begin).not.toHaveBeenCalled();
  });
  it("safety begin must be synchronous and positively acknowledged before any frame", async () => {
    const h = rig(); h.safety.begin.mockReturnValue(null as any); await h.admit(); expect(h.frames()).toHaveLength(0);
  });
  it("a safety callback revoking the owner cannot mount after it returns", async () => {
    const h = rig(), ds = h.descriptors(); h.safety.begin.mockImplementation(() => { h.api.update(ds, gates({ show: false })); return "late-token"; }); await h.admit(ds);
    expect(h.frames()).toHaveLength(0); expect(h.safety.finish).toHaveBeenCalledWith("late-token", "superseded");
  });
  it("superseding an existing frame removes the factory and geometry together", async () => {
    const h = rig(), ds = await h.admit(), f = h.frames()[0]; h.api.update(ds, gates({ show: false })); expect(f.state().removed).toBe(true); expect(h.geo().bindings[0].remove).toHaveBeenCalledOnce(); expect(h.safety.finish).toHaveBeenCalledOnce();
  });
  it("a refused marker cleanup immediately removes every other frame", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(3)); h.safety.finish.mockReturnValue(false); h.api.update(ds.slice(1), gates()); expect(h.frames().every(f => f.state().removed)).toBe(true);
  });
  it("hidden immediately hides/stops forwarding and removes after ten seconds without rAF", async () => {
    const h = rig(), ds = await h.admit(); const f = h.frames()[0]; f.ready(); h.api.update(ds, gates({ hidden: true })); expect(h.geo().hide).toHaveBeenCalled(); expect(h.api.publish("reply", {}, "own")).toBe(0);
    h.timer(9999); expect(f.state().removed).toBe(false); h.timer(10000); expect(f.state().removed).toBe(true);
  });
  it("disabled global gates still remove immediately while hidden", async () => {
    const h = rig(), ds = await h.admit(); h.frames()[0].ready(); h.api.update(ds, gates({ hidden: true, safe: true })); expect(h.frames()[0].state().removed).toBe(true);
  });
  it("resize observation doesn't disconnect/re-observe an unchanged inventory forever", async () => {
    const h = rig(), ds = await h.admit(); const ro = h.resizes[0], initial = ro.observe.mock.calls.length;
    h.api.update(ds, gates()); h.resizes[0].cb(); h.mutations[0].cb(); expect(ro.observe).toHaveBeenCalledTimes(initial); expect(ro.disconnect).not.toHaveBeenCalled();
  });
  it("mutation/scroll hides immediately; the next rAF reveals only after validated geometry", async () => {
    const h = rig(); await h.admit(); h.frames()[0].ready(); const geo = h.geo(); geo.hide.mockClear(); h.emit("scroll"); expect(geo.hide).toHaveBeenCalledOnce();
    geo.bindings[0].sync.mockReturnValue(false); h.frame(16); expect(h.frames()[0].state().removed).toBe(true);
  });
  it("only own-instance state/reply signals pass and content fields are not read", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    expect(h.api.publish("reply", {}, "other")).toBe(0); expect(h.api.publish("state", { state: "working", get text() { throw Error("content"); } }, "own")).toBe(1);
    expect(f.send.mock.calls[0]![0]).toEqual({ v: 1, type: "state", ts: 0, instance: "own", state: "working" }); expect(h.api.publish("usage", {}, "own")).toBe(0); expect(h.api.publish("pointer", { kind: "move", x: 1, y: 1, buttons: 0 })).toBe(0);
  });
  it("native pointer packets coalesce, are local to the region and never read keys/text", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    for (let n = 0; n < 10; n++) h.emit("pointermove", { isTrusted: true, clientX: n, clientY: 20, buttons: 0, get text() { throw Error("content"); } });
    expect(f.send).not.toHaveBeenCalled(); h.frame(17); expect(f.send).toHaveBeenCalledOnce(); expect(f.send.mock.calls[0]![0]).toEqual({ v: 1, type: "pointer", ts: 0, kind: "move", x: 9, y: 20, buttons: 0 });
    h.emit("pointermove", { isTrusted: true, clientX: 2, clientY: 20, buttons: 0 }); h.frame(20); expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(["synthetic", "focused", "unknown-focus", "contenteditable", "modal", "trusted", "outside"])("pointer %s does not enter a Worker", async fault => {
    const h = rig(), ds = await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    if (fault === "focused") h.doc.activeElement.matches.mockReturnValue(true);
    if (fault === "unknown-focus") h.doc.activeElement = h.node("EDITOR-HOST");
    if (fault === "contenteditable") h.doc.activeElement.isContentEditable = true;
    if (fault === "modal") h.api.update(ds, gates({ modal: true }));
    if (fault === "trusted") h.doc.body.closest.mockReturnValue(h.doc.body);
    h.emit("pointermove", { isTrusted: fault !== "synthetic", clientX: fault === "outside" ? 500 : 10, clientY: 20, buttons: 0 }); h.frame(17); expect(f.send).not.toHaveBeenCalled();
  });
  it("human Resume removes the pool and measures again; descriptor updates cannot revive a failed mount", async () => {
    const h = rig(), ds = await h.admit(); const f = h.frames()[0]; f.remove("navigation"); h.api.update(ds, gates()); await flush(); expect(h.frames()).toHaveLength(1);
    expect(h.api.resume(ds[0]!.key)).toBe(true); expect(h.safety.resume).toHaveBeenCalledWith(ds[0]!.id, "standard"); expect(h.cals()).toHaveLength(2); expect(h.cals()[1].options.empty()).toBe(true); expect(h.frames()[0].state().removed).toBe(true);
  });
  it("a sticky safety off refuses a human Resume", async () => {
    const h = rig(), ds = await h.admit(); h.safety.resume.mockReturnValue(false); expect(h.api.resume(ds[0]!.key)).toBe(false); expect(h.cals()).toHaveLength(1);
  });
  it("degraded pointer delivery is capped at thirty Hz by the registry itself", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready();
    for (const t of [1000, 2000, 3000]) { h.frame(t); h.timer(t); } f.send.mockClear();
    for (const [at, frame] of [[3001, 3010], [3020, 3028], [3040, 3044]]) { h.at(at!); h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(frame!); }
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls.map((c: any) => c[0].type)).toEqual(["pointer", "pointer"]);
    expect(f.send.mock.calls.map((c: any) => c[0].ts)).toEqual([3001, 3040]);
  });
  it("the safety participant retains its receiver and cannot be silently unbound", async () => {
    const participant: any = { flag: true, allowed() { return this.flag === true; }, begin() { return this.flag ? "owned-token" : null; }, finish() { return this.flag === true; }, pause() { return this.flag === true; }, resume() { return this.flag === true; } };
    const h = rig({ safety: participant }); await h.admit(); expect(h.frames()).toHaveLength(1); h.api.dispose(); expect(h.frames()[0].state().removed).toBe(true);
  });
  it("unknown participant getters refuse before any root or observer is created", () => {
    const h = rig({ safety: { get allowed() { throw Error("unknown"); } } }); expect(h.api).toMatchObject({ ok: false }); expect(h.doc.createElement).not.toHaveBeenCalled();
  });
  it("an async participant acknowledgement never authorizes a frame", async () => {
    const h = rig(); h.safety.allowed.mockReturnValue(Promise.resolve(true) as any); await h.admit(); expect(h.frames()).toHaveLength(0); expect(h.safety.begin).not.toHaveBeenCalled();
  });
  it("a reentrant admission check cannot overwrite new slots or exceed the physical load cap", async () => {
    const h = rig(), first = h.descriptors(3), next = h.descriptors(3);
    h.safety.allowed.mockImplementationOnce(() => { h.api.update(next, gates()); return true; }); await h.admit(first);
    expect(h.load).toHaveBeenCalledTimes(3); expect(h.frames()).toHaveLength(3);
    expect(h.api.snapshot().filter((r: any) => r.phase)).toHaveLength(3);
  });
  it("a coverage callback revoking the owner cannot admit a stale frame", async () => {
    const h = rig(), ds = h.descriptors(); h.coverage.mockImplementationOnce(() => { h.api.update(ds, gates({ show: false })); return true; }); h.api.update(ds, gates()); await flush(); expect(h.frames()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled();
  });
  it("a profile callback changing owners cannot publish metrics for retired siblings", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(3)); for (const f of h.frames()) f.ready();
    h.profile.mockImplementationOnce(() => h.api.update(ds, gates({ show: false })));
    for (const t of [1000, 2000, 3000]) { h.frame(t); h.timer(t); }
    expect(h.profile).toHaveBeenCalledOnce(); expect(h.frames().every(f => f.state().removed)).toBe(true); expect(h.safety.pause).not.toHaveBeenCalled();
  });
  it.each(["resize_listener", "performance_getter", "resize_constructor"])("startup failure at %s releases partial listeners and observers", fault => {
    const h = rig({ prepareHost(host: any) {
      if (fault === "resize_listener") { const add = host.addEventListener; host.addEventListener = (type: string, fn: any) => { if (type === "resize") throw Error("failed listener"); add(type, fn); }; }
      if (fault === "performance_getter") Object.defineProperty(host, "PerformanceObserver", { get() { throw Error("unknown performance"); } });
      if (fault === "resize_constructor") host.ResizeObserver = class { constructor() { throw Error("unknown resize"); } };
    } });
    expect(h.api).toMatchObject({ ok: false }); expect([...h.events.values()].every(s => s.size === 0)).toBe(true); expect(h.doc.body.children).toHaveLength(0); expect(h.mutations[0].disconnect).toHaveBeenCalledOnce();
  });
  it("unknown asynchronous cleanup is not a successful probation receipt", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(2)); h.safety.finish.mockReturnValue(Promise.resolve(true) as any); h.api.update(ds.slice(1), gates()); expect(h.frames().every(f => f.state().removed)).toBe(true);
  });
  it("stale pointer packets cannot arrive after a stalled host frame", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear(); h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(101); expect(f.send).not.toHaveBeenCalled();
  });
  it("a hidden interval cannot count as five healthy probation seconds", async () => {
    const h = rig(), ds = await h.admit(); h.frames()[0].ready(); h.api.update(ds, gates({ hidden: true })); h.timer(9000); h.at(9001); h.api.update(ds, gates());
    expect(h.api.publish("reply", {}, "own")).toBe(1);
    for (let i = 1; i < 300; i++) { h.frame(9001 + i * 1000 / 60); h.timer(9001 + i * 1000 / 60); }
    expect(h.safety.finish).not.toHaveBeenCalled(); h.frame(14001); h.timer(14001); expect(h.safety.finish).toHaveBeenCalledWith("token-1", "healthy");
  });
  it("an old calibration cannot authorize another device epoch after cancellation", async () => {
    const h = rig(), ds = h.descriptors(); h.api.update(ds, gates()); const old = h.cals()[0]; old.cancel.mockImplementation(() => {});
    h.api.update(ds, gates({ constrained: true })); expect(h.cals()).toHaveLength(2); old.resolve({ ok: true, baselineFps: 144 }); await flush(); expect(h.load).not.toHaveBeenCalled();
    h.cals()[1].resolve({ ok: true, baselineFps: 30 }); await flush(); expect(h.frames()).toHaveLength(1);
  });
  it("no eligible placements means no calibration, loader or frame", async () => {
    const h = rig(); h.api.update([], gates()); await flush(); expect(h.cals()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled();
  });
  it("healthy host cadence clears probation only after five healthy seconds", async () => {
    const h = rig(); await h.admit(); h.frames()[0].ready();
    for (let i = 1; i < 300; i++) { h.frame(i * 1000 / 60); h.timer(i * 1000 / 60); }
    expect(h.safety.finish).not.toHaveBeenCalled(); h.frame(5000); h.timer(5000);
    expect(h.safety.finish).toHaveBeenCalledWith("token-1", "healthy"); expect(h.frames()[0].state().removed).toBe(false);
    expect(h.profile.mock.calls.at(-1)![0].metrics.hostLongTaskMsPerSecond).toBeNull();
  });
  it("three bad host windows degrade then physically pause, and a descriptor update cannot revive it", async () => {
    const h = rig(), ds = await h.admit(); h.frames()[0].ready();
    for (const t of [1000, 2000, 3000]) { h.frame(t); h.timer(t); }
    expect(h.profile.mock.calls.at(-1)![0]).toMatchObject({ verdict: "degraded", quality: "low" }); expect(h.frames()[0].state().removed).toBe(false);
    for (const t of [4000, 5000]) { h.frame(t); h.timer(t); }
    expect(h.frames()[0].state().removed).toBe(true); expect(h.safety.pause).toHaveBeenCalledOnce(); expect(h.safety.pause.mock.calls[0]![0]).toMatchObject({ id: ds[0]!.id, device: "standard", reason: "host_budget" });
    h.api.update(ds, gates()); await flush(); expect(h.frames()).toHaveLength(1);
  });
  it("simultaneously paused copies of one content id count once per host incident", async () => {
    const h = rig(), ds = h.descriptors(2); ds[1]!.id = ds[0]!.id; await h.admit(ds); for (const f of h.frames()) f.ready();
    for (const t of [1000, 2000, 3000, 4000, 5000]) { h.frame(t); h.timer(t); }
    expect(h.frames().every(f => f.state().removed)).toBe(true); expect(h.safety.pause).toHaveBeenCalledOnce();
  });
  it("unknown safety cleanup after probation removes the complete pool", async () => {
    const h = rig(); await h.admit(h.descriptors(3)); for (const f of h.frames()) f.ready(); h.safety.finish.mockReturnValue(false);
    for (let i = 1; i <= 300; i++) { h.frame(i * 1000 / 60); h.timer(i * 1000 / 60); }
    expect(h.frames().every(f => f.state().removed)).toBe(true);
  });
  it("a rolling-back clock immediately revokes all frames at the event send fence", async () => {
    const h = rig(); await h.admit(h.descriptors(2)); for (const f of h.frames()) f.ready(); h.frame(100); h.at(99);
    expect(h.api.publish("reply", {}, "own")).toBe(0); expect(h.frames().every(f => f.state().removed)).toBe(true);
  });
  it("the one-frame constrained cap cannot reset through repeated updates", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(4), gates({ constrained: true }));
    for (let i = 0; i < 10; i++) h.api.update(ds, gates({ constrained: true })); await flush(); expect(h.load).toHaveBeenCalledTimes(1); expect(h.frames()).toHaveLength(1);
  });
  it("dispose releases timers, observers, ports through the factory, and host event handlers", async () => {
    const h = rig(); await h.admit(); h.frames()[0].ready(); h.api.dispose(); h.api.dispose();
    expect(h.frames()[0].state().removed).toBe(true); expect(h.rafs.size).toBe(0); expect(h.timers.size).toBe(0); expect([...h.events.values()].every(s => s.size === 0)).toBe(true); expect(h.mutations[0].disconnect).toHaveBeenCalledOnce(); expect(h.resizes[0].disconnect).toHaveBeenCalledOnce();
  });
});
