/**
 * #2770 (ii): Claude's background-agent list repaints every second (each agent's elapsed time and tokens). Read as
 * motion, it held an idle main session "working" for as long as any agent ran (the leader, 2026-10-27, 21:03–21:13):
 * no idle edge, and the delivery idle gate never opened. While the list is on screen, the claude backend now proves
 * idle structurally (box readable, no queue, no spinner), the way Codex and Muse prove it under their redraws.
 * Without the list nothing changes: motion is work.
 *
 * Frames: the leader's recorded pane (tests/fixtures/claude-2.1.311-*.pane.txt, see claude-bg-agents-box.test.ts).
 * The daemon cases run the real Daemon and PaneStateMachine with a stub tmux; nothing starts a CLI or a tmux server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { Daemon, PaneStateMachine } from "../src/daemon.js";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const frame = (name: string) => fixture(`claude-2.1.311-${name}.pane.txt`);
const ONE_IDLE = frame("bg-agent-one-idle");
const TWO_WAITING = frame("bg-agents-two-waiting");
const THREE_BUSY = frame("bg-agents-three-busy");
const QUEUED = frame("bg-agent-queued-hint");
const NO_LIST_IDLE = fixture("claude-2.1.293-idle-empty.pane.txt");
const NO_LIST_BUSY = fixture("claude-2.1.293-busy-empty.pane.txt");
/** The same frame a second later: the agents' clocks moved (`3m 6s` → `3m 7s`, …). */
const tick = (pane: string, n: number) => pane.replace(/(\d+)s · ([↑↓])/g, (_m, s: string, a: string) => `${Number(s) + n}s · ${a}`);

const b = new ClaudeCodeBackend("/nonexistent-2770");

describe("the claude backend's proof", () => {
  it.each([
    ["one agent, main idle", ONE_IDLE, true, true],
    ["two agents, main idle (\"Waiting for 1 background agent to finish\")", TWO_WAITING, true, true],
    ["three agents, main working (spinner)", THREE_BUSY, true, false],
    ["one agent, main working with a queued message", QUEUED, true, false],
    ["no agents, idle", NO_LIST_IDLE, false, false],
    ["no agents, working", NO_LIST_BUSY, false, false],
  ])("%s", (_name, pane, layout, idle) => {
    expect(b.periodicRedrawFrom(pane)).toBe(layout);
    expect(b.isPeriodicRedrawIdlePane(pane)).toBe(idle);
  });

  it("the clocks moving changes the pane, not the verdict", () => {
    expect(tick(ONE_IDLE, 1)).not.toBe(ONE_IDLE);
    expect(b.isPeriodicRedrawIdlePane(tick(ONE_IDLE, 1))).toBe(true);
    expect(b.isPeriodicRedrawIdlePane(tick(THREE_BUSY, 1))).toBe(false);
  });

  it("a queue the box holds is a working main session, even on a frame that caught no spinner", () => {
    const noSpinner = QUEUED.replace(/^· Improvising….*\n/m, "");
    expect(b.getBusyPattern().test(noSpinner)).toBe(false);
    expect(b.isPeriodicRedrawIdlePane(noSpinner)).toBe(false);
  });

  it("an unreadable box under the list is not idle", () => {
    // the list's rows, but the box's lower rule gone: no box this reader vouches for
    const broken = ONE_IDLE.replace(/\n─{20,}\n(?=  ok)/, "\n");
    expect(b.periodicRedrawFrom(broken)).toBe(true);
    expect(b.isPeriodicRedrawIdlePane(broken)).toBe(false);
  });
});

