/**
 * #1723: HTML previews over the temporary public link — a second quick tunnel for the preview origin, owned by the
 * exposure, started beside it and never waited for. Design: #1723 issuecomment-6127793728.
 *
 * The real PublicWebLink (fake tunnels and clock, as public-web-link-1367), the real PublicPreview, the real preview
 * gateway on a loopback socket, the real app-shell route, FleetManager's real publicPreviewForUi over fakes, and the
 * real preview.js in a fresh VM realm. No cloudflared, no fleet, no network.
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import type { TunnelHandle } from "../src/tunnel/types.js";
import { createPublicPreviewGateway, PublicPreview, publicPreviewWanted, PUBLIC_PREVIEW_FRAME_SRC, type PublicPreviewGateway } from "../src/public-preview.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { handleWebRequest } from "../src/web-api.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { FleetManager } from "../src/fleet-manager.js";
import { createPreviewListener } from "../src/web-preview.js";
// @ts-expect-error — a browser module without types
import { pollPublicPreview, POLL_MS, POLL_MAX } from "../src/ui/preview-status.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); }, execFileSync: () => { throw Error("no CLI"); }, execSync: () => { throw Error("no CLI"); } }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const deferred = <T>() => { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T", binding: {} };
const DASH = "dash-host.trycloudflare.com", PREV = "prev-host.trycloudflare.com";
const tick = () => new Promise(r => setImmediate(r));

function handleFor(host: string, path: string) {
  let lost!: () => void;
  const handle: TunnelHandle = { provider: "fake", visibility: "public", baseUrl: `https://${host}`, pageUrl: `https://${host}${path}`, pid: 1, identity: "fake",
    stop: vi.fn(), onUnexpectedExit: cb => { lost = () => cb({ code: 1, signal: null }); return vi.fn(); } };
  return { handle, lose: () => lost() };
}

/** The link with its real preview; `previewStart` decides what the preview tunnel does. */
function rig(opts: { web?: Record<string, unknown>; previewStart?: () => Promise<any> } = {}) {
  let now = 0, permitted = true, web: any = opts.web ?? {};
  const order: string[] = [];
  const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:9999")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "m", server: {} };
  const dash = handleFor(DASH, "/signin");
  const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { order.push("link tunnel"); ctx.onCandidateHost?.(DASH); return { ok: true as const, handle: dash.handle }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const prev = handleFor(PREV, "/ready");
  const previewManager = {
    start: vi.fn(async (_p: unknown, ctx: any) => {
      order.push("preview tunnel");
      // A real provider ends its start when the exposure's signal aborts (closing waits for that, as for the link's own).
      if (opts.previewStart) return Promise.race([opts.previewStart(), new Promise((_y, no) => ctx.signal.addEventListener("abort", () => no(new Error("cancelled"))))]);
      ctx.onCandidateHost?.(PREV);
      return { ok: true as const, handle: prev.handle };
    }),
    stop: vi.fn(async () => ({ confirmed: true as const })),
  };
  const previewGateway: PublicPreviewGateway = { server: {} as never, readinessMarker: "pm", bootId: "f".repeat(32), listen: vi.fn(async () => new URL("http://127.0.0.1:9998")), setHost: vi.fn(), close: vi.fn() };
  const created: PublicPreview[] = [];
  // The fleet's ONE tunnel lane, as FleetManager has it: /dashboard and /login reserve the same one.
  const lane = new TunnelPurposeLane(manager);
  const link = new PublicWebLink({
    dataDir: "/fixture", web: () => web, permitted: () => permitted, reserve: id => lane.reserve("dashboard", id),
    createGateway: () => gateway as never, ensure: vi.fn(async () => ({ path: "/pinned", source: "agend" as const })), provider: () => ({ name: "fake" }) as never,
    revoke: vi.fn(), log: vi.fn(), now: () => now, wallNow: () => 100_000,
    createPreview: ({ id, expiresAt, dashboardOrigin, isCurrent }) => {
      if (!publicPreviewWanted(web)) return null;
      const p = new PublicPreview({ exposureId: id, expiresAt, dashboardOrigin, isCurrent, manager: previewManager, provider: () => ({ name: "fake" }) as never,
        createGateway: () => previewGateway });
      created.push(p);
      return p;
    },
  });
  return { link, lane, manager, previewManager, previewGateway, created, order, dashLose: dash.lose, previewLose: prev.lose,
    advance: (n: number) => { now += n; }, allow: (v: boolean) => { permitted = v; }, settings: (v: any) => { web = v; } };
}

describe("#1723: the preview tunnel opens and closes with its exposure", () => {
  it("opened beside the link (started before the link's own tunnel step), ready → its own origin and boot", async () => {
    const h = rig();
    expect(await h.link.deliver(owner, async () => true)).toBe(true);
    await tick();
    expect(h.order).toEqual(["preview tunnel", "link tunnel"]);
    expect(h.previewManager.start.mock.calls[0]![1].pagePath).toBe("/ready");
    expect(h.link.previewStatus(h.link.exposureId!)).toEqual({ state: "ready", origin: `https://${PREV}`, boot: "f".repeat(32) });
    expect(h.link.previewStatus("0".repeat(32)), "another exposure's page gets nothing").toBeNull();
    await h.link.close("end");
  });

  it.each([
    ["the admin's close", async (h: ReturnType<typeof rig>) => { await h.link.close("admin close"); }],
    ["the TTL", async (h: ReturnType<typeof rig>) => { h.advance(3 * 3_600_000); h.link.status(); await h.link.close("end"); }],
    ["a policy change (refresh)", async (h: ReturnType<typeof rig>) => { h.settings({ public_link: { allow_public: false } }); h.link.refresh(); await h.link.close("end"); }],
    ["the link's own tunnel exiting", async (h: ReturnType<typeof rig>) => { h.dashLose(); await tick(); await h.link.close("end"); }],
    ["a revoke / shutdown close", async (h: ReturnType<typeof rig>) => { await h.link.close("fleet shutdown"); }],
  ])("closed with it: %s → the preview's gateway is fenced and its tunnel stopped", async (_label, end) => {
    const h = rig();
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.previewManager.stop).not.toHaveBeenCalled();
    await end(h);
    expect(h.previewManager.stop).toHaveBeenCalledTimes(1);
    expect(h.previewGateway.close).toHaveBeenCalled();
    expect(h.previewGateway.setHost).toHaveBeenLastCalledWith(null);
  });

  it("no confirmed recipient: the link closes, and its preview with it", async () => {
    const h = rig();
    expect(await h.link.deliver(owner, async () => false)).toBe(false);
    expect(h.previewManager.stop).toHaveBeenCalledTimes(1);
  });

  it("an unconfirmed preview stop is an unconfirmed close of the exposure (the next start waits for it)", async () => {
    const h = rig();
    await h.link.deliver(owner, async () => true); await tick();
    h.previewManager.stop.mockResolvedValueOnce({ confirmed: false, reason: "still running", pid: 7, identity: null } as never);
    const result = await h.link.close("end");
    expect(result.confirmed).toBe(false);
    expect(h.link.status().state).toBe("cleanup_unconfirmed");
  });
});

