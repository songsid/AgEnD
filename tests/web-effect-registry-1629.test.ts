import { afterEach, describe, expect, it, vi } from "vitest";
const M = vi.hoisted(() => ({ calibrations: [] as any[], frames: [] as any[], geometries: [] as any[], APIs: [] as any[], trials: new WeakMap<object, any>(), trialSerial: 0 }));
// Protocol mock only; real receipt issuance/topology and native paint are separate suites/recipe.
vi.mock("../src/ui/shared/effect-trial-stage.js", () => ({
  effectTrialStageIdentity: (receipt: object) => { const e = M.trials.get(receipt); return e && !e.dead ? e.identity : null; },
  effectTrialStage: (receipt: object, expected: any, stock: any) => {
    const e = M.trials.get(receipt); if (!e || e.dead) return null;
    e.calls++; e.onProject?.();
    if (e.dead || !e.valid || stock?.front !== false || ["key", "id", "instance", "generation"].some(k => expected[k] !== e.identity[k]) || e.root.children.some((f: any) => !e.bound.has(f))) return null;
    return { root: e.root, rect: { ...e.rect }, identity: e.identity, bind: e.bind };
  },
  watchEffectTrialStage(receipt: object, fn: any) { const e = M.trials.get(receipt); if (!e || e.dead) return null; e.listeners.add(fn); return () => e.listeners.delete(fn); },
}));
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
  return { createOpaqueEffectFrame(options: any) {
    let removed = false, ready = false; const element = options.window.document.createElement("iframe"); options.root.append(element);
    const api = { ok: true, element, options, ready() { if (removed) return; ready = true; options.onReady(); }, state: () => ({ ready, removed, loads: 1 }),
      remove: vi.fn((reason: string) => { if (removed) return; removed = true; element.remove(); options.onRemove(reason); }),
      send: vi.fn((e: any) => !removed && ready && policy.maySendEffectEvent(e, { instance: options.render.instance, wants: options.render.wants })) };
    M.frames.push(api); return api;
  } };
});
const { createEffectRegistry } = await import(new URL("../src/ui/shared/effect-registry.js", import.meta.url).href);
const id = (n: number) => n.toString(16).padStart(32, "0"), boot = "b".repeat(32);
const stock = (patch = {}) => ({ ok: true, front: true, agentFront: true, rects: [], ...patch });
const gates = (patch = {}) => ({ safe: false, publicLink: false, reducedMotion: false, saveData: false, hidden: false, enabled: true, show: true, transportReady: true, optIn: true, trialReady: true, constrained: false, modal: false, openInstance: "own", ...patch });
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
  const change = vi.fn(), profile = vi.fn(), mount = vi.fn(), retire = vi.fn(), coverage = vi.fn((_input?: any): any => stock());
  const { prepareHost, ...registryOptions } = options; prepareHost?.(host);
  const api = createEffectRegistry({ window: host, origin: "https://preview.example", boot, load, safety, stockSnapshot: coverage, onChange: change, onProfile: profile, onMount: mount, onRetire: retire, ...registryOptions }); M.APIs.push(api);
  const descriptors = (n = 1, patch: any = {}) => Array.from({ length: n }, (_, i) => { const element = node(); element.isConnected = true; return { key: `effect-${i}`, id: id(i + 1), region: "chat", layer: "behind", by: "agent", order: i, paused: false, visible: true, instance: "own", params: {}, element, ...patch }; });
  return { api, host, doc, safety, load, coverage, change, profile, mount, retire, rafs, timers, events, mutations, resizes, trusted, descriptors, node,
    frames: () => M.frames.filter(f => f.options.window === host), cals: () => M.calibrations.filter(c => c.options.window === host), geo: () => M.geometries.find(g => g.options.window === host),
    at(t: number) { now = t; }, frame(t: number) { now = t; const callbacks = [...rafs.values()]; rafs.clear(); for (const fn of callbacks) fn(); },
    timer(t: number) { now = t; const due = [...timers].filter(([, v]) => v.at <= now); for (const [k, v] of due) { timers.delete(k); v.fn(); } },
    emit(type: string, data: any = {}) { for (const fn of [...events.get(type) ?? []]) fn(Object.assign(Object.create(data), { type })); },
    async admit(ds = descriptors(), ctx = gates()) { api.update(ds, ctx); const c = M.calibrations.filter(c => c.options.window === host).at(-1); if (c) c.resolve({ ok: true, baselineFps: 60 }); await flush(); return ds; },
  };
}
function trial(h: ReturnType<typeof rig>, patch: any = {}) {
  const d: any = h.descriptors(1, { key: "trial", id: id(88), layer: "front", generation: 1, ...patch })[0];
  const receipt = Object.freeze({}); d.trialStage = receipt;
  const e: any = { root: d.element, rect: { x: 10.5, y: 20, width: 99, height: 78 }, identity: Object.freeze({ key: d.key, id: d.id, instance: d.instance, generation: d.generation, serial: ++M.trialSerial }), valid: true, dead: false, calls: 0, onProject: null, listeners: new Set<any>(), bound: new Set<any>(), bindings: [] };
  e.bind = vi.fn((frame: any, placement: any, stock: any) => {
    e.bound.add(frame);
    const b = { ok: true, element: frame, placement, sync: vi.fn(() => e.valid && !e.dead), hide: vi.fn(), remove: vi.fn(() => { e.bound.delete(frame); frame.remove(); }) }; e.bindings.push(b); return b;
  });
  e.end = () => { if (e.dead) return; e.dead = true; for (const b of e.bindings) b.remove(); const notify = [...e.listeners]; e.listeners.clear(); for (const fn of notify) fn("stopped"); };
  M.trials.set(receipt, e); return { d, e };
}

