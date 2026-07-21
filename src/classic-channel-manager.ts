import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { getAgendHome } from "./paths.js";
import { sanitizeInstanceName } from "./topic-commands.js";
import type { Logger } from "./logger.js";
import { KNOWN_BACKENDS } from "./config-validator.js";
import type { Choice } from "./channel/types.js";

const EXPERIMENTAL_BACKENDS = new Set(["grok"]);

/** Backends offered by ClassicBot onboarding. `mock` is test-only. */
export function getClassicBackendChoices(): Choice[] {
  return KNOWN_BACKENDS
    .filter(backend => backend !== "mock")
    .map(backend => ({
      id: backend,
      label: EXPERIMENTAL_BACKENDS.has(backend) ? `${backend} ⚠️` : backend,
    }));
}

/** Reject test-only/unknown values supplied through `/start <backend>`. */
export function isSelectableClassicBackend(backend: string | undefined): backend is string {
  return !!backend && KNOWN_BACKENDS.includes(backend) && backend !== "mock";
}

export interface ClassicChannel {
  channelId: string;
  /**
   * Which bot adapter owns this channel's agent. `undefined` only transiently
   * for legacy (pre-multi-bot) entries loaded before the primary adapter id is
   * known — {@link ClassicChannelManager.setPrimaryAdapterId} migrates those to
   * the primary. Enables same-channel multi-bot: two bots in one channel are
   * distinct entries keyed by (channelId, adapterId).
   */
  adapterId?: string;
  name: string;
  instanceName: string;
  backend?: string;
  model?: string;
  collab?: boolean;
  preTaskCommand?: string;
  contextLines?: number;
  createdAt: string;
  createdBy: string;
}

interface ClassicBotYaml {
  defaults?: { backend?: string; model?: string; context_lines?: number; allowed_guilds?: string[]; admin_users?: string[]; allowed_groups?: string[]; allowed_users?: string[] };
  channels?: Record<string, {
    // New format persists channelId/adapterId/instanceName explicitly so the
    // yaml key is just a unique id and naming never drifts. Old format omitted
    // these (key WAS the channelId) — load() migrates on read.
    channelId?: string;
    adapterId?: string;
    instanceName?: string;
    name?: string;
    backend?: string;
    model?: string;
    context_lines?: number;
    collab?: boolean;
    pre_task_command?: string;
    createdBy?: string;
    createdAt?: string;
  }>;
}

const YAML_HEADER = `# ClassicBot Configuration
# Available backends: claude-code, gemini-cli, codex, opencode, kiro-cli, antigravity, grok
`;

/**
 * Derive instance name from channel name + last 4 digits of channelId.
 * When `adapterId` is given (a non-primary bot in the same channel), append a
 * sanitized adapter suffix so two bots in one channel get distinct instance
 * names (dirs / tmux windows / IPC). The primary bot passes `undefined` to keep
 * the historical name — single-bot users see no change across the upgrade.
 */
export function classicInstanceName(sanitizedName: string, channelId: string, adapterId?: string): string {
  const suffix = channelId.slice(-4);
  const base = `classic-${sanitizedName}-${suffix}`;
  return adapterId ? `${base}-${sanitizeInstanceName(adapterId)}` : base;
}

/**
 * Manages classic bot channel lifecycle — register/unregister/persist.
 * Persists to ~/.agend/classicBot.yaml with per-channel backend override.
 * YAML keys are channelId to avoid duplicate name collisions.
 */
export class ClassicChannelManager {
  /** Keyed by compositeKey(channelId, adapterId) — see {@link ClassicChannel.adapterId}. */
  private channels = new Map<string, ClassicChannel>();
  /** Distinct channelIds across all adapters — makes hasChannel() O(1) (hot path: every inbound). */
  private channelIds = new Set<string>();
  private defaults: { backend?: string; model?: string; context_lines?: number; allowed_guilds?: string[]; admin_users?: string[]; allowed_groups?: string[]; allowed_users?: string[] } = {};
  private readonly configPath: string;
  private lastMtime = 0;
  /** The primary (channels[0]) adapter id. Legacy entries migrate to it; it also names without a suffix. */
  private primaryAdapterId?: string;

