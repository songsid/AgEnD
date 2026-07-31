import { describe, it, expect, afterAll } from "vitest";
import {
  LEGACY_TMUX_LOGICAL_SIZE,
  TmuxManager,
  resolveTmuxLogicalSize,
} from "../src/tmux-manager.js";
import { TmuxControlClient } from "../src/tmux-control.js";

describe("TmuxManager", () => {
  const session = `ccd-test-${Date.now()}`;

  afterAll(async () => {
    await TmuxManager.killSession(session);
  });

  it("creates and detects session", async () => {
    await TmuxManager.ensureSession(session);
    expect(await TmuxManager.sessionExists(session)).toBe(true);
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
