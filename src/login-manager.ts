/**
 * One remote login session: a dedicated tmux window running a backend's login
 * command, polled until it succeeds, fails, times out, or is cancelled.
 *
 * Deliberately NOT an instance pane. Credentials are per-backend (instances
 * symlink or share the backend's real home), so signing in once from a clean
 * window fixes every instance of that backend, and no instance delivery,
 * pane-state machine, or progress monitor ever observes login output.
 */
import type { Logger } from "./logger.js";
import { extractLoginHint, type LoginFlow } from "./login-flows.js";

/** The slice of TmuxManager a login session drives (injectable for tests). */
export interface LoginTmux {
  /** Must complete or fail within a hard bound; a window it may have created is reachable by `windowName` even if the id was never learned. */
  createWindow(command: string, cwd: string, windowName?: string): Promise<string>;
  setRemainOnExit(): Promise<void>;
  capturePaneJoined(lines?: number): Promise<string>;
  getPaneStatus(): Promise<{ alive: boolean; exitCode?: number } | null>;
  killWindow(): Promise<void>;
  /** Kill the window and CONFIRM it is gone; false when it may still exist. TmuxManager.killWindow() alone swallows errors. */
  killWindowConfirmed?(): Promise<boolean>;
  sendSpecialKey(key: "Enter" | "Escape" | "Up" | "Down" | "Right" | "Left" | "C-c" | "C-q"): Promise<boolean>;
  pasteText(text: string, opts?: { retryEnter?: boolean }): Promise<boolean>;
}

export interface LoginSessionEvents {
  /** The CLI is showing its arrow-key selector — offer the options as buttons. */
  onMenu(options: string[]): void | Promise<void>;
  /** The authorization URL (and one-time code, when shown) is on screen. */
  onAuthHint(url: string, code: string | null): void | Promise<void>;
  /** The CLI is waiting for admin-supplied text (`/login code <text>`). */
  onNeedInput(promptExcerpt: string): void | Promise<void>;
  /** Terminal state — exactly once per session. cleanupFailed: the window could not be confirmed removed. */
  onDone(result: { ok: boolean; detail: string; cleanupFailed?: boolean }): void | Promise<void>;
}

export type LoginSessionState = "starting" | "menu" | "waiting" | "input" | "done";

const POLL_INTERVAL_MS = 2_000;
const MENU_KEY_GAP_MS = 200;

export class LoginSession {
  state: LoginSessionState = "starting";
  private pollTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private sentUrl: string | null = null;
  private lastInputPrompt: string | null = null;
  private finished = false;
  /** Single-flight teardown: every cancel/finish caller — and start() — joins this one promise. */
  private finishing: Promise<void> | null = null;
  /** The createWindow() in flight, so finish() can wait for the window to exist before killing it. */
  private startInFlight: Promise<unknown> | null = null;

