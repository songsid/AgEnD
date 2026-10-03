import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { OpenCodeBackend } from "../src/backend/opencode.js";
import { TmuxManager } from "../src/tmux-manager.js";

/**
 * #1160 (C): the session-id checkpoint never forks a CLI on the event loop. Idle observations look in
 * the background (single-flight, throttled); lifecycle transitions wait for the lookup, bounded.
 */
let dir: string;
let instanceDir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
  dir = mkdtempSync(join(tmpdir(), "agend-ckpt-1160-"));
  instanceDir = join(dir, "instance");
  mkdirSync(instanceDir, { recursive: true });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

interface FakeBackend {
  binaryName: string;
  getSessionId: ReturnType<typeof vi.fn>;
  refreshSessionId?: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}
function backendWith(binaryName: string, refresh: "none" | "pending" | "resolves", id = { current: null as string | null }): { backend: FakeBackend; id: typeof id; release: () => void } {
  let release: () => void = () => {};
  const backend: FakeBackend = {
    binaryName,
    getSessionId: vi.fn(() => id.current),
    getReadyPattern: () => /./,
  };
  if (refresh === "pending") backend.refreshSessionId = vi.fn(() => new Promise<string | null>(resolve => { release = () => resolve(id.current); }));
  if (refresh === "resolves") backend.refreshSessionId = vi.fn(async () => { id.current = "ses_found"; return id.current; });
  return { backend, id, release: () => release() };
}
function daemon(backend: unknown, extra: Record<string, unknown> = {}): any {
  const d: any = new Daemon("test-oc", {
    working_directory: dir, backend: "opencode",
    restart_policy: { max_retries: 5, backoff: "linear", reset_after: 0, health_check_interval_ms: 1_000 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent", ...extra,
  } as any, instanceDir, false, backend as never, undefined, logger);
  return d;
}
const idle = (d: any) => {
  const now = Date.now();
  d.instanceState = "working";
  d.applyInstanceStateSnapshot({ state: "idle", unchangedForMs: 0, observedAt: now, stateChangedAt: now });
};
const persisted = () => existsSync(join(instanceDir, "session-id")) ? readFileSync(join(instanceDir, "session-id"), "utf8") : null;

describe("idle observations: background, single-flight, throttled", () => {
  it("an idle snapshot does not wait for the lookup: it starts it and returns", () => {
    const { backend } = backendWith("opencode", "pending");
    const d = daemon(backend);
    idle(d);                                                       // returns at once although the lookup never finishes
    expect(backend.refreshSessionId).toHaveBeenCalledTimes(1);
  });

  it("repeated idle observations inside the throttle window do not ask again; after it they do", async () => {
    const { backend } = backendWith("opencode", "resolves");
    const d = daemon(backend);
    idle(d); await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 10; i++) { idle(d); await vi.advanceTimersByTimeAsync(2_000); }     // 20 s of idle edges
    expect(backend.refreshSessionId).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11_000);                                                 // now past 30 s since the first
    idle(d);
    expect(backend.refreshSessionId).toHaveBeenCalledTimes(2);
  });

  it("what the lookup finds is persisted when it finishes, and what was already known at once", async () => {
    const id = { current: "ses_known" as string | null };
    const { backend } = backendWith("opencode", "resolves", id);
    backend.refreshSessionId = vi.fn(async () => { id.current = "ses_found"; return id.current; });
    const d = daemon(backend);
    idle(d);
    expect(persisted()).toBe("ses_known");                         // the cache answers synchronously
    await vi.advanceTimersByTimeAsync(1);
    expect(persisted()).toBe("ses_found");                         // the finished lookup is checkpointed
  });

  it("a lookup that rejects is swallowed", async () => {
    const { backend } = backendWith("opencode", "none");
    backend.refreshSessionId = vi.fn(async () => { throw new Error("spawn EAGAIN"); });
    const d = daemon(backend);
    idle(d);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.refreshSessionId).toHaveBeenCalledTimes(1);     // and nothing blew up
  });

  it("only opencode checkpoints on idle (other backends keep their behaviour)", async () => {
    const { backend } = backendWith("claude", "resolves");
    const d = daemon(backend);
    idle(d);
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.refreshSessionId).not.toHaveBeenCalled();
    expect(backend.getSessionId).not.toHaveBeenCalled();
  });

  it("with the real backend, an idle edge and a stop-time checkpoint share ONE CLI run", async () => {
    const backend = new OpenCodeBackend(instanceDir);
    backend.buildCommand({ workingDirectory: dir, instanceDir, instanceName: "t", mcpServers: {} } as never);
    let release!: () => void; let runs = 0;
    (backend as unknown as { listSessions: () => Promise<unknown> }).listSessions = () => { runs++; return new Promise(resolve => { release = () => resolve([{ id: "ses_ours", directory: dir, created: Date.now() + 10, updated: Date.now() + 20 }]); }); };
    const d = daemon(backend);
    idle(d);
    const checkpoint = d.checkpointSessionId() as Promise<void>;
    expect(runs).toBe(1);
    release();
    await checkpoint;
    expect(runs).toBe(1);
    expect(persisted()).toBe("ses_ours");
  });
});

