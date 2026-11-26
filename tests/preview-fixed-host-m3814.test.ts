/**
 * M-3814 (the user, 2026-11-26): over a fixed public link, HTML previews failed with Cloudflare's limit on new temporary
 * links (429) — each link opened a quick tunnel for its previews. `web.public_link.preview_hostname` is a second
 * published route on the same named tunnel, to the preview port: the fixed link's pages frame `https://<it>/frame`, and
 * no quick tunnel is started. Without it, today's quick-tunnel preview stays.
 *
 * The real PublicWebLink (named mode, fake tunnels), the real PublicPreview wiring, the real preview listener on a
 * loopback socket, FleetManager's real publicPreviewForUi / testPreviewRoute over fakes, the real validator and the
 * real check (fake DNS and fetch). No cloudflared, no fleet, no network.
 */
import { syntheticTunnelToken } from "./helpers/named-tunnel-token.js";
import { createServer, request, type Server } from "node:http";
import { handleSettingsRequest } from "../src/settings-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicWebLink, publicLinkModeProblem, publicLinkPatchShape, publicLinkPreviewHostname } from "../src/public-web-link.js";
import { PUBLIC_TUNNEL_TOKEN_ENV } from "../src/public-tunnel-config.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import type { TunnelHandle } from "../src/tunnel/types.js";
import { PublicPreview, publicPreviewWanted, PUBLIC_PREVIEW_FRAME_SRC } from "../src/public-preview.js";
import { FleetManager } from "../src/fleet-manager.js";
import { createPreviewListener } from "../src/web-preview.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { runPreviewRouteTest } from "../src/tunnel/named-link-test.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); }, execFileSync: () => { throw Error("no CLI"); }, execSync: () => { throw Error("no CLI"); } }));

const DASH = "agend.example.net", PREV = "preview.example.net";
const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T", binding: {} };
const tick = () => new Promise(r => setImmediate(r));
const savedToken = process.env[PUBLIC_TUNNEL_TOKEN_ENV];
beforeEach(() => { process.env[PUBLIC_TUNNEL_TOKEN_ENV] = syntheticTunnelToken(); });
afterEach(() => {
  if (savedToken === undefined) delete process.env[PUBLIC_TUNNEL_TOKEN_ENV]; else process.env[PUBLIC_TUNNEL_TOKEN_ENV] = savedToken;
  vi.restoreAllMocks();
});

