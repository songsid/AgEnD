import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // Do not depend on what happens to be installed on the developer/CI host.
    const dataDir = mkdtempSync(join(tmpdir(), "agend-doctor-"));
    const emptyPath = mkdtempSync(join(tmpdir(), "agend-empty-path-"));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      const fm = new FleetManager(dataDir);
      const result = await (fm as unknown as { runBackendDoctor(): Promise<string> }).runBackendDoctor();
      expect(result).toContain("agend CLI not found in PATH");
    } finally {
      process.env.PATH = originalPath;
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it("does not block the event loop", async () => {
    // A missing executable can reject before the first timer tick, which says
    // nothing about whether execFile is blocking. Use a deterministic slow fake.
    const dataDir = mkdtempSync(join(tmpdir(), "agend-doctor-"));
    const binDir = mkdtempSync(join(tmpdir(), "agend-doctor-bin-"));
    const fakeAgend = join(binDir, "agend");
    writeFileSync(fakeAgend, "#!/bin/sh\n/bin/sleep 0.1\nprintf 'doctor complete\\n'\n");
    chmodSync(fakeAgend, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    const fm = new FleetManager(dataDir);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      const result = await (fm as unknown as { runBackendDoctor(): Promise<string> }).runBackendDoctor();
      expect(result).toBe("doctor complete\n");
    } finally {
      clearInterval(timer);
      process.env.PATH = originalPath;
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
    expect(ticks).toBeGreaterThan(5);
  });
});
