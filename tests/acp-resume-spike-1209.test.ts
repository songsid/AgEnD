/** #1209 SPIKE (branch-only): ACP-style cross-restart turn resume, scenario matrix. Stub tmux, no CLI. */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";

const MARKER = "in-flight-turn.json";

function makeDaemon() {
  const root = mkdtempSync(join(tmpdir(), "agend-acp-spike-"));
  const instanceDir = join(root, "inst");
  mkdirSync(instanceDir, { recursive: true });
  const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: "claude-code",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, new ClaudeCodeBackend(instanceDir) as any,
  { getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, waitUntilIdle: vi.fn(async () => true), hasOutputSince: () => false } as any, logger);
  const markerPath = join(instanceDir, MARKER);
  return { daemon, markerPath };
}

const inboundMeta = {
  delivery_id: "d-1", delivery_attempt: "1", from_instance: "", correlation_id: "c-1",
  user: "u", user_id: "u", message_id: "m-1", chat_id: "chat", thread_id: "", ts: new Date().toISOString(),
};

afterEach(() => { vi.useRealTimers(); });

describe("#1209 spike: in-flight turn marker lifecycle", () => {
  it("arming a channel turn writes the marker; a non-channel inbound does not", async () => {
    const h = makeDaemon();
    h.daemon.markTurnStarted({ ...inboundMeta }, "hello");
    expect(existsSync(h.markerPath)).toBe(true);
    const saved = JSON.parse(readFileSync(h.markerPath, "utf-8"));
    expect(saved).toMatchObject({ deliveryId: "d-1", correlationId: "c-1", chatId: "chat" });

    const h2 = makeDaemon();
    h2.daemon.markTurnStarted({ ...inboundMeta, from_instance: "other", chat_id: "" }, "hello");
    expect(existsSync(h2.markerPath)).toBe(false);
  });

  it("cancel drops the marker: a cancelled turn never resumes (#1199)", async () => {
    const h = makeDaemon();
    h.daemon.markTurnStarted({ ...inboundMeta }, "hello");
    expect(existsSync(h.markerPath)).toBe(true);
    h.daemon.clearPendingDeliveries();
    expect(existsSync(h.markerPath)).toBe(false);
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("none");
  });

  it("a completed turn clears the marker at the busy→idle edge", async () => {
    const h = makeDaemon();
    h.daemon.markTurnStarted({ ...inboundMeta }, "hello");
    const token = h.daemon.turnReplyGuard.beginToolAttempt(false, true);
    h.daemon.turnReplyGuard.settleToolAttempt(token, true);
    await h.daemon.maybeProxyReplyOnTurnEnd();
    expect(existsSync(h.markerPath)).toBe(false);
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("none");
  });
});

describe("#1209 spike: conditional continuation matrix", () => {
  function withMarker() {
    const h = makeDaemon();
    writeFileSync(h.markerPath, JSON.stringify({
      deliveryId: "d-9", correlationId: "c-9", messageId: "m-9",
      chatId: "chat", threadId: "", adapterId: "", backend: "claude-code", armedAt: Date.now(),
    }));
    return h;
  }

  it("no marker → none, nothing injected", async () => {
    const h = makeDaemon();
    const push = vi.spyOn(h.daemon, "pushChannelMessage").mockImplementation(() => {});
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("none");
    expect(push).not.toHaveBeenCalled();
  });

  it("crash-loop (skipResume) → suppressed, marker consumed once (#835)", async () => {
    const h = withMarker();
    h.daemon.skipResume = true;
    const push = vi.spyOn(h.daemon, "pushChannelMessage").mockImplementation(() => {});
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("suppressed-crash-loop");
    expect(push).not.toHaveBeenCalled();
    expect(existsSync(h.markerPath)).toBe(false);
  });

  it("CLI already re-engaged → skipped, no double-drive", async () => {
    const h = withMarker();
    vi.spyOn(h.daemon, "didCliReengageAfterResume").mockResolvedValue("reengaged");
    const push = vi.spyOn(h.daemon, "pushChannelMessage").mockImplementation(() => {});
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("skipped-cli-reengaged");
    expect(push).not.toHaveBeenCalled();
  });

  it("CLI state unobservable → suppressed, never a guess", async () => {
    const h = withMarker();
    vi.spyOn(h.daemon, "didCliReengageAfterResume").mockResolvedValue("unknown");
    const push = vi.spyOn(h.daemon, "pushChannelMessage").mockImplementation(() => {});
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("suppressed-unobservable");
    expect(push).not.toHaveBeenCalled();
  });

  it("CLI idle → exactly one bounded continuation tied to the original request", async () => {
    const h = withMarker();
    vi.spyOn(h.daemon, "didCliReengageAfterResume").mockResolvedValue("idle");
    const push = vi.spyOn(h.daemon, "pushChannelMessage").mockImplementation(() => {});
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("injected");
    expect(push).toHaveBeenCalledTimes(1);
    const [text, meta] = push.mock.calls[0];
    expect(text).toContain("c-9");
    expect(meta).toMatchObject({ correlation_id: "c-9", resumedContinuationOf: "d-9", chat_id: "chat" });
    // Episode-once: the marker was consumed before gating, so a second boot finds nothing.
    expect(existsSync(h.markerPath)).toBe(false);
    expect(await h.daemon.maybeResumeInterruptedTurn()).toBe("none");
    expect(push).toHaveBeenCalledTimes(1);
  });
});
