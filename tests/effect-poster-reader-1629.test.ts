import { describe, expect, it, vi } from "vitest";
const { checkEffectPosters, checkStaticEffectPoster, createEffectPosterReader } = await import(new URL("../src/ui/shared/effect-poster-reader.js", import.meta.url).href);
const ID = "a".repeat(32), PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const input = () => ({ rev: 1, posters: [{ id: ID, title: "👨‍👩‍👧".repeat(40) }] });
const held = () => { let resolve: (x?: any) => void = () => {}; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
async function flush() { for (let n = 0; n < 20; n++) await Promise.resolve(); }
function response(body: Uint8Array = new TextEncoder().encode(JSON.stringify(input())), type = "application/json", patch = {}) {
  return { ok: true, status: 200, redirected: false, headers: new Headers({ "content-type": type }), body: new Response(body as any).body, ...patch };
}
function fixture() {
  let now = 0, live = true, serial = 0;
  const timers = new Map<number, () => void>();
  const host = { AbortController, performance: { now: () => now }, fetch: vi.fn(async (..._args: any[]): Promise<any> => response()),
    setTimeout: vi.fn((fn: () => void, _delay: number) => { timers.set(++serial, fn); return serial; }), clearTimeout: vi.fn((n: number) => timers.delete(n)) };
  return { host, api: createEffectPosterReader({ window: host, current: () => live }), at(n: number) { now = n; }, stale() { live = false; }, timers,
    timeout() { for (const fn of [...timers.values()]) fn(); } };
}
describe("#1629 static-only poster response projections", () => {
  it("copies/freezes the two-field metadata and accepts server-valid combined Unicode display text", () => {
    const source = input(), result = checkEffectPosters(source); expect(result).toEqual(source); source.posters[0].title = "changed";
    expect(result.posters[0].title).not.toBe("changed"); expect(Object.isFrozen(result.posters[0])).toBe(true); expect(Object.isFrozen(result.posters)).toBe(true); expect(Object.isFrozen(result)).toBe(true);
    expect(checkEffectPosters({ rev: 0, posters: [] })).toEqual({ rev: 0, posters: [] });
  });
  it.each(["rev", "field", "code", "id", "title", "duplicate", "three", "sparse", "array-field", "getter"])("refuses malformed closed metadata %s without reading getters", fault => {
    const x: any = input(); let called = 0;
    if (fault === "rev") x.rev = -1; if (fault === "field") x.effects = [];
    if (fault === "code") x.posters[0].code = "private"; if (fault === "id") x.posters[0].id = "../private";
    if (fault === "title") x.posters[0].title = "x".repeat(401); if (fault === "duplicate") x.posters.push({ ...x.posters[0] });
    if (fault === "three") x.posters = [1, 2, 3].map(n => ({ id: n.toString().padStart(32, "0"), title: "x" }));
    if (fault === "sparse") x.posters = Array(1); if (fault === "array-field") x.posters.extra = true;
    if (fault === "getter") Object.defineProperty(x.posters[0], "title", { get() { called++; throw Error("getter"); } });
    expect(checkEffectPosters(x)).toBeNull(); expect(called).toBe(0);
  });
  it("copies only a complete bounded static PNG and refuses APNG, invalid dimensions/chunks and trailing data", () => {
    const output = checkStaticEffectPoster(PNG); expect(Buffer.from(output)).toEqual(PNG); output[0] = 0; expect(PNG[0]).toBe(137);
    for (const type of ["acTL", "fcTL", "fdAT"]) { const b = Buffer.alloc(12); b.write(type, 4); expect(checkStaticEffectPoster(Buffer.concat([PNG.subarray(0, -12), b, PNG.subarray(-12)]))).toBeNull(); }
    for (const bytes of [PNG.subarray(0, -1), Buffer.concat([PNG, Buffer.from([0])]), Buffer.from("<svg/>"), Buffer.alloc(1048577)]) expect(checkStaticEffectPoster(bytes)).toBeNull();
    for (const [width, height] of [[0, 1], [4097, 1], [4096, 4096]]) { const bytes = Buffer.from(PNG); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); expect(checkStaticEffectPoster(bytes)).toBeNull(); }
    const length = Buffer.from(PNG); length.writeUInt32BE(0xffffffff, 33); expect(checkStaticEffectPoster(length)).toBeNull();
  });
});
describe("#1629 bounded static-only poster reader", () => {
  it("constructs only the fixed summary and image paths, with no epoch or response-derived URL", async () => {
    const h = fixture(); expect(await h.api.summary("a/b?c")).toEqual(input());
    expect(h.host.fetch).toHaveBeenCalledWith("/ui/effect-posters?instance=a%2Fb%3Fc", expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }));
    h.host.fetch.mockResolvedValueOnce(response(PNG, "image/png")); expect(Buffer.from(await h.api.image("own", ID))).toEqual(PNG);
    expect(h.host.fetch.mock.calls[1][0]).toBe(`/ui/effect-posters/${ID}.png?instance=own`); expect(h.host.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10000); h.api.dispose(); expect(h.timers.size).toBe(0);
  });
  it.each(["", "x".repeat(129), null, 1])("invalid instance %j cannot start HTTP", async instance => {
    const h = fixture(); expect(await h.api.summary(instance)).toBeNull(); expect(await h.api.image(instance, ID)).toBeNull(); expect(h.host.fetch).not.toHaveBeenCalled();
  });
  it.each(["bad", "../code", "A".repeat(32), null])("invalid id %j cannot start HTTP", async id => {
    const h = fixture(); expect(await h.api.image("own", id)).toBeNull(); expect(h.host.fetch).not.toHaveBeenCalled();
  });
  it.each(["redirect", "mime", "length", "status", "utf8", "json", "stream", "overflow"])("refuses %s without authority or retry", async fault => {
    const h = fixture(), patch: any = {};
    if (fault === "redirect") patch.redirected = true; if (fault === "status") patch.ok = false;
    if (fault === "mime") patch.headers = new Headers({ "content-type": "text/html" });
    if (fault === "length") patch.headers = new Headers({ "content-type": "application/json", "content-length": "-1" });
    if (fault === "stream") patch.body = null;
    const bytes = fault === "utf8" ? new Uint8Array([0xc3, 0x28]) : fault === "json" ? Buffer.from("{") : fault === "overflow" ? Buffer.alloc(8193) : undefined;
    h.host.fetch.mockResolvedValueOnce(response(bytes, "application/json", patch)); expect(await h.api.summary("own")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it.each([401, 403, 409])("%i revokes the reader and never retries or consumes reply content", async status => {
    const h = fixture(); h.host.fetch.mockResolvedValueOnce(response(undefined, "application/json", { ok: false, status }));
    expect(await h.api.summary("own")).toBeNull(); expect(await h.api.summary("own")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledOnce();
  });
  it.each([9999, 10000, 10001])("callback time %i enforces the exact deadline even if its timer has not fired", async at => {
    const h = fixture(), wait = held(); h.host.fetch.mockImplementationOnce(() => wait.promise); const result = h.api.summary("own"); await flush(); h.at(at); wait.resolve(response());
    expect(await result).toEqual(at < 10000 ? input() : null); h.api.dispose();
  });
  it.each(["stale", "dispose", "timeout", "rollback"])("late %s response cannot publish", async fault => {
    const h = fixture(), wait = held(); h.at(10); h.host.fetch.mockImplementationOnce(() => wait.promise); const result = h.api.summary("own"); await flush();
    if (fault === "stale") h.stale(); if (fault === "dispose") h.api.dispose(); if (fault === "timeout") h.timeout(); if (fault === "rollback") h.at(9);
    wait.resolve(response()); expect(await result).toBeNull(); await flush(); h.api.dispose();
  });
  it("keeps two physical reservations across canceled/replaced readers until fetch and body cancellation settle", async () => {
    const h = fixture(), waits = [held(), held()], cancellations = [held(), held()];
    h.host.fetch.mockImplementationOnce(() => waits[0].promise).mockImplementationOnce(() => waits[1].promise);
    const a = h.api.summary("own"), b = h.api.summary("other"); await flush(); h.api.dispose(); expect(await a).toBeNull(); expect(await b).toBeNull();
    const next = createEffectPosterReader({ window: h.host, current: () => true }); expect(await next.summary("own")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledTimes(2);
    for (let n = 0; n < 2; n++) waits[n].resolve(response(undefined, "application/json", { body: { cancel: () => cancellations[n].promise } }));
    await flush(); expect(await next.summary("own")).toBeNull(); expect(h.host.fetch).toHaveBeenCalledTimes(2);
    cancellations[0].resolve(); await flush(); expect(await next.summary("own")).toEqual(input()); expect(h.host.fetch).toHaveBeenCalledTimes(3);
    cancellations[1].resolve(); await flush(); next.dispose(); expect(h.timers.size).toBe(0);
  });
  it("holds a read/cancel reservation as well as a pending-fetch reservation", async () => {
    const h = fixture(), read = held(), cancel = held(), fetch = held();
    h.host.fetch.mockResolvedValueOnce(response(undefined, "application/json", { body: { getReader: () => ({ read: () => read.promise, cancel: () => cancel.promise }) } })).mockImplementationOnce(() => fetch.promise);
    const a = h.api.summary("own"), b = h.api.summary("other"); await flush(); h.timeout(); expect(await a).toBeNull(); expect(await b).toBeNull();
    const next = createEffectPosterReader({ window: h.host, current: () => true }); expect(await next.summary("own")).toBeNull();
    read.resolve({ done: true }); await flush(); expect(await next.summary("own")).toBeNull();
    cancel.resolve(); await flush(); expect(await next.summary("own")).toEqual(input()); fetch.resolve(response()); await flush(); h.api.dispose(); next.dispose();
  });
});
