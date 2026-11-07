/**
 * #3327 (P1, alpha): Runtime pairing accepted the bare web token — any HTTP client holding `X-Agend-Token` could go
 * code → pending machine → approve → machine credential with no page and no person. Under the owner's threat model
 * (fleet decision 64a289a0: a process running as the fleet's own OS user is the owner; remote parties, other OS users,
 * links, guests and cross-site requests are not) and the user's rule to add no click (721ca0c3, addendum 2), the fix is
 * defence in depth on the route itself:
 *   - creating a code and approving a computer take an administrator SESSION on the directly reached dashboard (its
 *     cookie and CSRF value: the page's own Connect a computer and Approve computer buttons) — never the bare token, a
 *     link, a guest or a read session, checked again after the body;
 *   - turning remote runtimes on was already a held Settings change that the bare token cannot ask for (pinned here).
 * Every refusal proves nothing was recorded: no code, no approval, and the Runtime's claim still answers "pending".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, IncomingMessage, ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";
import { handleRuntimeRequest, type RuntimeApiContext } from "../src/runtime-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { WEB_CSRF_HEADER, WEB_SESSION_COOKIE } from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { base32Decode, hotp, totpStep } from "../src/web-remote-access.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [], hubs: RuntimeCoordinator[] = [];
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
beforeEach(() => { vi.stubEnv("AGEND_REMOTE_RUNTIME", "1"); setLocale("en"); });
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const h of hubs.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── The Runtime routes themselves ──
const token = "t".repeat(48);
class Res extends ServerResponse {
  status = 0; body = "";
  override writeHead(code: number): this { this.status = code; return this; }
  override end(chunk?: unknown): this { this.body += String(chunk ?? ""); return this; }
}
type Who = "token" | "admin" | "read" | "guest" | "gateway";
function routes() {
  const hub = new RuntimeCoordinator(temp("agend-3327-api-")); hubs.push(hub);
  const sessions = new WebSessionStore(), ctx: RuntimeApiContext = { webToken: token, webSessions: sessions, runtimeCoordinator: () => hub };
  /** One POST as `who`; `during` runs while the body is still unread (a revocation then). */
  const make = (path: string, body: unknown, who: Who, during?: (handle: string) => void, extra: Record<string, string> = {}) => {
    const req = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
    req.method = "POST"; req.url = path; req.headers = { host: "localhost" };
    Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" }, configurable: true });
    let handle = "";
    if (who === "token") req.headers["x-agend-token"] = token;
    else {
      const tier = who === "gateway" ? "admin" : who;
      const { sessionId, record } = sessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(token), ...(tier === "guest" ? { owner: { adapterId: "tg", userId: "9" } } : {}) });
      handle = record.handle;
      Object.assign(req.headers, { cookie: `${WEB_SESSION_COOKIE}=${sessionId}`, origin: "http://localhost", "x-agend-csrf": csrfTokenFor(sessionId) });
      if (who === "gateway") bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: "http://localhost", isCurrent: () => true });
    }
    Object.assign(req.headers, extra);
    const res = new Res(req); handleRuntimeRequest(req, res, new URL(path, "http://localhost"), ctx);
    during?.(handle);
    return res;
  };
  const pending = () => { const p = hub.createPairing(), m = hub.pair({ code: p.code, name: "Desk", platform: "win32" }); return { ...m, fingerprint: hub.machine(m.machineId)!.pairingFingerprint!, path: `/ui/runtimes/machines/${m.machineId}/approve` }; };
  const claim = (m: { machineId: string; claimSecret: string }) => hub.claim({ machineId: m.machineId, claimSecret: m.claimSecret });
  return { hub, sessions, ctx, make, pending, claim };
}