  constructor(
    readonly flow: LoginFlow,
    private readonly tmux: LoginTmux,
    private readonly events: LoginSessionEvents,
    private readonly logger: Logger,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {}

  async start(): Promise<void> {
    // remain-on-exit keeps the dead pane (and its final output) so a CLI that
    // prints "Successfully logged in" and exits is still observable; without it
    // the window vanishes between polls and success is indistinguishable from a
    // crash.
    // finish() waits for this before its one confirmed kill, so a cancel that
    // races createWindow still removes the window — and reports if it cannot.
    this.startInFlight = this.tmux.createWindow(this.flow.command, process.env.HOME ?? "/", `agend-login-${this.flow.backend}`);
    try {
      await this.startInFlight;
      // finish() owns the cleanup; start() must not return before it completes,
      // or the caller would publish "started" for a window being torn down.
      if (this.finishing) { await this.finishing; return; }
      await this.tmux.setRemainOnExit();
      if (this.finishing) { await this.finishing; return; }
    } catch (err) {
      if (this.finishing) { await this.finishing; return; }
      // Plain startup failure (no cancel in flight): new-window may have
      // succeeded server-side before the client timed out, or setRemainOnExit
      // failed after the window existed. Roll back — by id or by name — and
      // say so if it cannot be confirmed.
      const confirmed = await this.rollbackWindow();
      if (!confirmed) (err as { cleanupFailed?: boolean }).cleanupFailed = true;
      throw err;
    }
    this.timeoutTimer = setTimeout(() => {
      void this.finish(false, "timeout");
    }, this.flow.timeoutMs);
    this.timeoutTimer.unref?.();
    this.schedulePoll();
  }

  /** Admin picked menu option N: Down×N then Enter, matching the CLI selector. */
  async selectMenuOption(index: number): Promise<boolean> {
    if (this.state !== "menu" || !this.flow.menu) return false;
    if (!Number.isInteger(index) || index < 0 || index >= this.flow.menu.options.length) return false;
    this.state = "waiting";
    for (let i = 0; i < index; i++) {
      await this.tmux.sendSpecialKey("Down");
      await delay(MENU_KEY_GAP_MS);
    }
    await this.tmux.sendSpecialKey("Enter");
    return true;
  }

  /** Paste admin-supplied text (authorization code, start URL, region). */
  async submitInput(text: string): Promise<boolean> {
    if (this.state === "done") return false;
    // pasteText presses Enter itself; the retry Enter is for TUIs that swallow
    // the first one, harmless for a line-input prompt.
    const ok = await this.tmux.pasteText(text, { retryEnter: false });
    if (ok && this.state === "input") this.state = "waiting";
    return ok;
  }

  async cancel(reason = "cancelled"): Promise<void> {
    await this.finish(false, reason);
  }

  private schedulePoll(): void {
    if (this.finished) return;
    this.pollTimer = setTimeout(() => {
      void this.poll().catch(err => {
        this.logger.warn({ err: (err as Error).message }, "login poll error");
        this.schedulePoll();
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.finished) return;
    const pane = await this.tmux.capturePaneJoined(200).catch(() => "");

    // Success first: the pane may show the success line with the process
    // already gone (remain-on-exit), and success must win over "exited".
    if (this.flow.successPattern.test(pane)) {
      await this.finish(true, "success");
      return;
    }

    const status = await this.tmux.getPaneStatus().catch(() => null);
    if (status && !status.alive) {
      // Exit code 0 without the success line still counts as success (some
      // CLIs clear the screen on exit); non-zero is a failure with evidence.
      const tail = pane.trim().split("\n").slice(-3).join(" / ").slice(0, 300);
      await this.finish(status.exitCode === 0, status.exitCode === 0
        ? "clean exit"
        : `CLI exited with code ${status.exitCode}${tail ? ` — ${tail}` : ""}`);
      return;
    }

    if (this.flow.menu && this.state === "starting" && this.flow.menu.promptPattern.test(pane)) {
      this.state = "menu";
      await this.events.onMenu(this.flow.menu.options);
    }

    const hint = extractLoginHint(pane, this.flow);
    if (hint.url && hint.url !== this.sentUrl) {
      this.sentUrl = hint.url;
      if (this.state === "starting") this.state = "waiting";
      await this.events.onAuthHint(hint.url, hint.code);
    }

    if (this.flow.inputPrompt) {
      const match = pane.match(this.flow.inputPrompt);
      // Notify once per distinct prompt: "Enter Start URL" then "Enter Region"
      // are two prompts, but a persistent "Paste code here" line is one.
      if (match && match[0] !== this.lastInputPrompt) {
        this.lastInputPrompt = match[0];
        this.state = "input";
        await this.events.onNeedInput(match[0]);
      }
    }

    this.schedulePoll();
  }

  /** Remove whatever the startup may have created; true only when confirmed absent. */
  private async rollbackWindow(): Promise<boolean> {
    if (this.tmux.killWindowConfirmed) return this.tmux.killWindowConfirmed().catch(() => false);
    return this.tmux.killWindow().then(() => true, () => false);
  }

  private finish(ok: boolean, detail: string): Promise<void> {
    if (this.finishing) return this.finishing;       // second cancel / shutdown joins the same teardown
    this.finishing = this.doFinish(ok, detail);
    return this.finishing;
  }

  private async doFinish(ok: boolean, detail: string): Promise<void> {
    this.finished = true;
    this.state = "done";
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    // Wait for an in-flight createWindow to settle — no timer race: the
    // primitive itself is bounded (TmuxManager gives the exec a hard timeout),
    // and a window it created without reporting its id is still found by name.
    if (this.startInFlight) await this.startInFlight.catch(() => { /* window never came up, or timed out */ });
    let cleanupFailed = false;
    if (this.tmux.killWindowConfirmed) {
      cleanupFailed = !(await this.tmux.killWindowConfirmed().catch(() => false));
    } else {
      await this.tmux.killWindow().catch(() => { cleanupFailed = true; });
    }
    if (cleanupFailed) this.logger.warn({ backend: this.flow.backend }, "login window could not be confirmed removed");
    // Present only when true: existing consumers compare the payload exactly.
    await this.events.onDone(cleanupFailed ? { ok, detail, cleanupFailed: true } : { ok, detail });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
