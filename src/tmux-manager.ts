import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalConfig } from "./types.js";

const exec = promisify(execFile);

export interface TmuxLogicalSize {
  columns: number;
  rows: number;
}

export const DEFAULT_TMUX_LOGICAL_SIZE: Readonly<TmuxLogicalSize> = Object.freeze({
  columns: 120,
  rows: 36,
});

export const LEGACY_TMUX_LOGICAL_SIZE: Readonly<TmuxLogicalSize> = Object.freeze({
  columns: 80,
  rows: 24,
});

/** Resolve an effective config into the geometry that must be pinned in tmux. */
export function resolveTmuxLogicalSize(config?: TerminalConfig): TmuxLogicalSize {
  if (config?.enabled === false) return { ...LEGACY_TMUX_LOGICAL_SIZE };
  return {
    columns: config?.columns ?? DEFAULT_TMUX_LOGICAL_SIZE.columns,
    rows: config?.rows ?? DEFAULT_TMUX_LOGICAL_SIZE.rows,
  };
}

export class TmuxManager {
  private windowId: string;

  // Socket isolation: null = use tmux default socket (backward compatible).
  // Set to a name to use `-L <name>` for custom AGEND_HOME isolation.
  private static socketName: string | null = null;

  static setSocketName(name: string | null): void {
    TmuxManager.socketName = name;
  }

  /** Prefix tmux args with -L when socket isolation is active. */
  private static tmuxArgs(args: string[]): string[] {
    if (!TmuxManager.socketName) return args;
    return ["-L", TmuxManager.socketName, ...args];
  }

  constructor(
    private sessionName: string,
    windowId: string,
    private logicalSize: TmuxLogicalSize = { ...DEFAULT_TMUX_LOGICAL_SIZE },
  ) {
    this.windowId = windowId;
  }

  // === Static session-level methods ===