afterEach(() => { for (const a of M.APIs) a.dispose?.(); M.APIs.length = 0; M.frames.length = 0; M.calibrations.length = 0; M.geometries.length = 0; });
describe("#1629 shared Canvas Worker registry", () => {
  it("exposes exactly its connected host root read-only, and nothing after disposal", () => {
    const h = rig(), root = h.api.frameRoot, descriptor = Object.getOwnPropertyDescriptor(h.api, "frameRoot");
    expect(root).toBe(h.doc.body.children[0]); expect(root.isConnected).toBe(true); expect(root.className).toBe("agend-effect-layer");
    expect(descriptor?.set).toBeUndefined(); expect(descriptor?.configurable).toBe(false); expect(descriptor?.enumerable).toBe(false); expect(() => { h.api.frameRoot = {}; }).toThrow();
    h.api.dispose(); expect(h.api.frameRoot).toBeNull(); expect(root.isConnected).toBe(false);
  });
  it("keeps mention reserved without consulting fields or sending to a ready frame", async () => {
    const h = rig(); await h.admit(); const frame = h.frames()[0]; frame.ready(); frame.send.mockClear();
    const getter = vi.fn(() => { throw Error("content"); }), fields = {}; Object.defineProperty(fields, "targets", { get: getter });
    expect(h.api.publish("mention", fields, "own")).toBe(0); expect(frame.send).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
    expect(h.api.publish("reply", {}, "own")).toBe(1);
  });
  it("publishes one frozen live mount receipt after marker, factory and successful geometry", async () => {
    const h = rig(); await h.admit(); const owner = h.mount.mock.calls[0]![0];
    expect(h.mount).toHaveBeenCalledOnce(); expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.keys(owner).sort()).toEqual(["current", "device", "id", "key"]);
    expect(owner).toMatchObject({ key: "effect-0", id: id(1), device: "standard" }); expect(owner.current()).toBe(true);
    expect(h.safety.begin.mock.invocationCallOrder[0]).toBeLessThan(h.mount.mock.invocationCallOrder[0]!);
    expect(h.geo().bindings[0].sync.mock.invocationCallOrder[0]).toBeLessThan(h.mount.mock.invocationCallOrder[0]!);
    h.frames()[0].ready(); h.timer(1000); expect(h.profile.mock.calls[0]![1]).toBe(owner);
    expect(h.profile.mock.calls[0]![0]).not.toHaveProperty("current");
  });
  it("identical descriptors preserve a receipt, but a remount never reuses it", async () => {
    const h = rig(), ds = await h.admit(), first = h.mount.mock.calls[0]![0];
    h.api.update(ds, gates()); await flush(); expect(h.mount).toHaveBeenCalledOnce(); expect(first.current()).toBe(true);
    h.retire.mockImplementation((owner: any) => { expect(owner.current()).toBe(false); expect(h.frames().at(-1).state().removed).toBe(true); expect(h.geo().bindings.at(-1).remove).toHaveBeenCalledOnce(); expect(h.safety.finish).toHaveBeenCalled(); });
    h.api.update(ds, gates({ show: false })); expect(first.current()).toBe(false); expect(h.retire).toHaveBeenCalledExactlyOnceWith(first, "gates_unknown");
    h.api.update([], gates()); await h.admit(ds); const second = h.mount.mock.calls[1]![0]; expect(second).not.toBe(first); expect(second.current()).toBe(true); expect(first.current()).toBe(false);
    h.api.dispose(); h.api.dispose(); expect(second.current()).toBe(false); expect(h.retire).toHaveBeenCalledTimes(2);
  });
  it.each(["empty", "ineligible", "resume"])("a newer identical B survives onRetire reentry during outer %s retirement", async outer => {
    const h = rig(), ds = await h.admit(h.descriptors(2)), b = h.frames()[1], ownerB = h.mount.mock.calls[1]![0], cals = h.cals().length;
    h.retire.mockImplementationOnce((owner: any) => { expect(owner.key).toBe(ds[0].key); h.api.update([ds[1]], gates()); });
    if (outer === "empty") h.api.update([], gates()); else if (outer === "ineligible") h.api.update(ds, gates({ show: false })); else expect(h.api.resume(ds[0].key)).toBe(false);
    await flush(); expect(b.state().removed).toBe(false); expect(ownerB.current()).toBe(true); expect(h.retire.mock.calls.map(([o]: any) => o.key)).toEqual([ds[0].key]);
    expect(h.mount).toHaveBeenCalledTimes(2); expect(h.load).toHaveBeenCalledTimes(2); expect(h.cals()).toHaveLength(cals); expect(h.api.snapshot()).toEqual([expect.objectContaining({ key: ds[1].key, phase: "starting" })]);
  });
  it("tick retirement callbacks cannot apply the old stock proof to a newer retained sibling", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(2)), b = h.frames()[1], ownerB = h.mount.mock.calls[1]![0];
    h.geo().bindings[0].sync.mockReturnValueOnce(false); h.retire.mockImplementationOnce(() => h.api.update([ds[1]], gates())); h.frame(100);
    expect(b.state().removed).toBe(false); expect(ownerB.current()).toBe(true); expect(h.geo().bindings[1].sync).toHaveBeenCalledTimes(1); expect(h.retire).toHaveBeenCalledOnce();
  });
  it("heartbeat abandons its old sibling measurements after retirement reentry", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(2)); for (const f of h.frames()) f.ready();
    h.retire.mockImplementationOnce(() => h.api.update([ds[1]], gates())); h.profile.mockImplementationOnce(() => h.frames()[0].remove("navigation")); h.timer(1000);
    expect(h.profile).toHaveBeenCalledOnce(); expect(h.frames()[1].state().removed).toBe(false); expect(h.mount.mock.calls[1]![0].current()).toBe(true);
  });
  it("a failed geometry admission has no mount receipt or invented retire notification", async () => {
    const h = rig(); h.geo().bind.mockImplementation(() => ({ ok: true, sync: () => false, remove: vi.fn() })); await h.admit();
    expect(h.mount).not.toHaveBeenCalled(); expect(h.retire).not.toHaveBeenCalled(); expect(h.frames()[0].state().removed).toBe(true); expect(h.safety.finish).toHaveBeenCalledOnce();
  });
  it("mount and retire observer exceptions cannot prevent physical cleanup", async () => {
    const h = rig(); h.mount.mockImplementation(() => { throw Error("display unavailable"); }); h.retire.mockImplementation(() => { throw Error("display unavailable"); });
    await h.admit(); const f = h.frames()[0]; expect(f.state().removed).toBe(false); const owner = h.mount.mock.calls[0]![0];
    h.api.dispose(); expect(f.state().removed).toBe(true); expect(owner.current()).toBe(false); expect(h.safety.finish).toHaveBeenCalledOnce(); expect(h.retire).toHaveBeenCalledOnce();
  });
  it("a mount observer may revoke its own owner without reviving the old frame", async () => {
    const h = rig(); h.mount.mockImplementation(() => h.api.dispose()); await h.admit();
    expect(h.frames()[0].state().removed).toBe(true); expect(h.mount.mock.calls[0]![0].current()).toBe(false); expect(h.retire).toHaveBeenCalledOnce();
  });
  it.each(["event", "explicit", "heartbeat", "foreground"])("%s revalidates safety for an already running frame", async via => {
    const h = rig(), ds = await h.admit(); h.frames()[0].ready(); const owner = h.mount.mock.calls[0]![0]; h.safety.allowed.mockReturnValue(false);
    if (via === "event") h.emit("storage"); else if (via === "explicit") h.api.revalidateSafety(); else if (via === "heartbeat") h.timer(1000); else h.emit("visibilitychange");
    expect(h.frames()[0].state().removed).toBe(true); expect(owner.current()).toBe(false); expect(h.retire).toHaveBeenCalledExactlyOnceWith(owner, "safety_revoked");
    h.api.update(ds, gates()); await flush(); expect(h.load).toHaveBeenCalledOnce(); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "safety_revoked" });
  });
  it("heartbeat revocation frees capacity for a different queued eligible id", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(4)); for (const f of h.frames()) f.ready();
    h.safety.allowed.mockImplementation((effectId?: string) => effectId !== ds[0].id); h.timer(1000); await flush();
    expect(h.frames()[0].state().removed).toBe(true); expect(h.load).toHaveBeenCalledTimes(4); expect(h.frames().at(-1).state().removed).toBe(false);
    expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "safety_revoked" });
  });
  it("a retire observer replacing the descriptors abandons that safety pass", async () => {
    const h = rig(), ds = await h.admit(h.descriptors(2)); const next = h.descriptors(1, { key: "next", id: id(99) });
    h.retire.mockImplementationOnce(() => h.api.update(next, gates())); h.safety.allowed.mockImplementationOnce(() => false); h.api.revalidateSafety(); await flush();
    expect(h.api.snapshot()).toHaveLength(1); expect(h.api.snapshot()[0]).toMatchObject({ key: "next", phase: "starting" }); expect(h.mount.mock.calls.at(-1)![0].current()).toBe(true);
  });
  it("unknown safety receipts stop all mounts and storage listeners are released", async () => {
    const h = rig(); await h.admit(h.descriptors(2)); h.safety.allowed.mockImplementation(() => { throw Error("unreadable"); }); h.emit("storage");
    expect(h.frames().every(f => f.state().removed)).toBe(true); expect(h.retire).toHaveBeenCalledTimes(2);
    h.api.dispose(); const calls = h.safety.allowed.mock.calls.length; h.emit("storage"); expect(h.safety.allowed).toHaveBeenCalledTimes(calls);
  });
  it("a reentrant safety read cannot retire a replacement owner's slot", async () => {
    const h = rig(), ds = await h.admit(); h.safety.allowed.mockImplementationOnce(() => { h.api.update(ds, gates({ show: false })); return false; });
    h.api.revalidateSafety(); expect(h.frames()[0].state().removed).toBe(true); expect(h.retire.mock.calls[0]![1]).toBe("gates_unknown");
    h.api.update([], gates()); await h.admit(ds); expect(h.frames().at(-1).state().removed).toBe(false); expect(h.mount.mock.calls.at(-1)![0].current()).toBe(true);
  });
  it.each([[true, 4, 1.5], [true, 1, 1], [false, 2.5, 2.5], [false, 4, 3]])("constrained=%s clamps native DPR %s to %s in render and env", async (constrained, native, expected) => {
    const h = rig({ prepareHost: (host: any) => { host.devicePixelRatio = native; } }), ds = await h.admit(undefined, gates({ constrained }));
    const f = h.frames()[0]; expect(f.options.render.dpr).toBe(expected); f.ready();
    expect(f.send.mock.calls.filter(([e]: any) => e.type === "env").at(-1)![0].dpr).toBe(expected);
    ds[0].element.rect.width++; h.frame(100); expect(f.send.mock.calls.filter(([e]: any) => e.type === "env").at(-1)![0].dpr).toBe(expected);
  });
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
  it.each([{ safe: true }, { reducedMotion: true }, { saveData: true }, { enabled: false }, { show: false }, { transportReady: false }, { hidden: true }, { show: undefined }])("unknown/disabled viewer gate %j mounts nothing", async patch => {
    const h = rig(); await h.admit(h.descriptors(3), gates(patch)); expect(h.frames()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled();
  });
  it("#2118 a viewer off/on revokes paint then recovers without clearing real safety or resource latches",async()=>{
    const h=rig(),ds=await h.admit();h.frames()[0].ready();const first=h.frames()[0];
    h.api.update(ds,gates({show:false}));expect(first.state().removed).toBe(true);expect(h.api.snapshot()[0]).toMatchObject({phase:null,reason:"disabled"});
    h.api.update(ds,gates());await flush();expect(h.frames().filter((f:any)=>!f.state().removed)).toHaveLength(1);expect(h.load).toHaveBeenCalledTimes(2);expect(h.api.snapshot()[0].reason).not.toBe("gates_unknown");
    h.api.dispose();
  });
  it("#2118 viewer off/on cannot clear resource or durable safety failures",async()=>{
    const failed=rig();failed.load.mockResolvedValueOnce(null as any);const ds=await failed.admit();expect(failed.load).toHaveBeenCalledOnce();
    failed.api.update(ds,gates({show:false}));failed.api.update(ds,gates());await flush();expect(failed.load).toHaveBeenCalledOnce();failed.api.dispose();
    const off=rig();off.safety.allowed.mockReturnValue(false);(off.safety as any).status=vi.fn(()=>({state:"off",history:null}));const blocked=await off.admit();
    off.api.update(blocked,gates({show:false}));off.api.update(blocked,gates());await flush();expect(off.load).not.toHaveBeenCalled();expect(off.api.snapshot()[0].reason).toBe("safety_off");off.api.dispose();
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
    const h = rig(); expect(createEffectRegistry({ window: h.host, load: h.load, safety: h.safety, stockSnapshot: h.coverage })).toMatchObject({ ok: false });
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
  it.each([9999, 10000, 10001])("completion at %dms independently checks the deadline even when its timer is delayed", async at => {
    const h = rig(); let resolve: (v: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); const ds = await h.admit();
    h.at(at); resolve({ id: ds[0]!.id, code: "agend.ready()", params: {}, assets: [], wants: [] }); await flush();
    if (at < 10000) { expect(h.frames()).toHaveLength(1); expect(h.safety.begin).toHaveBeenCalledOnce(); }
    else {
      expect(h.frames()).toHaveLength(0); expect(h.safety.begin).not.toHaveBeenCalled(); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "resource_timeout" });
      h.api.update(ds, gates()); await flush(); expect(h.load).toHaveBeenCalledTimes(1);
    }
  });
  it.each(["allowed", "begin", "coverage"])("time spent in the %s callback cannot extend a resource's deadline", async stage => {
    const h = rig(); let resolve: (v: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); const ds = await h.admit();
    if (stage === "allowed") h.safety.allowed.mockImplementation(() => { h.at(10000); return true; });
    else h.safety.begin.mockImplementation(() => { if (stage === "coverage") h.coverage.mockImplementation(() => { h.at(10000); return stock(); }); else h.at(10000); return "deadline-token"; });
    h.at(9999); resolve({ id: ds[0]!.id, code: "agend.ready()", params: {}, assets: [], wants: [] }); await flush();
    expect(h.frames()).toHaveLength(0); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "resource_timeout" });
    if (stage !== "allowed") expect(h.safety.finish).toHaveBeenCalledWith("deadline-token", "resource_timeout"); else expect(h.safety.begin).not.toHaveBeenCalled();
  });
  it.each(["once", "reentrant", "after-marker", "persistent"])("a %s coverage refusal retires the completing slot instead of leaving immortal loading", async mode => {
    const h = rig(); let resolve: (v: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); const ds = await h.admit();
    let refuse = true;
    const coverage = () => {
      if (!refuse) return stock();
      refuse = mode === "persistent";
      if (mode === "reentrant") { h.api.update(ds, gates()); return stock(); }
      return false;
    };
    if (mode === "after-marker") h.safety.begin.mockImplementation(() => { h.coverage.mockImplementation(coverage); return "coverage-token"; });
    else h.coverage.mockImplementation(coverage);
    resolve({ id: ds[0]!.id, code: "agend.ready()", params: {}, assets: [], wants: [] }); await flush();
    h.timer(20000); expect(h.frames()).toHaveLength(0); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: mode === "reentrant" ? "stock_reentrant" : "admission_revoked" });
    expect(h.load.mock.calls[0]![1]!.aborted).toBe(true); h.api.update(ds, gates()); await flush(); expect(h.load).toHaveBeenCalledTimes(1);
    if (mode === "after-marker") expect(h.safety.finish).toHaveBeenCalledWith("coverage-token", "admission_revoked"); else expect(h.safety.begin).not.toHaveBeenCalled();
  });
  it("no second pool is created while disposed physical loads remain unsettled", async () => {
    const h = rig(); let resolve: (v: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); await h.admit(); h.api.dispose();
    expect(createEffectRegistry({ window: h.host, load: h.load, safety: h.safety, stockSnapshot: h.coverage })).toMatchObject({ ok: false }); resolve(null); await flush();
    const next = createEffectRegistry({ window: h.host, load: h.load, safety: h.safety, stockSnapshot: h.coverage }); expect(next.ok).toBe(true); next.dispose();
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
  it.each([false, true])("#2057 an early rAF retains a fresh click at the %s degraded cap", async degraded => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready();
    if (degraded) for (const t of [1000, 2000, 3000]) { h.frame(t); h.timer(t); }
    f.send.mockClear(); const start = degraded ? 3000 : 0, period = 1000 / (degraded ? 30 : 60);
    h.at(start + 1); h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(start + 17);
    h.at(start + 18); h.emit("click", { isTrusted: true, clientX: 11, clientY: 20, buttons: 0 }); h.frame(start + 20); expect(f.send).toHaveBeenCalledOnce();
    h.frame(start + 17 + period - 0.001); expect(f.send).toHaveBeenCalledOnce();
    h.frame(start + 17 + period); expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1][0]).toMatchObject({ type: "pointer", kind: "click", ts: start + 18, x: 11 });
    h.frame(start + 100); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("#2057 a newer move replaces the retained move instead of adding a queue", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(17);
    h.at(18); h.emit("pointermove", { isTrusted: true, clientX: 11, clientY: 20, buttons: 0 }); h.frame(20);
    h.at(21); h.emit("pointermove", { isTrusted: true, clientX: 12, clientY: 20, buttons: 1 }); h.frame(25); expect(f.send).toHaveBeenCalledOnce(); h.frame(34);
    expect(f.send.mock.calls[1][0]).toMatchObject({ kind: "move", ts: 21, x: 12, buttons: 1 }); h.frame(60); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("#2057 motion1ms after a click cannot erase it at the %s degraded cap", async degraded => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready();
    if (degraded) for (const t of [1000, 2000, 3000]) { h.frame(t); h.timer(t); }
    const start = degraded ? 3000 : 0; f.send.mockClear();
    h.at(start + 1); h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(start + 17);
    h.at(start + 18); h.emit("click", { isTrusted: true, clientX: 11, clientY: 20, buttons: 0 });
    h.at(start + 19); h.emit("pointermove", { isTrusted: true, clientX: 12, clientY: 20, buttons: 0 }); h.frame(start + 25);
    expect(f.send).toHaveBeenCalledOnce(); h.frame(start + 51);
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.send.mock.calls[1][0]).toMatchObject({ kind: "click", ts: start + 18, x: 11 }); h.frame(start + 100); expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(["pointerdown", "pointerup", "click"])("#2057 a move cannot replace a fresh discrete %s", async type => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    h.emit(type, { isTrusted: true, clientX: 11, clientY: 20, buttons: type === "pointerdown" ? 1 : 0 });
    h.at(1); h.emit("pointermove", { isTrusted: true, clientX: 12, clientY: 20, buttons: 0 }); h.frame(17);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: type.replace("pointer", ""), ts: 0, x: 11 }));
  });
  it("#2057 down/up/click coalesce to the final click; later motion does not replace it", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    for (const [at, type, buttons] of [[0, "pointerdown", 1], [1, "pointerup", 0], [2, "click", 0], [3, "pointermove", 0]] as const) {
      h.at(at); h.emit(type, { isTrusted: true, clientX: 11 + at, clientY: 20, buttons });
    }
    h.frame(17); expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "click", ts: 2, x: 13 })); h.frame(34); expect(f.send).toHaveBeenCalledOnce();
  });
  it("#2057 an expired discrete sample cannot block a fresh move after a host stall", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    h.emit("click", { isTrusted: true, clientX: 11, clientY: 20, buttons: 0 });
    h.at(101); h.emit("pointermove", { isTrusted: true, clientX: 12, clientY: 20, buttons: 1 }); h.frame(102);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "move", ts: 101, x: 12 }));
  });
  it.each([100, 100.001])("#2057 the retained packet keeps its original 100ms freshness bound (%s)", async age => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(17);
    h.at(18); h.emit("click", { isTrusted: true, clientX: 11, clientY: 20, buttons: 0 }); h.frame(20); h.frame(18 + age);
    expect(f.send).toHaveBeenCalledTimes(age === 100 ? 2 : 1); h.frame(150); expect(f.send).toHaveBeenCalledTimes(age === 100 ? 2 : 1);
  });
  it.each(["focus", "stock"]) ("#2057 retained input is discarded on a new %s refusal, never replayed", async barrier => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(17);
    h.at(18); h.emit("click", { isTrusted: true, clientX: 11, clientY: 20, buttons: 0 }); h.frame(20);
    if (barrier === "focus") { h.doc.activeElement = h.node("INPUT"); h.emit("focusin"); } else h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    h.frame(34); expect(f.send).toHaveBeenCalledOnce(); h.doc.activeElement = h.doc.body; h.coverage.mockReturnValue(stock()); h.frame(60); expect(f.send).toHaveBeenCalledOnce();
  });
  it("stock main focus preserves native click and subsequent drag, clearing stale pre-focus down", async () => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    const main = h.node("MAIN"); main.isConnected = true;
    const original = h.doc.querySelectorAll.getMockImplementation();
    h.doc.querySelectorAll.mockImplementation((q: string) => q === "#app > .shell > main#main.main[tabindex='-1']" ? [main] : original(q));
    h.emit("pointerdown", { isTrusted: true, clientX: 10, clientY: 20, buttons: 1 });
    h.doc.activeElement = main; h.emit("focusin"); h.frame(17); expect(f.send).not.toHaveBeenCalled();
    h.emit("pointerup", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 });
    h.emit("click", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(34);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "click" }));
    h.emit("pointermove", { isTrusted: true, clientX: 11, clientY: 20, buttons: 1 }); h.frame(51);
    expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "move", buttons: 1 }));
  });
  it.each(["unknown-main", "detached", "other-document", "duplicate", "wrong-root", "changed-tabindex", "editable", "editable-selector", "design-mode", "trusted-target"])("stock main focus still refuses %s", async fault => {
    const h = rig(); await h.admit(); const f = h.frames()[0]; f.ready(); f.send.mockClear();
    const main = h.node("MAIN"); main.isConnected = fault !== "detached";
    if (fault === "other-document") main.ownerDocument = {};
    if (fault === "editable") main.isContentEditable = true;
    if (fault === "editable-selector") main.matches.mockReturnValue(true);
    if (fault === "design-mode") h.doc.designMode = "on";
    if (fault === "trusted-target") h.doc.body.closest.mockReturnValue(h.doc.body);
    const original = h.doc.querySelectorAll.getMockImplementation();
    h.doc.querySelectorAll.mockImplementation((q: string) => q === "#app > .shell > main#main.main[tabindex='-1']" ? ["unknown-main", "changed-tabindex"].includes(fault) ? [] : fault === "wrong-root" ? [h.node("MAIN")] : fault === "duplicate" ? [main, h.node("MAIN")] : [main] : original(q));
    h.doc.activeElement = main;
    h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 1 }); h.frame(17);
    expect(f.send).not.toHaveBeenCalled();
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
  it("behind effects receive no pointer while a fresh stock barrier denies front interaction", async () => {
    const h = rig(); await h.admit(); const frame = h.frames()[0]; frame.ready(); frame.send.mockClear();
    h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(17);
    expect(frame.state().removed).toBe(false); expect(frame.send).not.toHaveBeenCalled();
    h.coverage.mockReturnValue(stock()); h.at(20); h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 }); h.frame(37);
    expect(frame.send).toHaveBeenCalledWith(expect.objectContaining({ type: "pointer" }));
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
    const h = rig(), ds = h.descriptors(); h.coverage.mockImplementationOnce(() => { h.api.update(ds, gates({ show: false })); return stock(); }); h.api.update(ds, gates()); await flush(); expect(h.frames()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled();
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

describe("#1629 current stock admission", () => {
  it("requires the new provider; a legacy completeness callback never substitutes", () => {
    const h = rig({ stockSnapshot: undefined, trustComplete: () => true }); expect(h.api.ok).toBe(false);
  });
  it("passes the actual privately owned connected root to the observational provider", async () => {
    const h = rig(); await h.admit(); const input = h.coverage.mock.calls[0]![0];
    expect(Object.isFrozen(input)).toBe(true); expect(Object.keys(input)).toEqual(["frameRoot"]);
    expect(input.frameRoot).toBe(h.frames()[0].options.root); expect(input.frameRoot.ownerDocument).toBe(h.doc); expect(input.frameRoot.isConnected).toBe(true);
  });
  it.each([true, Promise.resolve(stock()), stock({ rects: Array(1) }), stock({ front: undefined }), stock({ agentFront: "off" })])("weak/async/malformed evidence %j never calibrates or loads", async value => {
    const h = rig(); h.coverage.mockReturnValue(value); await h.admit(); expect(h.cals()).toHaveLength(0); expect(h.load).not.toHaveBeenCalled(); expect(h.safety.begin).not.toHaveBeenCalled();
  });
  it.each([false, undefined])("owner CSS proof %s blocks agent fronts before allocation, preserving a behind slot", async css => {
    const h = rig(), ds = h.descriptors(4); for (let i = 0; i < 3; i++) ds[i]!.layer = "front";
    h.coverage.mockReturnValue(stock({ agentFront: css })); await h.admit(ds, gates({ constrained: true }));
    if (css === false) { expect(h.load).toHaveBeenCalledOnce(); expect(h.load.mock.calls[0]![0].key).toBe("effect-3"); expect(h.api.snapshot()[0]).toMatchObject({ reason: "owner_css", phase: null }); }
    else expect(h.load).not.toHaveBeenCalled();
  });
  it("human fronts retain the CSS exception, but a stock overlay suppresses both provenances", async () => {
    const h = rig(), ds = h.descriptors(3, { layer: "front" }); ds[1]!.by = "human"; ds[2]!.layer = "behind";
    h.coverage.mockReturnValue(stock({ agentFront: false })); await h.admit(ds);
    expect(h.load.mock.calls.map(c => c[0].key)).toEqual(["effect-1", "effect-2"]);
    h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); h.mutations[0].cb(); await flush();
    expect(h.api.snapshot()[0]).toMatchObject({ reason: "stock_overlay", phase: null }); expect(h.api.snapshot()[1]).toMatchObject({ reason: "stock_overlay", phase: null }); expect(h.api.snapshot()[2].phase).toBe("starting");
    expect(h.frames().filter(f => !f.state().removed)).toHaveLength(1);
  });
  it("the same frozen expanded paint snapshot reaches every reveal in one host frame", async () => {
    const h = rig(), rects = [{ x: -20, y: -30, width: 200, height: 300 }]; h.coverage.mockReturnValue(stock({ rects })); await h.admit(h.descriptors(2));
    for (const frame of h.frames()) frame.ready();
    h.emit("pointermove", { isTrusted: true, clientX: 10, clientY: 20, buttons: 0 });
    const a = h.geo().bindings[0], b = h.geo().bindings[1];
    for (const binding of [a, b]) { expect(binding.sync.mock.calls[0][1].rects).toEqual(rects); expect(Object.isFrozen(binding.sync.mock.calls[0][1])).toBe(true); }
    a.sync.mockClear(); b.sync.mockClear(); h.coverage.mockClear(); h.frame(17);
    expect(h.coverage).toHaveBeenCalledOnce(); for (const frame of h.frames()) expect(frame.send.mock.calls.some((call: any[]) => call[0].type === "pointer")).toBe(true); expect(a.sync).toHaveBeenCalledOnce(); expect(b.sync).toHaveBeenCalledOnce();
    const proof = a.sync.mock.calls[0][1]; expect(proof).toBe(b.sync.mock.calls[0][1]); expect(proof.rects).toEqual(rects); expect(proof.rects).not.toBe(rects); expect(Object.isFrozen(proof.rects[0])).toBe(true);
  });
  it("a CSS denial at held completion clears the request without a marker or frame", async () => {
    const h = rig(); let resolve: (value: any) => void = () => {}; h.load.mockImplementation(() => new Promise(r => { resolve = r; })); const ds = await h.admit(h.descriptors(1, { layer: "front" }));
    h.coverage.mockReturnValue(stock({ agentFront: false })); resolve({ id: ds[0]!.id, code: "agend.ready()", params: {}, assets: [], wants: [] }); await flush();
    expect(h.safety.begin).not.toHaveBeenCalled(); expect(h.frames()).toHaveLength(0); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "admission_revoked" });
    h.coverage.mockReturnValue(stock()); h.api.update(ds, gates()); await flush(); expect(h.load).toHaveBeenCalledOnce();
  });
  it("a denial after marker creation finishes that exact marker and never allocates a frame", async () => {
    const h = rig(); h.safety.begin.mockImplementation(() => { h.coverage.mockReturnValue(stock({ agentFront: false })); return "owned-marker"; });
    await h.admit(h.descriptors(1, { layer: "front" })); expect(h.frames()).toHaveLength(0); expect(h.safety.finish).toHaveBeenCalledWith("owned-marker", "admission_revoked");
  });
  it("a denial on a new host frame stops an agent front before geometry reveal or signal delivery", async () => {
    const h = rig(); await h.admit(h.descriptors(1, { layer: "front" })); const f = h.frames()[0]; f.ready(); f.send.mockClear(); h.geo().bindings[0].sync.mockClear();
    h.coverage.mockReturnValue(stock({ agentFront: false })); expect(h.api.publish("state", { state: "working" }, "own")).toBe(0); h.frame(17);
    expect(f.send).not.toHaveBeenCalled(); expect(h.geo().bindings[0].sync).not.toHaveBeenCalled(); expect(f.state().removed).toBe(true);
  });
  it("getter-driven reentry is not invoked; provider-driven reentry stops without scheduling a callback retry", async () => {
    const h = rig(), ds = h.descriptors(), getter = vi.fn(() => { h.api.update(ds, gates()); return true; });
    h.coverage.mockReturnValue(Object.defineProperty(stock(), "front", { get: getter })); await h.admit(ds); expect(getter).not.toHaveBeenCalled(); expect(h.load).not.toHaveBeenCalled();
    h.coverage.mockImplementation(() => { h.api.update(ds, gates()); return stock(); }); h.api.update(ds, gates()); await flush(); h.timer(20000);
    expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "stock_reentrant" }); expect(h.load).not.toHaveBeenCalled(); expect(h.coverage.mock.calls.length).toBeLessThan(5);
  });
  it("a provider disposing its owner cannot return reusable admission proof", async () => {
    const h = rig(); h.coverage.mockImplementation(() => { h.api.dispose(); return stock(); }); h.api.update(h.descriptors(), gates()); await flush(); expect(h.load).not.toHaveBeenCalled(); expect(h.frames()).toHaveLength(0);
  });
});


