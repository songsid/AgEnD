/** Host protocol fixtures only: no product click, real server session, stage or browser proof. */
import { describe, expect, it, vi } from "vitest";
const { createEffectTrialController } = await import("/ui/js/effect-trial-controller.js");
const ID = "a".repeat(32), OFFER = "b".repeat(32), TRIAL = "c".repeat(32), EPOCH = "d".repeat(16);
const offer = () => ({ v: 1, offer: OFFER, id: ID, title: "Fixture", expiresAt: 600000 });
const message = (patch = {}) => ({ sender: "agend", role: "status", instance: "worker /&", effectTrial: offer(), ...patch });
const reply = (patch = {}) => ({ trial: TRIAL, offer: offer(), remainingMs: 600000, manifest: { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "Fixture", regions: ["page"], layer: "front", wants: ["theme"] }, params: {}, ...patch });
const response = (data: any = reply(), patch = {}) => ({ status: 200, redirected: false, headers: new Headers({ "content-type": "application/json" }), body: new Response(JSON.stringify(data)).body, ...patch });
function held<T = any>() { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
async function flush() { for (let n = 0; n < 35; n++) await Promise.resolve(); }
function fixture(patch = {}) {
  let time = 0, wall = 1, live = true, allowed = true, ended = false, timerId = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>(), events = new Map<string, Set<() => void>>(), offAuth = vi.fn(), disposeStage = vi.fn();
  const add = (k: string, fn: () => void) => { if (!events.has(k)) events.set(k, new Set()); events.get(k)!.add(fn); };
  const doc = { body: { dataset: { mode: "full" } }, documentElement: { getAttribute: () => JSON.stringify({ ownerScope: "person", ownerEpoch: EPOCH }) }, visibilityState: "visible", addEventListener: add, removeEventListener: (k: string, fn: () => void) => events.get(k)?.delete(fn) };
  const host: any = { document: doc, Date: { now: () => wall }, AbortController, performance: { now: () => time }, addEventListener: add, removeEventListener: doc.removeEventListener,
    setTimeout: vi.fn((fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; }), clearTimeout: (id: number) => timers.delete(id),
    AgendAuth: { sessionEnded: () => ended, trialSession: vi.fn(async () => ({ localAdmin: true, epoch: EPOCH })), onSessionEnd: vi.fn((fn: () => void) => { add("auth", fn); return offAuth; }) },
    fetch: vi.fn(async (path: string) => path.includes("/start?") ? response() : response({ ok: true })), ...patch,
  };
  const start = vi.fn((_handle: any) => disposeStage), change = vi.fn(), current = vi.fn((_instance?: string) => live), gate = vi.fn(() => allowed);
  const api = createEffectTrialController({ window: host, current, allowed: gate, onStart: start, onChange: change });
  return { api, host, doc, timers, events, start, change, current, gate, disposeStage, offAuth, at: (t: number) => { time = t; }, wall: (t: number) => { wall = t; }, stale: () => { live = false; }, deny: () => { allowed = false; }, end: () => { ended = true; events.get("auth")?.forEach(fn => fn()); }, fire: (name: string) => events.get(name)?.forEach(fn => fn()), timeout: () => [...timers.values()][0]?.fn() };
}
describe("explicit Trial controller lane (unmounted)", () => {
  it("import/setup fetch nothing; one explicit call uses the fixed JSON Start with session hint and a frozen owner handle", async () => {
    const h = fixture(); expect(h.api.ok).toBe(true); expect(h.host.fetch).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
    expect(await h.api.start(message())).toBe(true); expect(h.start).toHaveBeenCalledOnce(); expect(h.host.AgendAuth.trialSession).toHaveBeenCalledOnce();
    expect(h.host.fetch).toHaveBeenCalledExactlyOnceWith(`/ui/effect-trials/start?ownerEpoch=${EPOCH}`, expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offer: OFFER, instance: "worker /&" }) }));
    const handle = h.start.mock.calls[0]![0]; expect(Object.isFrozen(handle)).toBe(true); expect(Object.isFrozen(handle.reply.manifest)).toBe(true); expect(handle.startedAt).toBe(0); expect(handle.current()).toBe(true); expect(handle.instance).toBe("worker /&");
    expect(await h.api.start(message())).toBe(false); expect(h.host.fetch).toHaveBeenCalledOnce(); h.api.dispose(); await flush();
  });
  it.each([null, { localAdmin: false, epoch: EPOCH }, { localAdmin: true, epoch: "e".repeat(16) }, { localAdmin: "true", epoch: EPOCH }])("a refused session display hint %j cannot issue Start", async session => {
    const h = fixture(); h.host.AgendAuth.trialSession.mockResolvedValue(session); expect(await h.api.start(message())).toBe(false); expect(h.host.fetch).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled(); h.api.dispose();
  });
  it.each([{ sender: "worker" }, { role: "agent" }, { instance: "" }, { effectTrial: { ...offer(), url: "/evil" } }])("refuses invalid host message %j", async patch => {
    const h = fixture(); expect(await h.api.start(message(patch))).toBe(false); expect(h.host.fetch).not.toHaveBeenCalled(); h.api.dispose();
  });
  it.each(["public", "view", "header", "poll"])("has no controller for %s boot", async kind => {
    const h = fixture(); h.api.dispose(); const doc: any = { ...h.doc, body: { dataset: { mode: kind === "view" ? "view" : "full", ...(kind === "public" ? { publicLink: "1" } : {}), ...(kind === "poll" ? { webTransport: "poll" } : {}) } }, documentElement: { getAttribute: () => kind === "header" ? "{}" : JSON.stringify({ ownerEpoch: EPOCH, ownerScope: "person" }) } };
    const a = createEffectTrialController({ window: { ...h.host, document: doc }, current: () => true, allowed: () => true, onStart: vi.fn() }); expect(a.ok).toBe(false); expect(await a.start(message())).toBe(false);
  });
  it("a synchronously ended auth episode releases its subscription and installs no listeners", () => {
    const h = fixture(); h.api.dispose(); const off = vi.fn(), add = vi.fn(), mount = vi.fn();
    const host = { ...h.host, addEventListener: add, AgendAuth: { ...h.host.AgendAuth, onSessionEnd: (fn: () => void) => { fn(); return off; } } };
    const a = createEffectTrialController({ window: host, current: () => true, allowed: () => true, onStart: mount }); expect(a.ok).toBe(false); expect(off).toHaveBeenCalledOnce(); expect(add).not.toHaveBeenCalled();
  });
  it("owns exactly one controller per Window, including after dispose; no new session episode is invented", () => {
    const h = fixture(); h.api.dispose(); const a = createEffectTrialController({ window: h.host, current: () => true, allowed: () => true, onStart: vi.fn() }); expect(a.ok).toBe(false); expect(h.offAuth).toHaveBeenCalledOnce();
  });
  it.each(["stale", "gate", "auth", "blur", "pagehide", "hidden"])("%s stops physical stage before issuing one Stop, with no automatic Start", async kind => {
    const h = fixture(); expect(await h.api.start(message())).toBe(true);
    const order: string[] = []; h.disposeStage.mockImplementation(() => order.push("paint removed")); h.host.fetch.mockClear(); h.host.fetch.mockImplementation(async () => { order.push("stop HTTP"); return response({ ok: true }); });
    if (kind === "stale") h.stale(); if (kind === "gate") h.deny(); if (kind === "auth") h.end(); if (kind === "hidden") h.doc.visibilityState = "hidden";
    if (["blur", "pagehide", "hidden"].includes(kind)) h.fire(kind === "hidden" ? "visibilitychange" : kind); else h.api.sync();
    expect(order).toEqual(["paint removed"]); await flush(); expect(order).toEqual(["paint removed", "stop HTTP"]); h.api.stop(); h.api.dispose(); await flush(); expect(h.host.fetch).toHaveBeenCalledOnce();
    expect(h.host.fetch).toHaveBeenCalledWith(`/ui/effect-trials/${TRIAL}/stop?ownerEpoch=${EPOCH}`, expect.objectContaining({ body: "{}", method: "POST" }));
  });
  it("removes physical paint before notifying a reentrant Start observer and draining Stop", async () => {
    const h = fixture(); expect(await h.api.start(message())).toBe(true);
    const order: string[] = [], observations: boolean[] = []; let painted = true, attempt: Promise<boolean> | null = null;
    h.disposeStage.mockImplementation(() => { painted = false; order.push("paint removed"); });
    h.change.mockImplementationOnce(() => { observations.push(painted); order.push("observer"); attempt = h.api.start(message()); });
    h.host.fetch.mockImplementation(async () => { order.push("stop HTTP"); return response({ ok: true }); });
    h.api.stop(); expect(observations).toEqual([false]); expect(order).toEqual(["paint removed", "observer"]);
    expect(attempt).not.toBeNull(); expect(await attempt!).toBe(false); await flush();
    expect(order).toEqual(["paint removed", "observer", "stop HTTP"]); expect(h.start).toHaveBeenCalledOnce();
    expect(h.disposeStage).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it.each(["title", "expiresAt"])("an active Start with a changed offer %s is stopped without mounting", async field => {
    const h = fixture(), changed = { ...offer(), [field]: field === "title" ? "Changed" : 599999 };
    const data = reply({ offer: changed }); data.manifest.title = changed.title;
    h.host.fetch.mockResolvedValueOnce(response(data));
    expect(await h.api.start(message())).toBe(false); await flush(); expect(h.start).not.toHaveBeenCalled();
    expect(h.host.fetch).toHaveBeenCalledTimes(2);
    expect(h.host.fetch.mock.calls[1]![0]).toBe(`/ui/effect-trials/${TRIAL}/stop?ownerEpoch=${EPOCH}`); h.api.dispose();
  });
  it("a pending session read times out logically, retains the lane and never starts from its late answer", async () => {
    const h = fixture(), p = held(); h.host.AgendAuth.trialSession.mockReturnValue(p.promise); const result = h.api.start(message()); await flush(); expect(h.host.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10000);
    h.at(10000); h.timeout(); expect(await result).toBe(false); expect(h.api.snapshot().busy).toBe(true); expect(await h.api.start(message())).toBe(false); p.resolve({ localAdmin: true, epoch: EPOCH }); await flush(); expect(h.host.fetch).not.toHaveBeenCalled(); expect(h.api.snapshot().busy).toBe(false); h.api.dispose();
  });
  it.each([9999, 10000, 10001])("checks a delayed timer at response acceptance %sms", async at => {
    const h = fixture(), p = held(); h.host.fetch.mockReturnValueOnce(p.promise); const result = h.api.start(message()); await flush(); h.at(at); p.resolve(response()); const ok = await result; await flush(); expect(ok).toBe(at < 10000); expect(h.start).toHaveBeenCalledTimes(at < 10000 ? 1 : 0); expect(h.host.fetch.mock.calls.filter(([s]: any[]) => s.includes("/stop?"))).toHaveLength(at < 10000 ? 0 : 1); h.api.dispose(); await flush();
  });
  it("an explicitly stopped late Start is only cleaned up, never mounted or reused", async () => {
    const h = fixture(), p = held(); h.host.fetch.mockReturnValueOnce(p.promise); const a = h.api.start(message()); await flush(); h.api.stop(); expect(await a).toBe(false); expect(h.api.snapshot().busy).toBe(true); p.resolve(response()); await flush(); expect(h.start).not.toHaveBeenCalled(); expect(h.host.fetch).toHaveBeenCalledTimes(2); expect(h.api.snapshot().busy).toBe(false); h.api.dispose();
  });
  it("a late valid run with changed display snapshot is still stopped, never mounted", async () => {
    const h = fixture(), p = held(); h.host.fetch.mockReturnValueOnce(p.promise); const a = h.api.start(message()); await flush(); h.api.stop(); expect(await a).toBe(false);
    p.resolve(response(reply({ offer: { ...offer(), expiresAt: 599999 } }))); await flush(); expect(h.start).not.toHaveBeenCalled(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it("remainingMs is anchored to request entry, not response arrival or wall expiry", async () => {
    const h = fixture(), p = held(); h.host.fetch.mockReturnValueOnce(p.promise); const a = h.api.start(message()); await flush(); h.at(9000); p.resolve(response(reply({ remainingMs: 8000 }))); expect(await a).toBe(false); await flush(); expect(h.start).not.toHaveBeenCalled(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it("lease acceptance checks time again after slow predicates; no timer can refresh it", async () => {
    const h = fixture(); h.gate.mockImplementation(() => { h.at(10000); return true; }); expect(await h.api.start(message())).toBe(false); expect(h.host.fetch).not.toHaveBeenCalled(); h.api.dispose();
  });
  it.each(["current", "gate"])("synchronous %s reentry cannot recursively validate or admit the old operation", async field => {
    const h = fixture(); h[field === "current" ? "current" : "gate"].mockImplementation(() => { h.api.sync(); return true; });
    expect(await h.api.start(message())).toBe(false); expect(h.start).not.toHaveBeenCalled(); expect(h.host.fetch).not.toHaveBeenCalled(); expect(h.current).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a current-handle check rechecks elapsed lease time after a slow gate", async () => {
    const h = fixture(); expect(await h.api.start(message())).toBe(true); const a = h.start.mock.calls[0]![0]; h.at(599999); h.gate.mockImplementation(() => { h.at(600000); return true; }); expect(a.current()).toBe(false); h.api.sync(); await flush(); expect(h.disposeStage).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("later lease deadline is exact and cannot be renewed by repeated sync", async () => {
    const h = fixture(); expect(await h.api.start(message())).toBe(true); h.at(599999); h.api.sync(); expect(h.disposeStage).not.toHaveBeenCalled(); h.at(600000); h.api.sync(); await flush(); expect(h.disposeStage).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it.each([NaN, Infinity, -1])("bad monotonic clock %s permanently refuses future starts", async n => {
    const h = fixture(); h.at(n); expect(await h.api.start(message())).toBe(false); h.at(0); expect(await h.api.start(message())).toBe(false); expect(h.host.fetch).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("clock rollback ends a running sample and cannot restart after recovery", async () => {
    const h = fixture(); h.at(10); expect(await h.api.start(message())).toBe(true); h.at(9); h.api.sync(); await flush(); h.at(20); expect(await h.api.start(message())).toBe(false); expect(h.disposeStage).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a response body and cancellation retain physical capacity until both settle", async () => {
    const h = fixture(), reading = held(), cancelling = held(); const cancel = vi.fn(() => cancelling.promise); h.host.fetch.mockResolvedValueOnce(response({}, { body: { getReader: () => ({ read: () => reading.promise, cancel }) } }));
    const a = h.api.start(message()); await flush(); h.api.stop(); expect(await a).toBe(false); expect(h.api.snapshot().busy).toBe(true); reading.resolve({ done: true }); await flush(); expect(cancel).toHaveBeenCalledOnce(); expect(h.api.snapshot().busy).toBe(true); cancelling.resolve(undefined); await flush(); expect(h.api.snapshot().busy).toBe(false); h.api.dispose();
  });
  it("Stop cleanup holds the lane through its response cancellation, including after disposal", async () => {
    const h = fixture(), p = held(); expect(await h.api.start(message())).toBe(true); h.host.fetch.mockResolvedValueOnce({ body: { cancel: () => p.promise } }); h.api.dispose(); await flush(); expect(h.api.snapshot().busy).toBe(true); p.resolve(undefined); await flush(); expect(h.api.snapshot().busy).toBe(false); expect(h.host.fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["mime", "redirect", "length", "stream", "utf8", "json", "shape", "status"])("refuses bounded response %s", async kind => {
    const h = fixture(); let r: any = response();
    if (kind === "mime") r.headers.set("content-type", "text/html"); if (kind === "redirect") r.redirected = true; if (kind === "length") r.headers.set("content-length", "131073"); if (kind === "status") r.status = 403;
    if (kind === "stream") r.body = new Response("x".repeat(131073)).body; if (kind === "utf8") r.body = new Response(new Uint8Array([0xff])).body; if (kind === "json") r.body = new Response("{").body; if (kind === "shape") r = response(reply({ url: "/evil" }));
    h.host.fetch.mockResolvedValueOnce(r); expect(await h.api.start(message())).toBe(false); expect(h.start).not.toHaveBeenCalled(); expect(h.api.snapshot().busy).toBe(false); h.api.dispose();
  });
  it("the streamed bound rejects otherwise-valid JSON padded beyond the cap", async () => {
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response({}, { body: new Response(" ".repeat(131073) + JSON.stringify(reply())).body })); expect(await h.api.start(message())).toBe(false); expect(h.start).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("fatal UTF8 rejects an otherwise-valid manifest description containing an invalid byte", async () => {
    const h = fixture(), data = reply(); (data.manifest as any).description = "X";
    const text = JSON.stringify(data), at = text.indexOf('"description":"X"') + '"description":"'.length, bytes = new TextEncoder().encode(text); expect(at).toBeGreaterThan(0); bytes[at] = 255;
    h.host.fetch.mockResolvedValueOnce(response({}, { body: new Response(bytes).body })); expect(await h.api.start(message())).toBe(false); expect(h.start).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("refuses an expired offer before session I/O and sends no token elsewhere", async () => {
    const h = fixture(); h.wall(600000); expect(await h.api.start(message())).toBe(false); expect(h.host.AgendAuth.trialSession).not.toHaveBeenCalled(); expect(h.host.fetch).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("an observer that stops just after mounting cannot report a successful active trial", async () => {
    const h = fixture(); h.change.mockImplementation(() => { if (h.api.snapshot().phase === "running") h.api.stop(); }); expect(await h.api.start(message())).toBe(false); await flush(); expect(h.disposeStage).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it("an old handle cannot stop a new explicit trial after cleanup has settled", async () => {
    const h = fixture(); expect(await h.api.start(message())).toBe(true); const a = h.start.mock.calls[0]![0]; a.stop(); await flush();
    expect(await h.api.start(message())).toBe(true); const b = h.start.mock.calls[1]![0]; a.stop(); expect(b.current()).toBe(true); expect(h.disposeStage).toHaveBeenCalledOnce(); h.api.dispose(); await flush(); expect(h.disposeStage).toHaveBeenCalledTimes(2);
  });
  it("a throwing physical disposer cannot suppress server cleanup or release capacity early", async () => {
    const h = fixture(), p = held(); expect(await h.api.start(message())).toBe(true); h.disposeStage.mockImplementation(() => { throw Error("removed then callback failed"); }); h.host.fetch.mockReturnValueOnce(p.promise);
    h.api.stop(); await flush(); expect(h.api.snapshot().busy).toBe(true); expect(await h.api.start(message())).toBe(false); p.resolve(response({ ok: true })); await flush(); expect(h.api.snapshot().busy).toBe(false); h.api.dispose();
  });
  it("a throwing mount callback ends the server run with no retry", async () => {
    const h = fixture(); h.start.mockImplementation(() => { throw Error("host mount failed before owning paint"); }); expect(await h.api.start(message())).toBe(false); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
  it("mount callback stop/reentry cannot retain its returned physical disposer or start a second request", async () => {
    const h = fixture(); h.start.mockImplementation(() => { h.api.stop(); void h.api.start(message()); return h.disposeStage; }); expect(await h.api.start(message())).toBe(false); await flush(); expect(h.disposeStage).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledTimes(2); h.api.dispose();
  });
});