describe("M-3814: web.public_link.preview_hostname — only beside a fixed hostname, never its name", () => {
  it("the address in force: a valid name beside a fixed hostname, and not that hostname", () => {
    expect(publicLinkPreviewHostname({ public_link: { hostname: DASH, preview_hostname: PREV } })).toBe(PREV);
    expect(publicLinkPreviewHostname({ public_link: { hostname: DASH, preview_hostname: `https://${PREV}/` } }), "an HTTPS root URL is read as its host").toBe(PREV);
    expect(publicLinkPreviewHostname({ public_link: { preview_hostname: PREV } }), "no fixed hostname: a quick link").toBeNull();
    expect(publicLinkPreviewHostname({ public_link: { hostname: DASH, preview_hostname: DASH } })).toBeNull();
    expect(publicLinkPreviewHostname({ public_link: { hostname: DASH, preview_hostname: "" } })).toBeNull();
    expect(publicLinkPreviewHostname({ public_link: { hostname: DASH } })).toBeNull();
  });
  it("Settings' patch shape and the mode's rules", () => {
    expect(publicLinkPatchShape({ preview_hostname: PREV })).toBe(true);
    expect(publicLinkPatchShape({ preview_hostname: "" })).toBe(true);
    expect(publicLinkPatchShape({ preview_hostname: "not a host/with path" })).toBe(false);
    expect(publicLinkPatchShape({ preview_hostname: 7 })).toBe(false);
    expect(publicLinkModeProblem({ preview_hostname: PREV })).toMatchObject({ key: "preview_hostname" });
    expect(publicLinkModeProblem({ hostname: DASH, preview_hostname: DASH })).toMatchObject({ key: "preview_hostname" });
    expect(publicLinkModeProblem({ hostname: DASH, preview_hostname: PREV })).toBeNull();
  });
  it("the validator: refused without a fixed hostname, on the same name, or on a name the dashboard answers to", () => {
    const errs = (public_link: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      validateFleetConfig({ web: { public_link, ...extra } }).errors.filter(e => e.path.startsWith("web.public_link")).map(e => e.path);
    expect(errs({ hostname: DASH, preview_hostname: PREV })).toEqual([]);
    expect(errs({ preview_hostname: PREV })).toEqual(["web.public_link.preview_hostname"]);
    expect(errs({ hostname: DASH, preview_hostname: DASH })).toEqual(["web.public_link.preview_hostname"]);
    expect(errs({ hostname: DASH, preview_hostname: PREV }, { allowed_hosts: [PREV] }), "a name the dashboard answers to").toEqual(["web.public_link.preview_hostname"]);
  });
});

function handleFor(host: string, path: string): TunnelHandle {
  return { provider: "fake", visibility: "public", baseUrl: `https://${host}`, pageUrl: `https://${host}${path}`, pid: 1, identity: "fake", stop: vi.fn(), onUnexpectedExit: () => vi.fn() };
}

/** A fixed (named) link with its real preview wiring; `web` decides the preview. */
function namedRig(web: any, start?: () => Promise<any>) {
  const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:9999")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "m", server: {} };
  const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { if (start) return start(); ctx.onCandidateHost?.(DASH); return { ok: true as const, handle: handleFor(DASH, "/signin") }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const previewManager = { start: vi.fn(async () => ({ ok: true as const, handle: handleFor("prev-host.trycloudflare.com", "/ready") })), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager);
  let current = web;
  const link = new PublicWebLink({
    dataDir: "/fixture", web: () => current, permitted: () => true, reserve: id => lane.reserve("dashboard", id),
    createGateway: () => gateway as never, ensure: vi.fn(async () => ({ path: "/pinned", source: "agend" as const })), provider: () => ({ name: "fake" }) as never,
    revoke: vi.fn(), log: vi.fn(), now: () => 0, wallNow: () => 100_000,
    // As FleetManager's: a preview tunnel only when publicPreviewWanted says so.
    createPreview: ({ id, expiresAt, dashboardOrigin, isCurrent }) => {
      if (!publicPreviewWanted(current)) return null;
      return new PublicPreview({ exposureId: id, expiresAt, dashboardOrigin, isCurrent, manager: previewManager, provider: () => ({ name: "fake" }) as never,
        createGateway: () => ({ server: {} as never, readinessMarker: "pm", bootId: "f".repeat(32), listen: vi.fn(async () => new URL("http://127.0.0.1:9998")), setHost: vi.fn(), close: vi.fn() }) });
    },
  });
  return { link, previewManager, settings: (v: any) => { current = v; } };
}

describe("M-3814: a fixed link with a preview address starts no quick tunnel", () => {
  it("named + preview_hostname: no preview tunnel; the open link's fixed preview address is the configured one, and none once closed", async () => {
    const h = namedRig({ public_link: { hostname: DASH, preview_hostname: PREV } });
    expect(await h.link.deliver(owner, async () => true)).toBe(true); await tick();
    expect(h.previewManager.start).not.toHaveBeenCalled();
    const id = h.link.exposureId!;
    expect(h.link.fixedPreviewHost()).toBe(PREV);
    expect(h.link.fixedPreviewHost(id)).toBe(PREV);
    expect(h.link.fixedPreviewHost("0".repeat(32)), "another exposure's page").toBeNull();
    await h.link.close("end");
    expect(h.link.fixedPreviewHost()).toBeNull();
  });
  it("not while the fixed link is still starting: no address until it is open", async () => {
    let release!: (v: unknown) => void;
    const h = namedRig({ public_link: { hostname: DASH, preview_hostname: PREV } }, () => new Promise(r => { release = r; }));
    const delivered = h.link.deliver(owner, async () => true);
    await tick(); await tick();
    expect(h.link.status().state).toBe("starting");
    expect(h.link.fixedPreviewHost()).toBeNull();
    release({ ok: true, handle: handleFor(DASH, "/signin") });
    await delivered; await tick();
    await h.link.close("end");
  });
  it("control: named without a preview address keeps today's quick-tunnel preview (and no fixed address)", async () => {
    const h = namedRig({ public_link: { hostname: DASH } });
    expect(await h.link.deliver(owner, async () => true)).toBe(true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(1);
    expect(h.link.fixedPreviewHost()).toBeNull();
    await h.link.close("end");
  });
  it.each([
    [{ public_link: { hostname: DASH, preview_hostname: PREV } }, false],
    [{ public_link: { hostname: DASH } }, true],
    [{ public_link: { preview_hostname: PREV } }, true],                       // no fixed hostname: ignored (the validator refuses it)
    [{ public_link: { hostname: DASH, preview_hostname: PREV }, preview_on_public_link: false }, false],
  ])("publicPreviewWanted(%j) → %s", (web, wanted) => { expect(publicPreviewWanted(web as never)).toBe(wanted); });
});

describe("M-3814: FleetManager.publicPreviewForUi with a fixed preview address", () => {
  const pub = `https://${DASH}`;
  const fm = (web: Record<string, unknown>, fixed: string | null, listener?: { bootId: string }) => {
    const f: any = Object.create(FleetManager.prototype);
    f.fleetConfig = { web };
    f.publicWebLink = { previewStatus: vi.fn(() => ({ state: "failed", reason: "rate-limited" })), fixedPreviewHost: vi.fn((id?: string) => (id === "e".repeat(32) ? fixed : null)) };
    f.previewListening = !!listener; f.previewListener = listener ?? null;
    return f;
  };
  it("the fixed address: exact frame-src, the local listener's boot (never the quick-tunnel wildcard)", () => {
    expect(fm({}, PREV, { bootId: "c".repeat(32) }).publicPreviewForUi("e".repeat(32), pub))
      .toMatchObject({ code: null, previewOrigin: `https://${PREV}`, boot: "c".repeat(32), frameSrc: `https://${PREV}/frame` });
  });
  it("no listener: why (not a quick tunnel)", () => {
    expect(fm({}, PREV).publicPreviewForUi("e".repeat(32), pub)).toMatchObject({ code: "notListening", previewOrigin: null, frameSrc: null });
  });
  it("another exposure's page, or no fixed address: the quick tunnel's status as before", () => {
    const r = fm({}, null, { bootId: "c".repeat(32) }).publicPreviewForUi("e".repeat(32), pub);
    expect(r).toMatchObject({ code: "publicLinkPreviewFailed", detail: "rate-limited" });
    expect(r.frameSrc).not.toBe(PUBLIC_PREVIEW_FRAME_SRC);
  });
  it("previews off: off, whatever the address", () => {
    expect(fm({ preview: false }, PREV, { bootId: "c".repeat(32) }).publicPreviewForUi("e".repeat(32), pub)).toMatchObject({ code: "fleetOff" });
    expect(fm({ preview_on_public_link: false }, PREV, { bootId: "c".repeat(32) }).publicPreviewForUi("e".repeat(32), pub)).toMatchObject({ code: "publicLink" });
  });
});

describe("M-3814: the preview listener answers the fixed address only while the fixed link is open", () => {
  it("Host and frame-ancestors follow the open link; closed → refused again", async () => {
    let open = false;
    const l = createPreviewListener({ settings: { enabled: true, port: 0, origin: null }, healthPort: 19280, config: {}, bootId: "d".repeat(32),
      extraOrigins: () => (open ? [`https://${DASH}`] : []), extraHosts: () => (open ? [PREV] : []) });
    await new Promise<void>(r => l.server.listen(0, "127.0.0.1", r));
    const port = (l.server.address() as any).port;
    const get = (host: string) => new Promise<{ status: number; csp: string; body: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/frame", headers: { host } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", c => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode!, csp: String(res.headers["content-security-policy"] ?? ""), body }));
      });
      r.on("error", reject); r.end();
    });
    try {
      expect((await get(PREV)).status, "closed: not a name it answers to").toBe(403);
      open = true;
      const r = await get(PREV);
      expect(r.status).toBe(200);
      expect(r.csp).toContain(`frame-ancestors`);
      expect(r.csp).toContain(`https://${DASH}`);
      expect(r.body).toContain(JSON.stringify("d".repeat(32)));
      expect((await get("other.example.net")).status, "only that name").toBe(403);
      open = false;
      expect((await get(PREV)).status, "closed again").toBe(403);
      expect((await get(`127.0.0.1:${port}`)).status, "control: loopback as before").toBe(200);
    } finally { l.close(); }
  });
  it("FleetManager wires it: the real listener answers the address (and frames the dashboard) only while the fixed link is open", async () => {
    const f: any = Object.create(FleetManager.prototype);
    let fixed: string | null = null;
    f.fleetConfig = { web: {} }; f.startupFleetConfig = null; f.logger = { warn() {}, info() {} };
    f.publicWebLink = { fixedPreviewHost: () => fixed, openDashboardOrigin: () => (fixed ? `https://${DASH}` : null) };
    f.startPreviewListener(0, 0);
    await new Promise(r => setTimeout(r, 50));
    const port = (f.previewListener.server.address() as any).port;
    const get = () => new Promise<{ status: number; csp: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/frame", headers: { host: PREV } }, res => { res.resume(); resolve({ status: res.statusCode!, csp: String(res.headers["content-security-policy"] ?? "") }); });
      r.on("error", reject); r.end();
    });
    try {
      expect((await get()).status).toBe(403);
      fixed = PREV;
      const r = await get();
      expect(r.status).toBe(200);
      expect(r.csp).toContain(`https://${DASH}`);
      fixed = null;
      expect((await get()).status).toBe(403);
    } finally { f.stopPreviewListener(); }
  });
});

