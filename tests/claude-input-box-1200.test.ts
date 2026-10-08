/**
 * #1200: claude-code's input box, read as a region, and what it lets the daemon prove about a delivery.
 *
 * Captured live from Claude Code 2.1.293 under the production launch (writeConfig + buildCommand, AgEnD's statusLine,
 * a private tmux socket, a local mock of the Anthropic API; tests/fixtures/claude-2.1.293-*.pane.txt). The box is the
 * rows between the last two `─` rules, with only the statusLine/mode rows under it; its first row is `❯` + U+00A0, its
 * further rows are indented two columns. A long paste stays collapsed in it (`[Pasted text #1 +11 lines]`), so the
 * delivery's own text is NOT visible there — only after submission, echoed above the box (idle) or in the queue block
 * above the spinner (busy), with the trailing `message_id` line on screen in both.
 *
 * The daemon cases run the real Daemon and DeliveryOutbox with a stub tmux serving those captures; nothing starts a CLI,
 * a fleet or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { ClaudeCodeBackend, readClaudeInputBox } from "../src/backend/claude-code.js";

const FIX = join(__dirname, "fixtures");
const pane = (name: string) => readFileSync(join(FIX, `claude-2.1.293-${name}.pane.txt`), "utf8");

describe("readClaudeInputBox on live 2.1.293 captures", () => {
  it.each([
    ["idle-empty", { text: "", collapsedPastes: 0 }],
    ["idle-draft", { text: "draft one two three", collapsedPastes: 0 }],
    ["idle-paste-multiline", { text: "short line one\nshort line two\nshort line three", collapsedPastes: 0 }],
    ["idle-paste-long", { text: "[Pasted text #1 +11 lines]", collapsedPastes: 1 }],
    ["after-submit", { text: "", collapsedPastes: 0 }],
    ["long-idle-submitted", { text: "", collapsedPastes: 0 }],
    ["busy-empty", { text: "", collapsedPastes: 0 }],
    ["busy-stranded", { text: "stranded while busy", collapsedPastes: 0 }],
    ["busy-paste-long", { text: "[Pasted text #2 +11 lines]", collapsedPastes: 1 }],
    ["long-busy-pasted", { text: "[Pasted text #4 +79 lines]", collapsedPastes: 1 }],
    // queued: the box shows "Press up to edit queued messages" — a placeholder, not input — under Claude's queue (#1169)
    ["busy-queued", { text: "", collapsedPastes: 0, queued: true }],
    ["busy-queued-long", { text: "", collapsedPastes: 0, queued: true }],
    ["long-busy-queued", { text: "", collapsedPastes: 0, queued: true }],
    ["tool-queued", { text: "", collapsedPastes: 0, queued: true }],
    ["busy-queued-two", { text: "", collapsedPastes: 0, queued: true }],
    ["busy-queued-under-quote", { text: "", collapsedPastes: 0, queued: true }],
    ["busy-reply-quotes-marker", { text: "", collapsedPastes: 0 }],
    ["queued-drained", { text: "", collapsedPastes: 0 }],
  ])("%s", (name, box) => {
    expect(readClaudeInputBox(pane(name))).toEqual(box);
  });

  it("the transcript echo above the box (`❯ ` with an ordinary space) is never read as input", () => {
    // after-submit shows the delivered message echoed with `❯ [agend-delivery-id:…]` above an empty box
    expect(pane("after-submit")).toMatch(/^❯ \[agend-delivery-id:/m);
    expect(readClaudeInputBox(pane("after-submit"))!.text).toBe("");
  });

  it("every older Claude fixture: dialogs and onboarding have no box (null); ready and busy panes have an empty one", () => {
    for (const f of readdirSync(FIX).filter(f => /^claude-2\.1\.28[6-9]-|^claude-2\.1\.291-/.test(f))) {
      const box = readClaudeInputBox(readFileSync(join(FIX, f), "utf8"));
      // A message Claude put back into the box after a failed request (#1239's capture): that IS the box's content.
      if (f === "claude-2.1.291-error-429-retry-escaped.pane.txt") {
        expect(box, f).toEqual({ text: "[user:alice via telegram, id:1] E429 please", collapsedPastes: 0 });
      } else if (/dialog|prompt|onboarding|theme|trust|bypass|login\b|login-method|oauth|resume|apikey|api-key|mcp|ext|settings|security|background-work|continue/.test(f)) {
        expect(box, f).toBeNull();
      } else if (f === "claude-2.1.291-error-500-retrying-statusline.pane.txt") {
        // a message queued while Claude retried (#1239's capture): an empty box under Claude's queue (#1169)
        expect(box, f).toEqual({ text: "", collapsedPastes: 0, queued: true });
      } else if (/ready|busy|error|compact|not-logged-in/.test(f)) {
        expect(box, f).toEqual({ text: "", collapsedPastes: 0 });
      }
    }
  });

  it("is anchored to the bottom: a box-shaped block with more than the footer under it is not the live box", () => {
    const quoted = `${pane("idle-draft").trimEnd()}\n  one\n  two\n  three\n  four\n  five`;
    expect(readClaudeInputBox(quoted)).toBeNull();
  });

  it("refuses rows it cannot vouch for: no prompt on the first row, an unindented row, a rule that carries text", () => {
    const draft = pane("idle-draft");
    expect(readClaudeInputBox(draft.replace("❯ draft one two three", "> draft one two three"))).toBeNull();
    expect(readClaudeInputBox(pane("idle-paste-multiline").replace("  short line two", "short line two"))).toBeNull();
    const rule = draft.split("\n").find(r => /^─{10,}$/.test(r.trimEnd()))!;
    expect(readClaudeInputBox(draft.split(rule).join(`${rule.slice(0, 20)} title ${rule.slice(20)}`))).toBeNull();
  });

  it("a long paste is counted, however many; the queue placeholder counts as empty", () => {
    const two = pane("idle-paste-long").replace("[Pasted text #1 +11 lines]", "[Pasted text #1 +11 lines][Pasted text #2 +3 lines]");
    expect(readClaudeInputBox(two)).toEqual({ text: "[Pasted text #1 +11 lines][Pasted text #2 +3 lines]", collapsedPastes: 2 });
  });

  it("the backend exposes it as readInputRow, and does not claim the prompt-row reader", () => {
    const backend = new ClaudeCodeBackend("/nonexistent-1200");
    expect(backend.readInputRow(pane("idle-draft"))).toEqual({ text: "draft one two three", collapsedPastes: 0 });
    expect((backend as any).getBottomReadyPattern).toBeUndefined();
    // supportsQueuedInput / getQueuedInputMarker arrived with #1169 (claude-queued-input-1169.test.ts).
  });
});

// ── The daemon, on those screens ─────────────────────────────────────────────────────────────────────────────────

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

interface Run {
  /** busy: a steer into a working pane (the hand-off path); idle: an ordinary delivery into a ready pane. */
  mode: "idle" | "steer-busy";
  messageId: string;
  /** What the pane shows, from the stub's own state. */
  screen: (s: { pasted: boolean; enters: number; idled: boolean }) => string;
  /** What the scrollback read (capturePaneWithHistory) shows; defaults to the screen. */
  history?: (s: { pasted: boolean; enters: number; idled: boolean }) => string;
  /** Captures after the first write throw (an EIO from tmux). */
  failCapturesAfterPaste?: boolean;
}

