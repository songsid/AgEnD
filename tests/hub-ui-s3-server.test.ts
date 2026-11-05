/**
 * AgEnD Hub P1, slice 3 (docs/design/hub-ui-client.md; docs/design/hub.md §1), server side. Live, through the fleet's
 * own listener (a scratch AGEND_HOME, no daemon):
 * - both switches off (the default): the app shell carries no Hub mark; `/ui/hub*` is the ordinary not-found;
 * - `hub_member.enabled`: this fleet's pages are marked `data-hub="member"` (never on a guest's page); `hub.enabled` makes
 *   no mark here — a Hub's own shell is served only by its own listener (slice 1), never by this fleet's;
 * - serveAppShell's `hubWorkspace` (slice 1's Hub listener): `data-hub="hub"` with its name, escaped and one line;
 * - the Hub pages' stylesheet is a static asset.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-hub3-home-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { tokenEpoch } = await import("../src/web-session.js");
const { serveAppShell } = await import("../src/web-api.js");
const { bindGatewayRequest } = await import("../src/web-request-context.js");
const { shellRoute } = await import("../src/web-shell-routes.js");
const { hubModeOf, hubNameOf, HUB_NAME_MAX } = await import("../src/hub-mode.js");

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, accept: "text/html", ...headers } }, (res) => {
      const b: Buffer[] = []; res.on("data", (c: Buffer) => { b.push(c); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(b).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
}
let fm: any, port = 0, dir: string;
const ALICE = { adapterId: "discord", userId: "111111111111111111" };
const session = (tier: "admin" | "guest", owner?: typeof ALICE) =>
  fm.webSessions.create({ tier, surface: "local", label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), owner }).sessionId as string;
const get = (sid: string | null, path: string) => raw(port, path, sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {});
const bodyTag = (html: string) => /<body[^>]*>/.exec(html)?.[0] ?? "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-hub3-fleet-"));
  writeFileSync(join(dir, "fleet.yaml"), `health_port: 0\ninstances:\n  a:\n    working_directory: ${dir}\n    backend: claude-code\n`);
  fm = new FleetManager(dir);
  const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
  fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
  fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
  fm.getInstanceStatus = () => "running";
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  port = (fm.healthServer.address() as { port: number }).port;
  fm.initializeWebSessions?.();
});
afterAll(async () => {
  await new Promise<void>((r) => fm.healthServer?.close(() => r()));
  rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
});
const setSwitches = (hub?: unknown, member?: unknown) => {
  if (hub === undefined) delete fm.fleetConfig.hub; else fm.fleetConfig.hub = hub;
  if (member === undefined) delete fm.fleetConfig.hub_member; else fm.fleetConfig.hub_member = member;
};

describe("the switches and the page's mark (this fleet's listener)", () => {
  it("off (the default): no mark; the Hub's pages are not found", async () => {
    setSwitches();
    const sid = session("admin");
    const page = await get(sid, "/ui");
    expect([page.status, bodyTag(page.body).includes("data-hub")]).toEqual([200, false]);
    for (const path of ["/ui/hub", "/ui/hub/exposures", "/ui/hub/admin"]) expect((await get(sid, path)).status, path).toBe(404);
  });
  it("hub_member.enabled: this fleet's pages say member; a guest's never; only exactly true turns it on", async () => {
    setSwitches(undefined, { enabled: true });
    expect(bodyTag((await get(session("admin"), "/ui")).body)).toContain(' data-hub="member"');
    for (const v of ["true", 1, null, {}]) {
      setSwitches(undefined, { enabled: v });
      expect(bodyTag((await get(session("admin"), "/ui")).body).includes("data-hub"), JSON.stringify(v)).toBe(false);
    }
    setSwitches(undefined, { enabled: true });
    fm.fleetConfig.web = { guests: { enabled: true, grants: { [`${ALICE.adapterId}:${ALICE.userId}`]: { instances: ["a"] } } } };
    try {
      const guest = await get(session("guest", ALICE), "/ui/chat/a");
      expect([guest.status, bodyTag(guest.body).includes("data-hub")]).toEqual([200, false]);
    } finally { delete fm.fleetConfig.web; }
  });
  it("hub_member.enabled: never marked over the public link (member handlers are local-owner-only — hub.md §1)", () => {
    setSwitches(undefined, { enabled: true });
    try {
      let body = "";
      const req = { url: "/ui", headers: { host: "x.trycloudflare.com" }, socket: { remoteAddress: "127.0.0.1" } };
      bindGatewayRequest(req, { surface: "gateway", exposureId: "e1", expectedOrigin: "https://x.trycloudflare.com", isCurrent: () => true });
      const res = { setHeader() {}, writeHead() {}, end(b?: string) { body = String(b ?? ""); }, headersSent: false };
      serveAppShell(req as never, res as never, fm, "full");
      expect(bodyTag(body)).toContain('data-public-link="1"');
      expect(bodyTag(body).includes("data-hub")).toBe(false);
    } finally { setSwitches(); }
  });
  it("hub.enabled makes no mark and mounts no Hub page here: a Hub's shell is its own listener's (slice 1)", async () => {
    setSwitches({ enabled: true, name: "Team Hub" });
    const sid = session("admin");
    expect(bodyTag((await get(sid, "/ui")).body).includes("data-hub")).toBe(false);
    expect((await get(sid, "/ui/hub")).status).toBe(404);
    setSwitches();
  });
  it("hubModeOf reads the member switch only, defensively", () => {
    expect([hubModeOf(null), hubModeOf({}), hubModeOf({ hub_member: { enabled: true } }), hubModeOf({ hub: { enabled: true } })])
      .toEqual([{ member: false }, { member: false }, { member: true }, { member: false }]);
  });
});

describe("a Hub's own workspace (serveAppShell's hubWorkspace, for slice 1's listener)", () => {
  function shellWith(opts: { hubWorkspace?: { name: string } }): string {
    let body = "";
    const req = { url: "/ui/hub", headers: { host: `127.0.0.1:${port}` }, socket: { remoteAddress: "127.0.0.1" } };
    const res = { setHeader() {}, writeHead() {}, end(b?: string) { body = String(b ?? ""); }, headersSent: false };
    serveAppShell(req as never, res as never, fm, "full", opts);
    return bodyTag(body);
  }
  it("marks the page the Hub's, with its name — escaped and one line — and reads nothing of the fleet's", () => {
    expect(shellWith({ hubWorkspace: { name: "Team Hub" } })).toContain(' data-hub="hub" data-hub-name="Team Hub"');
    // S3b: Hub-only — no fleet cookie, session, preference or preview is read (a throwing context proves it).
    let body = "";
    const trap = new Proxy({}, { get: (_t, k) => { throw new Error(`fleet context read: ${String(k)}`); } });
    const req = new Proxy({ url: "/ui/hub" }, { get: (t, k) => { if (k === "url") return (t as { url: string }).url; throw new Error(`request read: ${String(k)}`); } });
    serveAppShell(req as never, { setHeader() {}, writeHead() {}, end(b?: string) { body = String(b ?? ""); }, headersSent: false } as never, trap as never, "full", { hubWorkspace: { name: "Team Hub" } });
    expect(bodyTag(body)).toContain('data-hub="hub"');
    expect(body).not.toContain("data-prefs");
    const hostile = shellWith({ hubWorkspace: { name: '"><script>x</script>\n  second line' } });
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("data-hub-name=\"&#34;&#62;&#60;script&#62;x&#60;/script&#62; second line\"");
    expect(shellWith({})).not.toContain("data-hub");
  });
  it("hubNameOf: control characters out, at most HUB_NAME_MAX characters", () => {
    expect(hubNameOf("a\u0000b\tc")).toBe("a b c");
    expect([...hubNameOf("名".repeat(80))].length).toBe(HUB_NAME_MAX);
  });
});

describe("routes and assets", () => {
  it("the Hub's pages are shell routes (mounted only by a Hub's listener); its stylesheet is a static asset", async () => {
    expect(shellRoute("GET", "/ui/hub")).toEqual({ kind: "shell", route: { panel: "hub", tab: "ask" } });
    expect(shellRoute("GET", "/ui/hub/exposures")).toEqual({ kind: "shell", route: { panel: "hub", tab: "exposures" } });
    expect(shellRoute("GET", "/ui/hub/admin")).toEqual({ kind: "shell", route: { panel: "hub", tab: "admin" } });
    expect(shellRoute("GET", "/ui/hub/other")).toBeNull();
    const css = await raw(port, "/assets/hub.css");
    expect([css.status, String(css.headers["content-type"])]).toEqual([200, "text/css; charset=utf-8"]);
  });
});
