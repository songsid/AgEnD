import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import {
  LEGACY_TMUX_LOGICAL_SIZE,
  TmuxManager,
  resolveTmuxLogicalSize,
} from "../src/tmux-manager.js";
import { TmuxControlClient } from "../src/tmux-control.js";

const exec = promisify(execFile);

const PASTE_BYTES = 64 * 1024;

/**
 * How a 64 KiB paste is judged: it either arrives in full, or its size stops
 * growing for STALL_MS and it is called a stall — within CAP_MS either way.
 *
 * Growth is the only honest signal, and it cannot tell "slow" from "cut off"
 * quickly: a reader starved of CPU plateaus exactly like a truncated paste.
 * Measured, not assumed — a reader that stops draining at 28672 bytes for 8s
 * sits at 28672 the whole time, and tmux delivers the other 36864 the moment
 * it reads again. tmux holds undelivered paste bytes; it does not drop them.
 * The truncation test below pins that a real cut-off is still reported as a
 * stall, well before the cap. (CI's stalls at 28672 and 53248 were first read
 * as starvation and the window widened for them; they were bytes pasted before
 * the pane entered raw mode — see pasteInto.)
 */
const STALL_MS = 20_000;
const CAP_MS = 60_000;
const POLL_MS = 250;
const PASTE_TEST_TIMEOUT_MS = CAP_MS + 15_000;   // the integration default (30s) would cut the wait short

type Transfer = { size: number; stalled: boolean; plateauMs: number; elapsedMs: number };

/** Wait for the pane to report raw mode, or fail saying that is what never happened. */
async function waitForRawMode(ready: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error(`the pane never confirmed raw mode within ${timeoutMs / 1000}s`);
    await new Promise(r => setTimeout(r, 50));
  }
}


