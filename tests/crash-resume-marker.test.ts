import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

// This harness never launches a backend, binds a socket, or reaches live tmux.
// The real lifecycle and Daemon.start run only as far as the marker reader.
const hooks = vi.hoisted(() => ({
  beforeRead: null as null | (() => void),
  beforeUnlink: null as null | (() => void),
  forbidden: vi.fn((..._args: unknown[]): never => { throw new Error("Forbidden host side effect in crash-marker harness"); }),
}));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  exec: hooks.forbidden, execFile: hooks.forbidden, execSync: hooks.forbidden,
  execFileSync: hooks.forbidden, spawn: hooks.forbidden, spawnSync: hooks.forbidden, fork: hooks.forbidden,
}));
vi.mock("node:net", async importOriginal => ({
  ...await importOriginal<typeof import("node:net")>(),
  createServer: hooks.forbidden, createConnection: hooks.forbidden, connect: hooks.forbidden,
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith("/crash-state.json")) hooks.beforeRead?.();
      return fs.readFileSync(...args);
    },
    unlinkSync: (path: import("node:fs").PathLike) => {
      if (String(path).endsWith("/crash-state.json")) hooks.beforeUnlink?.();
      return fs.unlinkSync(path);
    },
  };
});
vi.mock("../src/backend/factory.js", () => ({
  createBackend: vi.fn(() => ({ binaryName: "mock" })),
}));

import { createBackend } from "../src/backend/factory.js";
import type { CliBackendConfig } from "../src/backend/types.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { Daemon } from "../src/daemon.js";
import { FleetManager } from "../src/fleet-manager.js";
import { InstanceLifecycle, SupersededStartError, type LifecycleContext } from "../src/instance-lifecycle.js";
import type { Logger } from "../src/logger.js";
import { TmuxManager } from "../src/tmux-manager.js";
import type { FleetConfig, InstanceConfig } from "../src/types.js";

const logger = pino({ level: "silent" }) as Logger;
const ipcBoundary = new Error("Expected stop after the real marker reader");
const savedStart = Daemon.prototype.start;
const savedSpawn = (Daemon.prototype as unknown as DaemonInternals).spawnClaudeWindow;
interface DaemonInternals {
  skipResume: boolean;
  buildBackendConfig(): CliBackendConfig;
  spawnClaudeWindow(): Promise<boolean>;
  beginSpawn(): void;
  endSpawn(): void;
  trySpawn(): Promise<boolean>;
}
const internals = (daemon: Daemon) => daemon as unknown as DaemonInternals;

let dir: string;
let marker: string;
let config: InstanceConfig;
let captured: Daemon | undefined;
let atIpc: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agend-crash-marker-"));
  marker = join(dir, "instance", "crash-state.json");
  mkdirSync(join(dir, "instance"));
  mkdirSync(join(dir, "work"));
  config = { working_directory: join(dir, "work"), backend: "mock", workflow: false, agent_mode: "mcp" } as InstanceConfig;
  captured = undefined;
  atIpc = undefined;
  hooks.beforeRead = null;
  hooks.beforeUnlink = null;
  hooks.forbidden.mockClear();
  vi.mocked(createBackend).mockReset().mockReturnValue({ binaryName: "mock" } as ReturnType<typeof createBackend>);
  vi.spyOn(Daemon.prototype, "start").mockImplementation(function (this: Daemon) {
    captured = this;
    return savedStart.call(this);
  });
  vi.spyOn(IpcServer.prototype, "listen").mockImplementation(async () => {
    atIpc?.();
    throw ipcBoundary;
  });
  // startOrDispose must dispose the failed private attempt without a real kill.
  vi.spyOn(Daemon.prototype, "abortStartup").mockResolvedValue(undefined);
  vi.spyOn(TmuxManager, "ensureSession").mockImplementation(hooks.forbidden);
  vi.spyOn(Daemon.prototype as unknown as DaemonInternals, "spawnClaudeWindow").mockImplementation(hooks.forbidden);
});

afterEach(() => {
  const forbiddenCalls = hooks.forbidden.mock.calls.length;
  hooks.beforeRead = null;
  hooks.beforeUnlink = null;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  expect(forbiddenCalls, "no process/backend/IPC/tmux launch is allowed").toBe(0);
});

function lifecycle() {
  const ctx = {
    dataDir: dir, logger, controlClient: null,
    fleetConfig: { defaults: {}, instances: { worker: config } },
    getInstanceDir: () => join(dir, "instance"),
    instanceIpcClients: new Map(), ipcStoppingInstances: new Set(), sessionRegistry: new Map(),
    eventLog: null,
  } as unknown as LifecycleContext;
  return new InstanceLifecycle(ctx);
}

