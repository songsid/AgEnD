import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { FleetManager } from "../src/fleet-manager.js";

// Several fleet-process paths used execSync: /doctor (30s), the update check (15s,
// twice on a beta build), and the tmux pane probe in the IPC reconnect loop (no
// timeout at all). While those ran, the entire fleet event loop was frozen — no IPC,
// no adapter, no message delivery, and no WATCHDOG ping, so a slow one could push
// past WatchdogSec and have systemd SIGABRT the fleet.

const execFileP = promisify(execFile);

/** How many times a 10ms interval fires while `work` runs. */
async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return ticks;
}

describe("event loop liveness during child processes", () => {
  it("keeps timers running during an async child process", async () => {
    const ticks = await ticksDuring(() => execFileP("sleep", ["0.3"]));
    // ~30 ticks in 300ms; anything above a couple proves the loop kept turning.
    expect(ticks).toBeGreaterThan(5);
  });

  it("demonstrates the blocking behaviour that was replaced", async () => {
    // The regression guard's counterpart: a synchronous child blocks every timer
    // for its whole duration. This is what /doctor and the update check did.
    const ticks = await ticksDuring(async () => { execFileSync("sleep", ["0.3"]); });
    expect(ticks).toBe(0);
  });
});

describe("runBackendDoctor", () => {
  it("resolves to a string instead of throwing when the CLI is unavailable", async () => {
    // `agend` is not on PATH in the test environment, so this exercises the failure
    // branch — which must return the message, not reject into the caller.
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-doctor-")));
    const result = await (fm as unknown as { runBackendDoctor(): Promise<string> }).runBackendDoctor();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("does not block the event loop", async () => {
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-doctor-")));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      await (fm as unknown as { runBackendDoctor(): Promise<string> }).runBackendDoctor();
    } finally {
      clearInterval(timer);
    }
    // Even a fast failure yields at least one tick, because the await hands control
    // back to the loop — an execSync call would yield zero.
    expect(ticks).toBeGreaterThan(0);
  });
});