  constructor(private dataDir: string, private logger: Logger) {
    this.configPath = join(dataDir, "classicBot.yaml");
    this.load();
  }

  /**
   * Record which adapter is primary. Migrates any legacy (adapterId-less)
   * entries onto it and rewrites the file in the new format. Idempotent.
   */
  setPrimaryAdapterId(adapterId: string): void {
    if (this.primaryAdapterId === adapterId) return;
    this.primaryAdapterId = adapterId;
    const hadLegacy = [...this.channels.values()].some(ch => ch.adapterId === undefined);
    this.load();          // re-derive keys/names now that the primary id is known
    if (hadLegacy) this.save(); // persist the upgraded format once
  }

  /** Map key for a (channelId, adapterId) pair. adapterId-less = legacy entry (pre-migration). */
  private compositeKey(channelId: string, adapterId?: string): string {
    return adapterId ? `${channelId}#${adapterId}` : channelId;
  }

  /** Rebuild the channelId presence set from the entry map (call after any mutation). */
  private rebuildChannelIds(): void {
    this.channelIds = new Set([...this.channels.values()].map(ch => ch.channelId));
  }

  /**
   * Resolve the entry for a channel as seen by a specific bot. Exact
   * (channelId, adapterId) match wins; the primary adapter also matches a
   * not-yet-migrated legacy entry as a defensive fallback.
   */
  private find(channelId: string, adapterId?: string): ClassicChannel | undefined {
    const exact = this.channels.get(this.compositeKey(channelId, adapterId));
    if (exact) return exact;
    if (adapterId && adapterId === this.primaryAdapterId) {
      return this.channels.get(this.compositeKey(channelId, undefined));
    }
    return undefined;
  }

  private load(): void {
    if (!existsSync(this.configPath)) return;
    try {
      const raw = yaml.load(readFileSync(this.configPath, "utf-8")) as ClassicBotYaml | null;
      if (!raw) return;
      this.defaults = raw.defaults ?? {};
      this.channels.clear();
      if (raw.channels) {
        for (const [key, val] of Object.entries(raw.channels)) {
          // Old format: key IS the channelId, no adapterId/instanceName fields.
          const channelId = val.channelId ?? key;
          const adapterId = val.adapterId ?? this.primaryAdapterId; // migrate legacy → primary
          const name = val.name ?? channelId;
          // Non-primary adapters carry a suffix; primary/legacy keep the historical name.
          const suffixAdapter = adapterId && adapterId !== this.primaryAdapterId ? adapterId : undefined;
          const instanceName = val.instanceName ?? classicInstanceName(sanitizeInstanceName(name), channelId, suffixAdapter);
          this.channels.set(this.compositeKey(channelId, adapterId), {
            channelId,
            adapterId,
            name,
            instanceName,
            backend: val.backend,
            model: val.model,
            collab: val.collab,
            preTaskCommand: val.pre_task_command,
            contextLines: val.context_lines,
            createdAt: val.createdAt ?? "",
            createdBy: val.createdBy ?? "",
          });
        }
      }
      this.rebuildChannelIds();
      this.lastMtime = statSync(this.configPath).mtimeMs;
      this.logger.info({ count: this.channels.size }, "Loaded classic channels");
    } catch (err) {
      this.logger.warn({ err }, "Failed to load classicBot.yaml");
    }
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const obj: ClassicBotYaml = { defaults: this.defaults, channels: {} };
    for (const ch of this.channels.values()) {
      const entry: Record<string, unknown> = {
        channelId: ch.channelId,
        instanceName: ch.instanceName,
        name: ch.name,
        createdBy: ch.createdBy,
        createdAt: ch.createdAt,
      };
      if (ch.adapterId) entry.adapterId = ch.adapterId;
      if (ch.backend) entry.backend = ch.backend;
      if (ch.model) entry.model = ch.model;
      if (ch.contextLines) entry.context_lines = ch.contextLines;
      if (ch.collab) entry.collab = ch.collab;
      if (ch.preTaskCommand) entry.pre_task_command = ch.preTaskCommand;
      obj.channels![this.compositeKey(ch.channelId, ch.adapterId)] = entry as any;
    }
    writeFileSync(this.configPath, YAML_HEADER + yaml.dump(obj, { lineWidth: -1 }));
    this.lastMtime = existsSync(this.configPath) ? statSync(this.configPath).mtimeMs : 0;
  }

