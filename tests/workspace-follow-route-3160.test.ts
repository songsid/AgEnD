/**
 * #3160: op=follow and op=diff of GET /ui/workspace (P1's gate and folder rules apply), on the fleet's own listener.
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
const get = (sid: string | null, q: string) => raw(port, `/ui/workspace?${q}`, sid ? { cookie: `${WEB_SESSION_COOKIE}=${sid}` } : {});
const json = (r: Raw) => JSON.parse(r.body.toString("utf8"));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agend-ws-fleet-"));
  work = join(dir, "work"); mkdirSync(work);
  execFileSync("git", ["-C", work, "init", "-q"]);
  writeFileSync(join(work, "a.txt"), "hello\n");
  writeFileSync(join(work, ".env"), "TOKEN=x\n");
  execFileSync("git", ["-C", work, "-c", "user.email=t@e", "-c", "user.name=t", "add", "a.txt"]);
  execFileSync("git", ["-C", work, "-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"]);
  writeFileSync(join(work, "a.txt"), "hello\nworld\n");
  writeFileSync(join(work, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(dir, "fleet.yaml"), [
    "health_port: 0", "instances:",
    `  dev:\n    working_directory: ${work}\n    backend: claude-code`,
    `  kiro:\n    working_directory: ${work}\n    backend: kiro-cli`,
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

describe("GET /ui/workspace op=follow / op=diff (#3160)", () => {
  const steps = (s: unknown[]) => ({ workspaceFollow: (after: number, turn?: number) => ({ turn: 3, last: 9, steps: s, after, asked: turn }) });
  it("follow: this turn's steps, confined — outside dropped, a secret marked hidden; only for the local admin", async () => {
    fm.daemons.set("dev", steps([
      { seq: 8, at: 1, kind: "edit", tool: "Edit", paths: [join(work, "a.txt")], exact: true },
      { seq: 9, at: 2, kind: "read", tool: "Read", paths: ["/etc/passwd", join(work, ".env")], exact: true },
      { seq: 10, at: 3, kind: "read", tool: "Read", paths: ["/etc/shadow"], exact: true },
    ]));
    const sid = session("admin");
    const r = await get(sid, "instance=dev&op=follow&after=7&turn=3");
    expect(r.status).toBe(200);
    const b = json(r);
    expect([b.supported, b.running, b.turn, b.last]).toEqual([true, true, 3, 9]);
    expect(b.steps.map((s: any) => [s.seq, s.paths])).toEqual([[8, [{ path: "a.txt", hidden: false, dir: false }]], [9, [{ path: ".env", hidden: true, dir: false }]]]);
    expect((await get(null, "instance=dev&op=follow")).status, "no session: the outer gate").toBe(401);
    // Refused by the fleet's own gate (401) or this route's local-admin check (403); never answered.
    for (const who of [session("guest", "local", { adapterId: "discord", userId: "111111111111111111" }), session("admin", "gateway")]) {
      const x = await get(who, "instance=dev&op=follow");
      expect([401, 403]).toContain(x.status);
      expect(x.body.toString("utf8")).not.toContain("a.txt");
    }
    expect((await get(sid, "instance=general&op=follow")).status).toBe(404);
  });
  it("follow: a backend it does not cover, or no running agent, answers with no steps and says so", async () => {
    fm.daemons.set("kiro", steps([{ seq: 1, at: 1, kind: "read", tool: "Read", paths: ["a.txt"], exact: true }]));
    const sid = session("admin");
    expect(json(await get(sid, "instance=kiro&op=follow"))).toMatchObject({ supported: false, steps: [] });
    fm.daemons.delete("dev");
    expect(json(await get(sid, "instance=dev&op=follow"))).toMatchObject({ supported: true, running: false, steps: [] });
  });
  it("diff: one file's patch; a hidden file is refused", async () => {
    const sid = session("admin");
    const d = json(await get(sid, "instance=dev&op=diff&path=a.txt"));
    expect([d.repo, d.patch.includes("+world")]).toEqual([true, true]);
    expect((await get(sid, "instance=dev&op=diff&path=.env")).status).toBe(403);
    expect((await get(sid, "instance=dev&op=diff&path=../x")).status).toBe(403);
  });
});
