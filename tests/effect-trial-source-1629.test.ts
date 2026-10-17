/** Source lifecycle uses the real source/codec with a branded stage protocol double; no DOM/paint/native claim. */
import { describe, expect, it, vi } from "vitest";
const staged = vi.hoisted(() => new WeakMap<object, any>());
vi.mock("../src/ui/shared/effect-trial-stage.js", () => ({
  constrainEffectTrialStage: (receipt: object, fn: any) => { const s = staged.get(receipt); if (!s?.live || s.constraint) return false; s.constraint = fn; return true; },
  disposeEffectTrialStage: (receipt: object) => { const s = staged.get(receipt); if (!s?.live) return false; s.end(); return true; },
  effectTrialStageIdentity: (receipt: object) => staged.get(receipt)?.identity ?? null,
  effectTrialStage: (receipt: object, _expected: any, stock: any) => { const s = staged.get(receipt); return s?.live && s.project && (!s.constraint || s.constraint() === true) && stock?.ok ? { root: s.root, rect: { x: 0, y: 0, width: 100, height: 80 } } : null; },
  watchEffectTrialStage: (receipt: object, fn: () => void) => { const s = staged.get(receipt); if (!s?.live) return null; s.listeners.add(fn); return () => s.listeners.delete(fn); },
}));
const { createEffectTrialSource } = await import("/assets/effect-trial-source.js");
const ID = "a".repeat(32), OFFER = "b".repeat(32), RUN = "c".repeat(32);
const manifest = () => ({ v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["page"], layer: "front", wants: ["state"], params: { n: { type: "int", min: 1, max: 4, default: 2 } } });
const reply = (patch = {}): any => ({ trial: RUN, offer: { v: 1, offer: OFFER, id: ID, title: "Fixture", expiresAt: 1234567 }, remainingMs: 10000, manifest: manifest(), params: { n: 2 }, ...patch });
const resource = (patch = {}): any => ({ id: ID, manifest: manifest(), params: { n: 2 }, code: "agend.ready()", assets: [], wants: ["state"], ...patch });
const held = () => { let resolve!: (x: any) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function rig() {
  let time = 0, live = true, owner: any = {}, serial = 0, timerId = 0; const timers = new Map<number, { fn: () => void; delay: number }>(), log: string[] = [];
  const host = { AbortController, performance: { now: () => time }, setTimeout: vi.fn((fn: () => void, delay: number) => { timers.set(++timerId, { fn, delay }); return timerId; }), clearTimeout: (id: number) => timers.delete(id) };
  const current = vi.fn(() => live), ownerCurrent = vi.fn((candidate: any, name: string) => candidate === owner && name === "own"), changed = vi.fn(), read = vi.fn(async (_spec?: any, _signal?: any): Promise<any> => resource());
  const api = createEffectTrialSource({ window: host, current, ownerCurrent, stock: () => ({ ok: true, front: false }), readResource: read, onChange: changed });
  function stage() {
    const receipt = Object.freeze({}), s: any = { identity: Object.freeze({ key: `trial:${++serial}`, id: ID, instance: "own", generation: serial, serial }), live: true, project: true, root: { isConnected: true }, listeners: new Set() };
    staged.set(receipt, s);
    const dispose = vi.fn(() => { if (!s.live) return; log.push("physical"); s.live = false; s.root.isConnected = false; staged.delete(receipt); for (const fn of [...s.listeners]) fn(); s.listeners.clear(); });
    s.end = dispose; return { api: Object.freeze({ receipt, dispose, hide() {} }), s, dispose };
  }
  function options(s = stage(), patch = {}) { const stop = vi.fn(() => log.push("stop")); return { input: { reply: reply(), offer: OFFER, startedAt: time, stage: s.api, current: () => true, onStop: stop, ...patch }, stage: s, stop }; }
  const attach = (p = options()) => ({ ...p, handle: api.attach(p.input, owner) });
  return { api, host, read, current, ownerCurrent, changed, timers, log, options, stage, attach, owner: () => owner,
    at(t: number) { time = t; }, stale() { live = false; }, replaceOwner() { owner = {}; }, tick() { const entries = [...timers.entries()]; entries.forEach(([id]) => timers.delete(id)); entries.forEach(([, t]) => t.fn()); } };
}

describe("private Trial lease contribution (no registry/loader factory)", () => {
  it("binds a private stage to one forced-agent sample and snapshots metadata independently", () => {
    const h = rig(), a = h.attach(); expect(a.handle).not.toBeNull(); const ds = h.api.descriptors();
    expect(ds).toEqual([{ key: a.stage.s.identity.key, id: ID, by: "agent", region: "chat", layer: "front", order: 0, paused: false, visible: true, instance: "own", generation: a.stage.s.identity.generation, trialStage: a.stage.api.receipt, params: { n: 2 }, element: a.stage.s.root }]);
    a.input.reply.params.n = 4; expect(h.api.descriptors()[0].params).toEqual({ n: 2 }); expect(a.handle.snapshot()).toMatchObject({ id: ID, trial: RUN, remainingMs: 10000 });
    expect(h.host.setTimeout).toHaveBeenCalledOnce(); expect(h.host.setTimeout.mock.calls[0]![1]).toBe(10000); h.api.dispose();
  });
  it.each(["no-stage", "cloned-receipt", "extra", "accessor", "bad-started", "future-started", "expired", "bad-reply", "wrong-owner", "predicate"])("denies %s without replacing an active contribution", fault => {
    const h = rig(), a = h.attach(), p = h.options(); let owner: any = h.owner(), reads = 0;
    if (fault === "no-stage") p.input.stage = null as any;
    if (fault === "cloned-receipt") p.input.stage = { ...p.stage.api, receipt: {} };
    if (fault === "extra") (p.input as any).url = "https://trap.invalid";
    if (fault === "accessor") Object.defineProperty(p.input, "reply", { enumerable: true, get() { reads++; throw Error("getter"); } });
    if (fault === "bad-started") p.input.startedAt = Symbol() as any;
    if (fault === "future-started") p.input.startedAt = 1;
    if (fault === "expired") { p.input.startedAt = 0; p.input.reply.remainingMs = 1; h.at(1); }
    if (fault === "bad-reply") p.input.reply.offer.id = "e".repeat(32);
    if (fault === "wrong-owner") owner = {};
    if (fault === "predicate") p.input.current = () => false;
    expect(h.api.attach(p.input, owner)).toBeNull(); expect(reads).toBe(0); expect(a.handle.current()).toBe(true); expect(a.stop).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("copies own descriptors without invoking a valid input Proxy's ordinary get trap", () => {
    const h = rig(), p = h.options(); let reads = 0; const proxy = new Proxy(p.input, { get() { reads++; throw Error("ordinary get"); } });
    const handle = h.api.attach(proxy, h.owner()); expect(handle).not.toBeNull(); expect(reads).toBe(0); handle.stop(); h.api.dispose();
  });
  it("the issued stage has a permanent source lease veto, including expiry before a delayed timer", () => {
    const h = rig(), a = h.attach(); expect(typeof a.stage.s.constraint).toBe("function"); h.at(9999); expect(a.stage.s.constraint()).toBe(true);
    h.at(10000); expect(a.stage.s.constraint()).toBe(false); expect(a.stage.s.root.isConnected).toBe(false); expect(a.stop).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("an already spent request budget cannot be refreshed at attach, including slow predicates", () => {
    const h = rig(), p = h.options(); h.at(6000); p.input.reply.remainingMs = 5000; expect(h.api.attach(p.input, h.owner())).toBeNull();
    const q = h.options(); q.input.reply.remainingMs = 10; q.input.current = () => { h.at(6011); return true; }; expect(h.api.attach(q.input, h.owner())).toBeNull(); expect(q.stop).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("expires at the exact cutoff even when the timer is late, and early timers only reschedule", () => {
    const h = rig(), a = h.attach(); h.at(1); h.tick(); expect(a.handle.current()).toBe(true); expect(h.host.setTimeout.mock.calls.at(-1)![1]).toBe(9999);
    h.at(9999); expect(h.api.descriptors()).toHaveLength(1); h.at(10000); expect(h.api.descriptors()).toEqual([]); expect(a.stop).toHaveBeenCalledOnce(); expect(a.stage.dispose).toHaveBeenCalledOnce(); h.tick(); expect(a.stop).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it.each(["owner", "global", "projection", "clock", "nonfinite", "stage"])("a lost %s condition is terminal for the exact lease", fault => {
    const h = rig(), p = h.options(), a = h.attach(p);
    if (fault === "owner") h.replaceOwner();
    if (fault === "global") h.stale(); if (fault === "projection") p.stage.s.project = false; if (fault === "clock") { h.at(2); expect(a.handle.current()).toBe(true); h.at(1); }
    if (fault === "nonfinite") h.at(NaN); if (fault === "stage") p.stage.api.dispose();
    expect(h.api.descriptors()).toEqual([]); expect(a.handle.current()).toBe(false); expect(p.stop).toHaveBeenCalledOnce(); expect(h.log.indexOf("physical")).toBeLessThan(h.log.indexOf("stop")); h.api.dispose();
  });
  it("a wrapper cannot substitute its own cleanup for the issued stage owner's physical removal", () => {
    const h = rig(), p = h.options(), fake = vi.fn(); p.input.stage = { ...p.stage.api, dispose: fake }; const a = h.attach(p);
    expect(a.handle).not.toBeNull(); a.handle.stop(); expect(p.stage.dispose).toHaveBeenCalledOnce(); expect(fake).not.toHaveBeenCalled(); expect(p.stage.s.root.isConnected).toBe(false); h.api.dispose();
  });
  it("the captured current predicate can revoke a lease without being replaced by input mutation", () => {
    const h = rig(); let current = true; const p = h.options(undefined, { current: () => current }), a = h.attach(p); p.input.current = () => true; current = false;
    expect(a.handle.current()).toBe(false); current = true; expect(a.handle.current()).toBe(false); expect(p.stop).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("clock rollback cannot be forgiven by a later timestamp or a new receipt", () => {
    const h = rig(), a = h.attach(); h.at(2); expect(a.handle.current()).toBe(true); h.at(1); expect(a.handle.current()).toBe(false); h.at(3);
    expect(h.api.attach(h.options().input, h.owner())).toBeNull(); h.api.dispose();
  });
  it("old handles and old owner cleanup never stop a replacement", () => {
    const h = rig(), owner = h.owner(), a = h.attach(), b = h.attach(); expect(a.stop).toHaveBeenCalledOnce();
    a.handle.stop(); expect(a.handle.snapshot()).toBeNull(); expect(b.handle.current()).toBe(true); expect(h.api.stopFor({})).toBe(false); expect(h.api.stopFor(owner)).toBe(true); expect(b.stop).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a stop callback's newer attach survives the older replace operation", () => {
    const h = rig(), b = h.options(), c = h.options(); let installed: any = null;
    const a = h.attach(h.options(undefined, { onStop: () => { installed = h.api.attach(b.input, h.owner()); } }));
    expect(h.api.attach(c.input, h.owner())).toBeNull(); expect(installed.current()).toBe(true); a.handle.stop(); expect(installed.current()).toBe(true); h.api.dispose();
  });
  it("current-predicate attach reentry preserves the new lease and rejects the old completion", () => {
    const h = rig(), b = h.options(); let armed = false, installed: any = null;
    const a = h.attach(h.options(undefined, { current: () => { if (armed) { armed = false; installed = h.api.attach(b.input, h.owner()); } return true; } }));
    armed = true; expect(a.handle.current()).toBe(false); expect(installed.current()).toBe(true); expect(h.api.descriptors()[0].key).toBe(b.stage.s.identity.key); h.api.dispose();
  });
  it("a used receipt cannot be replayed after stop, and disposal is one-shot", () => {
    const h = rig(), p = h.options(), a = h.attach(p); a.handle.stop(); expect(h.api.attach(p.input, h.owner())).toBeNull(); h.api.dispose(); h.api.dispose(); expect(p.stop).toHaveBeenCalledOnce(); expect(h.api.attach(h.options().input, h.owner())).toBeNull();
  });
  it("only the exact live binding reads through the fixed Trial callback", async () => {
    const h = rig(), a = h.attach(), d = h.api.descriptors()[0], b = h.api.binding(d.key, d.id);
    expect(h.api.binding("other", ID)).toBeNull(); expect(h.api.binding(d.key, "e".repeat(32))).toBeNull(); expect(await h.api.load({ ...b }, new AbortController().signal)).toBeNull();
    expect(await h.api.load(b, new AbortController().signal)).toMatchObject({ id: ID }); expect(h.read).toHaveBeenCalledWith({ trial: RUN, id: ID, instance: "own" }, expect.any(AbortSignal)); h.api.dispose();
  });
  it.each([null, { id: "e".repeat(32) }, { params: { n: 3 } }, { manifest: { ...manifest(), title: "Other" } }])("a refused/mismatched resource ends only its exact lease: %j", patch => {
    const h = rig(), a = h.attach(), d = h.api.descriptors()[0], b = h.api.binding(d.key, d.id); h.read.mockResolvedValueOnce(patch === null ? null : resource(patch));
    return h.api.load(b, new AbortController().signal).then((x: any) => { expect(x).toBeNull(); expect(a.stop).toHaveBeenCalledOnce(); h.api.dispose(); });
  });
  it("the final resource acceptance fence survives a host metadata callback replacing A with B", async () => {
    const h = rig(), a = h.attach(), d = h.api.descriptors()[0], b = h.api.binding(d.key, d.id), next = h.options(); let installed: any = null;
    const value = resource(); Object.defineProperty(value, "params", { enumerable: true, get() { installed ??= h.api.attach(next.input, h.owner()); return { n: 2 }; } });
    h.read.mockResolvedValueOnce(value); expect(await h.api.load(b, new AbortController().signal)).toBeNull(); expect(installed.current()).toBe(true); a.handle.stop(); expect(installed.current()).toBe(true); h.api.dispose();
  });
  it("resource metadata equality ignores field order and still preserves resolved params", async () => {
    const h = rig(), a = h.attach(), d = h.api.descriptors()[0], b = h.api.binding(d.key, d.id), m = manifest();
    h.read.mockResolvedValueOnce(resource({ manifest: Object.fromEntries(Object.entries(m).reverse()) })); expect(await h.api.load(b, new AbortController().signal)).not.toBeNull(); expect(a.handle.current()).toBe(true); h.api.dispose();
  });
  it("stage end synchronously stops its lease and aborts a held read without a descriptors poll", async () => {
    const h = rig(), a = h.attach(), key = a.stage.s.identity.key, binding = h.api.binding(key, ID), wait = held();
    h.read.mockImplementationOnce(() => wait.promise);
    const loading = h.api.load(binding, new AbortController().signal);
    expect(h.read).toHaveBeenCalledOnce(); const signal = h.read.mock.calls[0]![1]; expect(signal.aborted).toBe(false);
    a.stage.api.dispose(); // No descriptors/current/heartbeat call may be needed to deliver stage end.
    expect(a.stop).toHaveBeenCalledExactlyOnceWith("stage_ended"); expect(signal.aborted).toBe(true);
    expect(a.handle.current()).toBe(false); expect(h.api.binding(key, ID)).toBeNull();
    expect(await h.api.load(binding, new AbortController().signal)).toBeNull(); expect(h.read).toHaveBeenCalledOnce();
    wait.resolve(resource()); expect(await loading).toBeNull(); h.api.dispose();
  });
  it("stop aborts but does not settle a held physical read, and a late old response cannot fail B", async () => {
    const h = rig(), a = h.attach(), d = h.api.descriptors()[0], b = h.api.binding(d.key, d.id), wait = held(); h.read.mockImplementationOnce(() => wait.promise);
    let settled = false; const loading = h.api.load(b, new AbortController().signal).then((x: any) => { settled = true; return x; }); await flush();
    const duplicate = h.api.load(b, new AbortController().signal); await flush(); expect(h.read).toHaveBeenCalledOnce(); expect(await duplicate).toBeNull(); const next = h.attach();
    expect(h.read.mock.calls[0]![1].aborted).toBe(true); await flush(); expect(settled).toBe(false); wait.resolve(null); expect(await loading).toBeNull(); expect(next.handle.current()).toBe(true); expect(next.stop).not.toHaveBeenCalled(); h.api.dispose();
  });
});
