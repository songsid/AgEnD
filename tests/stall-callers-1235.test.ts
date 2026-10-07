import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
const io = vi.hoisted(() => ({ now: 0, missing: false, read: false,
  exec: vi.fn(), shell: vi.fn(), forbidden: vi.fn(() => { throw new Error("real process/tmux/IPC forbidden"); }) }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: io.exec, spawnSync: io.shell, execSync: io.forbidden, execFile: io.forbidden,
  spawn: io.forbidden, exec: io.forbidden, fork: io.forbidden }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual,
    readFileSync: (...args: any[]) => {
      if (io.read && String(args[0]).endsWith("statusline.json")) {
        io.now += 75; return JSON.stringify({ cost: { total_cost_usd: 12 }, rate_limits: { five_hour: { used_percentage: 80 }, seven_day: { used_percentage: 100 } } });
      }
      return (actual.readFileSync as any)(...args);
    },
    readdirSync: (...args: any[]) => { if (io.missing) throw new Error("optional nvm absent"); return (actual.readdirSync as any)(...args); },
    accessSync: (...args: any[]) => { if (io.missing) throw new Error("not executable"); return (actual.accessSync as any)(...args); },
  };
});
import { resolveBinary } from "../src/backend/types.js";
import { probeKiroCliCompatibility } from "../src/backend/kiro.js";
import { checkBinaryInstalled } from "../src/instance-lifecycle.js";
import { FleetManager } from "../src/fleet-manager.js";
import { StatuslineWatcher } from "../src/statusline-watcher.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { EventLog } from "../src/event-log.js";
import { slowSyncWorkSince, resetSyncWorkAttributionForTests } from "../src/sync-work-attribution.js";
let dir: string;
const tags = () => slowSyncWorkSince(-1, io.now).map(entry => entry.caller);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-1235-observe-"));
  vi.stubEnv("HOME", dir); vi.stubEnv("AGEND_HOME", join(dir, "data")); vi.stubEnv("CODEX_HOME", join(dir, "codex"));
  io.now = 0; io.missing = false; io.read = false; io.exec.mockReset(); io.shell.mockReset(); io.forbidden.mockClear();
  resetSyncWorkAttributionForTests(); vi.spyOn(performance, "now").mockImplementation(() => io.now);
});
afterEach(() => {
  expect(io.forbidden).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  resetSyncWorkAttributionForTests(); rmSync(dir, { recursive: true, force: true });
});
describe("real synchronous caller paths remain unchanged and gain attribution", () => {
  it("names which/npm separately, preserves ordered fallback and installation verdicts", () => {
    io.exec.mockImplementation((exe: string) => { io.now += 75; return exe === "which" ? "/private/grok\n" : "/private/prefix\n"; });
    expect(resolveBinary("grok")).toBe("/private/grok"); expect(tags()).toContain("backend.which");
    expect(checkBinaryInstalled("grok")).toBe(true); expect(tags()).toContain("lifecycle.checkBinaryInstalled");
    io.missing = true; io.exec.mockImplementation((exe: string) => { io.now += 75; if (exe === "which") throw new Error("missing"); return "/private/prefix\n"; });
    expect(resolveBinary("missing")).toBe("missing"); expect(checkBinaryInstalled("missing")).toBe(false);
    expect(tags()).toContain("backend.npmPrefix"); expect(tags()).toContain("backend.resolveBinary");
    expect(io.exec).toHaveBeenCalledWith("npm", ["prefix", "-g"], expect.objectContaining({ timeout: 3000 }));
  });
  it("names the native Kiro version/help paths without altering fail-closed policy", () => {
    io.exec.mockImplementation((_exe: string, args: string[]) => { io.now += 75; if (args[0] === "--version") return "kiro-cli 2.26.0"; throw new Error("help unavailable"); });
    expect(probeKiroCliCompatibility("/private/kiro-cli").source).toBe("version");
    io.exec.mockImplementation(() => { io.now += 75; throw new Error("missing/timeout"); });
    expect(probeKiroCliCompatibility("/private/missing").source).toBe("unknown");
    expect(tags()).toEqual(expect.arrayContaining(["kiro.version", "kiro.help", "kiro.compatibilitySync"]));
  });
  it("names installer bash and validation without changing the synchronous result", () => {
    const path = join(dir, "grok"); writeFileSync(path, "not executed"); chmodSync(path, 0o755);
    const fm: any = new FleetManager(join(dir, "fleet"));
    io.shell.mockImplementation(() => { io.now += 75; return { status: 0, stdout: `${path}\n` }; });
    expect(fm.locateBinaryOnLoginShell("grok")).toBe(path);
    expect(tags()).toEqual(expect.arrayContaining(["fleet.installLoginShell", "fleet.installLookup"]));
    io.shell.mockImplementation(() => { io.now += 75; return { status: 0, stdout: "alias grok='echo nope'" }; });
    expect(fm.locateBinaryOnLoginShell("grok")).toBeNull();
    expect(io.shell).toHaveBeenCalledWith("bash", ["-lc", "command -v grok"], expect.objectContaining({ timeout: 10_000 }));
  });
  it("names the existing statusline tick while retaining cost/rate/failover output", () => {
    vi.useFakeTimers(); io.read = true;
    const ctx: any = { getInstanceDir: () => dir, logger: { info: vi.fn() }, costGuard: { updateCost: vi.fn() }, notifyInstanceTopic: vi.fn(), checkModelFailover: vi.fn() };
    const watcher = new StatuslineWatcher(ctx);
    try {
      watcher.watch("a"); vi.advanceTimersByTime(10_000);
      expect(ctx.costGuard.updateCost).toHaveBeenCalledWith("a", 12);
      expect(ctx.checkModelFailover).toHaveBeenCalledWith("a", 80);
      expect(watcher.getRateLimits("a")).toEqual({ five_hour_pct: 80, seven_day_pct: 100 }); expect(tags()).toContain("statusline.read");
    } finally { watcher.stopAll(); }
  });
  it("names SQLite outbox reads/claim and event insert/query without opening a database", () => {
    const db = { prepare: vi.fn(() => ({ all: vi.fn(() => { io.now += 75; return []; }) })) };
    const outbox: any = Object.create(DeliveryOutbox.prototype); outbox.db = db;
    expect(outbox.listPending()).toEqual([]); expect(outbox.claimNext("manager", () => null, new Set())).toBeUndefined();
    const events: any = Object.create(EventLog.prototype); events.db = db;
    events.insertStmt = { run: vi.fn(() => { io.now += 75; }) };
    events.insert("a", "fixture", { result: "same" }); expect(events.query()).toEqual([]);
    expect(events.insertStmt.run).toHaveBeenCalledWith("a", "fixture", '{"result":"same"}');
    expect(tags()).toEqual(expect.arrayContaining(["outbox.listPending", "outbox.claimNext", "eventLog.insert", "eventLog.query"]));
  });
});
