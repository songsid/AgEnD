import { describe, expect, it, vi } from "vitest";
import { parseWebEffectManifest, resolveEffectParams } from "../src/web-effect.js";
const { checkEffectTrialStart, createEffectRuntimeLoader } = await import("/assets/effect-runtime-loader.js");
const ID = "a".repeat(32), OFFER = "b".repeat(32), TRIAL = "c".repeat(32), EPOCH = "d".repeat(16);
const manifest = (title = "Fixture") => ({ v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title, regions: ["page"], layer: "front", wants: ["state"], params: { size: { type: "int", min: 1, max: 5, default: 2 } } });
const start = (title = "Fixture"): any => ({ trial: TRIAL, offer: { v: 1, offer: OFFER, id: ID, title, expiresAt: 12345 }, remainingMs: 600000, manifest: manifest(title), params: { size: 2 } });
const resource = (id = ID) => ({ id, manifest: manifest(), params: { size: 2 }, wants: ["state"], code: "agend.ready()", assets: [] });
const spec = (patch = {}) => ({ trial: TRIAL, id: ID, instance: "own /&", ...patch });
function held<T = any>() { let resolve!: (x: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let n = 0; n < 15; n++) await Promise.resolve(); }
function fixture() {
  let time = 0, live = true, serial = 0; const timers = new Map<number, () => void>(), revoked = vi.fn();
  const host = { AbortController, performance: { now: () => time }, fetch: vi.fn(async (_url?: any, _o?: any): Promise<any> => response()), setTimeout: vi.fn((fn: () => void, _ms: number) => { timers.set(++serial, fn); return serial; }), clearTimeout: (id: number) => timers.delete(id) };
  const api = createEffectRuntimeLoader({ window: host, current: () => live, ownerEpoch: EPOCH, onRevoke: revoked });
  return { host, api, timers, revoked, at(t: number) { time = t; }, stale() { live = false; } };
}
const response = (data: any = resource(), patch = {}) => ({ ok: true, status: 200, redirected: false, headers: new Headers({ "content-type": "application/json" }), body: new Response(JSON.stringify(data)).body, ...patch });

describe("strict Trial Start response projection (no Start request)", () => {
  it.each(["Fixture", "👨‍👩‍👧".repeat(40), "x\u0301".repeat(40)])("server-valid metadata and default params are frozen independent snapshots: %s", title => {
    title = title.normalize("NFC"); const m = parseWebEffectManifest(manifest(title)); expect(m.ok).toBe(true); if (!m.ok) return;
    const values = resolveEffectParams(m.manifest); expect(values.ok).toBe(true); if (!values.ok) return;
    const input = { ...start(title), manifest: m.manifest, params: values.values }, checked = checkEffectTrialStart(input, OFFER, ID);
    expect(checked).toEqual(input); expect(checked).not.toBe(input); expect(Object.isFrozen(checked.offer)).toBe(true); expect(Object.isFrozen(checked.manifest.params)).toBe(true);
    input.offer.title = "Other"; expect(checked.offer.title).toBe(title);
  });
  it.each([0, -1, 600001, 1.5, Infinity, "100", null])("refuses invalid remaining budget %s", remainingMs => expect(checkEffectTrialStart({ ...start(), remainingMs }, OFFER, ID)).toBeNull());
  it.each([1, 599999, 600000])("accepts bounded remaining budget %s", remainingMs => expect(checkEffectTrialStart({ ...start(), remainingMs }, OFFER, ID)).not.toBeNull());
  it.each(["trial", "offer", "id", "title", "expiry", "params", "manifest", "extra", "missing", "expectedOffer", "expectedId", "offerExtra", "offerMissing"])("refuses %s mismatch", which => {
    const x = start(); let offer = OFFER, id = ID;
    if (which === "offerExtra") x.offer.url = "https://trap.invalid"; if (which === "offerMissing") delete x.offer.title;
    if (which === "trial") x.trial = "x"; if (which === "offer") x.offer.offer = "e".repeat(32); if (which === "id") x.offer.id = "e".repeat(32);
    if (which === "title") x.offer.title = "Not manifest title"; if (which === "expiry") x.offer.expiresAt = -1; if (which === "params") x.params.size = 6;
    if (which === "manifest") x.manifest.runtime = "html"; if (which === "extra") x.url = "https://trap.invalid"; if (which === "missing") delete x.params;
    if (which === "expectedOffer") offer = "e".repeat(32); if (which === "expectedId") id = "e".repeat(32);
    expect(checkEffectTrialStart(x, offer, id)).toBeNull();
  });
  it("rejects getters/symbols/exotic prototypes, non-NFC/invisible/over-limit titles and unbound expected IDs", () => {
    let read = 0; const x = start(); Object.defineProperty(x.offer, "title", { enumerable: true, get() { read++; throw Error("getter"); } });
    expect(checkEffectTrialStart(x, OFFER, ID)).toBeNull(); expect(read).toBe(0);
    for (const title of ["e\u0301", "x".repeat(41), "q" + "\u0301".repeat(400), "x\u202e", "\u2800"]) expect(checkEffectTrialStart(start(title), OFFER, ID)).toBeNull();
    for (const input of [Object.assign(start(), { [Symbol()]: 1 }), Object.create(start()), [], null]) expect(checkEffectTrialStart(input, OFFER, ID)).toBeNull();
    for (const [offer, id] of [[null, ID], [OFFER, null], ["", ID], [OFFER, "A".repeat(32)]]) expect(checkEffectTrialStart(start(), offer, id)).toBeNull();
  });
});

