/**
 * M-3770 S-246: Install as a service — POST /ui/update/fixes { fix: "service", confirm } on a real FleetManager's
 * listener (the pre-flight probes stubbed; no real process starts: spawn is a recorder):
 *  - only with the page's confirmation, an admin's session and a key; only while P3 still says "not a service";
 *  - 202 once this fleet begins to stop (the hand-over), 422 with the command's own words when it refused;
 *  - the command is this install's own `agend install`, apart from the fleet (detached), with its words in
 *    service-install.log, and without the fleet's service-lock token or direct-start flag;
 *  - watchServiceInstall tells a refusal from the hand-over.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const preflight = vi.hoisted(() => ({ checks: null as null | Array<Record<string, unknown>>, calls: [] as unknown[] }));
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[]; opts: any }>, behave: null as null | ((child: any, opts: any) => void) }));
vi.mock("../src/update-readiness.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/update-readiness.js")>();
  return { ...real, runUpdatePreflight: vi.fn(async (opts: { target?: string | null; localOnly?: boolean } = {}) => {
    preflight.calls.push(opts);
    const local = preflight.checks ?? [{ id: "P1", ok: true }, { id: "P3", ok: true }, { id: "P4", ok: true }, { id: "P9", ok: true }];
    return real.summarize(local as never, Date.now(), { install: "/home/u/.npm-global/bin/agend" });
  }) };
});
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => { throw new Error("process execution is outside this harness"); };
  const spawn = (command: string, args: string[], opts: any) => {
    spawned.calls.push({ command, args, opts });
    const child = Object.assign(new EventEmitter(), { unref: () => {}, pid: 0 });
    spawned.behave?.(child, opts);
    return child;
  };
  return { ...real, spawn: spawn as never, execFile: blocked, execFileSync: blocked, spawnSync: blocked, exec: blocked, execSync: blocked };
});

const { FleetManager } = await import("../src/fleet-manager.js");
const { csrfTokenFor, tokenEpoch } = await import("../src/web-session.js");
const { watchServiceInstall, serviceInstallReason, serviceInstallCause, SERVICE_FIX_CONFIRM, isUpdateFix } = await import("../src/update-fix.js");

const dirs: string[] = [];
afterEach(() => { preflight.checks = null; preflight.calls.length = 0; spawned.calls.length = 0; spawned.behave = null; vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let b: any = text; try { b = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject); if (body !== undefined) r.write(body); r.end();
  });
}

const NOT_SERVICE = [{ id: "P1", ok: true }, { id: "P3", ok: false, code: "not-service" }, { id: "P4", ok: true }, { id: "P9", ok: true }];
const SERVICE = JSON.stringify({ fix: "service", confirm: SERVICE_FIX_CONFIRM });

async function fleet(result?: () => Promise<any>) {
  const dir = mkdtempSync(join(tmpdir(), "agend-service-fix-")); dirs.push(dir);
  const fm = new FleetManager(dir) as any;
  const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.fleetConfig = { instances: { alpha: { working_directory: "/tmp" } }, defaults: {} };
  vi.spyOn(fm, "runningAgendVersion").mockReturnValue("2.3.5-beta.2");
  const start = result ? vi.spyOn(fm, "startServiceInstall").mockImplementation(result) : null;
  fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const port = ((fm.healthServer as Server).address() as { port: number }).port, origin = `http://127.0.0.1:${port}`;
  const session = (tier: "admin" | "read" = "admin") => {
    const { sessionId } = fm.webSessions.create({ tier, surface: "local", label: "t", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "discord", userId: "1" } });
    const cookie = `agend_session=${sessionId}`;
    return { write: (key?: string) => ({ cookie, origin, "x-agend-csrf": csrfTokenFor(sessionId), "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }) };
  };
  const post = (s: ReturnType<typeof session>, key: string, body = SERVICE) => raw(port, "POST", "/ui/update/fixes", s.write(key), body);
  const stop = async () => { try { fm.updateCard?.close(); } catch { /* closed */ } fm.stormWindow.shutdown(); fm.spawnGate.shutdown(); await new Promise<void>(r => (fm.healthServer as Server).close(() => r())); };
  return { fm, dir, session, post, start, stop };
}