  static async ensureSession(name: string): Promise<void> {
    if (await TmuxManager.sessionExists(name)) return;
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["new-session", "-d", "-s", name]));
    } catch (err) {
      if (String(err).includes("duplicate session")) return;
      throw err;
    }
  }

  static async sessionExists(name: string): Promise<boolean> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["has-session", "-t", name]));
      return true;
    } catch { return false; }
  }

  static async killSession(name: string): Promise<void> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["kill-session", "-t", name]));
    } catch {
      // Expected if session doesn't exist
    }
  }

  static async listWindows(sessionName: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
        "list-windows", "-t", sessionName, "-F", "#{window_id}|||#{window_name}"
      ]));
      return stdout.trim().split("\n").filter(Boolean).map(line => {
        const [id, name] = line.split("|||");
        return { id, name };
      });
    } catch { return []; }
  }

  static async getPanePid(sessionName: string, windowId: string): Promise<number | null> {
    try {
      const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
        "list-panes", "-t", `${sessionName}:${windowId}`, "-F", "#{pane_pid}",
      ]));
      const pid = parseInt(stdout.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch { return null; }
  }

  // === Instance window methods ===

  async createWindow(command: string, cwd: string, windowName?: string): Promise<string> {
    const args = ["new-window", "-a", "-t", this.sessionName, "-c", cwd];
    if (windowName) args.push("-n", windowName);
    args.push("-P", "-F", "#{window_id}", command);
    const { stdout } = await exec("tmux", TmuxManager.tmuxArgs(args));
    this.windowId = stdout.trim();
    try {
      // Apply the configured geometry and hand sizing to real terminals. The
      // control-mode client is kept harmless by its `ignore-size` flag, which is
      // what makes `window-size latest` safe here (see applyLogicalSize).
      await this.applyLogicalSize();
      if (windowName) {
        await exec("tmux", TmuxManager.tmuxArgs(["set-window-option", "-t", `${this.sessionName}:${this.windowId}`, "allow-rename", "off"])).catch(() => {});
      }
    } catch (err) {
      // Do not leave a live instance in an unpinned geometry if setup fails.
      await this.killWindow();
      throw err;
    }
    return this.windowId;
  }

  /** Restart the process inside the existing window, preserving its window id. */
  async respawnWindow(command: string, cwd: string): Promise<void> {
    if (!this.windowId) throw new Error("Cannot respawn tmux window without a window id");
    // Apply before respawn so the new CLI sees the intended COLUMNS/LINES from
    // its first frame. Reapplying is idempotent and repairs external drift.
    await this.applyLogicalSize();
    await exec("tmux", TmuxManager.tmuxArgs([
      "respawn-window", "-k", "-t", `${this.sessionName}:${this.windowId}`,
      "-c", cwd, command,
    ]));
  }

  /**
   * Give the window its configured geometry, then hand sizing authority to real
   * terminals: with `window-size latest`, a human `tmux attach` resizes the
   * window to their terminal instead of being stuck at the configured size.
   *
   * ORDER MATTERS. `resize-window -x/-y` implicitly switches the option back to
   * `manual`, so `latest` must be set AFTER the resize or it is silently undone.
   *
   * Safe because the shared control-mode client attaches with `-f ignore-size`
   * (see tmux-control.ts): verified on a scratch tmux server that under `latest`
   * an ignore-size control client does NOT collapse the window to its synthetic
   * 80 columns, while a real 200x50 PTY client does take over — and the size
   * persists after that client detaches.
   */
  private async applyLogicalSize(): Promise<void> {
    if (!this.windowId) throw new Error("Cannot size tmux window without a window id");
    const target = `${this.sessionName}:${this.windowId}`;
    await exec("tmux", TmuxManager.tmuxArgs([
      "resize-window", "-t", target,
      "-x", String(this.logicalSize.columns),
      "-y", String(this.logicalSize.rows),
    ]));
    await exec("tmux", TmuxManager.tmuxArgs([
      "set-window-option", "-t", target, "window-size", "latest",
    ]));
  }

  async killWindow(): Promise<void> {
    if (!this.windowId) return;
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["kill-window", "-t", `${this.sessionName}:${this.windowId}`]));
    } catch {
      // Expected if window already exited
    }
  }

  /**
   * Check if the tmux window still exists in the session.
   * Note: with remain-on-exit enabled, a window with a dead pane still
   * returns true. Use getPaneStatus() to distinguish alive vs dead pane.
   */
  async isWindowAlive(): Promise<boolean> {
    if (!this.windowId) return false;
    try {
      const windows = await TmuxManager.listWindows(this.sessionName);
      return windows.some(w => w.id === this.windowId);
    } catch { return false; }
  }

  /** Enable remain-on-exit so dead panes are preserved for exit code capture. */
  async setRemainOnExit(): Promise<void> {
    await exec("tmux", TmuxManager.tmuxArgs([
      "set-option", "-t", `${this.sessionName}:${this.windowId}`,
      "remain-on-exit", "on",
    ]));
  }

  /**
   * Get pane status. Returns null if the window doesn't exist.
   * When remain-on-exit is enabled, a dead pane has alive=false with exitCode.
   * exitCode is undefined if tmux version doesn't support pane_dead_status (< 3.1).
   */
  async getPaneStatus(): Promise<{ alive: boolean; exitCode?: number } | null> {
    if (!this.windowId) return null;
    try {
      const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
        "list-panes", "-t", `${this.sessionName}:${this.windowId}`,
        "-F", "#{pane_dead} #{pane_dead_status}",
      ]));
      const line = stdout.trim().split("\n")[0];
      if (!line) return null;
      const parts = line.split(" ");
      const dead = parts[0];
      if (dead === "1") {
        const code = parseInt(parts[1], 10);
        return { alive: false, exitCode: Number.isNaN(code) ? undefined : code };
      }
      return { alive: true };
    } catch {
      return null;
    }
  }

  /** Return tmux's effective window geometry and sizing policy (diagnostics/tests). */
  async getWindowGeometry(): Promise<TmuxLogicalSize & { mode: string }> {
    if (!this.windowId) throw new Error("Cannot inspect tmux window without a window id");
    const target = `${this.sessionName}:${this.windowId}`;
    const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
      "display-message", "-p", "-t", target,
      "#{window_width} #{window_height}",
    ]));
    const { stdout: modeOutput } = await exec("tmux", TmuxManager.tmuxArgs([
      "show-window-options", "-v", "-t", target, "window-size",
    ]));
    const [columnsRaw, rowsRaw] = stdout.trim().split(/\s+/);
    const columns = Number.parseInt(columnsRaw, 10);
    const rows = Number.parseInt(rowsRaw, 10);
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) {
      throw new Error(`Invalid tmux window geometry: ${stdout.trim()}`);
    }
    return { columns, rows, mode: modeOutput.trim() };
  }

  async sendKeys(text: string): Promise<boolean> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-l", "-t", `${this.sessionName}:${this.windowId}`, text]));
      return true;
    } catch { return false; }
  }

  async sendSpecialKey(key: "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c" | "C-q"): Promise<boolean> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-t", `${this.sessionName}:${this.windowId}`, key]));
      return true;
    } catch { return false; }
  }

  async pasteText(text: string): Promise<boolean> {
    try {
      const target = `${this.sessionName}:${this.windowId}`;
      const bufName = `paste-${this.windowId}-${Date.now()}`;
      await exec("tmux", TmuxManager.tmuxArgs(["set-buffer", "-b", bufName, "--", text]));
      await exec("tmux", TmuxManager.tmuxArgs(["paste-buffer", "-d", "-b", bufName, "-t", target, "-p"]));
      await new Promise(r => setTimeout(r, 500));
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-t", target, "Enter"]));
      // Retry Enter: if TUI was busy outputting, the first Enter may be swallowed.
      // A second Enter on an empty input is a no-op for all supported CLIs.
      await new Promise(r => setTimeout(r, 1000));
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-t", target, "Enter"]));
      return true;
    } catch { return false; }
  }

  /**
   * Paste text into the pane WITHOUT submitting (no Enter). Returns false on failure.
   * Callers that need to verify the idle→busy transition before/after Enter use this
   * together with sendSpecialKey("Enter") so they control submit timing and retries.
   */
  async pasteBuffer(text: string): Promise<boolean> {
    try {
      const target = `${this.sessionName}:${this.windowId}`;
      const bufName = `paste-${this.windowId}-${Date.now()}`;
      await exec("tmux", TmuxManager.tmuxArgs(["set-buffer", "-b", bufName, "--", text]));
      await exec("tmux", TmuxManager.tmuxArgs(["paste-buffer", "-d", "-b", bufName, "-t", target, "-p"]));
      return true;
    } catch { return false; }
  }

  async pipeOutput(logPath: string): Promise<void> {
    // pipe-pane's shell command runs via /bin/sh -c. Reject control characters
    // that would break out of the single-quote escape (newlines, NULs, etc.);
    // only expect absolute paths produced by getAgendHome() / instanceDir.
    if (/[\x00-\x1f]/.test(logPath)) {
      throw new Error(`Invalid log path (contains control characters): ${JSON.stringify(logPath)}`);
    }
    const escaped = logPath.replace(/'/g, "'\\''");
    await exec("tmux", TmuxManager.tmuxArgs([
      "pipe-pane", "-t", `${this.sessionName}:${this.windowId}`,
      `cat >> '${escaped}'`,
    ]));
  }

  async capturePane(): Promise<string> {
    const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
      "capture-pane", "-t", `${this.sessionName}:${this.windowId}`, "-p",
    ]));
    return stdout;
  }

  /** Capture pane content including scrollback history (last N lines). */
  async capturePaneWithHistory(lines: number = 50): Promise<string> {
    const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
      "capture-pane", "-t", `${this.sessionName}:${this.windowId}`,
      "-p", "-S", `-${lines}`,
    ]));
    return stdout;
  }

  getWindowId(): string { return this.windowId; }
}