  /** Poll for external file changes (call periodically, e.g. every 30s) */
  checkReload(): boolean {
    if (!existsSync(this.configPath)) return false;
    const mtime = statSync(this.configPath).mtimeMs;
    if (mtime <= this.lastMtime) return false;
    this.logger.info("classicBot.yaml changed — reloading");
    this.load();
    return true;
  }

  getDefaults(): { backend?: string } { return this.defaults; }

  /** Check if a guild is allowed. Empty/unset/non-array allowed_guilds = allow all (backward compat). */
  isGuildAllowed(guildId: string): boolean {
    const list = this.defaults.allowed_guilds;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes(guildId);
  }

  /** Check if a Telegram group is allowed. Empty/unset/non-array = allow all. */
  isGroupAllowed(groupId: string): boolean {
    const list = this.defaults.allowed_groups;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes(groupId);
  }

  /** Check if a Telegram user (private chat) is allowed. Empty/unset/non-array = allow all. */
  isUserAllowed(userId: string): boolean {
    const list = this.defaults.allowed_users;
    if (!Array.isArray(list) || list.length === 0) return true;
    return list.includes(userId);
  }

  /** Check if a user is admin. Empty/unset admin_users = no admins (secure default). */
  isAdmin(userId: string): boolean {
    const list = this.defaults.admin_users;
    return !!list && list.length > 0 && list.includes(userId);
  }

  /** Toggle collab mode for a channel. Returns new state. */
  toggleCollab(channelId: string, adapterId?: string): boolean {
    const ch = this.find(channelId, adapterId);
    if (!ch) return false;
    ch.collab = !ch.collab;
    this.save();
    return ch.collab;
  }

  isCollab(channelId: string, adapterId?: string): boolean {
    return this.find(channelId, adapterId)?.collab ?? false;
  }

  getPreTaskCommand(channelId: string, adapterId?: string): string | undefined {
    return this.find(channelId, adapterId)?.preTaskCommand;
  }

  /** Context lines fallback: per-channel → defaults → 5 */
  getContextLines(channelId: string, adapterId?: string): number {
    const ch = this.find(channelId, adapterId);
    if (ch?.contextLines != null) return ch.contextLines;
    if (this.defaults.context_lines != null) return this.defaults.context_lines;
    return 5;
  }

  /** Backend fallback: per-channel → classic defaults → fleetDefault → "claude-code" */
  getBackend(channelId: string, adapterId?: string, fleetDefault?: string): string {
    const ch = this.find(channelId, adapterId);
    return ch?.backend || this.defaults.backend || fleetDefault || "claude-code";
  }

  /** Get model for a channel — channel override → defaults → fleet default */
  getModel(channelId: string, adapterId?: string, fleetDefault?: string): string | undefined {
    const ch = this.find(channelId, adapterId);
    return ch?.model || this.defaults.model || fleetDefault;
  }

