/**
 * #1306 segment A: the preview listener, the shim, the dashboard's frame-src, availability, and the server-set role.
 * Design: docs/design/1306-inline-html-preview.md §3, §4, §5, §6.1, §10.1 (items 1–4, 7 for the shim).
 * Real listeners on ephemeral ports in a scratch AGEND_HOME; no fleet started, no CLI, no tmux.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { FleetManager } from "../src/fleet-manager.js";
import {
  buildShim, createPreviewListener, dashboardOrigins, normalizeOrigin, PREVIEW_HTML_MAX_BYTES, previewAvailability,
  previewFrameCsp, previewOriginProblem, previewSettings, type PreviewSettings,
} from "../src/web-preview.js";
import { panelContentSecurityPolicy } from "../src/web-host-guard.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { WebChatHistory } from "../src/web-chat-history.js";

const tempDirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) s.close();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Res { status: number; headers: IncomingHttpHeaders; body: string }
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", (c: Buffer) => { text += c.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    r.on("error", reject); r.end();
  });
}
const SETTINGS: PreviewSettings = { enabled: true, port: 0, origin: null };
async function listen(settings: PreviewSettings = SETTINGS, config: object | null = null, bootId = "b".repeat(32)) {
  const l = createPreviewListener({ settings, healthPort: 19280, config, bootId });
  servers.push(l.server);
  await new Promise<void>(r => l.server.listen(0, "127.0.0.1", () => r()));
  return { l, port: (l.server.address() as { port: number }).port };
}

// ── 1. The preview listener ──

describe("the preview listener", () => {
  it("GET /frame is the shim with exactly the §5.1 headers — and no X-Frame-Options", async () => {
    const { l, port } = await listen();
    const r = await raw(port, "GET", "/frame", { host: `127.0.0.1:${port}` });
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toBe(previewFrameCsp(l.origins));
    expect(r.headers["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; " +
      "connect-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; manifest-src 'none'; object-src 'none'; " +
      "webrtc 'block'; frame-ancestors http://localhost:19280 http://127.0.0.1:19280 http://[::1]:19280; sandbox allow-scripts");
    expect(r.headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=()");
    expect([r.headers["referrer-policy"], r.headers["cross-origin-resource-policy"], r.headers["x-content-type-options"], r.headers["cache-control"]])
      .toEqual(["no-referrer", "same-origin", "nosniff", "no-store"]);
    expect(r.headers["x-frame-options"]).toBeUndefined();
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.body).toBe(buildShim(l.bootId, l.origins));
  });

  it.each([
    ["GET", "/"], ["GET", "/open"], ["GET", "/frame/"], ["GET", "/frame?x=1"], ["GET", "/frame?"], ["GET", "/frame#x"], ["GET", "/FRAME"],
    ["GET", "/ui"], ["GET", "/api/fleet"], ["GET", "/assets/shell.js"], ["GET", "//frame"],
    ["POST", "/frame"], ["HEAD", "/frame"], ["PUT", "/frame"], ["OPTIONS", "/frame"],
  ])("%s %s: an empty 404, never a redirect", async (method, path) => {
    const { port } = await listen();
    const r = await raw(port, method, path, { host: `127.0.0.1:${port}` });
    expect(r.status).toBe(404);
    expect(r.body).toBe("");
    expect(r.headers.location).toBeUndefined();
  });

  it("a Host it does not answer to gets an empty 403; the preview_origin's host is answered", async () => {
    const { port } = await listen({ ...SETTINGS, origin: "https://preview.example.net" });
    for (const host of ["evil.example", "dash.example", "", "127.0.0.2"]) {
      const r = await raw(port, "GET", "/frame", host ? { host } : { host: " " });
      expect([r.status, r.body], host).toEqual([403, ""]);
    }
    expect((await raw(port, "GET", "/frame", { host: "preview.example.net" })).status).toBe(200);
    expect((await raw(port, "GET", "/frame", { host: "localhost" })).status).toBe(200);
    expect((await raw(port, "GET", "/frame", { host: "[::1]:9" })).status).toBe(200);
  });

  it("the session cookie a same-host port receives changes nothing: byte-identical, and nothing is logged", async () => {
    const { port } = await listen();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
    const plain = await raw(port, "GET", "/frame", { host: `127.0.0.1:${port}` });
    const withCookie = await raw(port, "GET", "/frame", { host: `127.0.0.1:${port}`, cookie: "agend_session=sessionmarker; __Host-agend_session=sessionmarker", authorization: "Bearer x" });
    const strip = (h: IncomingHttpHeaders) => { const { date: _d, connection: _c, "keep-alive": _k, ...rest } = h; return rest; };
    expect(withCookie.body).toBe(plain.body);
    expect(strip(withCookie.headers)).toEqual(strip(plain.headers));
    expect(withCookie.body).not.toContain("sessionmarker");
    for (const l of logs) expect(l).not.toHaveBeenCalled();
  });

  it("the shim embeds the boot id and the exact dashboard origins — and nothing about any request", async () => {
    const { l, port } = await listen({ ...SETTINGS, origin: "https://preview.example.net" }, { hostname: "dash.lan", web: { allowed_hosts: ["fleet.example.net"] } }, "c".repeat(32));
    expect(l.origins).toEqual(["http://localhost:19280", "http://127.0.0.1:19280", "http://[::1]:19280", "https://dash.lan", "https://fleet.example.net"]);
    const body = (await raw(port, "GET", "/frame", { host: "preview.example.net" })).body;
    expect(body).toContain(`var BOOT = "${"c".repeat(32)}", ORIGINS = ${JSON.stringify(l.origins)}`);
    expect(body).not.toMatch(/location\b/);                         // the HTML never comes from (or goes into) a URL
  });
});

describe("the fleet runs it beside the web listener (scratch AGEND_HOME)", () => {
  async function startFleet(config: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "agend-1306-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, ...config };
    (fm as unknown as { initializeWebAuthTokens(): void }).initializeWebAuthTokens();
    (fm as unknown as { startHealthServer(port: number): void }).startHealthServer(0);
    const any = fm as unknown as { healthServer: Server; previewListener: { server: Server; bootId: string } | null; previewListening: boolean; stop(): Promise<void> };
    await vi.waitFor(() => expect(any.previewListening).toBe(true));
    const port = (any.healthServer.address() as { port: number }).port;
    const pport = (any.previewListener!.server.address() as { port: number; address: string });
    const origin = `http://127.0.0.1:${port}`;
    const login = await new Promise<Res>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, method: "POST", path: "/auth/login", headers: { "content-type": "application/json", origin } }, res => {
        let t = ""; res.on("data", (c: Buffer) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: t }));
      });
      r.on("error", reject); r.end(JSON.stringify({ code: fm.issueDashboardLogin()!.display }));
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    return { fm, any, port, pport, cookie, stop: () => { any.healthServer.close(); any.previewListener?.server.close(); } };
  }
  const directive = (csp: string, name: string) => csp.split(";").map(s => s.trim()).find(s => s.startsWith(name + " ")) ?? "";
  const bodyAttrs = (html: string) => Object.fromEntries([...(/<body([^>]*)>/.exec(html)![1]!).matchAll(/(data-[a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));

  it("binds 127.0.0.1; a loopback /ui load gets frame-src <same host>:<preview port>/frame and the page's data", async () => {
    const h = await startFleet();
    try {
      expect(h.pport.address).toBe("127.0.0.1");
      const r = await raw(h.port, "GET", "/ui", { host: `127.0.0.1:${h.port}`, cookie: h.cookie });
      expect(r.status).toBe(200);
      const csp = String(r.headers["content-security-policy"]);
      expect(directive(csp, "frame-src")).toBe(`frame-src http://127.0.0.1:${h.pport.port}/frame`);
      expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(bodyAttrs(r.body)).toEqual({
        "data-dashboard-origin": `http://127.0.0.1:${h.port}`, "data-preview-origin": `http://127.0.0.1:${h.pport.port}`,
        "data-preview-boot": h.any.previewListener!.bootId, "data-preview-reason": "",
      });
      const lh = await raw(h.port, "GET", "/ui", { host: `localhost:${h.port}`, cookie: h.cookie });
      expect(directive(String(lh.headers["content-security-policy"]), "frame-src")).toBe(`frame-src http://localhost:${h.pport.port}/frame`);
    } finally { h.stop(); }
  });

  it("a non-loopback Host without web.preview_origin: no frame-src, disabled with its reason — X-Forwarded-Host is never read", async () => {
    const h = await startFleet({ web: { allowed_hosts: ["fleet.example.net"] } });
    try {
      const r = await raw(h.port, "GET", "/ui", { host: "fleet.example.net", cookie: h.cookie, "x-forwarded-host": `127.0.0.1:${h.port}`, "x-forwarded-proto": "https" });
      const csp = String(r.headers["content-security-policy"]);
      expect(directive(csp, "frame-src")).toBe("");
      const a = bodyAttrs(r.body);
      expect([a["data-dashboard-origin"], a["data-preview-origin"], a["data-preview-boot"]]).toEqual(["https://fleet.example.net", "", ""]);
      expect(a["data-preview-reason"]).toMatch(/web\.preview_origin/);
    } finally { h.stop(); }
  });

  it("/view, /settings and sign-in never get a frame-src; every dashboard response keeps DENY and frame-ancestors 'none'", async () => {
    const h = await startFleet();
    try {
      for (const p of ["/view", "/settings", "/signin", "/ui"]) {
        const r = await raw(h.port, "GET", p, { host: `127.0.0.1:${h.port}`, cookie: h.cookie, accept: "text/html" });
        const csp = String(r.headers["content-security-policy"]);
        if (p !== "/ui") expect(directive(csp, "frame-src"), p).toBe("");
        expect(r.headers["x-frame-options"], p).toBe("DENY");
        expect(directive(csp, "frame-ancestors"), p).toBe("frame-ancestors 'none'");
      }
    } finally { h.stop(); }
  });

  it("web.preview: false — no listener, and /ui says previews are off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1306-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    (fm as unknown as { fleetConfig: unknown }).fleetConfig = { instances: {}, web: { preview: false } };
    const any = fm as unknown as { previewForUi(h: string, s: boolean): { previewOrigin: string | null; reason: string | null; boot: string | null } };
    expect(any.previewForUi("127.0.0.1:19280", false)).toMatchObject({ previewOrigin: null, boot: null, reason: expect.stringMatching(/web\.preview: false/) });
  });
});

// ── 2/3. Availability and the validator ──

describe("which preview origin a /ui load gets (§3.2)", () => {
  const s = (o: Partial<PreviewSettings> = {}): PreviewSettings => ({ enabled: true, port: 19281, origin: null, ...o });
  it("loopback: the same loopback name on the preview port", () => {
    expect(previewAvailability(s(), "127.0.0.1:19280", false)).toEqual({ dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", reason: null });
    expect(previewAvailability(s(), "localhost:19280", false).previewOrigin).toBe("http://localhost:19281");
    expect(previewAvailability(s(), "[::1]:19280", false).previewOrigin).toBe("http://[::1]:19281");
    expect(previewAvailability(s(), "LOCALHOST:19280", false).dashboardOrigin).toBe("http://localhost:19280");
  });
  it("not loopback and no preview_origin: disabled; with one: that origin", () => {
    expect(previewAvailability(s(), "fleet.example.net", true)).toMatchObject({ dashboardOrigin: "https://fleet.example.net", previewOrigin: null });
    expect(previewAvailability(s(), "192.168.1.5:19280", false).previewOrigin).toBeNull();
    expect(previewAvailability(s({ origin: "https://preview.example.net" }), "fleet.example.net", true).previewOrigin).toBe("https://preview.example.net");
    expect(previewAvailability(s({ origin: "https://preview.example.net" }), "127.0.0.1:19280", false).previewOrigin).toBe("https://preview.example.net");
  });
  it("an https dashboard never gets an http preview (mixed content); a default port is not part of the origin", () => {
    expect(previewAvailability(s(), "localhost:19280", true)).toMatchObject({ previewOrigin: null, reason: expect.stringMatching(/https/) });
    expect(previewAvailability(s({ origin: "http://preview.example.net" }), "fleet.example.net", true).previewOrigin).toBeNull();
    expect(previewAvailability(s(), "fleet.example.net:443", true).dashboardOrigin).toBe("https://fleet.example.net");
  });
  it("off, or no listener: disabled with a reason", () => {
    expect(previewAvailability(s({ enabled: false }), "127.0.0.1:19280", false).previewOrigin).toBeNull();
    expect(previewAvailability(null, "127.0.0.1:19280", false).previewOrigin).toBeNull();
  });
  it("settings: preview_port defaults to health_port + 1; an ephemeral web listener gets an ephemeral one", () => {
    expect(previewSettings(undefined, 19280)).toEqual({ enabled: true, port: 19281, origin: null });
    expect(previewSettings({ preview_port: 20000, preview_origin: "https://p.example.net/" }, 19280)).toEqual({ enabled: true, port: 20000, origin: "https://p.example.net" });
    expect(previewSettings({ preview: false }, 0)).toEqual({ enabled: false, port: 0, origin: null });
  });
  it("frame-ancestors: exact loopback origins on the dashboard port; https names only with a preview_origin; never 'self' or *", () => {
    expect(dashboardOrigins(s(), 19280, { hostname: "dash.lan" })).toEqual(["http://localhost:19280", "http://127.0.0.1:19280", "http://[::1]:19280"]);
    const csp = previewFrameCsp(dashboardOrigins(s({ origin: "https://p.example.net" }), 19280, { web: { allowed_hosts: ["fleet.example.net"] } }));
    expect(csp).toContain("frame-ancestors http://localhost:19280 http://127.0.0.1:19280 http://[::1]:19280 https://fleet.example.net;");
    expect(csp).not.toMatch(/'self'|\*/);
  });
});

