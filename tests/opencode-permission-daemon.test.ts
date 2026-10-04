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
  const parked: unknown[] = [];
  const ignored: unknown[] = [];
  d.on("dialog_parked", (event: unknown) => parked.push(event));
  d.on("dialog_answer_ignored", (event: unknown) => ignored.push(event));
  return { d, keys, parked, ignored, stop: () => clearInterval(d.errorMonitorTimer) };
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

  it("the 'Always allow' page is Cancelled (Escape) back to the prompt, then the prompt is answered Allow once", async () => {
    let screen = ALWAYS;
    const { keys, stop } = rig(() => screen);
    await ticks(5_600);                                          // the 5 s scan
    expect(keys).toEqual(["Escape"]);                            // Cancel — not Right+Enter, which from Cancel would grant "always"
    screen = PROMPT;                                             // OpenCode repaints the prompt
    await ticks(5_600);
    expect(keys.slice(1)).toEqual(["Enter"]);                    // Allow once
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

  it("a draft in the composer that quotes the dialog, busy footer below, gets no keys and does not block input", async () => {
    const draft = [
      "  ┃  △ Permission required", "  ┃    ← Access external directory /tmp/x", "  ┃",
      "  ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter confirm",
      "  ┃  Build · Mock Model Mock", "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", "                                 esc interrupt",
    ].join("\n");
    const { d, keys, stop } = rig(() => draft);
    await ticks(30_000);
    expect(keys).toEqual([]);
    expect(d.isInputBlocked()).toBe(false);
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

describe("a pending permission prompt whose screen keeps changing around it (the real prompt, the real predicates)", () => {
  /** Status line under the prompt: the spinner frame and elapsed time OpenCode would paint there. */
  const withStatus = (pane: string, frame: number) => pane.replace("• OpenCode 1.18.34", `${"⠋⠙⠹⠸⠼⠴"[frame % 6]} ${10 + frame}s • OpenCode 1.18.34`);

  it("the frame changes with every Enter, the SAME request stays pending: the ignored answer is reported, and no false 'parked'", async () => {
    let frame = 0;
    const { keys, ignored, parked, stop } = rig(() => withStatus(PROMPT, frame));
    const answered = keys;
    const spy = setInterval(() => { frame = answered.length; }, 1);   // the screen changes after every key
    await ticks(75_000);
    clearInterval(spy);
    expect(keys.length).toBeGreaterThanOrEqual(4);          // three answers, then one per 30 s backoff
    expect(ignored).toHaveLength(1);
    expect(parked).toEqual([]);
    stop();
  });

  it("the timer changes only BETWEEN polls, the request does not: the same", async () => {
    let frame = 0;
    const { keys, ignored, parked, stop } = rig(() => withStatus(PROMPT, frame));
    for (let n = 0; n < 15; n++) { frame = n; await ticks(5_000); }
    expect(keys.length).toBeGreaterThanOrEqual(4);          // three answers, then one per 30 s backoff
    expect(ignored).toHaveLength(1);
    expect(parked).toEqual([]);
    stop();
  });

  it("each Enter shows the NEXT queued request (another target, painted at once): no ignored report, no parked, for 100 s", async () => {
    let answered = 0;
    const { keys, ignored, parked, stop } = rig(() => PROMPT.replaceAll("/tmp/ocprobe-ext", `/tmp/ocprobe-ext-${answered}`));
    const spy = setInterval(() => { answered = keys.length; }, 1);
    await ticks(100_000);
    clearInterval(spy);
    expect(keys.length).toBeGreaterThanOrEqual(15);
    expect(ignored).toEqual([]);
    expect(parked).toEqual([]);
    stop();
  });

  it("a prompt that really sits there unchanged is reported, once", async () => {
    const { keys, ignored, stop } = rig(() => PROMPT);
    await ticks(75_000);
    expect(keys.length).toBeGreaterThanOrEqual(4);          // three answers, then one per 30 s backoff
    expect(ignored).toHaveLength(1);
    stop();
  });

  it("SIX identical queued requests (the same directory, again and again): all six are answered — after the third, slowly — and the user is told once", async () => {
    let queuedLeft = 6;
    const { keys, ignored, parked, stop } = rig(() => (queuedLeft > 0 ? PROMPT : READY));
    const spy = setInterval(() => { queuedLeft = Math.max(0, 6 - keys.length); }, 1);
    await ticks(16_800);
    expect(keys).toHaveLength(3);
    expect(ignored).toHaveLength(1);
    await ticks(5_000);
    expect(keys).toHaveLength(3);                          // the backoff: not one per poll
    await ticks(200_000);
    clearInterval(spy);
    expect(keys).toHaveLength(6);                          // the queue is drained: every request got its Enter
    expect(ignored).toHaveLength(1);
    expect(parked).toEqual([]);
    stop();
  });

  it("…and the same queue still drains when the wall clock jumps back an hour right after the report", async () => {
    let queuedLeft = 6;
    const { keys, ignored, stop } = rig(() => (queuedLeft > 0 ? PROMPT : READY));
    const spy = setInterval(() => { queuedLeft = Math.max(0, 6 - keys.length); }, 1);
    await ticks(16_800);
    expect(keys).toHaveLength(3);
    expect(ignored).toHaveLength(1);
    vi.setSystemTime(Date.now() - 3_600_000);
    await ticks(180_000);
    clearInterval(spy);
    expect(keys).toHaveLength(6);
    stop();
  });
});
