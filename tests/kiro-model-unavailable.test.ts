import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { KiroBackend } from "../src/backend/kiro.js";

const READY = /^> /m;
const T0 = 10 * 60_000; // clear of ERROR_COOLDOWN_MS from the zero epoch
const MODEL_ERROR_PANE = "The selected model is not available\nPlease use '/model' to choose another model\n> ";
const CLEAN_PANE = "All done.\n> ";

function makeDaemon(model?: string) {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-kiro-model-"));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("kiro-model", {
    working_directory: "/tmp",
    backend: "kiro-cli",
    ...(model ? { model } : {}),
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, { getReadyPattern: () => READY } as any, undefined,
    { child: () => logger } as any);
  const errors: any[] = [];
  daemon.on("pty_error", e => errors.push(e));
  const patterns = new KiroBackend("/tmp/test").getErrorPatterns();
  const ev = (pane: string, t: number) => (daemon as any).evaluateErrorPatterns(pane, patterns, READY, t);
  return { daemon, instanceDir, errors, ev, logger };
}

describe("kiro model_error with model: auto", () => {
  it("suppresses the notification — auto reroutes on its own", () => {
    const { daemon, instanceDir, errors, ev } = makeDaemon("auto");
    try {
      (daemon as any).instanceState = "idle";
      ev(MODEL_ERROR_PANE, T0);
      ev(MODEL_ERROR_PANE, T0 + 1_000);
      expect(errors).toHaveLength(0);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("suppresses even mid-turn (auto outranks the deferral)", () => {
    const { daemon, instanceDir, errors, ev } = makeDaemon("auto");
    try {
      (daemon as any).instanceState = "working";
      ev(MODEL_ERROR_PANE, T0);
      (daemon as any).instanceState = "idle";
      ev(MODEL_ERROR_PANE, T0 + 1_000);
      expect(errors).toHaveLength(0);
      expect((daemon as any).pendingModelErrorKey).toBeNull();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("still reports non-model errors under auto", () => {
    const { daemon, instanceDir, errors, ev } = makeDaemon("auto");
    try {
      (daemon as any).instanceState = "idle";
      ev("ThrottlingException: rate exceeded\n> ", T0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].type).not.toBe("model_error");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});

describe("kiro model_error with a pinned model", () => {
  it("notifies immediately when the instance is idle (the agent gave up)", () => {
    const { daemon, instanceDir, errors, ev } = makeDaemon("claude-sonnet-4.5");
    try {
      (daemon as any).instanceState = "idle";
      ev(MODEL_ERROR_PANE, T0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "model_error", action: "notify" });
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("defers mid-turn and notifies at idle only if the error survived", () => {
    const { daemon, instanceDir, errors, ev } = makeDaemon("claude-sonnet-4.5");
    try {
      (daemon as any).instanceState = "working";
      ev(MODEL_ERROR_PANE, T0);
      expect(errors).toHaveLength(0);
      expect((daemon as any).pendingModelErrorKey).not.toBeNull();

      // Still working, error still on screen: keep holding.
      ev(MODEL_ERROR_PANE, T0 + 2_000);
      expect(errors).toHaveLength(0);

      // Turn ended with the error still on the idle screen → notify now.
      (daemon as any).instanceState = "idle";
      ev(MODEL_ERROR_PANE, T0 + 4_000);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "model_error" });
      expect((daemon as any).pendingModelErrorKey).toBeNull();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("drops the deferred notice when the CLI retried past the error", () => {
    const { daemon, instanceDir, errors, ev } = makeDaemon("claude-sonnet-4.5");
    try {
      (daemon as any).instanceState = "working";
      ev(MODEL_ERROR_PANE, T0);
      expect(errors).toHaveLength(0);

      // The retry worked: the idle screen no longer shows the error.
      (daemon as any).instanceState = "idle";
      ev(CLEAN_PANE, T0 + 4_000);
      expect(errors).toHaveLength(0);
      expect((daemon as any).pendingModelErrorKey).toBeNull();
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
