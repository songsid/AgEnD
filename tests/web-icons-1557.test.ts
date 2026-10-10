import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { createPublicWebGateway, isPublicWebRoute } from "../src/public-web-gateway.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { WEB_CONTENT_SECURITY_POLICY } from "../src/web-host-guard.js";
import { isWebIconPath } from "../src/web-icons.js";

const BASE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const token = "favicon-fixture-token", exposure = "a".repeat(32), host = "icon-fixture.trycloudflare.com";
const iconTypes = {
  "/favicon.svg": "image/svg+xml",
  "/favicon.ico": "image/vnd.microsoft.icon",
  "/apple-touch-icon.png": "image/png",
};

function exchange(path: string, method = "GET", headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host: "localhost", ...headers } });
  const out: Record<string, string | number | readonly string[]> = {};
  let status = 0, body = Buffer.alloc(0);
  const res = {
    headersSent: false, destroyed: false,
    setHeader: (key: string, value: string) => { out[key.toLowerCase()] = value; },
    writeHead: (code: number, values: Record<string, string> = {}) => {
      status = code; for (const [key, value] of Object.entries(values)) out[key.toLowerCase()] = value;
    },
    end: (value?: string | Buffer) => { body = Buffer.from(value ?? ""); }, destroy: vi.fn(),
  };
  return { req: req as unknown as IncomingMessage, res: res as unknown as ServerResponse,
    headers: out, status: () => status, body: () => body, text: () => body.toString("utf8") };
}

/** Inert prototype only: no constructor, fleet, listener, adapter, token file, database or tmux. */
function dispatcher() {
  const sessions = new WebSessionStore();
  const fm = Object.create(FleetManager.prototype);
  Object.assign(fm, { fleetConfig: { defaults: {}, instances: {} }, webSessions: sessions,
    webLoginCodes: null, rejectedHostsLogged: new Set(), logger: { warn: vi.fn(), error: vi.fn() },
    settingsGate: () => ({ handle: () => false }) });
  Object.defineProperty(fm, "webToken", { value: token });
  const dispatch = (h: ReturnType<typeof exchange>) => fm.dispatchWebHttp(h.req, h.res, 19280);
  return { dispatch, sessions };
}

function publicDispatcher(d: ReturnType<typeof dispatcher>) {
  let callback!: (req: IncomingMessage, res: ServerResponse) => void;
  let current = true, open = true;
  const server = Object.assign(new EventEmitter(), {
    close: vi.fn(), closeAllConnections: vi.fn(), setTimeout: vi.fn(),
  });
  const gateway = createPublicWebGateway({ exposureId: exposure, isCurrent: () => current, isOpen: () => open,
    dispatch: (req, res) => d.dispatch({ req, res } as ReturnType<typeof exchange>),
    create: ((handler: typeof callback) => { callback = handler; return server; }) as never });
  gateway.setHost(host);
  return { dispatch: (h: ReturnType<typeof exchange>) => callback(h.req, h.res),
    closeExposure: () => { current = false; }, pending: () => { open = false; } };
}

/** #1589: the app shell narrows media to this listener's file route (`<origin>/ui/file/`), or to nothing ('none') on
 *  the public link and the view-only page; other pages carry no media-src. Nothing else in the policy changes. */