describe("web.preview_origin is validated (§3.1)", () => {
  it.each([
    ["https://p.example.net/path", /bare/], ["https://p.example.net/?q=1", /bare/], ["https://p.example.net/#f", /bare/],
    ["https://user:pw@p.example.net", /bare/], ["https://*.example.net", /bare/], ["ftp://p.example.net", /bare/], ["p.example.net", /bare/],
    ["http://localhost:19281", /separate host/], ["https://127.0.0.1", /separate host/], ["https://dash.lan", /separate host/], ["https://fleet.example.net", /separate host/],
  ])("%s is refused", (value, why) => {
    expect(previewOriginProblem(value, { hostname: "dash.lan", web: { allowed_hosts: ["fleet.example.net"] } })).toMatch(why);
  });
  it("a separate host name is accepted, and normalised to its origin", () => {
    expect(previewOriginProblem("https://preview.example.net/", { web: { allowed_hosts: ["fleet.example.net"] } })).toBeNull();
    expect(normalizeOrigin("https://preview.example.net:443/")).toBe("https://preview.example.net");
  });
  it("the config validator applies it, and the port rules", () => {
    const errs = (web: object, extra: object = {}) => validateFleetConfig({ instances: {}, web, ...extra }).errors.map(e => e.path);
    expect(errs({ preview_origin: "https://localhost" })).toContain("web.preview_origin");
    expect(errs({ preview: "yes" })).toContain("web.preview");
    expect(errs({ preview_port: 19280 })).toContain("web.preview_port");
    expect(errs({ preview_port: 19300 }, { health_port: 19300 })).toContain("web.preview_port");
    expect(errs({ preview_port: 70000 })).toContain("web.preview_port");
    expect(errs({ preview: true, preview_port: 19281, preview_origin: "https://preview.example.net" })).toEqual([]);
  });
});