describe("transient stock restrictions", () => {
  it.each(["owner_css", "stock_overlay"])("rAF-first %s denial removes without a permanent identity failure", async reason => {
    const h = rig(), ds = await h.admit(h.descriptors(1, { layer: "front" })); const f = h.frames()[0]; f.ready();
    h.coverage.mockReturnValue(stock({ agentFront: false, front: reason === "owner_css" })); h.frame(17);
    expect(f.state().removed).toBe(true); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason });
    h.coverage.mockReturnValue(stock()); h.api.update(ds, gates()); h.cals().at(-1).resolve({ ok: true, baselineFps: 60 }); await flush();
    expect(h.load).toHaveBeenCalledTimes(2); expect(h.frames().filter(f => !f.state().removed)).toHaveLength(1); expect(h.safety.resume).not.toHaveBeenCalled();
  });
  it.each(["owner_css", "stock_overlay"])("heartbeat-first %s does not introduce a trial latch for an ordinary placement", async reason => {
    const h = rig(), ds = await h.admit(h.descriptors(1, { layer: "front" })), f = h.frames()[0]; f.ready();
    h.coverage.mockReturnValue(stock({ agentFront: false, front: reason === "owner_css" })); h.timer(1000); h.frame(1017);
    expect(f.state().removed).toBe(true); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason });
    h.coverage.mockReturnValue(stock()); h.api.update(ds, gates()); h.cals().at(-1).resolve({ ok: true, baselineFps: 60 }); await flush(); expect(h.load).toHaveBeenCalledTimes(2); expect(h.safety.resume).not.toHaveBeenCalled();
  });

});