async function waitForTransfer(output: string, expected: number): Promise<Transfer> {
  // The file is created by the shell INSIDE the pane (`> file`), and
  // createWindow resolves when tmux has the window, not when that shell has
  // run its redirect — so a missing file is 0 bytes so far, not an error.
  const bytesSoFar = () => statSync(output, { throwIfNoEntry: false })?.size ?? 0;
  const startedAt = Date.now();
  let last = -1;
  let lastChangeAt = startedAt;
  for (;;) {
    const now = Date.now();
    const size = bytesSoFar();
    if (size >= expected) return { size, stalled: false, plateauMs: 0, elapsedMs: now - startedAt };
    if (size !== last) { last = size; lastChangeAt = now; }
    const plateauMs = now - lastChangeAt;
    if (plateauMs >= STALL_MS) return { size, stalled: true, plateauMs, elapsedMs: now - startedAt };
    if (now - startedAt >= CAP_MS) return { size, stalled: false, plateauMs, elapsedMs: now - startedAt };
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

const describeTransfer = (t: Transfer) => t.stalled
  ? `transfer stalled at ${t.size} of ${PASTE_BYTES} bytes after ${Math.round(t.plateauMs / 1000)}s without growth — truncated, not merely slow`
  : `transfer reached ${t.size} of ${PASTE_BYTES} bytes in ${Math.round(t.elapsedMs / 1000)}s`
    + (t.size < PASTE_BYTES ? ` (hit the ${CAP_MS / 1000}s cap, last growth ${Math.round(t.plateauMs / 1000)}s before)` : "");

describe("TmuxManager", () => {
  const session = `ccd-test-${Date.now()}`;

  afterAll(async () => {
    await TmuxManager.killSession(session);
  });

  it("creates and detects session", async () => {
    await TmuxManager.ensureSession(session);
    expect(await TmuxManager.sessionExists(session)).toBe(true);
  });

  it("enables mouse mode for both new and existing AgEnD sessions", async () => {
    const showMouse = async (): Promise<string> => {
      const { stdout } = await exec("tmux", [
        "show-options", "-v", "-t", session, "mouse",
      ]);
      return stdout.trim();
    };

    expect(await showMouse()).toBe("on");
    await exec("tmux", ["set-option", "-t", session, "mouse", "off"]);
    expect(await showMouse()).toBe("off");

    await TmuxManager.ensureSession(session);
    expect(await showMouse()).toBe("on");
  });

  it("creates window and checks alive", async () => {
    const tm = new TmuxManager(session, "");
    const windowId = await tm.createWindow("sleep 30", "/tmp");
    expect(windowId).toMatch(/@\d+/);
    expect(await tm.isWindowAlive()).toBe(true);
    expect(await tm.getWindowGeometry()).toEqual({
      columns: 120,
      rows: 36,
      mode: "latest",
    });
  });

  it("distinguishes a ready-looking cooked shell from a raw TUI pane", async () => {
    await TmuxManager.ensureSession(session);
    const tm = new TmuxManager(session, "");
    await tm.createWindow("sleep 2; stty raw -echo; sleep 10", "/tmp", "termios-gate");
    try {
      expect(await tm.getPaneInputMode()).toBe("cooked");
      const deadline = Date.now() + 5_000;
      while (await tm.getPaneInputMode() !== "raw" && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(await tm.getPaneInputMode()).toBe("raw");
    } finally {
      await tm.killWindow();
    }
  }, 10_000);

  it("reuses one window id instead of leaving duplicate same-name windows", async () => {
    const first = new TmuxManager(session, "");
    const firstId = await first.createWindow("sleep 30", "/tmp", "dedupe-window");
    const replacement = new TmuxManager(session, "");
    const replacementId = await replacement.createWindow("sleep 30", "/tmp", "dedupe-window");

    const matches = (await TmuxManager.listWindows(session))
      .filter(window => window.name === "dedupe-window");
    expect(replacementId).toBe(firstId);
    expect(matches).toEqual([{ id: replacementId, name: "dedupe-window" }]);
    expect(await replacement.getPaneStatus()).toEqual({ alive: true });
  });

  it("keeps a per-instance size stable while the control client is attached", async () => {
    const tm = new TmuxManager(session, "", { columns: 132, rows: 40 });
    await tm.createWindow("sleep 30", "/tmp", "stable-size");
    const control = new TmuxControlClient(session, 100);
    control.start();
    try {
      // Give tmux time to register the no-PTY control client. Before
      // ignore-size this is where window-size=latest collapsed to 80 cols.
      await new Promise(r => setTimeout(r, 500));
      expect(await tm.getWindowGeometry()).toEqual({
        columns: 132,
        rows: 40,
        mode: "latest",
      });
      control.stop();
      control.start();
      await new Promise(r => setTimeout(r, 500));
      expect(await tm.getWindowGeometry()).toEqual({
        columns: 132,
        rows: 40,
        mode: "latest",
      });
    } finally {
      control.stop();
    }
  });

  it("keeps window-size=latest after a resize (resize implicitly sets manual)", async () => {
    // tmux resets window-size to "manual" as a side effect of `resize-window
    // -x/-y`, so applyLogicalSize must set "latest" AFTER resizing. Getting the
    // order wrong silently pins the window and a human attach cannot resize it.
    const tm = new TmuxManager(session, "", { columns: 100, rows: 30 });
    await tm.createWindow("sleep 30", "/tmp", "resize-order");
    expect(await tm.getWindowGeometry()).toEqual({ columns: 100, rows: 30, mode: "latest" });
    // A respawn re-applies the geometry; the policy must survive that too.
    await tm.respawnWindow("sleep 30", "/tmp");
    expect(await tm.getWindowGeometry()).toEqual({ columns: 100, rows: 30, mode: "latest" });
  });

  it("sends keys and captures pane", async () => {
    const tm = new TmuxManager(session, "");
    await tm.createWindow("cat", "/tmp");
    await tm.sendKeys("hello world");
    await tm.sendSpecialKey("Enter");
    await new Promise(r => setTimeout(r, 500));
    const output = await tm.capturePane();
    expect(output).toContain("hello world");
  });

  it("submits pasted input while the shared control client is attached", async () => {
    const tm = new TmuxManager(session, "");
    await tm.createWindow("cat", "/tmp", "control-send-keys");
    const control = new TmuxControlClient(session, 100);
    control.start();
    try {
      // tmux 3.7 rejects send-keys when the session's only attached client is
      // read-only. This is the production shape: paste-buffer succeeds, then
      // Enter used to fail with "client is read-only" and leave text stranded.
      await new Promise(r => setTimeout(r, 500));
      expect(await tm.pasteBuffer("control-client-enter-regression")).toBe(true);
      expect(await tm.sendSpecialKey("Enter")).toBe(true);
      await new Promise(r => setTimeout(r, 300));
      expect(await tm.capturePane()).toContain("control-client-enter-regression");
    } finally {
      control.stop();
    }
  });

  /**
   * Paste 64 KiB into a pane running `reader`, which writes what it receives to
   * `payload` in a fresh dir, and report how the transfer ended. Raw mode
   * avoids the terminal's canonical 4096-byte line limit, so what is measured
   * is the tmux buffer transport itself.
   *
   * The paste waits until the pane has CONFIRMED raw mode. createWindow resolves
   * when tmux has the window, not when its shell has run `stty raw -echo`, and a
   * paste that lands before that is dropped for good — measured: with the stty
   * delayed 0.3s, 0 of 65536 bytes ever arrived; landing mid-paste loses part
   * of it. That, not a starved reader, is what CI's "stalled at 28672" and
   * "stalled at 53248 … after 20s" were: bytes that no longer existed, which no
   * stall window can wait out. The shell writes `ready` only after stty
   * succeeds, and nothing is pasted until it exists.
   */
  async function pasteInto(
    reader: (output: string, dir: string) => string,
    name: string,
    opts: { shellStartDelaySeconds?: number } = {},
  ): Promise<Transfer> {
    const dir = mkdtempSync(join(tmpdir(), "agend-large-paste-"));
    const output = join(dir, "payload");
    const ready = join(dir, "ready");
    const tm = new TmuxManager(session, "");
    try {
      const slowStart = opts.shellStartDelaySeconds ? `sleep ${opts.shellStartDelaySeconds}; ` : "";
      await tm.createWindow(`${slowStart}stty raw -echo && : > '${ready}'; ${reader(output, dir)}`, "/tmp", name);
      await waitForRawMode(ready);
      expect(await tm.pasteBuffer("x".repeat(PASTE_BYTES))).toBe(true);
      return await waitForTransfer(output, PASTE_BYTES);
    } finally {
      await tm.killWindow();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("loads a 64 KiB paste through stdin without the tmux argv ceiling", async () => {
    const t = await pasteInto(output => `head -c ${PASTE_BYTES} > '${output}'`, "large-paste");
    expect(t.size, describeTransfer(t)).toBe(PASTE_BYTES);
  }, PASTE_TEST_TIMEOUT_MS);

  it("does not paste into a pane that has not entered raw mode yet", async () => {
    // What CI actually hit. A shell that takes a second to run `stty raw -echo`
    // is still in canonical mode when a paste arrives, and those bytes are gone
    // — no wait brings them back. With the paste gated on the pane's own
    // confirmation, a slow start costs a second, not the payload.
    const t = await pasteInto(output => `head -c ${PASTE_BYTES} > '${output}'`, "slow-raw-paste",
      { shellStartDelaySeconds: 1 });
    expect(t.size, describeTransfer(t)).toBe(PASTE_BYTES);
  }, PASTE_TEST_TIMEOUT_MS);

  it("still completes a paste whose reader stops draining for a while", async () => {
    // The CI failure, reproduced on purpose: the reader takes 28 KiB, then
    // stops reading for 7s — past the old 5s window — then drains the rest.
    // A plateau that ends is a slow paste, and must not be called a stall.
    const t = await pasteInto((output, dir) => {
      const script = join(dir, "reader.py");
      writeFileSync(script, [
        "import os, time",
        `f = open(${JSON.stringify(output)}, "wb"); got = 0`,
        "while got < 28672:",
        "    b = os.read(0, min(4096, 28672 - got)); f.write(b); f.flush(); got += len(b)",
        "time.sleep(7)",
        `while got < ${PASTE_BYTES}:`,
        `    b = os.read(0, ${PASTE_BYTES} - got)`,
        "    if not b: break",
        "    f.write(b); f.flush(); got += len(b)",
      ].join("\n"));
      return `exec python3 '${script}'`;
    }, "starved-paste");
    expect(t.stalled, describeTransfer(t)).toBe(false);
    expect(t.size, describeTransfer(t)).toBe(PASTE_BYTES);
  }, PASTE_TEST_TIMEOUT_MS);

  it("still reports a truncated paste as a stall, before the cap", async () => {
    // The other half, which a longer window must not buy away: a reader that
    // takes half and stops for good is what a cut-off paste looks like. It has
    // to be called a stall at the byte it stopped, by the stall rule — not
    // discovered only when the overall cap runs out.
    const t = await pasteInto(output => `head -c 32768 > '${output}'; sleep 120`, "truncated-paste");
    expect(t.stalled, describeTransfer(t)).toBe(true);
    expect(t.size).toBe(32768);
    expect(t.elapsedMs, "judged by the stall window, not by the cap").toBeLessThan(CAP_MS);
  }, PASTE_TEST_TIMEOUT_MS);

  it("kills window", async () => {
    const tm = new TmuxManager(session, "");
    const wid = await tm.createWindow("sleep 30", "/tmp");
    await tm.killWindow();
    await new Promise(r => setTimeout(r, 200));
    expect(await tm.isWindowAlive()).toBe(false);
  });

  it("respawns a process in the same window", async () => {
    const tm = new TmuxManager(session, "", { columns: 100, rows: 30 });
    const wid = await tm.createWindow("sleep 30", "/tmp", "respawn-test");
    await tm.respawnWindow("sleep 30", "/tmp");
    expect(tm.getWindowId()).toBe(wid);
    expect(await tm.getPaneStatus()).toEqual({ alive: true });
    expect(await tm.getWindowGeometry()).toEqual({
      columns: 100,
      rows: 30,
      mode: "latest",
    });
  });

  it("pins 80x24 when the tmux size feature flag is disabled", async () => {
    const legacySize = resolveTmuxLogicalSize({
      enabled: false,
      columns: 200,
      rows: 60,
    });
    expect(legacySize).toEqual(LEGACY_TMUX_LOGICAL_SIZE);
    const tm = new TmuxManager(session, "", legacySize);
    await tm.createWindow("sleep 30", "/tmp", "legacy-size");
    expect(await tm.getWindowGeometry()).toEqual({
      columns: 80,
      rows: 24,
      mode: "latest",
    });
  });

  it("lists windows", async () => {
    const tm = new TmuxManager(session, "");
    await tm.createWindow("sleep 30", "/tmp", "test-win");
    const windows = await TmuxManager.listWindows(session);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]).toHaveProperty("id");
    expect(windows[0]).toHaveProperty("name");
  });
});