async function run(r: Run) {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "agend-1200-")); roots.push(root);
  const instanceDir = join(root, "instances", "worker");
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const s = { pasted: false, enters: 0, idled: false };
  const control = {
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => r.mode === "idle",
    hasOutputSince: () => true,
    waitUntilIdle: vi.fn(async () => { s.idled = true; return true; }),
  };
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, new ClaudeCodeBackend(instanceDir) as any, control as any, logger);
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const kind = r.mode === "steer-busy" ? "steer" : "fleet_inbound";
  const row = outbox.admit({
    operationId: "op", sourceKey: `s:op:w:${kind}`, sourceInstance: "source", sourceDaemonBootId: "sb",
    targetInstance: "worker", kind, payload: { type: kind, content: "hello", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  const tmux = {
    capturePane: vi.fn(async () => { if (r.failCapturesAfterPaste && s.pasted) throw new Error("EIO"); return r.screen(s); }),
    capturePaneWithHistory: vi.fn(async () => { if (r.failCapturesAfterPaste && s.pasted) throw new Error("EIO"); return (r.history ?? r.screen)(s); }),
    pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
    sendSpecialKey: vi.fn(async (key: string) => { if (key === "Enter") s.enters++; return true; }),
    getLastPasteError: vi.fn(), isLastPasteFailureRecoverable: vi.fn(() => true), getLastSendSpecialKeyError: vi.fn(),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue(r.mode === "idle" ? "ready" : "busy");
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  const confirmed = vi.fn(); daemon.on("message_confirmed", confirmed);
  const failed = vi.fn(); daemon.on("message_failed", failed);
  const meta = {
    delivery_id: row.deliveryId, delivery_attempt: String(claimed.attemptNo), from_instance: "source", correlation_id: "c",
    user: "instance:source", user_id: "instance:source", message_id: r.messageId, chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
  };
  if (r.mode === "steer-busy") daemon.steerMessage("hello", meta);
  else daemon.pushChannelMessage("hello", meta);
  for (let i = 0; i < 120; i++) {
    await vi.advanceTimersByTimeAsync(1_000);
    if (outbox.get(row.deliveryId)?.state !== "delivering" && tmux.pasteBuffer.mock.calls.length > 0) break;
  }
  await vi.advanceTimersByTimeAsync(5_000);
  const attempt = (outbox as any).db.prepare("SELECT evidence FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId) as { evidence: string | null };
  return { state: outbox.get(row.deliveryId)?.state, evidence: attempt?.evidence ?? null, tmux, control, confirmed, failed, s };
}

// The 80-line delivery: idle it echoes with its trailing `(message_id: xmsg-long-10 | …)` above the box; queued while busy
// the whole block (ending `(message_id: xmsg-long-11 | …)`) sits above the spinner; pasted, it is `[Pasted text #4 …]`.
const IDLE_EMPTY = pane("idle-empty");
const IDLE_PASTED = pane("idle-paste-long");
const IDLE_SUBMITTED = pane("long-idle-submitted");
const BUSY_EMPTY = pane("busy-empty");
const BUSY_PASTED = pane("long-busy-pasted");
const BUSY_QUEUED = pane("long-busy-queued");
/** The queued screen with a dialog where the box was: our marker is visible, the box cannot be read. */
const BUSY_QUEUED_NO_BOX = BUSY_QUEUED.slice(0, BUSY_QUEUED.indexOf("ctrl+x ctrl+s")) + "  ctrl+x ctrl+s to send now\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";

describe("an ordinary delivery into a ready Claude pane", () => {
  it("the echo with our message_id, outside the box, is the proof: delivered on positive evidence, one paste, one Enter", async () => {
    const r = await run({ mode: "idle", messageId: "xmsg-long-10", screen: s => (!s.pasted ? IDLE_EMPTY : s.enters === 0 ? IDLE_PASTED : IDLE_SUBMITTED) });
    expect(r.state).toBe("delivered");
    expect(r.evidence).toBe("positive submission proof");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(1);
    expect(r.failed).not.toHaveBeenCalled();
  });

  it("an Enter the TUI swallowed leaves the collapsed paste in the box: stranded — one more Enter, never a second paste", async () => {
    const r = await run({ mode: "idle", messageId: "xmsg-long-10", screen: s => (!s.pasted ? IDLE_EMPTY : s.enters < 2 ? IDLE_PASTED : IDLE_SUBMITTED) });
    expect(r.state).toBe("delivered");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(2);
  });

  it("still in the box after the recovery Enter: not delivered, no second paste", async () => {
    const r = await run({ mode: "idle", messageId: "xmsg-long-10", screen: s => (!s.pasted ? IDLE_EMPTY : IDLE_PASTED) });
    expect(r.state).not.toBe("delivered");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(2);
    expect(r.confirmed).not.toHaveBeenCalled();
  });

  it("the box empty but our echo nowhere on screen: not proven either way — left at 👀 for reconciliation, no ❌, no second paste", async () => {
    // The Codex rule (#910): a missing viewport echo cannot establish non-delivery. The attempt stays open.
    const r = await run({ mode: "idle", messageId: "xmsg-long-10", screen: s => (!s.pasted ? IDLE_EMPTY : s.enters === 0 ? IDLE_PASTED : IDLE_EMPTY) });
    expect(r.state).toBe("submission_started");
    expect(r.confirmed).not.toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.failed).not.toHaveBeenCalled();
  });
});

describe("a steer into a busy Claude pane", () => {
  it("taken into Claude's queue (the block above the spinner carries our message_id): delivered on positive evidence, not the #1197 label", async () => {
    const r = await run({ mode: "steer-busy", messageId: "xmsg-long-11", screen: s => (!s.pasted ? BUSY_EMPTY : s.enters === 0 ? BUSY_PASTED : BUSY_QUEUED) });
    expect(r.state).toBe("delivered");
    expect(r.evidence).toBe("positive submission proof");
    expect(r.control.waitUntilIdle).not.toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(1);
  });

  it("the Enter swallowed (our collapsed paste still in the box): one recovery Enter after the turn, never a second paste", async () => {
    const r = await run({ mode: "steer-busy", messageId: "xmsg-long-11", screen: s => (!s.pasted ? BUSY_EMPTY : s.enters < 2 ? BUSY_PASTED : BUSY_QUEUED) });
    expect(r.state).toBe("delivered");
    expect(r.control.waitUntilIdle).toHaveBeenCalled();
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(2);
  });

  // #1353 review: none of these proves the paste was lost — a box reader never pastes the same delivery twice.
  it("the steer was taken, but by the check its echo had scrolled out and after the turn the queue had drained: uncertain, NOT a second paste", async () => {
    const r = await run({ mode: "steer-busy", messageId: "xmsg-long-11", screen: s => (s.pasted && s.enters === 0 ? BUSY_PASTED : BUSY_EMPTY) });
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.s.enters).toBe(1);
    expect(r.state).not.toBe("delivered");
  });

  it("every capture after the write fails (EIO): no verdict either way — NOT a second paste", async () => {
    const r = await run({ mode: "steer-busy", messageId: "xmsg-long-11", screen: () => BUSY_EMPTY, failCapturesAfterPaste: true });
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.state).not.toBe("delivered");
  });

  it("after the turn our marker is on screen but no box can be read: uncertain, NOT a second paste (it could run twice)", async () => {
    const r = await run({ mode: "steer-busy", messageId: "xmsg-long-11", screen: s => (!s.pasted || !s.idled ? BUSY_EMPTY : BUSY_QUEUED_NO_BOX) });
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.state).toBe("uncertain");
  });
});

