/** Private scratch HTTP and stores only; no fleet start, real account or trial frame. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectTrials } from "../src/web-effect-trials.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
const roots: string[] = [], servers: Server[] = [], registries: WebEffectTrials[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); for (const t of registries.splice(0)) t.dispose(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64");
const files = () => new Map<string, Uint8Array>([
  ["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name: "fixture", title: "👨‍👩‍👧".repeat(10), regions: ["page"], layer: "front", wants: ["theme"], poster: "poster.png", params: { n: { type: "int", min: 1, max: 3, default: 2 } } }))],
  ["worker.js", Buffer.from("agend.ready()")], ["poster.png", png], ["assets/star.png", png],
]);
const rootPath = "/ui/effect-trials";
function disk(root: string) { return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(x => x.isFile()).map(x => [join(x.parentPath, x.name), readFileSync(join(x.parentPath, x.name)).toString("base64")])); }
async function fixture(idleMs = 48 * 3600 * 1000) {
  mkdirSync(".artifacts", { recursive: true }); const root = mkdtempSync(join(process.cwd(), ".artifacts/trial-routes-")); roots.push(root);
  let wall = 0, mono = 0, known = true, css: unknown = "off";
  const token = "trial-scratch-token", library = new WebEffectLibrary(root), themes = new ThemeStore(root), profiles = new WebEffectProfiles(root);
  const trials = new WebEffectTrials({ library, known: n => known && n === "agent", monotonic: () => mono, now: () => wall }); registries.push(trials);
  const staged = library.stage(files(), { kind: "human", id: "bob" }); if (!staged.ok) throw Error(staged.error);
  const c = library.commit(staged.stageId); if (!c.ok) throw Error(c.error); const id = c.ids[0]!; library.setShared(id, { kind: "human", id: "bob" }, true);
  const offer = trials.offer("agent", id); if (!offer.ok) throw Error(offer.error);
  const sessionOptions = { dataDir: root, now: () => wall, policy: { local: { absoluteMs: 48 * 3600 * 1000, idleMs } } };
  const sessions = new WebSessionStore(sessionOptions), changed = vi.fn();
  const service = new WebEffectService({ library, themes, profiles, trials, known: n => known && n === "agent", changed });
  const ctx = { webToken: token, webSessions: sessions, effectService: service, ownerCss: { effectState: () => css } } as unknown as WebApiContext;
  const server = createServer((req, res) => { if (!handleWebRequest(req, res, new URL(req.url!, "http://localhost"), ctx)) { res.writeHead(404); res.end(); } }); servers.push(server);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const port = (server.address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (who: string | undefined = "alice", tier: "admin" | "read" = "admin") => {
    const made = sessions.create({ tier, surface: "local", label: "scratch", tokenEpoch: tokenEpoch(token), ...(who ? { owner: { adapterId: "discord", userId: who } } : {}) });
    return { ...made, epoch: made.record.handle, headers: { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId) } };
  };
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer) => new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: res.headers["content-type"] === "image/png" ? Buffer.concat(chunks) : JSON.parse(Buffer.concat(chunks).toString()) }));
    }); r.on("error", reject); r.setTimeout(5000, () => r.destroy(Error("scratch HTTP deadline"))); r.end(body);
  });
  const start = (s: ReturnType<typeof session>) => call("POST", `${rootPath}/start?ownerEpoch=${s.epoch}`, s.headers, JSON.stringify({ offer: offer.offer.offer, instance: "agent" }));
  const url = (trial: string, part: string, epoch: string) => `${rootPath}/${trial}/${part}?instance=agent&ownerEpoch=${epoch}`;
  return { root, library, themes, profiles, trials, service, ctx, sessions, sessionOptions, token, id, offer: offer.offer, session, call, start, url, changed, origin, css: (v: unknown) => { css = v; }, at: (v: number) => { mono = v; }, wall: (v: number) => { wall = v; }, unknown: () => { known = false; } };
}

describe("#1629 local-admin trial API (no card or runtime mount)", () => {
  it("starts a verified session-bound sample, reads normalized resources and existing history, stops with no appearance/claim/profile write", async () => {
    const f = await fixture(), a = f.session(), before = disk(f.root), r = await f.start(a); expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ offer: f.offer, manifest: { title: "👨‍👩‍👧".repeat(10) }, params: { n: 2 }, trial: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(Object.keys(r.body).sort()).toEqual(["manifest", "offer", "params", "remainingMs", "trial"]); expect(r.body.remainingMs).toBe(600_000);
    const resource = await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers);
    expect(resource.status).toBe(200); expect(resource.body).toMatchObject({ id: f.id, code: "agend.ready()", params: { n: 2 }, wants: ["theme"], assets: [{ name: "assets/star.png", mime: "image/png" }] }); expect(resource.body.assets).toHaveLength(1);
    const image = await f.call("GET", f.url(r.body.trial, "poster.png", a.epoch), a.headers); expect(image.status).toBe(200); expect(image.headers).toMatchObject({ "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-type": "image/png" });
    expect((await f.call("GET", f.url(r.body.trial, "profile", a.epoch), a.headers)).body).toMatchObject({ status: "unmeasured", records: [] });
    expect((await f.call("POST", f.url(r.body.trial, "profile", a.epoch), a.headers, "{}")).status).toBe(404);
    expect((await f.call("POST", `${rootPath}/${r.body.trial}/stop?ownerEpoch=${a.epoch}`, a.headers, "{}")).body).toEqual({ ok: true });
    expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(404);
    expect(disk(f.root)).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
    expect(f.library.read(f.id, { kind: "human", id: "person:discord:alice" }).ok).toBe(true); // shared before the trial, no new claim
    expect(f.library.managementList({ kind: "human", id: "person:discord:alice" })).toMatchObject({ entries: [{ ownClaim: false, sharedByYou: false }] });
  });
  it("Try cannot grant ordinary private resources or persist a diagnostic for the admin", async () => {
    const f = await fixture(), a = f.session(); f.library.setShared(f.id, { kind: "human", id: "bob" }, false);
    const staged = f.library.stage(files(), { kind: "agent", id: "agent" }); if (!staged.ok) throw Error(staged.error); expect(f.library.commit(staged.stageId).ok).toBe(true);
    const r = await f.start(a); expect(r.status).toBe(200); expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(200);
    expect((await f.call("GET", `/ui/effects/resource/${f.id}?ownerEpoch=${a.epoch}`, a.headers)).status).toBe(404);
    expect((await f.call("POST", `/ui/effects/profile/${f.id}?ownerEpoch=${a.epoch}`, a.headers, "{}")).status).toBe(404);
    expect(f.library.read(f.id, { kind: "human", id: "person:discord:alice" }).ok).toBe(false);
  });
  it("existing measurement history is readable only through current trial authority; unreadable storage is 503 after that gate", async () => {
    const f = await fixture(), a = f.session(), r = await f.start(a);
    expect(f.profiles.record(f.id, { v: 1, device: "standard", verdict: "ok", reason: null, samples: 1, fps_p50: 60, fps_p10: 60, fps_floor: 54, long_task_p95: null, long_task_samples: 0, attributed_long_task_p95: null, attributed_samples: 0, attribution: "unknown", load_ms: 2 }).ok).toBe(true);
    const before = readFileSync(f.profiles.path);
    expect((await f.call("GET", f.url(r.body.trial, "profile", a.epoch), a.headers)).body).toMatchObject({ records: [{ source: "reported_host", fps_p50: 60 }] });
    expect(readFileSync(f.profiles.path)).toEqual(before); writeFileSync(f.profiles.path, "{");
    expect((await f.call("GET", f.url(r.body.trial, "profile", a.epoch), a.headers)).status).toBe(503);
    f.library.setShared(f.id, { kind: "human", id: "bob" }, false);
    expect((await f.call("GET", f.url(r.body.trial, "profile", a.epoch), a.headers)).status).toBe(404);
  });
  it.each(["resource", "poster.png", "profile"])("revoked origin sharing denies the next %s read, even though a live reference retains the blob", async part => {
    const f = await fixture(), a = f.session(), r = await f.start(a); expect(r.status).toBe(200);
    expect((await f.call("GET", f.url(r.body.trial, part, a.epoch), a.headers)).status).toBe(200);
    f.library.setShared(f.id, { kind: "human", id: "bob" }, false);
    expect(f.library.readReferenced(f.id, `trial-offer:${f.offer.offer}`).ok).toBe(true);
    const denied = await f.call("GET", f.url(r.body.trial, part, a.epoch), a.headers); expect(denied.status).toBe(404); expect(denied.body).toEqual({ error: "not_found" });
    expect((await f.start(a)).status).toBe(404);
  });
  it.each(["on", "loading", "unknown", null, false, "OFF"])("CSS %j does not block the shadow-isolated local-admin trial", async css => {
    const f = await fixture(), a = f.session(), r = await f.start(a); expect(r.status).toBe(200); f.css(css);
    for (const p of ["resource", "poster.png", "profile"]) expect((await f.call("GET", f.url(r.body.trial, p, a.epoch), a.headers)).status).toBe(200);
    expect((await f.call("POST", `${rootPath}/${r.body.trial}/stop?ownerEpoch=${a.epoch}`, a.headers, "{}")).status).toBe(200);
  });
  it("absent or throwing CSS evidence remains diagnostic unknown for an isolated trial", async () => {
    const f = await fixture(), a = f.session(); (f.ctx as any).ownerCss = undefined; expect((await f.start(a)).status).toBe(200);
    (f.ctx as any).ownerCss = { effectState() { throw Error("unreadable"); } }; expect((await f.start(a)).status).toBe(200);
  });
  it("anonymous, read-tier, header tokens and header+cookie all fail admission and reads", async () => {
    const f = await fixture(), a = f.session(), ro = f.session("reader", "read"), r = await f.start(a);
    for (const [headers, status] of [[{}, 401], [ro.headers, 403], [{ "x-agend-token": f.token }, 403], [{ ...a.headers, "x-agend-token": f.token }, 403]] as const) {
      expect((await f.call("POST", `${rootPath}/start?ownerEpoch=${a.epoch}`, headers, JSON.stringify({ offer: f.offer.offer, instance: "agent" }))).status).toBe(status);
      expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), headers)).status).toBe(status);
    }
  });
  it("explicit web-only operator works but another operator session or a same-person re-login cannot borrow its trial", async () => {
    const f = await fixture(), a = f.session(""), b = f.session(""), r = await f.start(a); expect(r.status).toBe(200);
    expect((await f.call("GET", f.url(r.body.trial, "resource", b.epoch), b.headers)).status).toBe(404);
    const person = f.session(), again = f.session(), own = await f.start(person);
    expect((await f.call("GET", f.url(own.body.trial, "resource", again.epoch), again.headers)).status).toBe(404);
  });
  it.each(["", "ownerEpoch=bad", "ownerEpoch={epoch}&ownerEpoch={epoch}", "ownerEpoch={epoch}&slot=fx.page", "ownerEpoch={epoch}&id=anything"])("start refuses missing/duplicate/mixed query %s", async query => {
    const f = await fixture(), a = f.session(); expect((await f.call("POST", `${rootPath}/start?${query.replaceAll("{epoch}", a.epoch)}`, a.headers, JSON.stringify({ offer: f.offer.offer, instance: "agent" }))).status).toBe(409);
  });
  it.each(["ownerEpoch={epoch}", "instance=agent", "instance=agent&ownerEpoch=bad", "instance=agent&ownerEpoch={epoch}&ownerEpoch={epoch}", "instance=agent&instance=agent&ownerEpoch={epoch}", "instance=agent&ownerEpoch={epoch}&slot=fx.page", "instance=agent&ownerEpoch={epoch}&person=bob"])("private reads refuse missing/duplicate/mixed query %s", async query => {
    const f = await fixture(), a = f.session(), r = await f.start(a);
    expect((await f.call("GET", `${rootPath}/${r.body.trial}/resource?${query.replaceAll("{epoch}", a.epoch)}`, a.headers)).status).toBe(404);
  });
  it.each([{ actor: {} }, { person: "bob" }, { by: "human" }, { ownerCss: "off" }, { sessionHash: "a".repeat(64) }, { params: { n: 3 } }, { holder: "instance:agent" }])("request bodies cannot supply actor/provenance/params %j", async extra => {
    const f = await fixture(), a = f.session(); expect((await f.call("POST", `${rootPath}/start?ownerEpoch=${a.epoch}`, a.headers, JSON.stringify({ offer: f.offer.offer, instance: "agent", ...extra }))).status).toBe(400);
  });
  it("wrong origin, unknown origin, unknown token, exact expiry and stop are local 404s", async () => {
    const f = await fixture(), a = f.session(), r = await f.start(a);
    expect((await f.call("POST", `${rootPath}/start?ownerEpoch=${a.epoch}`, a.headers, JSON.stringify({ offer: f.offer.offer, instance: "other" }))).status).toBe(404);
    expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch).replace("instance=agent", "instance=other"), a.headers)).status).toBe(404);
    expect((await f.call("GET", f.url("a".repeat(32), "resource", a.epoch), a.headers)).status).toBe(404);
    f.at(599_999); expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(200);
    f.at(600_000); expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(404); expect((await f.start(a)).status).toBe(404);
    const g = await fixture(), b = g.session(), t = await g.start(b); g.unknown(); expect((await g.call("GET", g.url(t.body.trial, "resource", b.epoch), b.headers)).status).toBe(404);
  });
  it("returns the original monotonic remainder despite a different client/server wall time and late admission", async () => {
    const f = await fixture(), a = f.session(); f.at(599_999); f.wall(10_000_000);
    const r = await f.start(a); expect(r.status).toBe(200); expect(r.body.remainingMs).toBe(1); expect(r.body.offer.expiresAt).toBe(600_000);
  });
  it("start/stop are POST-only; no GET, body field or profile POST creates trial authority", async () => {
    const f = await fixture(), a = f.session(), start = vi.spyOn(f.trials, "start");
    expect((await f.call("GET", `${rootPath}/start?ownerEpoch=${a.epoch}`, a.headers)).status).toBe(404); expect(start).not.toHaveBeenCalled();
    const r = await f.start(a); expect(start).toHaveBeenCalledOnce();
    expect((await f.call("GET", `${rootPath}/${r.body.trial}/stop?ownerEpoch=${a.epoch}`, a.headers)).status).toBe(404);
    expect((await f.call("POST", `${rootPath}/${r.body.trial}/stop?ownerEpoch=${a.epoch}`, a.headers, '{"id":"forged"}')).status).toBe(400);
    expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(200);
  });
  it("POST keeps CSRF/Origin checks; malformed JSON/UTF-8 and excess body never reach start", async () => {
    const f = await fixture(), a = f.session(), start = vi.spyOn(f.trials, "start"), path = `${rootPath}/start?ownerEpoch=${a.epoch}`;
    for (const headers of [{ cookie: a.headers.cookie }, { ...a.headers, origin: "http://evil.example" }, { ...a.headers, "sec-fetch-site": "cross-site" }]) expect((await f.call("POST", path, headers, "{}")).status).toBe(401);
    for (const body of ["{", Buffer.from([0xff])]) expect((await f.call("POST", path, a.headers, body)).status).toBe(400);
    expect(await f.call("POST", path, a.headers, " ".repeat(16385)).then(() => "accepted", e => e.code)).toBe("ECONNRESET"); expect(start).not.toHaveBeenCalled();
  });
  it("passive Stop still requires CSRF/Origin and the same local admin", async () => {
    const f = await fixture(), a = f.session(), r = await f.start(a), path = `${rootPath}/${r.body.trial}/stop?ownerEpoch=${a.epoch}`;
    for (const headers of [{ cookie: a.headers.cookie }, { ...a.headers, origin: "http://evil.example" }, { ...a.headers, "sec-fetch-site": "cross-site" }]) expect((await f.call("POST", path, headers, "{}")).status).toBe(401);
    expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(200);
    const b = f.session("bob", "read"); expect((await f.call("POST", `${rootPath}/${r.body.trial}/stop?ownerEpoch=${b.epoch}`, b.headers, "{}")).status).toBe(403);
    expect((await f.call("POST", path, a.headers, "{}")).status).toBe(200);
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH"]) expect(isPassiveWebRead(method, `${rootPath}/${r.body.trial}/stop`)).toBe(false);
    for (const path of [`${rootPath}/${r.body.trial}/stop/extra`, `${rootPath}/${r.body.trial}/stop/`, `${rootPath}/${"A".repeat(32)}/stop`, `${rootPath}/${"a".repeat(31)}/stop`, `${rootPath}/${"a".repeat(33)}/stop`, `${rootPath}/bad/stop`, `${rootPath}/start`, "/ui/effects/apply"]) expect(isPassiveWebRead("POST", path)).toBe(false);
  });
  it("automatic trial reads and Stop do not extend idle expiry; Start stays human activity", async () => {
    const f = await fixture(1000), a = f.session(), r = await f.start(a); f.wall(800);
    for (const part of ["resource", "poster.png", "profile"]) { const p = f.url(r.body.trial, part, a.epoch); expect(isPassiveWebRead("GET", new URL(p, f.origin).pathname)).toBe(true); expect((await f.call("GET", p, a.headers)).status).toBe(200); }
    expect(a.record.lastSeen).toBe(0); expect(isPassiveWebRead("POST", `${rootPath}/start`)).toBe(false); expect(isPassiveWebRead("POST", `${rootPath}/${r.body.trial}/stop`)).toBe(true);
    expect((await f.call("POST", `${rootPath}/${r.body.trial}/stop?ownerEpoch=${a.epoch}`, a.headers, "{}")).status).toBe(200); expect(a.record.lastSeen).toBe(0);
    f.wall(1001); expect((await f.call("GET", f.url(r.body.trial, "resource", a.epoch), a.headers)).status).toBe(401);
  });
  it.each(["revoke", "expiry", "token", "same-person-cookie", "session-store", "css"])("held body rechecks current session/CSS before start: %s", async change => {
    const f = await fixture(1000), a = f.session(), start = vi.spyOn(f.service, "trialStart");
    const req = Object.assign(new EventEmitter(), { method: "POST", url: `${rootPath}/start?ownerEpoch=${a.epoch}`, headers: { ...a.headers, host: new URL(f.origin).host }, destroy() {}, resume() {} });
    let status = 0; const res: any = { headersSent: false, destroyed: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; }, end() {} };
    expect(handleWebRequest(req as never, res, new URL(req.url, f.origin), f.ctx)).toBe(true); expect(status).toBe(0);
    req.emit("data", Buffer.from('{"offer":"'));
    if (change === "revoke") f.sessions.revokeById(a.sessionId);
    if (change === "expiry") f.wall(1001);
    if (change === "token") (f.ctx as any).webToken = "rotated";
    if (change === "same-person-cookie") { const b = f.session(); Object.assign(req.headers, b.headers); }
    if (change === "session-store") (f.ctx as any).webSessions = new WebSessionStore(f.sessionOptions);
    if (change === "css") f.css("on");
    req.emit("data", Buffer.from(`${f.offer.offer}","instance":"agent"}`)); req.emit("end"); for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(status).toBe(change === "same-person-cookie" || change === "session-store" ? 409 : change === "css" ? 200 : 401);
    if (change === "css") expect(start).toHaveBeenCalledOnce(); else expect(start).not.toHaveBeenCalled();
  });
  it("public gateway manifest and direct bound requests refuse every trial operation", async () => {
    const f = await fixture(), made = f.sessions.create({ tier: "admin", surface: "gateway", exposureId: "e".repeat(32), label: "gateway", tokenEpoch: tokenEpoch(f.token) });
    for (const method of ["GET", "POST", "DELETE"]) for (const path of [`${rootPath}/start`, ...["resource", "poster.png", "profile", "stop"].map(p => `${rootPath}/${"a".repeat(32)}/${p}`)]) {
      expect(isPublicWebRoute(method, path)).toBe(false); let status = 0; const res: any = { headersSent: false, setHeader() {}, writeHead(n: number) { status = n; this.headersSent = true; }, end() {} };
      const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "x.trycloudflare.com", origin: "https://x.trycloudflare.com", cookie: `__Host-agend_session=${made.sessionId}`, "x-agend-csrf": csrfTokenFor(made.sessionId) }, destroy() {}, resume() {} });
      bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
      expect(handleWebRequest(req as never, res, new URL(`https://x.trycloudflare.com${path}`), f.ctx)).toBe(true); expect(status).toBe(method === "GET" ? 404 : 403);
    }
  });
});
