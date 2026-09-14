import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * Codex parks on its update picker until somebody answers it, and the picker's
 * SELECTED option is `› 1. Update now (runs `sh -c 'curl -fsSL …| sh'`)` — the
 * same `›` glyph codex uses for its input row. A delivery landing there would
 * paste into the picker and press Enter on an installer. The runtime dismisser
 * sends Escape, but it polls on a timer and a delivery can arrive first.
 *
 * The pane below is a verbatim capture from codex-cli 0.153.4 (the picker it
 * showed on a fresh launch).
 */
const PICKER = readFileSync(join(__dirname, "fixtures", "codex-update-picker.pane.txt"), "utf-8");

const backend = () => new CodexBackend(mkdtempSync(join(tmpdir(), "agend-codex-picker-")));
const picker = () => {
  const d = backend().getRuntimeDialogs().find(x => x.description.includes("update-available picker"));
  if (!d) throw new Error("the update picker dialog is no longer registered");
  return d;
};

describe("codex update picker blocks delivery", () => {
  it("is recognised on the real picker pane", () => {
    expect(picker().pattern.test(PICKER)).toBe(true);
  });

  it("makes the delivery readiness check report a dialog, not a ready pane", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-codex-picker-daemon-"));
    writeFileSync(join(dir, "window-id"), "@9");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("codex-picker", {
      working_directory: "/tmp",
      backend: "codex",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, dir, false, new CodexBackend(dir) as any, undefined, { child: () => logger } as any) as any;
    daemon.tmux = { capturePane: async () => PICKER };
    // Quiet pane: without the delivery-blocking flag this reads as "ready" and
    // the next message is pasted into the installer prompt.
    daemon.controlClient = { isIdle: () => true, getLastOutputAt: () => 0, getObservationResetAt: () => 0 };

    await expect(daemon.paneReadinessForDelivery("@9")).resolves.toBe("dialog");
  });

  it("counts only while the picker owns the bottom of the pane", () => {
    const live = picker();
    expect(live.isActive!(PICKER)).toBe(true);
  });

  it("does not count when an agent merely quoted the picker in the transcript", () => {
    // The same text scrolled up, with codex's input row back at the bottom.
    const quoted = `${PICKER}\n\n› Ask Codex to do anything\n  Context 63% left`;
    expect(picker().pattern.test(quoted), "the cheap pre-filter still matches").toBe(true);
    expect(picker().isActive!(quoted), "but it must not hold delivery").toBe(false);
  });
});