describe("#1723: the preview tunnel never delays (or fails) the link", () => {
  it("a preview tunnel that never answers: the link is ready and delivered as without one", async () => {
    const never = deferred<any>();
    const h = rig({ previewStart: () => never.promise });
    const send = vi.fn(async () => true);
    expect(await h.link.deliver(owner, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.link.status().state).toBe("open");
    expect(h.link.previewStatus(h.link.exposureId!)).toEqual({ state: "starting" });
    await h.link.close("end");
  });

  it("a preview tunnel that throws: the link is ready and delivered; the preview is failed", async () => {
    const h = rig({ previewStart: async () => { throw new Error("boom"); } });
    expect(await h.link.deliver(owner, async () => true)).toBe(true);
    await tick();
    expect(h.link.status().state).toBe("open");
    expect(h.link.previewStatus(h.link.exposureId!)).toEqual({ state: "failed", reason: "unknown" });
    await h.link.close("end");
  });

  it("the link's ready point does not move with the preview: same delivery steps with a hung preview as with none", async () => {
    const steps = async (web: Record<string, unknown>, previewStart?: () => Promise<any>) => {
      const h = rig({ web, previewStart });
      const seen: string[] = [];
      await h.link.deliver(owner, async () => { seen.push("delivered"); return true; }, p => { seen.push(p.steps.map(s => s.step + (s.endedAt === undefined ? "…" : "")).join(",")); });
      await h.link.close("end");
      return seen;
    };
    const hung = deferred<any>();
    expect(await steps({}, () => hung.promise)).toEqual(await steps({ preview: false }));
  });
});

describe("#1723: a preview-tunnel failure leaves the link up and names the reason", () => {
  it("a start error: the link serves, the page is told why", async () => {
    const h = rig({ previewStart: async () => ({ ok: false, errorKind: "timeout", message: "no url", leaseHeld: false }) });
    expect(await h.link.deliver(owner, async () => true)).toBe(true);
    await tick();
    expect(h.link.status().state).toBe("open");
    expect(h.link.previewStatus(h.link.exposureId!)).toEqual({ state: "failed", reason: "no-address" });
    expect(h.manager.stop, "the link's own tunnel is untouched").not.toHaveBeenCalled();
    await h.link.close("end");
  });

  it("up, then its tunnel exits: failed (exited), fenced; the link is untouched", async () => {
    const h = rig();
    await h.link.deliver(owner, async () => true); await tick();
    h.previewLose();
    expect(h.link.previewStatus(h.link.exposureId!)).toEqual({ state: "failed", reason: "exited" });
    expect(h.previewGateway.setHost).toHaveBeenLastCalledWith(null);
    expect(h.link.status().state).toBe("open");
    expect(h.manager.stop).not.toHaveBeenCalled();
    await h.link.close("end");
  });
});

describe("#1723: no tunnel when previews are off for the public link", () => {
  it.each([
    [{ preview: false }, false], [{ preview_on_public_link: false }, false], [{ preview_origin: "https://preview.example.net" }, false],
    [{}, true], [{ preview: true, preview_on_public_link: true }, true], [{ preview_origin: "not an origin" }, true],
  ])("web %j → a preview tunnel: %s", async (web, wanted) => {
    expect(publicPreviewWanted(web)).toBe(wanted);
    const h = rig({ web });
    expect(await h.link.deliver(owner, async () => true)).toBe(true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(wanted ? 1 : 0);
    if (!wanted) expect(h.link.previewStatus(h.link.exposureId!)).toBeNull();
    await h.link.close("end");
  });
});

describe("#1723: the frame is never served from the dashboard host", () => {
  it("the public link's route manifest has no /frame (its gateway answers 404)", () => {
    for (const m of ["GET", "HEAD", "POST"]) expect(isPublicWebRoute(m, "/frame")).toBe(false);
    expect(isPublicWebRoute("GET", "/ui/preview-status")).toBe(true);
  });

  it("the preview gateway: only its own Host, only while current, ancestors exactly this exposure's dashboard", async () => {
    let current = true, dashOrigin: string | null = null;
    const g = createPublicPreviewGateway({ exposureId: "e".repeat(32), dashboardOrigin: () => dashOrigin, isCurrent: () => current, bootId: "a".repeat(32) });
    const origin = await g.listen();
    const get = (host: string, path: string) => new Promise<{ status: number; csp: string; body: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: Number(origin.port), path, method: "GET", headers: { host } }, res => {
        let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode!, csp: String(res.headers["content-security-policy"] ?? ""), body }));
      });
      r.on("error", reject); r.end();
    });
    try {
      expect((await get(PREV, "/frame")).status, "no Host pinned yet").toBe(403);
      g.setHost(PREV);
      expect((await get(PREV, "/ready")).body).toContain(g.readinessMarker);
      expect((await get(PREV, "/frame")).status, "no dashboard origin yet").toBe(503);
      dashOrigin = `https://${DASH}`;
      const ok = await get(PREV, "/frame");
      expect(ok.status).toBe(200);
      expect(ok.csp).toContain(`frame-ancestors https://${DASH};`);
      expect(ok.csp).toContain("connect-src 'none'");
      expect(ok.csp).toContain("sandbox allow-scripts");
      expect(ok.body).toContain(JSON.stringify([`https://${DASH}`]));
      for (const host of [DASH, "127.0.0.1", "localhost", "evil.trycloudflare.com"]) expect((await get(host, "/frame")).status, host).toBe(403);
      expect((await get(PREV, "/frame?x=1")).status).toBe(404);
      expect((await get(PREV, "/")).status).toBe(404);
      current = false;
      expect((await get(PREV, "/frame")).status, "the exposure closed").toBe(403);
      expect(() => g.setHost("example.com")).toThrow();
    } finally { g.close(); }
  });
});

