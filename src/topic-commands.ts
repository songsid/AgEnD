import { readFileSync, existsSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const execAsync = promisify(exec);
import type { FleetContext } from "./fleet-context.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { formatCents } from "./cost-guard.js";
import { detectPlatform } from "./service-installer.js";
import { getAgendHome } from "./paths.js";
import { t } from "./locale.js";

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

/** Allowed filename for /save and /load (no path separators, no shell/inject chars). */
export const SAVE_FILENAME_RE = /^[\w.-]+$/;

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

/**
 * The in-session compact/context-reset command for a backend NAME (the fleet
 * process routes /compact via IPC and only has the backend string, not a
 * CliBackend instance). Keep in sync with each backend's getCompactCommand().
 * Most CLIs (claude-code, kiro-cli, codex, opencode, gemini-cli) use "/compact".
 * Antigravity (agy) has NO summarizing compact — its only manual context-reset
 * is "/clear" (a full reset; it also auto-summarizes at a token threshold).
 */
export function compactCommandForBackend(backend: string): string {
  if (backend === "antigravity") return "/clear";
  return "/compact";
}

/**
 * Extract context-usage % from a captured CLI pane. Scans bottom-up so the
 * MOST RECENT prompt wins (a captured scrollback may hold several). Covers the
 * common CLI prompt formats:
 *   kiro-cli classic:  "6% !>"        kiro-cli TUI: "◔ 6%"
 *   bracketed:         "[6%]"         claude/others prompt: "6% ❯" / "6% >"
 *   codex TUI footer:  "Context 94% left" (remaining) or "Context 6% used"
 *   opencode footer:   "1.2K (6%)"   (token count then parenthesized %)
 * All values returned are context USED (low % = fresh session); codex's
 * "N% left" is remaining, so it's inverted to 100 - N.
 */
export function parseContextPercent(pane: string): number | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // codex "context-remaining" item shows "Context N% left" (REMAINING) → used = 100 - N
    const left = line.match(/Context\s+(\d+)%\s+left/i);
    if (left) return 100 - parseInt(left[1], 10);
    const m = line.match(/(\d+)%.*[!❯>]/)
      || line.match(/◔\s*(\d+)%/)
      || line.match(/\[(\d+)%\]/)
      || line.match(/Context\s+(\d+)%\s+used/i)               // codex "context-used" variant
      || line.match(/\d+(?:\.\d+)?[KM]?\s*\((\d+)%\)/);        // opencode "1.2K (6%)"
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

export class TopicCommands {
  constructor(private ctx: FleetContext) {}

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
    let token = "";
    try { token = readFileSync(join(getAgendHome(), "web.token"), "utf-8").trim(); } catch { /* not started yet */ }
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

    if (text === "/compact" || text.startsWith("/compact@")) {
      const adapter = this.getReplyAdapter(msg);
      if (!adapter) return false;
      const result = await this.sendCompact(instanceName);
      await adapter.sendText(msg.chatId, result, { threadId: msg.threadId });
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

  /** Get context usage text for an instance (shared by TG + DC) */
  async getCtxText(instanceName: string): Promise<string> {
    // Classic instances live in classicBot.yaml, not fleet.yaml → consult the
    // classic channel manager for those so we don't mis-report defaults.backend.
    // getBackendByInstance always returns a string (its own fallback), so only
    // use it when the instance is ACTUALLY classic — otherwise a fleet instance
    // that inherits its backend would wrongly pick up the classic default.
    const classicBackend = this.ctx.classicChannels?.getChannelIdByInstance(instanceName)
      ? this.ctx.classicChannels.getBackendByInstance(instanceName)
      : undefined;
    const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
      ?? classicBackend
      ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    let context: number | null = null;
    // Only claude-code writes statusline.json. Reading it for other backends
    // risks a stale value left over from a previous backend (e.g. after
    // switching claude-code → kiro-cli), so those go straight to capture-pane.
    if (backend === "claude-code") {
      try {
        const statusFile = join(this.ctx.dataDir, "instances", instanceName, "statusline.json");
        if (existsSync(statusFile)) {
          const d = JSON.parse(readFileSync(statusFile, "utf-8"));
          context = d.context_window?.used_percentage ?? null;
        }
      } catch { /* ignore */ }
    }
    if (context == null) {
      try {
        const { execFileSync } = await import("node:child_process");
        const { getTmuxSocketName, getTmuxSessionName } = await import("./paths.js");
        const socketName = getTmuxSocketName();
        // Include scrollback (-S -60) so a recent prompt is captured even when
        // the CLI is mid-output and the bottom of the visible pane has no prompt.
        const baseArgs = ["capture-pane", "-t", `${getTmuxSessionName()}:${instanceName}`, "-p", "-S", "-60"];
        const tmuxArgs = socketName ? ["-L", socketName, ...baseArgs] : baseArgs;
        const pane = execFileSync("tmux", tmuxArgs, { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] });
        context = parseContextPercent(pane);
      } catch { /* ignore */ }
    }
    return context != null
      ? `${t("ctx.used", context)}\n${t("ctx.backend", backend)}\n${t("ctx.instance", instanceName)}`
      : `${t("ctx.unavailable")}\n${t("ctx.backend", backend)}\n${t("ctx.instance", instanceName)}`;
  }

  /** Send the backend-appropriate compact command to an instance's tmux pane */
  async sendCompact(instanceName: string): Promise<string> {
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
        ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
      const cmd = compactCommandForBackend(backend);
      ipc.send({ type: "raw_paste", content: cmd });
      return `🗜️ Compact command sent (\`${cmd}\`).`;
    }
    return "❌ Instance not connected (IPC unavailable)";
  }

  /** Send a backend-appropriate session-save command to a fleet-topic instance. */
  async sendSave(instanceName: string, filename: string): Promise<string> {
    const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
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

  private async handleStatusCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
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
    for (const [name] of Object.entries(this.ctx.fleetConfig.instances)) {
      const status = this.ctx.getInstanceStatus(name);
      const paused = this.ctx.costGuard?.isLimited(name);

      let contextStr = "-";
      try {
        const data = JSON.parse(readFileSync(join(this.ctx.dataDir, "instances", name, "statusline.json"), "utf-8"));
        if (data.context_window?.used_percentage != null) {
          contextStr = `${Math.round(data.context_window.used_percentage)}%`;
        }
      } catch { /* file may not exist yet */ }

      const costCents = this.ctx.costGuard?.getDailyCostCents(name) ?? 0;
      const backend = this.ctx.fleetConfig.instances[name]?.backend ?? this.ctx.fleetConfig.defaults?.backend ?? "-";

      let icon: string;
      if (paused) icon = "⏸";
      else if (status === "running") icon = "🟢";
      else if (status === "crashed") icon = "🔴";
      else icon = "⚪";

      rows.push(`| ${this.shortInstanceName(name)} | ${backend} | ${contextStr} | ${formatCents(costCents)} | ${icon} |`);
    }

    if (rows.length === 0) return "No instances configured.";

    const lines = [
      "## Fleet Status",
      "",
      "| Instance | Backend | Ctx | Cost | Status |",
      "|----------|---------|-----|------|--------|",
      ...rows,
    ];

    const limitCents = this.ctx.costGuard?.getLimitCents() ?? 0;
    const totalCents = this.ctx.costGuard?.getFleetTotalCents() ?? 0;
    if (limitCents > 0) {
      lines.push("", `Fleet: ${formatCents(totalCents)} / ${formatCents(limitCents)} daily`);
    }

    return lines.join("\n");
  }

  private async handleSysInfoCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter) return;
    const text = this.getSysInfoText();
    await adapter.sendText(msg.chatId, text, { threadId: msg.threadId });
  }

  /** Get system info as markdown text (shared by TG + DC) */
  getSysInfoText(): string {
    const info = this.ctx.getSysInfo();
    const upHours = Math.floor(info.uptime_seconds / 3600);
    const upMins = Math.floor((info.uptime_seconds % 3600) / 60);
    const require = createRequire(import.meta.url);
    const agendVersion = require("../package.json").version ?? "unknown";

    const lines: string[] = [
      "## System Info",
      "",
      "| Metric | Value |",
      "|--------|-------|",
      `| AgEnD | v${agendVersion} |`,
      `| Uptime | ${upHours}h ${upMins}m |`,
      `| Memory | ${info.memory_mb.rss} MB RSS |`,
      `| Heap | ${info.memory_mb.heapUsed} / ${info.memory_mb.heapTotal} MB |`,
      "",
      "## Instances",
      "",
      "| Name | IPC | Cost | Rate |",
      "|------|-----|------|------|",
    ];

    for (const inst of info.instances) {
      const icon = inst.status === "running" ? "🟢" : inst.status === "crashed" ? "🔴" : "⚪";
      const ipc = inst.ipc ? "✓" : "✗";
      const rate = inst.rateLimits ? `5h:${inst.rateLimits.five_hour_pct}%` : "-";
      lines.push(`| ${icon} ${this.shortInstanceName(inst.name)} | ${ipc} | ${formatCents(inst.costCents)} | ${rate} |`);
    }

    if (info.fleet_cost_limit_cents > 0) {
      lines.push("", `Fleet cost: ${formatCents(info.fleet_cost_cents)} / ${formatCents(info.fleet_cost_limit_cents)} daily`);
    }

    return lines.join("\n");
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

    await adapter.sendText(chatId, t("update.running"), { threadId });

    const currentVersion: string = createRequire(import.meta.url)("../package.json").version ?? "";
    const updateCmd = currentVersion.includes("beta") ? "agend update --beta" : "agend update";
    const { spawn } = await import("node:child_process");
    const child = spawn("sh", ["-c", `sleep 2 && ${updateCmd}`], { detached: true, stdio: "ignore" });
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
    try {
      const { execSync } = await import("node:child_process");
      const backend = this.ctx.fleetConfig?.defaults?.backend || "claude-code";
      const result = execSync(`agend backend doctor ${backend}`, { timeout: 30_000, encoding: "utf-8" });
      const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      await adapter.sendText(chatId, clean || "No output", { threadId });
    } catch (err: any) {
      const output = (err.stdout ?? err.message ?? "Doctor failed").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      await adapter.sendText(chatId, output, { threadId });
    }
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
      if (!botToken || !ch.group_id) continue;

      try {
        // Register admin commands for the forum group
        await fetch(
          `https://api.telegram.org/bot${botToken}/setMyCommands`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commands: [
                { command: "status", description: "Show fleet status and costs" },
                { command: "sysinfo", description: "System diagnostics" },
                { command: "dashboard", description: "🔒 Get dashboard URLs" },
                { command: "ctx", description: "Show context usage" },
                { command: "compact", description: "Compact agent context" },
                { command: "restart", description: "🔒 Graceful restart all instances" },
                { command: "collab", description: "🔒 Toggle bot/webhook mode" },
                { command: "update", description: "🔒 Update AgEnD to latest" },
                { command: "doctor", description: "🔒 Run health diagnostics" },
              ],
              scope: { type: "chat", chat_id: ch.group_id },
            }),
          },
        );

        // Register classic bot commands for private chats and all groups
        await fetch(
          `https://api.telegram.org/bot${botToken}/setMyCommands`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              commands: [
                { command: "start", description: "🔒 Start an agent in this chat" },
                { command: "stop", description: "🔒 Stop the agent" },
                { command: "compact", description: "🔒 Compact agent context" },
                { command: "ctx", description: "Show context usage" },
              ],
              scope: { type: "default" },
            }),
          },
        );

        this.ctx.logger.info({ adapterId: ch.id ?? ch.type }, "Registered bot commands: /status (forum), /start /stop (default)");
      } catch (err) {
        this.ctx.logger.warn({ err, adapterId: ch.id ?? ch.type }, "Failed to register bot commands (non-fatal)");
      }
    }
  }
}
