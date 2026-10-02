import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it, afterEach, vi } from "vitest";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";
import { Daemon } from "../src/daemon.js";
import { InstanceLifecycle, type LifecycleContext, type IncidentEventSource } from "../src/instance-lifecycle.js";
import type { Logger } from "../src/logger.js";
import { mcpServerState } from "../src/mcp-liveness.js";
import { t } from "../src/locale.js";

/**
 * #1111: kiro launched with --require-mcp-startup, which exits 3 when ANY
 * enabled MCP server fails — the user's third-party ones included. A
 * third-party server (outline) breaking on kiro-cli 2.27 stopped every kiro
 * instance. The flag is gone; what it was there for — "AgEnD's own server must
 * come up" — is now the daemon's check, which knows which server is which and
 * applies to every backend: a CLI that has been up past the startup grace with
 * no server for this instance ever serving is reported, and revived.
 */

vi.mock("../src/mcp-liveness.js", () => ({
  mcpServerState: vi.fn(() => ({ state: "unknown" })),
}));
const liveness = vi.mocked(mcpServerState);

const rootLogger = pino({ level: "silent" }) as Logger;
type AnyDaemon = Daemon & Record<string, any>;

const GRACE_MS = 90_000;

function makeDaemon(overrides: Record<string, unknown> = {}): { daemon: AnyDaemon; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agend-mcp-never-"));
  const daemon = new Daemon("never-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
    ...overrides,
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;
  return { daemon, dir };
}

/** A CLI whose spawn (generation `gen`) finished `agoMs` ago. */
function startedAgo(daemon: AnyDaemon, agoMs: number, gen = 1): void {
  daemon["spawnGeneration"] = gen;
  daemon["lastSpawnAt"] = Date.now() - agoMs;
}

describe("daemon: a fleet MCP server that never connects is an incident (#1111)", () => {
  let dir: string;
  afterEach(() => {
    vi.useRealTimers();
    liveness.mockReset();
    liveness.mockReturnValue({ state: "unknown" } as any);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports and arms the revival restart once the startup grace has passed with no server", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon["instanceState"] = "working"; // keep the restart armed, not fired
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS + 1);

    daemon["checkMcpServerAlive"]();

    expect(died).toHaveBeenCalledWith({ name: "never-test", pid: 0, autoRestart: true, authSuspected: false, neverConnected: true });
    expect(daemon["mcpRestartPending"]).toBe(true);
  });

  it("stays quiet inside the grace — the CLI may not have spawned its server yet", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS - 5_000);

    daemon["checkMcpServerAlive"]();

    expect(died).not.toHaveBeenCalled();
  });

  it("stays quiet before the first spawn has finished", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);

    daemon["checkMcpServerAlive"]();

    expect(died).not.toHaveBeenCalled();
  });

  it("stays quiet when this spawn's server already served (mcp_ready), even if its pid slot is gone", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS + 1);

    daemon["noteMcpProofOfLife"]("mcp_ready", 4242);
    daemon["checkMcpServerAlive"]();

    expect(died).not.toHaveBeenCalled();
  });

  it("a server seen alive in an EARLIER spawn does not cover the current one", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS + 1, 1);
    daemon["noteMcpProofOfLife"]("mcp_ready", 4242);

    startedAgo(daemon, GRACE_MS + 1, 2); // respawned; the new CLI never brought one up
    daemon["checkMcpServerAlive"]();

    expect(died).toHaveBeenCalledOnce();
  });

  it("stays quiet in agent_mode: cli — there is no MCP server by design", () => {
    const made = makeDaemon({ agent_mode: "cli" }); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS + 1);

    daemon["checkMcpServerAlive"]();

    expect(died).not.toHaveBeenCalled();
  });

  it("reports once per spawn, not every health tick", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS + 1);

    daemon["checkMcpServerAlive"]();
    daemon["checkMcpServerAlive"]();
    daemon["checkMcpServerAlive"]();

    expect(died).toHaveBeenCalledOnce();
  });

  it("mcp_auto_restart: false reports without arming a restart", () => {
    const made = makeDaemon({ mcp_auto_restart: false }); dir = made.dir;
    const { daemon } = made;
    const died = vi.fn();
    daemon.on("mcp_died", died);
    startedAgo(daemon, GRACE_MS + 1);

    daemon["checkMcpServerAlive"]();

    expect(died).toHaveBeenCalledWith(expect.objectContaining({ autoRestart: false, neverConnected: true }));
    expect(daemon["mcpRestartPending"]).toBe(false);
  });

  it("a server that connects late retracts the alarm as a late connect and stands the restart down", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon } = made;
    daemon["instanceState"] = "working";
    const recovered = vi.fn();
    daemon.on("mcp_recovered", recovered);
    startedAgo(daemon, GRACE_MS + 1);
    daemon["checkMcpServerAlive"]();

    daemon["noteMcpProofOfLife"]("mcp_ready", 5151);

    expect(recovered).toHaveBeenCalledWith({ name: "never-test", source: "late_connect", pid: 5151 });
    expect(daemon["mcpRestartPending"]).toBe(false);
  });
});

// ── Lifecycle side: the notice says what actually happened ─────────────────

function makeLifecycle() {
  const notifyInstanceTopic = vi.fn();
  const ctx = {
    fleetConfig: { instances: { worker: { backend: "kiro-cli" } }, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: null,
    isPlannedRestart: () => false,
    notifyInstanceTopic,
    webhookEmit() {},
    clearCancelButton() {},
    checkModelFailover() {},
    setTopicIcon() {},
    restartSingleInstance: vi.fn(async () => {}),
  } as unknown as LifecycleContext;
  const lifecycle = new InstanceLifecycle(ctx);
  const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} }) as unknown as IncidentEventSource & EventEmitter;
  lifecycle.attachIncidentHandlers("worker", daemon);
  return { daemon, notifyInstanceTopic };
}

describe("lifecycle: never-connected notice and its retraction (#1111)", () => {
  afterEach(() => setAuthCheckRunnerForTests(null));

  it("says the server never connected (not that it died), with the auto or manual follow-up", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: '{"loggedIn": true}' }));
    const { daemon, notifyInstanceTopic } = makeLifecycle();

    daemon.emit("mcp_died", { name: "worker", pid: 0, autoRestart: true, neverConnected: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenLastCalledWith("worker", t("inst.mcp_never_connected_auto", "worker")));

    daemon.emit("mcp_died", { name: "worker", pid: 0, autoRestart: false, neverConnected: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenLastCalledWith("worker", t("inst.mcp_never_connected_manual", "worker")));
  });

  it("retracts with the late-connect wording", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: '{"loggedIn": true}' }));
    const { daemon, notifyInstanceTopic } = makeLifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 0, autoRestart: true, neverConnected: true });
    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledOnce());

    daemon.emit("mcp_recovered", { name: "worker", source: "late_connect", pid: 5151 });

    expect(notifyInstanceTopic).toHaveBeenLastCalledWith("worker", t("inst.mcp_connected_late", "worker"));
  });
});
