import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import type { StartupDialog } from "../src/backend/types.js";

// Captured live from Claude Code 2.1.250 started with a corrupt .claude.json.
// Its ❯ selector satisfies claude's ready pattern /❯/, so without the fatal
// dialog entry this modal reports as "ready" and queued messages get typed
// into a menu whose Enter is "Exit and fix manually" — a crash loop.
const CORRUPT_CONFIG_MODAL = [
  "  Configuration error",
  "  The configuration file at /home/user/.claude.json contains invalid JSON.",
  "  JSON Parse error: Expected '}'",
  "  Choose an option:",
  "  ❯ 1. Exit and fix manually",
  "    2. Reset with default configuration",
  "  Enter to confirm · Esc to cancel",
].join("\n");

// The real backend's dialog table (getStartupDialogs doesn't touch `this`),
// so this test breaks if the fatal entry is dropped or reordered behind a
// dismissable pattern.
const claudeStartupDialogs: StartupDialog[] = ClaudeCodeBackend.prototype.getStartupDialogs.call(null);

function makeDaemon() {
  const instanceDir = mkdtempSync(join(tmpdir(), "agend-fatal-dialog-"));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("fatal-test", {
    working_directory: "/tmp",
    backend: "claude-code",
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, instanceDir, false, {
    binaryName: "claude",
    getReadyPattern: () => /❯/,
    getStartupDialogs: () => claudeStartupDialogs,
  } as any, undefined, { child: () => logger } as any);
  return { daemon, instanceDir };
}

describe("fatal startup dialogs", () => {
  it("corrupt-config modal reports config_error/pause without pressing any key", async () => {
    const { daemon, instanceDir } = makeDaemon();
    try {
      const sendSpecialKey = vi.fn();
      const sendKeys = vi.fn();
      (daemon as any).tmux = {
        capturePane: async () => CORRUPT_CONFIG_MODAL,
        isWindowAlive: async () => true,
        sendSpecialKey,
        sendKeys,
      };
      const errors: any[] = [];
      daemon.on("pty_error", e => errors.push(e));

      // Returns true to stop the spawn retry loop (like the sign-in screen
      // case): the pause action is what halts delivery, and a respawn would
      // only re-show the same modal.
      expect(await (daemon as any).dismissDialogsUntilReady(3)).toBe(true);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: "config_error", action: "pause" });
      // Never send keys into this modal: Enter would confirm "Exit and fix
      // manually" and exit the CLI.
      expect(sendSpecialKey).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();

      // The modal persists — a later pass must not spam a second report.
      await (daemon as any).dismissDialogsUntilReady(2);
      expect(errors).toHaveLength(1);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });

  it("a normal ready pane emits nothing", async () => {
    const { daemon, instanceDir } = makeDaemon();
    try {
      (daemon as any).tmux = { capturePane: async () => "claude ready\n❯ Try a prompt", isWindowAlive: async () => true };
      const errors: any[] = [];
      daemon.on("pty_error", e => errors.push(e));
      expect(await (daemon as any).dismissDialogsUntilReady(3)).toBe(true);
      expect(errors).toHaveLength(0);
    } finally {
      rmSync(instanceDir, { recursive: true, force: true });
    }
  });
});
