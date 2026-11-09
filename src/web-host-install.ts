/**
 * AGEND-133 (upstream #3521): installing an AI CLI on the AgEnD host from the web dashboard — Settings → Agents → AI sign-ins.
 *
 * It is `/login`'s install (FleetManager.startWebInstall → the same unattended window, the same exit-code verdict, the same
 * fresh-login-shell check), asked for by a button instead of a chat command. This file holds only what the page sees:
 *
 * - **Only an id comes in.** The page names a CLI by its registry id. The command is the registry's `host.install` /
 *   `host.unattended`, read on the server (BACKEND_INSTALLATION_INFO); nothing the browser sends is ever part of it.
 * - **Who.** A signed-in admin session on the local surface (the route checks, and `isLocalAdmin` is asked again before
 *   a start) — the same as signing a CLI in from the dashboard. Never a guest, a read session, the CLI's header token or
 *   the public link.
 * - **Update (AGEND-136).** The same machinery, asked for with `mode: "update"`: `POST /ui/host-update { backend }`. The command is the registry's `host.update`, its `{version}`
 *   filled on the server with the newest AUDITED release of that CLI (cli-audited.ts) — never "latest", never anything the browser sent. It is refused unless the CLI is
 *   installed and older than that release; the page shows the version before and after (the binary probe).
 * - **One at a time, fleet-wide.** The login window is one lock shared with `/login` and sign-in: a second install, or an install
 *   during a sign-in, is refused with `busy`, never queued.
 * - **What the page is shown.** The CLI, who started it, its phase, the last lines of the installer's output (ANSI stripped,
 *   secrets masked by the stream's own renderer), the exit code on failure, and the version the binary probe found on success.
 *   No command, path or environment. An ended run is kept 10 minutes, then it is gone.
 */
import { randomBytes } from "node:crypto";
import { AUDITED_VERSION, auditedVersion } from "./cli-audited.js";
import { hostFacts } from "./cli-registry.js";
import { dialogScreenText } from "./dialog-screen-text.js";
import { installerOutput } from "./install-stream.js";

/** How long an ended install is still shown, then it is gone. */
export const WEB_INSTALL_KEEP_ENDED_MS = 10 * 60_000;
/** The installer's last lines the page shows (the live view, and the end of a failed one). */
export const WEB_INSTALL_LINES = 12;
const WEB_INSTALL_BYTES = 2_000;

export type HostInstallPhase = "running" | "ok" | "failed" | "cancelled" | "timeout";

/** Why a start was refused. Codes: the page words them in its own language. */
export type HostInstallRefusal = "unsupported" | "already" | "busy" | "shutting_down" | "failed" | "not_installed" | "up_to_date";
/** What a run does: install a CLI that is not there, or take an installed one to AgEnD's audited release. */
export type HostInstallMode = "install" | "update";
export type HostInstallStart = { started: true } | { refused: HostInstallRefusal; message?: string };

/** What FleetManager reports while it drives the install window for a run. */
export interface HostInstallReporter {
  /** A poll's capture of the window (the same one the live view of `/login`'s install is made from). */
  progress(pane: string): void;
  /**
   * The install ended. `ok`: the installer's own exit code was 0; `verified`: a fresh login shell (or the installer's own directories) then
   * found the binary; `version`: what the probe read from it (null: not read). A cancel or a timeout is a `detail` of "cancelled" / "timeout".
   */
  done(result: { ok: boolean; detail: string; cleanupFailed?: boolean; verified: boolean; version: string | null; signIn: boolean }): void;
  /** An update: the version the binary probe read before it started, and the audited release it goes to (null: not read). Told once, when the window is open. */
  update?(from: string | null, target: string): void;
}

export interface WebHostInstallDeps {
  /** Is the session with this handle live, admin and local right now? */
  isLocalAdmin(handle: string): boolean;
  /** Which CLIs have an install at all (the registry's `host.install`). */
  installable(backend: string): boolean;
  /** Which CLIs have an update (the registry's `host.update`). */
  updatable?(backend: string): boolean;
  /** FleetManager.startWebInstall: claim the window and run the installer (or, for `update`, the registry's update command); `reporter` is told how it goes. */
  start(backend: string, reporter: HostInstallReporter, mode?: HostInstallMode): Promise<HostInstallStart>;
  /** Stop the running install (the window and its process group); true when there was one. */
  cancel(): Promise<boolean>;
  /** The run started, or ended: the pages read it again (no details in the event; the page also reads it every couple of seconds while one runs). */
  changed?(phase: "running" | "ended"): void;
  now?(): number;
}

export interface WebHostInstallRequester {
  /** The session's handle (web-session.ts). */
  handle: string;
  /** Its device label, shown to the other sessions. */
  label: string;
}

export interface HostInstallView {
  id: string;
  backend: string;
  /** AGEND-136: "install", or "update" (a CLI taken to the audited release). */
  mode: HostInstallMode;
  /** An update: the version before it started (null: not read) and the audited release it goes to. */
  fromVersion: string | null;
  targetVersion: string | null;
  phase: HostInstallPhase;
  startedOn: string;
  startedAt: number;
  endedAt: number | null;
  /** The installer's last lines; empty until it prints something. */
  lines: string[];
  /** A failed install: the installer's exit code, when it had one. */
  exitCode: number | null;
  /** A successful install: whether the binary was found afterwards, and the version it reported. */
  verified: boolean | null;
  version: string | null;
  /** A successful, verified install of a CLI the dashboard can sign in: the page offers Sign in next. */
  signIn: boolean;
  /** The window could not be confirmed removed (the same warning `/login` gives). */
  cleanupFailed: boolean;
}