describe("stock focus wake-up", () => {
  it("focusout re-evaluates a suppressed empty pool without a descriptor update or DOM mutation", async () => {
    const h = rig(); await h.admit(h.descriptors(1, { layer: "front" })); h.frames()[0].ready();
    h.doc.activeElement = h.node("SELECT"); h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); h.emit("focusin"); await flush();
    expect(h.api.snapshot()[0]).toMatchObject({ reason: "stock_overlay", phase: null }); expect(h.frames()[0].state().removed).toBe(true);
    h.doc.activeElement = h.doc.body; h.coverage.mockReturnValue(stock()); h.emit("focusout");
    expect(h.cals()).toHaveLength(2); h.cals()[1].resolve({ ok: true, baselineFps: 60 }); await flush();
    expect(h.frames().filter(f => !f.state().removed)).toHaveLength(1); expect(h.load).toHaveBeenCalledTimes(2);
  });
});

describe("#1629 local Trial admission in the SAME registry (stage protocol modeled)", () => {
  it("admits an exact local stage while ordinary foreground stays suppressed, without a second baseline/load/pool", async () => {
    const h = rig(), t = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    await h.admit([t.d], gates({ modal: true })); const f = h.frames()[0]; expect(f).toBeDefined();
    expect(f.options.root).toBe(t.e.root); expect(f.options.render).toMatchObject({ width: 99, height: 78, instance: "own" });
    expect(t.e.bind).toHaveBeenCalledWith(f.element, { layer: "front" }, expect.objectContaining({ front: false })); expect(h.geo().bind).not.toHaveBeenCalled();
    expect(h.cals()).toHaveLength(1); expect(h.load).toHaveBeenCalledExactlyOnceWith({ key: "trial", id: t.d.id, params: {} }, expect.any(AbortSignal));
    f.ready(); h.frame(100); expect(f.send.mock.calls.filter(([e]: any) => e.type === "env").at(-1)![0]).toMatchObject({ width: 99, height: 78 }); expect(h.api.publish("reply", {}, "own")).toBe(1); expect(h.api.publish("mention", {}, "own")).toBe(0);
    expect(h.api.snapshot()[0]).not.toHaveProperty("trialStage"); expect(f.options.render).not.toHaveProperty("trialStage"); expect(h.mount.mock.calls[0]![0]).not.toHaveProperty("trialStage");
  });
  it("a live branded Trial owns the modal exception; both paths require opaque transport", async () => {
    const h = rig(), t = trial(h), other = h.descriptors(1, { layer: "front" }); h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    await h.admit([t.d, ...other], gates({ modal: true, transportReady: true, optIn: false }));
    expect(h.frames()).toHaveLength(1); expect(h.load).toHaveBeenCalledOnce(); expect(h.load.mock.calls[0][0].key).toBe(t.d.key);
    h.frames()[0].ready(); expect(h.api.publish("reply", {}, "own")).toBe(1);
    h.api.update([t.d, ...other], gates({ transportReady: false, optIn: false, trialReady: false }));
    expect(h.frames()[0].state().removed).toBe(true); expect(h.api.publish("reply", {}, "own")).toBe(0);
  });
  it.each([false, true])("constrained=%s spends the common pool, preserves declared layer and queues without a read", async constrained => {
    const h = rig(), t = trial(h), ds = h.descriptors(4); h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    await h.admit([t.d, ...ds], gates({ constrained, modal: true })); expect(h.frames()).toHaveLength(constrained ? 1 : 3); expect(h.load).toHaveBeenCalledTimes(constrained ? 1 : 3); expect(t.e.bindings[0].placement.layer).toBe("front");
    expect(h.api.snapshot().filter((r: any) => r.verdict === "queued")).toHaveLength(constrained ? 4 : 2);
  });
  it.each(["forged", "key", "id", "generation", "instance", "root"])("%s cannot borrow a local stage exception", async fault => {
    const h = rig(), t = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    if (fault === "forged") t.d.trialStage = {}; else if (fault === "root") { t.d.element = h.node(); t.d.element.isConnected = true; } else t.d[fault] = fault === "generation" ? 2 : "other";
    await h.admit([t.d], gates({ modal: true })); expect(h.load).not.toHaveBeenCalled(); expect(h.frames()).toHaveLength(0);
  });
  it("forged human provenance does not grant owner region priority or clear ordinary foreground suppression", async () => {
    const h = rig(), t = trial(h, { by: "human" }), ordinary = h.descriptors(1, { layer: "front", by: "human", region: "page" })[0]; h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    await h.admit([ordinary, t.d], gates({ modal: true })); expect(h.load).toHaveBeenCalledOnce(); expect(h.load.mock.calls[0]![0].key).toBe("trial");
  });
  it("stage termination synchronously closes factory ownership and its exact safety token, including paused RAF", async () => {
    const h = rig(), t = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); await h.admit([t.d], gates({ modal: true }));
    const frame = h.frames()[0], owner = h.mount.mock.calls[0]![0]; frame.ready(); t.e.end();
    expect(frame.state().removed).toBe(true); expect(owner.current()).toBe(false); expect(h.safety.finish).toHaveBeenCalledExactlyOnceWith("token-1", "trial_ended"); expect(h.retire).toHaveBeenCalledExactlyOnceWith(owner, "trial_ended");
    expect(h.api.resume(t.d.key)).toBe(false); expect(h.safety.resume).not.toHaveBeenCalled(); h.api.dispose(); expect(h.safety.finish).toHaveBeenCalledTimes(1);
  });
  it("a terminated held load keeps physical capacity until settlement and never opens a marker", async () => {
    const h = rig(), t = trial(h); let resolve: any; h.load.mockImplementation(() => new Promise(r => resolve = r)); h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    await h.admit([t.d], gates({ constrained: true, modal: true })); t.e.end(); const other = h.descriptors(); h.api.update(other, gates({ constrained: true })); h.cals().at(-1).resolve({ ok: true, baselineFps: 60 }); await flush(); expect(h.load).toHaveBeenCalledOnce(); expect(h.safety.begin).not.toHaveBeenCalled();
    resolve({ id: t.d.id, code: "agend.ready()", params: {}, assets: [], wants: [] }); await flush(); expect(h.load).toHaveBeenCalledTimes(2); expect(h.frames()).toHaveLength(0);
  });
  it.each(["completion", "marker", "ready", "raf", "heartbeat", "profile", "send"])("stage loss at %s refuses further work", async via => {
    const h = rig(), t = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false }));
    if (via === "completion") h.load.mockImplementationOnce(async (d: any) => { t.e.valid = false; return { id: d.id, params: {}, assets: [], code: "agend.ready()", wants: [] }; });
    if (via === "marker") h.safety.begin.mockImplementationOnce(() => { t.e.valid = false; return "token-1"; });
    await h.admit([t.d], gates({ modal: true }));
    if (["completion", "marker"].includes(via)) { expect(h.frames()).toHaveLength(0); if (via === "marker") expect(h.safety.finish).toHaveBeenCalledOnce(); return; }
    const f = h.frames()[0]; if (via !== "ready") f.ready();
    if (via === "profile") h.profile.mockImplementationOnce(() => { t.e.valid = false; }); else t.e.valid = false;
    if (via === "ready") f.ready(); if (via === "raf") h.frame(100); if (["heartbeat", "profile"].includes(via)) h.timer(1000); if (via === "send") { f.send.mockClear(); expect(h.api.publish("reply", {}, "own")).toBe(0); expect(f.send).not.toHaveBeenCalled(); }
    if (via !== "send") expect(f.state().removed).toBe(true); if (via === "heartbeat") expect(h.profile).not.toHaveBeenCalled();
  });
  it("a current predicate replacement preserves B and prevents A from writing stale results", async () => {
    const h = rig(), a = trial(h), b = trial(h, { key: "trial-b", id: id(89) }); h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); let replaced = false;
    a.e.onProject = () => { if (!replaced) { replaced = true; h.api.update([b.d], gates({ modal: true })); } };
    await h.admit([a.d], gates({ modal: true })); expect(h.api.snapshot()).toHaveLength(1); expect(h.api.snapshot()[0].key).toBe(b.d.key); expect(h.load.mock.calls.every(([d]: any) => d.key === b.d.key)).toBe(true);
  });
  it("hiding and disposal cover local bindings and unregister their watchers", async () => {
    const h = rig(), t = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); await h.admit([t.d], gates({ modal: true })); h.api.update([t.d], gates({ modal: true })); expect(t.e.bindings[0].hide).toHaveBeenCalled(); h.api.dispose(); expect(t.e.listeners.size).toBe(0); expect(h.frames()[0].state().removed).toBe(true);
  });
  it("a new issued serial clears only the old run's failure identity, never the content safety gate", async () => {
    const h = rig(), a = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); await h.admit([a.d], gates({ modal: true })); a.e.end();
    const b = trial(h); h.api.update([b.d], gates({ modal: true })); h.cals().at(-1).resolve({ ok: true, baselineFps: 60 }); await flush(); expect(h.load).toHaveBeenCalledTimes(2); expect(h.frames().at(-1).state().removed).toBe(false);
    h.safety.allowed.mockReturnValue(false); h.api.revalidateSafety(); expect(h.frames().at(-1).state().removed).toBe(true); expect(h.api.resume(b.d.key)).toBe(true); h.cals().at(-1).resolve({ ok: true, baselineFps: 60 }); await flush(); expect(h.load).toHaveBeenCalledTimes(2);
  });
  it("same-receipt predicate recursion is bounded and cannot allocate a replacement from stale evidence", async () => {
    const h = rig(), t = trial(h); h.coverage.mockReturnValue(stock({ front: false, agentFront: false })); t.e.onProject = () => h.api.update([t.d], gates({ modal: true }));
    await h.admit([t.d], gates({ modal: true })); expect(t.e.calls).toBeLessThan(5); expect(h.load).not.toHaveBeenCalled(); expect(h.frames()).toHaveLength(0);
  });

});

