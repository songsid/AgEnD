/**
 * #906 §3: the daemon's agent switch after a resume (Daemon.ensureBackendAgent). A resumed kiro conversation comes
 * back as the agent it was saved under; the daemon reads the live layout, types `/agent swap <agent>` once — under
 * the pane-write lock, only into a pane the delivery path calls ready and whose fresh capture still shows another
 * agent — and confirms only on a capture taken after that write. Every await is fenced; the whole step has a 15 s
 * monotonic budget. Nothing here starts a process, tmux or a fleet: the backend, the pane and readiness are stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { t } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });

const AGENT = "agend-worker-f1eet000";
const ours = `[${AGENT}] 2% >`;
const theirs = "2% >";

function rig(opts: { panes: Array<string | null | Error>; alreadyConfirmed?: boolean; readiness?: () => string }) {
  const dir = mkdtempSync(join(tmpdir(), "agend-906-daemon-")); dirs.push(dir);
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;
  const confirm = vi.fn(() => [] as string[]);
  const sw = {
    agent: AGENT, alreadyConfirmed: !!opts.alreadyConfirmed, command: `/agent swap ${AGENT}`, confirm,
    readActive: (pane: string) => { const m = /^\[([^\]]+)\] \d+% >/.exec(pane); return m ? m[1]! : /^\d+% >/.test(pane) ? "kiro_default" : null; },
  };
  const backend = { binaryName: "kiro-cli", agentSwitch: () => sw, getReadyPattern: () => /\d+% >/, getBusyPattern: () => /Kiro is working/ };
  const daemon: any = new Daemon("worker", {
    working_directory: dir, log_level: "error", backend: "kiro-cli",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, join(dir, "worker"), false, backend as any, undefined as any, logger);
  const queue = [...opts.panes];
  let last: string | null = null;
  const capturePane = vi.fn(async () => {
    const next = queue.length ? queue.shift()! : last;
    if (next instanceof Error) throw next;
    last = next;
    return next ?? "";
  });
  const pasteBuffer = vi.fn(async () => true);
  const sendSpecialKey = vi.fn(async () => true);
  const deleteBackward = vi.fn(async () => true);
  daemon.tmux = { getWindowId: () => "@1", capturePane, pasteBuffer, sendSpecialKey, deleteBackward };
  daemon.paneReadinessForDelivery = vi.fn(async () => opts.readiness?.() ?? "ready");
  const warnings: string[] = [];
  daemon.on("backend_launch_warning", (w: { message: string }) => warnings.push(w.message));
  return { daemon, sw, confirm, capturePane, pasteBuffer, sendSpecialKey, deleteBackward, warnings, pasteText: pasteBuffer };
}

async function run(daemon: any): Promise<void> {
  const done = daemon.ensureBackendAgent();
  await vi.advanceTimersByTimeAsync(20_000);
  await done;
}

describe("the agent switch after a resume", () => {
  it("already ours and on record: nothing typed, nothing confirmed", async () => {
    const r = rig({ panes: [ours], alreadyConfirmed: true });
    await run(r.daemon);
    expect(r.pasteText).not.toHaveBeenCalled();
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("already ours but not on record: confirmed without typing", async () => {
    const r = rig({ panes: [ours] });
    await run(r.daemon);
    expect(r.pasteText).not.toHaveBeenCalled();
    expect(r.confirm).toHaveBeenCalledOnce();
  });

  it("another agent: the swap is typed once into a ready pane, and a capture after it confirms", async () => {
    // pre-capture, the fresh capture under the lock, then the confirming captures
    const r = rig({ panes: [theirs, theirs, theirs, ours] });
    await run(r.daemon);
    expect(r.pasteText).toHaveBeenCalledOnce();
    expect(r.pasteBuffer).toHaveBeenCalledWith(`/agent swap ${AGENT}`);
    expect(r.sendSpecialKey).toHaveBeenCalledWith("Enter");
    expect(r.confirm).toHaveBeenCalledOnce();
    expect(r.warnings).toEqual([]);
  });

  for (const state of ["busy", "dialog", "transient", "unknown"]) {
    it(`a pane that is not ready (${state}) is never written to; the budget runs out to a warning, nothing confirmed`, async () => {
      const r = rig({ panes: [theirs], readiness: () => state });
      await run(r.daemon);
      expect(r.pasteText).not.toHaveBeenCalled();
      expect(r.confirm).not.toHaveBeenCalled();
      expect(r.warnings).toEqual([t("kiro.switch_timeout", 15)]);
    });
  }

  it("an unreadable layout (or a failing capture) is never written to", async () => {
    const r = rig({ panes: ["Thinking...", new Error("tmux gone"), "Thinking..."] });
    await run(r.daemon);
    expect(r.pasteText).not.toHaveBeenCalled();
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("the fresh capture under the lock decides: already ours there means no write, and the next capture confirms", async () => {
    const r = rig({ panes: [theirs, ours, ours] });
    await run(r.daemon);
    expect(r.pasteText).not.toHaveBeenCalled();
    expect(r.confirm).toHaveBeenCalledOnce();
  });

  it("the switch typed but never shown: timeout warning, nothing confirmed, typed only once", async () => {
    const r = rig({ panes: [theirs] });
    await run(r.daemon);
    expect(r.pasteText).toHaveBeenCalledOnce();
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([t("kiro.switch_timeout", 15)]);
  });

  it("a respawn while the write is in flight: nothing confirmed, no warning", async () => {
    const r = rig({ panes: [theirs, theirs, ours] });
    r.pasteBuffer.mockImplementation(async () => { r.daemon.spawnGeneration++; return true; });
    await run(r.daemon);
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });

  it("a stop while a capture is awaited: nothing written, nothing confirmed", async () => {
    const r = rig({ panes: [theirs] });
    r.capturePane.mockImplementation(async () => { r.daemon.deliveryWritesStopping = true; return ours; });
    await run(r.daemon);
    expect(r.pasteText).not.toHaveBeenCalled();
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("a pause (launch fence) during the readiness check under the lock: no write", async () => {
    const r = rig({ panes: [theirs, theirs] });
    r.daemon.paneReadinessForDelivery = vi.fn(async () => { r.daemon.launchFenceEpoch++; return "ready"; });
    await run(r.daemon);
    expect(r.pasteText).not.toHaveBeenCalled();
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("the confirm's warnings are surfaced", async () => {
    const r = rig({ panes: [ours] });
    r.confirm.mockReturnValue(["could not record"]);
    await run(r.daemon);
    expect(r.warnings).toEqual(["could not record"]);
  });
});

describe("#1416 review: the final frame, the whole budget, the fences", () => {
  const thinking = "Thinking...";
  it("#2 readiness said ready, but the final capture under the lock is busy: no write", async () => {
    const r = rig({ panes: [theirs, `${theirs}  Kiro is working · esc to interrupt`] });
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
    expect(r.confirm).not.toHaveBeenCalled();
  });

  it("#3 a capture that never resolves: the step ends at its deadline with the warning", async () => {
    const r = rig({ panes: [] });
    r.capturePane.mockImplementation(() => new Promise<string>(() => {}));
    await run(r.daemon);
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([t("kiro.switch_timeout", 15)]);
  });

  for (const [label, at, confirms] of [["at 14.9 s confirms", 14_900, true], ["at 15.1 s never confirms", 15_100, false]] as const) {
    it(`#3 a capture showing ours that resolves ${label}`, async () => {
      const r = rig({ panes: [] });
      r.capturePane.mockImplementation(() => new Promise<string>(res => setTimeout(() => res(ours), at)));
      await run(r.daemon);
      expect(r.confirm.mock.calls.length).toBe(confirms ? 1 : 0);
    });
  }

  it("#3 the write lock held past the deadline: no write", async () => {
    const r = rig({ panes: [theirs] });
    void r.daemon.paneWriteLock.run(() => new Promise(res => setTimeout(res, 30_000)));
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
  });

  it("#3 a readiness check that never answers: no write", async () => {
    const r = rig({ panes: [theirs] });
    r.daemon.paneReadinessForDelivery = vi.fn(() => new Promise(() => {}));
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
  });

  /** Unreadable until `readyAt`, then another agent; the paste takes `pasteMs`. */
  function late(readyAtPolls: number, pasteMs: number) {
    const r = rig({ panes: [...Array(readyAtPolls).fill(thinking), theirs] });
    r.pasteBuffer.mockImplementation(() => new Promise(res => setTimeout(() => res(true), pasteMs)));
    return r;
  }
  it("#3 the Enter would land past the deadline: the paste is taken back, no Enter", async () => {
    const r = late(24, 2_600); // admitted at 12 s (3 s left), paste to 14.6 s, settle past 15 s
    await run(r.daemon);
    expect(r.pasteBuffer).toHaveBeenCalledOnce();
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.deleteBackward).toHaveBeenCalledWith(`/agent swap ${AGENT}`.length);
  });
  it("#3 control: the same write with time left gets its Enter", async () => {
    const r = late(24, 2_000);
    await run(r.daemon);
    expect(r.sendSpecialKey).toHaveBeenCalledWith("Enter");
    expect(r.deleteBackward).not.toHaveBeenCalled();
  });
  it("#3 too little budget left to see a write through: none is started", async () => {
    const r = late(26, 100); // another agent first seen at 13 s: under the 3 s reserve
    await run(r.daemon);
    expect(r.pasteBuffer).not.toHaveBeenCalled();
  });

  it("#4 an already aborted startup, or a launch already pausing: nothing at all", async () => {
    const a = rig({ panes: [theirs] });
    a.daemon.startupAborted = true;
    await run(a.daemon);
    expect(a.capturePane).not.toHaveBeenCalled();
    const p = rig({ panes: [theirs] });
    p.daemon.pauseWakeState = "pausing";
    await run(p.daemon);
    expect(p.capturePane).not.toHaveBeenCalled();
  });
  it("#4 a wake (phase `waking`) is allowed; a pause during it ends the step", async () => {
    const w = rig({ panes: [ours] });
    w.daemon.pauseWakeState = "waking";
    await run(w.daemon);
    expect(w.confirm).toHaveBeenCalledOnce();
    const p = rig({ panes: [theirs, theirs, ours] });
    p.daemon.pauseWakeState = "waking";
    p.pasteBuffer.mockImplementation(async () => { p.daemon.pauseWakeState = "pausing"; return true; });
    await run(p.daemon);
    expect(p.sendSpecialKey).not.toHaveBeenCalled();
    expect(p.confirm).not.toHaveBeenCalled();
  });
  it("#4 a stop between the paste and its Enter: no Enter, nothing taken back from a pane being torn down", async () => {
    const r = rig({ panes: [theirs, theirs, ours] });
    r.pasteBuffer.mockImplementation(async () => { r.daemon.deliveryWritesStopping = true; return true; });
    await run(r.daemon);
    expect(r.sendSpecialKey).not.toHaveBeenCalled();
    expect(r.deleteBackward).not.toHaveBeenCalled();
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.warnings).toEqual([]);
  });
});