interface Run {
  id: string;
  backend: string;
  mode: HostInstallMode;
  fromVersion: string | null;
  targetVersion: string | null;
  label: string;
  startedAt: number;
  phase: HostInstallPhase;
  endedAt: number | null;
  lines: string[];
  exitCode: number | null;
  verified: boolean | null;
  version: string | null;
  signIn: boolean;
  cleanupFailed: boolean;
}

/**
 * AGEND-136: what an update runs for `backend`: the registry's `host.update` command with its `{version}` filled with the newest audited release (cli-audited.ts), and that
 * release. Null when the CLI has no update (it updates itself, or has no way to reach a chosen release), or has no audited release. The release is checked once more
 * against a plain x.y.z before it goes into a command.
 */
export function hostUpdatePlan(backend: string): { command: string; target: string } | null {
  const facts = hostFacts(backend, "update"), target = auditedVersion(backend);
  if (!facts || !target || !AUDITED_VERSION.test(target)) return null;
  return { command: facts.command.replace("{version}", target), target };
}

/** "CLI exited with code 3 — …" (login-manager.ts) → 3. */
export function exitCodeOf(detail: string): number | null {
  const m = /exited with code (\d{1,3})\b/.exec(detail);
  return m ? Number(m[1]) : null;
}

/** The installer's output as a few plain lines: tmux's own dead-pane line and blank runs gone, ANSI stripped, secrets masked. */
export function installLines(pane: string): string[] {
  const text = dialogScreenText(installerOutput(pane), { lines: WEB_INSTALL_LINES, bytes: WEB_INSTALL_BYTES });
  return text ? text.split("\n") : [];
}

export class WebHostInstalls {
  private run: Run | null = null;
  private seq = 0;

  constructor(private readonly deps: WebHostInstallDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /**
   * Start installing `backend`. Who is re-checked here (the route checked it too). Refusals are codes; a start that worked answers with the run
   * as it is now (running, or — for an installer that ended before the answer — already over).
   */
  async begin(who: WebHostInstallRequester, backend: string, mode: HostInstallMode = "install"): Promise<{ install: HostInstallView } | { error: HostInstallRefusal | "not_allowed"; message?: string }> {
    if (!this.deps.isLocalAdmin(who.handle)) return { error: "not_allowed" };
    if (!(mode === "update" ? this.deps.updatable?.(backend) === true : this.deps.installable(backend))) return { error: "unsupported" };
    const run: Run = {
      id: randomBytes(16).toString("hex"), backend, mode, fromVersion: null, targetVersion: null, label: who.label, startedAt: this.now(), phase: "running", endedAt: null,
      lines: [], exitCode: null, verified: null, version: null, signIn: false, cleanupFailed: false,
    };
    // Published before the window opens, so a fast installer's `done` has a run to land on; withdrawn when the start is refused.
    const previous = this.run;
    this.run = run;
    const reporter: HostInstallReporter = {
      update: (from, target) => { run.fromVersion = from; run.targetVersion = target; },
      progress: pane => { if (this.run === run && run.phase === "running") run.lines = installLines(pane); },
      done: result => {
        if (run.phase !== "running") return;
        run.endedAt = this.now();
        run.cleanupFailed = result.cleanupFailed === true;
        if (result.ok) { run.phase = "ok"; run.verified = result.verified; run.version = result.version; run.signIn = run.mode === "install" && result.verified && result.signIn; }
        else {
          run.phase = result.detail === "cancelled" ? "cancelled" : result.detail === "timeout" ? "timeout" : "failed";
          run.exitCode = exitCodeOf(result.detail);
        }
        if (this.run === run) this.changed("ended");
      },
    };
    let started: HostInstallStart;
    try { started = await this.deps.start(backend, reporter, mode); }
    catch (err) { started = { refused: "failed", message: (err as Error)?.message ?? String(err) }; }
    if (!("started" in started)) {
      if (this.run === run) this.run = previous;
      return { error: started.refused, ...(started.message ? { message: started.message } : {}) };
    }
    if (run.phase === "running") this.changed("running");
    return { install: this.viewOf(run) };
  }

  /** The current (or last) install, or null. */
  view(): HostInstallView | null {
    const run = this.run;
    if (!run) return null;
    if (run.phase !== "running" && run.endedAt !== null && this.now() - run.endedAt > WEB_INSTALL_KEEP_ENDED_MS) { this.run = null; return null; }
    return this.viewOf(run);
  }

  /** Any local admin may stop it (it only takes something away), the same as `/login cancel`. */
  async cancel(): Promise<boolean> { return this.deps.cancel(); }

  private viewOf(run: Run): HostInstallView {
    return {
      id: run.id, backend: run.backend, mode: run.mode, fromVersion: run.fromVersion, targetVersion: run.targetVersion, phase: run.phase, startedOn: run.label, startedAt: run.startedAt, endedAt: run.endedAt,
      lines: [...run.lines], exitCode: run.exitCode, verified: run.verified, version: run.version, signIn: run.signIn, cleanupFailed: run.cleanupFailed,
    };
  }

  private changed(phase: "running" | "ended"): void { try { this.deps.changed?.(phase); } catch { /* the pages read it on their own next time */ } }
}