function daemon() {
  return new Daemon("worker", config, join(dir, "instance"), false,
    createBackend("mock", join(dir, "instance")), undefined, logger);
}

describe("#835 recovery intent reaches the real Daemon.start reader", () => {
  it("consumes explicit-fresh-start marker and latches skipResume", async () => {
    // An explicit fresh-start request (not a crash loop) still skips resume.
    writeFileSync(marker, JSON.stringify({ resumeDisabled: true, reason: "pty_error_restart" }));
    const sequence: string[] = [];
    const readStates: Array<{ exists: boolean; skipResume: boolean }> = [];
    const clearStates: boolean[] = [];
    let markerAtIpc: boolean | undefined;
    let skipResumeAtIpc: boolean | undefined;
    hooks.beforeRead = () => {
      sequence.push("read");
      readStates.push({ exists: existsSync(marker), skipResume: internals(captured!).skipResume });
    };
    hooks.beforeUnlink = () => {
      sequence.push("clear");
      clearStates.push(internals(captured!).skipResume);
    };
    atIpc = () => {
      sequence.push("await");
      markerAtIpc = existsSync(marker);
      skipResumeAtIpc = internals(captured!).buildBackendConfig().skipResume;
    };

    const lc = lifecycle();
    await expect(lc.start("worker", config, false)).rejects.toBe(ipcBoundary);

    expect(sequence).toEqual(["read", "clear", "await"]);
    expect(readStates).toEqual([{ exists: true, skipResume: false }]);
    expect(clearStates).toEqual([true]);
    expect(markerAtIpc).toBe(false);
    expect(skipResumeAtIpc).toBe(true);
    expect(internals(captured!).skipResume).toBe(true);
    expect(lc.daemons.size).toBe(0);
    expect(Daemon.prototype.abortStartup).toHaveBeenCalledOnce();
    expect(IpcServer.prototype.listen).toHaveBeenCalledOnce();
  });

  it("crash loop: does NOT skip resume — sets bootCrashLoopResume instead (#2809)", async () => {
    // A real crash loop (3+ crashes in 5 min) should try resume first.
    // skipResume must be false; bootCrashLoopResume must be true.
    writeFileSync(marker, JSON.stringify({ crashesInWindow: 3, lastCrashAt: Date.now(), resumeDisabled: true }));
    let skipResumeAtIpc: boolean | undefined;
    let bootCrashLoopResumeAtIpc: boolean | undefined;
    atIpc = () => {
      skipResumeAtIpc = internals(captured!).buildBackendConfig().skipResume;
      bootCrashLoopResumeAtIpc = (captured as unknown as { bootCrashLoopResume: boolean }).bootCrashLoopResume;
    };

    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);

    expect(skipResumeAtIpc, "crash loop must NOT skip resume").toBe(false);
    expect(bootCrashLoopResumeAtIpc, "crash loop must set bootCrashLoopResume").toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("resumeFailed marker: skips resume (session proved broken after crash-loop-resume) (#2809)", async () => {
    // A previous crash-loop-resume attempt failed → next boot goes fresh.
    writeFileSync(marker, JSON.stringify({ resumeFailed: true, failedAt: Date.now() }));
    let skipResumeAtIpc: boolean | undefined;
    atIpc = () => {
      skipResumeAtIpc = internals(captured!).buildBackendConfig().skipResume;
    };

    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);

    expect(skipResumeAtIpc, "resumeFailed must skip resume").toBe(true);
    expect(internals(captured!).skipResume).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["false", '{"resumeDisabled":false}'],
    ["truthy string", '{"resumeDisabled":"true"}'],
    ["truthy number", '{"resumeDisabled":1}'],
    ["missing flag", '{"crashesInWindow":3}'],
    ["null", "null"],
    ["corrupt JSON", "{broken"],
  ])("does not skip resume for %s, but clears successfully read marker bytes", async (_label, content) => {
    writeFileSync(marker, content);
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(internals(captured!).skipResume).toBe(false);
    expect(internals(captured!).buildBackendConfig().skipResume).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("normal startup has no marker and keeps resume enabled", async () => {
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(internals(captured!).buildBackendConfig().skipResume).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("unreadable recovery intent remains for a later attempt", async () => {
    const content = '{"resumeDisabled":true}';
    writeFileSync(marker, content);
    hooks.beforeRead = () => { throw new Error("stubbed EACCES"); };
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(internals(captured!).skipResume).toBe(false);
    expect(existsSync(marker)).toBe(true);
    hooks.beforeRead = null;
    expect(readFileSync(marker, "utf8")).toBe(content);
  });

  it("best-effort unlink failure does not undo the latched skip flag", async () => {
    writeFileSync(marker, '{"resumeDisabled":true}');
    hooks.beforeUnlink = () => { throw new Error("stubbed unlink EACCES"); };
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(internals(captured!).buildBackendConfig().skipResume).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it("keeps one-shot read consumption even if startup later fails", async () => {
    writeFileSync(marker, '{"resumeDisabled":true}');
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(internals(captured!).skipResume).toBe(true);
    expect(existsSync(marker)).toBe(false);

    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(internals(captured!).buildBackendConfig().skipResume).toBe(false);
  });

  it("successful stubbed CLI startup resets the flag for subsequent spawns", async () => {
    writeFileSync(marker, '{"resumeDisabled":true}');
    const d = daemon();
    await expect(d.start()).rejects.toBe(ipcBoundary);
    const state = internals(d);
    vi.spyOn(state, "beginSpawn").mockImplementation(() => {});
    vi.spyOn(state, "endSpawn").mockImplementation(() => {});
    const trySpawn = vi.spyOn(state, "trySpawn").mockImplementation(async () => {
      expect(state.buildBackendConfig().skipResume).toBe(true);
      return true;
    });
    expect(await savedSpawn.call(d)).toBe(false); // fresh start, not a successful resume
    expect(trySpawn).toHaveBeenCalledOnce();
    expect(state.skipResume).toBe(false);
  });
});

describe("unread marker survives callers that never enter Daemon.start", () => {
  it("retains recovery intent when backend construction fails before the reader", async () => {
    const content = '{"resumeDisabled":true}';
    writeFileSync(marker, content);
    const failure = new Error("stubbed backend construction failure");
    vi.mocked(createBackend).mockImplementation(() => { throw failure; });
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(failure);
    expect(Daemon.prototype.start).not.toHaveBeenCalled();
    expect(IpcServer.prototype.listen).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(content);
  });

  it("retains recovery intent when the launch generation is superseded before the reader", async () => {
    const content = '{"resumeDisabled":true}';
    writeFileSync(marker, content);
    const lc = lifecycle();
    vi.mocked(createBackend).mockImplementation(() => {
      lc.invalidate("worker");
      return { binaryName: "mock" } as ReturnType<typeof createBackend>;
    });
    await expect(lc.start("worker", config, false)).rejects.toBeInstanceOf(SupersededStartError);
    expect(Daemon.prototype.start).not.toHaveBeenCalled();
    expect(IpcServer.prototype.listen).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(content);
  });

  it("FleetManager does not consume a marker on lifecycle's early return", async () => {
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: {}, instances: { worker: config } } as FleetConfig;
    vi.spyOn(fm.memoryPressure, "start").mockImplementation(() => {});
    vi.spyOn(fm.lifecycle, "start").mockResolvedValue(undefined);
    const methods = fm as unknown as {
      connectIpcToInstance(name: string): Promise<void>;
      requestDiscordUsagePresenceRefresh(): void;
    };
    vi.spyOn(methods, "connectIpcToInstance").mockResolvedValue(undefined);
    vi.spyOn(methods, "requestDiscordUsagePresenceRefresh").mockImplementation(() => {});
    const path = join(fm.getInstanceDir("worker"), "crash-state.json");
    mkdirSync(fm.getInstanceDir("worker"), { recursive: true });
    const content = '{"resumeDisabled":true}';
    writeFileSync(path, content);

    await fm.startInstance("worker", config, false, "classic");

    expect(fm.lifecycle.start).toHaveBeenCalledOnce();
    expect(Daemon.prototype.start).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(content);
  });
});

describe("#2809 spawnClaudeWindow: resumeFailed placement and cleanup", () => {
  it("resumeFailed write is guarded by bootCrashLoopResume check in spawnClaudeWindow source (#2809 P2-1 structural)", () => {
    // Structural: resumeFailed is only written inside an `if (this.bootCrashLoopResume)` block
    // that appears directly after setSessionAside — never on the throw/outage paths.
    const src = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("private async spawnClaudeWindow"));
    const setAsidePos = fn.indexOf("this.setSessionAside(");
    const resumeFailedPos = fn.indexOf("resumeFailed: true");
    const bootCrashLoopGuardPos = fn.lastIndexOf("if (this.bootCrashLoopResume)", resumeFailedPos);
    expect(setAsidePos, "setSessionAside must be present").toBeGreaterThan(0);
    expect(resumeFailedPos, "resumeFailed write must be present").toBeGreaterThan(0);
    expect(resumeFailedPos, "resumeFailed must come after setSessionAside").toBeGreaterThan(setAsidePos);
    expect(bootCrashLoopGuardPos, "resumeFailed must be inside bootCrashLoopResume guard").toBeGreaterThan(setAsidePos);
    // Verify the resume-success path also has a bootCrashLoopResume=false and
    // clears any stale resumeFailed from disk
    const elseResumePath = fn.slice(fn.indexOf("} else if (attemptedResume) {"));
    expect(elseResumePath).toContain("bootCrashLoopResume = false");
    expect(elseResumePath).toContain("resumeFailed");
  });

  it("crash-loop-resume: bootCrashLoopResume is set by the boot reader (#2809 P2-2 guard)", async () => {
    // Verify the boot reader sets bootCrashLoopResume for a real crash loop.
    writeFileSync(marker, JSON.stringify({ crashesInWindow: 3, lastCrashAt: Date.now(), resumeDisabled: true }));
    // Read what the daemon instance has after the reader runs (at IpcServer.listen)
    let bootCrashAtIpc: boolean | undefined;
    atIpc = () => {
      bootCrashAtIpc = (captured as unknown as { bootCrashLoopResume: boolean }).bootCrashLoopResume;
    };
    await expect(lifecycle().start("worker", config, false)).rejects.toBe(ipcBoundary);
    expect(bootCrashAtIpc, "bootCrashLoopResume must be true after reading crash-loop marker").toBe(true);
    // skipResume must be false (we try resume)
    expect(internals(captured!).skipResume, "skipResume must be false for crash loop").toBe(false);
  });
  it("fresh-fallback success: clears resumeFailed marker so next restart is not forced fresh (#2809 P2-2 runtime)", async () => {
    // Scenario: crash-loop-resume → trySpawn[1]=false, trySpawn[2]=false →
    // setSessionAside writes resumeFailed + clears bootCrashLoopResume →
    // fresh trySpawn[3]=true → crash-state.json must be gone afterward.
    //
    // Drives real savedSpawn with seams stubbed (no live tmux/process).
    const crashStatePath = join(dir, "instance", "crash-state.json");
    const d = daemon();
    const state = internals(d);

    // Boot reader would have set bootCrashLoopResume — simulate that
    (d as unknown as { bootCrashLoopResume: boolean }).bootCrashLoopResume = true;

    // trySpawn: 1=false, 2=false, 3=true
    let tryCount = 0;
    vi.spyOn(state, "beginSpawn").mockImplementation(() => {});
    vi.spyOn(state, "endSpawn").mockImplementation(() => {});
    vi.spyOn(state, "trySpawn").mockImplementation(async () => {
      tryCount++;
      return tryCount >= 3;
    });

    // Stub setSessionAside: write resumeFailed + clear bootCrashLoopResume (mirrors real path)
    vi.spyOn(d as unknown as { setSessionAside(r: string): void }, "setSessionAside")
      .mockImplementation((_r: string) => {
        writeFileSync(crashStatePath, JSON.stringify({ resumeFailed: true, failedAt: Date.now() }));
        (d as unknown as { bootCrashLoopResume: boolean }).bootCrashLoopResume = false;
      });

    // Stub outage/retained/pane checks that run between trySpawn false and setSessionAside
    vi.spyOn(d as unknown as { noteStartupPaneForBackendOutage(): Promise<void> }, "noteStartupPaneForBackendOutage")
      .mockResolvedValue(undefined);
    vi.spyOn(d as unknown as { failStartupIfBackendUnreachable(): Promise<void> }, "failStartupIfBackendUnreachable")
      .mockResolvedValue(undefined);
    vi.spyOn(d as unknown as { setAsideForeignSession(): void }, "setAsideForeignSession").mockImplementation(() => {});
    vi.spyOn(d as unknown as { killProcessTree(sig: string, reason: string): Promise<void> }, "killProcessTree")
      .mockResolvedValue(undefined);
    // Provide a minimal tmux stub so killWindow doesn't throw
    (d as unknown as { tmux: { killWindow(): Promise<void>; isWindowAlive(): Promise<boolean>; getWindowId(): string; capturePaneWithHistory(n: number): Promise<string> } }).tmux = {
      killWindow: async () => {},
      isWindowAlive: async () => false,
      getWindowId: () => "",
      capturePaneWithHistory: async () => "No conversation found to resume",
    };
    // paneSaysNoConversation reads the pane text that tmux.capturePaneWithHistory returns
    vi.spyOn(d as unknown as { paneSaysNoConversation(t: string | undefined): boolean }, "paneSaysNoConversation")
      .mockReturnValue(true);

    const result = await savedSpawn.call(d);

    expect(tryCount, "3 trySpawn calls: 2 resume-fail + 1 fresh").toBe(3);
    expect(result, "returns false = fresh start").toBe(false);
    expect(existsSync(crashStatePath), "resumeFailed marker cleared after fresh-fallback success").toBe(false);
  });
});