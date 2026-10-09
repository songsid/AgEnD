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
  it.each([
    ["crash loop", { crashesInWindow: 3, resumeDisabled: true }],
    ["explicit fresh start (no crash count)", { resumeDisabled: true, reason: "pty_error_restart" }],
  ])("consumes %s after latching skipResume, before the first startup await", async (_label, state) => {
    writeFileSync(marker, JSON.stringify(state));
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