describe("the daemon under a repainting agent list", () => {
  let dir: string;
  beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-2770-")); mkdirSync(join(dir, "inst")); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  function rig(first: string) {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
    const backend = new ClaudeCodeBackend(join(dir, "inst"));
    const d: any = new Daemon("leader", {
      working_directory: dir, backend: "claude-code", log_level: "silent",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    } as any, join(dir, "inst"), false, backend as any, undefined, logger);
    const screen = { text: first, reads: 0 };
    const out = { at: 0 };
    d.processStatus = "running";
    d.tmux = { isWindowAlive: async () => true, capturePane: async () => { screen.reads++; return screen.text; }, getWindowId: () => "@1" };
    d.controlClient = { isIdle: () => false, getLastOutputAt: () => out.at, getObservationResetAt: () => 0, hasOutputSince: () => true };
    d.instanceStateMonitorActive = true;
    d.instanceStateStuckTimeoutMs = 10 * 60_000;
    d.instanceStateMachine = new PaneStateMachine(backend.getReadyPattern(), 10 * 60_000, Date.now(), backend.getBusyPattern(), null);
    const states: string[] = [];
    d.on("instance_state", (event: { state: string }) => states.push(event.state));
    /** One second of Claude repainting: the clocks move, tmux reports output. */
    const second = async (base: string, n: number) => {
      screen.text = tick(base, n);
      out.at = Date.now();
      d.handleInstancePaneOutput({ windowId: "@1", at: out.at });
      await vi.advanceTimersByTimeAsync(1_000);
    };
    return { d, screen, states, second };
  }

  it("main idle, agents running: idle within seconds, stays idle, never stuck — and the delivery gate can open", async () => {
    const { d, states, second } = rig(NO_LIST_BUSY);
    await d.captureAndEvaluateInstanceState("initial");          // a turn, no agents yet: the last look until now
    for (let n = 0; n < 3; n++) await second(THREE_BUSY, n);      // it launches agents and keeps working
    expect(d.instanceState).toBe("working");
    // the turn ends; only the agents' clocks move from here on
    let idleAfter = -1, gateOpen = false;
    for (let n = 0; n < 15 * 60; n++) {
      await second(ONE_IDLE, n);
      if (idleAfter < 0 && d.instanceState === "idle") idleAfter = n;
      // the 50 ms delivery poll sees the gate open right after a look
      if (d.isPaneIdleForDelivery("@1")) gateOpen = true;
    }
    expect(idleAfter).toBeGreaterThanOrEqual(0);
    expect(idleAfter).toBeLessThanOrEqual(8);
    expect(d.instanceState).toBe("idle");
    expect(states).not.toContain("stuck");
    expect(states.slice(states.indexOf("idle"))).not.toContain("working");   // no flapping once idle
    expect(gateOpen).toBe(true);
    d.stopInstanceStateMonitor?.();
  });

  it("…the same with two agents and Claude's \"Waiting for 1 background agent to finish\" row", async () => {
    const { d, second } = rig(THREE_BUSY);
    await d.captureAndEvaluateInstanceState("initial");
    for (let n = 0; n < 30; n++) await second(TWO_WAITING, n);
    expect(d.instanceState).toBe("idle");
  });

  it("main working with agents running stays working (the spinner, or a queue it holds)", async () => {
    for (const busy of [THREE_BUSY, QUEUED]) {
      const { d, states, second } = rig(busy);
      await d.captureAndEvaluateInstanceState("initial");
      for (let n = 0; n < 60; n++) await second(busy, n);
      expect(d.instanceState).toBe("working");
      expect(states).not.toContain("idle");
    }
  });

  it("main starts a turn while agents run: idle → working on the next look", async () => {
    const { d, second } = rig(ONE_IDLE);
    await d.captureAndEvaluateInstanceState("initial");
    for (let n = 0; n < 15; n++) await second(ONE_IDLE, n);
    expect(d.instanceState).toBe("idle");
    for (let n = 0; n < 3; n++) await second(THREE_BUSY, n);
    expect(d.instanceState).toBe("working");
  });

  it("no agent list: moving output is work, exactly as before", async () => {
    const { d, screen, states, second } = rig(NO_LIST_IDLE);
    await d.captureAndEvaluateInstanceState("initial");
    expect(d.instanceState).toBe("idle");
    // the delivery gate keeps tmux's own silence as its evidence: output pending means not idle
    expect(d.isPaneIdleForDelivery("@1")).toBe(false);
    // the first output is work at once — no structural look in between
    d.handleInstancePaneOutput({ windowId: "@1", at: Date.now() });
    expect(d.instanceState).toBe("working");
    screen.reads = 0;
    for (let n = 0; n < 60; n++) await second(`${NO_LIST_IDLE}\n${"x".repeat(n % 7)}`, n);   // a pane that keeps changing
    expect(d.instanceState).toBe("working");
    expect(states).toContain("working");
    // the looks for an agent list are throttled: one per PERIODIC_LAYOUT_LOOK_MS, not one per output chunk
    expect(screen.reads).toBeLessThanOrEqual(13);
  });

  it("a new launch starts without the old launch's agent list", async () => {
    const { d } = rig(ONE_IDLE);
    await d.captureAndEvaluateInstanceState("initial");
    expect(d.periodicRedrawLayout).toBe(true);
    d.instanceStateMonitorActive = false;                         // the CLI was respawned
    Object.assign(d.controlClient, { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() });
    d.startInstanceStateMonitor();
    expect(d.periodicRedrawLayout).toBe(false);
    d.stopInstanceStateMonitor?.();
  });
});
