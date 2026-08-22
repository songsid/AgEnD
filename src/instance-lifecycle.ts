import { existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, dirname, resolve, sep as pathSep } from "node:path";
import { access, unlink } from "node:fs/promises";
import { getAgendHome, ensureWorkspaceGit } from "./paths.js";
import type { InstanceConfig, FleetConfig } from "./types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { sanitizeInstanceName } from "./topic-commands.js";
import { isModelCompatible } from "./backend/types.js";
import { RoutingEngine } from "./routing-engine.js";
import { safeHandler } from "./safe-async.js";
import { t } from "./locale.js";
import type { Logger } from "./logger.js";
import type { IpcClient } from "./channel/ipc-bridge.js";
import type { EventLog } from "./event-log.js";
import type { TmuxControlClient } from "./tmux-control.js";
import type { FleetInstructionsParams } from "./instructions.js";
import { clearPausedMarker, hasPausedMarker, readPausedAt, writePausedMarker } from "./pause-marker.js";
import { reportProviderRateLimit } from "./usage/provider-alerts.js";
import { isFleetStartCommandLine } from "./fleet-lock.js";
import { GENERAL_PAUSE_ERROR, isGeneralInstance } from "./general-instance.js";
import { checkAuthStatus, LOGIN_FLOWS } from "./login-flows.js";

export { isFleetStartCommandLine } from "./fleet-lock.js";

export interface BackendInstallationInfo {
  binary: string;
  install: string;
}