describe("#2055: a safety denial is named from the history's own read", () => {
  it.each([["off", "safety_off"], ["paused", "paused"], ["interrupted", "interrupted"], ["unknown", "safety_unknown"], ["ok", "safety_unknown"]])("status %s → %s, and nothing mounts", async (state, reason) => {
    const h = rig(); h.safety.allowed.mockReturnValue(false); (h.safety as any).status = vi.fn(() => ({ state, history: null }));
    await h.admit();
    expect(h.frames()).toHaveLength(0); expect(h.safety.begin).not.toHaveBeenCalled();
    expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason });
  });
  it("an unreadable or missing status read stays unknown (still denied)", async () => {
    for (const status of [() => { throw Error("unreadable"); }, undefined]) {
      const h = rig(); h.safety.allowed.mockReturnValue(false); (h.safety as any).status = status;
      await h.admit();
      expect(h.frames()).toHaveLength(0); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "safety_unknown" });
    }
  });
});

describe("#2055: a sticky safety state outranks a waiting reason", () => {
  it("an effect waiting behind a dialog reads safety_off when its history is off", async () => {
    const h = rig(); h.safety.allowed.mockReturnValue(false); (h.safety as any).status = vi.fn(() => ({ state: "off", history: null }));
    await h.admit(h.descriptors(1, { layer: "front" }), gates({ modal: true }));
    expect(h.frames()).toHaveLength(0); expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "safety_off" });
  });
  it("an ok history leaves the waiting reason alone", async () => {
    const h = rig(); (h.safety as any).status = vi.fn(() => ({ state: "ok", history: null }));
    await h.admit(h.descriptors(1, { layer: "front" }), gates({ modal: true }));
    expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason: "modal" });
  });
});

