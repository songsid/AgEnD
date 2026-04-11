import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { getAgendHome } from "./paths.js";
import type { Logger } from "./logger.js";

export interface ClassicChannel {
  channelId: string;
  instanceName: string;
  createdAt: string;
  createdBy: string;
}

/**
 * Manages classic bot channel lifecycle — register/unregister/persist.
 * Classic channels are Discord channels where the bot responds only to /chat commands
 * and logs all messages to daily-rotated text files.
 */
export class ClassicChannelManager {
  private channels = new Map<string, ClassicChannel>();
  private readonly registryPath: string;

  constructor(private dataDir: string, private logger: Logger) {
    this.registryPath = join(dataDir, "classic-channels.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.registryPath, "utf-8")) as ClassicChannel[];
      for (const ch of data) this.channels.set(ch.channelId, ch);
      this.logger.info({ count: this.channels.size }, "Loaded classic channels");
    } catch (err) {
      this.logger.warn({ err }, "Failed to load classic channels registry");
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify([...this.channels.values()], null, 2));
  }

  isClassicChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  get(channelId: string): ClassicChannel | undefined {
    return this.channels.get(channelId);
  }

  getAll(): ClassicChannel[] {
    return [...this.channels.values()];
  }

  register(channelId: string, instanceName: string, userId: string): ClassicChannel {
    const ch: ClassicChannel = { channelId, instanceName, createdAt: new Date().toISOString(), createdBy: userId };
    this.channels.set(channelId, ch);
    this.save();
    this.logger.info({ channelId, instanceName }, "Registered classic channel");
    return ch;
  }

  unregister(channelId: string): ClassicChannel | undefined {
    const ch = this.channels.get(channelId);
    if (!ch) return undefined;
    this.channels.delete(channelId);
    this.save();
    this.logger.info({ channelId, instanceName: ch.instanceName }, "Unregistered classic channel");
    return ch;
  }

  /** Get the chat log directory for a classic channel instance */
  static chatLogDir(instanceName: string): string {
    return join(getAgendHome(), "workspaces", instanceName, "chat-logs");
  }

  /** Append a message to the daily chat log */
  static logMessage(instanceName: string, username: string, text: string, timestamp: Date): void {
    const logDir = ClassicChannelManager.chatLogDir(instanceName);
    mkdirSync(logDir, { recursive: true });
    const dateStr = timestamp.toISOString().slice(0, 10);
    const logFile = join(logDir, `${dateStr}.log`);
    const line = `[${timestamp.toISOString()}] <${username}> ${text}\n`;
    appendFileSync(logFile, line);
  }

  /** Delete chat log files older than retentionDays */
  rotateLogs(retentionDays = 7): number {
    let deleted = 0;
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const ch of this.channels.values()) {
      const logDir = ClassicChannelManager.chatLogDir(ch.instanceName);
      if (!existsSync(logDir)) continue;
      for (const file of readdirSync(logDir)) {
        const match = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
        if (!match) continue;
        const fileDate = new Date(match[1]).getTime();
        if (fileDate < cutoff) {
          unlinkSync(join(logDir, file));
          deleted++;
        }
      }
    }
    if (deleted > 0) this.logger.info({ deleted }, "Rotated classic channel chat logs");
    return deleted;
  }
}
