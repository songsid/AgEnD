import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listKiroV2Sessions, resolveKiroIdentity, kiroIdentityNeedsStore } from "../src/backend/kiro-identity.js";
import { KiroV2StoreLane, sharedKiroV2StoreLane, KIRO_V2_STORE_BUDGET_MS, KIRO_V2_STORE_QUEUE_LIMIT } from "../src/backend/kiro-v2-store.js";
import { KiroBackend, type KiroCliCompatibility } from "../src/backend/kiro.js";
import { recordKiroLaunch } from "../src/backend/kiro-engine-ledger.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { Daemon } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";
import pino from "pino";

// A sync selector on the fleet's realm fails even on small files. The worker
// owns only private fixtures; these mocks cannot reach that separate realm.
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const guard = (path: unknown) => { if (String(path).includes("/sessions/cli")) throw new Error("session IO on fleet loop"); };
  return { ...fs, readFileSync: (...args: any[]) => { guard(args[0]); return (fs.readFileSync as any)(...args); },
    readdirSync: (...args: any[]) => { guard(args[0]); return (fs.readdirSync as any)(...args); } };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: () => { throw new Error("no CLI"); }, execSync: () => { throw new Error("no CLI"); },
  spawn: () => { throw new Error("no processes"); } }));

let root: string, dir: string, cwd: string;
const lanes: KiroV2StoreLane[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1417-")); dir = join(root, "kiro", "sessions", "cli"); cwd = join(root, "work");
  mkdirSync(dir, { recursive: true }); mkdirSync(cwd); mkdirSync(join(root, "agend", "instances", "a"), { recursive: true });
  vi.stubEnv("KIRO_HOME", join(root, "kiro")); vi.stubEnv("AGEND_HOME", join(root, "agend")); vi.stubEnv("XDG_DATA_HOME", join(root, "xdg"));
});
afterEach(() => { lanes.splice(0).forEach(l => l.close()); sharedKiroV2StoreLane.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const file = (name: string, extra: Record<string, unknown> = {}) => {
  const path = join(dir, name + ".json"); writeFileSync(path, JSON.stringify({ cwd, session_id: name, updated_at: "2026-10-08T10:00:00Z", created_at: "2026-10-08T09:00:00Z", ...extra })); return path;
};
const deferred = <T>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
class FakeWorker extends EventEmitter {
  sent: any[] = []; ref = vi.fn(); unref = vi.fn(); terminate = vi.fn(() => new Promise<number>(() => {}));
  postMessage(v: unknown) { this.sent.push(v); }
  ack(id = this.sent.at(-1).id) { this.emit("message", { id, reply: { kind: "ok", sessions: [], diagnostics: { reads: 0, hits: 0 } } }); }
}
const input = { keys: ["/fixture"], sessionsDir: "/fixture/sessions/cli" };

describe("bounded metadata lane", () => {
  it("uses one warm worker, request ids, and unrefs after completion", async () => {
    const worker = new FakeWorker(), factory = vi.fn(() => worker), lane = new KiroV2StoreLane(factory); lanes.push(lane);
    const a = lane.read(input), b = lane.read(input); expect(factory).toHaveBeenCalledTimes(1);
    worker.ack(worker.sent[1].id); expect((await b).kind).toBe("ok"); worker.ack(worker.sent[0].id); expect((await a).kind).toBe("ok");
    expect(worker.unref).toHaveBeenCalled(); const c = lane.read(input); worker.ack(); await c; expect(factory).toHaveBeenCalledTimes(1);
  });
  it("keeps the physical slot across timeout/close until exact exit, then starts one replacement", async () => {
    vi.useFakeTimers(); let now = 0; const a = new FakeWorker(), b = new FakeWorker(), factory = vi.fn().mockReturnValueOnce(a).mockReturnValueOnce(b);
    const lane = new KiroV2StoreLane(factory, () => now); lanes.push(lane);
    const first = lane.read(input); now = KIRO_V2_STORE_BUDGET_MS; await vi.advanceTimersByTimeAsync(KIRO_V2_STORE_BUDGET_MS);
    expect((await first).kind).toBe("unreadable"); expect(a.terminate).toHaveBeenCalledTimes(1);
    lane.close(); const next = lane.read(input); expect(factory).toHaveBeenCalledTimes(1); a.ack();
    a.emit("exit", 0); expect(factory).toHaveBeenCalledTimes(2); b.ack(); expect((await next).kind).toBe("ok");
    a.emit("exit", 0); expect(factory).toHaveBeenCalledTimes(2);
  });
  it("rejects a deadline ACK even before its timer and never starts expired queued work", async () => {
    vi.useFakeTimers(); let now = 0; const worker = new FakeWorker(), factory = vi.fn(() => worker), lane = new KiroV2StoreLane(factory, () => now); lanes.push(lane);
    const first = lane.read(input); now = KIRO_V2_STORE_BUDGET_MS; worker.ack(); expect((await first).kind).toBe("unreadable");
    const waiting = lane.read(input); now += KIRO_V2_STORE_BUDGET_MS; worker.emit("exit", 0);
    expect((await waiting).kind).toBe("unreadable"); expect(factory).toHaveBeenCalledTimes(1);
  });
  it("bounds queue length and ignores late ACK after close", async () => {
    const worker = new FakeWorker(), lane = new KiroV2StoreLane(() => worker); lanes.push(lane);
    const jobs = Array.from({ length: KIRO_V2_STORE_QUEUE_LIMIT }, () => lane.read(input));
    expect(await lane.read(input)).toMatchObject({ kind: "unreadable", detail: expect.stringContaining("queue full") });
    lane.close(); worker.ack(); expect((await Promise.all(jobs)).every(r => r.kind === "unreadable")).toBe(true);
  });
});

describe("real private worker, exact JSON metadata semantics", () => {
  it("keeps directory aliases, filename fallback, subagents, arbitrary property order and duplicate-key last wins", async () => {
    file("mine"); file("other", { cwd: join(root, "other") }); file("sub", { session_created_reason: "subagent" });
    file("fallback", { session_id: 12, updated_at: "invalid", created_at: "invalid" });
    writeFileSync(join(dir, "last.json"), `{"history":[],"cwd":"other","session_id":"last","cwd":${JSON.stringify(cwd)},"created_at":"2026-10-08T11:00:00Z"}`);
    writeFileSync(join(dir, "partial.json"), `{"cwd":${JSON.stringify(cwd)},"session_id":"partial"`);
    const link = join(root, "link"); symlinkSync(cwd, link);
    const result = await listKiroV2Sessions(link, dir); expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("not ok");
    expect(result.sessions.map(s => s.id).sort()).toEqual(["fallback", "last", "mine"]);
    expect(result.sessions.find(s => s.id === "fallback")?.updatedAt).toBe(0); expect(result.createdAt("fallback")).toBeNull();
    expect(result.createdAt("last")).toBe(Date.parse("2026-10-08T11:00:00Z"));
  });
  it("caches only metadata, invalidates changes/replacement and retries repaired malformed files", async () => {
    const lane = new KiroV2StoreLane(); lanes.push(lane); const p = file("a"); const request = { keys: [cwd], sessionsDir: dir };
    const cold = await lane.read(request); expect(cold.kind === "ok" && cold.diagnostics.reads).toBe(1);
    const warm = await lane.read(request); expect(warm.kind === "ok" && warm.diagnostics).toEqual({ reads: 0, hits: 1 });
    const old = new Date("2025-01-01"); writeFileSync(p, "{"); utimesSync(p, old, old);
    expect(await lane.read(request)).toMatchObject({ kind: "ok", sessions: [] });
    file("a", { session_id: "repaired" }); expect(await lane.read(request)).toMatchObject({ kind: "ok", sessions: [{ id: "repaired" }] });
    rmSync(p); file("a", { session_id: "replacement" }); expect(await lane.read(request)).toMatchObject({ kind: "ok", sessions: [{ id: "replacement" }] });
  });
  it("missing directory is empty, an unlistable path is unreadable", async () => {
    expect(await listKiroV2Sessions(cwd, join(root, "missing"))).toMatchObject({ kind: "ok", sessions: [] });
    const p = join(root, "not-a-directory"); writeFileSync(p, "x"); expect((await listKiroV2Sessions(cwd, p)).kind).toBe("unreadable");
  });
  it("a large history scan yields to the fleet event loop and warm reads do not reparse bodies", async () => {
    for (let i = 0; i < 4; i++) file("huge-" + i, { cwd: join(root, "elsewhere"), history: "x".repeat(16 * 1024 * 1024) });
    const lane = new KiroV2StoreLane(); lanes.push(lane); let settled = false, beats = 0;
    const started = performance.now(); const pending = lane.read({ keys: [cwd], sessionsDir: dir }).then(r => { settled = true; return r; });
    const timer = setInterval(() => { if (!settled) beats++; }, 1);
    try { expect(await pending).toMatchObject({ kind: "ok", sessions: [], diagnostics: { reads: 4 } }); } finally { clearInterval(timer); }
    expect(beats).toBeGreaterThan(5); expect(performance.now() - started).toBeLessThan(KIRO_V2_STORE_BUDGET_MS);
    expect(await lane.read({ keys: [cwd], sessionsDir: dir })).toMatchObject({ kind: "ok", diagnostics: { reads: 0, hits: 4 } });
  });
});

const compat: KiroCliCompatibility = { version: "kiro-cli 2.27.0", source: "version", supportsLegacyUi: true, supportsTui: true,
  supportsV3: true, supportsInstanceAgent: true, agentEngines: ["v1", "v2", "v3"], supportsEffortFlag: true };
const config = (): CliBackendConfig => ({ workingDirectory: cwd, instanceName: "a", instanceDir: join(root, "agend", "instances", "a"), kiroUi: "tui", mcpServers: {} });
describe("launch preparation / unchanged identity decisions", () => {
  it("a real daemon stop during held Kiro preparation cannot write identity/config or launch", async () => {
    const held = deferred<any>(); vi.spyOn(sharedKiroV2StoreLane, "read").mockReturnValueOnce(held.promise);
    const c = config(), b = new KiroBackend(c.instanceDir, compat);
    const daemon: any = new Daemon("a", { working_directory: cwd, backend: "kiro", kiro_ui: "tui", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 } } as any, c.instanceDir, false, undefined, undefined, pino({ level: "silent" }) as any);
    daemon.backend = b; const write = vi.spyOn(b, "writeConfig");
    const tmux = vi.spyOn(TmuxManager, "ensureSession").mockRejectedValue(new Error("no tmux"));
    const outcome = daemon.trySpawnInsideGate().then(() => "launched", (e: Error) => e.message);
    await vi.waitFor(() => expect(sharedKiroV2StoreLane.read).toHaveBeenCalled());
    await daemon.stop(); held.resolve({ kind: "ok", sessions: [], diagnostics: { reads: 0, hits: 0 } });
    expect(await outcome).toMatch(/Launch cancelled/); expect(write).not.toHaveBeenCalled(); expect(tmux).not.toHaveBeenCalled();
    expect(existsSync(join(root, "agend", "kiro-identity"))).toBe(false);
  });
  it("a late preparation cannot replace a newer directory snapshot, and an unprepared store refuses", async () => {
    const held = deferred<any>(); vi.spyOn(sharedKiroV2StoreLane, "read").mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce({ kind: "ok", sessions: [{ id: "current", updatedAt: 1, createdAt: 1 }], diagnostics: { reads: 1, hits: 0 } });
    const b = new KiroBackend(config().instanceDir, compat), old = config(); const reading = b.prepareLaunch(old);
    const next = { ...config(), workingDirectory: join(root, "next") }; mkdirSync(next.workingDirectory);
    await b.prepareLaunch(next); held.resolve({ kind: "ok", sessions: [{ id: "old", updatedAt: 99, createdAt: 1 }], diagnostics: { reads: 1, hits: 0 } }); await reading;
    expect(() => b.writeConfig(next)).not.toThrow(); expect(b.buildCommand(next)).not.toContain("--resume");
    const unprepared = new KiroBackend(config().instanceDir, compat);
    expect(() => unprepared.writeConfig(config())).toThrow(/not prepared/);
  });
  it("adopts newest only with ledger evidence and recorded exact resume-id does not scan again", async () => {
    file("old"); file("new", { updated_at: "2026-10-08T12:00:00Z" });
    recordKiroLaunch({ instance: "a", workingDirectory: cwd, credentialProfile: null, kiroVersion: "2.27.0", ui: "tui", flags: ["--tui", "--agent-engine=v2"] });
    const b = new KiroBackend(config().instanceDir, compat), c = config(); await b.prepareLaunch(c); b.writeConfig(c);
    expect(b.buildCommand(c)).toContain("--resume-id 'new'");
    const spy = vi.spyOn(sharedKiroV2StoreLane, "read"); await b.prepareLaunch(c); b.writeConfig(c);
    expect(b.buildCommand(c)).toContain("--resume-id 'new'"); expect(spy).not.toHaveBeenCalled();
  });
  it("a directory symlink retargeted during preparation cannot adopt its former conversation", async () => {
    const held = deferred<any>(); vi.spyOn(sharedKiroV2StoreLane, "read").mockReturnValueOnce(held.promise);
    const link = join(root, "linked"), next = join(root, "next"); symlinkSync(cwd, link); mkdirSync(next);
    const c = { ...config(), workingDirectory: link }, b = new KiroBackend(c.instanceDir, compat);
    const reading = b.prepareLaunch(c); rmSync(link); symlinkSync(next, link);
    held.resolve({ kind: "ok", sessions: [{ id: "former", updatedAt: 1, createdAt: 1 }], diagnostics: { reads: 1, hits: 0 } }); await reading;
    expect(() => b.writeConfig(c)).toThrow(/not prepared/);
  });
  it("fresh baseline then takes up only one newly created conversation, not an updated old one", async () => {
    file("old"); const b = new KiroBackend(config().instanceDir, compat), c = config();
    await b.prepareLaunch(c); b.writeConfig(c); expect(b.buildCommand(c)).not.toContain("--resume");
    file("old", { updated_at: "2099-01-01T00:00:00Z" });
    await b.prepareLaunch(c); b.writeConfig(c); expect(b.buildCommand(c)).not.toContain("--resume");
    file("new", { created_at: "2099-01-01T00:00:00Z", updated_at: "2099-01-01T00:00:00Z" });
    await b.prepareLaunch(c); b.writeConfig(c); expect(b.buildCommand(c)).toContain("--resume-id 'new'");
  });
  it("preparation never writes identity, rereads newer claims and prevents old results replacing newer preparation", async () => {
    const held = deferred<any>(), spy = vi.spyOn(sharedKiroV2StoreLane, "read").mockReturnValueOnce(held.promise);
    const b = new KiroBackend(config().instanceDir, compat), a = config(); const preparing = b.prepareLaunch(a);
    const opts = { instance: "a", engine: "v2" as const, workingDirectory: cwd, credentialProfile: null, agendHome: join(root, "agend") };
    expect(kiroIdentityNeedsStore(opts)).toBe(true);
    resolveKiroIdentity({ ...opts, launchedBefore: () => true, readStore: () => ({ kind: "ok", sessions: [{ id: "newer", updatedAt: 1 }], createdAt: () => 1 }) });
    expect(kiroIdentityNeedsStore(opts)).toBe(false);
    const current = config(); await b.prepareLaunch(current); held.resolve({ kind: "ok", sessions: [{ id: "old", updatedAt: 99, createdAt: 1 }], diagnostics: { reads: 1, hits: 0 } }); await preparing;
    b.writeConfig(current); expect(b.buildCommand(current)).toContain("--resume-id 'newer'"); expect(spy).toHaveBeenCalledTimes(1);
  });
});