  /** Get backend for an instance by name */
  getBackendByInstance(instanceName: string, fleetDefault?: string): string {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) return ch.backend || this.defaults.backend || fleetDefault || "claude-code";
    }
    return this.defaults.backend || fleetDefault || "claude-code";
  }

  getChannelIdByInstance(instanceName: string): string | undefined {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) return ch.channelId;
    }
    return undefined;
  }

  /** The bot adapter that owns an instance's channel (for restart rebind). */
  getAdapterIdByInstance(instanceName: string): string | undefined {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) return ch.adapterId;
    }
    return undefined;
  }

  /**
   * Resolve the instance a given bot should route to in a channel. Returns
   * undefined if this adapter has no agent here (e.g. a sibling same-guild bot
   * that never ran /start) — callers must NOT fall back to another bot's agent.
   */
  getInstanceByChannel(channelId: string, adapterId?: string): string | undefined {
    return this.find(channelId, adapterId)?.instanceName;
  }

  /** Instance name for a new registration, applying the primary-adapter naming rule. */
  deriveInstanceName(channelName: string, channelId: string, adapterId?: string): string {
    const suffixAdapter = adapterId && adapterId !== this.primaryAdapterId ? adapterId : undefined;
    return classicInstanceName(sanitizeInstanceName(channelName || channelId), channelId, suffixAdapter);
  }

  /** Whether ANY bot has an agent in this channel (adapter-independent). O(1). */
  hasChannel(channelId: string): boolean {
    return this.channelIds.has(channelId);
  }

  /** Exact per-bot check. adapterId omitted matches only a legacy entry. */
  isClassicChannel(channelId: string, adapterId?: string): boolean { return !!this.find(channelId, adapterId); }
  get(channelId: string, adapterId?: string): ClassicChannel | undefined { return this.find(channelId, adapterId); }
  getAll(): ClassicChannel[] { return [...this.channels.values()]; }

  register(channelId: string, adapterId: string | undefined, instanceName: string, channelName: string, userId: string, backend?: string): ClassicChannel {
    const ch: ClassicChannel = {
      channelId,
      adapterId,
      name: channelName,
      instanceName,
      ...(backend ? { backend } : {}),
      createdAt: new Date().toISOString(),
      createdBy: userId,
    };
    this.channels.set(this.compositeKey(channelId, adapterId), ch);
    this.rebuildChannelIds();
    this.save();
    this.logger.info({ channelId, adapterId, instanceName }, "Registered classic channel");
    return ch;
  }

  unregister(channelId: string, adapterId?: string): ClassicChannel | undefined {
    const ch = this.find(channelId, adapterId);
    if (!ch) return undefined;
    this.channels.delete(this.compositeKey(ch.channelId, ch.adapterId));
    this.rebuildChannelIds();
    this.save();
    this.logger.info({ channelId, adapterId: ch.adapterId, instanceName: ch.instanceName }, "Unregistered classic channel");
    return ch;
  }

  static chatLogDir(instanceName: string): string {
    return join(getAgendHome(), "workspaces", instanceName, "chat-logs");
  }

  static logMessage(instanceName: string, username: string, text: string, timestamp: Date, replyToText?: string): void {
    const logDir = ClassicChannelManager.chatLogDir(instanceName);
    mkdirSync(logDir, { recursive: true });
    const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localStr = timestamp.toLocaleString("sv-SE", { timeZone: tz, hour12: false }).replace(" ", "T");
    const dateStr = localStr.slice(0, 10);
    const logFile = join(logDir, `${dateStr}.log`);
    const replyPrefix = replyToText ? `[reply: ${replyToText.slice(0, 100)}] ` : "";
    appendFileSync(logFile, `[${localStr}] <${username}> ${replyPrefix}${text}\n`);
  }

  /** Delete chat log files older than retentionDays. Dates parsed as local to avoid UTC off-by-one. */
  rotateLogs(retentionDays = 7): number {
    let deleted = 0;
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const ch of this.channels.values()) {
      const logDir = ClassicChannelManager.chatLogDir(ch.instanceName);
      if (!existsSync(logDir)) continue;
      for (const file of readdirSync(logDir)) {
        const match = file.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
        if (!match) continue;
        const fileDate = new Date(+match[1], +match[2] - 1, +match[3]).getTime();
        if (fileDate < cutoff) { unlinkSync(join(logDir, file)); deleted++; }
      }
    }
    if (deleted > 0) this.logger.info({ deleted }, "Rotated classic channel chat logs");
    return deleted;
  }
}
