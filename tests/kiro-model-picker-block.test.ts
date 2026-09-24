import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";

// The error text was captured in #915. The picker chrome/row shape was checked
// against a real kiro-cli 2.24.0 --legacy-ui pane (without making a paid turn).
const ERROR = [
  "Kiro is having trouble responding right now:",
  "    The model you've selected is temporarily unavailable. Please select a different model.",
].join("\n");
const PICKER = [
  "Select model (type to search):",
  "> * auto                 1.00x credits      Models chosen by task for optimal usage and consistent quality",
  "    claude-sonnet-4.6    1.30x credits      Claude Sonnet 4.6 model with 1M context window",
  "    claude-opus-4.5      2.20x credits      Claude Opus 4.5 model",
].join("\n");
const BLOCKED = `${ERROR}\n\n${PICKER}\n`;
const dirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDaemon(pane = BLOCKED) {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-kiro-picker-"));
  dirs.push(instanceDir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("kiro-picker", {
    working_directory: "/tmp", backend: "kiro-cli",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, new KiroBackend(instanceDir), undefined,
  { child: () => logger } as any) as any;
  const screen = { pane };
  const tmux = {
    capturePane: vi.fn(async () => screen.pane),
    isWindowAlive: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true),
    pasteText: vi.fn(async () => true),
  };
  daemon.tmux = tmux;
  return { daemon, screen, tmux, logger };
}

describe("Kiro model-unavailable picker", () => {
  const dialog = new KiroBackend("/tmp/kiro-picker-test").getRuntimeDialogs()
    .find(candidate => candidate.description.includes("model unavailable"));

  it("requires the exact outage and the live, bottom-anchored credit picker", () => {
    expect(dialog).toBeDefined();
    expect(dialog?.holdOnly).toBe(true);
    expect(dialog?.inputBlocked).toBe(true);
    expect(dialog?.keys).toEqual([]);
    expect(dialog?.isActive?.(BLOCKED)).toBe(true);
    expect(dialog?.isActive?.(PICKER)).toBe(false); // ordinary /model menu
    expect(dialog?.isActive?.(`${ERROR}\n\n2% λ > ready`)).toBe(false);
    expect(dialog?.isActive?.(`${BLOCKED}\n2% λ > ready`)).toBe(false);
    expect(dialog?.isActive?.(BLOCKED.replace("> * auto", "    auto"))).toBe(false);
    expect(dialog?.isActive?.(BLOCKED.replace("1.00x credits", "auto"))).toBe(false);
    expect(dialog?.isActive?.(`${ERROR}\n\nUnrelated output\n\n${PICKER}`)).toBe(false);
    expect(dialog?.isActive?.(`${BLOCKED}\nThe request completed.`)).toBe(false);
    expect(dialog?.isActive?.(BLOCKED.replace("The model you've selected is temporarily unavailable.", "The model is ready."))).toBe(false);
    expect(dialog?.isActive?.(BLOCKED.replace("Select model (type to search):", "Select a tool:"))).toBe(false);
    expect(dialog?.isActive?.(BLOCKED.replace("credit", "token"))).toBe(false);
    expect(dialog?.isActive?.(BLOCKED.replace("Models chosen by task for optimal usage and consistent quality", "Models chosen by task for optimal us\nage and consistent quality"))).toBe(true);
    expect(dialog?.isActive?.(`${ERROR}\nRetry #3\n${BLOCKED}`)).toBe(true);
  });

  it("holds stdin without sending any model-selection key, reports General once, and clears on exit", async () => {
    vi.useFakeTimers();
    const { daemon, screen, tmux } = makeDaemon();
    const blocked: unknown[] = [];
    const parked: unknown[] = [];
    const errors: unknown[] = [];
    daemon.on("input_blocked", (event: unknown) => blocked.push(event));
    daemon.on("dialog_parked", (event: unknown) => parked.push(event));
    daemon.on("pty_error", (event: unknown) => errors.push(event));

    const notifyFleetError = vi.fn();
    const notifyInstanceTopic = vi.fn();
    const lifecycle = new InstanceLifecycle({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      isPlannedRestart: () => false,
      notifyFleetError,
      notifyInstanceTopic,
    } as any);
    const source = new EventEmitter();
    lifecycle.attachIncidentHandlers("kiro-picker", source as any);
    daemon.on("dialog_parked", (event: unknown) => source.emit("dialog_parked", event));

    daemon.startErrorMonitor();
    try {
      await vi.advanceTimersByTimeAsync(66_000);
      expect(blocked).toContainEqual(expect.objectContaining({ blocked: true }));
      expect(daemon.isInputBlocked()).toBe(true);
      expect(parked).toEqual([expect.objectContaining({ holdOnly: true })]);
      expect(notifyFleetError).toHaveBeenCalledOnce();
      expect(notifyFleetError.mock.calls[0][0]).toContain("Kiro");
      expect(notifyInstanceTopic).toHaveBeenCalledOnce();
      expect(errors).toEqual([]); // generic "having trouble" is not a pty-error/churn path
      expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
      expect(tmux.pasteText).not.toHaveBeenCalled();

      daemon.instanceState = "working";
      daemon.autoPauseController.observe = vi.fn(() => true);
      daemon.hangDetector = { emit: vi.fn() };
      daemon.applyInstanceStateSnapshot({ state: "stuck", unchangedForMs: 600_000, stateChangedAt: 1, observedAt: 2 }, screen.pane);
      expect(daemon.instanceState).toBe("working");
      expect(daemon.autoPauseController.observe).not.toHaveBeenCalled();
      expect(daemon.hangDetector.emit).not.toHaveBeenCalled();

      // The pane is still deliverability-blocked; when a human resolves it,
      // the observation clears without an automatic key.
      expect((await daemon.probeBlockingDialog()).state).toBe("dialog");
      screen.pane = "2% λ > ready";
      await vi.advanceTimersByTimeAsync(5_100);
      expect(blocked).toContainEqual(expect.objectContaining({ blocked: false }));
      expect(daemon.isInputBlocked()).toBe(false);
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });

  it("does not classify a quoted incident followed by a normal prompt as a live picker", async () => {
    vi.useFakeTimers();
    const { daemon, tmux } = makeDaemon(`A previous screen was:\n${BLOCKED}\n\n2% λ > ready`);
    daemon.startErrorMonitor();
    try {
      await vi.advanceTimersByTimeAsync(5_100);
      expect(daemon.isInputBlocked()).toBe(false);
      expect(tmux.sendSpecialKey).not.toHaveBeenCalled();
    } finally {
      daemon.freezeRuntimeMonitors();
    }
  });
});
