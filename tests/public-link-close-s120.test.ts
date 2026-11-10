/**
 * S-120 (D2a): POST /ui/public-link/close — Settings → 存取與安全 → 總覽's 「立即關閉公開連結」. Over HTTP against a real fleet,
 * its public link through the REAL gateway with only the tunnel stubbed (as device-list-3061.test.ts).
 *
 *  - an admin session on this fleet's own listener closes the open link, at once, and the remembered owner is forgotten
 *    (auto_open never reopens a deliberate close);
 *  - it only closes: with no link open it answers closed:false and opens nothing;
 *  - never over the public link itself (the gateway refuses the route; the handler refuses it too), never a guest, a
 *    read-only session or the CLI's header token — the link stays open each time;
 *  - a web-only fleet's outside link is not closed here (its switch is the owner's, on this computer): 409 outside_link,
 *    the link stays open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE } from "../src/web-auth.js";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import { base32Decode, hotp, totpStep } from "../src/web-remote-access.js";
import { fleetCookieName } from "../src/web-cookie-names.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { EventEmitter } from "node:events";
import { PUBLIC_LINK_OWNER_FILE } from "../src/public-link-owner.js";
import { setLocale } from "../src/locale.js";

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stops.splice(0)) await s().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
beforeEach(() => setLocale("en"));

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const parse = (r: Res) => { try { return JSON.parse(r.body); } catch { return null; } };
const cookieOf = (r: Res) => { const set = r.headers["set-cookie"]; return (Array.isArray(set) ? set : [set!])[0]!.split(";")[0]!; };
const HOST = "close-link.trycloudflare.com";
type Signed = { cookie: string; sessionId: string };
const CHAT_OWNER = { adapterId: "telegram", userId: "1", chatId: "1" };

async function startFleet(opts: { chat?: boolean; holdStart?: Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-s120-close-")); dirs.push(dir);
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } },
    ...(opts.chat ? { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } } : {}) } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, token = fm.getDashboardAccess().token!;
  const tunnel = { port: 0 };
  const manager = {
    start: vi.fn(async (_p: unknown, ctx: any) => {
      if (opts.holdStart) await opts.holdStart;                       // the link stays "starting" until released
      tunnel.port = Number(new URL(ctx.origin).port);
      ctx.onCandidateHost(HOST);
      return { ok: true as const, handle: { pageUrl: `https://${HOST}/signin`, onUnexpectedExit: () => () => {} } };
    }),
    stop: vi.fn(async () => ({ confirmed: true as const })),
  };
  any.tunnelPurposeLane = new TunnelPurposeLane(manager as never);
  any.publicWebLink = new PublicWebLink({ ...any.publicWebLinkDeps(), permitted: () => true, ensure: async () => ({ path: "/stub/cloudflared", source: "agend" }), provider: () => ({}) as never });
  stops.push(async () => { await any.publicWebLink?.close("test end"); await new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); }); });

  const hostSignIn = async (): Promise<Signed> => {
    const code = parse(await raw(port, "POST", "/auth/issue-code", { "x-agend-token": token, origin })).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    return { cookie, sessionId: cookie.split("=")[1]! };
  };
  const local = (s: Signed, method: string, path: string, body?: unknown) =>
    raw(port, method, path, { cookie: s.cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId) },
      body === undefined ? undefined : JSON.stringify(body));
  const outside = (s: Signed, method: string, path: string, body?: unknown) =>
    raw(tunnel.port, method, path, { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json",
      cookie: s.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(s.sessionId) }, body === undefined ? undefined : JSON.stringify(body));
  const stored = (input: { tier?: "admin" | "guest" | "read"; surface?: "local" | "gateway"; label: string }): Signed => {
    const surface = input.surface ?? "local";
    const { sessionId } = any.webSessions.create({ tier: input.tier ?? "admin", surface, label: input.label, tokenEpoch: tokenEpoch(token),
      ...(input.tier === "guest" ? { owner: { adapterId: "discord", userId: "9" } } : {}), ...(surface === "gateway" ? { exposureId: any.publicWebLink.exposureId } : {}) });
    return { sessionId, cookie: `${surface === "gateway" ? fleetCookieName(WEB_SESSION_COOKIE_SECURE, token) : WEB_SESSION_COOKIE}=${sessionId}` };
  };
  /** A link /web opened for a chat admin (its owner remembered, as a confirmed delivery records it). */
  const openChatLink = async () => {
    expect(await any.publicWebLink.openUnattended(CHAT_OWNER)).toBe("opened");
    writeFileSync(join(dir, PUBLIC_LINK_OWNER_FILE), JSON.stringify(CHAT_OWNER) + "\n");
    expect(fm.getPublicWebStatus().state).toBe("open");
  };
  return { dir, fm, any, port, origin, token, tunnel, hostSignIn, local, outside, stored, openChatLink };
}
const close = (h: Awaited<ReturnType<typeof startFleet>>, s: Signed) => h.local(s, "POST", "/ui/public-link/close", {});