describe("#1723: the page — the quick-tunnel wildcard only on public-link pages", () => {
  const token = "c".repeat(48), exposureId = "a".repeat(32), pub = `https://${DASH}`;
  function get(path: string, opts: { gateway: boolean; publicPreviewForUi?: (...a: any[]) => any; previewForUi?: (...a: any[]) => any }) {
    const store = new WebSessionStore();
    const s = opts.gateway
      ? store.create({ tier: "admin", surface: "gateway", exposureId, label: "phone", tokenEpoch: tokenEpoch(token) })
      : store.create({ tier: "admin", surface: "local", label: "desk", tokenEpoch: tokenEpoch(token) });
    const headers = opts.gateway ? { host: DASH, cookie: `__Host-agend_session=${s.sessionId}`, accept: "text/html" } : { host: "127.0.0.1:19280", cookie: `agend_session=${s.sessionId}`, accept: "text/html" };
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers, socket: { destroy() {} } });
    if (opts.gateway) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0, body = ""; const out: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), { headersSent: false, setHeader(k: string, v: string) { out[k.toLowerCase()] = v; }, writeHead(c: number, h?: Record<string, string>) { status = c; for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v; }, end(t = "") { body = String(t); }, write() { return true; } });
    handleWebRequest(req as never, res as never, new URL(path, opts.gateway ? pub : "http://127.0.0.1:19280"),
      { webToken: token, webSessions: store, previewForUi: opts.previewForUi, publicPreviewForUi: opts.publicPreviewForUi, logger: { info() {}, debug() {}, error() {}, warn() {} } } as never);
    return { status: () => status, body: () => body, headers: out };
  }
  const starting = { dashboardOrigin: pub, previewOrigin: null, reason: "Preview is starting…", code: "publicLinkStarting", boot: null, frameSrc: PUBLIC_PREVIEW_FRAME_SRC };
  const ready = { dashboardOrigin: pub, previewOrigin: `https://${PREV}`, reason: null, code: null, boot: "f".repeat(32), frameSrc: PUBLIC_PREVIEW_FRAME_SRC };

  it("a public-link page while its preview starts: the wildcard frame-src, 'starting', no origin yet", () => {
    const publicPreviewForUi = vi.fn(() => starting);
    const r = get("/ui/chat/web-dev", { gateway: true, publicPreviewForUi });
    expect(publicPreviewForUi).toHaveBeenCalledWith(exposureId, pub);
    expect(r.headers["content-security-policy"]).toContain(`frame-src ${PUBLIC_PREVIEW_FRAME_SRC}`);
    const tag = /<body[^>]*>/.exec(r.body())![0];
    expect(tag).toContain('data-preview-reason-code="publicLinkStarting"');
    expect(tag).toContain('data-preview-origin=""');
  });

  it("ready: the page names the preview origin and boot; the frame-src is still the wildcard", () => {
    const r = get("/ui/chat/web-dev", { gateway: true, publicPreviewForUi: () => ready });
    const tag = /<body[^>]*>/.exec(r.body())![0];
    expect(tag).toContain(`data-preview-origin="https://${PREV}"`);
    expect(tag).toContain(`data-dashboard-origin="${pub}"`);
    expect(r.headers["content-security-policy"]).toContain(`frame-src ${PUBLIC_PREVIEW_FRAME_SRC}`);
  });

  it("a local page never gets the wildcard: its exact preview origin, and only that", () => {
    const r = get("/ui/chat/web-dev", { gateway: false, previewForUi: () => ({ dashboardOrigin: "http://127.0.0.1:19280", previewOrigin: "http://127.0.0.1:19281", reason: null, code: null, boot: "b".repeat(32) }),
      publicPreviewForUi: () => ready });
    expect(r.status()).toBe(200);
    const csp = r.headers["content-security-policy"];
    expect(csp).toContain("frame-src http://127.0.0.1:19281/frame");
    expect(csp).not.toContain("trycloudflare");
  });

  it("/ui/preview-status: the public link page's own preview; a local page is not offered it", () => {
    const r = get("/ui/preview-status", { gateway: true, publicPreviewForUi: () => ready });
    expect(r.status()).toBe(200);
    expect(JSON.parse(r.body())).toEqual({ code: null, previewOrigin: `https://${PREV}`, boot: "f".repeat(32), detail: null });
    expect(get("/ui/preview-status", { gateway: false, publicPreviewForUi: () => ready }).status()).toBe(404);
  });
});