describe("lifecycle transitions: wait for the lookup, bounded", () => {
  it("a backend with no CLI lookup is saved synchronously, exactly as before (no promise)", () => {
    const id = { current: "ses_file" as string | null };
    const { backend } = backendWith("claude", "none", id);
    const d = daemon(backend);
    expect(d.checkpointSessionId()).toBeUndefined();
    expect(persisted()).toBe("ses_file");
  });

  it("waits for the lookup and persists the CURRENT id, not a stale cache", async () => {
    const id = { current: "ses_stale" as string | null };
    const { backend } = backendWith("opencode", "none", id);
    backend.refreshSessionId = vi.fn(async () => { await new Promise(r => setTimeout(r, 800)); id.current = "ses_current"; return id.current; });
    const d = daemon(backend);
    const done = d.checkpointSessionId() as Promise<void>;
    await vi.advanceTimersByTimeAsync(799);
    expect(persisted()).toBeNull();                                // still waiting
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(persisted()).toBe("ses_current");
  });

  it("a lookup that never finishes holds a transition for 5 s, not for ever, and then the cache is saved", async () => {
    const id = { current: "ses_cached" as string | null };
    const { backend } = backendWith("opencode", "pending", id);
    const d = daemon(backend);
    let settled = false;
    void (d.checkpointSessionId() as Promise<void>).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
    expect(persisted()).toBe("ses_cached");
  });

  it("a lookup that rejects does not stop the transition: the cache is saved", async () => {
    const id = { current: "ses_cached" as string | null };
    const { backend } = backendWith("opencode", "none", id);
    backend.refreshSessionId = vi.fn(async () => { throw new Error("boom"); });
    const d = daemon(backend);
    await d.checkpointSessionId();
    expect(persisted()).toBe("ses_cached");
  });

  it("after a resume failure (skipResume) nothing is persisted and nothing is looked up — the existing rule", async () => {
    const { backend } = backendWith("opencode", "resolves");
    const d = daemon(backend);
    d.skipResume = true;
    await d.checkpointSessionId();
    expect(persisted()).toBeNull();
    expect(backend.refreshSessionId).not.toHaveBeenCalled();
  });

  it("pause() waits for the lookup before it quits the CLI", async () => {
    const id = { current: "ses_cached" as string | null };
    const { backend } = backendWith("opencode", "none", id);
    const order: string[] = [];
    backend.refreshSessionId = vi.fn(async () => { order.push("lookup:start"); await new Promise(r => setTimeout(r, 1_500)); order.push("lookup:done"); id.current = "ses_current"; return id.current; });
    const d = daemon(backend);
    d.instanceState = "idle";
    d.tmux = { getWindowId: () => "@1", getPaneStatus: vi.fn(async () => ({ alive: false })), killWindow: vi.fn(async () => {}) };
    d.sendQuitSequence = vi.fn(async () => { order.push("quit"); return true; });
    d.freezeRuntimeMonitors = () => {};
    const pausing = d.pause("operator");
    await vi.advanceTimersByTimeAsync(10_000);
    await pausing.catch(() => {});
    expect(order.slice(0, 3)).toEqual(["lookup:start", "lookup:done", "quit"]);
    expect(persisted()).toBe("ses_current");
  });

  it("start() waits for the lookup before it kills the previous run's window", async () => {
    const id = { current: "ses_cached" as string | null };
    const { backend } = backendWith("opencode", "none", id);
    const order: string[] = [];
    backend.refreshSessionId = vi.fn(async () => { order.push("lookup:start"); await new Promise(r => setTimeout(r, 1_500)); order.push("lookup:done"); id.current = "ses_current"; return id.current; });
    const d = daemon(backend);
    writeFileSync(join(instanceDir, "window-id"), "@77");
    vi.spyOn(TmuxManager, "ensureSession").mockResolvedValue(undefined);
    vi.spyOn(TmuxManager.prototype, "isWindowAlive").mockResolvedValue(true);
    vi.spyOn(TmuxManager.prototype, "killWindow").mockImplementation(async () => { order.push("kill"); });
    d.spawnClaudeWindow = async () => { throw new Error("stop after the old window is gone"); };
    const starting = d.start().catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(10_000);
    await starting;
    expect(order.slice(0, 3)).toEqual(["lookup:start", "lookup:done", "kill"]);
    await d.ipcServer?.close?.();
  });

  it("stop() pauses the health check BEFORE it waits, so no tick can run in the wait", async () => {
    const { backend } = backendWith("opencode", "pending");
    const d = daemon(backend);
    let pausedWhileWaiting: boolean | null = null;
    const wait = d.checkpointSessionId.bind(d);
    d.checkpointSessionId = () => { pausedWhileWaiting = d.healthCheckPaused; return wait(); };
    d.tmux = { getWindowId: () => "@1", getPaneStatus: vi.fn(async () => null), killWindow: vi.fn(async () => {}) };
    d.sendQuitSequence = vi.fn(async () => false);
    d.drainBusyKiroForStop = vi.fn(async () => true);
    d.killProcessTree = vi.fn(async () => {});
    const stopping = d.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(pausedWhileWaiting).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    await stopping;
    expect(d.tmux.killWindow).toHaveBeenCalled();                  // and it did finish
  });
});

