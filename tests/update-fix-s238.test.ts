/**
 * M-3770 slice 1.6 (design #4480 §4.1, P3): the pre-flight's fix button, Turn on lingering. POST /ui/update/fixes on a real
 * FleetManager's listener (the pre-flight probes stubbed, the fix itself stubbed: no real loginctl runs), and the fix's
 * own logic (update-fix.ts) over stubbed deps:
 *  - an admin's signed-in session only, with an Idempotency-Key and a known fix; on the public link's route list;
 *  - the local checks run again first: the fix runs only while they still ask for it (a stale page never runs it);
 *  - the session is asked again right before it runs; the checks run once more after, and the page gets that result;
 *  - the same key gets the same answer (one run); one fix at a time;
 *  - the proof is the file P3 reads, never the command's exit status; only the fleet's own user, a plain login name.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const preflight = vi.hoisted(() => ({ checks: null as null | Array<Record<string, unknown>>, hold: null as null | Promise<void>, calls: [] as unknown[] }));
vi.mock("../src/update-readiness.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-readiness.js")>();
  return { ...real, runUpdatePreflight: vi.fn(async (opts: { target?: string | null; localOnly?: boolean } = {}) => {
    preflight.calls.push(opts);
    if (preflight.hold) await preflight.hold;
    const local = preflight.checks ?? [{ id: "P1", ok: true }, { id: "P2", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P8", ok: true }, { id: "P9", ok: true }];
    return real.summarize(local as never, Date.now(), { install: "/home/u/.npm-global/bin/agend" });
  }) };
});
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  return { ...real, spawn: ((() => Object.assign(new EventEmitter(), { unref: () => {}, pid: 0 })) as never), execFile: blocked, execFileSync: blocked, spawnSync: blocked, exec: blocked, execSync: blocked };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { isPublicWebRoute } = await import("../src/public-web-gateway.js");
const { fixFor, fixOffered, turnOnLinger, isUpdateFix } = await import("../src/update-fix.js");
const { summarize } = await import("../src/update-readiness.js");

const dirs: string[] = [];
afterEach(() => { preflight.checks = null; preflight.hold = null; preflight.calls.length = 0; vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let b: any = text; try { b = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

const LINGER_OFF = [{ id: "P1", ok: true }, { id: "P2", ok: true }, { id: "P3", ok: false, code: "linger-off", detail: { user: "example" } }, { id: "P4", ok: true }, { id: "P8", ok: true }, { id: "P9", ok: true }];
const FIXED = [{ id: "P1", ok: true }, { id: "P2", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P8", ok: true }, { id: "P9", ok: true }];
const LINGER = JSON.stringify({ fix: "linger" });

async function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-update-fix-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  vi.spyOn(fm, "runningAgendVersion").mockReturnValue("2.3.5-beta.2");
  // The fix: what a real `loginctl enable-linger` would leave behind (P3 passing), unless `fails`.
  const fix = { fails: false, running: 0, most: 0 };
  const runUpdateFix = vi.spyOn(fm, "runUpdateFix").mockImplementation(async () => {
    fix.running++; fix.most = Math.max(fix.most, fix.running);
    await new Promise(r => setTimeout(r, 5));
    fix.running--;
    if (fix.fails) return { ok: false };
    preflight.checks = FIXED;
    return { ok: true };
  });
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" | "guest" = "admin", userId = tier === "guest" ? "7" : "1") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken),
      owner: { adapterId: "discord", userId } });
    const cookie = `agend_session=${sessionId}`;
    return { id: sessionId, write: (key?: string) => ({ cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }) };
  };
  const post = (s: ReturnType<typeof session>, key: string | undefined, body = LINGER) => raw(port, "POST", "/ui/update/fixes", s.write(key), body);
  const stop = async () => { try { fm.updateCard?.close(); } catch { /* already closed */ } fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, port, session, post, fix, runUpdateFix, stop };
}