describe("S-246: POST /ui/update/fixes { fix: service }", () => {
  it("only with the page's confirmation and an admin's session; nothing starts otherwise", async () => {
    expect(isUpdateFix("service")).toBe(true);
    preflight.checks = NOT_SERVICE;
    const f = await fleet(async () => ({ kind: "restarting" }));
    try {
      for (const body of [JSON.stringify({ fix: "service" }), JSON.stringify({ fix: "service", confirm: "yes" }), JSON.stringify({ fix: "service", confirm: true })]) {
        const r = await f.post(f.session(), "svc-key-0001", body);
        expect([r.status, r.body.error], body).toEqual([400, `confirm must be "${SERVICE_FIX_CONFIRM}"`]);
      }
      expect([401, 403]).toContain((await f.post(f.session("read"), "svc-key-0002")).status);
      expect(f.start).not.toHaveBeenCalled();
    } finally { await f.stop(); }
  });

  it("the hand-over began: 202 { restarting }; the same key is the same answer; still running after the wait: 202 { pending } with the fresh pre-flight", async () => {
    preflight.checks = NOT_SERVICE;
    const f = await fleet(async () => ({ kind: "restarting" }));
    try {
      const admin = f.session();
      const r = await f.post(admin, "svc-key-0010");
      expect([r.status, r.body]).toEqual([202, { restarting: true }]);
      expect(preflight.calls).toEqual([{ localOnly: true }]);              // the checks before; none after (it is stopping)
      expect((await f.post(admin, "svc-key-0010")).status).toBe(202);
      expect(f.start).toHaveBeenCalledTimes(1);
      f.start!.mockImplementation(async () => ({ kind: "pending" }));
      const pending = await f.post(admin, "svc-key-0011");
      expect([pending.status, pending.body.pending, pending.body.restarting]).toEqual([202, true, undefined]);   // never claims a restart
      expect(pending.body.preflight).toBeTruthy();                                                              // looked again
    } finally { await f.stop(); }
  });

  it("refused (nothing stopped): 422 with the command's own words and the fresh pre-flight", async () => {
    preflight.checks = NOT_SERVICE;
    const f = await fleet(async () => ({ kind: "failed", reason: "the user's service manager isn't running" }));
    try {
      const r = await f.post(f.session(), "svc-key-0020");
      expect([r.status, r.body.error, r.body.reason, r.body.cause]).toEqual([422, "fix_failed", "the user's service manager isn't running", "other"]);
      expect(r.body.preflight.checks.find((c: any) => c.id === "P3")).toMatchObject({ ok: false, code: "not-service" });
    } finally { await f.stop(); }
  });

  it("not asked for any more (already a service, or another P3 reason): 409, nothing starts", async () => {
    const f = await fleet(async () => ({ kind: "restarting" }));
    try {
      for (const checks of [null, [{ id: "P3", ok: false, code: "linger-off", detail: { user: "u" } }], [{ id: "P3", ok: false, code: "service-unknown" }]]) {
        preflight.checks = checks;
        expect((await f.post(f.session(), `svc-key-003${String(checks?.length ?? 0)}${Math.random().toString(36).slice(2, 6)}`)).status).toBe(409);
      }
      expect(f.start).not.toHaveBeenCalled();
    } finally { await f.stop(); }
  });

  it("the command: this install's own `agend install`, detached, its words in service-install.log, no fleet token or direct-start flag", async () => {
    const f = await fleet();
    process.env.AGEND_SERVICE_LOCK_TOKEN = "fleet-token";
    process.env.AGEND_FLEET_START_DIRECT = "1";
    try {
      spawned.behave = (child, opts) => {
        writeSync(opts.stdio[1], "  ✗ Cannot confirm the hand-started fleet's owner; nothing was stopped or started.\n");
        setTimeout(() => child.emit("exit", 1), 5);
      };
      const result = await f.fm.startServiceInstall();
      expect(result).toEqual({ kind: "failed", reason: "Cannot confirm the hand-started fleet's owner; nothing was stopped or started." });
      expect(spawned.calls).toHaveLength(1);
      const call = spawned.calls[0]!;
      expect(call.command).toBe(process.execPath);
      expect(call.args.at(-1)).toBe("install");
      expect(call.args.at(-2)).toMatch(/[/\\]cli\.(ts|js)$/);
      expect(call.opts.detached).toBe(true);
      expect(call.opts.env.AGEND_SERVICE_LOCK_TOKEN).toBeUndefined();
      expect(call.opts.env.AGEND_FLEET_START_DIRECT).toBeUndefined();
      expect(readFileSync(join(f.dir, "service-install.log"), "utf8")).toMatch(/--- agend install \(web, Install as a service\) .*\n  ✗ Cannot confirm/);
      // The fleet begins to stop: the hand-over.
      spawned.behave = () => {};
      setTimeout(() => { f.fm.shuttingDown = true; }, 20);
      expect(await f.fm.startServiceInstall()).toEqual({ kind: "restarting" });
    } finally {
      delete process.env.AGEND_SERVICE_LOCK_TOKEN; delete process.env.AGEND_FLEET_START_DIRECT;
      f.fm.shuttingDown = false; await f.stop();
    }
  });
});

describe("S-246: watchServiceInstall", () => {
  const watch = (over: Partial<Parameters<typeof watchServiceInstall>[0]>) => {
    let t = 0;
    return watchServiceInstall({ exitCode: () => undefined, shuttingDown: () => false, output: () => "", now: () => t, sleep: async ms => { t += ms; }, waitMs: 30_000, ...over });
  };
  it("refused → failed with its words; ended well → done; the fleet stopping → restarting (even when it then exits); neither → pending", async () => {
    expect(await watch({ exitCode: () => 1, output: () => "--- agend install (web) x ---\nWriting the unit\n❌ Fleet service was installed but could not be started: boom\n" }))
      .toEqual({ kind: "failed", reason: "Fleet service was installed but could not be started: boom" });
    expect(await watch({ exitCode: () => 0 })).toEqual({ kind: "done" });
    expect(await watch({ shuttingDown: () => true, exitCode: () => 1 })).toEqual({ kind: "restarting" });
    expect(await watch({})).toEqual({ kind: "pending" });
  });
  it("the cause: the user's service manager (either language, systemd's or agend install's words), else other (#4564 look)", () => {
    for (const r of ["The user's service manager can't be reached (Failed to connect to bus: No medium found).", "Failed to connect to bus: No such file or directory",
      "user@1000.service is not running", "/run/user/1000/bus is missing", "這台電腦的使用者服務管理員無法連線"]) expect(serviceInstallCause(r), r).toBe("user-manager");
    for (const r of ["agend install failed", "the user's service manager isn't running", "Permission denied"]) expect(serviceInstallCause(r), r).toBe("other");
  });
  it("the reason: the ✗/❌ lines, else the last line; never empty", () => {
    expect(serviceInstallReason("a\nb\n")).toBe("b");
    expect(serviceInstallReason("--- header ---\n")).toBe("agend install failed");
    expect(serviceInstallReason("  ✗ one\nx\n  ✗ two\n")).toBe("one two");
  });
});
