import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { CodexBackend } from "../src/backend/codex.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

/**
 * #1188: a Codex turn that runs for a long time with nothing new on screen but its own elapsed counter was declared
 * stuck (hang notice + restart attempt) while it was alive. Two things made that happen: the stuck-deadline capture
 * stamped "the pane changed" with the time of the LAST output event — minutes ago — rewinding the progress a later
 * capture had already proved; and the live status row's counter was never read as proof of life. Everything here runs
 * the production backend and state machine on panes shaped like the real ones; nothing starts Codex or a tmux server.
 */
const b = new CodexBackend("/tmp/codex-1188-probe");
const MIN = 60_000;
const status = (elapsed: string) => `• Working (${elapsed} • esc to interrupt)`;
const pane = (row: string) => ["• Earlier answer.", "", row, "", "› Ask Codex to do anything", "", "  Context 46% left · gpt-5.6-sol medium"].join("\n");
const withTimer = (elapsed: string) => pane(status(elapsed));
const machine = (progress = true) => new PaneStateMachine(b.getReadyPattern(), 10 * MIN, 0, b.getBusyPattern(), progress ? (p: string) => b.getLiveProgressTick(p) : null);

describe("the stuck-deadline capture after a long quiet turn", () => {
  it("does not rewind the progress a sweep already saw: the turn is still working", () => {
    const m = machine();
    m.recordOutput(5_000);                                  // the last output event, five seconds into the turn
    for (let t = 1; t <= 9; t++) m.observe(withTimer(`${t}m 00s`), t * MIN, { settled: true, changeAt: t * MIN });   // the 60 s sweeps see the timer move
    // stuck_deadline: its changeAt is the time of the OLD output event
    expect(m.observe(withTimer("10m 00s"), 10 * MIN + 5_000, { settled: true, changeAt: 5_000 }).state).toBe("working");
  });

  it("…even with no sweep in between: the deadline capture itself sees the counter has moved", () => {
    const m = machine();
    m.observe(withTimer("0m 05s"), 5_000, { settled: true, changeAt: 5_000 });
    expect(m.observe(withTimer("10m 05s"), 10 * MIN + 5_000, { settled: true, changeAt: 5_000 }).state).toBe("working");
  });

  it("…and the counter alone is enough even if nothing else about the pane differs", () => {
    const m = machine();
    // the same bytes except the counter; the machine is told the (old) output time as the change time
    for (let t = 0; t < 15; t++) {
      const snap = m.observe(withTimer(`${t}m 00s`), t * MIN + 5_000, { settled: true, changeAt: 5_000 });
      expect(snap.state, `${t} min`).toBe("working");
    }
  });
});

describe("a pane that really froze is still detected", () => {
  it("the same elapsed time on every capture: working until the stuck timeout, stuck after it", () => {
    const m = machine();
    m.observe(withTimer("5m 00s"), 0, { settled: true, changeAt: 0 });
    for (let t = 1; t <= 9; t++) expect(m.observe(withTimer("5m 00s"), t * MIN, { settled: true, changeAt: 0 }).state, `${t} min`).toBe("working");
    expect(m.observe(withTimer("5m 00s"), 10 * MIN, { settled: true, changeAt: 0 }).state).toBe("stuck");
  });

  it("a counter that moved and then stopped is stuck a full timeout after it stopped", () => {
    const m = machine();
    for (let t = 0; t <= 5; t++) m.observe(withTimer(`${t}m 00s`), t * MIN, { settled: true, changeAt: t * MIN });
    expect(m.observe(withTimer("5m 00s"), 14 * MIN, { settled: true, changeAt: 0 }).state).toBe("working");   // 9 min since it last moved
    expect(m.observe(withTimer("5m 00s"), 15 * MIN, { settled: true, changeAt: 0 }).state).toBe("stuck");     // 10 min
  });

  it("a counter that goes BACKWARDS (a new turn began) is movement too", () => {
    const m = machine();
    m.observe(withTimer("30m 00s"), 0, { settled: true, changeAt: 0 });
    expect(m.observe(withTimer("0m 05s"), 12 * MIN, { settled: true, changeAt: 0 }).state).toBe("working");
  });
});

describe("what does NOT count as the turn's own clock", () => {
  it("a status row with no elapsed time falls back to pane changes alone", () => {
    const row = "• Planning the edit (esc to interrupt)";
    const frozen = machine();
    frozen.observe(pane(row), 0, { settled: true, changeAt: 0 });
    expect(frozen.observe(pane(row), 10 * MIN, { settled: true, changeAt: 0 }).state).toBe("stuck");
    const moving = machine();
    moving.observe(pane(row), 0, { settled: true, changeAt: 0 });
    expect(moving.observe(`${pane(row)}\n  more output`, 10 * MIN, { settled: true, changeAt: 10 * MIN }).state).toBe("working");
  });

  it("a backend without a progress counter behaves exactly as before", () => {
    const m = machine(false);
    m.observe(withTimer("5m 00s"), 0, { settled: true, changeAt: 0 });
    expect(m.observe(withTimer("5m 00s"), 10 * MIN, { settled: true, changeAt: 0 }).state).toBe("stuck");
  });
});

describe("progress never moves backwards", () => {
  it("a capture for an older output event cannot erase newer progress", () => {
    const m = machine(false);
    m.observe("a", 100_000, { settled: true, changeAt: 100_000 });
    m.observe("b", 200_000, { settled: true, changeAt: 5_000 });              // changed, but stamped with an old time
    expect(m.snapshot(200_000).unchangedForMs).toBe(100_000);                 // still measured from 100 s, not from 5 s
  });

  it("recordOutput with an older time cannot rewind either", () => {
    const m = machine(false);
    m.recordOutput(100_000);
    m.recordOutput(5_000);
    expect(m.snapshot(110_000).unchangedForMs).toBe(10_000);
  });
});

