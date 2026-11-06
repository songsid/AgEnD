/**
 * #3153 P1: GET /ui/workspace on the fleet's own listener (a scratch AGEND_HOME, no daemon) — who may ask and for which
 * agent: the local admin session only (not a guest, not a session made over the public link, not the web token), one
 * agent's own folder, never General's or a coordinator's, never an agent on another machine. An image is served with a
 * sandboxing policy of its own.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agend-ws-home-"));
process.env.AGEND_HOME = home;
const { FleetManager } = await import("../src/fleet-manager.js");
const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
const { tokenEpoch } = await import("../src/web-session.js");

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const b: Buffer[] = []; res.on("data", (c: Buffer) => { b.push(c); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(b) }));
    });
    r.on("error", reject); r.end();
  });
}
let fm: any, port = 0, dir: string, work: string;
const session = (tier: "admin" | "guest", surface: "local" | "gateway" = "local", owner?: { adapterId: string; userId: string }) =>
  fm.webSessions.create({ tier, surface, label: tier, tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!), ...(owner ? { owner } : {}), ...(surface === "gateway" ? { exposureId: "e1" } : {}) }).sessionId as string;
const get = (sid: string | null, q: string) => raw(port, `/ui/workspace?${q}`, sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {});
const json = (r: Raw) => JSON.parse(r.body.toString("utf8"));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-ws-fleet-"));
  work = join(dir, "work"); mkdirSync(work);
  execFileSync("git", ["-C", work, "init", "-q"]);
  writeFileSync(join(work, "a.txt"), "hello\n");
  writeFileSync(join(work, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(dir, "fleet.yaml"), [
    "health_port: 0", "instances:",
    `  dev:\n    working_directory: ${work}\n    backend: claude-code`,
    `  general:\n    working_directory: ${dir}\n    backend: claude-code\n    general_topic: true`,
    `  lead:\n    working_directory: ${dir}\n    backend: claude-code\n    tool_set: coordinator`,
  ].join("\n") + "\n");
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

describe("GET /ui/workspace (#3153 P1)", () => {
  it("the local admin session: Changes, Files and a file of the agent's own folder", async () => {
    const sid = session("admin");
    const ch = await get(sid, "instance=dev&op=changes");
    expect(ch.status).toBe(200);
    expect(json(ch).files.map((f: { path: string }) => f.path).sort()).toEqual(["a.txt", "pic.png"]);
    expect(String(ch.headers["cache-control"])).toContain("no-store");
    const ls = await get(sid, "instance=dev&op=list&path=");
    expect(json(ls).entries.map((e: { name: string }) => e.name)).toEqual([".git", "a.txt", "pic.png"]);
    expect(json(await get(sid, "instance=dev&op=file&path=a.txt"))).toMatchObject({ kind: "text", text: "hello\n" });
    const img = await get(sid, "instance=dev&op=image&path=pic.png");
    expect([img.status, img.headers["content-type"], img.headers["content-security-policy"], img.body.length]).toEqual([200, "image/png", "default-src 'none'; sandbox", 8]);
    expect((await get(sid, "instance=dev&op=file&path=../fleet.yaml")).status).toBe(403);
  });

  it("nobody else: no session, a guest, a session made over the public link", async () => {
    expect((await get(null, "instance=dev&op=changes")).status).toBe(401);            // the fleet's own gate, before the route
    // Refused, whether by the fleet's own gate (401) or by this route's local-admin check (403) — never answered.
    for (const sid of [session("guest", "local", { adapterId: "discord", userId: "111111111111111111" }), session("admin", "gateway")]) {
      const r = await get(sid, "instance=dev&op=changes");
      expect([401, 403]).toContain(r.status);
      expect(r.body.toString("utf8")).not.toContain("a.txt");
    }
  });

  it("not General, not a coordinator, not an unknown agent; a bad op is refused", async () => {
    const sid = session("admin");
    for (const inst of ["general", "lead", "nobody", "__proto__"]) expect((await get(sid, `instance=${inst}&op=changes`)).status, inst).toBe(404);
    expect((await get(sid, "instance=dev&op=write")).status).toBe(400);
  });
});
