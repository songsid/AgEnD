import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";

/**
 * #1030: every backend /quit send logs reason + caller + outcome, and a
 * codex that exits to its resume screen without relaunching warns instead
 * of wedging silently.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts?: {
  sendKeys?: boolean;
  enter?: boolean;
  alive?: boolean;
  pane?: string;
  backendName?: string;
  quitCommand?: string | null;
}) {
  const dir = mkdtempSync(join(tmpdir(), "agend-quit-seq-"));
  dirs.push(dir);
  writeFileSync(join(dir, "window-id"), "@1");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const tmux = {
    sendKeys: vi.fn(async () => opts?.sendKeys ?? true),
    sendSpecialKey: vi.fn(async () => opts?.enter ?? true),
    getPaneStatus: vi.fn(async () => ({ alive: opts?.alive ?? true })),
    capturePane: vi.fn(async () => opts?.pane ?? ""),
  };
  const backend = {
    binaryName: opts?.backendName ?? "codex",
    getQuitCommand: () => opts?.quitCommand === undefined ? "/quit" : opts.quitCommand,
  };
  const d = new Daemon("quit-test", {
    working_directory: "/tmp",
    backend: "codex",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, dir, false, backend as any, undefined, { child: () => logger } as any) as any;
  d.tmux = tmux;
  return { d, logger, tmux };
}

const RESUME_SCREEN = "To continue this session, run:\n  codex resume abc123";

describe("sendQuitSequence logging (#1030)", () => {
  it("logs reason + caller + backend + command on send and on success", async () => {
    const { d, logger, tmux } = setup();
    const ok = await d.sendQuitSequence("pause-test-reason", "pause");
    expect(ok).toBe(true);
    expect(tmux.sendKeys).toHaveBeenCalledWith("/quit");
    const sendCall = logger.info.mock.calls.find(c => String(c[1]).includes("Sending backend quit sequence"));
    expect(sendCall).toBeDefined();
    expect(sendCall![0]).toMatchObject({ backend: "codex", quit: "/quit", reason: "pause-test-reason", caller: "pause" });
    expect(logger.info.mock.calls.some(c => String(c[1]).includes("Backend quit sequence sent"))).toBe(true);
  });

  it("logs a warn with the failed step when sendKeys fails", async () => {
    const { d, logger } = setup({ sendKeys: false });
    const ok = await d.sendQuitSequence("graceful stop", "stop");
    expect(ok).toBe(false);
    const warnCall = logger.warn.mock.calls.find(c => String(c[1]).includes("failed to send"));
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({ step: "sendKeys", reason: "graceful stop", caller: "stop" });
  });

  it("logs a warn when Enter fails after the command", async () => {
    const { d, logger } = setup({ enter: false });
    const ok = await d.sendQuitSequence("pause-x", "pause");
    expect(ok).toBe(false);
    const warnCall = logger.warn.mock.calls.find(c => String(c[1]).includes("failed to send"));
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({ step: "enter" });
  });
});

describe("codex-exited-without-relaunch (#1030)", () => {
  it("detects the codex resume screen text", () => {
    const { d } = setup();
    expect(d.isCodexResumeScreen(RESUME_SCREEN)).toBe(true);
    expect(d.isCodexResumeScreen("To continue this session, run:\n  codex resume")).toBe(true);
    expect(d.isCodexResumeScreen("ordinary composer output")).toBe(false);
    expect(d.isCodexResumeScreen("")).toBe(false);
  });

  it("warns when the pane is dead on the resume screen and the daemon is still active", async () => {
    const { d, logger } = setup({ alive: false, pane: RESUME_SCREEN });
    await d.checkQuitRelaunch({ reason: "pause-x", caller: "pause", generation: d.spawnGeneration, quitAt: Date.now() });
    const warnCall = logger.warn.mock.calls.find(c => String(c[1]).includes("codex-exited-without-relaunch"));
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({ reason: "pause-x", caller: "pause", resumeScreen: true });
  });

  it("warns on a dead pane even without the screen, stays silent when live and clean", async () => {
    const wedged = setup({ alive: false, pane: "some crash text" });
    await wedged.d.checkQuitRelaunch({ reason: "r", caller: "c", generation: wedged.d.spawnGeneration, quitAt: 1 });
    expect(wedged.logger.warn.mock.calls.some(c => String(c[1]).includes("codex-exited-without-relaunch"))).toBe(true);

    const healthy = setup({ alive: true, pane: "composer ready > " });
    await healthy.d.checkQuitRelaunch({ reason: "r", caller: "c", generation: healthy.d.spawnGeneration, quitAt: 1 });
    expect(healthy.logger.warn).not.toHaveBeenCalled();
  });

  it("stays silent when paused or relaunched since the quit", async () => {
    const { d, logger } = setup({ alive: false, pane: RESUME_SCREEN });
    d.pauseWakeState = "paused";
    await d.checkQuitRelaunch({ reason: "r", caller: "c", generation: d.spawnGeneration, quitAt: 1 });
    expect(logger.warn).not.toHaveBeenCalled();

    d.pauseWakeState = "active";
    d.spawnGeneration += 1;
    await d.checkQuitRelaunch({ reason: "r", caller: "c", generation: d.spawnGeneration - 1, quitAt: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("arms a bounded watch on non-stop quits that fires the warn", async () => {
    const { d, logger } = setup({ alive: false, pane: RESUME_SCREEN });
    const ok = await d.sendQuitSequence("pause-x", "pause", { watchRelaunch: true, watchMs: 20 });
    expect(ok).toBe(true);
    await new Promise(r => setTimeout(r, 120));
    expect(logger.warn.mock.calls.some(c => String(c[1]).includes("codex-exited-without-relaunch"))).toBe(true);
    d.clearQuitRelaunchWatch();
  });

  it("TOCTOU: no warn when a relaunch lands while pane reads are pending", async () => {
    const { d, logger, tmux } = setup({ alive: false, pane: RESUME_SCREEN });
    let releaseStatus!: (v: { alive: boolean }) => void;
    tmux.getPaneStatus.mockImplementation(() => new Promise(r => { releaseStatus = r; }));
    d.armQuitRelaunchWatch("pause-x", "pause", 60_000);
    const pending = d.checkQuitRelaunch({
      reason: "pause-x", caller: "pause",
      generation: d.spawnGeneration, quitAt: 1, token: d.quitWatchToken,
    });
    await new Promise(r => setTimeout(r, 10));
    // beginSpawn lands mid-read: new generation, watch cleared.
    d.spawnGeneration += 1;
    d.clearQuitRelaunchWatch();
    releaseStatus({ alive: false });
    await pending;
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