describe("#2055 R2: one display precedence through the real snapshot (Prism)", () => {
  const withStatus = (h: any, fn: (id: string) => string) => { h.safety.status = vi.fn((id: string) => ({ state: fn(id), history: null })); };
  it("a queued descriptor with an OFF history reads off, not waiting for a slot; an ordinary queue still queues", async () => {
    const h = rig(), ds = h.descriptors(4); withStatus(h, id => (id === ds[3].id ? "off" : "ok"));
    await h.admit(ds);
    expect(h.frames()).toHaveLength(3);
    expect(h.api.snapshot()[3]).toMatchObject({ verdict: "off", reason: "safety_off", queuePos: null, phase: null });
    const q = rig(), qs = q.descriptors(4); withStatus(q, () => "ok"); await q.admit(qs);
    expect(q.api.snapshot()[3]).toMatchObject({ verdict: "queued", reason: "frame_limit" });
  });
  it("the third automatic pause reads off in the same page; a pause that is not the third still reads paused", async () => {
    for (const [after, reason] of [["off", "safety_off"], ["paused", "paused"]] as const) {
      const h = rig(); let state = "ok"; withStatus(h, () => state); h.safety.pause.mockImplementation(() => { state = after; return true; });
      await h.admit(); h.frames()[0].ready();
      for (const t of [1000, 2000, 3000, 4000, 5000]) { h.frame(t); h.timer(t); }
      expect(h.safety.pause).toHaveBeenCalledOnce(); expect(h.frames()[0].state().removed).toBe(true);
      expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason });
    }
  });
  it("another tab's OFF or interruption replaces safety_revoked; an unreadable history stays revoked (fail-closed)", async () => {
    for (const [state, reason] of [["off", "safety_off"], ["interrupted", "interrupted"], ["throw", "safety_revoked"]] as const) {
      const h = rig(); await h.admit(); h.frames()[0].ready();
      h.safety.allowed.mockReturnValue(false);
      (h.safety as any).status = vi.fn(() => { if (state === "throw") throw Error("unreadable"); return { state, history: null }; });
      h.emit("storage"); await flush();
      expect(h.frames()[0].state().removed).toBe(true);
      expect(h.api.snapshot()[0]).toMatchObject({ phase: null, reason });
    }
  });
  it.each([[{ reducedMotion: true }, "reduced_motion"], [{ saveData: true }, "save_data"], [{ show: false }, "disabled"], [{ transportReady: false }, "transport_unavailable"],
    [{ safe: true }, "safe_mode"]])("a closed global gate %o is named %s", async (patch, reason) => {
    const h = rig(), ds = await h.admit(); h.api.update(ds, gates(patch)); await flush();
    expect(h.frames().every((f: any) => f.state().removed)).toBe(true); expect(h.api.snapshot()[0]).toMatchObject({ verdict: "off", reason });
  });
  it("unknown gates stay unknown", async () => {
    const h = rig(), ds = await h.admit(); h.api.update(ds, { ...gates(), show: "maybe" } as any); await flush();
    expect(h.api.snapshot()[0].reason).not.toMatch(/reduced_motion|save_data|disabled|preview_unavailable|safe_mode|public_link/);
  });
});

