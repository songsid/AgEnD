import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { mcpServerState } from "../src/mcp-liveness.js";

/**
 * #663. An external user's Codex instance was force-restarted 18 times in two
 * days while doing image work.
 *
 * Codex <0.146 tears down and recreates ALL MCP connections on an auth/config
 * change, healthy ones included, so the daemon's health tick sees the old pid
 * die while Codex itself is fine and a replacement is seconds away. The daemon
 * armed a revival restart and then fired it on the next busy->idle edge without
 * ever looking again — inside the ~30s before the next health tick could stand
 * it down. The restart hit a perfectly healthy instance.
 *
 * The bug is not Codex-specific: any CLI that legitimately respawns its MCP
 * child hits it. Codex image turns are just a high-frequency trigger.
 */
let instanceDir: string;
const dirs: string[] = [];

beforeEach(() => {
  instanceDir = mkdtempSync(join(tmpdir(), "agend-mcp663-"));
  dirs.push(instanceDir);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

const PID_FILE = () => join(instanceDir, "channel.mcp.pid");
/** A pid that is certainly gone: our own pid + a large offset never allocated. */
const DEAD_PID = 0x7ffffff0;
const LIVE_PID = process.pid;

function makeDaemon(backend = "codex") {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("img", {
    working_directory: "/tmp",
    backend,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, { getReadyPattern: () => /^> /m } as any, undefined,
    { child: () => logger } as any);
  const died: any[] = [];
  const restarts: any[] = [];
  daemon.on("mcp_died", e => died.push(e));
  daemon.on("mcp_restart_requested", e => restarts.push(e));
  return { daemon: daemon as any, died, restarts, logger };
}

/** Drive the health tick's MCP check directly. */
const tick = (d: any) => d.checkMcpServerAlive();
/** Drive the busy->idle edge that fires the revival restart. */
const idleEdge = (d: any) =>
  d.applyInstanceStateSnapshot({ state: "idle", stateChangedAt: 0, unchangedForMs: 1000 });

describe("a CLI-replaced MCP server must not restart the instance (#663)", () => {
  it("1. dead old pid then a live replacement: no alarm, no restart", async () => {
    const { daemon, died, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));

    tick(daemon);                                   // health check sees the corpse
    expect(daemon.mcpRestartPending).toBe(true);    // revival armed
    expect(died).toHaveLength(0);                   // ...but the alarm is held

    writeFileSync(PID_FILE(), String(LIVE_PID));    // Codex respawns its child
    idleEdge(daemon);                               // the turn ends

    // The authoritative re-read at the chokepoint sees the replacement.
    expect(daemon.mcpRestartPending).toBe(false);
    expect(restarts).toHaveLength(0);
    expect(died).toHaveLength(0);
  });

  it("2. replacement that only arrives during the grace window still cancels", async () => {
    vi.useFakeTimers();
    const { daemon, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);
    idleEdge(daemon);                               // still dead -> grace starts
    expect(restarts).toHaveLength(0);

    writeFileSync(PID_FILE(), String(LIVE_PID));    // lands mid-grace
    await vi.advanceTimersByTimeAsync(2_500);

    expect(restarts).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(false);
  });

  it("3. no replacement: exactly one mcp_died, then the restart", async () => {
    vi.useFakeTimers();
    const { daemon, died, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));

    tick(daemon);                 // first sighting: deferred
    tick(daemon);                 // still dead: now reported
    expect(died).toHaveLength(1);

    idleEdge(daemon);
    await vi.advanceTimersByTimeAsync(2_500);

    expect(restarts).toHaveLength(1);
    expect(died).toHaveLength(1); // exactly one, not one per tick
  });

  it("5. a non-Codex backend keeps the old immediate-alarm behaviour", () => {
    const { daemon, died } = makeDaemon("claude-code");
    writeFileSync(PID_FILE(), String(DEAD_PID));

    tick(daemon);

    // No deferral for backends where a dead MCP under a live CLI is real.
    expect(died).toHaveLength(1);
    expect(daemon.mcpRestartPending).toBe(true);
  });

  it("7. R1: an external session's mcp_ready must not stand down our restart", () => {
    const { daemon } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon); tick(daemon);
    expect(daemon.mcpRestartPending).toBe(true);

    const sock = { on: () => {} } as any;
    // Even with a live pid on disk, a FOREIGN session may not clear our pending.
    writeFileSync(PID_FILE(), String(LIVE_PID));
    daemon.handleMcpReady({ type: "mcp_ready", sessionName: "external-other-4242", pid: LIVE_PID }, sock);
    expect(daemon.mcpRestartPending).toBe(true);

    // Our own server announcing itself does clear it.
    daemon.handleMcpReady({ type: "mcp_ready", sessionName: "img", pid: LIVE_PID }, sock);
    expect(daemon.mcpRestartPending).toBe(false);
  });

  it("8. already_idle and stale_timeout are protected by the same chokepoint", async () => {
    vi.useFakeTimers();
    const { daemon, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    daemon.instanceState = "idle";                  // armMcpRestartWhenIdle -> already_idle
    tick(daemon); tick(daemon);

    writeFileSync(PID_FILE(), String(LIVE_PID));    // replacement during the grace
    await vi.advanceTimersByTimeAsync(2_500);
    expect(restarts).toHaveLength(0);

    // stale_timeout takes the same path.
    const fresh = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    fresh.daemon.checkMcpServerAlive(); fresh.daemon.checkMcpServerAlive();
    writeFileSync(PID_FILE(), String(LIVE_PID));
    fresh.daemon.fireMcpRestartRequest("stale_timeout");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fresh.restarts).toHaveLength(0);
  });

  it("9. R3: a deferral that turns out to be a real loss still reports", async () => {
    vi.useFakeTimers();
    const { daemon, died, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));

    tick(daemon);                 // deferred, alarm withheld, restart armed
    expect(died).toHaveLength(0);
    idleEdge(daemon);
    await vi.advanceTimersByTimeAsync(2_500);

    // instance-lifecycle documents that it assumes the notification already
    // went out when it decides whether to suppress the restart, and this daemon
    // does not survive the restart to send it later.
    expect(died).toHaveLength(1);
    expect(restarts).toHaveLength(1);
    const deathIdx = died[0], restartIdx = restarts[0];
    expect(deathIdx).toBeTruthy(); expect(restartIdx).toBeTruthy();
  });

  it("10. both death shapes: SIGKILL leaves a stale pid file, exit(0) unlinks it", () => {
    // SIGKILL -> file present, pid gone -> "dead" -> the incident we report.
    writeFileSync(PID_FILE(), String(DEAD_PID));
    expect(mcpServerState(instanceDir)).toMatchObject({ state: "dead", pid: DEAD_PID });

    // Clean exit -> file unlinked -> "unknown" -> never alarm (every startup
    // would otherwise alert).
    unlinkSync(PID_FILE());
    expect(mcpServerState(instanceDir)).toEqual({ state: "unknown" });

    const { daemon, died } = makeDaemon();
    tick(daemon);
    expect(died).toHaveLength(0);
    expect(existsSync(PID_FILE())).toBe(false);
  });
});

