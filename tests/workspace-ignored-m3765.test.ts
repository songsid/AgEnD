/**
 * M-3765: the read-only Files view left out everything git ignores, so an agent's soul.md (AgEnD's own long-form memory,
 * which projects list in .gitignore) could not be found. Now:
 * - soul.md at the folder's top is always listed (marked `ignored` when git ignores it) and opens as any other file;
 * - `ignored=1` (the Files tab's "Show files git ignores") lists every ignored entry, each marked; a dependency folder is
 *   one entry, its contents only when it is opened;
 * - secret-looking names stay hidden (listed, never read), AgEnD's state directory stays out, either way.
 * On a REAL scratch git repository, through workspaceList / workspaceFile and the /ui/workspace route.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../src/logger.js", async original => {
  const silent: Record<string, unknown> = new Proxy({}, { get: (_t, key) => (key === "child" ? () => silent : key === "level" ? "silent" : () => {}) });
  return { ...await original<typeof import("../src/logger.js")>(), createLogger: () => silent };
});
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALWAYS_LISTED, workspaceFile, workspaceList, workspaceRoot } from "../src/agent-workspace.js";

const home = mkdtempSync(join(tmpdir(), "agend-ws-m3765-home-"));
process.env.AGEND_HOME = home;
const base = mkdtempSync(join(tmpdir(), "agend-ws-m3765-"));
const work = join(base, "work"), plain = join(base, "plain"), state = join(work, ".agend-state");

beforeAll(() => {
  mkdirSync(work); mkdirSync(plain); mkdirSync(state);
  execFileSync("git", ["-C", work, "init", "-q"]);
  writeFileSync(join(work, ".gitignore"), "soul.md\nsoul.declined\nnode_modules/\ndist/\n*.log\n.env\n");
  writeFileSync(join(work, "soul.md"), "# Example agent's memory\n\nCurrent state: example.\n");
  writeFileSync(join(work, "app.js"), "console.log(1);\n");
  writeFileSync(join(work, "debug.log"), "ignored log\n");
  writeFileSync(join(work, ".env"), "API_KEY=sk-should-never-leave\n");
  mkdirSync(join(work, "node_modules", "left-pad"), { recursive: true }); writeFileSync(join(work, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(work, "dist")); writeFileSync(join(work, "dist", "out.js"), "built\n");
  mkdirSync(join(work, "docs")); writeFileSync(join(work, "docs", "soul.md"), "not the agent's memory\n"); writeFileSync(join(work, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(state, "fleet.yaml"), "agend: private\n");
  writeFileSync(join(plain, "soul.md"), "# Memory, no repository\n");
});
afterAll(() => { rmSync(base, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const names = (l: { entries: Array<{ name: string }> }) => l.entries.map((e) => e.name);
const by = (l: { entries: Array<{ name: string }> }) => Object.fromEntries(l.entries.map((e) => [e.name, e])) as Record<string, any>;

describe("soul.md is always listed (M-3765)", () => {
  it("at the folder's top, even though git ignores it — marked ignored, and it opens", async () => {
    const ws = await workspaceRoot(work, state);
    const l = await workspaceList(ws, "");
    expect(by(l)["soul.md"]).toMatchObject({ type: "file", hidden: false, ignored: true });
    // The rest of what git ignores stays out by default (as before).
    for (const n of ["node_modules", "dist", "debug.log", ".env", "soul.declined"]) expect(names(l), n).not.toContain(n);
    expect(by(l)["app.js"]).toMatchObject({ hidden: false });
    expect(by(l)["app.js"].ignored).toBeUndefined();
    expect(names(l)).not.toContain(".agend-state");
    const f = await workspaceFile(ws, "soul.md");
    expect(f).toMatchObject({ kind: "text", path: "soul.md" });
    expect((f as { text: string }).text).toContain("Example agent's memory");
    expect(ALWAYS_LISTED).toEqual(["soul.md"]);
  });
  it("only at the top: a soul.md in a subfolder is an ordinary ignored file", async () => {
    const ws = await workspaceRoot(work, state);
    expect(names(await workspaceList(ws, "docs"))).toEqual(["guide.md"]);
  });
  it("in a folder that is not a repository: listed as before, nothing marked ignored", async () => {
    const l = await workspaceList(await workspaceRoot(plain, state), "");
    expect(by(l)["soul.md"]).toMatchObject({ type: "file", hidden: false });
    expect(by(l)["soul.md"].ignored).toBeUndefined();
  });
});

describe("Show files git ignores (M-3765)", () => {
  it("lists every ignored entry, each marked; the secret filter and AgEnD's state directory are unchanged", async () => {
    const ws = await workspaceRoot(work, state);
    const l = await workspaceList(ws, "", { showIgnored: true });
    const e = by(l);
    expect(e["node_modules"]).toMatchObject({ type: "dir", ignored: true });
    expect(e["dist"]).toMatchObject({ type: "dir", ignored: true });
    expect(e["debug.log"]).toMatchObject({ type: "file", ignored: true });
    expect(e["soul.md"]).toMatchObject({ ignored: true });
    expect(e[".env"]).toMatchObject({ hidden: true, ignored: true });          // listed, still hidden
    await expect(workspaceFile(ws, ".env")).rejects.toMatchObject({ code: "hidden" });
    expect(e["app.js"].ignored).toBeUndefined();
    expect(names(l)).not.toContain(".agend-state");
    expect(e[".git"]).toMatchObject({ hidden: true });
  });
  it("a dependency folder is one entry: its contents only when it is opened", async () => {
    const ws = await workspaceRoot(work, state);
    const top = await workspaceList(ws, "", { showIgnored: true });
    expect(names(top)).not.toContain("left-pad");
    expect(names(await workspaceList(ws, "node_modules", { showIgnored: true }))).toEqual(["left-pad"]);
    expect(names(await workspaceList(ws, "node_modules"))).toEqual([]);         // without the toggle: nothing in it is listed
  });
});

// ── the route: /ui/workspace?op=list&ignored=1 (the fleet's own listener, its local admin session) ──
interface Raw { status: number; body: Buffer }
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const b: Buffer[] = []; res.on("data", (c: Buffer) => { b.push(c); }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(b) }));
    });
    r.on("error", reject); r.end();
  });
}
describe("GET /ui/workspace op=list (M-3765)", () => {
  let fm: any, port = 0, sid = "", cookie = "";
  beforeAll(async () => {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { WEB_SESSION_COOKIE } = await import("../src/web-auth.js");
    const { tokenEpoch } = await import("../src/web-session.js");
    const dir = mkdtempSync(join(base, "fleet-"));
    writeFileSync(join(dir, "fleet.yaml"), ["health_port: 0", "instances:", `  dev:\n    working_directory: ${work}\n    backend: claude-code`].join("\n") + "\n");
    fm = new FleetManager(dir);
    const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
    fm.notifyFleetError = () => true; fm.loadConfig(join(dir, "fleet.yaml"));
    fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
    fm.getInstanceStatus = () => "running";
    fm.initializeWebAuthTokens(); fm.startHealthServer(0);
    await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true), { timeout: 15_000 });
    port = (fm.healthServer.address() as { port: number }).port;
    fm.initializeWebSessions?.();
    sid = fm.webSessions.create({ tier: "admin", surface: "local", label: "admin", tokenEpoch: tokenEpoch(fm.getDashboardAccess().token!) }).sessionId;
    cookie = `${WEB_SESSION_COOKIE}=${sid}`;
  }, 30_000);
  afterAll(async () => { try { fm.healthServer?.close(); } catch { /* closed */ } });
  it("without ignored: soul.md and the tracked files; with ignored=1: everything, marked", async () => {
    const plainList = JSON.parse((await raw(port, "/ui/workspace?instance=dev&op=list&path=", { cookie })).body.toString("utf8"));
    expect(names(plainList)).toContain("soul.md");
    expect(names(plainList)).not.toContain("node_modules");
    const all = JSON.parse((await raw(port, "/ui/workspace?instance=dev&op=list&path=&ignored=1", { cookie })).body.toString("utf8"));
    expect(by(all)["node_modules"]).toMatchObject({ ignored: true });
    // Anything but "1" is the default.
    const other = JSON.parse((await raw(port, "/ui/workspace?instance=dev&op=list&path=&ignored=yes", { cookie })).body.toString("utf8"));
    expect(names(other)).not.toContain("node_modules");
  });
  it("still only an admin session (no session: refused)", async () => {
    expect((await raw(port, "/ui/workspace?instance=dev&op=list&path=&ignored=1")).status).toBeGreaterThanOrEqual(401);
  });
  it("the route stays on the public link's list (the same GET /ui/workspace, the new parameter rides it)", () => {
    expect(readFileSync("src/public-web-gateway.ts", "utf8")).toContain('if (method === "GET" && (path === "/ui/accounts" || path === "/ui/workspace")) return true;');
  });
});