describe("S-120: POST /ui/public-link/close", () => {
  it("never over the public link, even past the gateway: the handler itself refuses a gateway request (403 public_link_close_not_here)", async () => {
    // Fable #3570 R1: a request handed to the route as the gateway hands it (its context bound, an admin session's
    // cookie and CSRF) — the handler's own check answers, before any session is looked at or anything is closed.
    const h = await startFleet({ chat: true });
    await h.openChatLink();
    const remote = h.stored({ label: "Over the link", surface: "gateway" });
    const closeSpy = vi.spyOn(h.fm as any, "closePublicLinkFromWeb");
    const req: any = Object.assign(new EventEmitter(), { method: "POST", url: "/ui/public-link/close", socket: { remoteAddress: "127.0.0.1" }, destroy: () => {},
      headers: { host: HOST, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: remote.cookie, [WEB_CSRF_HEADER]: csrfTokenFor(remote.sessionId) } });
    bindGatewayRequest(req, { surface: "gateway", exposureId: h.any.publicWebLink.exposureId, expectedOrigin: `https://${HOST}`, isCurrent: () => true, named: false } as any);
    const answer = await new Promise<{ status: number; body: any }>((resolve) => {
      let status = 0;
      const res: any = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, setHeader: () => {},
        writeHead(code: number) { status = code; this.headersSent = true; },
        end(this: EventEmitter, v: string) { this.emit("finish"); this.emit("close"); resolve({ status, body: JSON.parse(v) }); } });
      expect(handleWebRequest(req, res, new URL("/ui/public-link/close", `https://${HOST}`), h.fm as any)).toBe(true);
      setImmediate(() => { req.emit("data", Buffer.from("{}")); req.emit("end"); });
    });
    expect(answer).toEqual({ status: 403, body: { error: "public_link_close_not_here" } });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(h.fm.getPublicWebStatus().state).toBe("open");
    // The refusal leaves the real way intact: an admin on this fleet's own listener still closes it.
    expect((await close(h, await h.hostSignIn())).status).toBe(200);
    expect(h.fm.getPublicWebStatus().state).toBe("closed");
  }, 30_000);

  it("an admin on this fleet's own listener closes the open link at once, and its owner is forgotten", async () => {
    const h = await startFleet({ chat: true });
    const admin = await h.hostSignIn();
    await h.openChatLink();
    const remote = h.stored({ label: "Over the link", surface: "gateway" });
    expect(h.any.webSessions.list(undefined, (x: any) => x.exposureId === h.any.publicWebLink.exposureId).length).toBe(1);
    const id = h.any.publicWebLink.exposureId;
    const r = await close(h, admin);
    expect(r.status).toBe(200);
    expect(parse(r)).toMatchObject({ closed: true });
    // The devices signed in through it are signed out with it (the confirm dialog says so).
    expect(h.any.webSessions.list(undefined, (x: any) => x.exposureId === id).length).toBe(0);
    void remote;
    expect(h.fm.getPublicWebStatus().state).toBe("closed");
    expect(existsSync(join(h.dir, PUBLIC_LINK_OWNER_FILE))).toBe(false);
  }, 30_000);

  it("only closes: with no link open it answers closed:false and opens nothing", async () => {
    const h = await startFleet({ chat: true });
    const admin = await h.hostSignIn();
    const r = await close(h, admin);
    expect(r.status).toBe(200);
    expect(parse(r)).toMatchObject({ closed: false });
    expect(h.fm.getPublicWebStatus().state).toBe("closed");
    expect(h.any.publicWebLink.exposureId).toBeUndefined();
  }, 30_000);

  it("never over the public link itself: the gateway does not route it — the link stays open", async () => {
    expect(isPublicWebRoute("POST", "/ui/public-link/close")).toBe(false);
    const h = await startFleet({ chat: true });
    await h.openChatLink();
    const remote = h.stored({ label: "Over the link", surface: "gateway" });
    const r = await h.outside(remote, "POST", "/ui/public-link/close", {});
    expect(r.status).not.toBe(200);
    expect(h.fm.getPublicWebStatus().state).toBe("open");
  }, 30_000);

  it("closes only the exposure it read: a link opened again before the close runs is left open", async () => {
    // Fable #3570 R7: close("admin close", id) — the captured exposure, never "whatever is open by then".
    const h = await startFleet({ chat: true });
    const admin = await h.hostSignIn();
    await h.openChatLink();
    const link = h.any.publicWebLink, first = link.exposureId, realClose = link.close.bind(link);
    let second: string | undefined;
    vi.spyOn(link, "close").mockImplementationOnce((async (reason: string, id?: string) => {
      // Between the route reading the exposure and its close running, that link ends and a new one opens.
      await realClose("rotated");
      expect(await link.openUnattended(CHAT_OWNER)).toBe("opened");
      second = link.exposureId;
      return realClose(reason, id);
    }) as never);
    const r = await close(h, admin);
    expect(r.status).toBe(200);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect([h.fm.getPublicWebStatus().state, link.exposureId]).toEqual(["open", second]);
  }, 30_000);

  it("never a guest, a read-only session or the CLI's header token — the link stays open each time", async () => {
    const h = await startFleet({ chat: true });
    await h.openChatLink();
    for (const s of [h.stored({ tier: "guest", label: "A guest" }), h.stored({ tier: "read", label: "A reader" })]) {
      const r = await close(h, s);
      expect([401, 403]).toContain(r.status);
      expect(h.fm.getPublicWebStatus().state).toBe("open");
    }
    const cli = await raw(h.port, "POST", "/ui/public-link/close", { "x-agend-token": h.token, origin: h.origin, "content-type": "application/json" }, "{}");
    expect([401, 403]).toContain(cli.status);
    expect(h.fm.getPublicWebStatus().state).toBe("open");
    const anon = await raw(h.port, "POST", "/ui/public-link/close", { origin: h.origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, "{}");
    expect([401, 403]).toContain(anon.status);
    expect(h.fm.getPublicWebStatus().state).toBe("open");
  }, 30_000);

  it("a web-only fleet's outside link is the owner's switch, not closed here: 409 outside_link, the link stays open", async () => {
    const h = await startFleet();
    const owner = await h.hostSignIn();
    const begun = parse(await h.local(owner, "POST", "/ui/outside/enroll", {}));
    const key = base32Decode(begun.secret)!;
    expect((await h.local(owner, "POST", "/ui/outside/enroll/confirm", { code: hotp(key, totpStep(Date.now()) - 1) })).status).toBe(200);
    expect((await h.local(owner, "POST", "/ui/outside/switch", { on: true })).status).toBe(200);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
    const r = await close(h, owner);
    expect(r.status).toBe(409);
    expect(parse(r)).toMatchObject({ error: "outside_link" });
    expect(h.fm.getPublicWebStatus().state).toBe("open");
  }, 40_000);

  it("the outside link while it is still starting is the owner's switch too: 409, and it goes on to open", async () => {
    // Fable #3570 P3: openSignin() is only the OPEN link; the owner is read whatever the phase.
    let release!: () => void;
    const h = await startFleet({ holdStart: new Promise<void>(r => { release = r; }) });
    const owner = await h.hostSignIn();
    const begun = parse(await h.local(owner, "POST", "/ui/outside/enroll", {}));
    const key = base32Decode(begun.secret)!;
    expect((await h.local(owner, "POST", "/ui/outside/enroll/confirm", { code: hotp(key, totpStep(Date.now()) - 1) })).status).toBe(200);
    expect((await h.local(owner, "POST", "/ui/outside/switch", { on: true })).status).toBe(200);
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("starting"));
    const r = await close(h, owner);
    expect([r.status, parse(r)]).toEqual([409, { error: "outside_link" }]);
    release();
    await vi.waitFor(() => expect(h.fm.getPublicWebStatus().state).toBe("open"));
  }, 40_000);
});