describe("crash respawn inside the health tick", () => {
  it("looks the session up (bounded) before it respawns, and respawns after", async () => {
    vi.spyOn(TmuxManager, "sessionExists").mockResolvedValue(true);
    vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(4242);
    vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([] as never);          // the window is gone, the server is alive
    const id = { current: "ses_cached" as string | null };
    const { backend } = backendWith("opencode", "none", id);
    const order: string[] = [];
    backend.refreshSessionId = vi.fn(async () => { order.push("lookup:start"); await new Promise(r => setTimeout(r, 2_000)); order.push("lookup:done"); id.current = "ses_current"; return id.current; });
    const d = daemon(backend);
    d.tmux = { getPaneStatus: vi.fn(async () => null), getWindowId: () => "@1", capturePaneWithHistory: vi.fn(async () => ""), killWindow: vi.fn(async () => {}) };
    d.lastSpawnAt = 1;
    d.setProcessStatus("running");
    d.checkMcpServerAlive = () => {};
    d.spawnClaudeWindow = async () => { order.push("respawn"); return true; };
    d.writeRotationSnapshot = () => {}; d.injectSnapshotMessage = async () => {};
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(order.slice(0, 3)).toEqual(["lookup:start", "lookup:done", "respawn"]);
    expect(persisted()).toBe("ses_current");
    d.stopHealthCheck?.();
  });
});

describe("a crash tick that is already past the health check when stop() / pause() lands (#1160 review)", () => {
  function rig(backendKind: "opencode" | "claude", lookupMs: number | "pending") {
    vi.spyOn(TmuxManager, "sessionExists").mockResolvedValue(true);
    vi.spyOn(TmuxManager, "getServerPid").mockResolvedValue(4242);
    vi.spyOn(TmuxManager, "listWindows").mockResolvedValue([] as never);
    const id = { current: "ses_cached" as string | null };
    const { backend, release } = backendWith(backendKind, "none", id);
    const order: string[] = [];
    if (backendKind === "opencode") {
      backend.refreshSessionId = vi.fn(() => {
        order.push("lookup:start");
        return new Promise<string | null>(resolve => {
          const done = () => { order.push("lookup:done"); resolve(id.current); };
          if (lookupMs === "pending") release2 = done; else setTimeout(done, lookupMs);
        });
      });
    }
    let release2: () => void = () => {};
    const d = daemon(backend);
    const killWindow = vi.fn(async () => {});
    d.tmux = { getPaneStatus: vi.fn(async () => null), getWindowId: () => "@1", capturePaneWithHistory: vi.fn(async () => ""), killWindow };
    d.lastSpawnAt = 1;
    d.setProcessStatus("running");
    d.checkMcpServerAlive = () => {};
    d.spawnClaudeWindow = vi.fn(async () => { order.push("respawn"); return true; });
    d.writeRotationSnapshot = vi.fn(); d.injectSnapshotMessage = async () => {};
    d.transcriptMonitor = { resetOffset: vi.fn(), stop: () => {} };
    return { d, order, releaseLookup: () => release2(), killWindow };
  }

  it("stop() during the session lookup: when it settles nothing is cleared and nothing is respawned", async () => {
    const { d, order, releaseLookup } = rig("opencode", "pending");
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(order).toEqual(["lookup:start"]);                  // the tick is parked in the lookup
    d.healthCheckPaused = true;                               // what stop() does
    releaseLookup();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(order).toEqual(["lookup:start", "lookup:done"]);   // no "respawn"
    expect(d.spawnClaudeWindow).not.toHaveBeenCalled();
    expect(d.transcriptMonitor.resetOffset).not.toHaveBeenCalled();
    expect(d.writeRotationSnapshot).not.toHaveBeenCalled();
    d.stopHealthCheck?.();
  });

  it("pause() (runtime monitors frozen) during the lookup: the same", async () => {
    const { d, order, releaseLookup } = rig("opencode", "pending");
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(6_000);
    d.runtimeMonitorsFrozen = true;                           // what pause() does (freezeRuntimeMonitors)
    releaseLookup();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(d.spawnClaudeWindow).not.toHaveBeenCalled();
    expect(order).not.toContain("respawn");
    d.stopHealthCheck?.();
  });

  it("stop() during the BACKOFF delay (a backend with no lookup): no respawn either — the hole was older than the lookup", async () => {
    const { d } = rig("claude", 0);
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(2_700);                 // tick + 1.5 s recheck, now inside the 1 s backoff delay
    d.healthCheckPaused = true;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(d.spawnClaudeWindow).not.toHaveBeenCalled();
    d.stopHealthCheck?.();
  });

  it("control: with nobody stopping it the same tick does respawn after the lookup", async () => {
    const { d, order } = rig("opencode", 800);
    d.startHealthCheck();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(order.slice(0, 3)).toEqual(["lookup:start", "lookup:done", "respawn"]);
    d.stopHealthCheck?.();
  });
});