describe("Trial reads in the existing physical resource lane", () => {
  it("only constructs the fixed trial URL with captured epoch; normal projection and exact expected id", async () => {
    const f = fixture(); expect(await f.api.trialResourceSettled(spec())).toMatchObject({ id: ID, params: { size: 2 } });
    expect(f.host.fetch).toHaveBeenCalledWith(`/ui/effect-trials/${TRIAL}/resource?instance=own%20%2F%26&ownerEpoch=${EPOCH}`, expect.objectContaining({ redirect: "error", credentials: "same-origin", cache: "no-store" }));
    f.host.fetch.mockResolvedValueOnce(response(resource("e".repeat(32)))); expect(await f.api.trialResourceSettled(spec())).toBeNull(); f.api.dispose();
  });
  it.each([{}, { trial: "A".repeat(32) }, { id: 1 }, { instance: "" }, { instance: "x".repeat(129) }, { instance: null }, { url: "https://trap.invalid" }, { slot: "fx.page" }])("refuses invalid/unbound request before fetch: %j", patch => {
    const f = fixture(), input = Object.keys(patch).length ? spec(patch) : {};
    return f.api.trialResourceSettled(input).then((x: any) => { expect(x).toBeNull(); expect(f.host.fetch).not.toHaveBeenCalled(); f.api.dispose(); });
  });
  it("snapshots caller data and refuses accessors before a request", async () => {
    const f = fixture(), input = spec(), pending = f.api.trialResourceSettled(input); input.trial = "e".repeat(32); input.instance = "other";
    await pending; expect(f.host.fetch.mock.calls[0]![0]).toContain(TRIAL); expect(f.host.fetch.mock.calls[0]![0]).toContain("own%20%2F%26");
    const bad = spec(); let reads = 0; Object.defineProperty(bad, "trial", { get() { reads++; return TRIAL; } }); expect(await f.api.trialResourceSettled(bad)).toBeNull(); expect(reads).toBe(0); expect(f.host.fetch).toHaveBeenCalledTimes(1); f.api.dispose();
  });
  it("ordinary Chat, personal and Trial resources share the SAME three physical reservations", async () => {
    const f = fixture(), heldResponses = [held(), held(), held()]; f.host.fetch.mockImplementation(() => heldResponses[f.host.fetch.mock.calls.length - 1]!.promise);
    const a = f.api.resourceSettled({ id: ID, instance: "chat" }), b = f.api.resourceSettled({ id: ID, slot: "fx.page" }), c = f.api.trialResourceSettled(spec()); await flush();
    expect(await f.api.trialResourceSettled(spec({ trial: "e".repeat(32) }))).toBeNull(); expect(f.host.fetch).toHaveBeenCalledTimes(3);
    heldResponses.forEach(h => h.resolve(response())); expect((await Promise.all([a, b, c])).map(x => x?.id)).toEqual([ID, ID, ID]); f.api.dispose();
  });
  it("logical cancellation cannot release the lane until a late body cancellation settles", async () => {
    const f = fixture(), answer = held(), cancelled = held<void>(), controller = new AbortController(); let settled = false;
    f.host.fetch.mockImplementationOnce(() => answer.promise); const a = f.api.trialResourceSettled(spec(), controller.signal).then((x: any) => { settled = true; return x; }); await flush(); controller.abort();
    const cancel = vi.fn(() => cancelled.promise); answer.resolve(response({}, { body: { cancel } })); await flush(); expect(cancel).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    const second = held(); f.host.fetch.mockImplementation(() => second.promise.then(() => response())); const b = f.api.resourceSettled({ id: ID, instance: "chat" }), c = f.api.trialResourceSettled(spec()); await flush();
    expect(await f.api.trialResourceSettled(spec())).toBeNull(); expect(f.host.fetch).toHaveBeenCalledTimes(3);
    cancelled.resolve(); expect(await a).toBeNull(); const d = f.api.trialResourceSettled(spec()); await flush(); expect(f.host.fetch).toHaveBeenCalledTimes(4);
    second.resolve(response()); await Promise.all([b, c, d]); f.api.dispose();
  });
  it.each([9999, 10000, 10001])("acceptance observes the 10-second monotonic cutoff even with a delayed timer: %s", async ms => {
    const f = fixture(), wait = held(); f.host.fetch.mockImplementationOnce(() => wait.promise); const p = f.api.trialResourceSettled(spec()); await flush(); f.at(ms); wait.resolve(response());
    expect((await p)?.id ?? null).toBe(ms < 10000 ? ID : null); f.api.dispose();
  });
  it.each([401, 403, 409])("authorization rejection %s revokes all peer reads with no ordinary fallback", async status => {
    const f = fixture(), peer = held(); f.host.fetch.mockImplementationOnce(() => peer.promise).mockResolvedValueOnce(response({}, { ok: false, status }));
    const a = f.api.resourceSettled({ id: ID, instance: "chat" }); expect(await f.api.trialResourceSettled(spec())).toBeNull(); expect(f.revoked).toHaveBeenCalledOnce();
    peer.resolve(response()); expect(await a).toBeNull(); expect(await f.api.trialResourceSettled(spec())).toBeNull(); expect(f.host.fetch).toHaveBeenCalledTimes(2); f.api.dispose();
  });
  it("private not-found ends only that read, while stale owner or bad response never admits bytes", async () => {
    const f = fixture(); f.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status: 404 })); expect(await f.api.trialResourceSettled(spec())).toBeNull(); expect(f.revoked).not.toHaveBeenCalled();
    expect(await f.api.resourceSettled({ id: ID, instance: "chat" })).not.toBeNull(); f.stale(); expect(await f.api.trialResourceSettled(spec())).toBeNull(); expect(f.host.fetch).toHaveBeenCalledTimes(2); f.api.dispose();
  });
});