describe("#3327 the Runtime routes: a pairing code and an approval only from a page session", () => {
  it.each(["token", "read", "guest", "gateway"] as const)("%s cannot create a pairing code — nothing is recorded", async who => {
    const r = routes(), create = vi.spyOn(r.hub, "createPairing");
    const res = r.make("/ui/runtimes/pairing", {}, who);
    await vi.waitFor(() => expect(res.status).toBe(403));
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["token", "read", "guest", "gateway"] as const)("%s cannot approve a pending computer: it stays pending, its claim gets no credential", async who => {
    const r = routes(), m = r.pending(), approve = vi.spyOn(r.hub, "approve");
    const res = r.make(m.path, { fingerprint: m.fingerprint }, who);
    await vi.waitFor(() => expect(res.status).toBe(403));
    expect([approve.mock.calls.length, r.hub.machine(m.machineId)!.status, r.claim(m)]).toEqual([0, "pending", { status: "pending" }]);
  });
  it("a session revoked while its body is still being read: refused after the read, nothing recorded", async () => {
    const r = routes(), m = r.pending(), create = vi.spyOn(r.hub, "createPairing"), approve = vi.spyOn(r.hub, "approve");
    const a = r.make("/ui/runtimes/pairing", {}, "admin", handle => r.sessions.revokeByHandle(handle));
    const b = r.make(m.path, { fingerprint: m.fingerprint }, "admin", handle => r.sessions.revokeByHandle(handle));
    await vi.waitFor(() => expect([a.status, b.status]).toEqual([403, 403]));
    expect([create.mock.calls.length, approve.mock.calls.length, r.claim(m)]).toEqual([0, 0, { status: "pending" }]);
  });
  it("the page's own session: Connect a computer gives a code, Approve computer approves it — one click each, as before", async () => {
    const r = routes();
    const made = r.make("/ui/runtimes/pairing", {}, "admin"); await vi.waitFor(() => expect(made.status).toBe(201));
    const m = r.hub.pair({ code: JSON.parse(made.body).code, name: "Desk", platform: "win32" });
    expect(r.claim(m)).toEqual({ status: "pending" });
    const ok = r.make(`/ui/runtimes/machines/${m.machineId}/approve`, { fingerprint: r.hub.machine(m.machineId)!.pairingFingerprint }, "admin");
    await vi.waitFor(() => expect(ok.status).toBe(200));
    expect(r.claim(m)).toMatchObject({ status: "approved", credential: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it("routes other than pairing keep their own policy (the bare token still renames)", async () => {
    const r = routes(), m = r.pending();
    const renamed = r.make(`/ui/runtimes/machines/${m.machineId}/rename`, { name: "Work PC" }, "token");
    await vi.waitFor(() => expect(renamed.status).toBe(200));
    expect(r.hub.machine(m.machineId)!.name).toBe("Work PC");
  });
});

// ── A real fleet over HTTP: the token's chain is broken; the person's page still pairs ──
interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}
const CHAT = { channel: { type: "telegram", mode: "topic", bot_token_env: "T", group_id: "-100", access: { mode: "locked", allowed_users: ["1"] } } };
async function startFleet(config: Record<string, unknown> = {}) {
  const dir = temp("agend-3327-fleet-");
  const fm = new FleetManager(dir), any = fm as any;
  const sink = () => {};
  fm.logger = { info: sink, warn: sink, error: sink, debug: sink, trace: sink, fatal: sink, child: () => fm.logger } as unknown as typeof fm.logger;
  const notices = vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  fm.fleetConfig = { defaults: {}, instances: {}, web: { verified_authority: { enabled: true } }, ...config } as never;
  any.initializeWebAuthTokens();
  any.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const address = (any.healthServer as Server).address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  const port = address.port, origin = `http://127.0.0.1:${port}`, tok = fm.getDashboardAccess().token!;
  const stop = () => new Promise<void>(resolve => { const s = any.healthServer as Server | null; any.healthServer = null; s ? s.close(() => resolve()) : resolve(); });
  const bare = (method: string, path: string, body: unknown) => raw(port, method, path, { "x-agend-token": tok, origin, "content-type": "application/json" }, JSON.stringify(body));
  /** A page session: here, the token's own bootstrap (`/auth/issue-code`, then `/auth/login`) — the owner, per 64a289a0. */
  /** `issue`: headers on the code's request (`agend web` runs here: none); `extra`: on the sign-in and every later write. */
  const issue = (extra: Record<string, string> = {}) => raw(port, "POST", "/auth/issue-code", { "x-agend-token": tok, origin, ...extra });
  const page = async (extra: Record<string, string> = {}) => {
    const issued = await issue();
    expect(issued.status).toBe(200);
    const code = JSON.parse(issued.body).code as string;
    const res = await raw(port, "POST", "/auth/login", { "content-type": "application/json", origin, ...extra }, JSON.stringify({ code }));
    expect(res.status).toBe(200);
    const set = res.headers["set-cookie"], cookie = (Array.isArray(set) ? set[0] : set)!.split(";")[0]!, sessionId = cookie.split("=")[1]!;
    const post = (path: string, body: unknown, csrf = true) => raw(port, "POST", path, { cookie, origin, "content-type": "application/json",
      ...(csrf ? { [WEB_CSRF_HEADER]: csrfTokenFor(sessionId) } : {}), ...extra }, JSON.stringify(body));
    return { cookie, sessionId, post };
  };
  return { fm, any, port, stop, bare, issue, page, notices };
}
function runtimeOf(fm: FleetManager) {
  const hub = fm.runtimeCoordinator(); if (!hubs.includes(hub)) hubs.push(hub);
  const pair = (code: string) => { const m = hub.pair({ code, name: "Desk", platform: "win32" }); return { ...m, fingerprint: hub.machine(m.machineId)!.pairingFingerprint!, path: `/ui/runtimes/machines/${m.machineId}/approve` }; };
  const claim = (m: { machineId: string; claimSecret: string }) => hub.claim({ machineId: m.machineId, claimSecret: m.claimSecret });
  return { hub, pair, claim };
}

describe("#3327 a real fleet", () => {
  it.each([["chat fleet", CHAT], ["web-only fleet", {}]] as const)("%s: the bare token gets no code and no approval; the page's two clicks still pair", async (_name, config) => {
    const h = await startFleet(config as Record<string, unknown>);
    try {
      const r = runtimeOf(h.fm), create = vi.spyOn(r.hub, "createPairing");
      expect((await h.bare("POST", "/ui/runtimes/pairing", {})).status).toBe(403);
      expect(create).not.toHaveBeenCalled();
      const s = await h.page();
      // Without its CSRF value the session is refused too (a cross-site request).
      expect((await s.post("/ui/runtimes/pairing", {}, false)).status).toBe(403);
      expect(create).not.toHaveBeenCalled();
      const made = await s.post("/ui/runtimes/pairing", {});                         // click 1: Connect a computer
      expect(made.status).toBe(201);
      const m = r.pair(JSON.parse(made.body).code);
      const approve = vi.spyOn(r.hub, "approve");
      expect((await h.bare("POST", m.path, { fingerprint: m.fingerprint })).status).toBe(403);
      expect([approve.mock.calls.length, r.hub.machine(m.machineId)!.status, r.claim(m)]).toEqual([0, "pending", { status: "pending" }]);
      const ok = await s.post(m.path, { fingerprint: m.fingerprint });                // click 2: Approve computer
      expect(ok.status).toBe(200);
      expect(r.claim(m)).toMatchObject({ status: "approved" });
    } finally { await h.stop(); }
  }, 30_000);
  it.each([["chat fleet", CHAT], ["web-only fleet", {}]] as const)("%s: the token's remote bootstrap is fenced — issue-code from elsewhere mints nothing (#3345 review)", async (_name, config) => {
    const h = await startFleet(config as Record<string, unknown>);
    try {
      const codes = h.any.webLoginCodes, issued = vi.spyOn(codes, "issue");
      // Prism's probes: the header token through a forwarding proxy, or a non-loopback Host — no code, so no session.
      for (const away of [{ "x-forwarded-for": "198.51.100.70" }, { forwarded: "for=198.51.100.70" }, { host: "agend.example.test" }]) {
        const res = await h.issue(away);
        expect([res.status, JSON.parse(res.body).code], JSON.stringify(away)).toEqual([403, undefined]);
      }
      expect(issued).not.toHaveBeenCalled();
      // D3 / the owner: `agend web` on this computer still gets its code; typed into a browser elsewhere (a LAN, the
      // owner's own proxy) it signs in as before, and the page's two clicks pair — no step added.
      const s = await h.page({ "x-forwarded-for": "198.51.100.70" });
      const r = runtimeOf(h.fm), made = await s.post("/ui/runtimes/pairing", {});
      expect(made.status).toBe(201);
      const m = r.pair(JSON.parse(made.body).code);
      expect((await s.post(m.path, { fingerprint: m.fingerprint })).status).toBe(200);
      expect(r.claim(m)).toMatchObject({ status: "approved" });
    } finally { await h.stop(); }
  }, 30_000);
  it("the bare token cannot turn remote runtimes on (a held Settings change needs a session): the switch stays off", async () => {
    vi.stubEnv("AGEND_REMOTE_RUNTIME", "");
    const h = await startFleet(CHAT);
    try {
      const res = await h.bare("PUT", "/api/settings/fleet/runtimes", { remote_runtime: true });
      expect(res.status).toBe(401);
      expect((h.fm.fleetConfig as { runtimes?: { remote_runtime?: boolean } }).runtimes?.remote_runtime).toBeUndefined();
    } finally { await h.stop(); }
  }, 30_000);
  it("an authenticator set up again, or removed, is announced; a first set-up is not", async () => {
    const h = await startFleet();
    try {
      vi.spyOn(h.any, "liveOwner").mockReturnValue({ handle: "0123456789abcdef", current: () => true });
      const enrol = () => {
        const begun = h.fm.webOutsideBeginEnrollment({} as IncomingMessage)!;
        expect(h.fm.webOutsideConfirmEnrollment({} as IncomingMessage, hotp(base32Decode(begun.secret)!, totpStep(Date.now())))).toBe("ok");
      };
      enrol();
      expect(h.notices).not.toHaveBeenCalled();
      enrol();
      expect(h.notices.mock.calls.map(c => c[0])).toEqual([t("outside.reenrolled_notice")]);
      expect(h.fm.webOutsideRemove({} as IncomingMessage)).toBe("ok");
      expect(h.notices.mock.calls.map(c => c[0])).toEqual([t("outside.reenrolled_notice"), t("outside.removed_notice")]);
    } finally { await h.stop(); }
  }, 30_000);
});
