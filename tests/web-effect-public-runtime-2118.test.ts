/** Real private listeners/gateway and stores; synthetic accounts only, no fleet or external transport. */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebEffectLibrary } from "../src/web-effect-library.js";
import { WebEffectProfiles } from "../src/web-effect-profiles.js";
import { WebEffectService } from "../src/web-effect-service.js";
import { ThemeStore } from "../src/web-theme-store.js";
import { WebPrefsStore } from "../src/web-prefs.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { bindGuestRequest, guestRouteDecision } from "../src/web-guest-access.js";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";
import { webPersonKey } from "../src/web-profile.js";
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); })));
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
async function fixture(guest = false) {
  const root = mkdtempSync(join(tmpdir(), "agend-public-effect-")); roots.push(root);
  const library = new WebEffectLibrary(root), themes = new ThemeStore(root), profiles = new WebEffectProfiles(root), prefs = new WebPrefsStore(root);
  const account = { adapterId: "demo", userId: "synthetic" }, person = webPersonKey(account), token = "synthetic-runtime-token", exposure = "e".repeat(32), host = "effects-fixture.trycloudflare.com";
  let current = true, guestCurrent = true, wall = 0; const scope = new Set(["own"]);
  const sessions = new WebSessionStore({ now: () => wall });
  library.registerReferenceSource("themes", () => themes.placedEffects().flatMap(row => row.ids.map(id => ({ id, holder: `instance:${row.name}` }))));
  const service = new WebEffectService({ library, themes, profiles, changed() {}, known: n => ["own", "peer"].includes(n) });
  const ctx = { fleetConfig: { web: { experimental: { canvas_worker: true } } }, webToken: token, webSessions: sessions, effectService: service, webPrefs: prefs, effectBoot: "c".repeat(32) } as unknown as WebApiContext;
  const dispatch = (req: any, res: any) => {
    if (guest) bindGuestRequest(req, { owner: account, scope: () => scope, current: () => guestCurrent });
    if (!handleWebRequest(req, res, new URL(req.url, `https://${host}`), ctx)) { res.writeHead(404); res.end("{}"); }
  };
  const local = createServer(dispatch); servers.push(local); await new Promise<void>(r => local.listen(0, "127.0.0.1", r));
  const gateway = createPublicWebGateway({ exposureId: exposure, isCurrent: () => current, isOpen: () => true, dispatch });
  const address = await gateway.listen(); servers.push(gateway.server); gateway.setHost(host);
  const session = (surface: "local" | "gateway" = "gateway") => {
    const s = sessions.create({ tier: guest ? "guest" : "read", surface, ...(surface === "gateway" ? { exposureId: exposure } : {}), label: "Synthetic", tokenEpoch: tokenEpoch(token), owner: account });
    return { id: s.sessionId, epoch: s.record.handle, cookie: `${surface === "gateway" ? "__Host-agend_session" : "agend_session"}=${s.sessionId}` };
  };
  const call = (path: string, s?: ReturnType<typeof session>, method = "GET", publicLink = true, more: Record<string, string> = {}) => new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: publicLink ? Number(address.port) : (local.address() as any).port, path, method,
      headers: { host: publicLink ? host : "localhost", ...(s ? { cookie: s.cookie } : {}), ...more } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : text, headers: res.headers }); });
    }); r.on("error", reject); r.end();
  });
  const upload = (name = "chat", regions = ["chat"]) => {
    const staged = library.stage(new Map([["effect.json", Buffer.from(JSON.stringify({ v: 1, runtime: "canvas-worker-v1", worker: "worker.js", name, title: name, regions, layer: "behind", wants: [] }))], ["worker.js", Buffer.from("agend.ready(); // " + name)]]), { kind: "human", id: person });
    if (!staged.ok) throw Error(staged.error); const committed = library.commit(staged.stageId); if (!committed.ok) throw Error(committed.error); return committed.ids[0]!;
  };
  return { service, themes, sessions, scope, person, upload, session, call, end: () => { current = false; }, expire: () => { wall += 30 * 86400_000; }, endGuest: () => { guestCurrent = false; } };
}
const query = (epoch: string, instance = "own") => `instance=${instance}&ownerEpoch=${epoch}`;
describe("#2118 exact current Chat reads over the real public gateway", () => {
  it("reads a private retained placement, without acquiring any library/owner/export grant; removal takes effect on the next read", async () => {
    const f = await fixture(), s = f.session(), id = f.upload();
    expect(f.themes.setPlacements("own", { effects: [id] }, "human", () => null).ok).toBe(true);
    expect(await f.call(`/ui/effects/placements?${query(s.epoch)}`, s)).toMatchObject({ status: 200, body: { effects: [{ id }] } });
    const resource = await f.call(`/ui/effects/resource/${id}?${query(s.epoch)}`, s); expect(resource).toMatchObject({ status: 200, body: { id, code: "agend.ready(); // chat" }, headers: { "cache-control": "private, no-store" } });
    expect((await f.call(`/ui/effects/resource/${id}?ownerEpoch=${s.epoch}`, s)).status).toBe(404);
    expect((await f.call(`/ui/effects/resource/${f.upload("unplaced")}?${query(s.epoch)}`, s)).status).toBe(404);
    expect(f.themes.setPlacements("own", { effects: [] }, "human", () => null).ok).toBe(true);
    expect((await f.call(`/ui/effects/resource/${id}?${query(s.epoch)}`, s)).status).toBe(404);
    expect((await f.call(`/ui/effects/placements?${query(s.epoch)}`, s)).body.effects).toEqual([]);
  });
  it("requires the current session/epoch/exposure and rejects duplicate or extra query scopes", async () => {
    const f = await fixture(), s = f.session(), id = f.upload(); f.themes.setPlacements("own", { effects: [id] }, "agent", () => null);
    const path = `/ui/effects/resource/${id}`;
    expect((await f.call(`${path}?${query(s.epoch)}`)).status).toBe(401);
    expect((await f.call(`${path}?${query(s.epoch)}`, undefined, "GET", true, { "x-agend-token": "synthetic-runtime-token" })).status).toBe(401);
    expect((await f.call(`${path}?${query(s.epoch)}`, undefined, "GET", false, { "x-agend-token": "synthetic-runtime-token" })).status).toBe(403);
    for (const q of ["", query("f".repeat(16)), query(s.epoch, ""), query(s.epoch, "peer"), `${query(s.epoch)}&instance=peer`, `${query(s.epoch)}&ownerEpoch=${s.epoch}`, `${query(s.epoch)}&slot=fx.page`, `${query(s.epoch)}&extra=1`]) expect((await f.call(`${path}?${q}`, s)).status, q).toBe(404);
    expect((await f.call(`${path}?${query(s.epoch)}`, f.session("local"))).status).toBe(401);
    f.sessions.revokeById(s.id); expect((await f.call(`${path}?${query(s.epoch)}`, s)).status).toBe(401);
    const newer = f.session(); f.expire(); expect((await f.call(`${path}?${query(newer.epoch)}`, newer)).status).toBe(401);
    f.end(); expect((await f.call(`${path}?${query(s.epoch)}`, s)).status).toBe(403);
  });
  it("filters legacy non-chat placements and never falls back to a readable own claim", async () => {
    const f = await fixture(), s = f.session(), id = f.upload("header", ["header"]);
    f.themes.setPlacements("own", { effects: [id] }, "human", () => null);
    expect((await f.call(`/ui/effects/placements?${query(s.epoch)}`, s)).body.effects).toEqual([]);
    expect((await f.call(`/ui/effects/resource/${id}?${query(s.epoch)}`, s)).status).toBe(404);
    expect(f.service.resource(f.person, id, undefined, true)).toEqual({ error: "not_found" });
    expect(f.service.resource(f.person, id)).toMatchObject({ id });
  });
  it("excludes all private endpoints and writes, even with a valid public session", async () => {
    const f = await fixture(), s = f.session(), id = f.upload();
    for (const path of ["/ui/effects", "/ui/effects/owner", `/ui/effects/image/${id}/cursor.png`, `/ui/effects/profile/${id}`, "/ui/effect-trials/start"])
      expect((await f.call(`${path}?${query(s.epoch)}`, s)).status, path).toBe(404);
    for (const method of ["HEAD", "POST", "DELETE"]) for (const path of ["/ui/effects/placements", `/ui/effects/resource/${id}`, "/ui/effects/apply", "/ui/effects/remove"])
      expect(isPublicWebRoute(method, path), `${method} ${path}`).toBe(false);
  });
  it("issues a separate public Chat capability while personal preference scope stays none; headers and anonymous loads get none", async () => {
    const f = await fixture(), s = f.session(), r = await f.call("/ui/chat/own", s);
    expect(r.status).toBe(200); expect(r.body).toContain(`data-effect-epoch="${s.epoch}"`); expect(r.body).toContain('data-effect-scope="chat"'); expect(r.body).toContain('data-effect-boot="' + "c".repeat(32) + '"');
    expect(r.body).toContain('data-owner-css-state="off"'); expect(r.body).toMatch(/ownerEpoch&#34;:null/); expect(r.headers["content-security-policy"]).toContain("https://effects-fixture.trycloudflare.com/effect-bootstrap");
    for (const extra of [{}, { "x-agend-token": "synthetic-runtime-token" }] as Record<string, string>[]) expect((await f.call("/ui/chat/own", undefined, "GET", false, extra)).body).not.toContain("data-effect-epoch");
  });
  it.each([false, true])("guest instance/current scope is checked by the handler as well as the route table (public=%s)", async publicLink => {
    const f = await fixture(true), s = f.session(publicLink ? "gateway" : "local"), id = f.upload(); f.themes.setPlacements("own", { effects: [id] }, "human", () => null);
    const path = `/ui/effects/resource/${id}?${query(s.epoch)}`;
    const shell=await f.call("/ui/chat/own",s,"GET",publicLink); expect(shell.body).toContain('data-owner-css-state="off"');expect(shell.body).not.toContain('data-owner-css="');
    expect((await f.call(path, s, "GET", publicLink)).status).toBe(200);
    f.scope.clear(); expect((await f.call(path, s, "GET", publicLink)).status).toBe(404);
    f.scope.add("own"); f.endGuest(); expect((await f.call(path, s, "GET", publicLink)).status).toBe(404);
    expect(guestRouteDecision("GET", new URL("https://example/ui/effects/placements?instance=own"), new Set(["own"]))).toMatchObject({ kind: "allow" });
  });
});