describe("M-3770 1.6: POST /ui/update/fixes", () => {
  it("an admin's session only, with a key and a known fix; on the public link's route list", async () => {
    expect(isPublicWebRoute("POST", "/ui/update/fixes")).toBe(true);
    expect(isPublicWebRoute("GET", "/ui/update/fixes")).toBe(false);
    preflight.checks = LINGER_OFF;
    const f = await fleet();
    try {
      expect((await raw(f.port, "POST", "/ui/update/fixes", { "content-type": "application/json" }, LINGER)).status).toBe(401);
      for (const tier of ["read", "guest"] as const) expect([401, 403], tier).toContain((await f.post(f.session(tier), "fix-key-0001")).status);
      const admin = f.session();
      expect((await f.post(admin, undefined)).status).toBe(400);                                    // no Idempotency-Key
      for (const body of [JSON.stringify({ fix: "install-service" }), JSON.stringify({}), JSON.stringify({ fix: ["linger"] }), "{"]) {
        expect((await f.post(admin, "fix-key-0002", body)).status, body).toBe(400);
      }
      expect((await raw(f.port, "GET", "/ui/update/fixes", admin.write())).status).toBe(405);
      expect(f.runUpdateFix).not.toHaveBeenCalled();
    } finally { await f.stop(); }
  });

  it("lingering off: the checks run again, the fix runs once, and the answer is the fresh pre-flight; the same key again is the same answer", async () => {
    preflight.checks = LINGER_OFF;
    const f = await fleet();
    try {
      const admin = f.session();
      const r = await f.post(admin, "fix-key-0010");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(f.runUpdateFix).toHaveBeenCalledTimes(1);
      expect(f.runUpdateFix).toHaveBeenCalledWith("linger");
      expect(r.body.preflight).toMatchObject({ class: "self", pressHere: true });
      expect(r.body.preflight.checks.find((c: any) => c.id === "P3")).toMatchObject({ ok: true });
      expect(preflight.calls).toEqual([{ localOnly: true }, { localOnly: true }]);              // before and after, never the network
      const again = await f.post(admin, "fix-key-0010");
      expect([again.status, again.body]).toEqual([200, r.body]);
      expect(f.runUpdateFix).toHaveBeenCalledTimes(1);
      const view = await raw(f.port, "GET", "/ui/update", admin.write());
      expect(view.body.preflight).toMatchObject({ class: "self" });                             // the page's next read agrees
    } finally { await f.stop(); }
  });

  it("not asked for any more (the check passes, or fails for another reason): 409 not_needed, nothing runs", async () => {
    const f = await fleet();
    try {
      const admin = f.session();
      for (const [i, checks] of [FIXED, [{ id: "P3", ok: false, code: "not-service" }], [{ id: "P3", ok: false, code: "service-unknown" }]].entries()) {
        preflight.checks = checks;
        const r = await f.post(admin, `fix-key-002${i}`);
        expect([r.status, r.body.error], JSON.stringify(checks)).toEqual([409, "not_needed"]);
        expect(r.body.preflight).toBeTruthy();
      }
      expect(f.runUpdateFix).not.toHaveBeenCalled();
    } finally { await f.stop(); }
  });

  it("a fix that doesn't take: 422 fix_failed, with the pre-flight as it still is", async () => {
    preflight.checks = LINGER_OFF;
    const f = await fleet();
    try {
      f.fix.fails = true;
      const r = await f.post(f.session(), "fix-key-0030");
      expect([r.status, r.body.error]).toEqual([422, "fix_failed"]);
      expect(r.body.preflight.checks.find((c: any) => c.id === "P3")).toMatchObject({ ok: false, code: "linger-off" });
      expect(f.runUpdateFix).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
  });

  it("a session that ends while the checks run again never runs the fix", async () => {
    preflight.checks = LINGER_OFF;
    const f = await fleet();
    try {
      const admin = f.session();
      let release!: () => void;
      preflight.hold = new Promise<void>(r => { release = r; });
      const pending = f.post(admin, "fix-key-0040");
      await vi.waitFor(() => expect(preflight.calls.length).toBe(1));
      f.fm.webSessions.revokeById(admin.id);
      release();
      const r = await pending;
      expect(r.status).toBe(403);
      expect(f.runUpdateFix).not.toHaveBeenCalled();
    } finally { await f.stop(); }
  });

  it("the same key from another admin is that admin's own request, never the first one's answer (#4557 review)", async () => {
    preflight.checks = LINGER_OFF;
    const f = await fleet();
    try {
      const first = await f.post(f.session("admin", "1"), "fix-key-0060");
      expect(first.status).toBe(200);
      const other = await f.post(f.session("admin", "2"), "fix-key-0060");
      expect([other.status, other.body.error]).toEqual([409, "not_needed"]);              // checked afresh: nothing left to fix
      expect(f.runUpdateFix).toHaveBeenCalledTimes(1);
      expect(preflight.calls.length).toBe(3);                                                  // before + after the fix, then the other's check
      const again = await f.post(f.session("admin", "1"), "fix-key-0060");                  // the first admin's key: its own answer
      expect([again.status, again.body]).toEqual([200, first.body]);
    } finally { await f.stop(); }
  });

  it("one fix at a time: a second press waits for the first, then finds nothing left to fix", async () => {
    preflight.checks = LINGER_OFF;
    const f = await fleet();
    try {
      const admin = f.session();
      const [a, b] = await Promise.all([f.post(admin, "fix-key-0050"), f.post(admin, "fix-key-0051")]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(f.runUpdateFix).toHaveBeenCalledTimes(1);
      expect(f.fix.most).toBe(1);
    } finally { await f.stop(); }
  });
});

describe("M-3770 1.6: update-fix.ts", () => {
  const deps = (over: Partial<{ platform: NodeJS.Platform; user: string; lingering: boolean; takes: boolean; throws: boolean }> = {}) => {
    const o = { platform: "linux" as NodeJS.Platform, user: "example", lingering: false, takes: true, throws: false, ...over };
    const runs: Array<[string, string[]]> = [];
    return { runs, d: {
      platform: o.platform, user: o.user,
      exists: async (path: string) => path === `/var/lib/systemd/linger/${o.user}` && o.lingering,
      run: async (command: string, args: string[]) => {
        runs.push([command, args]);
        if (o.throws) throw new Error("spawn failed");
        if (o.takes) o.lingering = true;
        return { status: o.takes ? 0 : 1, stdout: "", stderr: "" };
      },
    } };
  };
  it("turns on the fleet's own user's lingering, proven by P3's own file", async () => {
    const a = deps();
    expect(await turnOnLinger(a.d)).toEqual({ ok: true });
    expect(a.runs).toEqual([["loginctl", ["enable-linger", "example"]]]);
    const already = deps({ lingering: true });
    expect(await turnOnLinger(already.d)).toEqual({ ok: true });
    expect(already.runs).toEqual([]);
  });
  it("a command that exits 0 but leaves no proof, a refusal, or a spawn error is not fixed", async () => {
    const zeroNoProof = deps({ takes: false });
    zeroNoProof.d.run = async (command: string, args: string[]) => { zeroNoProof.runs.push([command, args]); return { status: 0, stdout: "", stderr: "" }; };
    expect(await turnOnLinger(zeroNoProof.d)).toEqual({ ok: false });
    expect(await turnOnLinger(deps({ takes: false }).d)).toEqual({ ok: false });
    expect(await turnOnLinger(deps({ throws: true }).d)).toEqual({ ok: false });
  });
  it("Linux only, and only a plain login name (nothing loginctl could read as an option or a path)", async () => {
    for (const over of [{ platform: "darwin" as NodeJS.Platform }, { user: "" }, { user: "-h" }, { user: "../root" }, { user: "a b" }, { user: "x".repeat(40) }]) {
      const a = deps(over);
      expect(await turnOnLinger(a.d), JSON.stringify(over)).toEqual({ ok: false });
      expect(a.runs, JSON.stringify(over)).toEqual([]);
    }
  });
  it("only lingering off offers a fix; Install as a service is words for now", () => {
    expect(fixFor({ id: "P3", ok: false, code: "linger-off" })).toBe("linger");
    for (const c of [{ id: "P3", ok: true }, { id: "P3", ok: false, code: "not-service" }, { id: "P4", ok: false, code: "no-write" }, null]) expect(fixFor(c as never)).toBeNull();
    expect(fixOffered(summarize(LINGER_OFF as never, 1), "linger")).toBe(true);
    expect(fixOffered(summarize(FIXED as never, 1), "linger")).toBe(false);
    expect(fixOffered(null, "linger")).toBe(false);
    expect([isUpdateFix("linger"), isUpdateFix("install-service"), isUpdateFix(1)]).toEqual([true, false, false]);
  });
});
