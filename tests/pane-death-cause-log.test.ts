import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../src/daemon.js";
import { CodexBackend } from "../src/backend/codex.js";
import { TmuxManager } from "../src/tmux-manager.js";

/**
 * #927: a codex on Luna Reserve died with status 0 and daemon.log said only
 * "CLI exited normally (code 0)" — no output, and no way to tell a CLI that
 * exited on its own from one AgEnD had sent /quit. These tests drive the real
 * health-check loop over a stub tmux and read what gets logged. Logging only:
 * the tests also hold that what the daemon DOES next is unchanged.
 */

// What a dying codex leaves on screen, colour codes and all.
const DYING_PANE = [
  "• Working (2m 10s • esc to interrupt)",
  "\x1b[31m■ You've hit your usage limit for Luna Reserve.\x1b[0m Try again in 6d 23h.",
  "To continue this session, run codex resume 01a0d41d-462a-7983-b0d8-690525b798be",
].join("\n");

let dir: string;
let logger: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
let daemon: any;
let pane: { alive: boolean; exitCode: number } | null;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "agend-death-log-"));
  logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  daemon = new Daemon("codex-death", {
    working_directory: "/tmp",
    backend: "codex",
    restart_policy: { max_retries: 5, backoff: "linear", reset_after: 0, health_check_interval_ms: 1_000 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, new CodexBackend(dir) as any, undefined, { child: () => logger } as any);
  pane = { alive: false, exitCode: 0 };
  daemon.tmux = {
    getPaneStatus: vi.fn(async () => pane),
    capturePaneWithHistory: vi.fn(async () => DYING_PANE),
    killWindow: vi.fn(async () => {}),
    getWindowId: () => "@7",
    sendKeys: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** sendQuitSequence waits between keys; with fake timers the clock has to be driven. */
async function quit(reason: string) {
  const sent = daemon.sendQuitSequence(reason);
  await vi.advanceTimersByTimeAsync(500);
  return sent;
}

async function oneHealthTick() {
  daemon.startHealthCheck();
  await vi.advanceTimersByTimeAsync(1_100);
}

/** The single death record, whichever level it was logged at. */
function deathRecord() {
  const calls = [...logger.warn.mock.calls, ...logger.info.mock.calls]
    .filter(([payload]) => payload && typeof payload === "object" && "initiatedBy" in payload);
  expect(calls, "exactly one death record per death").toHaveLength(1);
  return { payload: calls[0][0], message: String(calls[0][1]), level: logger.warn.mock.calls.includes(calls[0]) ? "warn" : "info" };
}

describe("a pane that dies", () => {
  it("records a status-0 exit with the CLI's last output, as its own doing", async () => {
    await oneHealthTick();

    const death = deathRecord();
    expect(death.payload).toMatchObject({ exitCode: 0, initiatedBy: "cli" });
    expect(death.payload.lastOutput).toContain("usage limit for Luna Reserve");
    expect(death.payload.lastOutput).toContain("codex resume");
    expect(death.payload.lastOutput, "escape codes stripped").not.toContain("\x1b[");
    expect(Number.isNaN(Date.parse(death.payload.diedAt))).toBe(false);
    expect(death.level, "an unexplained exit is worth a warning").toBe("warn");
    // Logging only: the status-0 handling is what it was.
    expect(daemon.tmux.killWindow).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("CLI exited normally (code 0) — pausing health check");
  });

  it("attributes the death to AgEnD when AgEnD had just asked the CLI to quit", async () => {
    await quit("graceful stop");
    expect(logger.info).toHaveBeenCalledWith(
      { via: "quit command /quit", reason: "graceful stop" },
      "AgEnD is stopping the CLI: quit command /quit (graceful stop)",
    );

    await oneHealthTick();

    const death = deathRecord();
    expect(death.payload).toMatchObject({ initiatedBy: "agend", stopVia: "quit command /quit", stopReason: "graceful stop" });
    expect(death.level, "an exit AgEnD asked for is expected").toBe("info");
  });

  it("stops attributing to AgEnD once its request is old", async () => {
    await quit("graceful stop");
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await oneHealthTick();

    expect(deathRecord().payload.initiatedBy).toBe("cli");
  });

  it("records a crash with its exit code and output too", async () => {
    pane = { alive: false, exitCode: 1 };
    await oneHealthTick();

    expect(deathRecord().payload).toMatchObject({ exitCode: 1, initiatedBy: "cli" });
  });

  it("puts the count and the last exit into the crash-loop pause", async () => {
    pane = { alive: false, exitCode: 1 };
    daemon.crashTimestamps = [Date.now(), Date.now()];   // two crashes already in the window

    await oneHealthTick();

    const loop = logger.error.mock.calls.find(([, msg]) => msg === "3+ crashes in 5 minutes — pausing respawn");
    expect(loop, "the crash-loop pause must be logged").toBeDefined();
    expect(loop![0]).toMatchObject({ crashesInWindow: 3, lastExitCode: 1 });
    expect(loop![0].lastOutput).toContain("Luna Reserve");
  });
});

describe("AgEnD stopping the CLI", () => {
  it("logs which signal and why, before sending it", async () => {
    vi.spyOn(TmuxManager, "getPanePid").mockResolvedValue(424242);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    await daemon.killProcessTree("SIGKILL", "graceful stop: the CLI survived SIGTERM");

    expect(logger.info).toHaveBeenCalledWith(
      { via: "SIGKILL", reason: "graceful stop: the CLI survived SIGTERM" },
      "AgEnD is stopping the CLI: SIGKILL (graceful stop: the CLI survived SIGTERM)",
    );
    expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL");
    expect(logger.info.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0]);
  });
});