describe("#2055 R3: a re-entered status read never writes a stale display reason (Prism)", () => {
  it("a nested update for another device keeps its own reason; the outer read's OFF is dropped", async () => {
    const h = rig(), ds = h.descriptors(1); let nested = false;
    (h.safety as any).status = vi.fn((_id: string, device: string) => {
      if (!nested && device === "standard") { nested = true; h.api.update(ds, gates({ constrained: true })); return { state: "off", history: null }; }
      return { state: device === "constrained" ? "paused" : "off", history: null };
    });
    h.safety.allowed.mockReturnValue(false);
    const view = h.api.update(ds, gates()); await flush();
    expect(nested).toBe(true);
    expect(view[0]).toMatchObject({ reason: "paused" }); expect(h.api.snapshot()[0]).toMatchObject({ reason: "paused" });
  });
  it("a stale ok read does not delete the nested current name", async () => {
    const h = rig(), ds = h.descriptors(1); let nested = false;
    (h.safety as any).status = vi.fn((_id: string, device: string) => {
      if (!nested && device === "standard") { nested = true; h.api.update(ds, gates({ constrained: true })); return { state: "ok", history: null }; }
      return { state: "off", history: null };
    });
    h.safety.allowed.mockReturnValue(false);
    h.api.update(ds, gates()); await flush();
    expect(h.api.snapshot()[0]).toMatchObject({ reason: "safety_off" });
  });
  it("a read that disposes the registry writes nothing and does not throw", async () => {
    const h = rig(), ds = h.descriptors(1);
    (h.safety as any).status = vi.fn(() => { h.api.dispose(); return { state: "off", history: null }; });
    h.safety.allowed.mockReturnValue(false);
    expect(() => h.api.update(ds, gates())).not.toThrow(); await flush();
  });
});