/** Shared CLI metadata used by startup validation and ClassicBot onboarding. */
export const BACKEND_INSTALLATION_INFO: Readonly<Record<string, BackendInstallationInfo>> = {
  "claude-code": { binary: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
  "gemini-cli": { binary: "gemini", install: "npm i -g @google/gemini-cli" },
  "kiro-cli": { binary: "kiro-cli", install: "brew install --cask kiro-cli" },
  codex: { binary: "codex", install: "npm i -g @openai/codex" },
  opencode: { binary: "opencode", install: "curl -fsSL https://opencode.ai/install | bash" },
  antigravity: { binary: "agy", install: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
  grok: { binary: "grok", install: "curl -fsSL https://x.ai/cli/install.sh | bash" },
};

/** Check one executable using the same PATH visible to the fleet process. */
export function checkBinaryInstalled(binary: string): boolean {
  try {
    execFileSync("which", [binary], { stdio: "pipe", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function readProcessCommandLine(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
    } catch {
      return "";
    }
  }
}

/**
 * Return why an instance daemon PID must not receive SIGTERM, or null when the
 * stale-process cleanup may proceed. daemon.pid historically stores the shared
 * in-process FleetManager PID, so this check is deliberately conservative.
 */
export function getUnsafeInstanceDaemonPidReason(pid: number, dataDir: string): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "invalid or privileged PID";
  if (pid === process.pid) return "PID is the current shared fleet process";

  try {
    const fleetPid = Number.parseInt(readFileSync(join(dataDir, "fleet.pid"), "utf8").trim(), 10);
    if (Number.isSafeInteger(fleetPid) && pid === fleetPid) {
      return "PID matches fleet.pid";
    }
  } catch {
    // Missing/unreadable fleet.pid: fall through to the process command check.
  }

  const commandLine = readProcessCommandLine(pid);
  if (commandLine && isFleetStartCommandLine(commandLine)) {
    return "process command line is agend fleet start";
  }
  return null;
}

/**
 * Context interface for instance lifecycle operations.
 * FleetManager implements this.
 */
export interface LifecycleContext {
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly routing: RoutingEngine;
  readonly instanceIpcClients: Map<string, IpcClient>;
  readonly ipcStoppingInstances: Set<string>;
  readonly sessionRegistry: Map<string, string>;
  readonly eventLog: EventLog | null;
  readonly controlClient: TmuxControlClient | null;

  getInstanceDir(name: string): string;
  saveFleetConfig(): void;
  /** Full stop+start. freshStart forces the respawn to skip session resume. */
  restartSingleInstance(name: string, opts?: { freshStart?: boolean }): Promise<void>;
  connectIpcToInstance(name: string): Promise<void>;
  createForumTopic(topicName: string, adapterId?: string): Promise<number | string>;
  deleteForumTopic(topicId: number | string): Promise<void>;
  setTopicIcon(name: string, state: "green" | "blue" | "red" | "remove"): void;
  /** Remove instance with full cleanup (scheduler, IPC, routing, config). */
  removeInstance(name: string): Promise<void>;
  touchActivity(name: string): void;
  sendHangNotification(name: string, unchangedForMs?: number): Promise<void>;
  notifyInstanceTopic(name: string, text: string): void;
  /** Notify the blocked instance and offer an interactive assist action in General. */
  notifyInteractivePrompt(name: string, kind: string): Promise<void>;
  /** Notify a clean CLI exit and offer an admin-only restart action in General. */
  notifyNormalExit(name: string): Promise<void>;
  /** True for a dynamic ClassicBot channel instance (not a fleet topic). */
  isClassicInstance?(name: string): boolean;
  /** True while the fleet is stopping on purpose or an `agend update` is running. */
  isPlannedRestart(): boolean;
  /** List claimed tasks for an instance (from task board). Returns empty array if unavailable. */
  listClaimedTasks(assignee: string): Array<{ id: string; title: string }>;
  webhookEmit(event: string, name: string, data?: Record<string, unknown>): void;
  checkModelFailover(name: string, fiveHourPct: number): void;
  /** Retire (delete) any pending Cancel button for an instance. No-op if none. */
  clearCancelButton(name: string): void;
  startStatuslineWatcher(name: string): void;
  stopStatuslineWatcher(name: string): void;
  reactMessageStatus(instanceName: string, chatId: string, messageId: string, emoji: string): void;
  startPersistedPausedInstance(name: string): Promise<void>;
}

type Daemon = InstanceType<typeof import("./daemon.js").Daemon>;

/** What attachIncidentHandlers needs from a Daemon — the real one satisfies it. */
export interface IncidentEventSource {
  on(event: string, handler: (...args: any[]) => void): unknown;
  requestPauseWhenIdle(): void;
  /** Present on real daemons; hang buttons attach only when it returns one. */
  getHangDetector?(): { on(event: string, handler: (...args: any[]) => void): unknown } | null;
}

/** Arguments accepted by handleCreate — mirrors CreateInstanceArgs in outbound-schemas.ts
 *  plus internal-only fields forwarded by deploy_template (profile-derived). */
export interface LifecycleCreateArgs {
  directory?: string;
  topic_name?: string;
  description?: string;
  model?: string;
  backend?: string;
  /** Backend-specific launch options, e.g. { codex: { provider: "glm" } }. */
  backend_options?: Record<string, Record<string, unknown>>;
  branch?: string;
  detach?: boolean;
  worktree_path?: string;
  systemPrompt?: string;
  tags?: string[];
  workflow?: string | false;
  model_failover?: string[];
  tool_set?: string;
  skipPermissions?: boolean;
  lightweight?: boolean;
  /** Internal: used by deploy_template when branch is specified to base a new branch off this ref. */
  start_point?: string;
  /** Preserve any other passthrough keys without loss. */
  [key: string]: unknown;
}

export interface LifecycleDeleteArgs {
  name: string;
  delete_topic?: boolean;
}

export interface LifecycleReplaceArgs {
  name: string;
  reason?: string;
}

/** Suppress duplicate auth alerts for the same backend within this window. */
const AUTH_ALERT_COOLDOWN_MS = 5 * 60_000;

/**
 * Reuse one auth verification per backend for this long. Shared credentials
 * expiring makes EVERY instance of the backend emit auth_error at once — one
 * token-free check answers for all of them.
 */
const AUTH_VERIFY_CACHE_MS = 60_000;

export class InstanceLifecycle {
  /** Active daemon processes: instanceName → Daemon */
  readonly daemons = new Map<string, Daemon>();
  /** backend → last auth-error alert time, so one expiry sends one alert. */
  private lastAuthAlertAt = new Map<string, number>();
  /**
   * backend → cached token-free auth verification (see AUTH_VERIFY_CACHE_MS).
   * The PROMISE is cached, not the result: a shared credential expiring makes
   * every instance of the backend fire in the same tick, and they must join
   * one in-flight check instead of each spawning their own.
   */
  private authVerifyCache = new Map<string, { at: number; promise: Promise<"valid" | "invalid" | "unknown"> }>();
  /**
   * Minimum gap between MCP-revival auto-restarts of one instance. Kept here —
   * not in the daemon — because each restart replaces the daemon object, which
   * would take an in-daemon cooldown with it and allow a tight restart loop.
   */
  private static readonly MCP_AUTO_RESTART_COOLDOWN_MS = 15 * 60_000;
  /** instanceName → time of the last MCP-revival auto-restart. */
  private mcpAutoRestartAt = new Map<string, number>();

  constructor(private ctx: LifecycleContext) {}

  /**
   * Report an incident to the user — unless the fleet is deliberately going
   * down, in which case the "incident" is the shutdown doing its job.
   *
   * `agend update` stops instances, kills their MCP servers and restarts the
   * daemon; every one of those looked like a crash to the alert path, so an
   * upgrade produced a burst of ⚠️ for things that were working correctly. That
   * burst is worse than noise: it teaches the operator to ignore the same alert
   * that matters when a process really does die on its own.
   *
   * The event log and daemon.log entries still happen at the call sites — this
   * suppresses the chat message, not the record. A crash outside a planned
   * restart notifies exactly as before.
   */
  private notifyIncident(name: string, kind: string, text: string): void {
    if (this.ctx.isPlannedRestart()) {
      this.ctx.logger.info({ name, kind }, "Incident notification suppressed — planned restart in progress");
      return;
    }
    this.ctx.notifyInstanceTopic(name, text);
  }

  /** Backend a running instance uses (config → fleet default). */
  private backendOf(name: string): string {
    return this.ctx.fleetConfig?.instances[name]?.backend
      ?? this.ctx.fleetConfig?.defaults?.backend
      ?? "claude-code";
  }

  /**
   * Confirm a pane-detected auth error with the backend's token-free status
   * probe before pausing anything: pattern matching over terminal text also
   * fires on an agent DISCUSSING a 401. "valid" means false positive — ignore.
   * "invalid" and "unknown" (timeout, missing binary) both pause: for a
   * suspected expiry, pausing too much is recoverable, delivering into a dead
   * CLI is not. Cached per backend so simultaneous alerts run one check.
   */
  private verifyAuthError(name: string): Promise<"valid" | "invalid" | "unknown"> {
    return this.verifyBackendAuth(this.backendOf(name));
  }

  /** Same verification keyed by backend (used by startup pre-flight priming). */
  verifyBackendAuth(backend: string): Promise<"valid" | "invalid" | "unknown"> {
    const cached = this.authVerifyCache.get(backend);
    if (cached && Date.now() - cached.at < AUTH_VERIFY_CACHE_MS) return cached.promise;
    const check = LOGIN_FLOWS[backend]?.authCheck;
    const promise = check ? checkAuthStatus(check) : Promise.resolve("unknown" as const);
    this.authVerifyCache.set(backend, { at: Date.now(), promise });
    return promise;
  }

  /**
   * Startup pre-flight: warm the per-backend auth verification cache so the
   * detectors that fire seconds later (login-screen scan, MCP-died gate) get an
   * instant answer. Advisory only — a pre-flight result alone never pauses
   * anything, because e.g. codex on a custom provider runs fine while
   * `codex login status` reports logged out (live-verified on this fleet).
   */
  primeAuthVerification(backends: Iterable<string>): void {
    for (const backend of new Set(backends)) {
      void this.verifyBackendAuth(backend).then(result => {
        if (result === "invalid") {
          this.ctx.logger.warn({ backend }, "Pre-flight auth check failed — marking backend as auth-suspect");
        }
      }).catch(() => { /* verification is advisory */ });
    }
  }

  /**
   * One alert per backend per cooldown, naming every affected instance — a CLI's
   * credentials are shared, so N instances failing is ONE problem with ONE fix
   * (re-login once). The per-instance daemon cooldown can't dedupe across
   * instances, so the fleet-level map does it here.
   */
  private notifyAuthErrorOnce(name: string, message: string, notificationTarget = name): void {
    const backend = this.backendOf(name);
    const now = Date.now();
    const last = this.lastAuthAlertAt.get(backend) ?? 0;
    if (now - last < AUTH_ALERT_COOLDOWN_MS) {
      this.ctx.logger.info({ name, backend }, "auth error suppressed (backend already alerted)");
      return;
    }
    this.lastAuthAlertAt.set(backend, now);

    const affected = [...this.daemons.keys()].filter(n => this.backendOf(n) === backend);
    const others = affected.filter(n => n !== name);
    const scope = others.length
      ? `${affected.length} instances on \`${backend}\`: ${affected.join(", ")}`
      : `\`${name}\` (${backend})`;
    this.notifyIncident(notificationTarget, "auth_error",
      `🔑 ${message}\n\nAffects ${scope}. Credentials are shared per backend — one re-login restores all of them; affected instances pause until then. Use \`/login ${backend}\` to re-login remotely.`);
  }

  /**
   * System errors from a ClassicBot belong in the operator's General topic,
   * never in the end user's chat channel. Fleet-topic instances retain their
   * existing local notification target.
   */
  private ptyErrorNotificationTarget(name: string): string | undefined {
    if (!this.ctx.isClassicInstance?.(name)) return name;
    const general = this.findGeneralInstance();
    if (!general) {
      this.ctx.logger.warn({ name }, "ClassicBot PTY error has no General topic notification target");
    }
    return general;
  }

  /**
   * Handlers for the events that mean "something went wrong".
   *
   * Extracted from start() so the planned-restart suppression can be exercised
   * against a plain event emitter — the alternative is a real Daemon, which
   * means a real tmux window, which is why this rule went untested before.
   */
  attachIncidentHandlers(name: string, daemon: IncidentEventSource): void {
    const hangDetector = daemon.getHangDetector?.();
    if (hangDetector) {
      hangDetector.on("hang", safeHandler(async (data?: { unchangedForMs?: number }) => {
        this.ctx.eventLog?.insert(name, "hang_detected", {});
        this.ctx.logger.warn({ name }, "Instance appears hung");

        if (this.ctx.isPlannedRestart()) {
          // A graceful stop makes every pane look frozen; alerting on that (with
          // a restart button, no less) during `agend update` is pure noise. The
          // same suppression interactive-prompt and normal-exit already apply.
          // Checked BEFORE the task nudge: injecting new work into a CLI that is
          // being shut down would only delay the stop.
          this.ctx.logger.info({ name }, "Hang notification suppressed — planned restart in progress");
          return;
        }

        // Check if instance has claimed tasks — nudge it to continue
        const claimedTasks = this.ctx.listClaimedTasks(name);
        if (claimedTasks.length > 0) {
          const task = claimedTasks[0];
          this.ctx.eventLog?.insert(name, "idle_task_nudge", { taskId: task.id, taskTitle: task.title });
          // Inject nudge message into the instance's CLI session
          const ipc = this.ctx.instanceIpcClients.get(name);
          if (ipc?.connected) {
            ipc.send({
              type: "fleet_inbound",
              content: `[system] You have a claimed task: "${task.title}" (#${task.id}). Continue working on it, or use task(done) / task(update, status=blocked) to update status.`,
              meta: { chat_id: "", thread_id: "", ts: new Date().toISOString() },
            });
          }
        }

        await this.ctx.sendHangNotification(name, data?.unchangedForMs);
        this.ctx.webhookEmit("hang", name);
      }, this.ctx.logger, `hangDetector[${name}]`));
    }

    daemon.on("crash_respawn", safeHandler(() => {
      this.ctx.eventLog?.insert(name, "crash_respawn", {});
      this.ctx.logger.warn({ name }, "Instance crashed and respawned");
      this.notifyIncident(name, "crash_respawn", t("inst.crashed_respawned", name));
      const generalName = this.findGeneralInstance();
      if (generalName && generalName !== name) {
        this.notifyIncident(generalName, "crash_respawn", t("inst.crashed_respawned_log", name));
      }
    }, this.ctx.logger, `daemon.crash_respawn[${name}]`));

    daemon.on("snapshot_failed", safeHandler(() => {
      this.ctx.eventLog?.insert(name, "snapshot_failed", {});
      this.notifyIncident(name, "snapshot_failed", t("inst.restarted_no_context", name));
    }, this.ctx.logger, `daemon.snapshot_failed[${name}]`));

    daemon.on("supervision_ended", safeHandler(async (data: { name: string; reason: string; remedy: string; exitCode?: number }) => {
      // The instance is dead and nothing will restart it. Say so where the operator
      // is looking, and mark the topic — otherwise messages routed here just queue
      // or fail with a bare ❌ and the dashboard still looks normal.
      this.ctx.eventLog?.insert(name, "supervision_ended", { reason: data.reason });
      if (data.exitCode === 0) {
        this.ctx.logger.info({ name, exitCode: data.exitCode }, "CLI exited normally and will not restart automatically");
        if (this.ctx.isPlannedRestart()) {
          this.ctx.logger.info({ name }, "Normal-exit controls suppressed — planned restart in progress");
        } else {
          await this.ctx.notifyNormalExit(name);
        }
        this.ctx.setTopicIcon(name, "red");
        return;
      }
      this.ctx.logger.error({ name, reason: data.reason }, "Instance is no longer supervised");
      this.notifyIncident(
        name,
        "supervision_ended",
        `🛑 ${name} is no longer running and will not be restarted automatically — ${data.reason}.\n${data.remedy}`,
      );
      this.ctx.setTopicIcon(name, "red");
    }, this.ctx.logger, `daemon.supervision_ended[${name}]`));

    daemon.on("health_check_error", safeHandler((data: { name: string; message: string }) => {
      this.ctx.eventLog?.insert(name, "health_check_error", { message: data.message });
      this.ctx.logger.error({ name, message: data.message }, "Health check failing — instance supervision degraded");
      this.notifyIncident(
        name,
        "health_check_error",
        `⚠️ ${name}: health check is failing (\`${data.message}\`). Crash detection for this instance may be degraded — see daemon.log.`,
      );
    }, this.ctx.logger, `daemon.health_check_error[${name}]`));

    daemon.on("crash_loop", safeHandler(() => {
      this.ctx.eventLog?.insert(name, "crash_loop", {});
      this.ctx.logger.error({ name }, "Instance in crash loop — respawn paused");
      this.notifyIncident(name, "crash_loop", t("inst.respawn_paused", name));
      this.ctx.setTopicIcon(name, "red");
    }, this.ctx.logger, `daemon.crash_loop[${name}]`));

    daemon.on("mcp_died", safeHandler(async (data: { name: string; pid: number; autoRestart?: boolean; authSuspected?: boolean }) => {
      this.ctx.eventLog?.insert(name, "mcp_died", { pid: data.pid });
      this.ctx.logger.error({ name, pid: data.pid }, "MCP server died — instance cannot use agend tools");
      this.ctx.webhookEmit("mcp_died", name, { pid: data.pid });
      // Auth outranks MCP: when the CLI lost authentication, "MCP server died"
      // is a symptom and the fix is /login, not a restart. The daemon flags a
      // suspicion it already confirmed (login screen / 401 pattern); otherwise
      // ask the cached token-free probe. Only a CONFIRMED invalid swaps the
      // message — valid or uncertain keeps the accurate MCP report below.
      const verdict = data.authSuspected ? "invalid" : await this.verifyAuthError(name);
      if (verdict === "invalid") {
        this.notifyAuthErrorOnce(name,
          "Sign-in expired — the CLI cannot run its MCP server (agend tools are down) until it is re-authenticated.",
          this.ptyErrorNotificationTarget(name) ?? name);
        return;
      }
      // The CLI owns the MCP server's stdio pipes, so only restarting the CLI can
      // restore its tools. With mcp_auto_restart (default) the daemon requests an
      // idle-gated restart itself — an immediate one would interrupt whatever the
      // agent is doing. With it off, tell the operator what to run, as before.
      this.notifyIncident(name, "mcp_died",
        `⚠️ \`${name}\` 的 MCP server 已終止 — 這個 instance 目前無法使用 agend 工具（無法 reply / 跨 instance 通訊）。\n`
        + (data.autoRestart
          ? "CLI 本身還在執行；等它閒置後會自動重啟以恢復工具（進行中的工作不會被打斷，session 會保留）。"
          : `CLI 本身還在執行。工具只能由 CLI 自己重新啟動 MCP server，請用 \`restart_instance("${name}")\` 或 \`/restart\` 恢復。`));
    }, this.ctx.logger, `daemon.mcp_died[${name}]`));

    daemon.on("mcp_proxy_reply", safeHandler((data: { name: string; correlationId?: string }) => {
      // The message itself goes out through the daemon's fleet_outbound path;
      // this is the audit trail that it happened (and why the channel saw a ⚠️).
      this.ctx.eventLog?.insert(name, "mcp_proxy_reply", { correlationId: data.correlationId });
      this.ctx.logger.warn({ name, correlationId: data.correlationId },
        "MCP dead at turn end with no reply — daemon relayed the pane text to the channel");
    }, this.ctx.logger, `daemon.mcp_proxy_reply[${name}]`));

    daemon.on("mcp_restart_requested", safeHandler((data: { name: string; trigger: string }) => {
      // The daemon object dies with the restart it asks for, so the loop guard
      // lives here: if the previous auto-restart was under the cooldown, the new
      // MCP server evidently died right back (broken install, OOM pressure) and
      // another attempt would just cycle the instance. Leave it to the operator —
      // the mcp_died notification for this death has already gone out.
      const last = this.mcpAutoRestartAt.get(name) ?? 0;
      const now = Date.now();
      if (now - last < InstanceLifecycle.MCP_AUTO_RESTART_COOLDOWN_MS) {
        this.ctx.eventLog?.insert(name, "mcp_auto_restart_suppressed", { trigger: data.trigger });
        this.ctx.logger.error({ name, trigger: data.trigger },
          "MCP auto-restart suppressed — the previous attempt is still inside the cooldown, so the restart is not fixing it");
        return;
      }
      this.mcpAutoRestartAt.set(name, now);
      this.ctx.eventLog?.insert(name, "mcp_auto_restart", { trigger: data.trigger });
      this.ctx.logger.warn({ name, trigger: data.trigger }, "Auto-restarting instance to revive its MCP server");
      // The restart ends whatever turn the button belonged to; a click on the
      // leftover would target the new CLI. Retire it before tearing down.
      this.ctx.clearCancelButton(name);
      this.notifyIncident(name, "mcp_auto_restart",
        `🔁 \`${name}\` 自動重啟中，以恢復 agend 工具`
        + (data.trigger === "stale_timeout" ? "（等待閒置逾時，強制執行）" : "")
        + "。session 會保留。");
      // Plain restart — NOT freshStart: the session itself is healthy and must
      // survive; the point is only to respawn the CLI so it brings up a new MCP
      // server.
      this.ctx.restartSingleInstance(name).catch(err =>
        this.ctx.logger.error({ err, name }, "MCP auto-restart failed"));
    }, this.ctx.logger, `daemon.mcp_restart_requested[${name}]`));

    daemon.on("interactive_prompt", safeHandler(async (data: { name: string; kind: string; prompt: string }) => {
      this.ctx.eventLog?.insert(name, "interactive_prompt", { kind: data.kind });
      this.ctx.logger.warn({ name, kind: data.kind, prompt: data.prompt }, "Instance is waiting for interactive terminal input");
      if (this.ctx.isPlannedRestart()) {
        this.ctx.logger.info({ name }, "Interactive prompt notification suppressed — planned restart in progress");
        return;
      }
      await this.ctx.notifyInteractivePrompt(name, data.kind);
    }, this.ctx.logger, `daemon.interactive_prompt[${name}]`));

    daemon.on("pty_error", safeHandler(async (data: { name: string; type: string; action: string; message: string }) => {
      this.ctx.eventLog?.insert(name, "pty_error", { type: data.type, action: data.action });
      this.ctx.logger.warn({ name, errorType: data.type, action: data.action }, `PTY error: ${data.message}`);

      // Antigravity's account-level cap is visible ONLY here: the quota summary
      // API keeps reporting its buckets as barely used while the CLI is blocked
      // (verified live — 0% used and "Individual quota reached" in the same
      // minute). Remember it so /usage can overlay the truth on that row.
      if (data.type === "quota" && this.backendOf(name) === "antigravity") {
        reportProviderRateLimit("antigravity", data.message);
      }

      // Pattern-matched auth errors get a second opinion from the real CLI
      // before any pause/alert: an agent quoting "401 Unauthorized" in prose
      // must not pause the fleet. A working credential ends the incident here.
      if (data.type === "auth_error") {
        const verdict = await this.verifyAuthError(name);
        if (verdict === "valid") {
          this.ctx.logger.info({ name, backend: this.backendOf(name) },
            "auth-error pattern ignored — token-free auth check passed (likely conversation text)");
          return;
        }
      }

      const emoji = data.type === "rate_limit" || data.type === "timeout" ? "⏳" : data.type === "auth_error" ? "🔑" : "⚠️";
      const notificationTarget = this.ptyErrorNotificationTarget(name);
      // Auth failures are a property of the BACKEND's shared credentials, not of
      // one instance: every instance on that CLI fails at once, and one re-login
      // fixes them all. Notify once per backend (listing who's affected) instead
      // of N near-identical alerts, and suppress repeats fleet-wide.
      if (data.type === "auth_error") {
        if (notificationTarget) this.notifyAuthErrorOnce(name, data.message, notificationTarget);
      } else if (notificationTarget) {
        this.notifyIncident(notificationTarget, "pty_error", t("inst.notification", emoji, name, data.message, data.action));
      }
      this.ctx.webhookEmit("pty_error", name, { type: data.type, action: data.action, message: data.message });

      // The CLI interrupted itself on this error, so any pending Cancel button is
      // now useless — retire it. We only reach here when the error wasn't
      // cooldown-suppressed (the daemon skips the emit during cooldown), so this
      // won't fire on repeat errors within the 5-min window. No-op if no button.
      this.ctx.clearCancelButton(name);

      if (data.action === "failover") {
        this.ctx.checkModelFailover(name, 100); // Force failover trigger
      } else if (data.action === "restart") {
        // A broken *resumed* session (e.g. agy pinned to a dead model) can't
        // self-recover; a plain restart would --continue back into it. freshStart
        // makes the respawn skip resume so the CLI starts a clean session on its
        // default (valid) model.
        this.ctx.restartSingleInstance(name, { freshStart: true }).catch(err =>
          this.ctx.logger.error({ err, name }, "pty_error restart failed"));
      } else if (data.action === "pause") {
        // Previously unhandled, so an expired session kept receiving messages and
        // re-sending its whole context into a CLI that could only fail — wasted
        // credit and lost work. pause() alone no-ops while the pane is busy (the
        // usual state when auth fails), so mark it to pause as soon as it idles.
        // Queued messages survive: delivery wakes a paused instance.
        void this.pause(name)
          .catch(err => this.ctx.logger.warn({ err, name }, "auth-error pause failed"))
          .finally(() => { if (!this.isPaused(name)) daemon.requestPauseWhenIdle(); });
      }
    }, this.ctx.logger, `daemon.pty_error[${name}]`));
  }

  async start(
    name: string,
    config: InstanceConfig,
    topicMode: boolean,
    runtimeIdentity?: FleetInstructionsParams["runtimeIdentity"],
  ): Promise<void> {
    if (this.daemons.has(name)) {
      this.ctx.logger.info({ name }, "Instance already running, skipping");
      return;
    }

    if (!existsSync(config.working_directory)) {
      this.ctx.logger.info({ name, working_directory: config.working_directory }, "Working directory does not exist — creating it");
      mkdirSync(config.working_directory, { recursive: true });
    }

    const instanceDir = this.ctx.getInstanceDir(name);
    mkdirSync(instanceDir, { recursive: true });

    // Defense-in-depth: clear crash state before daemon start
    try { await unlink(join(instanceDir, "crash-state.json")); } catch {}

    const { Daemon } = await import("./daemon.js");
    const { createBackend } = await import("./backend/factory.js");

    const backendName = config.backend ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";

    // Verify backend binary is in PATH before spawning
    const installation = BACKEND_INSTALLATION_INFO[backendName];
    if (installation && !checkBinaryInstalled(installation.binary)) {
      this.ctx.logger.error(
        { binary: installation.binary, backend: backendName, instance: name },
        `Backend binary "${installation.binary}" not found in PATH`,
      );
    }

    // claude-code refuses --dangerously-skip-permissions as root — fail fast
    // Unless IS_SANDBOX=1 is set (recognized sandbox environment)
    if (process.getuid?.() === 0 && backendName === "claude-code" && !process.env.IS_SANDBOX) {
      const msg = `⚠️ claude-code cannot run with --dangerously-skip-permissions as root. Set IS_SANDBOX=1 or use a non-root user.`;
      this.ctx.logger.error({ name, backend: backendName }, msg);
      this.ctx.notifyInstanceTopic(name, t("inst.root_skip_perms"));
      return;
    }

    const backend = createBackend(backendName, instanceDir);
    const daemon = new Daemon(
      name,
      config,
      instanceDir,
      topicMode,
      backend,
      this.ctx.controlClient ?? undefined,
      this.ctx.logger,
      runtimeIdentity ?? {
        kind: "fleet-topic",
        backend: backendName,
        model: config.model ?? "default",
      },
    );
    // Catch errors from daemon internals (e.g. IPC server) to prevent crashing the fleet process
    daemon.on("error", (err: Error) => {
      this.ctx.logger.error({ err, name }, "Daemon emitted error — instance isolated");
    });
    await daemon.start();
    this.daemons.set(name, daemon);


    daemon.on("auto_pause_requested", safeHandler(async () => {
      await this.pause(name);
    }, this.ctx.logger, `autoPause[${name}]`));

    daemon.on("auto_paused", (data: { pausedAt: number }) => {
      this.ctx.eventLog?.insert(name, "instance_paused", { reason: "idle", paused_at: data.pausedAt });
      this.ctx.logger.info({ name, pausedAt: data.pausedAt }, "Instance auto-paused after idle timeout");
      this.ctx.setTopicIcon(name, "remove");
    });

    daemon.on("auto_woke", () => {
      this.ctx.eventLog?.insert(name, "instance_resumed", { reason: "message" });
      this.ctx.logger.info({ name }, "Instance auto-woke for delivery");
      this.ctx.setTopicIcon(name, "green");
      this.ctx.touchActivity(name);
    });

    this.attachIncidentHandlers(name, daemon);

    daemon.on("pty_recovered", safeHandler((data: { name: string; downtime_s: number }) => {
      const mins = Math.floor(data.downtime_s / 60);
      const secs = data.downtime_s % 60;
      const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      this.ctx.eventLog?.insert(name, "pty_recovered", { downtime_s: data.downtime_s });
      this.ctx.logger.info({ name, downtime_s: data.downtime_s }, "PTY error recovered");
      this.ctx.notifyInstanceTopic(name, t("inst.recovered", name, duration));
      this.ctx.webhookEmit("pty_recovered", name, { downtime_s: data.downtime_s });
    }, this.ctx.logger, `daemon.pty_recovered[${name}]`));

    daemon.on("message_queued", (data: { chatId: string; messageId: string }) => {
      this.ctx.reactMessageStatus(name, data.chatId, data.messageId, "⏳");
    });
    // 👀 delivered (agent has the message), ✅ confirmed (agent started processing).
    daemon.on("message_delivered", (data: { chatId: string; messageId: string }) => {
      this.ctx.reactMessageStatus(name, data.chatId, data.messageId, "👀");
    });
    daemon.on("message_confirmed", (data: { chatId: string; messageId: string }) => {
      this.ctx.reactMessageStatus(name, data.chatId, data.messageId, "✅");
    });
    daemon.on("message_failed", safeHandler((data: { chatId: string; messageId: string }) => {
      this.ctx.eventLog?.insert(name, "message_failed", { messageId: data.messageId });
      this.ctx.logger.warn({ name, messageId: data.messageId }, "Message delivery failed (window gone, retries exhausted)");
      this.ctx.reactMessageStatus(name, data.chatId, data.messageId, "❌");
    }, this.ctx.logger, `daemon.message_failed[${name}]`));

    this.ctx.setTopicIcon(name, "green");
    this.ctx.touchActivity(name);
  }

  isPaused(name: string): boolean {
    return this.daemons.get(name)?.isPaused ?? hasPausedMarker(this.ctx.getInstanceDir(name));
  }

  getLastPausedAt(name: string): number | null {
    return this.daemons.get(name)?.lastPausedAt ?? readPausedAt(this.ctx.getInstanceDir(name));
  }

  async pause(name: string): Promise<void> {
    // Final backstop shared by slash, MCP, Settings, warm-cap, and any future
    // caller. General is the coordinator and must remain resident to route work.
    if (isGeneralInstance(this.ctx.fleetConfig, name)) {
      throw new Error(GENERAL_PAUSE_ERROR);
    }
    const daemon = this.daemons.get(name);
    if (!daemon) {
      if (hasPausedMarker(this.ctx.getInstanceDir(name))) return;
      throw new Error(`Cannot pause stopped instance '${name}'`);
    }
    this.ctx.stopStatuslineWatcher(name);
    try {
      await daemon.pause();
    } finally {
      // A rejected/no-op pause leaves the instance active and must not strand
      // its fleet-level statusline watcher in the frozen state.
      if (!daemon.isPaused) this.ctx.startStatuslineWatcher(name);
    }
  }

  async wake(name: string, timeoutMs = 30_000): Promise<void> {
    const daemon = this.daemons.get(name);
    if (daemon) {
      await daemon.wake(timeoutMs);
    } else {
      const instanceDir = this.ctx.getInstanceDir(name);
      if (!hasPausedMarker(instanceDir)) throw new Error(`Cannot wake stopped instance '${name}'`);
      const pausedAt = readPausedAt(instanceDir) ?? Date.now();
      clearPausedMarker(instanceDir);
      try {
        await this.ctx.startPersistedPausedInstance(name);
      } catch (err) {
        writePausedMarker(instanceDir, pausedAt);
        throw err;
      }
    }
    this.ctx.startStatuslineWatcher(name);
  }

  async stop(name: string): Promise<void> {
    this.ctx.setTopicIcon(name, "remove");

    const daemon = this.daemons.get(name);
    if (daemon) {
      await daemon.stop();
      this.daemons.delete(name);
    } else {
      const instanceDir = this.ctx.getInstanceDir(name);
      const pidPath = join(instanceDir, "daemon.pid");
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        const unsafeReason = getUnsafeInstanceDaemonPidReason(pid, this.ctx.dataDir);
        if (unsafeReason) {
          this.ctx.logger.error(
            { instance: name, pid, reason: unsafeReason, pidPath },
            `Refusing to SIGTERM pid ${pid} — it is the shared fleet process, not a per-instance daemon`,
          );
        } else {
          try { process.kill(pid, "SIGTERM"); } catch (e) { this.ctx.logger.debug({ err: e, pid }, "SIGTERM failed for stale process"); }
        }
      }
      // Kill orphaned tmux window (daemon not in memory but window may persist)
      const windowIdPath = join(instanceDir, "window-id");
      if (existsSync(windowIdPath)) {
        const windowId = readFileSync(windowIdPath, "utf-8").trim();
        if (windowId) {
          const { TmuxManager } = await import("./tmux-manager.js");
          const { getTmuxSession } = await import("./config.js");
          const tmux = new TmuxManager(getTmuxSession(), windowId);
          await tmux.killWindow();
        }
        try { const { unlinkSync } = await import("node:fs"); unlinkSync(windowIdPath); } catch {}
      }
    }

    // Clean up IPC client (prevents stale routing after stop)
    this.ctx.ipcStoppingInstances.add(name);
    const ipc = this.ctx.instanceIpcClients.get(name);
    if (ipc) {
      try { ipc.close(); } catch { /* already closed */ }
      this.ctx.instanceIpcClients.delete(name);
    }
    this.ctx.ipcStoppingInstances.delete(name);
    // Clean up session registry entries pointing to this instance
    for (const [session, instance] of this.ctx.sessionRegistry) {
      if (instance === name) this.ctx.sessionRegistry.delete(session);
    }
  }

  async remove(name: string): Promise<void> {
    const config = this.ctx.fleetConfig?.instances[name];
    if (!config) return;

    // Never remove the General instance
    if (config.general_topic) {
      this.ctx.logger.warn({ name }, "Refusing to remove General instance");
      return;
    }

    // Clean up schedules
    // Access scheduler through fleetConfig — scheduler is managed by FleetManager
    // We just clean up instance-related data here

    // Stop daemon and clean up tmux window (handles both in-memory and orphaned cases)
    await this.stop(name);

    // Clean up backend config files (MCP config, instructions, etc.)
    // This is needed even when daemon is not in memory — stop() only calls
    // backend.cleanup() when daemon object exists. Without this, stale MCP
    // entries remain in the working directory and crash new instances.
    if (config.working_directory && config.backend) {
      try {
        const { createBackend } = await import("./backend/factory.js");
        const instanceDir = this.ctx.getInstanceDir(name);
        const backend = createBackend(config.backend, instanceDir);
        if (backend?.cleanup) {
          const backendConfig = {
            workingDirectory: config.working_directory,
            instanceDir,
            instanceName: name,
            mcpServers: {
              agend: { command: "", args: [], env: {} },
            },
          };
          backend.cleanup(backendConfig as import("./backend/types.js").CliBackendConfig);
          this.ctx.logger.info({ name }, "Cleaned up backend config files");
        }
      } catch (err) {
        this.ctx.logger.debug({ err, name }, "Backend cleanup failed (best effort)");
      }
    }

    // Clean up git worktree if applicable
    if (config.worktree_source && config.working_directory) {
      if (!existsSync(config.working_directory)) {
        this.ctx.logger.info({ worktree: config.working_directory }, "Worktree directory already gone, skipping removal");
      } else {
        try {
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFileCb);
          await execFileAsync("git", ["worktree", "remove", "--force", config.working_directory], {
            cwd: config.worktree_source,
          });
          this.ctx.logger.info({ worktree: config.working_directory }, "Removed git worktree");
        } catch {
          // worktree remove failed — directory exists but isn't a valid worktree.
          // Only rm if directory is in the expected location (sibling of source repo or under ~/.agend/).
          const expectedParent = dirname(config.working_directory);
          const sourceParent = dirname(config.worktree_source);
          if (expectedParent === sourceParent || config.working_directory.startsWith(getAgendHome())) {
            const { rm } = await import("node:fs/promises");
            await rm(config.working_directory, { recursive: true, force: true });
            this.ctx.logger.info({ worktree: config.working_directory }, "Removed orphaned worktree directory");
          } else {
            this.ctx.logger.warn({ worktree: config.working_directory }, "Worktree removal failed and directory is outside expected location — skipping rm");
          }
        }
      }
      // Prune stale worktree records (e.g. if directory was manually deleted)
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFileCb);
        await execFileAsync("git", ["worktree", "prune"], { cwd: config.worktree_source });
      } catch { /* best effort */ }
    }

    // Clean up IPC
    const ipc = this.ctx.instanceIpcClients.get(name);
    if (ipc) {
      await ipc.close();
      this.ctx.instanceIpcClients.delete(name);
    }

    // Remove from routing table
    if (config.topic_id != null) {
      this.ctx.routing.unregister(config.topic_id);
    }

    // Remove from fleet config and save
    delete this.ctx.fleetConfig!.instances[name];
    this.ctx.saveFleetConfig();
    clearPausedMarker(this.ctx.getInstanceDir(name));

    this.ctx.logger.info({ name }, "Instance removed");
  }

  /** Handle create_instance tool call from a daemon. */
  async handleCreate(
    args: LifecycleCreateArgs,
    respond: (result: unknown, error?: string) => void,
    adapterId?: string,
  ): Promise<void> {
    const rawDirectory = args.directory;
    const directory = rawDirectory ? rawDirectory.replace(/^~/, process.env.HOME || "~") : undefined;
    const topicName = args.topic_name || (directory ? basename(directory) : undefined);
    const description = args.description;
    const systemPrompt = args.systemPrompt;
    const branch = args.branch;
    const detach = args.detach ?? false;

    if (!directory && !topicName) {
      respond(null, "topic_name is required when directory is not specified");
      return;
    }

    // Validate directory exists (only when explicitly provided)
    if (directory) {
      try {
        await access(directory);
      } catch {
        respond(null, `Directory does not exist: ${directory}`);
        return;
      }
    }

    // Enforce project_roots boundary when configured. Use realpathSync so
    // symlinks cannot be used to escape the allowed roots (a directory under
    // an allowed root that symlinks to `/etc` would otherwise pass the string
    // prefix check).
    const roots = this.ctx.fleetConfig?.project_roots;
    if (directory && roots?.length) {
      let resolved: string;
      try {
        resolved = realpathSync(resolve(directory));
      } catch {
        respond(null, `Directory "${directory}" is not accessible`);
        return;
      }
      const allowed = roots.some(r => {
        const raw = resolve(r.replace(/^~/, process.env.HOME || "~"));
        let root: string;
        try {
          root = realpathSync(raw);
        } catch {
          // Root doesn't exist on disk — cannot be a valid boundary.
          return false;
        }
        return resolved === root || resolved.startsWith(root + pathSep);
      });
      if (!allowed) {
        respond(null, `Directory "${directory}" is not under project_roots. Allowed: ${roots.join(", ")}`);
        return;
      }
    }

    // Check for duplicate early (before worktree creation) — only when directory is known and no branch
    if (directory && !branch) {
      const expandHome = (p: string) => p.replace(/^~/, process.env.HOME || "~");
      const existingInstance = Object.entries(this.ctx.fleetConfig?.instances ?? {})
        .find(([_, config]) => expandHome(config.working_directory) === directory);
      if (existingInstance) {
        const [eName, eConfig] = existingInstance;
        respond({
          success: true,
          status: "already_exists",
          name: eName,
          topic_id: eConfig.topic_id,
          running: this.daemons.has(eName),
        });
        return;
      }
    }

    // If branch specified, create git worktree (requires directory)
    let workDir = directory ?? "";
    let worktreePath: string | undefined;
    if (branch && !directory) {
      respond(null, "directory is required when branch is specified");
      return;
    }
    if (branch) {
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFileCb);

        await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: directory });

        const customPath = args.worktree_path;
        if (customPath) {
          worktreePath = customPath.replace(/^~/, process.env.HOME || "~");
        } else {
          const repoName = basename(directory!);
          const safeBranch = branch.replace(/\//g, "-");
          worktreePath = join(dirname(directory!), `${repoName}-${safeBranch}`);
        }

        let branchExists = false;
        try {
          await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd: directory });
          branchExists = true;
        } catch { /* branch doesn't exist */ }

        if (detach) {
          await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, branch], { cwd: directory });
        } else if (branchExists) {
          await execFileAsync("git", ["worktree", "add", worktreePath, branch], { cwd: directory });
        } else {
          const startPoint = args.start_point;
          const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
          if (startPoint) worktreeArgs.push(startPoint);
          await execFileAsync("git", worktreeArgs, { cwd: directory });
        }
        this.ctx.logger.info({ worktreePath, branch, repo: directory }, "Created git worktree for instance");
        workDir = worktreePath;
      } catch (err) {
        respond(null, `Failed to create worktree: ${(err as Error).message}`);
        return;
      }
    }

    // Check worktree path for duplicates
    if (worktreePath) {
      const expandHome = (p: string) => p.replace(/^~/, process.env.HOME || "~");
      const existingInstance = Object.entries(this.ctx.fleetConfig?.instances ?? {})
        .find(([_, config]) => expandHome(config.working_directory) === workDir);
      if (existingInstance) {
        const [eName, eConfig] = existingInstance;
        respond({
          success: true,
          status: "already_exists",
          name: eName,
          topic_id: eConfig.topic_id,
          running: this.daemons.has(eName),
        });
        return;
      }
    }

    // Sequential steps with rollback
    let createdTopicId: number | string | undefined;
    let newInstanceName: string | undefined;

    try {
      createdTopicId = await this.ctx.createForumTopic(topicName!, adapterId);

      // Use explicit topic_name as name base when provided; fall back to directory basename
      const explicitTopicName = args.topic_name;
      const nameBase = explicitTopicName ?? (worktreePath ? topicName! : (directory ? basename(workDir) : topicName!));
      newInstanceName = `${sanitizeInstanceName(nameBase)}-t${createdTopicId}`;
      // A recycled name must never inherit a stale pause marker.
      clearPausedMarker(this.ctx.getInstanceDir(newInstanceName));

      // If no directory was provided, auto-create default workspace
      if (!directory) {
        workDir = join(getAgendHome(), "workspaces", newInstanceName);
        mkdirSync(workDir, { recursive: true });
        ensureWorkspaceGit(workDir);
      }

      const instanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        ...this.ctx.fleetConfig!.defaults,
        working_directory: workDir,
        topic_id: createdTopicId,
        ...(description ? { description } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.backend ? { backend: args.backend } : {}),
        ...(args.backend_options ? { backend_options: args.backend_options } : {}),
        ...(args.model_failover ? { model_failover: args.model_failover } : {}),
        ...(args.tool_set ? { tool_set: args.tool_set } : {}),
        ...(args.skipPermissions != null ? { skipPermissions: args.skipPermissions } : {}),
        ...(args.lightweight != null ? { lightweight: args.lightweight } : {}),
        ...(args.workflow !== undefined ? { workflow: args.workflow === "false" ? false : args.workflow } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
        ...(worktreePath ? { worktree_source: directory } : {}),
      } as InstanceConfig;
      // defaults.model is inherited by every instance via the spread above, but
      // a Claude model (etc.) must not be forced onto a backend that can't run
      // it (e.g. codex/agy → CLI errors on --model claude-*). Drop an INHERITED
      // (non-explicit) model that's incompatible with the resolved backend; an
      // explicitly-passed args.model is always respected.
      if (!args.model && instanceConfig.model && instanceConfig.backend
          && !isModelCompatible(instanceConfig.backend, instanceConfig.model)) {
        delete instanceConfig.model;
      }
      this.ctx.fleetConfig!.instances[newInstanceName] = instanceConfig;
      this.ctx.routing.register(createdTopicId, { kind: "instance", name: newInstanceName });
      this.ctx.saveFleetConfig();

      await this.start(newInstanceName, instanceConfig, true);
      await this.ctx.connectIpcToInstance(newInstanceName);

      respond({
        success: true,
        name: newInstanceName,
        topic_id: createdTopicId,
        ...(worktreePath ? { worktree_path: worktreePath, branch } : {}),
      });
    } catch (err) {
      // Rollback in reverse order
      if (newInstanceName && this.daemons.has(newInstanceName)) {
        await this.stop(newInstanceName).catch(e => this.ctx.logger.error({ err: e, name: newInstanceName }, "Failed to stop instance during rollback"));
      }
      if (newInstanceName && this.ctx.fleetConfig?.instances[newInstanceName]) {
        delete this.ctx.fleetConfig.instances[newInstanceName];
        if (createdTopicId) this.ctx.routing.unregister(createdTopicId);
        this.ctx.saveFleetConfig();
      }
      if (createdTopicId) {
        await this.ctx.deleteForumTopic(createdTopicId);
      }
      if (worktreePath) {
        try {
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFileCb);
          await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: directory });
          await execFileAsync("git", ["worktree", "prune"], { cwd: directory });
        } catch { /* best-effort worktree cleanup */ }
      } else if (!directory && workDir) {
        // Remove auto-created workspace directory
        try {
          const { rm } = await import("node:fs/promises");
          await rm(workDir, { recursive: true, force: true });
        } catch { /* best-effort cleanup */ }
      }
      respond(null, `Failed to create instance: ${(err as Error).message}`);
    }
  }

  /** Handle delete_instance tool call from a daemon. */
  async handleDelete(
    args: LifecycleDeleteArgs,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const instanceName = args.name;
    const deleteTopic = args.delete_topic ?? false;

    const instanceConfig = this.ctx.fleetConfig?.instances[instanceName];
    if (!instanceConfig) {
      respond(null, `Instance not found: ${instanceName}`);
      return;
    }

    if (instanceConfig.general_topic) {
      respond(null, "Cannot delete the General instance");
      return;
    }

    if (deleteTopic && instanceConfig.topic_id) {
      await this.ctx.deleteForumTopic(instanceConfig.topic_id);
    }

    await this.ctx.removeInstance(instanceName);
    respond({ success: true, name: instanceName, topic_deleted: deleteTopic });
  }

  has(name: string): boolean {
    return this.daemons.has(name);
  }

  /** Handle replace_instance tool call: handover → stop → create new → delete old config.
   *  If the old instance has a worktree_source, ownership transfers to the new instance
   *  implicitly via savedConfig — the worktree itself is not recreated or removed. */
  async handleReplace(
    args: LifecycleReplaceArgs,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const instanceName = args.name;
    const reason = args.reason || "replaced";

    const oldConfig = this.ctx.fleetConfig?.instances[instanceName];
    if (!oldConfig) { respond(null, `Instance not found: ${instanceName}`); return; }
    if (oldConfig.general_topic) { respond(null, "Cannot replace the General instance"); return; }

    // 1. Collect handover context from daemon ring buffer (before stopping)
    let handoverContext = "";
    const daemon = this.daemons.get(instanceName);
    if (daemon) {
      handoverContext = daemon.collectHandoverContext();
    }

    // 2. Remember config for recreation
    const savedConfig = { ...oldConfig };
    const topicId = savedConfig.topic_id;

    // 3. Stop old instance (reversible — config still in fleet.yaml)
    await this.stop(instanceName);
    const oldIpc = this.ctx.instanceIpcClients.get(instanceName);
    if (oldIpc) { await oldIpc.close(); this.ctx.instanceIpcClients.delete(instanceName); }

    // 4. Remove old config + routing (so new instance can reuse the name/topic)
    if (topicId != null) this.ctx.routing.unregister(topicId);
    delete this.ctx.fleetConfig!.instances[instanceName];
    this.ctx.saveFleetConfig();

    // 5. Clean instanceDir to avoid stale rotation-state.json / crash-history
    const instanceDir = this.ctx.getInstanceDir(instanceName);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(instanceDir, { recursive: true, force: true });
    } catch { /* best effort */ }

    // 6. Create new instance with same config, reusing topic
    const newName = `${instanceName.replace(/-t\d+$/, "")}-t${topicId}`;
    const instanceConfig = { ...savedConfig } as InstanceConfig;
    try {
      this.ctx.fleetConfig!.instances[newName] = instanceConfig;
      if (topicId != null) this.ctx.routing.register(topicId, { kind: "instance", name: newName });
      this.ctx.saveFleetConfig();

      await this.start(newName, instanceConfig, true);
      await this.ctx.connectIpcToInstance(newName);

      // 7. Send handover context via fleet_inbound (standard message delivery path)
      if (handoverContext) {
        await new Promise(r => setTimeout(r, 3_000));
        const newIpc = this.ctx.instanceIpcClients.get(newName);
        if (newIpc) {
          const handoverMsg = `[system:handover]\nYou are replacing instance "${instanceName}" (reason: ${reason}).\n\n${handoverContext}\n\nResume work based on this context. Do NOT reply to this message — wait for the next user message.`;
          newIpc.send({
            type: "fleet_inbound",
            content: handoverMsg,
            meta: { from_instance: "system", source: "handover", user: "system", ts: new Date().toISOString(), chat_id: "", thread_id: "" },
          });
        }
      }

      respond({
        success: true,
        old_name: instanceName,
        new_name: newName,
        topic_id: topicId,
        reason,
        handover_chars: handoverContext.length,
      });
    } catch (err) {
      // Rollback: restore old instance config (new instance failed to start)
      if (this.daemons.has(newName)) await this.stop(newName).catch(() => {});
      delete this.ctx.fleetConfig!.instances[newName];
      // Restore old config so user doesn't lose both instances
      this.ctx.fleetConfig!.instances[instanceName] = savedConfig;
      if (topicId != null) this.ctx.routing.register(topicId, { kind: "instance", name: instanceName });
      this.ctx.saveFleetConfig();
      respond(null, `Failed to replace instance: ${(err as Error).message}. Old instance config restored (stopped).`);
    }
  }

  private findGeneralInstance(): string | undefined {
    const instances = this.ctx.fleetConfig?.instances ?? {};
    for (const [n, config] of Object.entries(instances)) {
      if (config.general_topic) return n;
    }
    return undefined;
  }
}