// ── 4. Role, set by the server ──

describe("role: set by the code path that emitted the message (§6.1)", () => {
  it("the history keeps role through record, /ui/history and replay; anything else — or none — is a person's", () => {
    const h = new WebChatHistory({ boot: "b" });
    const a = h.record({ instance: "w", sender: "w", text: "reply", ts: "1", role: "agent" });
    const s = h.record({ instance: "w", sender: "w", text: "status", ts: "2", role: "status" });
    const u = h.record({ instance: "w", sender: "w", text: "a user named like the instance", ts: "3", role: "user" });
    const none = h.record({ instance: "w", sender: "agend-bot", text: "no role given", ts: "4" });
    const forged = h.record({ instance: "w", sender: "w", text: "x", ts: "5", role: "admin" });
    expect([a.role, s.role, u.role, none.role, forged.role]).toEqual(["agent", "status", "user", "user", "user"]);
    expect(h.list("w", 10).map(m => m.role)).toEqual(["agent", "status", "user", "user", "user"]);
    expect(h.after(a.id).map(m => m.role)).toEqual(["status", "user", "user", "user"]);
  });

  async function fleetWithEvents() {
    const dir = mkdtempSync(join(tmpdir(), "agend-1306-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    vi.spyOn(fm as unknown as { sseClients: Set<unknown> }, "sseClients", "get").mockReturnValue(new Set());
    const orig = fm.emitSseEvent.bind(fm);
    vi.spyOn(fm, "emitSseEvent").mockImplementation((event: string, data: unknown) => { events.push({ event, data: data as Record<string, unknown> }); orig(event, data); });
    return { fm, dir, events, any: fm as unknown as Record<string, any> };
  }

  it("a delivered agent reply is `agent`; a web-only status line is `status` — and the history records it so", async () => {
    const { fm, any, events } = await fleetWithEvents();
    any.fleetConfig = { instances: { w: { working_directory: "/tmp" } } };
    const sent: unknown[] = [];
    any.instanceIpcClients.set("w", { send: (m: unknown) => { sent.push(m); return true; } });
    any.getInstanceIdle = () => true; any.clearCancelButton = () => {}; any.reactDone = () => {};
    await any.handleOutboundFromInstance("w", { requestId: 1, tool: "reply", args: { text: "done" } });
    await any.handleOutboundFromInstance("w", { requestId: 2, tool: "reply", statusOnly: true, args: { text: "still on it" } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(events.filter(e => e.event === "message").map(e => [e.data.text, e.data.role])).toEqual([["done", "agent"], ["still on it", "status"]]);
    expect(fm.webChatHistory.list("w", 10).map(m => [m.text, m.role])).toEqual([["done", "agent"], ["still on it", "status"]]);
  });

  it("a platform user's message is `user` — even one named like the instance or agend-*", async () => {
    const { any, events } = await fleetWithEvents();
    const adapter = { id: "discord", type: "discord", react: vi.fn().mockResolvedValue(undefined) };
    any.fleetConfig = { defaults: {}, channels: [{ id: "discord", type: "discord", mode: "topic", bot_token_env: "T", group_id: "g", access: { mode: "open" } }], instances: { w: { working_directory: "/tmp", topic_id: "t1" } } };
    any.adapter = adapter;
    any.worlds.set("discord", { id: "discord", adapter, channelConfig: any.fleetConfig.channels[0], groupId: "g" });
    any.routing.rebuild(any.fleetConfig);
    vi.spyOn(any.topicCommands, "handleInstanceCommand").mockResolvedValue(false);
    vi.spyOn(any.topicCommands, "handleGeneralCommand").mockResolvedValue(false);
    vi.spyOn(any, "sendCancelButton").mockResolvedValue(undefined);
    vi.spyOn(any, "deliverToInstance").mockResolvedValue(undefined);
    for (const [i, username] of ["alice", "w", "agend-bot"].entries()) {
      await any.handleInboundMessage({ source: "discord", adapterId: "discord", chatId: "g", threadId: "t1", messageId: `m${i}`, userId: `u${i}`, username, text: `<h1>${username}</h1>\n\`\`\`html\n<script>1</script>\n\`\`\``, timestamp: new Date() });
    }
    expect(events.filter(e => e.event === "message").map(e => [e.data.sender, e.data.role])).toEqual([["alice", "user"], ["w", "user"], ["agend-bot", "user"]]);
  });
});

// ── 7 (shim side). The shim, run as written ──

describe("the shim (§4.1)", () => {
  const ORIGINS = ["http://127.0.0.1:19280", "https://fleet.example.net"];
  function shim() {
    const html = buildShim("d".repeat(32), ORIGINS);
    const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
    const parent = { posted: [] as Array<[unknown, string]>, postMessage(m: unknown, t: string) { parent.posted.push([m, t]); } };
    const written: string[] = [];
    const doc = { open: vi.fn(), write: (s: string) => { written.push(s); }, close: vi.fn() };
    let onMessage: ((e: unknown) => void) | null = null;
    const win: Record<string, unknown> = {
      parent, document: doc, TextEncoder,
      RTCPeerConnection: function RTCPeerConnection() {}, webkitRTCPeerConnection: function W() {}, RTCDataChannel: function D() {}, RTCIceTransport: function I() {}, RTCSctpTransport: function S() {},
      addEventListener: (t: string, f: (e: unknown) => void) => { if (t === "message") onMessage = f; },
    };
    win.window = win;
    const c = vm.createContext(win);
    vm.runInContext(script, c);
    // postMessage structured-clones into the receiver's realm: so does this.
    const send = (data: unknown, opts: { source?: unknown; origin?: string } = {}) =>
      onMessage!({ source: "source" in opts ? opts.source : parent, origin: opts.origin ?? ORIGINS[0], data: vm.runInContext(`(${JSON.stringify(data)})`, c) });
    return { parent, written, doc, win, send };
  }
  const render = (html = "<p>hi</p>", ch = "0123456789abcdef") => ({ v: 1, type: "render", ch, html });

  it("posts ready with its boot id, addressed to * (the only way to reach an opaque parent's listener)", () => {
    const { parent } = shim();
    expect(parent.posted).toEqual([[{ v: 1, type: "ready", ch: null, boot: "d".repeat(32) }, "*"]]);
  });

  it.each([
    ["from another window", (s: ReturnType<typeof shim>) => s.send(render(), { source: {} })],
    ["from the opaque origin \"null\"", (s: ReturnType<typeof shim>) => s.send(render(), { origin: "null" })],
    ["from a non-listed origin", (s: ReturnType<typeof shim>) => s.send(render(), { origin: "http://127.0.0.1:19281" })],
    ["with an extra key", (s: ReturnType<typeof shim>) => s.send({ ...render(), extra: 1 })],
    ["with the wrong type", (s: ReturnType<typeof shim>) => s.send({ ...render(), type: "ready" })],
    ["with a bad ch", (s: ReturnType<typeof shim>) => s.send(render("<p>x</p>", "not-hex"))],
    ["as a string", (s: ReturnType<typeof shim>) => s.send(JSON.stringify(render()))],
    ["over 1 MiB of UTF-8", (s: ReturnType<typeof shim>) => s.send(render("é".repeat(PREVIEW_HTML_MAX_BYTES / 2 + 1)))],
  ])("refuses a render %s", (_why, act) => {
    const s = shim();
    act(s);
    expect(s.written).toEqual([]);
    expect(s.doc.open).not.toHaveBeenCalled();
  });

  it("takes exactly one render: removes the WebRTC entry points, then writes the prologue and the HTML; later ones are ignored", () => {
    const s = shim();
    s.send(render("<p>one</p>"));
    s.send(render("<p>two</p>"));
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toMatch(/^<script>\(function\(\)\{var ch="0123456789abcdef",p=window\.parent/);
    expect(s.written[0]!.endsWith("<\/script><p>one</p>")).toBe(true);
    for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport"]) expect(s.win[k], k).toBeUndefined();
    // The prologue reports heartbeat and height to the parent only, tagged with this frame's ch.
    expect(s.written[0]).toContain('{v:1,type:"heartbeat",ch:ch}');
    expect(s.written[0]).toContain('{v:1,type:"resize",ch:ch,height:h}');
  });

  it("1 MiB exactly is accepted", () => {
    const s = shim();
    s.send(render("a".repeat(PREVIEW_HTML_MAX_BYTES)));
    expect(s.written).toHaveLength(1);
  });
});

describe("the dashboard policy gains frame-src only when asked (§5.2)", () => {
  it("panelContentSecurityPolicy: none by default; exactly the given /frame when a preview origin was chosen", () => {
    expect(panelContentSecurityPolicy("n")).not.toContain("frame-src");
    expect(panelContentSecurityPolicy("n", { frameSrc: "http://127.0.0.1:19281/frame" })).toMatch(/; frame-src http:\/\/127\.0\.0\.1:19281\/frame$/);
  });
});

// ── #1327 review ──

describe("a config reload adopts preview changes, hot (#1327 review P2-1)", () => {
  async function fleetFromFile(yaml: string) {
    const dir = mkdtempSync(join(tmpdir(), "agend-1306r-")); tempDirs.push(dir);
    const { writeFileSync } = await import("node:fs");
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, yaml);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    vi.spyOn(fm, "notifyFleetError").mockImplementation(() => true);
    const any = fm as unknown as Record<string, any>;
    // A reconcile starts and stops instances — which would launch real CLIs in tmux. No instances here, and
    // anything that tries anyway fails the test instead.
    const refuse = (what: string) => async () => { throw new Error(`test must not ${what}`); };
    any.startInstance = refuse("start an instance"); any.stopInstance = refuse("stop an instance");
    any.loadConfig(path);
    // As start() records them: the baseline a reload is compared with, and the config this process runs on.
    any.appliedFleetLevel = any.fleetLevelSignature();
    any.startupFleetConfig = structuredClone(any.fleetConfig);
    any.initializeWebAuthTokens();
    any.startHealthServer(0);
    await vi.waitFor(() => expect(any.previewListening).toBe(true));
    servers.push(any.healthServer);
    const write = (y: string) => writeFileSync(path, y);
    const ui = () => any.previewForUi(`127.0.0.1:${(any.healthServer.address() as { port: number }).port}`, false);
    return { fm, any, write, ui };
  }
  const BASE = "instances: {}\n";

  it("web.preview: false through reconcile — the listener stops, /ui is offered nothing, and no restart is asked for", async () => {
    const h = await fleetFromFile(BASE);
    const before = h.ui();
    expect(before.previewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const oldServer = h.any.previewListener.server as Server;
    h.write(BASE + "web:\n  preview: false\n");
    const observed: string[] = [];
    await h.any.reconcileInstances((target: string, _k: string, state: string) => observed.push(`${target}:${state}`));
    expect(h.ui()).toMatchObject({ previewOrigin: null, boot: null, reason: expect.stringMatching(/web\.preview: false/) });
    expect(oldServer.listening).toBe(false);
    expect(observed.filter(o => o.includes("restart-required"))).toEqual([]);
    // …and back on: a new listener, a new boot id.
    h.write(BASE);
    await h.any.reconcileInstances();
    await vi.waitFor(() => expect(h.any.previewListening).toBe(true));
    expect(h.ui().boot).not.toBe(before.boot);
    expect(h.ui().previewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    h.any.previewListener?.close();
  });

  it("preview_port and preview_origin are startup-only: a reload reports restart-required and leaves the listener as it runs", async () => {
    const h = await fleetFromFile(BASE);
    const before = h.ui(), server = h.any.previewListener.server;
    for (const yaml of [BASE + "web:\n  preview_port: 47395\n", BASE + "web:\n  preview_origin: https://preview.example.net\n"]) {
      h.write(yaml);
      const observed: string[] = [];
      await h.any.reconcileInstances((target: string, _k: string, state: string) => observed.push(`${target}:${state}`));
      expect(observed.some(o => o.endsWith(":restart-required")), yaml).toBe(true);
      expect([h.ui().previewOrigin, h.ui().boot, h.any.previewListener.server], yaml).toEqual([before.previewOrigin, before.boot, server]);
    }
    // …and a hot off→on in the meantime still uses what this process started with, never the pending port/origin.
    h.write(BASE + "web:\n  preview: false\n  preview_origin: https://preview.example.net\n");
    await h.any.reconcileInstances();
    h.write(BASE + "web:\n  preview_origin: https://preview.example.net\n");
    await h.any.reconcileInstances();
    await vi.waitFor(() => expect(h.any.previewListening).toBe(true));
    expect(h.ui().previewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    h.any.previewListener?.close();
  });

  it("a change of dashboard names (web.allowed_hosts) is hot: rebuilt with the new allow-list", async () => {
    const h = await fleetFromFile(BASE);
    const boot = h.ui().boot;
    h.write(BASE + "web:\n  allowed_hosts: [fleet.example.net]\n");
    await h.any.reconcileInstances();
    await vi.waitFor(() => expect(h.any.previewListening).toBe(true));
    expect(h.ui().boot).not.toBe(boot);
    h.any.previewListener?.close();
  });

  it("an unrelated reload leaves the listener — and its boot id — alone", async () => {
    const h = await fleetFromFile(BASE);
    const boot = h.ui().boot, server = h.any.previewListener.server;
    h.write(BASE + "fleet_label: renamed\n");
    await h.any.reconcileInstances();
    expect([h.ui().boot, h.any.previewListener.server]).toEqual([boot, server]);
    h.any.previewListener?.close();
  });
});

describe("an optional listener never takes the fleet down (#1327 review P2-2)", () => {
  it("health_port 65535 and no preview_port: no default port — previews off, nothing thrown; the validator warns", () => {
    expect(previewSettings(undefined, 65535).port).toBeNull();
    expect(previewAvailability(previewSettings(undefined, 65535), "127.0.0.1:65535", false)).toMatchObject({ previewOrigin: null, reason: expect.stringMatching(/preview_port/) });
    const dir = mkdtempSync(join(tmpdir(), "agend-1306p-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const warns: unknown[] = [];
    fm.logger = { info() {}, warn: (o: unknown) => warns.push(o), error() {}, debug() {}, trace() {}, fatal() {}, child: () => fm.logger } as unknown as typeof fm.logger;
    const any = fm as unknown as Record<string, any>;
    any.fleetConfig = { instances: {} };
    expect(() => any.startPreviewListener(65535, 65535)).not.toThrow();
    expect([any.previewListener, any.previewListening, warns.length]).toEqual([null, false, 1]);
    const w = validateFleetConfig({ instances: {}, health_port: 65535 }).warnings.map(x => x.path);
    expect(w).toContain("web.preview_port");
    expect(validateFleetConfig({ instances: {}, health_port: 65535, web: { preview_port: 65534 } }).warnings.map(x => x.path)).not.toContain("web.preview_port");
  });

  it("a port Node refuses synchronously (ERR_SOCKET_BAD_PORT) is caught: previews off, the fleet goes on", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1306p-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const warns: unknown[] = [];
    fm.logger = { info() {}, warn: (o: unknown) => warns.push(o), error() {}, debug() {}, trace() {}, fatal() {}, child: () => fm.logger } as unknown as typeof fm.logger;
    const any = fm as unknown as Record<string, any>;
    any.fleetConfig = { instances: {}, web: { preview_port: 70000 } };
    expect(() => any.startPreviewListener(19280, 19280)).not.toThrow();
    expect([any.previewListener, any.previewListening]).toEqual([null, false]);
    expect(JSON.stringify(warns)).toMatch(/70000/);
  });
});

describe("the page's origin and the shim's allow-list are the same exact strings (#1327 review P3)", () => {
  it("a default port is not part of an origin; an allowed_hosts entry keeps its port", () => {
    expect(dashboardOrigins({ enabled: true, port: 81, origin: null }, 80, null)).toEqual(["http://localhost", "http://127.0.0.1", "http://[::1]"]);
    expect(dashboardOrigins({ enabled: true, port: 19281, origin: "https://p.example.net" }, 19280, { hostname: "dash.lan:9443", web: { allowed_hosts: ["fleet.example.net:8443", "other.example.net", "FLEET2.example.net:443"] } }))
      .toEqual(["http://localhost:19280", "http://127.0.0.1:19280", "http://[::1]:19280", "https://dash.lan:9443", "https://fleet.example.net:8443", "https://other.example.net", "https://fleet2.example.net"]);
  });
  it("availability offers a preview only when the page's origin is in that list — never by a wildcard", () => {
    const s: PreviewSettings = { enabled: true, port: 19281, origin: "https://p.example.net" };
    const list = dashboardOrigins(s, 19280, { web: { allowed_hosts: ["fleet.example.net:8443"] } });
    expect(previewAvailability(s, "fleet.example.net:8443", true, list).previewOrigin).toBe("https://p.example.net");
    expect(previewAvailability(s, "fleet.example.net", true, list)).toMatchObject({ dashboardOrigin: "https://fleet.example.net", previewOrigin: null, reason: expect.stringMatching(/with its port/) });
    expect(previewAvailability({ ...s, origin: null }, "127.0.0.1:80", false, dashboardOrigins({ ...s, origin: null }, 80, null)).dashboardOrigin).toBe("http://127.0.0.1");
    expect(previewAvailability({ ...s, origin: null }, "127.0.0.1:80", false, dashboardOrigins({ ...s, origin: null }, 80, null)).previewOrigin).toBe("http://127.0.0.1:19281");
  });
  it("through the real listener: an https proxy on :8443 gets the preview, and the shim takes HTML from exactly that origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1306o-")); tempDirs.push(dir);
    const fm = new FleetManager(dir);
    const quiet = () => {};
    fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as unknown as typeof fm.logger;
    const any = fm as unknown as Record<string, any>;
    any.fleetConfig = { instances: {}, web: { allowed_hosts: ["fleet.example.net:8443"], preview_origin: "https://preview.example.net" } };
    any.initializeWebAuthTokens(); any.startHealthServer(0);
    await vi.waitFor(() => expect(any.previewListening).toBe(true));
    servers.push(any.healthServer);
    const p = any.previewForUi("fleet.example.net:8443", true);
    expect([p.dashboardOrigin, p.previewOrigin]).toEqual(["https://fleet.example.net:8443", "https://preview.example.net"]);
    expect(any.previewListener.origins).toContain(p.dashboardOrigin);
    any.previewListener.close();
  });
});