function assertLinks(h: ReturnType<typeof exchange>, media?: string) {
  expect(h.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(h.text()).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 64x64">');
  expect(h.text()).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">');
  expect(h.text()).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">');
  const csp = String(h.headers["content-security-policy"]).replace(/'nonce-[^']+'/g, "'nonce-fixture'");
  expect(csp).toBe(BASE_CSP.replace("script-src 'self'", "script-src 'self' 'nonce-fixture'")
    .replace("style-src 'self'", "style-src 'self' 'nonce-fixture'")
    .replace("img-src 'self' data: blob:", "img-src 'self' data: blob: https://cdn.discordapp.com/emojis/")
    + (media ? `; media-src ${media}` : ""));
}

afterEach(() => vi.restoreAllMocks());

describe("Silver Ag dashboard icons", () => {
  it.each(Object.entries(iconTypes))("serves %s publicly, with real bundled bytes and unchanged headers", (path, type) => {
    const d = dispatcher();
    for (const method of ["GET", "HEAD"]) {
      // Even an invalid credential must not turn this inert resource into an authentication error.
      const h = exchange(path + "?from=tab", method, { "x-agend-token": "wrong" }); d.dispatch(h);
      const file = readFileSync(new URL(`../src/ui/icons${path}`, import.meta.url));
      expect(h.status()).toBe(200); expect(h.headers["content-type"]).toBe(type);
      expect(h.headers["content-length"]).toBe(String(file.length));
      expect(h.body()).toEqual(method === "HEAD" ? Buffer.alloc(0) : file);
      expect(h.headers["content-security-policy"]).toBe(BASE_CSP);
      expect(h.headers["x-content-type-options"]).toBe("nosniff");
      expect(h.headers["x-frame-options"]).toBe("DENY");
      expect(h.headers["cache-control"]).toBe("no-store");
      expect(h.headers["set-cookie"]).toBeUndefined(); expect(d.sessions.size).toBe(0);
    }
  });

  it("keeps Host admission ahead of public branding and keeps other routes authenticated", () => {
    const d = dispatcher();
    for (const path of Object.keys(iconTypes)) {
      const foreign = exchange(path, "GET", { host: "attacker.invalid" }); d.dispatch(foreign);
      expect(foreign.status()).toBe(403); expect(foreign.text()).not.toContain("<svg");
      const write = exchange(path, "POST"); d.dispatch(write); expect(write.status()).toBe(405);
      expect(write.headers.allow).toBe("GET, HEAD");
    }
    for (const path of ["/favicon.svg/extra", "/apple-touch-icon.png/../web.token", "/icons/web.token", "/status", "/ui/backends"]) {
      const h = exchange(path); d.dispatch(h); expect(h.status()).toBe(401);
    }
  });

  it("admits only exact icon reads through the real public gateway and retains its host/lifetime gates", () => {
    const d = dispatcher(), g = publicDispatcher(d);
    for (const [path, type] of Object.entries(iconTypes)) {
      for (const method of ["GET", "HEAD"]) {
        const h = exchange(path, method, { host }); g.dispatch(h);
        expect(h.status()).toBe(200); expect(h.headers["content-type"]).toBe(type);
        expect(h.headers["content-security-policy"]).toBe(BASE_CSP);
        expect(h.headers["set-cookie"]).toBeUndefined();
      }
      const foreign = exchange(path); g.dispatch(foreign); expect(foreign.status()).toBe(403);
      for (const method of ["POST", "DELETE"]) expect(isPublicWebRoute(method, path)).toBe(false);
    }
    for (const path of ["/favicon.svg/extra", "/favicon.png", "/ui/icons/favicon.svg", "constructor", "__proto__"]) {
      expect(isWebIconPath(path)).toBe(false); expect(isPublicWebRoute("GET", path)).toBe(false);
      const h = exchange(path, "GET", { host }); g.dispatch(h); expect([400, 404]).toContain(h.status());
    }
    expect(d.sessions.size).toBe(0);
    g.pending(); const pending = exchange("/favicon.ico", "GET", { host }); g.dispatch(pending); expect(pending.status()).toBe(503);
    g.closeExposure(); const closed = exchange("/favicon.ico", "GET", { host }); g.dispatch(closed); expect(closed.status()).toBe(403);
  });

  it.each(["/signin", "/ui", "/ui/chat/worker", "/settings", "/settings/bots", "/view", "/view/worker"])("links all icons on local page %s without changing its CSP", path => {
    const d = dispatcher();
    const h = exchange(path, "GET", path === "/signin" || path.startsWith("/view") ? {} : { "x-agend-token": token });
    d.dispatch(h); expect(h.status()).toBe(200);
    assertLinks(h, path === "/signin" ? undefined : path.startsWith("/view") ? "'none'" : "http://localhost/ui/file/");
    if (path.startsWith("/view")) expect(h.text()).toContain('data-mode="view-only"');
  });

  it.each(["/signin", "/ui", "/ui/chat/worker", "/settings/bots", "/view", "/view/worker"])("links all icons on public page %s and keeps non-signed-in pages gated", path => {
    const d = dispatcher(), g = publicDispatcher(d);
    const session = d.sessions.create({ tier: "admin", surface: "gateway", exposureId: exposure, label: "fixture", tokenEpoch: tokenEpoch(token) });
    const h = exchange(path, "GET", { host, cookie: `__Host-agend_session=${session.sessionId}` });
    g.dispatch(h); expect(h.status()).toBe(200); assertLinks(h, path === "/signin" ? undefined : "'none'");
    if (path !== "/signin") expect(h.text()).toContain('data-web-transport="poll"');
    const anonymous = exchange(path, "GET", { host, accept: "text/html" }); g.dispatch(anonymous);
    expect(anonymous.status()).toBe(path === "/signin" ? 200 : 401); assertLinks(anonymous);
  });

  it("ships font-free SVG, exact raster dimensions and actual 16/32/64 ICO frames", () => {
    expect(WEB_CONTENT_SECURITY_POLICY).toBe(BASE_CSP);
    const icon = (file: string) => readFileSync(new URL(`../src/ui/icons/${file}`, import.meta.url));
    const svg = icon("favicon.svg").toString();
    expect(svg).toContain('viewBox="0 0 64 64"'); expect(svg).toContain('fill="#e5eaf0"');
    expect(svg).toContain('fill="#14273d"'); expect(svg.match(/<path\b/g)).toHaveLength(2);
    expect(svg).not.toMatch(/<text\b|font|<script\b|<foreignObject\b|\b(?:href|on\w+)\s*=/i);
    const png = icon("apple-touch-icon.png");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
    const ico = icon("favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 3]);
    for (const [index, size] of [16, 32, 64].entries()) {
      const entry = 6 + index * 16, bytes = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
      expect([ico[entry], ico[entry + 1]]).toEqual([size, size]);
      const frame = ico.subarray(offset, offset + bytes);
      expect(frame.subarray(0, 8)).toEqual(png.subarray(0, 8));
      expect([frame.readUInt32BE(16), frame.readUInt32BE(20)]).toEqual([size, size]);
    }
  });
});
