import { describe, expect, it, vi } from "vitest";
const { createEffectRuntimeLoader } = await import(new URL("../src/ui/shared/effect-runtime-loader.js", import.meta.url).href);
const id = "a".repeat(32), epoch = "b".repeat(16);
const manifest = { v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat"], layer: "behind", wants: [] };
const resource = () => ({ id, manifest, params: {}, wants: [], code: "agend.ready()", assets: [] });
const placement = () => ({ rev: 1, effects: [{ id, manifest, params: {}, by: "agent", at: 1 }] });
const held = () => { let resolve: (v?: any) => void = () => {}; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
function rig() {
  let now = 0, serial = 0; const timers = new Map<number, () => void>();
  const host: any = { performance: { now: () => now }, AbortController,
    fetch: vi.fn(async () => new Response(JSON.stringify(resource()), { headers: { "content-type": "application/json" } })),
    setTimeout(fn: () => void) { timers.set(++serial, fn); return serial; }, clearTimeout(n: number) { timers.delete(n); } };
  const create = () => createEffectRuntimeLoader({ window: host, ownerEpoch: epoch, current: () => true });
  return { host, api: create(), create, at(t: number) { now = t; }, timeout() { for (const fn of [...timers.values()]) fn(); } };
}
const invoke = (api: any, method: string, signal?: AbortSignal) => method.startsWith("placements") ? api[method]("own", signal) : api[method]({ id, instance: "own" }, signal);
describe("#1629 host physical-settlement read seams (not wired to product)", () => {
  it.each(["placementsSettled", "resourceSettled"])("%s returns the same bounded scope/projection on normal completion", async method => {
    const h = rig(), body = method.startsWith("placements") ? placement() : resource(); h.host.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    expect(await invoke(h.api, method)).toMatchObject(method.startsWith("placements") ? { rev: 1, effects: [{ id }] } : { id, code: "agend.ready()" });
    expect(h.host.fetch.mock.calls[0][0]).toBe(method.startsWith("placements") ? `/ui/effects/placements?instance=own&ownerEpoch=${epoch}` : `/ui/effects/resource/${id}?instance=own&ownerEpoch=${epoch}`);
    expect(h.host.fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store", redirect: "error" }); h.api.dispose();
  });
  it.each(["placementsSettled", "resourceSettled"].flatMap(method => ["caller", "timeout", "dispose"].map(reason => [method, reason])))("%s %s waits for late response cancellation before releasing the Window", async (method, reason) => {
    const h = rig(), fetch = held(), cancellation = held(), cancel = vi.fn(() => cancellation.promise), getReader = vi.fn(), controller = new AbortController();
    h.host.fetch.mockImplementationOnce(() => fetch.promise); let finished = false;
    const task = invoke(h.api, method, controller.signal).then((v: any) => { finished = true; return v; }); await flush();
    if (reason === "caller") controller.abort(); if (reason === "timeout") { h.at(10000); h.timeout(); } if (reason === "dispose") h.api.dispose();
    await flush(); expect(finished).toBe(false); h.api.dispose(); expect(h.create().ok).toBe(false);
    fetch.resolve({ ok: true, status: 200, body: { cancel, getReader } }); await flush();
    expect(cancel).toHaveBeenCalledOnce(); expect(getReader).not.toHaveBeenCalled(); expect(finished).toBe(false); expect(h.create().ok).toBe(false);
    cancellation.resolve(); expect(await task).toBeNull(); expect(finished).toBe(true); const next = h.create(); expect(next.ok).toBe(true); next.dispose();
  });
  it.each(["placements", "resource"])("legacy %s remains promptly canceled while its physical cleanup still owns capacity", async method => {
    const h = rig(), fetch = held(), cancellation = held(), cancel = vi.fn(() => cancellation.promise), controller = new AbortController(); h.host.fetch.mockImplementationOnce(() => fetch.promise);
    const task = invoke(h.api, method, controller.signal); await flush(); controller.abort(); expect(await task).toBeNull(); h.api.dispose(); expect(h.create().ok).toBe(false);
    fetch.resolve({ ok: true, status: 200, body: { cancel } }); await flush(); expect(cancel).toHaveBeenCalledOnce(); expect(h.create().ok).toBe(false);
    cancellation.resolve(); await flush(); const next = h.create(); expect(next.ok).toBe(true); next.dispose();
  });
  it.each(["read-first", "cancel-first"])("a canceled locked reader retains ownership until both read and its one cancellation settle (%s)", async order => {
    const h = rig(), read = held(), cancellation = held(), controller = new AbortController(), cancel = vi.fn(() => cancellation.promise), bodyCancel = vi.fn();
    h.host.fetch.mockResolvedValueOnce({ ok: true, status: 200, redirected: false, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({ read: () => read.promise, cancel }), cancel: bodyCancel } });
    let finished = false; const task = invoke(h.api, "resourceSettled", controller.signal).then((v: any) => { finished = true; return v; }); await flush(); controller.abort(); await flush();
    expect(cancel).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    if (order === "cancel-first") cancellation.resolve(); else read.resolve({ done: true });
    await flush(); expect(finished).toBe(false);
    if (order === "cancel-first") read.resolve({ done: true }); else cancellation.resolve();
    expect(await task).toBeNull(); expect(cancel).toHaveBeenCalledOnce(); expect(bodyCancel).not.toHaveBeenCalled(); h.api.dispose();
  });
  it.each(["resource", "resourceSettled"])("%s cannot refresh a result while final body cancellation is delayed beyond the deadline", async method => {
    const h = rig(), cancellation = held(), bytes = new TextEncoder().encode(JSON.stringify(resource())); let reads = 0;
    const cancel = vi.fn(() => cancellation.promise);
    h.host.fetch.mockResolvedValueOnce({ ok: true, status: 200, redirected: false, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({ read: async () => ++reads === 1 ? { done: false, value: bytes } : { done: true }, cancel }) } });
    let finished = false; const task = invoke(h.api, method).then((v: any) => { finished = true; return v; }); await flush(); expect(cancel).toHaveBeenCalledOnce(); expect(finished).toBe(false);
    h.at(10000); cancellation.resolve(); expect(await task).toBeNull(); h.api.dispose();
  });
  it.each(["throw", "reject"])("%s during cancellation releases the physical reservation without granting a result", async mode => {
    const h = rig(), fetch = held(), controller = new AbortController(); h.host.fetch.mockImplementationOnce(() => fetch.promise);
    const task = invoke(h.api, "resourceSettled", controller.signal); await flush(); controller.abort(); h.api.dispose();
    fetch.resolve({ body: { cancel: () => { if (mode === "throw") throw Error("inert cancel"); return Promise.reject(Error("inert cancel")); } } });
    expect(await task).toBeNull(); const next = h.create(); expect(next.ok).toBe(true); next.dispose();
  });
  it.each([9999, 10000, 10001])("settlement still enforces the exact monotonic deadline at %s", async time => {
    const h = rig(), fetch = held(); h.host.fetch.mockImplementationOnce(() => fetch.promise); const task = invoke(h.api, "resourceSettled"); await flush(); h.at(time);
    fetch.resolve(new Response(JSON.stringify(resource()), { headers: { "content-type": "application/json" } })); expect((await task) !== null).toBe(time < 10000); h.api.dispose();
  });
  it.each([401, 403, 409])("a settled %s revocation never grants a new read", async status => {
    const h = rig(); h.host.fetch.mockResolvedValueOnce(new Response("{}", { status, headers: { "content-type": "application/json" } }));
    expect(await invoke(h.api, "resourceSettled")).toBeNull(); expect(await invoke(h.api, "placementsSettled")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("invalid scopes refuse before either settled method fetches", async () => {
    const h = rig(); expect(await h.api.placementsSettled(4)).toBeNull();
    for (const spec of [{ id }, { id, instance: "own", slot: "fx.page" }, { id, slot: "fx.cursor" }]) expect(await h.api.resourceSettled(spec)).toBeNull();
    expect(h.host.fetch).not.toHaveBeenCalled(); h.api.dispose();
  });
});
