/** Saved native frames/RPC receipts only. No Codex, account, tmux or fleet is started by this suite. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const versions = ["0.162.0", "0.162.1"] as const;
const root = new URL("./fixtures/codex-0162-newstrings/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, root), "utf8");
const frame = (v: string, phase: string) => text(`v${v.replaceAll(".", "")}/${phase}.pane.txt`);
const strings = JSON.parse(text("precheck-exact.json")).strings as Array<{ text: string }>;
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(pane: string) {
  const dir = mkdtempSync(join(tmpdir(), "agend-codex-strings-")); directories.push(dir);
  writeFileSync(join(dir, "window-id"), "@audit");
  const backend = new CodexBackend(dir);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("codex-strings", {
    working_directory: dir, backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 }, log_level: "silent",
  } as any, dir, false, backend, undefined, { child: () => logger } as any) as any;
  const keys = vi.fn(async () => true), paste = vi.fn(async () => true);
  daemon.tmux = {
    capturePane: async () => pane, capturePaneWithHistory: async () => pane,
    getPaneInputMode: async () => "raw", getWindowId: () => "@audit",
    isWindowAlive: async () => true, sendSpecialKey: keys, sendKeys: keys, pasteBuffer: paste,
  };
  daemon.controlClient = {
    isIdle: () => true, waitUntilIdle: async () => true, hasOutputSince: () => false,
    getLastOutputAt: () => 0, getObservationResetAt: () => 0,
  };
  daemon.spawnGeneration++;
  daemon.inputTransientGuardGeneration = daemon.spawnGeneration;
  return { backend, daemon, keys, paste };
}

const phases = ["tier-catalog-idle", "tier-save-success", "tier-save-failed", "turn-after-failed-save",
  "resumed-idle", "resumed-tier-save-failed", "resumed-turn-after-failed-save"];

describe.each(versions)("Codex %s default-tier persistence is nonblocking", version => {
  it.each(phases)("%s remains idle and deliverable through the real daemon gate", async phase => {
    const pane = frame(version, phase), h = harness(pane);
    expect(h.backend.getBusyPattern().test(pane)).toBe(false);
    expect(h.backend.getReadyPattern().test(pane)).toBe(true);
    expect(h.backend.isDeliveryInputReadyPane(pane)).toBe(true);
    expect(h.backend.getInputUnavailableTransients().some(t => t.isActive(pane))).toBe(false);
    for (const dialog of [...h.backend.getStartupDialogs(), ...h.backend.getRuntimeDialogs()]) {
      expect(dialog.isActive ? dialog.isActive(pane) : dialog.pattern.test(pane), dialog.description).toBe(false);
    }
    const state = new PaneStateMachine(h.backend.getReadyPattern(), 30_000, 0, h.backend.getBusyPattern());
    expect(state.observe(pane, 1000, { settled: true }).state).toBe("idle");
    await expect(h.daemon.paneReadinessForDelivery("@audit")).resolves.toBe("ready");
    const errors = vi.fn(); h.daemon.on("pty_error", errors);
    h.daemon.evaluateErrorPatterns(pane, h.backend.getErrorPatterns(), h.backend.getReadyPattern(), 1000, h.backend.getBusyPattern());
    expect(errors).not.toHaveBeenCalled();
    expect(h.daemon.errorWaitingForRecovery).toBe(false);
    expect(h.keys).not.toHaveBeenCalled(); expect(h.paste).not.toHaveBeenCalled();
  });

  it("fresh and resumed save failures contain the complete new instruction, followed by completed live turns", () => {
    for (const prefix of ["", "resumed-"]) {
      const failed = frame(version, prefix + "tier-save-failed");
      expect(failed).toContain("■ Failed to save default service tier:");
      expect(failed).toContain("unclosed table, expected `]` (code -32603)");
      expect(failed).toContain(strings[0]!.text);
      const continued = frame(version, prefix + "turn-after-failed-save");
      expect(continued).toContain(strings[0]!.text);
      expect(continued).toContain("• ok");
      expect(continued).toContain(prefix ? "› resumed task still works" : "› continue after failed default save");
      expect(continued).toContain("› Ask Codex to do anything");
    }
    expect(frame(version, "tier-save-success")).toContain("• Service tier set to priority");
  });

  it("the native quota detail timeout falls back to usage; periodic RPCs do not request details", () => {
    const detailed = JSON.parse(text(`quota-${version}-False.json`));
    const periodic = JSON.parse(text(`quota-${version}-True.json`));
    expect(detailed.reply.result.rateLimits.primary.usedPercent).toBe(21);
    expect(detailed.reply.result.rateLimitResetCredits).toEqual({ availableCount: 3, credits: null });
    expect(detailed.calls.filter((c: any) => c.path.endsWith("/rate-limit-reset-credits"))).toHaveLength(1);
    expect(text(`quota-${version}.log.txt`)).toContain(strings[1]!.text);
    expect(periodic.reply.result).toEqual(detailed.reply.result);
    expect(periodic.calls.filter((c: any) => c.path.endsWith("/rate-limit-reset-credits"))).toHaveLength(1);
    expect(periodic.calls.filter((c: any) => c.path.endsWith("/usage"))).toHaveLength(2);
  });
});

it("an internal log and model-only Guardian instruction are not standalone pane chrome or auto-actionable dialogs", () => {
  for (const value of [strings[1]!.text, strings[2]!.text]) {
    const { backend } = harness(value);
    expect(backend.getReadyPattern().test(value)).toBe(false);
    expect(backend.getBusyPattern().test(value)).toBe(false);
    expect(backend.isDeliveryInputReadyPane(value)).toBe(false);
    expect(backend.getErrorPatterns().filter(p => p.pattern.test(value))).toEqual([]);
    for (const dialog of [...backend.getStartupDialogs(), ...backend.getRuntimeDialogs()]) {
      expect(dialog.isActive ? dialog.isActive(value) : dialog.pattern.test(value), dialog.description).toBe(false);
    }
  }
});
