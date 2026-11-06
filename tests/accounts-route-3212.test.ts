/**
 * #3212 PR 1: GET /ui/accounts — the fleet's local admin session only (no session, a guest or the gateway: refused,
 * nothing of the accounts in the answer); the view has a card per CLI with host-scoped rows.
 * Harness as #3153 P1's route test: GET /ui/workspace on the fleet's own listener (a scratch AGEND_HOME, no daemon) — who may ask and for which
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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const get = (sid: string | null) => raw(port, `/ui/accounts`, sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {});
const json = (r: Raw) => JSON.parse(r.body.toString("utf8"));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-ws-fleet-"));
  work = join(dir, "work"); mkdirSync(work);
  execFileSync("git", ["-C", work, "init", "-q"]);
  writeFileSync(join(work, "a.txt"), "hello\n");
  mkdirSync(join(dir, "credential-profiles", "claude-code", "spare-account"), { recursive: true });
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

describe("GET /ui/accounts (#3212)", () => {
  it("the local admin session: a card per CLI, host rows, a profile only on disk listed", async () => {
    vi.spyOn(fm, "refreshSignInIdentities").mockImplementation(() => {});
    const r = await get(session("admin"));
    expect(r.status).toBe(200);
    const v = json(r);
    const claude = v.clis.find((c: any) => c.backend === "claude-code");
    expect(claude.rows.every((row: any) => row.scope.kind === "host")).toBe(true);
    expect(claude.rows.map((row: any) => row.profile)).toContain("spare-account");
  });
  it("the web token (a script, not the local admin session) is refused by the route itself", async () => {
    const r = await raw(port, "/ui/accounts", { "x-agend-token": fm.getDashboardAccess().token! });
    expect(r.status).toBe(403);
    expect(r.body.toString("utf8")).not.toContain("spare-account");
  });
  it("no session, a guest or a gateway session: refused, with nothing of the accounts", async () => {
    expect((await get(null)).status).toBe(401);
    for (const sid of [session("guest", "local", { adapterId: "discord", userId: "111111111111111111" }), session("admin", "gateway")]) {
      const r = await get(sid);
      expect([401, 403, 404]).toContain(r.status);
      expect(r.body.toString("utf8")).not.toContain("spare-account");
    }
  });
});