describe("#1723: FleetManager.publicPreviewForUi", () => {
  const pub = `https://${DASH}`;
  const fm = (web: Record<string, unknown>, status: unknown, listener?: { bootId: string }) => {
    const f: any = Object.create(FleetManager.prototype);
    f.fleetConfig = { web };
    f.publicWebLink = { previewStatus: vi.fn(() => status) };
    f.previewListening = !!listener; f.previewListener = listener ?? null;
    return f;
  };
  it.each([
    ["preview off everywhere", { preview: false }, { state: "ready", origin: `https://${PREV}`, boot: "f".repeat(32) }, { code: "fleetOff", previewOrigin: null, frameSrc: null }],
    ["off on the public link", { preview_on_public_link: false }, { state: "ready", origin: `https://${PREV}`, boot: "f".repeat(32) }, { code: "publicLink", previewOrigin: null, frameSrc: null }],
    ["no preview for this exposure", {}, null, { code: "publicLink", previewOrigin: null, frameSrc: null }],
    ["starting", {}, { state: "starting" }, { code: "publicLinkStarting", previewOrigin: null, frameSrc: PUBLIC_PREVIEW_FRAME_SRC }],
    ["failed", {}, { state: "failed", reason: "exited" }, { code: "publicLinkPreviewFailed", detail: "exited", previewOrigin: null, frameSrc: null }],
    ["ready", {}, { state: "ready", origin: `https://${PREV}`, boot: "f".repeat(32) }, { code: null, previewOrigin: `https://${PREV}`, boot: "f".repeat(32), frameSrc: PUBLIC_PREVIEW_FRAME_SRC }],
  ])("%s", (_label, web, status, want) => {
    expect(fm(web, status).publicPreviewForUi("e".repeat(32), pub)).toMatchObject({ dashboardOrigin: pub, ...want });
  });
  it("a configured web.preview_origin is used instead: exact frame-src, the local listener's boot; http is refused on https", () => {
    const listener = { bootId: "c".repeat(32) };
    expect(fm({ preview_origin: "https://preview.example.net" }, null, listener).publicPreviewForUi("e".repeat(32), pub))
      .toMatchObject({ code: null, previewOrigin: "https://preview.example.net", boot: "c".repeat(32), frameSrc: "https://preview.example.net/frame" });
    expect(fm({ preview_origin: "http://preview.example.net" }, null, listener).publicPreviewForUi("e".repeat(32), pub)).toMatchObject({ code: "needHttps", frameSrc: null });
  });
  it("with a configured web.preview_origin, the local listener's frame accepts the open link's dashboard while it is open", async () => {
    let open: string | null = null;
    const l = createPreviewListener({ settings: { enabled: true, port: 0, origin: "https://preview.example.net" }, healthPort: 19280, config: {}, bootId: "d".repeat(32), extraOrigins: () => (open ? [open] : []) });
    await new Promise<void>(r => l.server.listen(0, "127.0.0.1", r));
    const port = (l.server.address() as any).port;
    const csp = () => new Promise<string>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/frame", headers: { host: "preview.example.net" } }, res => { res.resume(); resolve(String(res.headers["content-security-policy"])); });
      r.on("error", reject); r.end();
    });
    try {
      expect(await csp()).not.toContain(DASH);
      open = `https://${DASH}`;
      expect(await csp()).toContain(`https://${DASH}`);
      open = null;
      expect(await csp(), "dropped once the link closes").not.toContain(DASH);
    } finally { l.close(); }
  });
});

