/**
 * #1116: one muse instance wrote 89,532 of the fleet's ~91,000 "execution state
 * changed" lines — an idle -> working / working -> idle pair every ~1.6s, for
 * days, while nothing was happening.
 *
 * The screen was never the cause. Muse <= 1.4.1 repaints its parked cursor
 * (`ESC[39m ESC[49m ESC[59m ESC[0m ESC[33;3H`, 132,169 of them in the two idle
 * hours at the end of one real output log, ~18 a second) without changing a
 * cell. Every burst arms a structural probe 500ms later; the probe's capture
 * takes a few ms, and about one probe in five has fresh output land inside that
 * window. That branch published "working" for a pane whose capture still showed
 * the idle layout, and because the idle state banks its confirmation the next
 * clean probe published "idle" again. Reproduced against the production Daemon,
 * a real tmux server and the real replayed log: 21 edges in 60s; with the fix, 0.
 *
 * The pane below is the real idle frame at the end of that log (replayed through
 * tmux); the working pane is the #1045 fixture, also from a real muse log.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon, STATE_EDGE_LOG_BURST, STATE_EDGE_LOG_WINDOW_MS } from "../src/daemon.js";
import { MuseBackend } from "../src/backend/muse.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const IDLE = fixture("muse-idle-parked-cursor-1116.pane.txt");
const WORKING = fixture("muse-thinking-over-a-minute.pane.txt");
/** Muse's parked-cursor repaint cadence in the real log (~18/s). */
const REPAINT_EVERY_MS = 55;
/** What one `tmux capture-pane` costs; long enough for the next burst to land inside it. */
const CAPTURE_MS = 15;

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1116-"));
  writeFileSync(join(dir, "window-id"), "@7");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
  const backend = new MuseBackend(dir);
  const daemon = new Daemon("worker", {
    working_directory: "/tmp", backend: "muse",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 15, idle_debounce_ms: 2_000 },
    log_level: "silent",
  } as any, dir, false, backend, undefined, logger as any) as any;
  const control = new EventEmitter();
  const state = { pane: IDLE, lastOutputAt: 0, overtaken: 0, captures: 0 };
  daemon.controlClient = control;
  daemon.tmux = {
    getWindowId: () => "@7",
    capturePane: vi.fn(async () => {
      state.captures++;
      const startedAt = Date.now();
      const pane = state.pane;
      await new Promise(resolve => setTimeout(resolve, CAPTURE_MS));
      if (state.lastOutputAt >= startedAt) state.overtaken++;
      return pane;
    }),
  };
  daemon.spawnGeneration++;
  const edges: Array<{ previous: string; state: string; at: number }> = [];
  let last = "idle";
  daemon.on("instance_state", (snapshot: { state: string }) => {
    edges.push({ previous: last, state: snapshot.state, at: Date.now() });
    last = snapshot.state;
  });
  daemon.startInstanceStateMonitor();
  cleanups.push(() => { daemon.stopInstanceStateMonitor(); rmSync(dir, { recursive: true, force: true }); });
  /**
   * Muse repainting its cursor for `ms`. The gaps average REPAINT_EVERY_MS but
   * are not regular (a fixed LCG keeps the run deterministic): a metronome would
   * sit in the same phase against the probe timer for ever and never land inside
   * a capture.
   */
  let seed = 1116;
  const gap = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return 20 + (seed >> 8) % (2 * REPAINT_EVERY_MS - 40); };
  const repaint = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms;) {
      state.lastOutputAt = Date.now();
      control.emit("output:@7", { paneId: "%1", windowId: "@7", at: Date.now() });
      const wait = gap();
      elapsed += wait;
      await vi.advanceTimersByTimeAsync(wait);
    }
  };
  return { daemon, state, edges, logger, repaint };
}