describe("M-3814: Check — the saved address, through the open fixed link, to this AgEnD's previews", () => {
  const boot = "b".repeat(32);
  const deps = (fetchPage: (u: string) => Promise<{ status: number; body: string }>, resolve4: (h: string) => Promise<string[]> = async () => ["104.16.0.1"]) =>
    ({ resolve4, fetchPage: async (u: string) => fetchPage(u) as never, reachMs: 50, retryMs: 1, hardMs: 5_000 });
  const codes = (r: { steps: { step: string; code: string }[] }) => r.steps.map(s => `${s.step}:${s.code}`);
  it("works: the boot id comes back from https://<address>/frame", async () => {
    const asked: string[] = [];
    const r = await runPreviewRouteTest({ hostname: PREV, linkOpen: true, bootId: boot, port: 19281 }, deps(async u => { asked.push(u); return { status: 200, body: `var BOOT = ${JSON.stringify(boot)}` }; }));
    expect(codes(r)).toEqual(["values:ok", "link:ok", "dns:ok", "reach:ok"]);
    expect(asked[0]).toBe(`https://${PREV}/frame`);
    expect(r).toMatchObject({ hostname: PREV, port: 19281 });
  });
  it.each([
    ["nothing saved", { hostname: null, linkOpen: true, bootId: boot, port: 19281 }, ["values:not-set"]],
    ["the link is closed", { hostname: PREV, linkOpen: false, bootId: boot, port: 19281 }, ["values:ok", "link:link-closed"]],
    ["no preview listener", { hostname: PREV, linkOpen: true, bootId: null, port: null }, ["values:ok", "link:no-listener"]],
    ["the page shows another (unsaved) address", { hostname: PREV, linkOpen: true, bootId: boot, port: 19281, shown: "other.example.net" }, ["values:not-saved"]],
  ])("%s: starts nothing, asks nothing", async (_l, input, want) => {
    const fetchPage = vi.fn(), resolve4 = vi.fn();
    const r = await runPreviewRouteTest(input, { fetchPage, resolve4 } as never);
    expect(codes(r)).toEqual(want);
    expect(fetchPage).not.toHaveBeenCalled(); expect(resolve4).not.toHaveBeenCalled();
  });
  it.each([
    ["another page (another AgEnD, another service)", { status: 200, body: "var BOOT = \"other\"" }, "reach:other-page"],
    ["no route on the tunnel", { status: 404, body: "" }, "reach:route-missing"],
    ["route to a wrong service", { status: 502, body: "" }, "reach:wrong-service"],
  ])("%s", async (_l, answer, last) => {
    const r = await runPreviewRouteTest({ hostname: PREV, linkOpen: true, bootId: boot, port: 19281 }, deps(async () => answer));
    expect(codes(r).at(-1)).toBe(last);
    expect(r.steps.at(-1)!.ok).toBe(false);
  });
  it("no DNS record yet", async () => {
    const r = await runPreviewRouteTest({ hostname: PREV, linkOpen: true, bootId: boot, port: 19281 },
      deps(async () => ({ status: 200, body: "" }), async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); }));
    expect(codes(r)).toEqual(["values:ok", "link:ok", "dns:dns-missing"]);
  });
  it("FleetManager.testPreviewRoute: the saved address, the open link's, the listener's boot and port; one at a time", async () => {
    const f: any = Object.create(FleetManager.prototype);
    f.fleetConfig = { web: { public_link: { hostname: DASH, preview_hostname: PREV } } };
    f.logger = { info: vi.fn() };
    f.previewListening = true; f.previewListener = { bootId: boot, settings: { port: 19281 } };
    f.publicWebLink = { fixedPreviewHost: () => null };
    expect(codes(await f.testPreviewRoute())).toEqual(["values:ok", "link:link-closed"]);
    expect(codes(await f.testPreviewRoute({ hostname: `https://${PREV.toUpperCase()}/` })), "the saved one, as the page writes it").toEqual(["values:ok", "link:link-closed"]);
    expect(codes(await f.testPreviewRoute({ hostname: "other.example.net" }))).toEqual(["values:not-saved"]);
    f.fleetConfig = { web: { public_link: { preview_hostname: PREV } } };
    expect(codes(await f.testPreviewRoute()), "no fixed hostname: not in force").toEqual(["values:not-set"]);
    f.previewRouteTestRunning = true;
    expect(await f.testPreviewRoute()).toEqual({ busy: true });
  });
});

