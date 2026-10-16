import { describe, expect, it, vi } from "vitest";
import { checkEffectEntry } from "../src/web-effect-bundle.js";
import { parseWebEffectManifest, resolveEffectParams } from "../src/web-effect.js";
const { checkEffectPlacements, checkEffectResource, createEffectRuntimeLoader } = await import(new URL("../src/ui/shared/effect-runtime-loader.js", import.meta.url).href);
const ID = "a".repeat(32), EPOCH = "b".repeat(16), MIB = 1048576;
const manifest = () => ({ v: 1, kind: "effect", runtime: "canvas-worker-v1", worker: "worker.js", name: "test", title: "Test", regions: ["chat", "page"], layer: "behind", wants: ["state", "env"].filter(x => x !== "env") });
const resource = (patch: Record<string, unknown> = {}): any => ({ id: ID, manifest: manifest(), params: {}, wants: ["state"], code: "agend.ready()", assets: [], ...patch });
const placements = (patch = {}) => ({ rev: 1, effects: [{ id: ID, by: "agent", at: 1234, manifest: manifest(), params: {}, ...patch }] });
const copy = (x: any) => JSON.parse(JSON.stringify(x));
function fixture(onRevoke?: any) {
  let time = 0, current = true, serial = 0;
  const timers = new Map<number, () => void>();
  const host = { performance: { now: () => time }, AbortController, fetch: vi.fn(async (_path?: any, _options?: any): Promise<any> => new Response(JSON.stringify(resource()), { headers: { "content-type": "application/json" } })),
    setTimeout: vi.fn((fn: () => void, _delay: number) => { timers.set(++serial, fn); return serial; }), clearTimeout: vi.fn((id: number) => timers.delete(id)) };
  const api = createEffectRuntimeLoader({ window: host, ownerEpoch: EPOCH, current: () => current, onRevoke });
  return { host, api, timers, at(t: number) { time = t; }, revoke() { current = false; }, restore() { current = true; }, timeout() { for (const fn of [...timers.values()]) fn(); } };
}
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function held<T>() { let resolve: (v: T) => void = () => {}; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function response(body: any = resource(), patch = {}) {
  return { ok: true, status: 200, redirected: false, headers: new Headers({ "content-type": "application/json" }), body: new Response(JSON.stringify(body)).body, ...patch };
}
describe("#1629 bounded runtime HTTP projection (unmounted)", () => {
  it("copies and freezes closed host placements including exact provenance and resolved params", () => {
    const input = placements(), x = checkEffectPlacements(input); expect(x).toEqual(input); expect(Object.isFrozen(x)).toBe(true); expect(Object.isFrozen(x.effects[0].manifest.regions)).toBe(true);
    input.effects[0].by = "human"; expect(x.effects[0].by).toBe("agent"); expect(checkEffectPlacements({ rev: 0, effects: [] })).toEqual({ rev: 0, effects: [] });
  });
  it.each(["rev", "by", "at", "id", "unknown", "duplicate", "three", "params"])("refuses malformed placement %s", mode => {
    const x: any = placements(); if (mode === "rev") x.rev = -1; else if (mode === "unknown") x.effects[0].role = "admin"; else if (mode === "duplicate") x.effects.push(copy(x.effects[0])); else if (mode === "three") x.effects = [1, 2, 3].map(n => ({ ...copy(x.effects[0]), id: n.toString(16).padStart(32, "0") })); else if (mode === "params") x.effects[0].params = { secret: "x" }; else x.effects[0][mode] = mode === "at" ? -1 : "unknown";
    expect(checkEffectPlacements(x)).toBeNull();
  });
  it.each(["runtime", "worker", "kind", "regions", "layer", "wants", "box", "cursor", "title", "extra"])("refuses an unsupported manifest %s", field => {
    const x: any = resource(); x.manifest[field] = ({ runtime: "html", worker: "other.js", kind: "widget", regions: ["dialog"], layer: "overlay", wants: ["text"], box: { anchor: "center", width: 0, height: 100, offset: 0 }, cursor: { hotspot: [64, 0] }, title: "x".repeat(41), extra: true } as Record<string, unknown>)[field];
    expect(checkEffectResource(x, ID)).toBeNull();
  });
  it("matches all five authoritative parameter types with defaults and valid non-default values", () => {
    const defs: any = { number: { type: "number", min: 0, max: 10, step: 0.5, default: 1 }, int: { type: "int", min: -2, max: 2, default: 0 }, bool: { type: "bool", default: false }, color: { type: "color", default: "#aabbcc" }, enum: { type: "enum", values: ["a", "b"], default: "a" } };
    const m: any = { ...manifest(), params: defs }, parsed = parseWebEffectManifest(m); expect(parsed.ok).toBe(true); if (!parsed.ok) throw Error("fixture");
    for (const overrides of [{}, { number: 2.5, int: -2, bool: true, color: "#123456", enum: "b" }]) {
      const r = resolveEffectParams(parsed.manifest, overrides); expect(r.ok).toBe(true); if (!r.ok) throw Error("fixture");
      expect(checkEffectResource(resource({ manifest: parsed.manifest, params: r.values }), ID)).not.toBeNull();
      for (const [k, value] of Object.entries({ number: 2.6, int: 0.1, bool: "yes", color: "red", enum: "c" })) expect(checkEffectResource(resource({ manifest: parsed.manifest, params: { ...r.values, [k]: value } }), ID)).toBeNull();
    }
  });
  it("preserves supported Unicode display lengths, empty source and a retained leading BOM", () => {
    const m = { ...manifest(), title: "😀".repeat(40), description: "😀".repeat(200) }, parsed = parseWebEffectManifest(m); expect(parsed.ok).toBe(true); if (!parsed.ok) throw Error("fixture");
    expect(checkEffectResource(resource({ manifest: parsed.manifest }), ID)).not.toBeNull(); expect(checkEffectResource(resource({ code: "" }), ID)).not.toBeNull(); expect(checkEffectResource(resource({ code: "\ufeffagend.ready()" }), ID).code).toBe("\ufeffagend.ready()");
  });
  it.each([
    ["ZWJ witness", "👨‍👩‍👧".repeat(10), "👨‍👩‍👧".repeat(50)],
    ["ZWJ boundaries", "👨‍👩‍👧".repeat(40), "👨‍👩‍👧".repeat(200)],
    ["combining boundaries", "x\u0301".repeat(40), "x\u0301".repeat(200)],
    ["normalized combining", "e\u0301".repeat(40), "e\u0301".repeat(200)],
  ])("accepts server-validated %s through both projections and HTTP reads", async (_name, title, description) => {
    const checked = checkEffectEntry(new Map([["effect.json", new TextEncoder().encode(JSON.stringify({ ...manifest(), title, description }))], ["worker.js", new TextEncoder().encode("agend.ready()")]]));
    expect(checked.ok).toBe(true); if (!checked.ok) throw Error("server-positive fixture");
    const input = resource({ id: checked.id, manifest: checked.manifest }), placed = { rev: 1, effects: [{ ...placements().effects[0], id: checked.id, manifest: checked.manifest }] };
    expect(checkEffectPlacements(placed)).not.toBeNull(); expect(checkEffectResource(input, checked.id)).not.toBeNull();
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response(placed)); expect(await h.api.placements("a")).not.toBeNull();
    h.host.fetch.mockResolvedValueOnce(response(input)); expect(await h.api.resource({ id: checked.id, instance: "a" })).not.toBeNull();
  });
  it.each([
    ["title graphemes", "👨‍👩‍👧".repeat(41), "valid"],
    ["description graphemes", "valid", "👨‍👩‍👧".repeat(201)],
    ["title UTF-16 units", "x" + "\u0301".repeat(400), "valid"],
    ["description UTF-16 units", "valid", "x" + "\u0301".repeat(2000)],
  ])("refuses oversized %s just like the server", async (_name, title, description) => {
    const m = { ...manifest(), title, description }; expect(parseWebEffectManifest(m).ok).toBe(false);
    const placed = { rev: 1, effects: [{ ...placements().effects[0], manifest: m }] }, input = resource({ manifest: m });
    expect(checkEffectPlacements(placed)).toBeNull(); expect(checkEffectResource(input, ID)).toBeNull();
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response(placed)); expect(await h.api.placements("a")).toBeNull();
    h.host.fetch.mockResolvedValueOnce(response(input)); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull();
  });
  it("rejects unknown-key getters without invoking them and refuses sparse/deep trees", () => {
    const input: any = resource(), getter = vi.fn(() => { throw Error("read"); }); Object.defineProperty(input, "extra", { get: getter }); expect(checkEffectResource(input, ID)).toBeNull(); expect(getter).not.toHaveBeenCalled();
    const sparse: any = resource({ assets: Array(1) }); expect(checkEffectResource(sparse, ID)).toBeNull(); let deep: any = {}; for (let n = 0; n < 12; n++) deep = { nested: deep }; expect(checkEffectResource(resource({ manifest: deep }), ID)).toBeNull();
  });
  it("projects only owned worker assets into independent byte arrays", () => {
    const input = resource({ assets: [{ name: "assets/one.png", mime: "image/png", data_b64: "AQID" }] }); const a = checkEffectResource(input, ID), b = checkEffectResource(input, ID);
    expect(a.assets).toEqual([{ name: "assets/one.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }]); a.assets[0].bytes[0] = 9; expect(b.assets[0].bytes[0]).toBe(1); expect(input.assets[0].data_b64).toBe("AQID");
  });
  it.each(["poster.png", "cursor.png", "assets/a.svg", "assets/../a.png", "assets/A.png"])("host/unsupported asset %s never enters a Worker", name => expect(checkEffectResource(resource({ assets: [{ name, mime: "image/png", data_b64: "AQID" }] }), ID)).toBeNull());
  it.each(["duplicate", "mime", "base64", "empty", "seventeen", "total"])("refuses asset %s", mode => {
    const a = { name: "assets/a.png", mime: "image/png", data_b64: "AQID" }; let assets: any[] = [a], code = "agend.ready()";
    if (mode === "duplicate") assets.push(copy(a)); else if (mode === "mime") a.mime = "text/html"; else if (mode === "base64") a.data_b64 = "AQI=".replace("=", " "); else if (mode === "empty") a.data_b64 = ""; else if (mode === "seventeen") assets = Array.from({ length: 17 }, (_, n) => ({ ...a, name: `assets/a${n}.png` })); else { code = "x".repeat(600000); a.data_b64 = Buffer.alloc(600000).toString("base64"); }
    expect(checkEffectResource(resource({ assets, code }), ID)).toBeNull();
  });
  it("refuses mismatched id/wants, oversize code, malformed Unicode and unknown source fields", () => {
    expect(checkEffectResource(resource(), "f".repeat(32))).toBeNull(); expect(checkEffectResource(resource({ wants: ["reply"] }), ID)).toBeNull(); expect(checkEffectResource(resource({ code: "x".repeat(MIB + 1) }), ID)).toBeNull(); expect(checkEffectResource(resource({ code: "\ud800" }), ID)).toBeNull(); expect(checkEffectResource(resource({ secret: "no" }), ID)).toBeNull();
  });
  it("uses exact epoch/scope URLs, same-origin credentials, redirect error and no-store", async () => {
    const h = fixture(); expect(h.api.ok).toBe(true); expect(await h.api.resource({ id: ID, instance: "a b/&" })).not.toBeNull();
    expect(h.host.fetch).toHaveBeenCalledWith(`/ui/effects/resource/${ID}?instance=a%20b%2F%26&ownerEpoch=${EPOCH}`, expect.objectContaining({ credentials: "same-origin", redirect: "error", cache: "no-store" }));
    h.host.fetch.mockResolvedValueOnce(response(placements())); expect(await h.api.placements("a b/&")).not.toBeNull(); expect(h.host.fetch.mock.calls.at(-1)![0]).toBe(`/ui/effects/placements?instance=a%20b%2F%26&ownerEpoch=${EPOCH}`);
    expect(await h.api.resource({ id: ID, slot: "fx.page" })).not.toBeNull(); expect(h.host.fetch.mock.calls.at(-1)![0]).toContain(`slot=fx.page&ownerEpoch=${EPOCH}`);
  });
  it.each([{ id: ID }, { id: ID, slot: "fx.cursor" }, { id: ID, instance: "a", slot: "fx.page" }, { id: "../x", instance: "a" }, { id: ID, instance: "" }, { id: ID, instance: "a".repeat(129) }, { id: ID, instance: "a", url: "https://outside" }])("refuses bad scope %j before fetch", async spec => { const h = fixture(); expect(await h.api.resource(spec)).toBeNull(); expect(h.host.fetch).not.toHaveBeenCalled(); });
  it("snapshots scope data and refuses accessor scopes without reading them", async () => {
    const h = fixture(), getter = vi.fn(() => ID); expect(await h.api.resource({ get id() { return getter(); }, instance: "a" })).toBeNull(); expect(getter).not.toHaveBeenCalled(); expect(h.host.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 409])("a %s response permanently revokes the old loader", async status => { const h = fixture(); h.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status })); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); });
  it.each([401, 403, 409])("%i notifies once before a held response body finishes and fences reentrant reads", async status => {
    const cancel = held<any>(), finished = vi.fn(), seen: any[] = []; let h: any;
    h = fixture((episode: any) => { seen.push(episode); void h.api.resource({ id: ID, instance: "a" }); throw Error("listener"); });
    const bodyCancel = vi.fn(() => cancel.promise); h.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status, body: { cancel: bodyCancel } }));
    const job = h.api.resourceSettled({ id: ID, instance: "a" }).then(finished); await flush();
    expect(seen).toEqual([{ reason: "authorization_rejected" }]); expect(Object.isFrozen(seen[0])).toBe(true); expect(finished).not.toHaveBeenCalled(); expect(bodyCancel).toHaveBeenCalledOnce(); expect(h.host.fetch).toHaveBeenCalledOnce();
    expect(await h.api.owner()).toBeNull(); h.api.dispose(); expect(seen).toHaveLength(1); cancel.resolve(undefined); await job; expect(finished).toHaveBeenCalledExactlyOnceWith(null);
  });
  it("terminal revocation aborts concurrent logical callers but retains a held physical reservation", async () => {
    const pending = held<any>(), cancel = held<any>(), revoked = vi.fn(), h = fixture(revoked), first = vi.fn();
    h.host.fetch.mockImplementationOnce(() => pending.promise); const a = h.api.resource({ id: ID, instance: "a" }).then(first); await flush();
    h.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status: 409 })); expect(await h.api.resource({ id: ID, slot: "fx.page" })).toBeNull(); await flush(); expect(first).toHaveBeenCalledWith(null); await a;
    expect(first).toHaveBeenCalledWith(null); expect(revoked).toHaveBeenCalledOnce(); h.api.dispose();
    const construct = () => createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => true }); expect(construct().ok).toBe(false);
    pending.resolve(response({}, { body: { cancel: () => cancel.promise } })); await flush(); expect(construct().ok).toBe(false); cancel.resolve(undefined); await flush(); const next = construct(); expect(next.ok).toBe(true); next.dispose();
  });
  it.each(["clock", "current"])("%s loss reports one closed terminal reason and cannot be repaired", async how => {
    const ended = vi.fn(), h = fixture(ended); if (how === "clock") h.at(-1); else h.revoke(); expect(await h.api.owner()).toBeNull();
    expect(ended).toHaveBeenCalledExactlyOnceWith({ reason: how === "clock" ? "clock_unavailable" : "owner_unavailable" }); h.at(1); h.restore(); expect(await h.api.placements("a")).toBeNull(); expect(ended).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("ordinary unavailable metadata/resources and manual disposal do not fabricate revocation", async () => {
    const ended = vi.fn(), h = fixture(ended); h.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status: 404 })); expect(await h.api.resource({ id: ID, slot: "fx.page" })).toBeNull();
    h.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status: 503 })); expect(await h.api.owner()).toBeNull(); expect(await h.api.resource({ id: ID, instance: "a" })).not.toBeNull(); h.api.dispose(); expect(ended).not.toHaveBeenCalled();
  });
  it("ownerSettled shares the existing metadata lane through late-body cancellation", async () => {
    const h = fixture(), fetch = held<any>(), cancel = held<any>(), done = vi.fn(), controller = new AbortController(); h.host.fetch.mockImplementationOnce(() => fetch.promise);
    const job = h.api.ownerSettled(controller.signal).then(done); await flush(); controller.abort(); await flush(); expect(done).not.toHaveBeenCalled();
    expect(await h.api.placementsSettled("a")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce();
    const bodyCancel = vi.fn(() => cancel.promise); fetch.resolve(response({}, { body: { cancel: bodyCancel } })); await flush(); expect(bodyCancel).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
    expect(await h.api.placements("a")).toBeNull(); cancel.resolve(undefined); await job; h.host.fetch.mockResolvedValueOnce(response(placements())); expect(await h.api.placementsSettled("a")).not.toBeNull();
    expect(h.host.fetch.mock.calls[0][0]).toBe(`/ui/effects/owner?ownerEpoch=${EPOCH}`); h.api.dispose();
  });
  it("Chat metadata also excludes owner reads until its physical cleanup finishes", async () => {
    const h = fixture(), fetch = held<any>(), controller = new AbortController(); h.host.fetch.mockImplementationOnce(() => fetch.promise);
    const job = h.api.placementsSettled("a", controller.signal); await flush(); controller.abort(); expect(await h.api.ownerSettled()).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); fetch.resolve(response(placements())); expect(await job).toBeNull(); h.api.dispose();
  });
  it("ownerSettled retains the 256-KiB streamed metadata bound", async () => {
    const slots = { rev: 1, slots: Object.fromEntries(["fx.page", "fx.header", "fx.sidebar", "fx.box", "fx.cursor"].map(k => [k, { status: "none", id: null }])) };
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response(null, { body: new Response(" ".repeat(256 * 1024) + JSON.stringify(slots)).body })); expect(await h.api.ownerSettled()).toBeNull(); h.api.dispose();
  });
  it("ownerSettled projects the same closed slots and monotonic deadline as owner", async () => {
    const slots = { rev: 1, slots: Object.fromEntries(["fx.page", "fx.header", "fx.sidebar", "fx.box", "fx.cursor"].map(k => [k, { status: "none", id: null }])) };
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response(slots)); expect(await h.api.ownerSettled()).toEqual(slots);
    const delayed = held<any>(); h.host.fetch.mockImplementationOnce(() => delayed.promise); const job = h.api.ownerSettled(); await flush(); h.at(10000); delayed.resolve(response(slots)); expect(await job).toBeNull(); h.api.dispose();
  });
  it("a private 404 is unavailable, not a fabricated global session verdict or automatic retry", async () => {
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response({}, { ok: false, status: 404 })); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); expect(await h.api.resource({ id: ID, instance: "a" })).not.toBeNull();
  });
  it.each(["redirect", "mime", "declared-size", "bad-length", "no-stream", "bytes", "utf8", "json"])("rejects response %s", async mode => {
    const h = fixture(); let r: any = response();
    if (mode === "redirect") r.redirected = true; else if (mode === "mime") r.headers.set("content-type", "text/html"); else if (mode === "declared-size") r.headers.set("content-length", String(8 * MIB + 1)); else if (mode === "bad-length") r.headers.set("content-length", "NaN"); else if (mode === "no-stream") r.body = null; else if (mode === "bytes") r.body = new Response(" ".repeat(8 * MIB) + JSON.stringify(resource())).body; else if (mode === "utf8") r.body = new Response(new Uint8Array([255])).body; else r.body = new Response("{").body;
    h.host.fetch.mockResolvedValueOnce(r); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull();
  });
  it.each([9999, 10000, 10001])("late headers at %dms cannot bypass a delayed deadline timer", async at => {
    const h = fixture(), pending = held<any>(); h.host.fetch.mockImplementationOnce(() => pending.promise); const p = h.api.resource({ id: ID, instance: "a" }); await flush(); h.at(at); pending.resolve(response()); expect(await p === null).toBe(at >= 10000);
  });
  it.each(["initial", "headers"])("time in the %s owner predicate counts before fetch/decode", async stage => {
    const h = fixture(); h.api.dispose(); let calls = 0, headers = false; const read = vi.fn(async () => ({ done: true }));
    const api = createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => { calls++; if (stage === "initial" ? calls === 2 : headers) h.at(10000); return true; } });
    h.host.fetch.mockImplementation(async () => { headers = true; return response(null, { body: { getReader: () => { read(); return { read, cancel: vi.fn() }; } } }); });
    expect(await api.resource({ id: ID, instance: "a" })).toBeNull(); if (stage === "initial") expect(h.host.fetch).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("a late final body chunk cannot bypass the same monotonic deadline", async () => {
    const h = fixture(), pending = held<any>(), cancel = vi.fn(); h.host.fetch.mockResolvedValueOnce(response(null, { body: { getReader: () => ({ read: () => pending.promise, cancel }) } }));
    const p = h.api.resource({ id: ID, instance: "a" }); await flush(); h.at(10000); pending.resolve({ done: true }); expect(await p).toBeNull(); expect(cancel).toHaveBeenCalled();
  });
  it.each(["timeout", "abort", "dispose"])("%s resolves the caller while retaining hung physical reads against capacity", async how => {
    const h = fixture(), pending = held<any>(), signal = new AbortController(); h.host.fetch.mockImplementation(() => pending.promise);
    const jobs = Array.from({ length: 3 }, () => h.api.resource({ id: ID, instance: "a" }, signal.signal)); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(3);
    if (how === "timeout") { h.at(10000); h.timeout(); } else if (how === "abort") signal.abort(); else h.api.dispose();
    expect(await Promise.all(jobs)).toEqual([null, null, null]); let blocked = false; const blockedJob = h.api.resource({ id: ID, instance: "a" }).then((value: any) => { blocked = true; expect(value).toBeNull(); }); await flush(); expect(blocked).toBe(true); await blockedJob; expect(h.host.fetch).toHaveBeenCalledTimes(3);
    pending.resolve(response()); await flush(); if (how !== "dispose") { h.host.fetch.mockImplementation(async () => response()); expect(await h.api.resource({ id: ID, instance: "a" })).not.toBeNull(); } else { expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); expect(h.host.fetch).toHaveBeenCalledTimes(3); }
  });
  it("bounds placements independently to one physical request", async () => {
    const h = fixture(), pending = held<any>(); h.host.fetch.mockImplementationOnce(() => pending.promise); const p = h.api.placements("a"); await flush(); expect(await h.api.placements("a")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); pending.resolve(response(placements())); expect(await p).not.toBeNull();
  });
  it("lost currentness and clock rollback are permanent, even if the host later recovers", async () => {
    for (const how of ["owner", "clock"]) { const h = fixture(), pending = held<any>(); h.at(10); h.host.fetch.mockImplementationOnce(() => pending.promise); const p = h.api.resource({ id: ID, instance: "a" }); await flush(); if (how === "owner") h.revoke(); else h.at(9); pending.resolve(response()); expect(await p).toBeNull(); h.restore(); h.at(11); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); }
  });
  it("handles valid UTF-8 split across every streamed byte without unbounded body readers", async () => {
    const h = fixture(), bytes = new TextEncoder().encode(JSON.stringify(resource({ code: "// 你好 😀\nagend.ready()" })));
    h.host.fetch.mockResolvedValueOnce(response(null, { body: new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }) }));
    const result = await h.api.resource({ id: ID, instance: "a" }); expect(result.code).toBe("// 你好 😀\nagend.ready()");
  });
  it("allows the JSON escaping expansion of an otherwise valid sub-MiB script", async () => {
    const h = fixture(), code = "//" + "\0".repeat(800000) + "\nagend.ready()"; expect(checkEffectEntry(new Map([["effect.json", new TextEncoder().encode(JSON.stringify(manifest()))], ["worker.js", new TextEncoder().encode(code)]] )).ok).toBe(true); h.host.fetch.mockResolvedValueOnce(response(resource({ code })));
    expect((await h.api.resource({ id: ID, instance: "a" })).code).toBe(code);
  });
  it("body readers that ignore abort retain physical capacity until their reads settle", async () => {
    const h = fixture(), pending = held<any>(), signal = new AbortController(), cancel = vi.fn();
    h.host.fetch.mockImplementation(async () => response(null, { body: { getReader: () => ({ read: () => pending.promise, cancel }) } }));
    const jobs = Array.from({ length: 3 }, () => h.api.resource({ id: ID, instance: "a" }, signal.signal)); await flush(); signal.abort(); expect(await Promise.all(jobs)).toEqual([null, null, null]);
    let blocked = false; const blockedJob = h.api.resource({ id: ID, instance: "a" }).then((value: any) => { blocked = true; expect(value).toBeNull(); }); await flush(); expect(blocked).toBe(true); await blockedJob; expect(h.host.fetch).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalled();
    pending.resolve({ done: true }); await flush(); h.host.fetch.mockImplementation(async () => response()); expect(await h.api.resource({ id: ID, instance: "a" })).not.toBeNull();
  });
  it("snapshots source selectors before the first asynchronous boundary", async () => {
    const h = fixture(), input = { id: ID, instance: "first" }; const job = h.api.resource(input); input.id = "f".repeat(32); input.instance = "other";
    expect(await job).not.toBeNull(); expect(h.host.fetch.mock.calls[0]![0]).toContain(`/resource/${ID}?instance=first&`);
  });
  it("rejects exotic sparse array properties even when their property count matches length", () => {
    const assets: any = Array(1); assets["4294967295"] = { name: "assets/a.png", mime: "image/png", data_b64: "AQID" }; expect(checkEffectResource(resource({ assets }), ID)).toBeNull();
  });
  it("pins the ten-second scheduler and refuses an already-aborted caller before fetch", async () => {
    const h = fixture(); expect(await h.api.resource({ id: ID, instance: "a" })).not.toBeNull(); expect(h.host.setTimeout.mock.calls[0]![1]).toBe(10000);
    const c = new AbortController(); c.abort(); expect(await h.api.resource({ id: ID, instance: "a" }, c.signal)).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce();
  });
  it.each([null, "bad", "a".repeat(15), "a".repeat(17), "G".repeat(16)])("unknown epoch %s constructs no usable loader", epoch => { const h = fixture(); expect(createEffectRuntimeLoader({ window: h.host, ownerEpoch: epoch, current: () => true }).ok).toBe(false); expect(h.host.fetch).not.toHaveBeenCalled(); });
  it("one Window cannot reset physical capacity by replacing a disposed loader", async () => {
    const h = fixture(), construct = () => createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => true }); expect(construct().ok).toBe(false);
    const pending = held<any>(); h.host.fetch.mockImplementationOnce(() => pending.promise); const job = h.api.resource({ id: ID, instance: "a" }); await flush(); h.api.dispose(); expect(await job).toBeNull(); expect(construct().ok).toBe(false);
    pending.resolve(response()); await flush(); const fresh = construct(); expect(fresh.ok).toBe(true); h.host.fetch.mockImplementation(async () => response()); expect(await fresh.resource({ id: ID, instance: "a" })).not.toBeNull(); fresh.dispose();
  });
  it("failed and reentrant construction cannot leak or duplicate the Window reservation", () => {
    const h = fixture(); h.api.dispose(); const nested = vi.fn();
    const api = createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => { nested(createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => true }).ok); return true; } });
    expect(api.ok).toBe(true); expect(nested).toHaveBeenCalledWith(false); api.dispose(); expect(createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => false }).ok).toBe(false);
    const retry = createEffectRuntimeLoader({ window: h.host, ownerEpoch: EPOCH, current: () => true }); expect(retry.ok).toBe(true); retry.dispose();
  });
  it("a throwing host clock cannot be repaired into authority on the same loader", async () => {
    const h = fixture(), clock = vi.spyOn(h.host.performance, "now"); clock.mockImplementationOnce(() => { throw Error("clock unavailable"); });
    expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); clock.mockRestore(); expect(await h.api.resource({ id: ID, instance: "a" })).toBeNull(); expect(h.host.fetch).not.toHaveBeenCalled();
  });
  it("no response JSON/text/arrayBuffer escape hatch is used", async () => {
    const h = fixture(), json = vi.fn(() => { throw Error("unbounded"); }); h.host.fetch.mockResolvedValueOnce({ ...response(), json, text: json, arrayBuffer: json }); expect(await h.api.resource({ id: ID, instance: "a" })).not.toBeNull(); expect(json).not.toHaveBeenCalled();
  });
});
