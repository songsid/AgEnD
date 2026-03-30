import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextGuardian } from "../src/context-guardian.js";
import { createLogger } from "../src/logger.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const makeConfig = (overrides = {}) => ({
  grace_period_ms: 600_000,
  max_age_hours: 8,
  ...overrides,
});

describe("ContextGuardian v3", () => {
  const logger = createLogger("silent");
  let guardian: ContextGuardian;
  let tmpDir: string;
  let statusFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = join(tmpdir(), `ccd-guardian-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    statusFile = join(tmpDir, "statusline.json");
    guardian = new ContextGuardian(makeConfig(), logger, statusFile);
  });

  afterEach(() => {
    guardian.stop();
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts in NORMAL state", () => {
    expect(guardian.state).toBe("NORMAL");
  });

  it("does not trigger restart on threshold (threshold rotation removed)", () => {
    const restartSpy = vi.fn();
    guardian.on("restart_requested", restartSpy);
    guardian.updateContextStatus({
      used_percentage: 95,
      remaining_percentage: 5,
      context_window_size: 1_000_000,
    });
    expect(guardian.state).toBe("NORMAL");
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it("stays NORMAL below any context level", () => {
    guardian.updateContextStatus({
      used_percentage: 75,
      remaining_percentage: 25,
      context_window_size: 1_000_000,
    });
    expect(guardian.state).toBe("NORMAL");
  });

  it("enters GRACE after markRestartComplete", () => {
    guardian.requestRestart("max_age");
    expect(guardian.state).toBe("RESTARTING");
    guardian.markRestartComplete();
    expect(guardian.state).toBe("GRACE");
  });

  it("emits restart_complete on markRestartComplete", () => {
    const completeSpy = vi.fn();
    guardian.on("restart_complete", completeSpy);
    guardian.requestRestart("max_age");
    guardian.markRestartComplete();
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("returns to NORMAL after grace period expires", () => {
    guardian.requestRestart("max_age");
    guardian.markRestartComplete();
    vi.advanceTimersByTime(600_001);
    expect(guardian.state).toBe("NORMAL");
  });

  it("triggers restart on max_age_hours timer", () => {
    const restartSpy = vi.fn();
    guardian.on("restart_requested", restartSpy);
    guardian.startTimer();
    vi.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(guardian.state).toBe("RESTARTING");
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartSpy).toHaveBeenCalledWith("max_age");
  });

  it("does not start timer when max_age_hours is 0 (disabled)", () => {
    const disabledGuardian = new ContextGuardian(
      makeConfig({ max_age_hours: 0 }),
      logger,
      statusFile,
    );
    const restartSpy = vi.fn();
    disabledGuardian.on("restart_requested", restartSpy);
    disabledGuardian.startTimer();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(restartSpy).not.toHaveBeenCalled();
    disabledGuardian.stop();
  });

  it("ignores requestRestart when not NORMAL", () => {
    guardian.requestRestart("max_age");
    expect(guardian.state).toBe("RESTARTING");
    // Second request should be ignored
    const restartSpy = vi.fn();
    guardian.on("restart_requested", restartSpy);
    guardian.requestRestart("max_age");
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it("resets age timer after grace period", () => {
    const restartSpy = vi.fn();
    guardian.on("restart_requested", restartSpy);
    guardian.startTimer();

    // Trigger restart via max_age
    vi.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(restartSpy).toHaveBeenCalledTimes(1);
    guardian.markRestartComplete();

    // Grace expires, returns to NORMAL
    vi.advanceTimersByTime(600_001);
    expect(guardian.state).toBe("NORMAL");

    // Age timer should have been reset — wait full max_age
    vi.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(guardian.state).toBe("RESTARTING");
    expect(restartSpy).toHaveBeenCalledTimes(2);
  });
});
