import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeSession, decideWebGate, evaluateWebRequest, isPassiveWebRead, readSessionCookies, WEB_CSRF_HEADER, WEB_SESSION_COOKIE, WEB_SESSION_COOKIE_SECURE,
} from "../src/web-auth.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { csrfTokenFor, tokenEpoch, WebSessionStore } from "../src/web-session.js";
import { SetupHost } from "../src/setup-host.js";

/**
 * #1490 (2.2 audit), three small web items:
 *  - row 21: a stale `__Host-agend_session` hid a valid `agend_session` on this computer's own listener;
 *  - row 22: polling an Apply job (up to ten minutes) slid the session's idle expiry (#1373);
 *  - row 24: the setup host's pages had no Content-Security-Policy and no frame protection.
 */

const TOKEN = "t".repeat(48);
const STALE = "0".repeat(32);
const local = (headers: Record<string, string>) => ({ method: "GET", headers: { host: "fleet.local", ...headers } });
const both = (secure: string, plain: string) => `${WEB_SESSION_COOKIE_SECURE}=${secure}; ${WEB_SESSION_COOKIE}=${plain}`;

describe("a stale __Host- cookie does not hide a valid plain one on the local listener (row 21)", () => {
  it("a read with a stale __Host- cookie and a valid plain one is allowed, as that session", () => {
    const sessions = new WebSessionStore();
    const { sessionId } = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(TOKEN) });
    const decision = decideWebGate(local({ cookie: both(STALE, sessionId) }), new URL("/ui", "http://fleet.local"), TOKEN, sessions);
    expect(decision.kind).toBe("allow");
    expect((decision as { session?: { id?: string } }).session).toBeTruthy();
  });

  it("a write is checked against the session that authenticated: its CSRF value passes, the stale cookie's does not", () => {
    const sessions = new WebSessionStore();
    const { sessionId } = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(TOKEN) });
    const write = (csrf: string) => decideWebGate({ method: "POST", headers: {
      host: "fleet.local", origin: "http://fleet.local", cookie: both(STALE, sessionId), [WEB_CSRF_HEADER]: csrf,
    } }, new URL("/ui/send", "http://fleet.local"), TOKEN, sessions);
    expect(write(csrfTokenFor(sessionId)).kind).toBe("allow");
    expect(write(csrfTokenFor(STALE))).toMatchObject({ kind: "reject", status: 403, reason: "csrf" });
  });

  it("the handlers' own check (evaluateWebRequest) and the session endpoints (authorizeSession) fall back the same way", () => {
    const sessions = new WebSessionStore();
    const { sessionId } = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(TOKEN) });
    expect(evaluateWebRequest(local({ cookie: both(STALE, sessionId) }), new URL("/ui", "http://fleet.local"), TOKEN, sessions).kind).toBe("allow");
    expect(authorizeSession(local({ cookie: both(STALE, sessionId) }), TOKEN, sessions)).toMatchObject({ kind: "ok", sessionId });
  });

  it("a valid __Host- cookie still wins over a plain one (positive control for the order)", () => {
    const sessions = new WebSessionStore();
    const secure = sessions.create({ tier: "admin", surface: "local", label: "secure", tokenEpoch: tokenEpoch(TOKEN) }).sessionId;
    const plain = sessions.create({ tier: "admin", surface: "local", label: "plain", tokenEpoch: tokenEpoch(TOKEN) }).sessionId;
    expect(readSessionCookies(local({ cookie: both(secure, plain) }))).toEqual([secure, plain]);
    const seen: string[] = [];
    const real = sessions.authenticate.bind(sessions);
    const spy = vi.spyOn(sessions, "authenticate").mockImplementation((id, epoch, opts) => { seen.push(String(id)); return real(id, epoch, opts); });
    expect(decideWebGate(local({ cookie: both(secure, plain) }), new URL("/ui", "http://fleet.local"), TOKEN, sessions).kind).toBe("allow");
    expect(seen, "the plain cookie is not even tried when the __Host- one authenticates").toEqual([secure]);
    spy.mockRestore();
  });

  it("the public link accepts only its __Host- cookie: a valid plain one there is not a fallback", () => {
    const sessions = new WebSessionStore();
    const exposureId = "e".repeat(32), origin = "https://sample.trycloudflare.com";
    const plain = sessions.create({ tier: "admin", surface: "gateway", exposureId, label: "p", tokenEpoch: tokenEpoch(TOKEN) }).sessionId;
    const req = { method: "GET", headers: { host: "sample.trycloudflare.com", cookie: both(STALE, plain) } };
    bindGatewayRequest(req, { surface: "gateway", exposureId, expectedOrigin: origin, isCurrent: () => true });
    expect(readSessionCookies(req)).toEqual([STALE]);
    expect(decideWebGate(req, new URL("/ui", origin), TOKEN, sessions).kind).toBe("reject");
  });
});