describe("a system paste into a ready Claude pane", () => {
  async function systemPaste(screen: (s: { pasted: boolean; enters: number; looks: number }) => string) {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-1200-sys-")); roots.push(root);
    const instanceDir = join(root, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@worker");
    const daemon: any = new Daemon("worker", {
      working_directory: root, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, instanceDir, false, new ClaudeCodeBackend(instanceDir) as any,
    { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true } as any, logger);
    const s = { pasted: false, enters: 0, looks: 0 };
    daemon.tmux = {
      capturePane: vi.fn(async () => { if (s.pasted && s.enters > 0) s.looks++; return screen(s); }),
      pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
      sendSpecialKey: vi.fn(async (key: string) => { if (key === "Enter") s.enters++; return true; }),
      getWindowId: () => "@worker",
    };
    // The 12-line delivery of the capture session (pasted collapsed as `[Pasted text #1 +11 lines]`, then echoed whole
    // above the box). A system paste has no unique id: its first-line signature is matched in that echo, against a
    // baseline that did not show it. (A paste so long that its echo's first line scrolls out of the pane cannot be
    // matched this way — system notices are a few lines.)
    const text = "[agend-delivery-id:5b0c1d2e-0000-4000-8000-000000000001]\n[from:agend-leader-t1] Please check the build.";
    const done = daemon.submitSystemPaste(text, "notice");
    await vi.advanceTimersByTimeAsync(20_000);
    return { ok: await done, s };
  }

  it("the paste is still collapsed in the box for the first looks after Enter: waited out, not a second Enter", async () => {
    const r = await systemPaste(s => (!s.pasted ? IDLE_EMPTY : s.enters === 0 || s.looks < 3 ? IDLE_PASTED : pane("after-submit")));
    expect(r.ok).toBe(true);
    expect(r.s.enters).toBe(1);
  });

  it("never leaves the box: one retry Enter, then reported not submitted", async () => {
    const r = await systemPaste(s => (!s.pasted ? IDLE_EMPTY : IDLE_PASTED));
    expect(r.ok).toBe(false);
    expect(r.s.enters).toBe(2);
  });
});

describe("evidence that cannot be attributed is not ours (#1353 review)", () => {
  /** idle-paste-long with extra rows under the frame: the reader refuses it (null) — the same box, unreadable. */
  const unreadable = (screen: string) => `${screen.trimEnd()}\n  a\n  b\n  c\n  d\n  e\n`;

  it("an older collapsed paste, unreadable before ours and readable after: not stranded — no recovery Enter on someone else's text", async () => {
    // Before our paste the box already held `[Pasted text #1 …]` (not ours) but the reader could not vouch for the
    // frame; after it, the same token is readable. Our own message is nowhere on screen.
    const r = await run({ mode: "idle", messageId: "xmsg-long-10", screen: s => (!s.pasted ? unreadable(IDLE_PASTED) : IDLE_PASTED) });
    expect(r.s.enters).toBe(1);
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(r.state).not.toBe("delivered");
  });

  it("the history read cannot vouch for a box it cannot read: our id still IN the unreadable box is not 'submitted'", async () => {
    // A short delivery still sitting in the box (its id visible inside it), the frame unreadable.
    const stuck = IDLE_EMPTY.replace(/^❯\u00a0?$/m, "❯\u00a0[from:x] hello (message_id: xmsg-short-1)");
    expect(stuck).not.toBe(IDLE_EMPTY);
    const r = await run({ mode: "idle", messageId: "xmsg-short-1", screen: s => (!s.pasted ? IDLE_EMPTY : unreadable(stuck)) });
    expect(r.state).not.toBe("delivered");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });

  it("the history read cannot vouch while our collapsed paste is still in the box, whatever older echo of the id is further up", async () => {
    // The steer is stranded (a new collapsed paste) all along; the scrollback holds an earlier echo carrying the id.
    const r = await run({
      mode: "steer-busy", messageId: "xmsg-long-11",
      screen: s => (!s.pasted ? BUSY_EMPTY : BUSY_PASTED),
      history: s => (!s.pasted ? BUSY_EMPTY : `${BUSY_QUEUED}\n${BUSY_PASTED}`),
    });
    expect(r.state).not.toBe("delivered");
    expect(r.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
  });
});

describe("text in the box after an unreadable baseline is not proof either (#1353 review)", () => {
  it("a system paste (no unique id) seen only IN the box, against a baseline whose box could not be read: never 'submitted'", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "agend-1200-res-")); roots.push(root);
    const instanceDir = join(root, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "window-id"), "@worker");
    const daemon: any = new Daemon("worker", {
      working_directory: root, log_level: "error", backend: "claude-code",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
    }, instanceDir, false, new ClaudeCodeBackend(instanceDir) as any,
    { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true } as any, logger);
    const s = { pasted: false, enters: 0 };
    const text = "[agend-delivery-id:5b0c1d2e-0000-4000-8000-000000000001]\n[from:agend-leader-t1] Please check the build.";
    const inBox = IDLE_EMPTY.replace(/^❯ ?$/m, `❯ ${text.split("\n")[0]}`);
    expect(inBox).not.toBe(IDLE_EMPTY);
    daemon.tmux = {
      capturePane: vi.fn(async () => (!s.pasted ? `${IDLE_EMPTY.trimEnd()}\n  a\n  b\n  c\n  d\n  e\n` : inBox)),
      pasteBuffer: vi.fn(async () => { s.pasted = true; return true; }),
      sendSpecialKey: vi.fn(async (key: string) => { if (key === "Enter") s.enters++; return true; }),
      getWindowId: () => "@worker",
    };
    const verdicts: string[] = [];
    const judge = daemon.confirmSubmitted.bind(daemon);
    daemon.confirmSubmitted = async (...args: unknown[]) => { const v = await judge(...args); verdicts.push(v); return v; };
    const done = daemon.submitSystemPaste(text, "notice");
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts).not.toContain("submitted");
    // Claude queues its own input since #1169: no defensive second Enter (it could touch the queue).
    expect(s.enters).toBe(1);
  });
});
