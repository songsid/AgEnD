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

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

/**
 * Extract context-usage % from a captured CLI pane. Scans bottom-up so the
 * MOST RECENT prompt wins (a captured scrollback may hold several). Covers the
 * common CLI prompt formats:
 *   kiro-cli classic:  "6% !>"        kiro-cli TUI: "◔ 6%"
 *   bracketed:         "[6%]"         claude/others prompt: "6% ❯" / "6% >"
 */
export function parseContextPercent(pane: string): number | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/(\d+)%\s*[!❯>]/) || line.match(/◔\s*(\d+)%/) || line.match(/\[(\d+)%\]/);
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

    return false;
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
        ? "🤝 Collaboration mode **ON** — bot/webhook messages to this topic will reach the agent."
        : "💬 Collaboration mode **OFF** — only user messages trigger the agent.",
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
      await adapter.sendText(msg.chatId, ok ? `🛑 已送出取消給 ${instanceName}。` : `❌ ${instanceName} 未在執行。`, { threadId: msg.threadId });
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
    const backend = this.ctx.fleetConfig?.instances[instanceName]?.backend
      ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    let context: number | null = null;
    try {
      const statusFile = join(this.ctx.dataDir, "instances", instanceName, "statusline.json");
      if (existsSync(statusFile)) {
        const d = JSON.parse(readFileSync(statusFile, "utf-8"));
        context = d.context_window?.used_percentage ?? null;
      }
    } catch { /* ignore */ }
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
      ? `📊 Context: ${context}% used\nBackend: ${backend}\nInstance: ${instanceName}`
      : `Context info not available yet.\nBackend: ${backend}\nInstance: ${instanceName}`;
  }

  /** Send /compact to an instance's tmux pane */
  async sendCompact(instanceName: string): Promise<string> {
    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc?.connected) {
      ipc.send({ type: "raw_paste", content: "/compact" });
      return "🗜️ Compact command sent.";
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
      await adapter.sendText(chatId, "⛔ Not authorized", { threadId });
      return;
    }

    await adapter.sendText(chatId, "🔄 Graceful restart — waiting for instances to idle...", { threadId });
    process.kill(process.pid, "SIGUSR2");
  }

  private async handleStatusCommand(msg: InboundMessage): Promise<void> {
    const adapter = this.getReplyAdapter(msg);
    if (!adapter || !this.ctx.fleetConfig) return;
    const text = await this.getStatusText();
    await adapter.sendText(msg.chatId, text, { threadId: msg.threadId });
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

      rows.push(`| ${name} | ${backend} | ${contextStr} | ${formatCents(costCents)} | ${icon} |`);
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
      lines.push(`| ${icon} ${inst.name} | ${ipc} | ${formatCents(inst.costCents)} | ${rate} |`);
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
      await adapter.sendText(chatId, "⛔ /update disabled — no allowed_users configured", { threadId });
      return;
    }
    if (!allowed.some(u => String(u) === String(msg.userId))) {
      await adapter.sendText(chatId, "⛔ Not authorized", { threadId });
      return;
    }

    await adapter.sendText(chatId, "📦 Updating AgEnD... Fleet will restart automatically.", { threadId });

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
      await adapter.sendText(chatId, "⛔ Not authorized", { threadId });
      return;
    }

    await adapter.sendText(chatId, "🩺 Running diagnostics...", { threadId });
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
          config.topic_id = (ch?.options?.general_channel_id as string | number) ?? 1;
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