describe("#1723: the page while the preview starts, and the device's opt-in", () => {
  /**
   * preview.js in a realm of its own (no fetch there at all: it reaches no network, #1306), and the page's poller
   * (preview-status.js) asking with the test's fetch and timers.
   */
  function client(opts: { optedIn: boolean; status: () => unknown }) {
    const timers: Array<() => void> = [];
    const store = new Map<string, string>(opts.optedIn ? [["agend_html_preview", "on"]] : []);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const fetchCalls: string[] = [];
    const sandbox: any = {
      location: { origin: `https://${DASH}` }, localStorage: storage, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout: () => { throw new Error("preview.js set a timer"); }, performance: { now: () => 0 }, addEventListener() {},
      module: { exports: {} as any },
    };
    vm.runInNewContext(readFileSync(join(process.cwd(), "src", "ui", "preview.js"), "utf8"), sandbox);
    const PV = sandbox.module.exports;
    const poll = () => pollPublicPreview(PV, {
      fetch: async (url: string) => { fetchCalls.push(url); return { ok: true, json: async () => opts.status() }; },
      setTimeout: (fn: () => void, ms: number) => { expect(ms).toBe(POLL_MS); timers.push(fn); },
    });
    return { PV, poll, fetchCalls, pending: () => timers.length,
      runTimers: async () => { const t = timers.splice(0); for (const fn of t) fn(); for (let i = 0; i < 5; i++) await tick(); } };
  }
  const startingBody = { dashboardOrigin: `https://${DASH}`, previewOrigin: "", previewBoot: "", previewReason: "Preview is starting…", previewReasonCode: "publicLinkStarting" };

  it("starting → it asks /ui/preview-status until up, then previews run (opted-in device)", async () => {
    let answer: unknown = { code: "publicLinkStarting", previewOrigin: null, boot: null, detail: null };
    const c = client({ optedIn: true, status: () => answer });
    c.PV.init(startingBody);
    c.poll();
    expect(c.PV.availability()).toMatchObject({ ok: false, why: "server" });
    await c.runTimers();
    expect(c.fetchCalls).toEqual(["/ui/preview-status"]);
    expect(c.PV.availability().ok).toBe(false);
    answer = { code: null, previewOrigin: `https://${PREV}`, boot: "f".repeat(32), detail: null };
    await c.runTimers();
    expect(c.PV.availability()).toEqual({ ok: true, why: "", reason: "" });
  });

  it("no opt-in → no run, even once the preview is up", async () => {
    const c = client({ optedIn: false, status: () => ({ code: null, previewOrigin: `https://${PREV}`, boot: "f".repeat(32), detail: null }) });
    c.PV.init(startingBody);
    c.poll();
    await c.runTimers();
    expect(c.PV.availability()).toMatchObject({ ok: false, why: "optin" });
  });

  it("only an https quick-tunnel origin other than the page's own is ever taken", async () => {
    for (const bad of ["https://evil.example.net", `https://${DASH}`, `http://${PREV}`, "javascript:alert(1)"]) {
      const c = client({ optedIn: true, status: () => ({ code: null, previewOrigin: bad, boot: "f".repeat(32), detail: null }) });
      c.PV.init(startingBody);
    c.poll();
      await c.runTimers();
      expect(c.PV.availability().ok, bad).toBe(false);
    }
  });

  it("failed → it stops asking and the page says why", async () => {
    const c = client({ optedIn: true, status: () => ({ code: "publicLinkPreviewFailed", previewOrigin: null, boot: null, detail: "exited" }) });
    c.PV.init(startingBody);
    c.poll();
    await c.runTimers();
    const a = c.PV.availability();
    expect(a).toMatchObject({ ok: false, why: "server" });
    expect(a.reason).toContain("its address closed unexpectedly");
    await c.runTimers();
    expect(c.fetchCalls).toHaveLength(1);
    expect(c.pending()).toBe(0);
  });

  it("not starting → nothing is asked; still starting → it asks at most POLL_MAX times", async () => {
    const idle = client({ optedIn: true, status: () => null });
    idle.PV.init({ ...startingBody, previewReasonCode: "publicLink" });
    idle.poll();
    expect(idle.pending()).toBe(0);
    const c = client({ optedIn: true, status: () => ({ code: "publicLinkStarting", previewOrigin: null, boot: null, detail: null }) });
    c.PV.init(startingBody);
    c.poll();
    for (let i = 0; i < POLL_MAX + 5 && c.pending(); i++) await c.runTimers();
    expect(c.fetchCalls).toHaveLength(POLL_MAX);
    expect(c.pending()).toBe(0);
  });

  it("an error answer keeps asking; stop() ends it", async () => {
    let fail = true;
    const c = client({ optedIn: true, status: () => { if (fail) throw new Error("offline"); return { code: "publicLinkStarting" }; } });
    c.PV.init(startingBody);
    const stop = c.poll();
    await c.runTimers();
    expect(c.pending()).toBe(1);
    fail = false; stop();
    await c.runTimers();
    expect(c.pending()).toBe(0);
    expect(c.fetchCalls).toHaveLength(1);
  });

  it("the page starts the poller once preview.js has the load's data (panel-chat boot)", () => {
    const src = readFileSync(join(process.cwd(), "src", "ui", "panel-chat.js"), "utf8");
    expect(src).toMatch(/import \{ pollPublicPreview \} from "\.\/preview-status\.js";/);
    const init = src.indexOf("P().init(bootData"), poll = src.indexOf("pollPublicPreview(P())");
    expect(init).toBeGreaterThan(0);
    expect(poll).toBeGreaterThan(init);
  });
});