describe("polling an Apply job does not count as activity (row 22)", () => {
  it.each([
    "/api/settings/apply/1a2b-3c4d",
    "/api/settings/secrets/GROQ_API_KEY/apply/abc_123",
    "/api/settings/provider-secrets/OPENAI_API_KEY/apply/abc-123",
    "/api/settings/connections/discord-2/secret/apply/abc-123",
    "/api/settings/connections/discord-2/binding/apply/abc-123",
  ])("GET %s is passive, and the gate does not slide the session", (path) => {
    expect(isPassiveWebRead("GET", path)).toBe(true);
    const sessions = new WebSessionStore();
    const { sessionId } = sessions.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(TOKEN) });
    const spy = vi.spyOn(sessions, "authenticate");
    decideWebGate(local({ cookie: `${WEB_SESSION_COOKIE}=${sessionId}` }), new URL(path, "http://fleet.local"), TOKEN, sessions);
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ touch: false });
  });

  it("starting an Apply, or reading another settings route, still counts (controls)", () => {
    expect(isPassiveWebRead("POST", "/api/settings/apply")).toBe(false);
    expect(isPassiveWebRead("POST", "/api/settings/apply/1a2b")).toBe(false);
    expect(isPassiveWebRead("GET", "/api/settings/fleet")).toBe(false);
    expect(isPassiveWebRead("GET", "/api/settings/apply/1a2b/extra")).toBe(false);
  });
});

// ── row 24: the setup host's headers, on a real SetupHost ──────────────────────

const dirs: string[] = [];
const hosts: SetupHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown(false, "test cleanup").catch(() => {});
  for (const dir of dirs.splice(0)) { try { chmodSync(dir, 0o700); } catch {} rmSync(dir, { recursive: true, force: true }); }
});
function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.json === undefined ? null : JSON.stringify(opts.json);
    const headers: Record<string, string> = { ...opts.headers };
    if (payload !== null) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(payload)); }
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let body = ""; res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject); r.end(payload ?? undefined);
  });
}
async function startHost() {
  const dir = mkdtempSync(join(tmpdir(), "agend-setup-csp-")); dirs.push(dir);
  const host = new SetupHost({ dataDir: dir, configPath: join(dir, "fleet.yaml"), port: 0, spawnFleet: vi.fn(), log: () => {} });
  hosts.push(host);
  return host.start();
}
function noncesOf(html: string): string[] {
  return [...html.matchAll(/<(?:script|style)( nonce="([^"]+)")?>/g)].map(m => m[2] ?? "(none)");
}

describe("the setup host's pages are framed by nothing and run only their own inline code (row 24)", () => {
  it("the code prompt: a CSP whose nonce is on its script and style, X-Frame-Options DENY", async () => {
    const { port, path } = await startHost();
    const page = await call(port, "GET", path);
    expect(page.status).toBe(200);
    const csp = String(page.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, csp).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(noncesOf(page.body), "every inline tag carries this response's nonce").toEqual([nonce, nonce]);
    const again = await call(port, "GET", path);
    expect(/script-src 'nonce-([^']+)'/.exec(String(again.headers["content-security-policy"]))?.[1], "fresh per response").not.toBe(nonce);
  });

  it("the first-setup wizard (signed in) gets the same protection and still renders (positive control)", async () => {
    const { port, path, code } = await startHost();
    const open = await call(port, "POST", `${path}open`, { json: { code } });
    expect(open.status, open.body).toBe(200);
    const cookie = String(open.headers["set-cookie"]).split(";")[0]!;
    const wizard = await call(port, "GET", path, { headers: { cookie } });
    expect(wizard.status).toBe(200);
    expect(wizard.body).toContain("Review and start");
    const csp = String(wizard.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(noncesOf(wizard.body)).toEqual([nonce, nonce]);
    expect(wizard.headers["x-frame-options"]).toBe("DENY");
  });

  it("an API answer is framed by nothing either", async () => {
    const { port, path } = await startHost();
    const api = await call(port, "GET", `${path}api/anything`);
    expect(api.headers["x-frame-options"]).toBe("DENY");
    expect(String(api.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });
});
