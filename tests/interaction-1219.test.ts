/**
 * #1219 follow-ups to #1212: (1) the kiro outage picker's actionable
 * notification text, (2) the dead delivery_idle_gate branch, (3) debounced
 * publishInteraction IPC.
 *
 * Each part has a red-on-mutation test: reverting the fix (generic-category
 * text for kind === "dialog"; re-adding the dead branch is behavior-neutral
 * so the live :5344 fence it shadowed is covered instead; unthrottled
 * publish) fails the corresponding test below.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forbiddenProcess = vi.hoisted(() => vi.fn((): never => { throw new Error("No real CLI in 1219 sandbox"); }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  exec: forbiddenProcess, execFile: forbiddenProcess, execSync: forbiddenProcess, execFileSync: forbiddenProcess,
  spawn: forbiddenProcess, spawnSync: forbiddenProcess, fork: forbiddenProcess,
}));
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";

const dirs: string[] = [];
const backend = Object.assign(Object.create(KiroBackend.prototype), { activeUi: "legacy", activeTrustAll: true }) as KiroBackend;

afterEach(() => {
  expect(forbiddenProcess).not.toHaveBeenCalled();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDaemon(pane = "2% λ > ready") {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-1219-"));
  dirs.push(instanceDir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("w", {
    working_directory: "/tmp", backend: "kiro-cli",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, backend, undefined,
  { child: () => logger } as any) as any;
  const screen = { pane };
  daemon.tmux = {
    capturePane: vi.fn(async () => screen.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true),
    pasteText: vi.fn(async () => true),
  };
  return { daemon, screen, logger };
}

function makeLifecycle() {
  const notifyFleetError = vi.fn();
  const notifyInstanceTopic = vi.fn();
  const lifecycle = new InstanceLifecycle({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    isPlannedRestart: () => false,
    notifyFleetError,
    notifyInstanceTopic,
  } as any);
  const source = new EventEmitter();
  lifecycle.attachIncidentHandlers("w", source as any);
  return { source, notifyFleetError, notifyInstanceTopic };
}

describe("#1219(1): generic-dialog notices keep the code-owned description", () => {
  const OUTAGE = "Kiro model unavailable — choose a replacement model in the instance pane";

  it("kind === 'dialog' (the no-specific-kind default) reports the description, not 'waiting for your input'", () => {
    const { source, notifyFleetError, notifyInstanceTopic } = makeLifecycle();
    source.emit("dialog_parked", { name: "w", description: OUTAGE, holdOnly: true, kind: "dialog", episode: 1, backend: "kiro-cli" });
    expect(notifyInstanceTopic).toHaveBeenCalledOnce();
    expect(notifyInstanceTopic.mock.calls[0][1]).toContain("model unavailable");
    expect(notifyInstanceTopic.mock.calls[0][1]).not.toContain("waiting for your input");
    expect(notifyFleetError).toHaveBeenCalledOnce();
    expect(notifyFleetError.mock.calls[0][0]).toContain("model unavailable");
  });

  it("a specific kind still reports its category text", () => {
    const { source, notifyFleetError, notifyInstanceTopic } = makeLifecycle();
    source.emit("dialog_parked", { name: "w", description: "Enter password:", holdOnly: false, kind: "permission", episode: 1, backend: "claude-code" });
    expect(notifyInstanceTopic.mock.calls[0][1]).toContain("waiting for your input");
    expect(notifyInstanceTopic.mock.calls[0][1]).toContain("permission confirmation");
    expect(notifyFleetError.mock.calls[0][0]).toContain("permission confirmation");
  });

  it("a dialog with no kind at all still reports the description", () => {
    const { source, notifyInstanceTopic } = makeLifecycle();
    source.emit("dialog_parked", { name: "w", description: OUTAGE, holdOnly: true });
    expect(notifyInstanceTopic.mock.calls[0][1]).toContain("model unavailable");
  });
});

describe("#1219(2): the live stale-during-probe fence resets the footer fallback", () => {
  it("delivery_idle_gate capture overtaken mid-probe resets and returns before observing", async () => {
    const { daemon } = makeDaemon();
    daemon.instanceStateMonitorActive = true;
    daemon.instanceStateMachine = {} as any;
    const reset = vi.spyOn(daemon, "resetFooterFallback");
    const observed: string[] = [];
    daemon.probeDeliveryIdleFallback = async (pane: string) => {
      observed.push(pane);
      daemon.spawning = true; // respawn lands while the probe awaits
      return null;
    };
    try {
      await daemon.captureAndEvaluateInstanceState("delivery_idle_gate", 0);
      expect(observed).toHaveLength(1);
      expect(reset).toHaveBeenCalledTimes(1); // the live post-probe fence
      expect(daemon.statePollInFlight).toBe(false);
      expect(daemon.footerFallbackPaneKey).toBeNull();
    } finally {
      daemon.spawning = false;
    }
  });
});

describe("#1219(3): publishInteraction dedupes identical snapshots", () => {
  const snap = (over: Record<string, unknown> = {}) => ({
    phase: "waiting", kind: "dialog", reason: "dialog", episode: 3, owner: "cli",
    since: 1, observedAt: 2, confirmedAt: 3, ageMs: 1_000, stale: false, suspected: false,
    ...over,
  });

  it("emits + broadcasts on change, skips exact duplicates, never loses the final state", () => {
    const { daemon } = makeDaemon();
    const emitted: unknown[] = [];
    const broadcast: unknown[] = [];
    daemon.on("instance_interaction", (event: unknown) => emitted.push(event));
    daemon.ipcServer = { broadcast: (message: unknown) => broadcast.push(message) };
    let current = snap();
    daemon.getInteractionSnapshot = () => current as any;

    daemon.publishInteraction();
    daemon.publishInteraction(); // identical: skipped
    expect(emitted).toHaveLength(1);
    expect(broadcast).toHaveLength(1);

    current = { ...current, ageMs: 61_000 }; // clocks alone never republish
    daemon.publishInteraction();
    expect(emitted).toHaveLength(1);
    expect(broadcast).toHaveLength(1);

    current = snap({ phase: "candidate", episode: 4 }); // real change: published
    daemon.publishInteraction();
    expect(emitted).toHaveLength(2);
    expect(broadcast).toHaveLength(2);
    expect(broadcast[1]).toMatchObject({ type: "instance_interaction", instanceName: "w" });

    current = snap({ phase: "clear", kind: null, reason: null, episode: null }); // final state kept
    daemon.publishInteraction();
    expect(emitted).toHaveLength(3);
    expect(broadcast).toHaveLength(3);
  });
});
