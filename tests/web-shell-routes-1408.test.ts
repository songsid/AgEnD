/**
 * #1408 §3: the app shell's routes, served for exactly what the one classifier names.
 * - The server classifier (web-shell-routes.ts) and the client router (app-route.js) agree on one case table, and no
 *   shell path is a data route or the reverse.
 * - Over real HTTP (a FleetManager's listener in a scratch dir: no fleet, no tmux): every shell path serves the same
 *   page; a known and an unknown instance get the same body and the same CSP (the nonce masked: it is fresh per
 *   response); a malformed name is a 400; signed out, a browser navigation gets the sign-in page.
 * - Every signed-in shell entry carries the same boot attributes and the same conditional frame-src (#1306); the
 *   public link carries the poll transport and no previews.
 * - The public link's manifest asks the same classifier.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { shellRoute, isWebPageNavigation, isSafeInstanceName, chatPath as serverChatPath } from "../src/web-shell-routes.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { EventEmitter } from "node:events";

const client = await import("/assets/app-route.js") as {
  parseRoute(p: string): unknown; legacyHashTarget(p: string, h: string): string | null; chatPath(n: string): string; isSafeInstanceName(n: string): boolean;
};

// [path, what it is]: "chat:<name>" / "chat:" / "fleet:<tab>" / "settings:<section>" / "malformed" / "none"
const CASES: Array<[string, string]> = [
  ["/ui", "chat:"],
  ["/ui/chat/web-dev", "chat:web-dev"],
  ["/ui/chat/%E4%B8%AD%E6%96%87", "chat:中文"],
  ["/ui/chat/a%20b", "chat:a b"],
  ["/ui/chat/classic-ops-1234", "chat:classic-ops-1234"],
  ["/ui/chat/%E0%A4", "malformed"],          // not valid percent-encoding
  ["/ui/chat/a%2Fb", "malformed"],           // a separator once decoded
  ["/ui/chat/%2E%2E", "malformed"],          // traversal
  ["/ui/chat/a%5Cb", "malformed"],
  ["/ui/chat/a%00b", "malformed"],
  [`/ui/chat/${"x".repeat(129)}`, "malformed"],
  ["/ui/chat", "none"],
  ["/ui/chat/a/b", "none"],
  ["/ui/fleet", "fleet:tasks"],
  ["/ui/fleet/tasks", "fleet:tasks"],
  ["/ui/fleet/schedules", "fleet:schedules"],
  ["/ui/fleet/teams", "fleet:teams"],
  ["/ui/fleet/config", "fleet:config"],
  ["/ui/fleet/bogus", "none"],
  ["/ui/", "none"],
  ["/uix", "none"],
  ["/view", "view:"],
  ["/view/web-dev", "view:web-dev"],
  ["/view/%E4%B8%AD", "view:中"],
  ["/view/a%2Fb", "malformed"],
  ["/view/%E0%A4", "malformed"],
  ["/view/a/b", "none"],
  ["/ui/needs", "needs:"],
  ["/ui/needs/x", "none"],
  ["/settings", "settings:agents"],
  ["/settings/agents", "settings:agents"],
  ["/settings/bots", "settings:bots"],
  ["/settings/classic", "settings:classic"],
  ["/settings/general", "settings:general"],
  ["/settings/advanced", "settings:advanced"],
  ["/settings/bogus", "none"],
  ["/settings/", "none"],
  ["/settings/general/x", "none"],
  ["/settingsx", "none"],
];
// Every data route under /ui the server answers (web-api.ts), by shape.
const DATA_ROUTES = ["/ui/poll", "/ui/events", "/ui/history", "/ui/file/abc", "/ui/prompts", "/ui/instance/web-dev", "/ui/instances",
  "/ui/tasks", "/ui/tasks/t1", "/ui/schedules", "/ui/schedules/s1", "/ui/teams", "/ui/teams/x", "/ui/config", "/ui/backends", "/ui/js/app.js",
  "/ui/needs/ack", "/ui/send", "/ui/upload", "/ui/prompt", "/ui/cancel/x", "/ui/stop/x", "/ui/start/x", "/ui/restart/x", "/ui/instances/x/delete"];

function describeServer(path: string): string {
  const m = shellRoute("GET", path);
  if (!m) return "none";
  if (m.kind === "malformed") return "malformed";
  if (m.route.panel === "fleet") return `fleet:${m.route.tab}`;
  if (m.route.panel === "settings") return `settings:${m.route.section}`;
  if (m.route.panel === "needs") return "needs:";
  return `${m.route.panel}:${m.route.instance ?? ""}`;
}
function describeClient(path: string): string {
  const r = client.parseRoute(path) as { panel: string; instance?: string | null; tab?: string; section?: string } | null;
  if (!r) return "none";
  if (r.panel === "fleet") return `fleet:${r.tab}`;
  if (r.panel === "settings") return `settings:${r.section}`;
  if (r.panel === "needs") return "needs:";
  return `${r.panel}:${r.instance ?? ""}`;
}

describe("one classifier, the same on both sides", () => {
  it.each(CASES)("%s → %s (server)", (path, want) => { expect(describeServer(path)).toBe(want); });
  it.each(CASES)("%s → client agrees (a malformed path is a full load, which the server answers 400)", (path, want) => {
    expect(describeClient(path)).toBe(want === "malformed" ? "none" : want);
  });
  it("only GET and HEAD are navigations", () => {
    for (const m of ["POST", "PUT", "DELETE", "PATCH"]) expect(shellRoute(m, "/ui/chat/web-dev"), m).toBeNull();
    expect(shellRoute("HEAD", "/ui")?.kind).toBe("shell");
  });
  it("no shell path is a data route, and no data route is a shell path", () => {
    for (const p of DATA_ROUTES) expect(shellRoute("GET", p), p).toBeNull();
    for (const [p, want] of CASES) if (want !== "none" && want !== "malformed") expect(DATA_ROUTES).not.toContain(p);
    // Settings' data lives under /api/settings/, never under its pages' paths.
    for (const p of ["/api/settings/schema", "/api/settings/fleet/raw", "/api/settings/apply", "/api/settings/pending"]) expect(shellRoute("GET", p), p).toBeNull();
  });
  it("names: the client builds the same paths, and both sides hold names to the same rule", () => {
    for (const n of ["web-dev", "中文", "a b", "a?b#c", "100%"]) {
      expect(client.chatPath(n)).toBe(serverChatPath(n));
      expect(describeServer(serverChatPath(n))).toBe(`chat:${n}`);
    }
    for (const n of ["", ".", "..", "a/b", "a\\b", "a..b", "a\u0000b", "a\u007fb", "x".repeat(129)]) {
      expect(isSafeInstanceName(n), JSON.stringify(n)).toBe(false);
      expect(client.isSafeInstanceName(n), JSON.stringify(n)).toBe(false);
    }
  });
  it("the sign-in fallback covers every page of the app", () => {
    for (const p of ["/ui", "/ui/chat/web-dev", "/ui/fleet", "/ui/fleet/config", "/view", "/view/web-dev", "/settings", "/settings/general"]) expect(isWebPageNavigation(p), p).toBe(true);
    for (const p of [...DATA_ROUTES, "/ui/fleet/bogus", "/settings/bogus", "/api/fleet", "/api/settings/schema", "/signin"]) expect(isWebPageNavigation(p), p).toBe(false);
  });
  it("the public link's manifest admits exactly the shell's pages (and a malformed one, answered 400 behind it)", () => {
    for (const [p, want] of CASES) {
      if (want === "none") expect(isPublicWebRoute("GET", p), p).toBe(false);
      else expect(isPublicWebRoute("GET", p), p).toBe(true);
    }
    expect(isPublicWebRoute("POST", "/ui/chat/web-dev")).toBe(false);
  });
});

describe("old deep links: /ui#instance=<name>", () => {
  it("become /ui/chat/<name>, and only that exact form", () => {
    expect(client.legacyHashTarget("/ui", "#instance=web-dev")).toBe("/ui/chat/web-dev");
    expect(client.legacyHashTarget("/ui", "#instance=%E4%B8%AD")).toBe("/ui/chat/%E4%B8%AD");
    for (const h of ["#instance=../x", "#instance=a%2Fb", "#instance=", "#instance=a&token=x", "#next=//evil.example", "#x", ""]) {
      expect(client.legacyHashTarget("/ui", h), h).toBeNull();
    }
    expect(client.legacyHashTarget("/view", "#instance=web-dev")).toBeNull();
  });
});

// ── over real HTTP ──

const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); r.end();
  });
}
async function startListener() {
  const dir = mkdtempSync(join(tmpdir(), "agend-shell-1408-"));
  tempDirs.push(dir);
  const fm = new FleetManager(dir);
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
  vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
  (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
  (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as unknown as { healthServer: Server }).healthServer;
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const login = await new Promise<Res>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "POST", path: "/auth/login", headers: { "content-type": "application/json", origin } }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); r.end(JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const stop = async () => { await new Promise<void>(r => server.close(() => r())); (fm as unknown as { healthServer: Server | null }).healthServer = null; };
  return { fm, port, cookie, stop };
}
const maskNonce = (s: string) => s.replace(/nonce-[A-Za-z0-9+/=_-]+/g, "nonce-X").replace(/nonce="[^"]*"/g, 'nonce="X"');

describe("served: one page for every route", () => {
  it("signed in: the shell for every route; a known and an unknown name are byte-identical (nonce masked)", async () => {
    const h = await startListener();
    try {
      const known = await raw(h.port, "GET", "/ui/chat/web-dev", { cookie: h.cookie, accept: "text/html" });
      const unknown = await raw(h.port, "GET", "/ui/chat/nobody-here", { cookie: h.cookie, accept: "text/html" });
      expect(known.status).toBe(200);
      expect(String(known.headers["content-type"])).toContain("text/html");
      expect(known.body).toContain('<script type="module" src="/assets/app.js"></script>');
      expect(known.body).toMatch(/<body data-mode="full" /);
      expect(maskNonce(unknown.body)).toBe(maskNonce(known.body));
      expect(maskNonce(String(unknown.headers["content-security-policy"]))).toBe(maskNonce(String(known.headers["content-security-policy"])));
      for (const p of ["/ui", "/ui/fleet", "/ui/fleet/config", "/ui/chat/%E4%B8%AD", "/settings", "/settings/general", "/settings/advanced"]) {
        const r = await raw(h.port, "GET", p, { cookie: h.cookie, accept: "text/html" });
        expect(r.status, p).toBe(200);
        expect(maskNonce(r.body), p).toBe(maskNonce(known.body));
      }
      // The CSP is the panels' policy: nothing inline beyond this response's nonce, no 'unsafe-*'.
      const csp = String(known.headers["content-security-policy"]);
      expect(csp).toMatch(/script-src 'self' 'nonce-[^']+'/);
      expect(csp).toMatch(/style-src 'self' 'nonce-[^']+'/);
      expect(csp).not.toContain("unsafe");
    } finally { await h.stop(); }
  }, 30_000);

  it("a malformed name is a 400; an unknown fleet tab and /ui/chat alone are not pages", async () => {
    const h = await startListener();
    try {
      // (A whole-segment %2E%2E never reaches the router: URL parsing resolves it to /ui/, a 404. "a..b" does.)
      for (const p of ["/ui/chat/%E0%A4", "/ui/chat/a%2Fb", "/ui/chat/a%2E%2Eb"]) {
        const r = await raw(h.port, "GET", p, { cookie: h.cookie, accept: "text/html" });
        expect(r.status, p).toBe(400);
        expect(r.body, p).not.toContain("<html");
      }
      for (const p of ["/ui/fleet/bogus", "/ui/chat", "/settings/bogus", "/settings/general/x"]) {
        const r = await raw(h.port, "GET", p, { cookie: h.cookie, accept: "text/html" });
        expect(r.status, p).toBe(404);
        expect(r.body, p).not.toContain("<html");
      }
      // A Settings page is read, never written to: another method is refused (the gate's CSRF check, or the route's
      // own 405 behind it), and the page is not served.
      for (const m of ["POST", "PUT", "DELETE"]) {
        const r = await raw(h.port, m, "/settings/general", { cookie: h.cookie, accept: "text/html" });
        expect([403, 405], m).toContain(r.status);
        expect(r.body, m).not.toContain("<html");
      }
    } finally { await h.stop(); }
  }, 30_000);

  it("signed out, a browser navigation to any page gets the sign-in page; an API call still gets JSON", async () => {
    const h = await startListener();
    try {
      for (const p of ["/ui", "/ui/chat/web-dev", "/ui/chat/nobody", "/ui/fleet", "/ui/fleet/teams", "/settings", "/settings/bots"]) {
        const r = await raw(h.port, "GET", p, { accept: "text/html" });
        expect(r.status, p).toBe(401);
        expect(r.body, p).toContain('src="/assets/signin.js"');
      }
      const api = await raw(h.port, "GET", "/ui/tasks", { accept: "text/html" });
      expect(api.status).toBe(401);
      expect(() => JSON.parse(api.body)).not.toThrow();
    } finally { await h.stop(); }
  }, 30_000);

  it("#1306: every signed-in entry carries the same preview data and the same frame-src", async () => {
    const h = await startListener();
    vi.spyOn(h.fm as unknown as { previewForUi: (...a: unknown[]) => unknown }, "previewForUi").mockReturnValue({
      dashboardOrigin: `http://127.0.0.1:${h.port}`, previewOrigin: "http://127.0.0.1:4999", reason: null, boot: "b".repeat(16),
    });
    try {
      const bodies = new Set<string>(), csps = new Set<string>();
      for (const p of ["/ui", "/ui/chat/web-dev", "/ui/fleet/config", "/settings", "/settings/general"]) {
        const r = await raw(h.port, "GET", p, { cookie: h.cookie, accept: "text/html" });
        const tag = /<body[^>]*>/.exec(r.body)![0];
        expect(tag, p).toContain('data-preview-origin="http://127.0.0.1:4999"');
        expect(tag, p).toContain(`data-preview-boot="${"b".repeat(16)}"`);
        expect(tag, p).not.toContain("data-web-transport");
        bodies.add(tag); csps.add(maskNonce(String(r.headers["content-security-policy"])));
      }
      expect(bodies.size).toBe(1);
      expect(csps.size).toBe(1);
      expect([...csps][0]).toContain("frame-src http://127.0.0.1:4999/frame");
    } finally { await h.stop(); }
  }, 30_000);
});

describe("the public link (#1367)", () => {
  function gatewayGet(path: string) {
    const token = "c".repeat(48), exposureId = "a".repeat(32), pub = "https://sample.trycloudflare.com";
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "gateway", exposureId, label: "phone", tokenEpoch: tokenEpoch(token) });
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "sample.trycloudflare.com", cookie: `__Host-agend_session=${s.sessionId}`, accept: "text/html" }, socket: { destroy() {} } });
    bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0, body = ""; const headers: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), { headersSent: false, setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; }, writeHead(c: number) { status = c; }, end(t = "") { body = String(t); }, write() { return true; } });
    const previewForUi = vi.fn(() => ({ dashboardOrigin: pub, previewOrigin: "https://x.example", reason: null, boot: "b".repeat(16) }));
    handleWebRequest(req as never, res as never, new URL(path, pub), { webToken: token, webSessions: store, previewForUi, logger: { info() {}, debug() {}, error() {}, warn() {} } } as never);
    return { status: () => status, body: () => body, headers, previewForUi };
  }
  it("the shell polls (no stream on this link) and has no previews, on every entry", () => {
    for (const p of ["/ui", "/ui/chat/web-dev", "/ui/fleet/teams"]) {
      const r = gatewayGet(p);
      expect(r.status(), p).toBe(200);
      const tag = /<body[^>]*>/.exec(r.body())![0];
      expect(tag, p).toContain('data-web-transport="poll"');
      expect(tag, p).toContain('data-preview-origin=""');
      expect(r.headers["content-security-policy"], p).not.toContain("frame-src");
      expect(r.previewForUi, p).not.toHaveBeenCalled();
    }
  });
});
