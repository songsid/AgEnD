import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { OpenCodeBackend } from "../src/backend/opencode.js";

/**
 * The daemon's runtime-dialog scanner against OpenCode's real panes: what it sends, and what it leaves alone.
 * The tmux is a stub that serves a pane and records keys; nothing here starts OpenCode or touches a tmux server.
 */
const pane = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const PROMPT = pane("opencode-1.18.34-permission-external-directory.pane.txt");
const ALWAYS = pane("opencode-1.18.34-permission-always-confirm.pane.txt");
const READY = pane("opencode-1.18.34-ready-after-tool.pane.txt");

let dir: string;
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger } as any;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "agend-oc-dialog-")); mkdirSync(join(dir, "inst")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function rig(current: () => string) {
  const keys: string[] = [];
  const d: any = new Daemon("oc", {
    working_directory: dir, backend: "opencode",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, join(dir, "inst"), false, new OpenCodeBackend(join(dir, "inst")) as any, undefined, logger);
  d.tmux = {
    isWindowAlive: async () => true,
    capturePane: async () => current(),
    capturePaneWithHistory: async () => current(),
    sendSpecialKey: async (key: string) => { keys.push(key); return true; },
    pasteText: async (text: string) => { keys.push(`paste:${text}`); return true; },
    getWindowId: () => "@1",
  };
  d.startErrorMonitor();
  return { d, keys, stop: () => clearInterval(d.errorMonitorTimer) };
}
const ticks = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("the scanner against OpenCode's real panes", () => {
  it("a live permission prompt is answered with one Enter (Allow once) — never Right", async () => {
    const { keys, stop } = rig(() => PROMPT);
    await ticks(5_100);
    expect(keys[0]).toBe("Enter");
    expect(keys).not.toContain("Right");
    stop();
  });

  it("the prompt is on screen: the pane takes no delivery and is reported as waiting for a human, not stuck", async () => {
    const events: unknown[] = [];
    const { d, stop } = rig(() => PROMPT);
    d.on("input_blocked", (event: unknown) => events.push(event));
    await ticks(5_100);
    expect(d.isInputBlocked()).toBe(true);
    expect(events).toContainEqual({ name: "oc", blocked: true, description: expect.stringContaining("Allow once") });
    const probe = await d.probeBlockingDialog();               // what the delivery gate asks before it pastes
    expect(probe.state).toBe("dialog");
    stop();
  });

  it("the 'Always allow' page is Cancelled back to the prompt, then the prompt is answered Allow once", async () => {
    let screen = ALWAYS;
    const { keys, stop } = rig(() => screen);
    await ticks(5_600);                                          // the 5 s scan, then the 200 ms between the two keys
    expect(keys.slice(0, 2)).toEqual(["Right", "Enter"]);        // Cancel
    screen = PROMPT;                                             // OpenCode repaints the prompt
    await ticks(5_600);
    expect(keys.slice(2)).toEqual(["Enter"]);                    // Allow once
    stop();
  });

  it("the idle screen gets no keys, however often it is scanned", async () => {
    const { keys, stop } = rig(() => READY);
    await ticks(30_000);
    expect(keys).toEqual([]);
    stop();
  });

  it("a transcript quoting the prompt (idle prompt below it) gets no keys", async () => {
    const quoted = `${PROMPT}\n${READY}`;
    const { keys, stop } = rig(() => quoted);
    await ticks(30_000);
    expect(keys).toEqual([]);
    stop();
  });

  it("an agent saying 'please confirm' gets no Enter (the old /confirm/i matched any viewport)", async () => {
    const chatter = `${READY}\n  ┃  Could you confirm which file you meant?  Permission required for the next step.`;
    const { keys, stop } = rig(() => chatter);
    await ticks(30_000);
    expect(keys).toEqual([]);
    stop();
  });
});
