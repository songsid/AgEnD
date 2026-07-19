import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaneStateMachine } from "../src/daemon.js";
import { TmuxManager } from "../src/tmux-manager.js";

const TMUX_SESSION = `agend-e2e-tri-state-${process.pid}-${Date.now()}`;
const STUCK_THRESHOLD_MS = 15_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("tri-state detection with a real tmux pane", () => {
  let tmux: TmuxManager;

  beforeAll(async () => {
    await TmuxManager.ensureSession(TMUX_SESSION);
    tmux = new TmuxManager(TMUX_SESSION, "");
    await tmux.createWindow("bash --noprofile --norc", "/tmp", "tri-state");
    await sleep(300);
  });

  afterAll(async () => {
    await TmuxManager.killSession(TMUX_SESSION);
  });

  it("observes idle, working, stuck, then idle recovery", async () => {
    const machine = new PaneStateMachine(/E2E_READY/, STUCK_THRESHOLD_MS);

    // Idle: the command returns immediately and leaves a backend-like ready
    // marker in the stable pane.
    await tmux.sendKeys("clear; printf '\\nE2E_READY\\n'");
    await tmux.sendSpecialKey("Enter");
    await sleep(500);
    const idlePane = await tmux.capturePane();
    expect(idlePane).toContain("E2E_READY");
    expect(machine.observe(idlePane).state).toBe("idle");

    // Working: a real shell process changes pane output once per second. The
    // two captures prove that the hash, not elapsed wall time alone, drives it.
    await tmux.sendKeys("clear; i=0; while [ $i -lt 30 ]; do printf 'E2E_WORKING_%s\\n' \"$i\"; i=$((i+1)); sleep 1; done");
    await tmux.sendSpecialKey("Enter");
    await sleep(1_200);
    const workingPane1 = await tmux.capturePane();
    expect(machine.observe(workingPane1).state).toBe("working");
    await sleep(1_200);
    const workingPane2 = await tmux.capturePane();
    expect(workingPane2).not.toBe(workingPane1);
    expect(machine.observe(workingPane2).state).toBe("working");

    // Stuck: sleep keeps the process alive without changing its pane. Injecting
    // a 15-second threshold makes the production state machine testable without
    // changing the daemon's 10-minute default.
    await tmux.sendSpecialKey("C-c");
    await sleep(200);
    await tmux.sendKeys("clear; printf 'E2E_BUSY\\n'; sleep 30");
    await tmux.sendSpecialKey("Enter");
    await sleep(500);
    const stuckPane = await tmux.capturePane();
    expect(stuckPane).toContain("E2E_BUSY");
    expect(stuckPane).not.toContain("E2E_READY");
    expect(machine.observe(stuckPane).state).toBe("working");
    await sleep(STUCK_THRESHOLD_MS + 500);
    const unchangedPane = await tmux.capturePane();
    expect(unchangedPane).toBe(stuckPane);
    expect(machine.observe(unchangedPane).state).toBe("stuck");

    // Recovery: visible progress leaves stuck immediately; once the returned
    // prompt pane is stable, the state settles back to idle.
    await tmux.sendSpecialKey("C-c");
    await sleep(200);
    await tmux.sendKeys("clear; printf '\\nE2E_READY\\n'");
    await tmux.sendSpecialKey("Enter");
    await sleep(500);
    const recoveredPane = await tmux.capturePane();
    expect(machine.observe(recoveredPane).state).toBe("working");
    await sleep(500);
    expect(machine.observe(await tmux.capturePane()).state).toBe("idle");
  }, 30_000);
});