describe("an idle muse repainting its parked cursor does not flap (#1116)", () => {
  it("publishes no state edge in two minutes of ~18 repaints a second", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.daemon.instanceState).toBe("idle");
    await h.repaint(120_000);
    // The probes really were overtaken — the branch under test ran many times.
    expect(h.state.overtaken).toBeGreaterThan(20);
    expect(h.edges).toEqual([]);
    expect(h.daemon.instanceState).toBe("idle");
  });

  it("real work behind the same repaint still reads as working, once, and ends as idle once", async () => {
    const h = harness();
    await h.repaint(20_000);
    expect(h.edges).toEqual([]);

    // A turn starts: the pane shows muse's working row while the repaint continues.
    h.state.pane = WORKING;
    const startedAt = Date.now();
    await h.repaint(30_000);
    expect(h.edges.map(e => `${e.previous}->${e.state}`)).toEqual(["idle->working"]);
    expect(h.edges[0].at - startedAt, "the work is noticed within a probe or two").toBeLessThan(1_500);
    expect(h.daemon.instanceState).toBe("working");

    // The turn ends; the idle layout is back and the repaint goes on.
    h.state.pane = IDLE;
    const endedAt = Date.now();
    await h.repaint(30_000);
    expect(h.edges.map(e => `${e.previous}->${e.state}`)).toEqual(["idle->working", "working->idle"]);
    expect(h.edges[1].at - endedAt, "and idle is re-proved quickly").toBeLessThan(3_000);
    expect(h.daemon.instanceState).toBe("idle");
  });

  it("work that starts right after an overtaken probe is picked up by the next one", async () => {
    const h = harness();
    await h.repaint(10_000);
    // Run on until a probe has been overtaken, then start the work: the capture
    // that was overtaken showed idle, so only the NEXT probe can see the change.
    const before = h.state.overtaken;
    while (h.state.overtaken === before) await h.repaint(100);
    h.state.pane = WORKING;
    await h.repaint(3_000);
    expect(h.daemon.instanceState).toBe("working");
    expect(h.edges.map(e => `${e.previous}->${e.state}`)).toEqual(["idle->working"]);
  });
});

describe("a flapping instance cannot bury the fleet log again (#1116)", () => {
  function flap(daemon: any, times: number, everyMs = 1_000) {
    return (async () => {
      for (let i = 0; i < times; i++) {
        daemon.applyInstanceStateSnapshot({ state: i % 2 === 0 ? "working" : "idle", unchangedForMs: 0, observedAt: Date.now(), stateChangedAt: Date.now() });
        await vi.advanceTimersByTimeAsync(everyMs);
      }
    })();
  }
  const edgeLogs = (logger: { info: ReturnType<typeof vi.fn> }) =>
    logger.info.mock.calls.filter(call => call[1] === "Instance execution state changed").length;

  it("logs the first edges, then one warning, and still publishes every edge", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(100);
    await flap(h.daemon, 200);
    expect(edgeLogs(h.logger)).toBe(STATE_EDGE_LOG_BURST);
    const warnings = h.logger.warn.mock.calls.filter(call => /flapping/.test(String(call[1])));
    // one at the onset, then one per window while it lasts (200s of flapping)
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeLessThanOrEqual(Math.ceil(200_000 / STATE_EDGE_LOG_WINDOW_MS) + 1);
    expect(warnings[0][0]).toMatchObject({ backend: "muse" });
    // Every edge was still emitted to observers.
    expect(h.edges.length).toBe(200);
  });

  it("an instance that changes state a few times a minute is logged line by line, as before", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(100);
    await flap(h.daemon, 40, 20_000);
    expect(edgeLogs(h.logger)).toBe(40);
    expect(h.logger.warn.mock.calls.filter(call => /flapping/.test(String(call[1])))).toEqual([]);
  });

  it("reports how many edges it held back once the flapping stops", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(100);
    await flap(h.daemon, 40);
    await vi.advanceTimersByTimeAsync(2 * STATE_EDGE_LOG_WINDOW_MS);
    await flap(h.daemon, 1);
    const summary = h.logger.info.mock.calls.find(call => /were not logged/.test(String(call[1])));
    expect(summary?.[0]).toEqual({ notLogged: 40 - STATE_EDGE_LOG_BURST });
  });
});
