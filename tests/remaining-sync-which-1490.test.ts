/**
 * #1490 row 67: remaining synchronous `which` on spawn and dashboard/browser login.
 * Chat `/login` already uses `isCliInstalledOffLoop` (#2982). These paths still called
 * `checkBinaryInstalled` / `isCliInstalled` on the fleet loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hooks = vi.hoisted(() => ({ syncWhich: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: ((file: string, args?: unknown, opts?: unknown) => {
      if (file === "which") hooks.syncWhich.push(String(Array.isArray(args) ? args[0] : ""));
      return (real.execFileSync as (file: string, args?: unknown, opts?: unknown) => unknown)(file, args, opts);
    }) as typeof real.execFileSync,
  };
});

import { Daemon } from "../src/daemon.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";
import { InstanceLifecycle, SupersededStartError, type LifecycleContext, BACKEND_INSTALLATION_INFO } from "../src/instance-lifecycle.js";
import { FleetManager } from "../src/fleet-manager.js";
import { WebSessionStore, tokenEpoch } from "../src/web-session.js";
import { t } from "../src/locale.js";
import { noteResolvedBinary } from "../src/backend/types.js";
import * as availability from "../src/backend-availability.js";
import { writePendingBackendSignIns } from "../src/backend-signin-pending.js";

const dirs: string[] = [];
afterEach(() => {
  hooks.syncWhich.length = 0;
  noteResolvedBinary("codex", null);
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "agend-1490-which-"));
  dirs.push(d);
  return d;
}

function spawnLifecycle(root: string) {
  vi.spyOn(Daemon.prototype, "start").mockResolvedValue(undefined as never);
  vi.spyOn(Daemon.prototype, "stop").mockResolvedValue();
  vi.spyOn(Daemon.prototype, "abortStartup").mockResolvedValue();
  vi.spyOn(IpcServer.prototype, "listen").mockResolvedValue();
  const errors: unknown[][] = [];
  const logger: any = { info() {}, warn() {}, debug() {}, error: (...a: unknown[]) => { errors.push(a); }, child() { return logger; } };
  const base: Record<string, unknown> = {
    fleetConfig: { defaults: {}, instances: { worker: { backend: "codex" } } },
    logger, eventLog: null, deliveryOutbox: null, controlClient: null, dataDir: root,
    getInstanceDir: (n: string) => join(root, "instances", n),
    isPlannedRestart: () => false,
    notifyInstanceTopic: () => true,
    webhookEmit: () => {}, clearCancelButton: () => {}, instanceIpcClients: new Map(),
    spawnGate: { run: (_task: unknown, operation: () => Promise<unknown>) => operation() },
    stormWindow: null, backendOutage: null,
  };
  const ctx = new Proxy(base, { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }) as unknown as LifecycleContext;
  return { lc: new InstanceLifecycle(ctx), errors };
}

describe("#1490 row 67: spawn PATH probe is async", () => {
  it("with no cached hint and a real constructor, does not run execFileSync(which)", async () => {
    noteResolvedBinary("codex", null);
    const root = scratch();
    const { lc } = spawnLifecycle(root);
    await lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false);
    expect(hooks.syncWhich).toEqual([]);
    expect(lc.daemons.has("worker")).toBe(true);
    expect(Daemon.prototype.start).toHaveBeenCalledOnce();
  });

  it.each([null, undefined] as const)("a missing/unknown pin (%s) still starts without sync which", async (path) => {
    noteResolvedBinary("codex", null);
    vi.spyOn(availability, "pinResolvedBinary").mockImplementation(async (backend) => {
      noteResolvedBinary(BACKEND_INSTALLATION_INFO[backend]!.binary, BACKEND_INSTALLATION_INFO[backend]!.binary);
      return path;
    });
    const root = scratch();
    const { lc, errors } = spawnLifecycle(root);
    await lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false);
    expect(hooks.syncWhich).toEqual([]);
    expect(lc.daemons.has("worker")).toBe(true);
    expect(errors.some(a => String(a[1] ?? a[0]).includes("not found in PATH"))).toBe(true);
  });

  it("a superseded start during the off-loop pin does not construct or which", async () => {
    noteResolvedBinary("codex", null);
    let finish!: (value: string | null | undefined) => void;
    const pinStarted = new Promise<void>(resolve => {
      vi.spyOn(availability, "pinResolvedBinary").mockImplementation(() => {
        resolve();
        return new Promise(r => { finish = r; });
      });
    });
    const root = scratch();
    const { lc } = spawnLifecycle(root);
    const starting = lc.start("worker", { working_directory: join(root, "w"), backend: "codex" } as never, false);
    await pinStarted;
    lc.invalidate("worker");
    finish(null);
    await expect(starting).rejects.toBeInstanceOf(SupersededStartError);
    expect(Daemon.prototype.start).not.toHaveBeenCalled();
    expect(hooks.syncWhich).toEqual([]);
    expect(lc.daemons.has("worker")).toBe(false);
  });
});

function makeFleet() {
  const dir = scratch();
  const fm = new FleetManager(dir) as any;
  fm.fleetConfig = { defaults: {}, instances: {} };
  const start = vi.fn(async (b: string) => `started:${b}`);
  fm.loginController = { start, webAccessToken: vi.fn(), isActiveFor: vi.fn(() => false), isActive: () => false };
  const sessions = new WebSessionStore({});
  fm.webSessions = sessions;
  Object.defineProperty(fm, "webToken", { get: () => "scratch-token", configurable: true });
  const owner = sessions.create({ tier: "admin", surface: "local", label: "Scratch", tokenEpoch: tokenEpoch("scratch-token") }).record;
  return { fm, start, owner, dir };
}

const chat = { adapter: {} as never, adapterId: "web", chatId: "web", userId: "web:x" };

describe("#1490 row 67: dashboard and browser PATH probes stay off the fleet loop", () => {
  it("dashboard login uses the async probe; a missing CLI still returns the install command", async () => {
    const { fm, start } = makeFleet();
    vi.spyOn(fm, "isCliInstalled").mockImplementation(() => { throw new Error("synchronous which on dashboard login"); });
    vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(false);
    expect(await fm.startWebDashboardLogin("codex", chat, {})).toBe(
      t("login.web_dashboard_not_installed", "codex", BACKEND_INSTALLATION_INFO.codex!.install),
    );
    expect(fm.isCliInstalled).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("an installed dashboard CLI still reaches the controller, without the sync probe", async () => {
    const { fm, start } = makeFleet();
    vi.spyOn(fm, "isCliInstalled").mockImplementation(() => { throw new Error("synchronous which on dashboard login"); });
    vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(true);
    expect(await fm.startWebDashboardLogin("claude", chat, { skipAuthCheck: true })).toBe("started:claude");
    expect(fm.isCliInstalled).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith("claude", chat, { skipAuthCheck: true });
  });

  it("browser sign-in installed list uses the async probe; unknown/false stays filtered out", async () => {
    const { fm, owner, dir } = makeFleet();
    writePendingBackendSignIns(dir, {
      version: 1,
      selected: ["kiro-cli", "claude-code", "codex", "antigravity"],
      pending: ["kiro-cli", "claude-code", "codex", "antigravity"],
    });
    vi.spyOn(fm, "isCliInstalled").mockImplementation(() => { throw new Error("synchronous which on browser sign-in"); });
    vi.spyOn(fm, "isCliInstalledOffLoop").mockResolvedValue(false);
    const snap = await fm.browserBackendSignIns.refresh(owner);
    expect(fm.isCliInstalled).not.toHaveBeenCalled();
    expect(snap.states.codex).toBe("not_installed");
    expect(snap.states["claude-code"]).toBe("not_installed");
    expect(snap.states["kiro-cli"]).toBe("not_installed");
    expect(snap.states.antigravity).toBe("not_installed");
  });
});
