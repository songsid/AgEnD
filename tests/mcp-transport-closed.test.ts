import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiroBackend } from "../src/backend/kiro.js";
import { Daemon } from "../src/daemon.js";

/**
 * #384. When the AgEnD MCP server dies, or something writes non-JSON-RPC to its
 * stdout, kiro drops the transport and prints:
 *
 *   ● Execution failed after 0.0s:
 *   Transport to MCP server 'agend-agend-leader-…' is closed.
 *   The server may have written non-JSON-RPC output to stdout which caused the
 *   connection to close. Check the server's stdout output and restart the session.
 *
 * kiro keeps running and keeps answering, so nothing looks wrong — but every
 * fleet tool is gone, which for an AgEnD instance means it can no longer reply,
 * report or delegate. It cannot reconnect in-session; only a restart can.
 */

const REAL_ERROR = [
  "● Execution failed after 0.0s:",
  "Transport to MCP server 'agend-agend-leader-t1503382358143799511' is closed.",
  "The server may have written non-JSON-RPC output to stdout which caused the connection to close.",
  "Check the server's stdout output and restart the session.",
].join("\n");

function findMatch(pane: string) {
  return new KiroBackend("/tmp/test").getErrorPatterns()
    .find(ep => ep.pattern.test(pane));
}

describe("kiro MCP transport-closed detection", () => {
  it("detects the real error and asks for a restart", () => {
    const match = findMatch(REAL_ERROR);

    expect(match).toMatchObject({ type: "crash", action: "restart" });
    // A restart loop is prevented by the default 5-minute per-pattern cooldown,
    // so this pattern must NOT opt out of it.
    expect(match?.skipCooldown).toBeFalsy();
  });

  it("says what happened and what is being done about it", () => {
    const match = findMatch(REAL_ERROR)!;

    // Deliberately no formatMessage: the quoted server name is always
    // `agend-<instance-name>`, and the notification already names the instance.
    expect(match.formatMessage).toBeUndefined();
    expect(match.message).toContain("MCP transport closed");
    expect(match.message).toContain("restarting");
  });

  it("also fires on the stdout-pollution sentence alone", () => {
    // The transport line can scroll out of the visible pane while the advice
    // paragraph is still on screen.
    const pane = "The server may have written non-JSON-RPC output to stdout which caused the connection to close.";
    expect(findMatch(pane)).toMatchObject({ action: "restart" });
  });

  it("does not fire on an agent discussing the failure", () => {
    // A fleet that maintains AgEnD will have agents writing about this very bug.
    // Restarting one of them mid-sentence would be worse than the bug.
    for (const prose of [
      "I think the MCP transport closed and that is why the tools vanished",
      "Should we detect 'Transport to MCP server is closed' in the error monitor?",
      "the transport to the MCP server was closed",
      "non-JSON-RPC output on stdout breaks MCP",
      "restart the session to fix MCP",
    ]) {
      expect(findMatch(prose), prose).toBeUndefined();
    }
  });

});

describe("the daemon acts on it", () => {
  it("emits pty_error with action restart, which the lifecycle turns into a respawn", () => {
    const instanceDir = mkdtempSync(join(tmpdir(), "agend-mcp-closed-"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const daemon = new Daemon("mcp-dead", {
      working_directory: "/tmp",
      restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
      hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
      log_level: "silent",
    } as any, instanceDir, false, { getReadyPattern: () => /\d+% !>/ } as any, undefined,
      { child: () => logger } as any);

    const errors: Array<{ action: string; type: string; message: string }> = [];
    daemon.on("pty_error", e => errors.push(e as never));

    try {
      const patterns = new KiroBackend("/tmp/test").getErrorPatterns();
      // Well past ERROR_COOLDOWN_MS from the epoch, or the first detection is
      // swallowed as a cooldown hit.
      (daemon as any).evaluateErrorPatterns(REAL_ERROR, patterns, /\d+% !>/, 10 * 60_000);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ action: "restart", type: "crash" });
      expect(errors[0].message).toContain("MCP transport closed");
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
