/** Unmounted cursor HTTP/PNG foundation. Private stores and modeled fetch/body only. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleWebRequest } from "../src/web-api.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { webPersonKey } from "../src/web-profile.js";
import { deflateSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { staticEffectCursor } from "../src/web-effect-poster.js";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebPrefsStore } from "../src/web-prefs.js";
import { encodeEffectFiles } from "../src/web-effect-upload.js";
const { createEffectRuntimeLoader, checkStaticEffectCursor } = await import(new URL("../src/ui/shared/effect-runtime-loader.js", import.meta.url).href);
const ID = "a".repeat(32), EPOCH = "b".repeat(16), roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function chunk(type: string, bytes: Uint8Array = new Uint8Array()) {
  const b = Buffer.alloc(bytes.length + 12); b.writeUInt32BE(bytes.length); b.write(type, 4); b.set(bytes, 8);
  let crc = 0xffffffff; for (const byte of b.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4); return b;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(width = 1, height = width, animated = false, pad = 0) {
  const h = Buffer.alloc(13); h.writeUInt32BE(width); h.writeUInt32BE(height, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([signature, chunk("IHDR", h), ...(animated ? [chunk("acTL", Buffer.alloc(8)), chunk("fcTL", Buffer.alloc(26))] : []), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), ...(animated ? [chunk("fdAT", Buffer.from([0, 0, 0, 1, 99]))] : []), ...(pad ? [chunk("ruSt", Buffer.alloc(pad))] : []), chunk("IEND")]);
}
function held<T = any>() { let resolve = (_x: T) => {}; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let n = 0; n < 16; n++) await Promise.resolve(); }
function response(bytes: Uint8Array = png(), patch: any = {}) { return { ok: true, status: 200, redirected: false, headers: new Headers({ "content-type": "image/png" }), body: new Response(new Uint8Array(bytes)).body, ...patch }; }
function fixture() {
  let time = 0, active = true, serial = 0; const timers = new Map<number, () => void>(), ended = vi.fn();
  const host = { performance: { now: () => time }, AbortController, fetch: vi.fn(async (_path?: any, _options?: any): Promise<any> => response()),
    setTimeout: vi.fn((fn: () => void, _delay: number) => { timers.set(++serial, fn); return serial; }), clearTimeout: vi.fn((id: number) => timers.delete(id)) };
  const api = createEffectRuntimeLoader({ window: host, ownerEpoch: EPOCH, current: () => active, onRevoke: ended });
  return { host, api, ended, at(n: number) { time = n; }, lose() { active = false; }, timeout() { for (const fn of [...timers.values()]) fn(); } };
}
describe("static host cursor projection", () => {
  it.each([1, 64])("accepts a square %d-pixel header and independently copies its bytes", n => {
    const image = png(n), a = staticEffectCursor(image), b = checkStaticEffectCursor(image); expect(a).toEqual(new Uint8Array(image)); expect(b).toEqual(a); a![0] = 0; b[0] = 0; expect(image[0]).toBe(137);
  });
  it("strips all APNG chunks on the server, refuses raw animation in the browser, and preserves source bytes", () => {
    const animated = png(1, 1, true), before = Buffer.from(animated), image = staticEffectCursor(animated);
    expect(image).toEqual(new Uint8Array(png())); expect(checkStaticEffectCursor(animated)).toBeNull(); expect(checkStaticEffectCursor(image)).toEqual(image); expect(animated).toEqual(before);
  });
  it.each([png(0), png(65), png(32, 16), Buffer.alloc(0), Buffer.from("<svg/>"), png().subarray(0, -1), Buffer.concat([png(), Buffer.from([0])]), png(1, 1, false, 32768)])("refuses malformed/dimension/byte overflow %#", bytes => {
    expect(staticEffectCursor(bytes)).toBeNull(); expect(checkStaticEffectCursor(bytes)).toBeNull();
  });
  it("pins the exact byte ceiling independently of dimensions", () => {
    const size = png().length, exact = png(1, 1, false, 32768 - size - 12), over = png(1, 1, false, 32769 - size - 12);
    expect(exact.length).toBe(32768); expect(staticEffectCursor(exact)).not.toBeNull(); expect(checkStaticEffectCursor(exact)).not.toBeNull(); expect(staticEffectCursor(over)).toBeNull(); expect(checkStaticEffectCursor(over)).toBeNull();
  });
  it("projects actual private/shared selections and HTTP bytes without changing stored id or granting code", async () => {
    mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/cursor-read-")); roots.push(root);
    const prefs = new WebPrefsStore(root), library = new WebEffectLibrary(root), themes = new ThemeStore(root), profiles = new WebEffectProfiles(root), service = new WebEffectService({ prefs, library, themes, profiles, known: () => true, changed() {} });
    const files = new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "cursor", title: "Cursor", regions: ["chat"], layer: "behind", wants: [], cursor: { hotspot: [0, 0] } }))], ["worker.js", Buffer.from("agend.ready()")], ["cursor.png", png(1, 1, true)]]);
    const aliceOwner = { adapterId: "discord", userId: "alice" }, alice = webPersonKey(aliceOwner), bob = webPersonKey({ adapterId: "discord", userId: "bob" });
    const upload = service.upload(bob, encodeEffectFiles(files)!), id = upload.id as string; expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(service.share(bob, { id, shared: true })).toHaveProperty("id");
    expect(prefs.writeForViewer(alice, new Map([["fx.cursor", id]]), { validateEffect: (p, k, i) => service.validateOwnerSelection(p, k, i) })).toHaveProperty("ok", true);
    const image = service.ownerImage(alice, id, "cursor", "fx.cursor"); expect(image).toEqual({ ok: true, bytes: new Uint8Array(png()) });
    const read = library.read(id, { kind: "human", id: bob }); expect(read.ok).toBe(true); if (!read.ok) throw Error("fixture"); expect(Buffer.from(read.entry.files.get("cursor.png")!)).toEqual(png(1, 1, true)); expect(read.entry.id).toBe(id);
    expect(service.ownerResource(alice, id, "fx.cursor")).toEqual({ error: "not_found" }); expect(service.ownerImage("other", id, "cursor", "fx.cursor").ok).toBe(false);
    service.share(bob, { id, shared: false }); expect(service.ownerImage(alice, id, "cursor", "fx.cursor").ok).toBe(false); expect(prefs.readForViewer(alice).values["fx.cursor"]).toBe(id);
    // The actual handler preserves the PNG-only private output and existing session/epoch policy.
    service.share(bob, { id, shared: true });
    const token = "private-test-token", sessions = new WebSessionStore(), signed = sessions.create({ tier: "read", surface: "local", label: "test", tokenEpoch: tokenEpoch(token), owner: aliceOwner });
    const call = async (query: string, method = "GET") => {
      let status = 0, body: any; const headers: Record<string, unknown> = {};
      const path = `/ui/effects/image/${id}/cursor.png?${query}`, req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "127.0.0.1:19280", cookie: `agend_session=${signed.sessionId}` }, resume() {} });
      const res: any = { setHeader(k: string, v: unknown) { headers[k] = v; }, writeHead(code: number, h: any) { status = code; Object.assign(headers, h); }, end(bytes: any) { body = bytes; } };
      handleWebRequest(req as never, res, new URL(path, "http://127.0.0.1:19280"), { fleetConfig: { web: { experimental: { canvas_worker: true } } }, webToken: token, webSessions: sessions, effectService: service } as any); await flush(); return { status, body, headers };
    };
    const output = await call(`slot=fx.cursor&ownerEpoch=${signed.record.handle}`); expect(output.status).toBe(200); expect(Buffer.from(output.body)).toEqual(png()); expect(output.headers).toMatchObject({ "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    for (const query of ["slot=fx.cursor", `slot=fx.cursor&ownerEpoch=${"f".repeat(16)}`, `slot=fx.cursor&instance=worker&ownerEpoch=${signed.record.handle}`]) expect((await call(query)).status).toBe(404);
    service.share(bob, { id, shared: false }); expect((await call(`slot=fx.cursor&ownerEpoch=${signed.record.handle}`)).status).toBe(404);

  });
});
describe("shared runtime loader cursor lane (unmounted)", () => {
  it("uses only the exact slot/epoch URL and returns independent static bytes", async () => {
    const f = fixture(), bytes = await f.api.cursorImageSettled(ID); expect(bytes).toEqual(new Uint8Array(png()));
    expect(f.host.fetch).toHaveBeenCalledExactlyOnceWith(`/ui/effects/image/${ID}/cursor.png?slot=fx.cursor&ownerEpoch=${EPOCH}`, expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" })); expect(f.host.setTimeout.mock.calls[0][1]).toBe(10000); f.api.dispose();
  });
  it.each([null, {}, { id: ID }, "../x", "A".repeat(32), "a".repeat(31), "a".repeat(33)])("refuses selector %j before fetching", async id => { const f = fixture(); expect(await f.api.cursorImageSettled(id)).toBeNull(); expect(f.host.fetch).not.toHaveBeenCalled(); f.api.dispose(); });
  it.each(["mime", "redirect", "declared", "bad-length", "streamed", "animation", "invalid", "no-body"])("rejects %s and cancels the physical body", async how => {
    const f = fixture(), r: any = response();
    if (how === "mime") r.headers.set("content-type", "application/json"); else if (how === "redirect") r.redirected = true; else if (how === "declared") r.headers.set("content-length", "32769"); else if (how === "bad-length") r.headers.set("content-length", "-1"); else if (how === "streamed") r.body = new Response(Buffer.alloc(32769)).body; else if (how === "animation") r.body = new Response(png(1, 1, true)).body; else if (how === "invalid") r.body = new Response("png").body; else r.body = null;
    f.host.fetch.mockResolvedValueOnce(r); expect(await f.api.cursorImageSettled(ID)).toBeNull(); f.api.dispose();
  });
  it.each([9999, 10000, 10001])("retains the monotonic cutoff at %dms even if the timer has not fired", async at => {
    const f = fixture(), fetch = held(); f.host.fetch.mockImplementationOnce(() => fetch.promise); const job = f.api.cursorImageSettled(ID); await flush(); f.at(at); fetch.resolve(response()); expect(await job === null).toBe(at >= 10000); f.api.dispose();
  });
  it("a late final chunk and a late body cancellation cannot refresh the deadline", async () => {
    for (const phase of ["chunk", "cancel"]) { const f = fixture(), late = held(), finish = vi.fn(), bytes = png(); let n = 0;
      const reader = { read: vi.fn(() => ++n === 1 ? Promise.resolve({ value: new Uint8Array(bytes), done: false }) : phase === "chunk" ? late.promise : Promise.resolve({ done: true })), cancel: vi.fn(() => phase === "cancel" ? late.promise : Promise.resolve()) };
      f.host.fetch.mockResolvedValueOnce(response(bytes, { body: { getReader: () => reader } })); const job = f.api.cursorImageSettled(ID).then(finish); await flush(); f.at(10000); late.resolve(phase === "chunk" ? { done: true } : undefined); await job; expect(finish).toHaveBeenCalledExactlyOnceWith(null); f.api.dispose(); }
  });
  it("one unsettled cursor excludes a second cursor while the three Worker-resource slots retain their own bound", async () => {
    const f = fixture(), late = held(); f.host.fetch.mockImplementation(() => late.promise);
    const cursor = f.api.cursorImageSettled(ID); const code = Array.from({ length: 3 }, () => f.api.resource({ id: ID, instance: "worker" })); await flush();
    expect(f.host.fetch).toHaveBeenCalledTimes(4); const blocked = vi.fn(), second = f.api.cursorImageSettled(ID).then(blocked); await flush(); expect(blocked).toHaveBeenCalledExactlyOnceWith(null); await second; expect(await f.api.resource({ id: ID, instance: "worker" })).toBeNull(); expect(f.host.fetch).toHaveBeenCalledTimes(4);
    f.api.dispose(); late.resolve(response()); expect(await cursor).toBeNull(); expect(await Promise.all(code)).toEqual([null, null, null]);
  });
  it.each(["abort", "timeout", "dispose"])("%s does not release the cursor's physical lane or Window reservation early", async how => {
    const f = fixture(), late = held(), cancel = held(), controller = new AbortController(), done = vi.fn(); f.host.fetch.mockImplementationOnce(() => late.promise);
    const job = f.api.cursorImageSettled(ID, controller.signal).then(done); await flush();
    if (how === "abort") controller.abort(); else if (how === "timeout") { f.at(10000); f.timeout(); } else f.api.dispose();
    await flush(); expect(done).not.toHaveBeenCalled(); expect(await f.api.cursorImageSettled(ID)).toBeNull(); expect(f.host.fetch).toHaveBeenCalledOnce();
    // Metadata remains a different existing lane; binary requests never reset its bound.
    if (how !== "dispose") { f.host.fetch.mockResolvedValueOnce({ ...response(), headers: new Headers({ "content-type": "application/json" }), body: new Response(JSON.stringify({ rev: 1, effects: [] })).body }); expect(await f.api.placementsSettled("worker")).toEqual({ rev: 1, effects: [] }); }
    f.api.dispose(); const construct = () => createEffectRuntimeLoader({ window: f.host, ownerEpoch: EPOCH, current: () => true }); expect(construct().ok).toBe(false);
    const bodyCancel = vi.fn(() => cancel.promise); late.resolve(response(undefined, { body: { cancel: bodyCancel } })); await flush(); expect(bodyCancel).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled(); expect(construct().ok).toBe(false);
    cancel.resolve(undefined); await job; expect(done).toHaveBeenCalledExactlyOnceWith(null); const next = construct(); expect(next.ok).toBe(true); next.dispose();
  });
  it.each([401, 403, 409])("%i on a cursor read revokes the shared metadata/resource loader once", async status => {
    const f = fixture(); f.host.fetch.mockResolvedValueOnce(response(undefined, { ok: false, status })); expect(await f.api.cursorImageSettled(ID)).toBeNull(); expect(f.ended).toHaveBeenCalledExactlyOnceWith({ reason: "authorization_rejected" }); expect(await f.api.owner()).toBeNull(); expect(await f.api.resource({ id: ID, instance: "worker" })).toBeNull(); expect(f.host.fetch).toHaveBeenCalledOnce(); f.api.dispose();
  });
  it("authorization loss aborts a held cursor but keeps its physical reservation until cleanup", async () => {
    const f = fixture(), late = held(), controller = new AbortController(), done = vi.fn(); f.host.fetch.mockImplementationOnce(() => late.promise); const job = f.api.cursorImageSettled(ID, controller.signal).then(done); await flush();
    f.host.fetch.mockResolvedValueOnce(response(undefined, { ok: false, status: 409 })); expect(await f.api.owner()).toBeNull(); expect(controller.signal.aborted).toBe(false); await flush(); expect(done).not.toHaveBeenCalled(); late.resolve(response()); await job; expect(done).toHaveBeenCalledWith(null); expect(f.ended).toHaveBeenCalledOnce(); f.api.dispose();
  });
  it.each(["owner", "clock"])("%s loss revokes cursor and all other lanes permanently", async how => {
    const f = fixture(), late = held(); f.at(10); f.host.fetch.mockImplementationOnce(() => late.promise); const job = f.api.cursorImageSettled(ID); await flush(); if (how === "owner") f.lose(); else f.at(9); late.resolve(response()); expect(await job).toBeNull(); expect(f.ended).toHaveBeenCalledOnce(); f.at(11); expect(await f.api.cursorImageSettled(ID)).toBeNull(); expect(f.host.fetch).toHaveBeenCalledOnce(); f.api.dispose();
  });
});
