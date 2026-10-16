/** Private stores/listeners only: no FleetManager, account, provider or process manager. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, request, type Server } from "node:http";
import { deflateSync } from "node:zlib";
import { staticEffectPoster } from "../src/web-effect-poster.js";
import { checkEffectEntry } from "../src/web-effect-bundle.js";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { encodeEffectFiles } from "../src/web-effect-upload.js";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function chunk(type: string, bytes: Uint8Array = new Uint8Array()) {
  const b = Buffer.alloc(bytes.length + 12); b.writeUInt32BE(bytes.length); b.write(type, 4); b.set(bytes, 8);
  let crc = 0xffffffff; for (const byte of b.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4); return b;
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const header = () => { const h = Buffer.alloc(13); h.writeUInt32BE(1); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 6; return chunk("IHDR", h); };
const image = chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255])));
const png = () => Buffer.concat([signature, header(), image, chunk("IEND")]);
const apng = () => Buffer.concat([signature, header(), chunk("acTL", Buffer.alloc(8)), chunk("fcTL", Buffer.alloc(26)), image, chunk("fcTL", Buffer.alloc(26)), chunk("fdAT", Buffer.from([0, 0, 0, 1, 99])), chunk("IEND")]);
const entry = (poster = apng(), regions = ["chat"]) => new Map<string, Uint8Array>([
  ["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "poster", title: "Poster", regions, layer: "front", wants: ["state"], poster: "poster.png" }))],
  ["worker.js", Buffer.from("// private worker content\nagend.ready()")], ["poster.png", poster],
]);
function stores() {
  mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/effect-posters-")); roots.push(root);
  const library = new WebEffectLibrary(root), themes = new ThemeStore(root), profiles = new WebEffectProfiles(root);
  library.registerReferenceSource("placements", () => { if (!themes.readable()) throw Error("unreadable"); return themes.placedEffects().flatMap(r => r.ids.map(id => ({ id, holder: `instance:${r.name}` }))); });
  const service = new WebEffectService({ library, themes, profiles, known: name => ["own", "other"].includes(name), changed() {} });
  const add = (files = entry()) => { const r = service.upload("alice", encodeEffectFiles(files)!); if (typeof r.id !== "string") throw Error(JSON.stringify(r)); return r.id; };
  return { root, library, themes, profiles, service, add };
}
function httpCall(port: number, path: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; bytes: Buffer; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, res => {
      const parts: Buffer[] = []; res.on("data", c => parts.push(c)); res.on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(parts), headers: res.headers }));
    }); req.on("error", reject); req.setTimeout(5000, () => req.destroy(Error("private HTTP deadline"))); req.end();
  });
}
async function routes() {
  const f = stores(), token = "poster-private-token"; let now = 0, current = true, open = true;
  const sessions = new WebSessionStore({ now: () => now, policy: { local: { absoluteMs: 60000, idleMs: 1000 }, gateway: { absoluteMs: 60000, idleMs: 1000 } } });
  const ctx = { webToken: token, webSessions: sessions, effectService: f.service } as unknown as WebApiContext;
  const dispatch: Parameters<typeof createPublicWebGateway>[0]["dispatch"] = (req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } };
  const local = createServer(dispatch); servers.push(local); await new Promise<void>(r => local.listen(0, "127.0.0.1", r));
  const gateway = createPublicWebGateway({ exposureId: "e".repeat(32), isCurrent: () => current, isOpen: () => open, dispatch });
  servers.push(gateway.server); gateway.setHost("posters.trycloudflare.com"); const gw = await gateway.listen();
  const a = sessions.create({ tier: "read", label: "private fixture", surface: "local", tokenEpoch: tokenEpoch(token) });
  const b = sessions.create({ tier: "read", label: "private gateway", surface: "gateway", exposureId: "e".repeat(32), tokenEpoch: tokenEpoch(token) });
  const wrong = sessions.create({ tier: "read", label: "private wrong exposure", surface: "gateway", exposureId: "f".repeat(32), tokenEpoch: tokenEpoch(token) });
  return { ...f, sessions, ctx, at: (v: number) => { now = v; }, revoke: () => sessions.revokeById(a.sessionId), closeLink: () => { open = false; }, stale: () => { current = false; },
    local: (path: string, method = "GET", cookie = `agend_session=${a.sessionId}`) => httpCall((local.address() as { port: number }).port, path, { cookie }, method),
    public: (path: string, method = "GET", cookie = `__Host-agend_session=${b.sessionId}`) => httpCall(Number(gw.port), path, { host: "posters.trycloudflare.com", cookie }, method),
    wrongCookie: `__Host-agend_session=${wrong.sessionId}`,
  };
}

describe("#1629 bounded static PNG projection", () => {
  it("copies a static default image and strips every APNG animation chunk without mutating input", () => {
    const animated = apng(), before = Buffer.from(animated), projected = staticEffectPoster(animated);
    expect(Buffer.from(projected!)).toEqual(png()); expect(animated).toEqual(before);
    const plain = png(), copied = staticEffectPoster(plain)!; expect(Buffer.from(copied)).toEqual(plain); copied[0] = 0; expect(plain[0]).toBe(137);
  });
  it.each([Buffer.alloc(0), Buffer.from("<svg/>"), png().subarray(0, -1), Buffer.concat([png(), Buffer.from([0])]), Buffer.concat([signature, header(), chunk("IEND")]), Buffer.concat([signature, image, chunk("IEND")]), Buffer.concat([signature, header(), header(), image, chunk("IEND")]), Buffer.concat([signature, header(), image, chunk("IEND", Buffer.from([0]))])])("refuses malformed/unsupported input %#", input => { expect(staticEffectPoster(input)).toBeNull(); });
  it("bounds bytes, dimensions, pixels, chunk count and chunk lengths", () => {
    const big = png(); big.writeUInt32BE(4097, 16); expect(staticEffectPoster(big)).toBeNull();
    const pixels = png(); pixels.writeUInt32BE(4096, 16); pixels.writeUInt32BE(4096, 20); expect(staticEffectPoster(pixels)).toBeNull();
    const length = png(); length.writeUInt32BE(0xffffffff, 33); expect(staticEffectPoster(length)).toBeNull();
    expect(staticEffectPoster(Buffer.alloc(1048577))).toBeNull();
    const pad = (extra: number) => Buffer.concat([signature, header(), image, chunk("ruSt", Buffer.alloc(1048576 - png().length - 12 + extra)), chunk("IEND")]);
    expect(staticEffectPoster(pad(0))?.byteLength).toBe(1048576); expect(staticEffectPoster(pad(1))).toBeNull();
    expect(staticEffectPoster(Buffer.concat([signature, header(), ...Array.from({ length: 4094 }, () => chunk("acTL")), image, chunk("IEND")]))).toBeNull();
    expect(staticEffectPoster(Buffer.concat([signature, header(), ...Array.from({ length: 4093 }, () => chunk("acTL")), image, chunk("IEND")]))).not.toBeNull();
  });
  it("does not change CW1 normalization or the retained content identity", () => {
    const files = entry(), a = checkEffectEntry(files); expect(a.ok).toBe(true); if (!a.ok) return;
    const original = a.files.get("poster.png")!; expect(Buffer.from(original).includes(Buffer.from("acTL"))).toBe(true);
    expect(staticEffectPoster(original)).not.toBeNull(); const b = checkEffectEntry(a.files); expect(b.ok && b.id).toBe(a.id); expect(Buffer.from(a.files.get("poster.png")!)).toEqual(apng());
  });
});

describe("#1629 current-placement poster authority", () => {
  it("projects only current chat posters, with no code/manifest/params or new read grant", () => {
    const f = stores(), id = f.add(); expect(f.service.posterPlacements("own")).toEqual({ rev: 0, posters: [] }); expect(f.service.placedPoster(id, "own")).toEqual({ ok: false, error: "not_found" });
    expect(f.service.apply("alice", { instance: "own", id })).toHaveProperty("id");
    expect(f.service.posterPlacements("own")).toEqual({ rev: f.themes.rev(), posters: [{ id, title: "Poster" }] });
    expect(f.service.placedPoster(id, "own")).toEqual({ ok: true, bytes: new Uint8Array(png()) });
    expect(f.library.read(id, { kind: "human", id: "bob" }).ok).toBe(false);
    for (const instance of ["other", "missing"]) expect(f.service.placedPoster(id, instance).ok).toBe(false);
    f.service.remove("alice", { instance: "own", id }); expect(f.service.placedPoster(id, "own").ok).toBe(false);
  });
  it("requires a poster and chat declaration; sharing/extra reference is not a placement", () => {
    const f = stores(), id = f.add(); f.service.share("alice", { id, shared: true }); f.library.registerReferenceSource("extra", () => [{ id, holder: "instance:other" }]);
    expect(f.service.posterPlacements("own")).toMatchObject({ posters: [] }); expect(f.service.placedPoster(id, "other").ok).toBe(false);
    const nonchat = f.add(entry(apng(), ["header"])); f.service.apply("alice", { instance: "own", id: nonchat }); expect(f.service.posterPlacements("own")).toMatchObject({ posters: [] });
    const files = entry(); files.delete("poster.png"); const manifest = JSON.parse(Buffer.from(files.get("effect.json")!).toString()); delete manifest.poster; files.set("effect.json", Buffer.from(JSON.stringify(manifest)));
    const absent = f.add(files); f.service.apply("alice", { instance: "own", id: absent }); expect(f.service.posterPlacements("own")).toMatchObject({ posters: [] }); expect(f.service.placedPoster(absent, "own").ok).toBe(false);
  });
  it("unreadable themes/library/reference provider and bad PNG/params fail closed", () => {
    for (const failure of ["themes", "library", "provider", "png", "params"]) {
      const f = stores(), id = f.add(); f.service.apply("alice", { instance: "own", id });
      if (failure === "themes") vi.spyOn(f.themes, "readable").mockReturnValue(false);
      if (failure === "library") vi.spyOn(f.library, "readReferenced").mockReturnValue({ ok: false, error: "library_unreadable" });
      if (failure === "provider") f.library.registerReferenceSource("broken", () => { throw Error("unreadable"); });
      if (failure === "png") { const read = f.library.readReferenced.bind(f.library); vi.spyOn(f.library, "readReferenced").mockImplementation((...args) => { const r = read(...args); return r.ok ? { ...r, entry: { ...r.entry, files: new Map([...r.entry.files].map(([name, bytes]) => [name, name === "poster.png" ? new Uint8Array() : bytes])) } } : r; }); }
      if (failure === "params") f.themes.setPlacements("own", { effects: [{ id, params: { unknown: 1 } }] }, "human", () => null);
      expect(f.service.placedPoster(id, "own").ok, failure).toBe(false);
      expect(f.service.posterPlacements("own")).toMatchObject(failure === "themes" ? { error: "themes_unreadable" } : { posters: [] });
      vi.restoreAllMocks();
    }
  });
});

describe("#1629 local/public poster-only HTTP", () => {
  it("serves the same closed metadata/static PNG to local and current gateway read sessions", async () => {
    const f = await routes(), id = f.add(); f.service.apply("alice", { instance: "own", id });
    for (const call of [f.local, f.public]) {
      const summary = await call("/ui/effect-posters?instance=own"); expect(summary.status).toBe(200); expect(JSON.parse(summary.bytes.toString())).toEqual({ rev: f.themes.rev(), posters: [{ id, title: "Poster" }] });
      const image = await call(`/ui/effect-posters/${id}.png?instance=own`); expect(image.status).toBe(200); expect(image.bytes).toEqual(png());
      expect(image.headers).toMatchObject({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-type": "image/png", "content-security-policy": "default-src 'none'; sandbox" });
    }
  });
  it("never opens effect library/code/cursor/personal/profile or write routes over the gateway", async () => {
    const f = await routes(), id = f.add(); f.service.apply("alice", { instance: "own", id });
    for (const path of ["/ui/effects", `/ui/effects/resource/${id}`, `/ui/effects/image/${id}/cursor.png`, `/ui/effects/profile/${id}`, "/ui/effects/owner", "/ui/effects/placements", "/ui/effect-posters/resource", `/ui/effect-posters/${id}.js`]) {
      expect(isPublicWebRoute("GET", path), path).toBe(false); expect((await f.public(path)).status, path).toBe(404);
    }
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(isPublicWebRoute(method, "/ui/effect-posters")).toBe(false); expect((await f.public("/ui/effect-posters?instance=own", method)).status).toBe(404);
    }
  });
  it.each(["", "?instance=own&instance=own", "?instance=own&slot=fx.page", "?instance=own&ownerEpoch=a", "?instance=", `?instance=${"x".repeat(129)}`, "?other=own"])("refuses malformed query %s without service access", async query => {
    const f = await routes(), spy = vi.spyOn(f.service, "posterPlacements"); expect((await f.public(`/ui/effect-posters${query}`)).status).toBe(404); expect(spy).not.toHaveBeenCalled();
  });
  it("never falls back to another holder/person and rechecks removal for every image fetch", async () => {
    const f = await routes(), id = f.add(); f.service.apply("alice", { instance: "own", id });
    expect((await f.public(`/ui/effect-posters/${id}.png?instance=other`)).status).toBe(404);
    f.service.remove("alice", { instance: "own", id }); expect((await f.public(`/ui/effect-posters/${id}.png?instance=own`)).status).toBe(404);
  });
  it("no credentials, revoked/expired sessions, a wrong exposure or closed/stale gateway cannot read", async () => {
    const f = await routes(); expect((await f.local("/ui/effect-posters?instance=own", "GET", "")).status).toBe(401);
    expect((await f.public("/ui/effect-posters?instance=own", "GET", f.wrongCookie)).status).toBe(401);
    f.revoke(); expect((await f.local("/ui/effect-posters?instance=own")).status).toBe(401);
    f.at(1000); expect((await f.public("/ui/effect-posters?instance=own")).status).toBe(401);
    f.closeLink(); expect((await f.public("/ui/effect-posters?instance=own")).status).toBe(503);
    f.stale(); expect((await f.public("/ui/effect-posters?instance=own")).status).toBe(403);
  });
  it("automatic posters do not extend idle expiry; only the exact GET paths are passive", async () => {
    const f = await routes(), path = "/ui/effect-posters?instance=own";
    f.at(500); expect((await f.local(path)).status).toBe(200); expect((await f.public(path)).status).toBe(200);
    f.at(1000); expect((await f.local(path)).status).toBe(401); expect((await f.public(path)).status).toBe(401);
    for (const path of ["/ui/effect-posters", `/ui/effect-posters/${"a".repeat(32)}.png`]) for (const method of ["GET", "HEAD", "POST", "DELETE"]) expect(isPassiveWebRead(method, path)).toBe(method === "GET");
    for (const path of ["/ui/effect-posters/abc.png", "/ui/effect-posters/resource", `/ui/effect-posters/${"A".repeat(32)}.png`]) expect(isPassiveWebRead("GET", path)).toBe(false);
  });
  it("unknown/unavailable/unreadable storage gives no public content", async () => {
    const f = await routes(); expect((await f.public("/ui/effect-posters?instance=missing")).status).toBe(404);
    vi.spyOn(f.themes, "readable").mockReturnValue(false); expect((await f.public("/ui/effect-posters?instance=own")).status).toBe(503);
    (f.ctx as { effectService?: WebEffectService }).effectService = undefined; expect((await f.public("/ui/effect-posters?instance=own")).status).toBe(404);
  });
});