describe("M-3814: the route — admin only, the page's shown address handed on, closed codes back", () => {
  const servers: Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });
  async function api() {
    const token = "c".repeat(48), sessions = new WebSessionStore({});
    const testPreviewRoute = vi.fn(async (_input?: unknown) => ({ steps: [{ step: "values", ok: false, code: "not-saved" }], hostname: PREV, port: 19281 }));
    const ctx = { webToken: token, webSessions: sessions, testPreviewRoute, logger: { warn() {}, info() {}, debug() {}, error() {} } } as never;
    let gateway = false;
    const server = createServer((req, res) => {
      // Over the public link as its gateway serves it: only a route on its list reaches the handler (public-web-gateway.ts).
      if (gateway) {
        if (!isPublicWebRoute(req.method ?? "GET", new URL(req.url!, origin).pathname)) { res.writeHead(404); res.end(); return; }
        bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: origin, isCurrent: () => true });
      }
      if (!handleSettingsRequest(req, res, new URL(req.url!, origin), ctx)) { res.writeHead(404); res.end(); }
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = (tier: "admin" | "read" | "guest", surface: "local" | "gateway" = "local") => {
      const made = sessions.create({ tier, surface, label: "scratch", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}), ...(tier === "guest" ? { owner: { adapterId: "web", userId: "g" } } : {}) });
      return { cookie: `${surface === "gateway" ? "__Host-" : ""}agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string>;
    };
    const post = (headers: Record<string, string>, body: string) => new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = request(origin + "/api/settings/public-link/preview-test", { method: "POST", headers }, res => {
        let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => resolve({ status: res.statusCode!, raw }));
      }); req.on("error", reject); req.end(body);
    });
    return { post, session, testPreviewRoute, setGateway: (v: boolean) => { gateway = v; } };
  }
  it("an admin's request: the shown address reaches the check; the answer is its closed codes", async () => {
    const h = await api();
    const r = await h.post(h.session("admin"), JSON.stringify({ hostname: "other.example.net" }));
    expect(r.status).toBe(200);
    expect(h.testPreviewRoute).toHaveBeenCalledWith({ hostname: "other.example.net" });
    expect(JSON.parse(r.raw)).toEqual({ steps: [{ step: "values", ok: false, code: "not-saved" }], hostname: PREV, port: 19281 });
    await h.post(h.session("admin"), "{}");
    expect(h.testPreviewRoute).toHaveBeenLastCalledWith({});
  });
  it("over the public link (M-3278, as Test connection): on the gateway's list; an admin session is served, read, guest and none are refused", async () => {
    expect(isPublicWebRoute("POST", "/api/settings/public-link/preview-test")).toBe(true);
    expect(isPublicWebRoute("GET", "/api/settings/public-link/preview-test")).toBe(false);
    const h = await api();
    h.setGateway(true);
    for (const headers of [h.session("read", "gateway"), h.session("guest", "gateway"), { "content-type": "application/json" }]) expect((await h.post(headers, "{}")).status).toBeGreaterThanOrEqual(401);
    expect(h.testPreviewRoute).not.toHaveBeenCalled();
    expect((await h.post(h.session("admin", "gateway"), JSON.stringify({ hostname: PREV }))).status).toBe(200);
    expect(h.testPreviewRoute).toHaveBeenCalledWith({ hostname: PREV });
  });
  it("refused: read, guest and no session; bad JSON", async () => {
    const h = await api();
    for (const headers of [h.session("read"), h.session("guest"), { "content-type": "application/json" }]) expect((await h.post(headers, "{}")).status).toBeGreaterThanOrEqual(401);
    expect((await h.post(h.session("admin"), "{not json")).status).toBe(400);
    expect(h.testPreviewRoute).not.toHaveBeenCalled();
  });
});