// #1729 review (Prism): the exposure holds the one tunnel lane until BOTH of its tunnels are proven stopped.
describe("#1723: the tunnel lane is held until the link's AND the preview's stops are proven", () => {
  it("while the preview's stop is still running, /login cannot take the lane (the link's own stop already proven)", async () => {
    const h = rig(); await h.link.deliver(owner, async () => true); await tick();
    const stop = deferred<{ confirmed: true }>(); h.previewManager.stop.mockImplementationOnce(() => stop.promise);
    const closing = h.link.close("admin"); await tick();
    expect(h.manager.stop).toHaveBeenCalledTimes(1);
    const login = h.lane.reserve("login", "new-login");
    try { expect(login).toBeNull(); }
    finally { login?.releaseUnused(); stop.resolve({ confirmed: true }); await closing; }
    expect(h.lane.reserve("login", "new-login"), "proven: free again").not.toBeNull();
  });
  it("an unproven preview stop: cleanup_unconfirmed, and /login cannot take the lane", async () => {
    const h = rig(); await h.link.deliver(owner, async () => true); await tick();
    h.previewManager.stop.mockResolvedValueOnce({ confirmed: false, reason: "still running", pid: 7, identity: null } as never);
    expect(await h.link.close("end")).toMatchObject({ confirmed: false, pid: 7 });
    expect(h.link.status().state).toBe("cleanup_unconfirmed");
    expect(h.lane.reserve("login", "new-login")).toBeNull();
  });
  it("a rejected preview stop counts as unproven", async () => {
    const h = rig(); await h.link.deliver(owner, async () => true); await tick();
    h.previewManager.stop.mockRejectedValueOnce(new Error("boom"));
    expect((await h.link.close("end")).confirmed).toBe(false);
    expect(h.lane.reserve("login", "new-login")).toBeNull();
  });
  it("the lane itself: a companion stop that rejects is unproven (the lane stays held), and its own result comes first", async () => {
    const manager = { start: vi.fn(async () => ({ ok: true as const, handle: {} as never })), stop: vi.fn(async () => ({ confirmed: true as const })) };
    const lane = new TunnelPurposeLane(manager);
    const r = lane.reserve("dashboard", "A")!;
    await r.start({} as never, {} as never);
    expect(await r.stop("close", Promise.reject(new Error("preview stop failed")))).toMatchObject({ confirmed: false });
    expect(lane.reserve("login", "B")).toBeNull();
    const lane2 = new TunnelPurposeLane({ ...manager, stop: vi.fn(async () => ({ confirmed: false as const, reason: "own", pid: 3, identity: null })) });
    const r2 = lane2.reserve("dashboard", "A")!;
    await r2.start({} as never, {} as never);
    expect(await r2.stop("close", Promise.resolve({ confirmed: false as const, reason: "other", pid: 4, identity: null }))).toMatchObject({ pid: 3 });
  });
  it("control: both proven → /login can take the lane", async () => {
    const h = rig(); await h.link.deliver(owner, async () => true); await tick();
    expect((await h.link.close("end")).confirmed).toBe(true);
    expect(h.lane.reserve("login", "new-login")).not.toBeNull();
  });
  it("control: an unproven link stop holds the lane, whatever the preview's", async () => {
    const h = rig(); await h.link.deliver(owner, async () => true); await tick();
    h.manager.stop.mockResolvedValueOnce({ confirmed: false, reason: "still running", pid: 8, identity: null } as never);
    expect(await h.link.close("end")).toMatchObject({ confirmed: false, pid: 8 });
    expect(h.lane.reserve("login", "new-login")).toBeNull();
  });
  it("without a preview (web.preview: false) the lane works as before", async () => {
    const h = rig({ web: { preview: false } }); await h.link.deliver(owner, async () => true); await tick();
    expect((await h.link.close("end")).confirmed).toBe(true);
    expect(h.lane.reserve("login", "new-login")).not.toBeNull();
  });
});

