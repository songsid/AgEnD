/**
 * #1386 §6: the web side of "Needs you" — the list over the existing passive channels only (SSE `needs`, /ui/poll),
 * Acknowledge as a session write (CSRF) recorded by the session's public handle, the public link's manifest entry,
 * and no new GET or passive path. Real handlers, fake request/response, no server, no fleet.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest } from "../src/web-api.js";
import { isPassiveWebRead } from "../src/web-auth.js";

const token = "c".repeat(48), local = "http://127.0.0.1:19280", pub = "https://sample.trycloudflare.com", exposureId = "a".repeat(32);
const ITEMS = [{ id: "delivery:d1", type: "delivery", instance: "alpha", reason: "delivery_failed", detail: "", since: 1, deliveryId: "d1" }];

function request(path: string, method = "GET", headers: Record<string, string> = {}, host = "127.0.0.1:19280") {
  const req = Object.assign(new EventEmitter(), { method, url: path, headers: { host, ...headers } as Record<string, string>, destroy: vi.fn(), socket: { destroy: vi.fn() } });
  let status = 0, body = ""; const writes: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, headersSent: false, writableEnded: false,
    setHeader() {}, writeHead: (code: number) => { status = code; }, end: (text = "") => { body = text; },
    write: (chunk: string) => { writes.push(chunk); return true; }, destroy: vi.fn(),
  });
  return { req, res, writes, status: () => status, json: () => JSON.parse(body),
    feed: (value: unknown) => { req.emit("data", Buffer.from(JSON.stringify(value))); req.emit("end"); } };
}
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function ctx(store: WebSessionStore, over: Record<string, unknown> = {}) {
  return {
    webToken: token, webSessions: store, logger: { info() {}, debug() {}, error() {}, warn() {} },
    sseClients: new Set(), getUiStatus: () => ({ instances: [] }), listWebPrompts: () => [],
    needsYouItems: vi.fn(() => ITEMS),
    acknowledgeNeedsItem: vi.fn((_id: string, _p: string) => ({ status: 200, message: "Acknowledged." })),
    ...over,
  } as any;
}

describe("the list rides the existing passive channels only", () => {
  it("SSE: `needs` on connect, beside status and prompts", () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/events", "GET", { cookie: `agend_session=${s.sessionId}` });
    const c = ctx(store);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), c);
    const needs = h.writes.find(w => w.startsWith("event: needs\n"));
    expect(needs).toBeDefined();
    expect(JSON.parse(needs!.split("data: ")[1]!)).toEqual({ items: ITEMS });
    h.req.emit("close");
  });

  it("/ui/poll: a `needs` field", () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/poll?after=", "GET", { cookie: `agend_session=${s.sessionId}` });
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), ctx(store));
    expect(h.json().needs).toEqual(ITEMS);
  });

  it("no new GET route, and the passive allowlist is exactly what it was (#1374)", () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    for (const path of ["/ui/needs", "/ui/needs/ack", "/ui/needs/list"]) {
      const h = request(path, "GET", { cookie: `agend_session=${s.sessionId}` });
      handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), ctx(store));
      expect(h.status(), path).not.toBe(200);
    }
    const passive = ["/ui/poll", "/ui/events", "/api/pane/x", "/api/profiles", "/api/ai-usage"];
    for (const p of passive) expect(isPassiveWebRead("GET", p), p).toBe(true);
    for (const p of ["/ui/needs", "/ui/needs/ack"]) { expect(isPassiveWebRead("GET", p), p).toBe(false); expect(isPassiveWebRead("POST", p), p).toBe(false); }
  });
});

describe("POST /ui/needs/ack", () => {
  it("a signed-in session with CSRF: acknowledged, recorded as web:<the session's public handle>", async () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/needs/ack", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local, "x-agend-csrf": csrfTokenFor(s.sessionId) });
    const c = ctx(store);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), c);
    h.feed({ id: "delivery:d1" });
    await flush();
    expect(h.status()).toBe(200);
    expect(c.acknowledgeNeedsItem).toHaveBeenCalledWith("delivery:d1", `web:${s.record.handle}`);
    expect(String(c.acknowledgeNeedsItem.mock.calls[0][1])).not.toContain(s.sessionId);
  });

  it("without the CSRF value: refused, nothing acknowledged", async () => {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "local", label: "t", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/needs/ack", "POST", { cookie: `agend_session=${s.sessionId}`, origin: local });
    const c = ctx(store);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), c);
    h.feed({ id: "delivery:d1" });
    await flush();
    expect(h.status()).toBeGreaterThanOrEqual(400);
    expect(c.acknowledgeNeedsItem).not.toHaveBeenCalled();
  });

  it("the CLI's header token: recorded as cli", async () => {
    const store = new WebSessionStore();
    const h = request("/ui/needs/ack", "POST", { "x-agend-token": token });
    const c = ctx(store);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, local), c);
    h.feed({ id: "delivery:d1" });
    await flush();
    expect(c.acknowledgeNeedsItem).toHaveBeenCalledWith("delivery:d1", "cli");
  });
});

describe("the public link (#1367): exactly this route, under its own session and exposure", () => {
  it("the manifest has POST /ui/needs/ack and nothing more", () => {
    expect(isPublicWebRoute("POST", "/ui/needs/ack")).toBe(true);
    for (const [m, p] of [["GET", "/ui/needs/ack"], ["DELETE", "/ui/needs/ack"], ["POST", "/ui/needs/ack/x"], ["POST", "/ui/needs"], ["GET", "/ui/needs"]] as const) {
      expect(isPublicWebRoute(m, p), `${m} ${p}`).toBe(false);
    }
  });

  function gatewayAck(current: () => boolean, withCsrf = true) {
    const store = new WebSessionStore();
    const s = store.create({ tier: "admin", surface: "gateway", exposureId, label: "phone", tokenEpoch: tokenEpoch(token) });
    const h = request("/ui/needs/ack", "POST", { cookie: `__Host-agend_session=${s.sessionId}`, origin: pub, ...(withCsrf ? { "x-agend-csrf": csrfTokenFor(s.sessionId) } : {}) }, "sample.trycloudflare.com");
    bindGatewayRequest(h.req, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: current });
    const c = ctx(store);
    handleWebRequest(h.req as never, h.res as never, new URL(h.req.url, pub), c);
    return { h, c, s };
  }

  it("a gateway session with CSRF acknowledges (HTTPS users can act)", async () => {
    const { h, c, s } = gatewayAck(() => true);
    h.feed({ id: "delivery:d1" });
    await flush();
    expect(h.status()).toBe(200);
    expect(c.acknowledgeNeedsItem).toHaveBeenCalledWith("delivery:d1", `web:${s.record.handle}`);
  });

  it("without CSRF, or with the exposure closed while the body was in flight: nothing acknowledged", async () => {
    const a = gatewayAck(() => true, false);
    a.h.feed({ id: "delivery:d1" });
    await flush();
    expect(a.c.acknowledgeNeedsItem).not.toHaveBeenCalled();
    let open = true;
    const b = gatewayAck(() => open);
    open = false;
    b.h.feed({ id: "delivery:d1" });
    await flush();
    expect(b.c.acknowledgeNeedsItem).not.toHaveBeenCalled();
  });
});