describe("the elapsed counter, read off the live status row only", () => {
  const rows: Array<[string, number | null]> = [
    ["• Working (12s • esc to interrupt)", 12],
    ["• Working (2m 05s • esc to interrupt)", 125],
    ["• Reviewing the diff (1h 02m 05s • esc to interrupt)", 3725],
    ["• Running the focused tests (41s · esc to interrupt)", 41],
    ["• Checking migrations (1m 02s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close", 62],
    ["• Planning the edit (esc to interrupt)", null],
    ["  • Working (12s • esc to interrupt)", null],
    ["Working (12s • esc to interrupt)", null],
  ];
  it.each(rows)("%s → %s", (row, expected) => {
    expect(b.getLiveProgressTick(pane(row))).toBe(expected);
  });

  it("the LAST live row wins, and a pane with none has none", () => {
    expect(b.getLiveProgressTick(["• Working (9m 00s • esc to interrupt)", "", "• Working (1m 00s • esc to interrupt)", "› Ask Codex to do anything"].join("\n"))).toBe(60);
    expect(b.getLiveProgressTick(pane("• Done."))).toBeNull();
  });
});

describe("the daemon hands the backend's counter to its state machine", () => {
  let dir: string;
  beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-1188w-")); mkdirSync(join(dir, "inst")); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  function started(backend: "codex" | "claude-code") {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
    const impl = backend === "codex" ? new CodexBackend(join(dir, "inst")) : new ClaudeCodeBackend(join(dir, "inst"));
    const d: any = new Daemon("w", {
      working_directory: dir, backend, log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "inst"), false, impl as any, undefined, logger);
    d.processStatus = "running";
    d.tmux = { isWindowAlive: async () => true, capturePane: async () => withTimer("0m 05s"), getWindowId: () => "@1" };
    d.startInstanceStateMonitor();
    return d;
  }

  it("Codex: the state machine reads the live status row's counter", async () => {
    const d = started("codex");
    expect(d.instanceStateMachine.progressTick).toBeTypeOf("function");
    expect(d.instanceStateMachine.progressTick(withTimer("1m 00s"))).toBe(60);
    d.stopInstanceStateMonitor();
  });

  it("a backend without a counter gets none", async () => {
    const d = started("claude-code");
    expect(d.instanceStateMachine.progressTick).toBeNull();
    d.stopInstanceStateMonitor();
  });
});

describe("the daemon's stuck deadline follows the latest sign of life (no hot loop)", () => {
  let dir: string;
  beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-1188-")); mkdirSync(join(dir, "inst")); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  function rig() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
    const d: any = new Daemon("cx", {
      working_directory: dir, backend: "codex", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "inst"), false, new CodexBackend(join(dir, "inst")) as any, undefined, logger);
    const screen = { text: withTimer("0m 05s"), reads: 0 };
    d.processStatus = "running";
    d.tmux = { isWindowAlive: async () => true, capturePane: async () => { screen.reads++; return screen.text; }, getWindowId: () => "@1" };
    d.instanceStateMonitorActive = true;
    d.instanceStateStuckTimeoutMs = 10 * MIN;
    d.instanceStateReadyPattern = b.getReadyPattern();
    d.instanceStateMachine = new PaneStateMachine(b.getReadyPattern(), 10 * MIN, Date.now(), b.getBusyPattern(), p => b.getLiveProgressTick(p));
    const states: string[] = [];
    d.on("instance_state", (event: { state: string }) => states.push(event.state));

    return { d, screen, states };
  }

  it("a long quiet turn whose timer keeps moving: never stuck, and the deadline is re-armed for later — not re-fired at once", async () => {
    const { d, screen, states } = rig();
    const t0 = Date.now();
    d.instanceStateLastOutputAt = t0 - 30_000;               // the last output event, well before the first look (a settled capture)
    d.instanceStateMachine.recordOutput(t0 - 30_000);
    screen.text = withTimer("0m 05s");
    await d.captureAndEvaluateInstanceState("initial");
    vi.setSystemTime(t0 + 10 * MIN + 10_000);                // the deadline for the old output time comes due (the clock moves, no timer fires)
    screen.text = withTimer("10m 05s");
    screen.reads = 0;
    d.clearInstanceStateStuckTimer();                       // the deadline timer has just fired (its callback clears itself first)
    await d.captureAndEvaluateInstanceState("stuck_deadline", d.instanceStateLastOutputAt);
    expect(d.instanceState).toBe("working");
    expect(states).not.toContain("stuck");
    await vi.advanceTimersByTimeAsync(5_000);               // five seconds later…
    expect(screen.reads).toBeLessThanOrEqual(3);             // …not a capture loop
    expect(d.instanceStateStuckTimer).not.toBeNull();        // a deadline is armed, for later
    d.clearInstanceStateStuckTimer();
  });

  it("the same pane frozen: the deadline capture declares it stuck", async () => {
    const { d, screen, states } = rig();
    const t0 = Date.now();
    d.instanceStateLastOutputAt = t0 - 30_000;               // the last output event, well before the first look (a settled capture)
    d.instanceStateMachine.recordOutput(t0 - 30_000);
    screen.text = withTimer("0m 05s");
    await d.captureAndEvaluateInstanceState("initial");
    vi.setSystemTime(t0 + 10 * MIN + 10_000);
    await d.captureAndEvaluateInstanceState("stuck_deadline", d.instanceStateLastOutputAt);   // same text: the counter never moved
    expect(d.instanceState).toBe("stuck");
    expect(states).toContain("stuck");
    d.clearInstanceStateStuckTimer();
  });
});