// #1729 review (Prism): the page's automatic status GET is not the person's activity.
describe("#1723: /ui/preview-status never slides the session", () => {
  it("the GET is passive; nothing else on that path is", () => {
    expect(isPassiveWebRead("GET", "/ui/preview-status")).toBe(true);
    expect(isPassiveWebRead("POST", "/ui/preview-status")).toBe(false);
  });
  it.each([["/ui/preview-status", true], ["/ui/poll", true], ["/ui/chat/one", false]])("a real public session: %s (passive %s)", (path, passive) => {
    let now = 1000; const token = "c".repeat(48), exposureId = "a".repeat(32), pub = `https://${DASH}`;
    const sessions = new WebSessionStore({ now: () => now });
    const s = sessions.create({ tier: "admin", surface: "gateway", exposureId, label: "phone", tokenEpoch: tokenEpoch(token) });
    const before = { ...s.record }; now += 120_000;
    const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: DASH, cookie: `__Host-agend_session=${s.sessionId}` }, socket: { destroy() {} } });
    bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
    let status = 0; const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead(c: number) { status = c; }, end() {}, write() { return true; } });
    handleWebRequest(req as never, res as never, new URL(path, pub), { webToken: token, webSessions: sessions,
      getUiStatus: () => ({ instances: [] }), publicPreviewForUi: () => ({ dashboardOrigin: pub, previewOrigin: null, reason: "starting", code: "publicLinkStarting", boot: null, frameSrc: PUBLIC_PREVIEW_FRAME_SRC }),
      logger: { info() {}, debug() {}, error() {}, warn() {} } } as never);
    expect(status).toBe(200);
    const after = sessions.list()[0]!;
    expect([after.lastSeen, after.idleExpiry]).toEqual(passive ? [before.lastSeen, before.idleExpiry] : [now, before.idleExpiry + 120_000]);
  });
});
