import { readFileSync, existsSync } from "node:fs";
import { exec, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { homedir, release } from "node:os";
import { createRequire } from "node:module";

const execAsync = promisify(exec);
import type { FleetContext } from "./fleet-context.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { formatCents } from "./cost-guard.js";
import { detectPlatform } from "./service-installer.js";
import { getTmuxSocketName, getTmuxSessionName } from "./paths.js";
import { t } from "./locale.js";
import {
  clampContextPercent,
  parseContextPercent,
  parseTokenContextRatio,
  type TokenContextRatio,
} from "./context-percent.js";
import { GENERAL_PAUSE_ERROR, isGeneralInstance } from "./general-instance.js";

export { parseContextPercent, parseTokenContextRatio } from "./context-percent.js";
export type { TokenContextRatio } from "./context-percent.js";

type ExecutionFleetContext = FleetContext & {
  getInstanceExecutionState?(instanceName: string): "idle" | "working" | "stuck" | null;
};

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

/** Allowed filename for /save and /load (no path separators, no shell/inject chars). */
export const SAVE_FILENAME_RE = /^[\w.-]+$/;

/** Backends with a native side-question command that does not steer the active turn. */
export const BTW_SUPPORTED_BACKENDS = new Set(["claude-code"]);

/**
 * Build the backend-specific session-save command, or null if the backend has no
 * /save equivalent. kiro-cli → `/chat save <name>`; claude-code → `/export <name>.md`.
 */
export function saveCommandForBackend(backend: string, filename: string, force = false): string | null {
  if (backend === "kiro-cli") return force ? `/chat save ${filename} -f` : `/chat save ${filename}`;
  if (backend === "claude-code") return `/export ${filename}.md`;
  return null;
}

/** Extract the filename argument from `/save <name>` or `/save@bot <name>`. */
export function parseSaveFilename(text: string): string {
  const m = text.match(/^\/save(?:@\S+)?(?:\s+(.*))?$/);
  return (m?.[1] ?? "").trim();
}

/** Shared message when a backend doesn't support /save. */
export const SAVE_UNSUPPORTED_MSG = "⚠️ /save is not supported for this backend (only kiro-cli and claude-code)";

export function parsePauseWakeCommand(text: string): { action: "pause" | "wake"; instance?: string } | null {
  const match = text.match(/^\/(pause|wake)(?:@\S+)?(?:\s+(\S+))?$/);
  if (!match) return null;
  return { action: match[1] as "pause" | "wake", instance: match[2] };
}

/**
 * The in-session compact/context-reset command for a backend NAME (the fleet
 * process routes /compact via IPC and only has the backend string, not a
 * CliBackend instance). Keep in sync with each backend's getCompactCommand().
 * Most CLIs (claude-code, kiro-cli, codex, opencode, gemini-cli) use "/compact".
 * Antigravity (agy) has NO summarizing compact — its only manual context-reset
 * is "/clear" (a full reset; it also auto-summarizes at a token threshold).
 */
/** os.release(), guarded — purely informational, must never break /sysinfo. */
function osRelease(): string {
  try { return release(); } catch { return "?"; }
}

/**
 * `tmux -V`, memoised. One short synchronous exec for the lifetime of the
 * process — /sysinfo is on-demand and rare, and the version cannot change under
 * a running fleet (the server would have to restart with it).
 */
let cachedTmuxVersion: string | null = null;
function tmuxVersion(): string {
  if (cachedTmuxVersion === null) {
    try {
      cachedTmuxVersion = execFileSync("tmux", ["-V"], { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
      cachedTmuxVersion = "not found";
    }
  }
  return cachedTmuxVersion;
}

export function compactCommandForBackend(backend: string): string {
  if (backend === "antigravity") return "/clear";
  return "/compact";
}

/**
 * Full conversation-reset command for a backend NAME. Keep this routing-only
 * lookup in sync with CliBackend.getClearCommand(); the fleet process does not
 * own the backend object that lives inside each daemon.
 */
export function clearCommandForBackend(backend: string): string | null {
  switch (backend) {
    case "claude-code":
    case "codex":
    case "kiro-cli":
    case "antigravity":
    case "opencode":
    case "mock":
      return "/clear";
    case "grok":
      return "/new";
    case "gemini-cli":
    default:
      return null;
  }
}

export const CLEAR_UNSUPPORTED_MSG = "⚠️ Clear not supported for this backend";

/**
 * Extract context-usage % from a captured CLI pane. Scans bottom-up so the
 * MOST RECENT prompt wins (a captured scrollback may hold several). Covers the
 * common CLI prompt formats:
 *   kiro-cli classic:  "6% !>"        kiro-cli TUI: "◔ 6%" (any pie glyph)
 *   bracketed:         "[6%]"         claude/others prompt: "6% ❯" / "6% >"
 *   codex TUI footer:  "Context 94% left" (remaining) or "Context 6% used"
 *   opencode footer:   "1.2K (6%)"   (token count then parenthesized %)
 *   grok title bar:     "12K / 500K" (used tokens / context window)
 * All values returned are context USED (low % = fresh session); codex's
 * "N% left" is remaining, so it's inverted to 100 - N.
 */
export function formatContextUsageLine(context: number, tokenRatio: TokenContextRatio | null = null): string {
  const rounded = Math.round(context);
  const localized = t("ctx.used", rounded);
  return tokenRatio
    ? localized.replace(`${rounded}%`, `${tokenRatio.usedLabel} / ${tokenRatio.totalLabel} (${rounded}%)`)
    : localized;
}

/** Claude Code statusline.json context used % (null if missing / unreadable). */
export function readStatuslineContextPct(dataDir: string, instanceName: string): number | null {
  try {
    const statusFile = join(dataDir, "instances", instanceName, "statusline.json");
    if (!existsSync(statusFile)) return null;
    const data = JSON.parse(readFileSync(statusFile, "utf-8"));
    const pct = data.context_window?.used_percentage;
    return clampContextPercent(pct);
  } catch {
    return null;
  }
}

/** Live-pane scrape used by /ctx, /status Ctx, and /view sidebar. */
export function scrapePaneContext(
  instanceName: string,
  backend: string,
): { context: number | null; tokenRatio: TokenContextRatio | null } {
  try {
    const socketName = getTmuxSocketName();
    // Scrollback (-S -60) so a recent footer/statusline is kept even mid-output.
    const baseArgs = ["capture-pane", "-t", `${getTmuxSessionName()}:${instanceName}`, "-p", "-S", "-60"];
    const tmuxArgs = socketName ? ["-L", socketName, ...baseArgs] : baseArgs;
    const pane = execFileSync("tmux", tmuxArgs, {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const tokenRatio = backend === "grok" ? parseTokenContextRatio(pane) : null;
    const context = tokenRatio?.percentage ?? parseContextPercent(pane);
    return { context, tokenRatio };
  } catch {
    return { context: null, tokenRatio: null };
  }
}

const paneContextCache = new Map<string, { at: number; context: number | null; tokenRatio: TokenContextRatio | null }>();
// Below the dashboard's 10s SSE tick on purpose: at the previous 12s the cache was
// guaranteed to be stale on roughly every other tick, which is what made the
// blocking scrape fire so often. Now a tick either hits the cache or triggers a
// background refresh, never a synchronous capture.
const PANE_CONTEXT_CACHE_MS = 8_000;
/** Instances with a background scrape in flight, so polls don't pile up captures. */
const paneScrapeInFlight = new Set<string>();

/** Async twin of scrapePaneContext — same parsers, no blocking. */
async function scrapePaneContextAsync(
  instanceName: string,
  backend: string,
): Promise<{ context: number | null; tokenRatio: TokenContextRatio | null }> {
  try {
    const socketName = getTmuxSocketName();
    const baseArgs = ["capture-pane", "-t", `${getTmuxSessionName()}:${instanceName}`, "-p", "-S", "-60"];
    const tmuxArgs = socketName ? ["-L", socketName, ...baseArgs] : baseArgs;
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    const { stdout } = await promisify(execFile)("tmux", tmuxArgs, { encoding: "utf-8", timeout: 2000 });
    const pane = stdout.toString();
    const tokenRatio = backend === "grok" ? parseTokenContextRatio(pane) : null;
    return { context: tokenRatio?.percentage ?? parseContextPercent(pane), tokenRatio };
  } catch {
    return { context: null, tokenRatio: null };
  }
}

/** Refresh one instance's cached context in the background (deduped per instance). */
function refreshPaneContext(instanceName: string, backend: string): void {
  if (paneScrapeInFlight.has(instanceName)) return;
  paneScrapeInFlight.add(instanceName);
  void scrapePaneContextAsync(instanceName, backend)
    .then(scraped => { paneContextCache.set(instanceName, { at: Date.now(), ...scraped }); })
    .finally(() => { paneScrapeInFlight.delete(instanceName); });
}

/** Forget a deleted instance's cached context so the map can't grow forever. */
export function forgetInstanceContext(instanceName: string): void {
  paneContextCache.delete(instanceName);
}

/**
 * Single source of truth for instance context % across /ctx, /status, and View.
 * Claude-code prefers statusline.json (authoritative, no TUI scrape); everyone
 * else scrapes the live pane with the same parsers /ctx uses.
 *
 * Non-blocking by default (stale-while-revalidate): a fresh cache entry is
 * returned as-is; a stale or missing one is returned immediately anyway while a
 * background refresh runs. This used to scrape synchronously with `execFileSync`
 * (2s timeout) on a cache miss, and the 12s TTL is LONGER than the dashboard's
 * 10s poll — so roughly every other tick did N blocking captures. With ten
 * non-claude-code instances and a slow tmux that froze the entire fleet event
 * loop for up to 20s per tick: no IPC, no message delivery, no watchdog ping.
 * Three open browser tabs ran three independent polls.
 *
 * Pass `bypassCache` for a synchronous, authoritative read — used by `/ctx`,
 * where a user is asking right now and 2s of blocking is the correct trade.
 */
export function resolveInstanceContext(
  dataDir: string,
  instanceName: string,
  backend: string,
  opts?: { bypassCache?: boolean },
): { context: number | null; tokenRatio: TokenContextRatio | null } {
  if (backend === "claude-code") {
    const fromFile = readStatuslineContextPct(dataDir, instanceName);
    if (fromFile != null) return { context: fromFile, tokenRatio: null };
  }

  if (opts?.bypassCache) {
    const scraped = scrapePaneContext(instanceName, backend);
    paneContextCache.set(instanceName, { at: Date.now(), ...scraped });
    return scraped;
  }

  const hit = paneContextCache.get(instanceName);
  if (hit && Date.now() - hit.at < PANE_CONTEXT_CACHE_MS) {
    return { context: hit.context, tokenRatio: hit.tokenRatio };
  }

  // Stale or absent: kick off the refresh and answer with what we have. A brand-new
  // instance reads as "no data" for one tick rather than blocking the fleet.
  refreshPaneContext(instanceName, backend);
  return hit ? { context: hit.context, tokenRatio: hit.tokenRatio } : { context: null, tokenRatio: null };
}

export class TopicCommands {
  constructor(private ctx: ExecutionFleetContext) {}

  /** Get the adapter that should reply to a given inbound message */
  private getReplyAdapter(msg: InboundMessage): ChannelAdapter | null {
    if (msg.adapterId && this.ctx.adapters) {
      return this.ctx.adapters.get(msg.adapterId) ?? this.ctx.adapter;
    }
    return this.ctx.adapter;
  }

  /** Parse and dispatch commands from the General topic */
  async handleGeneralCommand(msg: InboundMessage): Promise<boolean> {
    const text = msg.text?.trim();
    if (!text) return false;

    if (text === "/status" || text === "/status@" || text.startsWith("/status@")) {
      await this.handleStatusCommand(msg);
      return true;
    }

    if (text === "/restart" || text === "/restart@" || text.startsWith("/restart@")) {
      await this.handleRestartCommand(msg);
      return true;
    }

    if (text === "/sysinfo" || text === "/sysinfo@" || text.startsWith("/sysinfo@")
        || text === "/sys-info" || text === "/sys_info") {
      await this.handleSysInfoCommand(msg);
      return true;
    }

    if (text === "/doctor" || text.startsWith("/doctor@")) {
      await this.handleDoctorCommand(msg);
      return true;
    }

    if (text === "/usage" || text.startsWith("/usage@")) {
      await this.handleUsageCommand(msg);
      return true;
    }

    if (text === "/tips" || text.startsWith("/tips ") || text.startsWith("/tips@")) {
      await this.handleTipsCommand(msg);
      return true;
    }

    if (text === "/update" || text.startsWith("/update@")) {
      await this.handleUpdateCommand(msg);
      return true;
    }

    if (text === "/dashboard" || text.startsWith("/dashboard@")) {
      await this.handleDashboardCommand(msg);
      return true;
    }

    return false;
  }

  /**
   * Build the dashboard URL text (View / Settings / Web UI). The Settings/Web UI
   * URLs carry the web token; when `htmlSpoiler` is set they're wrapped in a
   * Telegram HTML spoiler (`<tg-spoiler>`) so the token isn't shown in the clear
   * in a shared topic (the caller must send with format: "html"). /view is
   * public, so it's never spoilered. DC uses the plain form (ephemeral reply).
   */
  getDashboardText(htmlSpoiler = false): string {
    const port = this.ctx.fleetConfig?.health_port ?? 19280;
    const host = (this.ctx.fleetConfig as { hostname?: string } | null | undefined)?.hostname || "localhost";
    const access = this.ctx.getDashboardAccess?.();
    if (!access?.ready || !access.token) return t("dashboard.starting");
    const token = access.token;
    const base = `http://${host}:${port}`;
    const hide = (u: string) => htmlSpoiler ? `<tg-spoiler>${u}</tg-spoiler>` : u;
    return [
      t("dashboard.title"),
      "",
      `• View:     ${base}/view`,
      `• View (edit): ${hide(`${base}/view?token=${token}`)}`,
      `• Settings: ${hide(`${base}/settings?token=${token}`)}`,
      `• Web UI:   ${hide(`${base}/ui?token=${token}`)}`,
    ].join("\n");
  }

  /**
   * /dashboard (TG): admin-only. Replies directly in the topic; the token-
   * bearing URLs are wrapped in a Telegram HTML spoiler so they aren't shown in
   * the clear (the adapter supports plain/HTML, not MarkdownV2's `||…||`).
   */
  private async handleDashboardCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;
    const allowed = this.ctx.fleetConfig?.channel?.access?.allowed_users ?? [];
    if (allowed.length === 0) { await adapter.sendText(chatId, t("dashboard.disabled"), { threadId }); return; }
    if (!allowed.some(u => String(u) === String(msg.userId))) { await adapter.sendText(chatId, t("not_authorized"), { threadId }); return; }

    await adapter.sendText(chatId, this.getDashboardText(true), { threadId, format: "html" });
  }

  /** Handle /ctx or /compact in any instance topic — returns true if handled */
  async handleInstanceCommand(msg: InboundMessage, instanceName: string): Promise<boolean> {
    const text = msg.text?.trim();
    if (!text) return false;

    const pauseWake = parsePauseWakeCommand(text);
    if (pauseWake) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }

      const isGeneral = !!this.ctx.fleetConfig?.instances[instanceName]?.general_topic;
      if (isGeneral && !pauseWake.instance) {
        await adapter.sendText(msg.chatId, t(`${pauseWake.action}.usage`), { threadId: msg.threadId });
        return true;
      }
      const target = isGeneral ? pauseWake.instance! : instanceName;
      if (!this.ctx.fleetConfig?.instances[target]) {
        await adapter.sendText(msg.chatId, t("instance.not_found", target), { threadId: msg.threadId });
        return true;
      }
      if (pauseWake.action === "pause" && isGeneralInstance(this.ctx.fleetConfig, target)) {
        await adapter.sendText(msg.chatId, GENERAL_PAUSE_ERROR, { threadId: msg.threadId });
        return true;
      }
      await adapter.sendText(msg.chatId, await this.runPauseWake(target, pauseWake.action), { threadId: msg.threadId });
      return true;
    }

    if (text === "/collab" || text.startsWith("/collab@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      const isCollab = this.ctx.toggleFleetCollab(instanceName);
      await adapter.sendText(msg.chatId, isCollab
        ? t("collab.on")
        : t("collab.off"),
        { threadId: msg.threadId });
      return true;
    }

    if (text === "/effort" || text.startsWith("/effort ") || text.startsWith("/effort@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const level = text.replace(/^\/effort(@\S+)?/, "").trim();
      if (level) {
        const reply = await this.ctx.applyEffort?.(instanceName, level)
          ?? "Effort switching is unavailable.";
        await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
      } else if (this.ctx.promptEffortMenu) {
        // No arg → inline keyboard menu (TG), same shape as /model.
        const fallback = await this.ctx.promptEffortMenu(
          instanceName, msg.userId, msg.threadId ?? msg.chatId, adapter, msg.chatId, msg.threadId,
        );
        if (fallback) await adapter.sendText(msg.chatId, fallback, { threadId: msg.threadId });
      }
      return true;
    }

    if (text === "/model" || text.startsWith("/model ") || text.startsWith("/model@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      const name = text.replace(/^\/model(@\S+)?/, "").trim();
      if (name) {
        const reply = await this.ctx.applyModel(instanceName, name);
        await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
      } else if (this.ctx.promptModelMenu) {
        // No arg → inline keyboard menu (TG)
        const fallback = await this.ctx.promptModelMenu(
          instanceName, msg.userId, msg.threadId ?? msg.chatId, adapter, msg.chatId, msg.threadId,
        );
        if (fallback) await adapter.sendText(msg.chatId, fallback, { threadId: msg.threadId });
      } else {
        await adapter.sendText(msg.chatId, "Usage: /model <name> — e.g. /model sonnet", { threadId: msg.threadId });
      }
      return true;
    }

    if (text === "/compact" || text.startsWith("/compact@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      const result = await this.sendCompact(instanceName);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (text === "/steer" || text.startsWith("/steer ") || text.startsWith("/steer@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Deliberately NOT admin-gated: anyone who can speak in this topic can
      // already send the instance a message; /steer only changes WHEN it lands
      // (mid-turn instead of after), and it goes through the full [user:]
      // formatting — unlike /raw, which bypasses it and is gated.
      const content = text.replace(/^\/steer(@\S+)?/, "").trim();
      if (!content) {
        await adapter.sendText(msg.chatId, t("steer.usage"), { threadId: msg.threadId });
        return true;
      }
      const result = this.sendSteer(instanceName, content, msg);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (text === "/btw" || text.startsWith("/btw ") || text.startsWith("/btw@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      // Like /steer, /btw is not admin-gated: anyone who can send the agent a
      // normal message may ask a side question. Claude owns the isolation from
      // the active turn; AgEnD only submits its native command immediately.
      const content = text.replace(/^\/btw(@\S+)?/, "").trim();
      if (!content) {
        await adapter.sendText(msg.chatId, t("btw.usage"), { threadId: msg.threadId });
        return true;
      }
      const result = this.sendBtw(instanceName, content, msg);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (text === "/clear" || text.startsWith("/clear@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return true;
      }
      if (!this.ctx.promptClearConfirmation) {
        await adapter.sendText(msg.chatId, t("clear.prompt_unavailable"), { threadId: msg.threadId });
        return true;
      }
      const fallback = await this.ctx.promptClearConfirmation(
        instanceName,
        msg.threadId ?? msg.chatId,
        adapter,
        msg.chatId,
        msg.threadId,
      );
      if (fallback) await adapter.sendText(msg.chatId, fallback, { threadId: msg.threadId });
      return true;
    }

    if (text === "/cancel" || text.startsWith("/cancel@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      const ok = this.ctx.cancelInstance(instanceName);
      await adapter.sendText(msg.chatId, ok ? t("cancel.sent", instanceName) : t("cancel.not_running", instanceName), { threadId: msg.threadId });
      return true;
    }

    if (text === "/save" || text.startsWith("/save ") || text.startsWith("/save@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      const filename = parseSaveFilename(text);
      if (!filename) {
        await adapter.sendText(msg.chatId, t("save.usage"), { threadId: msg.threadId });
        return true;
      }
      if (!SAVE_FILENAME_RE.test(filename)) {
        await adapter.sendText(msg.chatId, t("filename.invalid"), { threadId: msg.threadId });
        return true;
      }
      const result = await this.sendSave(instanceName, filename);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
      return true;
    }

    if (text !== "/ctx" && !text.startsWith("/ctx@")) return false;

    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return false;

    const reply = await this.getCtxText(instanceName);
    await adapter.sendText(msg.chatId, reply, { threadId: msg.threadId });
    return true;
  }

  async runPauseWake(instanceName: string, action: "pause" | "wake"): Promise<string> {
    if (action === "pause" && isGeneralInstance(this.ctx.fleetConfig, instanceName)) {
      return GENERAL_PAUSE_ERROR;
    }
    try {
      const result = await this.ctx.changeInstancePauseState(instanceName, action);
      if (result === "not_idle") return t("pause.not_idle", instanceName);
      return t(result === "paused" ? "pause.success" : "wake.success", instanceName);
    } catch (err) {
      return t(`${action}.failed`, instanceName, (err as Error).message);
    }
  }

  /** Resolve the effective backend name for fleet or classic instances. */
  private effectiveBackend(instanceName: string): string {
    const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
      ? this.ctx.classicChannels.getBackendByInstance(instanceName, this.ctx.fleetConfig?.defaults?.backend)
      : undefined;
    return this.ctx.fleetConfig?.instances[instanceName]?.backend
      ?? classicBackend
      ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
  }

  /** Get context usage text for an instance (shared by TG + DC) */
  async getCtxText(instanceName: string): Promise<string> {
    // Classic instances live in classicBot.yaml, not fleet.yaml → consult the
    // classic channel manager for those so we don't mis-report defaults.backend.
    const backend = this.effectiveBackend(instanceName);
    // Fresh scrape for /ctx (user is asking right now) — bypass short cache.
    const { context, tokenRatio } = resolveInstanceContext(
      this.ctx.dataDir,
      instanceName,
      backend,
      { bypassCache: true },
    );
    const contextLine = context == null ? null : formatContextUsageLine(context, tokenRatio);
    // Effective model (resolves per-instance → fleet default → classic channel →
    // the CLI's own default) via the shared resolver, so /ctx and /model agree.
    const modelDisplay = this.ctx.modelDisplayForInstance?.(instanceName);
    const modelLine = modelDisplay ? `\n${t("ctx.model", modelDisplay)}` : "";
    return context != null
      ? `${contextLine}\n${t("ctx.backend", backend)}${modelLine}\n${t("ctx.instance", instanceName)}`
      : `${t("ctx.unavailable")}\n${t("ctx.backend", backend)}${modelLine}\n${t("ctx.instance", instanceName)}`;
  }

  /** Send the backend-appropriate compact command to an instance's tmux pane */
  async sendCompact(instanceName: string): Promise<string> {
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
        ? this.ctx.classicChannels.getBackendByInstance(instanceName, this.ctx.fleetConfig?.defaults?.backend)
        : undefined;
      const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
        ?? classicBackend
        ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
      const cmd = compactCommandForBackend(backend);
      ipc.send({ type: "raw_paste", content: cmd });
      return `🗜️ Compact command sent (\`${cmd}\`).`;
    }
    return "❌ Instance not connected (IPC unavailable)";
  }

  /** Whether the instance backend exposes a verified full-reset command. */
  supportsClear(instanceName: string): boolean {
    return clearCommandForBackend(this.effectiveBackend(instanceName)) !== null;
  }

  /**
   * Steer: interject a message into the instance's CURRENT turn. The daemon
   * pastes it into the busy CLI instead of queueing for idle (falling back to
   * the queue if the TUI swallows busy input — see Daemon.steerMessage).
   */
  /**
   * Backends whose TUI accepts a busy-pane paste as steering input,
   * live-verified: claude-code and codex buffer-then-submit at the turn
   * boundary, grok accepts it in its input line. kiro's legacy TUI swallows
   * the paste outright, and opencode/antigravity are unverified — for those
   * the user gets an honest "not supported" instead of a silent queue
   * fallback that looks like a steer but behaves like a normal message.
   */
  private static STEER_SUPPORTED_BACKENDS = new Set(["claude-code", "codex", "grok", "mock"]);

  sendSteer(
    instanceName: string,
    content: string,
    msg: Pick<InboundMessage, "chatId" | "messageId" | "username" | "userId" | "threadId" | "adapterId" | "source">,
  ): string {
    const backend = this.effectiveBackend(instanceName);
    if (!TopicCommands.STEER_SUPPORTED_BACKENDS.has(backend)) {
      return t("steer.unsupported", backend);
    }
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (!ipc?.connected) return t("steer.not_connected");
    ipc.send({
      type: "steer",
      content,
      delivery_epoch: this.ctx.getDeliveryEpoch?.(instanceName) ?? undefined,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId ?? "",
        user: msg.username,
        user_id: msg.userId,
        thread_id: msg.threadId ?? "",
        adapter_id: msg.adapterId ?? "",
        source: msg.source,
      },
    });
    return t("steer.sent", instanceName);
  }

  /** Ask a Claude Code side question without folding it into the active turn. */
  sendBtw(
    instanceName: string,
    content: string,
    msg: Pick<InboundMessage, "chatId" | "messageId" | "username" | "userId" | "threadId" | "adapterId" | "source">,
  ): string {
    const backend = this.effectiveBackend(instanceName);
    if (!BTW_SUPPORTED_BACKENDS.has(backend)) return t("btw.unsupported", backend);
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (!ipc?.connected) return t("btw.not_connected");
    ipc.send({
      type: "btw",
      content,
      delivery_epoch: this.ctx.getDeliveryEpoch?.(instanceName) ?? undefined,
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId ?? "",
        user: msg.username,
        user_id: msg.userId,
        thread_id: msg.threadId ?? "",
        adapter_id: msg.adapterId ?? "",
        source: msg.source,
      },
    });
    return t("btw.sent", instanceName);
  }

  /** Send the backend-appropriate full conversation reset through raw_paste. */
  async sendClear(instanceName: string): Promise<string> {
    const backend = this.effectiveBackend(instanceName);
    const cmd = clearCommandForBackend(backend);
    if (!cmd) return CLEAR_UNSUPPORTED_MSG;

    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      ipc.send({ type: "raw_paste", content: cmd });
      return t("clear.sent", cmd);
    }
    return t("clear.not_connected");
  }

  /** Send a backend-appropriate session-save command to a fleet-topic instance. */
  async sendSave(instanceName: string, filename: string): Promise<string> {
    const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
      ? this.ctx.classicChannels.getBackendByInstance(instanceName, this.ctx.fleetConfig?.defaults?.backend)
      : undefined;
    const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
      ?? classicBackend
      ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    const cmd = saveCommandForBackend(backend, filename);
    if (!cmd) return SAVE_UNSUPPORTED_MSG;
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      ipc.send({ type: "raw_paste", content: cmd });
      return `💾 Save command sent (\`${cmd}\`).`;
    }
    return "❌ Instance not connected (IPC unavailable)";
  }

  private async handleRestartCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    const allowed = this.ctx.fleetConfig?.channel?.access?.allowed_users ?? [];
    if (allowed.length > 0 && !allowed.some(u => String(u) === String(msg.userId))) {
      await adapter.sendText(chatId, t("not_authorized"), { threadId });
      return;
    }

    await adapter.sendText(chatId, t("restart.graceful"), { threadId });
    process.kill(process.pid, "SIGUSR2");
  }

  /**
   * `/usage` — AI subscription usage for CLI backends used by running or paused
   * instances, one compact message. Same permission level as /ctx (none): whoever
   * can talk to the fleet may see how much headroom it has left. Vendor rate
   * limits are protected by the shared 5-minute cache, not by gating callers.
   */
  private async handleUsageCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    try {
      const { getUsageSnapshot } = await import("./usage/usage-api.js");
      const { renderUsageHtml, renderUsageMarkdown } = await import("./usage/format-rich.js");
      const payload = await getUsageSnapshot(false, this.ctx.getActiveUsageProviderIds?.());
      // Each platform gets its native rich format: Telegram needs parse_mode
      // HTML; Discord renders Markdown in plain content. Anything else falls back
      // to Markdown, which degrades to readable text.
      if (adapter.type === "telegram") {
        await adapter.sendText(msg.chatId, renderUsageHtml(payload), { threadId: msg.threadId, format: "html" });
      } else {
        await adapter.sendText(msg.chatId, renderUsageMarkdown(payload), { threadId: msg.threadId });
      }
    } catch (err) {
      await adapter.sendText(msg.chatId, `⚠️ Usage fetch failed: ${(err as Error).message}`, { threadId: msg.threadId });
    }
  }

  private async handleTipsCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
    const mode = msg.text.trim().replace(/^\/tips(?:@\S+)?/, "").trim().toLowerCase();
    if (mode === "on" || mode === "off") {
      if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
        await adapter.sendText(msg.chatId, t("permission.denied"), { threadId: msg.threadId });
        return;
      }
      this.ctx.fleetConfig.defaults.tips = mode === "on";
      this.ctx.saveFleetConfig();
      await adapter.sendText(msg.chatId, t(mode === "on" ? "tips.enabled" : "tips.disabled"), {
        threadId: msg.threadId,
      });
      return;
    }
    if (mode) {
      await adapter.sendText(msg.chatId, t("tips.usage"), { threadId: msg.threadId });
      return;
    }
    const result = await this.ctx.promptTip?.(
      // /tips is a General command, so the route target is the current General.
      Object.entries(this.ctx.fleetConfig.instances)
        .find(([, config]) => config.general_topic === true
          && (!config.channel_id || config.channel_id === msg.adapterId))?.[0] ?? "general",
      adapter,
      msg.chatId,
      msg.threadId,
    ) ?? "unavailable";
    if (result === "empty") {
      await adapter.sendText(msg.chatId, t("tips.empty"), { threadId: msg.threadId });
    } else if (result === "unavailable") {
      await adapter.sendText(msg.chatId, t("tips.unavailable"), { threadId: msg.threadId });
    }
  }

  private async handleStatusCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
    // Admin-gated: with the /sysinfo instance table folded in, /status now shows
    // the whole fleet's per-instance costs and IPC health in one message.
    if (!this.ctx.isFleetAdmin(msg.userId, msg.adapterId)) {
      await adapter.sendText(msg.chatId, t("cmd.admin_required", "/status"), { threadId: msg.threadId });
      return;
    }
    const text = await this.getStatusText();
    await adapter.sendText(msg.chatId, text, { threadId: msg.threadId });
  }

  /** Compact label for status/sysinfo tables: prefer display_name, else strip the
   * `-t<topicId>` suffix (e.g. doupo-server-t1503381916525793300 → doupo-server).
   * Keeps rows short so a large fleet's table fits Discord's 2000-char limit. The
   * FULL name is still used for all lookups — only the displayed label changes. */
  private shortInstanceName(name: string): string {
    const dn = this.ctx.fleetConfig?.instances[name]?.display_name;
    if (dn && dn.trim()) return dn.trim();
    return name.replace(/-t\d+$/, "");
  }

  /** Get fleet status as markdown text (shared by TG + DC) */
  async getStatusText(): Promise<string> {
    if (!this.ctx.fleetConfig) return "No fleet config loaded.";

    const rows: string[] = [];
    let pausedCount = 0;
    const fleetNames = new Set(Object.keys(this.ctx.fleetConfig.instances));
    const instances = [
      ...Object.keys(this.ctx.fleetConfig.instances).map(name => ({ name, classic: false })),
      ...(this.ctx.classicChannels?.getAll() ?? [])
        .filter(ch => !fleetNames.has(ch.instanceName))
        .map(ch => ({ name: ch.instanceName, classic: true })),
    ];

    for (const { name, classic } of instances) {
      const status = this.ctx.getInstanceStatus(name);
      const executionState = status === "paused" ? "paused"
        : status === "running" ? this.ctx.getInstanceExecutionState?.(name) ?? null
          : null;
      const costPaused = this.ctx.costGuard?.isLimited(name);
      if (status === "paused") pausedCount++;

      const backend = classic
        ? this.ctx.classicChannels?.getBackendByInstance(name, this.ctx.fleetConfig.defaults?.backend) ?? "-"
        : this.ctx.fleetConfig.instances[name]?.backend ?? this.ctx.fleetConfig.defaults?.backend ?? "-";
      // Same source as /ctx (statusline for claude-code, pane scrape otherwise).
      // Without this, kiro/grok/codex always showed "-" in the Ctx column.
      const { context } = backend === "-"
        ? { context: null as number | null }
        : resolveInstanceContext(this.ctx.dataDir, name, backend);
      const contextStr = context == null ? "-" : `${Math.round(context)}%`;

      const costCents = this.ctx.costGuard?.getDailyCostCents(name) ?? 0;

      let icon: string;
      if (costPaused || status === "paused") icon = "⏸";
      else if (status === "running") icon = "🟢";
      else if (status === "crashed") icon = "🔴";
      else icon = "⚪";

      const stateLabel = executionState === "idle" ? "🟢 idle"
        : executionState === "working" ? "🔵 working"
          : executionState === "stuck" ? "🔴 stuck"
            : executionState === "paused" ? "⏸ paused"
              : "—";
      const displayName = this.shortInstanceName(name);
      // IPC reachability moved here from /sysinfo: it is per-instance health, and
      // /status is now the one place that shows the fleet per instance.
      const ipc = this.ctx.instanceIpcClients.has(name) ? "✓" : "✗";
      // "-" distinguishes "backend has no effort setting" from an unset one:
      // an empty cell would read as missing data rather than not-applicable.
      const effort = this.ctx.resolveInstanceEffort?.(name).effort ?? "-";
      rows.push(`| ${displayName} | ${backend} | ${contextStr} | ${effort} | ${formatCents(costCents)} | ${icon} | ${stateLabel} | ${ipc} |`);
    }

    if (rows.length === 0) return "No instances configured.";

    const lines = [
      "## Fleet Status",
      "",
      "| Instance | Backend | Ctx | Effort | Cost | Status | State | IPC |",
      "|----------|---------|-----|--------|------|--------|-------|-----|",
      ...rows,
      "",
      `Paused instances: ${pausedCount}`,
    ];

    const limitCents = this.ctx.costGuard?.getLimitCents() ?? 0;
    const totalCents = this.ctx.costGuard?.getFleetTotalCents() ?? 0;
    if (limitCents > 0) {
      lines.push("", `Fleet: ${formatCents(totalCents)} / ${formatCents(limitCents)} daily`);
    }

    // Adapter states (only show if any are not connected)
    const adapterStates = this.ctx.getAdapterStates?.();
    if (adapterStates && adapterStates.size > 0) {
      const issues = [...adapterStates.entries()].filter(([, s]) => s.status !== "connected");
      if (issues.length > 0) {
        lines.push("", "**Adapters:**");
        for (const [id, s] of adapterStates) {
          const icon = s.status === "connected" ? "✅" : s.status === "retrying" ? "🔄" : "❌";
          lines.push(`  ${icon} ${id}: ${s.status}${s.lastError ? ` (${s.lastError.slice(0, 60)})` : ""}`);
        }
      }
    }

    return lines.join("\n");
  }

  private async handleSysInfoCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const text = this.getSysInfoText();
    await adapter.sendText(msg.chatId, text, { threadId: msg.threadId });
  }

  /**
   * Get system info as markdown text (shared by TG + DC).
   *
   * System-level only. The per-instance table (state/IPC/cost) moved to /status,
   * which was already the fleet-per-instance view — the two tables overlapped on
   * everything but the IPC column, and each command answered half of "is the
   * machine fine and are the instances fine".
   */
  getSysInfoText(): string {
    const info = this.ctx.getSysInfo();
    const upHours = Math.floor(info.uptime_seconds / 3600);
    const upMins = Math.floor((info.uptime_seconds % 3600) / 60);
    const require = createRequire(import.meta.url);
    const agendVersion = require("../package.json").version ?? "unknown";

    return [
      "## System Info",
      "",
      "| Metric | Value |",
      "|--------|-------|",
      `| AgEnD | v${agendVersion} |`,
      `| OS | ${process.platform} ${osRelease()} (${process.arch}) |`,
      `| Node | ${process.version} |`,
      `| tmux | ${tmuxVersion()} |`,
      `| Uptime | ${upHours}h ${upMins}m |`,
      `| Memory | ${info.memory_mb.rss} MB RSS |`,
      `| Heap | ${info.memory_mb.heapUsed} / ${info.memory_mb.heapTotal} MB |`,
    ].join("\n");
  }

  private async handleUpdateCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    // Access control — only allowed users can trigger update; empty = disabled
    const allowed = this.ctx.fleetConfig?.channel?.access?.allowed_users ?? [];
    if (allowed.length === 0) {
      await adapter.sendText(chatId, t("update.disabled"), { threadId });
      return;
    }
    if (!allowed.some(u => String(u) === String(msg.userId))) {
      await adapter.sendText(chatId, t("not_authorized"), { threadId });
      return;
    }

    const sent = await adapter.sendText(chatId, t("update.progress.preparing", 0), { threadId });
    this.ctx.beginUpdateProgress?.(adapter, chatId, threadId, sent.messageId);

    const currentVersion: string = createRequire(import.meta.url)("../package.json").version ?? "";
    const updateCmd = currentVersion.includes("beta") ? "agend update --beta" : "agend update";
    const { spawn } = await import("node:child_process");
    const child = spawn("sh", ["-c", `sleep 2 && ${updateCmd}`], { detached: true, stdio: "ignore" });
    child.once("error", err => this.ctx.failUpdateProgress?.(err.message));
    child.unref();
  }

  private async handleDoctorCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    const allowed = this.ctx.fleetConfig?.channel?.access?.allowed_users ?? [];
    if (allowed.length > 0 && !allowed.some(u => String(u) === String(msg.userId))) {
      await adapter.sendText(chatId, t("not_authorized"), { threadId });
      return;
    }

    await adapter.sendText(chatId, t("doctor.running"), { threadId });
    // Async, and execFile rather than a shell string: as execSync this froze the
    // whole fleet event loop for up to 30s — no IPC, no delivery, no WATCHDOG
    // ping — and any allowlisted user could trigger it with /doctor.
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const backend = this.ctx.fleetConfig?.defaults?.backend || "claude-code";
    let output: string;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("agend", ["backend", "doctor", backend], {
        timeout: 30_000,
        encoding: "utf-8",
      });
      output = stripAnsi(stdout) || "No output";
    } catch (err) {
      const e = err as { stdout?: string; message?: string };
      output = stripAnsi(e.stdout ?? e.message ?? "Doctor failed");
    }
    await adapter.sendText(chatId, output, { threadId });
  }

  /** Reply with redirect when message arrives in an unbound topic */
  async handleUnboundTopic(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    await adapter.sendText(
      msg.chatId,
      "This topic is not bound to an instance. Ask the General assistant to create one with create_instance.",
      { threadId: msg.threadId },
    );
  }

  /** Handle topic deletion — stop daemon and remove from config */
  async handleTopicDeleted(threadId: string): Promise<void> {
    const target = this.ctx.routingTable.get(threadId);
    if (!target) return;
    if (target.kind === "general") {
      this.ctx.logger.debug({ instanceName: target.name, threadId }, "Ignoring delete event for General topic");
      return;
    }

    this.ctx.logger.info({ instanceName: target.name, threadId }, "Topic deleted — auto-unbinding");
    await this.ctx.removeInstance(target.name);
  }

  /** Create instance config, save fleet.yaml, start daemon, connect IPC. */
  async bindAndStart(dirPath: string, topicId: number | string): Promise<string> {
    if (!this.ctx.fleetConfig) throw new Error("Fleet config not loaded");

    const instanceName = `${sanitizeInstanceName(basename(dirPath))}-t${topicId}`;

    this.ctx.fleetConfig.instances[instanceName] = {
      working_directory: dirPath,
      topic_id: topicId,
      restart_policy: this.ctx.fleetConfig.defaults.restart_policy ?? DEFAULT_INSTANCE_CONFIG.restart_policy,
      context_guardian: this.ctx.fleetConfig.defaults.context_guardian ?? DEFAULT_INSTANCE_CONFIG.context_guardian,
      log_level: this.ctx.fleetConfig.defaults.log_level ?? DEFAULT_INSTANCE_CONFIG.log_level,
    };

    this.ctx.saveFleetConfig();
    this.ctx.routingTable.set(String(topicId), { kind: "instance", name: instanceName });

    // startInstance awaits lifecycle.start → daemon.start (IPC listening) →
    // connectIpcToInstance. By the time it resolves, IPC is already wired —
    // the previous code's 5s sleep + second connect was leftover paranoia.
    await this.ctx.startInstance(instanceName, this.ctx.fleetConfig.instances[instanceName], true);

    this.ctx.logger.info({ instanceName, topicId }, "Topic bound and started");
    return instanceName;
  }

  /** Create Telegram topics for instances that don't have topic_id */
  async autoCreateTopics(): Promise<void> {
    if (!this.ctx.fleetConfig?.channel?.group_id) return;
    const botToken = process.env[this.ctx.fleetConfig.channel.bot_token_env];
    if (!botToken) return;

    let configChanged = false;
    for (const [name, config] of Object.entries(this.ctx.fleetConfig.instances)) {
      if (config.topic_id != null) continue;

      // General topic: determine platform type from channel_id → channels config
      if (config.general_topic) {
        const channels = this.ctx.fleetConfig?.channels ?? (this.ctx.fleetConfig?.channel ? [this.ctx.fleetConfig.channel] : []);
        let platformType: string | undefined;
        if ((config as any).channel_id) {
          const matched = channels.find(c => (c.id ?? c.type) === (config as any).channel_id);
          platformType = matched?.type;
        }
        if (!platformType) {
          if (name.includes("telegram")) platformType = "telegram";
          else if (name.includes("discord")) platformType = "discord";
        }
        if (platformType === "discord") {
          const ch = channels.find(c => c.type === "discord");
          const gcid = ch?.options?.general_channel_id as string | number | undefined;
          // A Discord general needs a real channel id — NOT the TG-convention
          // "1", which makes the DC adapter throw fetching channel "1". Skip
          // (leave unbound) if there's no valid channel to bind to.
          if (gcid == null || !/^\d{17,}$/.test(String(gcid))) {
            this.ctx.logger.warn({ name }, "Discord general has no valid general_channel_id — skipping topic bind (set channel.options.general_channel_id)");
            continue;
          }
          config.topic_id = gcid;
        } else {
          config.topic_id = 1;
        }
        configChanged = true;
        this.ctx.logger.info({ name, topicId: config.topic_id, platformType }, "Bound to General topic");
        continue;
      }

      try {
        const topicName = basename(config.working_directory);
        const threadId = await this.ctx.createForumTopic(topicName);
        config.topic_id = threadId;
        configChanged = true;
        this.ctx.logger.info({ name, topicId: config.topic_id, topicName }, "Auto-created Telegram topic");
      } catch (err) {
        this.ctx.logger.warn({ name, err }, "Failed to auto-create topic");
      }
    }

    if (configChanged) {
      this.ctx.saveFleetConfig();
    }
  }

  /** Register bot commands in Telegram command menu */
  async registerBotCommands(): Promise<void> {
    // Register bot commands for all Telegram adapters (channels[] support)
    const channels = this.ctx.fleetConfig?.channels ?? (this.ctx.fleetConfig?.channel ? [this.ctx.fleetConfig.channel] : []);
    const telegramChannels = channels.filter(ch => ch.type === "telegram");
    if (telegramChannels.length === 0) return;

    for (const ch of telegramChannels) {
      const botToken = process.env[ch.bot_token_env];
      if (!botToken || !ch.group_id) {
        this.ctx.logger.warn({
          adapterId: ch.id ?? ch.type,
          hasBotToken: !!botToken,
          hasGroupId: !!ch.group_id,
        }, "Skipping Telegram bot-command registration — token or group_id is missing");
        continue;
      }

      try {
        const fleetCommands = [
          { command: "status", description: "🔒 Fleet status, per-instance costs and health" },
          { command: "sysinfo", description: "System diagnostics" },
          { command: "dashboard", description: "🔒 Get dashboard URLs" },
          { command: "ctx", description: "Show context usage" },
          { command: "compact", description: "Compact agent context" },
          { command: "steer", description: "Interject into the current task" },
          { command: "btw", description: "Ask a side question without interrupting" },
          { command: "clear", description: "🔒 Clear agent conversation context" },
          { command: "model", description: "🔒 Switch model (admin only)" },
          { command: "effort", description: "🔒 Set reasoning effort (admin only)" },
          { command: "pause", description: "🔒 Pause an idle instance" },
          { command: "wake", description: "🔒 Wake a paused instance" },
          { command: "restart", description: "🔒 Graceful restart all instances" },
          { command: "collab", description: "🔒 Toggle bot/webhook mode" },
          { command: "update", description: "🔒 Update AgEnD to latest" },
          { command: "doctor", description: "🔒 Run health diagnostics" },
          { command: "usage", description: "AI subscription usage" },
          { command: "tips", description: "Show a useful AgEnD tip" },
        ];

        const setCommands = async (
          commands: Array<{ command: string; description: string }>,
          scope: Record<string, string | number>,
        ): Promise<void> => {
          const response = await fetch(
            `https://api.telegram.org/bot${botToken}/setMyCommands`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ commands, scope }),
            },
          );
          type TelegramApiResponse = { ok?: boolean; result?: boolean; description?: string };
          let result: TelegramApiResponse | null = null;
          try {
            result = await response.json() as TelegramApiResponse;
          } catch { /* handled by the validation below */ }
          // fetch() resolves on Telegram 4xx/5xx. Without checking both layers we
          // logged a successful registration while Telegram kept the old (often
          // four-command) menu indefinitely.
          if (!response.ok || result?.ok !== true || result.result !== true) {
            throw new Error(
              `Telegram setMyCommands failed (${response.status}): ${result?.description ?? "invalid Bot API response"}`,
            );
          }
        };

        const classicCommands = [
          { command: "start", description: "🔒 Start an agent in this chat" },
          { command: "stop", description: "🔒 Stop the agent" },
          { command: "compact", description: "🔒 Compact agent context" },
          { command: "steer", description: "Interject into the current task" },
          { command: "btw", description: "Ask a side question without interrupting" },
          { command: "clear", description: "🔒 Clear agent conversation context" },
          { command: "model", description: "🔒 Switch model (admin only)" },
          { command: "effort", description: "🔒 Set reasoning effort (admin only)" },
          { command: "pause", description: "🔒 Pause the agent" },
          { command: "wake", description: "🔒 Wake the agent" },
          { command: "ctx", description: "Show context usage" },
        ];

        // A chat_administrators scope has higher precedence than the chat scope.
        // Keep both synchronized so a stale admin-only list from BotFather or an
        // older deployment cannot hide newly added commands from fleet admins.
        // Try every scope even if one fails: a bad fleet chat id must not prevent
        // the default Classic menu from being refreshed (or vice versa).
        const registrations: Array<{
          commands: Array<{ command: string; description: string }>;
          scope: Record<string, string | number>;
        }> = [
          { commands: fleetCommands, scope: { type: "chat", chat_id: ch.group_id } },
          { commands: fleetCommands, scope: { type: "chat_administrators", chat_id: ch.group_id } },
          { commands: classicCommands, scope: { type: "default" } },
        ];
        const failures: Error[] = [];
        for (const registration of registrations) {
          try {
            await setCommands(registration.commands, registration.scope);
          } catch (err) {
            failures.push(err instanceof Error ? err : new Error(String(err)));
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, failures.map(error => error.message).join("; "));
        }

        this.ctx.logger.info({
          adapterId: ch.id ?? ch.type,
          fleetCommandCount: fleetCommands.length,
        }, "Registered Telegram bot commands for fleet chat/admin and Classic default scopes");
      } catch (err) {
        this.ctx.logger.warn({ err, adapterId: ch.id ?? ch.type }, "Failed to register bot commands (non-fatal)");
      }
    }
  }
}