describe("zombie protection is not weakened by the recovery changes", () => {
  it("4. a recovery already in flight cancels the revival rather than stacking on it", async () => {
    // A real parent/pane death goes down the crash path, which sets spawning /
    // healthCheckPaused. The transient branch must never turn that into a
    // second restart fighting the first.
    vi.useFakeTimers();
    const { daemon, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon); tick(daemon);
    expect(daemon.mcpRestartPending).toBe(true);

    daemon.spawning = true;               // crash respawn underway
    daemon.fireMcpRestartRequest("idle_edge");
    await vi.advanceTimersByTimeAsync(2_500);

    expect(restarts).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(false);
  });

  it("6. the MCP server still exits when its stdin closes, and no longer claims the parent died", async () => {
    // stdio EOF is irreversible, so this exit MUST stay — turning it into a
    // reconnect would orphan the server on a real parent death. Only the
    // wording changed: Codex closing a healthy child's pipe made the old
    // message assert something false.
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "agend-mcpexit-"));
    dirs.push(dir);
    const child = spawn(process.execPath, ["dist/channel/mcp-server.js"], {
      env: { ...process.env, AGEND_SOCKET_PATH: join(dir, "channel.sock"), AGEND_INSTANCE_NAME: "img" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", d => { stderr += String(d); });

    const exited = new Promise<number | null>(res => child.on("exit", code => res(code)));
    await new Promise(r => setTimeout(r, 600));   // let it boot
    child.stdin.end();                            // the EOF under test

    const code = await Promise.race([
      exited,
      new Promise<null>(r => setTimeout(() => r(null), 6_000)),
    ]);
    if (code === null) child.kill("SIGKILL");

    expect(code).not.toBeNull();                  // it exits — no zombie
    if (/stdin (EOF|closed)/.test(stderr)) {
      expect(stderr).not.toMatch(/\(parent exited\)/);
      expect(stderr).toMatch(/parent exited or closed the pipe/);
    }
  }, 20_000);
});
