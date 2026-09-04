import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, copyFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { getAgendHome } from "./paths.js";
import { sanitizeInstanceName } from "./topic-commands.js";
import type { Logger } from "./logger.js";
import { KNOWN_BACKENDS } from "./config-validator.js";
import type { Choice } from "./channel/types.js";


/** Last real channel activity recorded in a ClassicBot chat log. */
export function readClassicLastActivityAt(dataDir: string, instanceName: string): number | null {
  const logDir = join(dataDir, "workspaces", instanceName, "chat-logs");
  try {
    let latest = 0;
    for (const file of readdirSync(logDir)) {
      if (!file.endsWith(".log")) continue;
      try { latest = Math.max(latest, statSync(join(logDir, file)).mtimeMs); } catch { /* skip unreadable log */ }
    }
    return latest || null;
  } catch {
    return null;
  }
}

/** Backends offered by ClassicBot onboarding. `mock` is test-only. */
export function getClassicBackendChoices(): Choice[] {
  return KNOWN_BACKENDS
    .filter(backend => backend !== "mock" && backend !== "gemini-cli")
    .map(backend => ({ id: backend, label: backend }));
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
  displayName?: string;
  description?: string;
  autoPauseAfter?: number;
  collab?: boolean;
  preTaskCommand?: string;
  contextLines?: number;
  createdAt: string;
  createdBy: string;
}

interface ClassicBotYaml {
  defaults?: { backend?: string; model?: string; auto_pause_after?: number; context_lines?: number; allowed_guilds?: string[]; admin_users?: string[]; allowed_groups?: string[]; allowed_users?: string[] };
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
    display_name?: string;
    description?: string;
    auto_pause_after?: number;
    context_lines?: number;
    collab?: boolean;
    pre_task_command?: string;
    createdBy?: string;
    createdAt?: string;
  }>;
}

interface ClassicAdapterIdentity {
  id: string;
  type: string;
}

interface LoadedClassicChannel {
  channel: ClassicChannel;
  /** The adapter persisted in YAML. Undefined means pre-multi-bot legacy data. */
  persistedAdapterId?: string;
  /** Platform inferred from the externally assigned chat/channel id. */
  inferredType?: "telegram" | "discord";
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
 * Infer the platform which issued a Classic channel id.
 *
 * Telegram group ids are negative. Telegram private-chat ids are positive but
 * fit in 52 bits (at most 16 decimal digits), while Discord snowflakes are
 * currently 17-20 decimal digits. Anything else is deliberately left unknown
 * so custom/future adapters retain the backwards-compatible primary fallback.
 */
export function inferClassicChannelType(channelId: string): "telegram" | "discord" | undefined {
  const value = channelId.trim();
  if (!/^-?\d+$/.test(value)) return undefined;
  if (value.startsWith("-")) return "telegram";
  if (value.length >= 17 && value.length <= 20) return "discord";
  if (value.length >= 1 && value.length <= 16) return "telegram";
  return undefined;
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
  private defaults: { backend?: string; model?: string; auto_pause_after?: number; context_lines?: number; allowed_guilds?: string[]; admin_users?: string[]; allowed_groups?: string[]; allowed_users?: string[] } = {};
  private readonly configPath: string;
  private lastMtime = 0;
  /** The primary (channels[0]) adapter id. It names without a suffix. */
  private primaryAdapterId?: string;
  /** Config-order adapter identities, used to migrate legacy rows by platform. */
  private adapters: ClassicAdapterIdentity[] = [];

  constructor(private dataDir: string, private logger: Logger) {
    this.configPath = join(dataDir, "classicBot.yaml");
    this.load();
  }

  /**
   * Backwards-compatible single-adapter configuration used by tests and older
   * callers. Production startup supplies the complete adapter list through
   * {@link configureAdapters} so legacy rows can be matched by platform.
   */
  setPrimaryAdapterId(adapterId: string): void {
    this.configureAdapters([{ id: adapterId, type: adapterId }]);
  }

  /**
   * Configure all adapters in fleet.yaml order, then migrate/repair persisted
   * Classic registrations. The full list matters when the primary adapter is
   * a different platform from a legacy channel.
   */
  configureAdapters(adapters: ReadonlyArray<{ id?: string; type: string }>): void {
    const identities = adapters.map(adapter => ({ id: adapter.id ?? adapter.type, type: adapter.type }));
    const primaryAdapterId = identities[0]?.id;
    const unchanged = this.primaryAdapterId === primaryAdapterId
      && this.adapters.length === identities.length
      && this.adapters.every((adapter, index) => adapter.id === identities[index]?.id && adapter.type === identities[index]?.type);
    if (unchanged) return;

    this.primaryAdapterId = primaryAdapterId;
    this.adapters = identities;
    const repaired = this.load();
    if (repaired && this.backupBeforeAdapterRepair()) this.save();
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
      const legacy = this.channels.get(this.compositeKey(channelId, undefined));
      if (!legacy) return undefined;
      const inferredType = inferClassicChannelType(channelId);
      const primaryType = this.adapterType(adapterId);
      // A known cross-platform legacy row must wait for its owning adapter to
      // return; never expose it to the current primary merely as a fallback.
      if (inferredType && primaryType && inferredType !== primaryType) return undefined;
      return legacy;
    }
    return undefined;
  }

  /** Type of a configured adapter id, including historical default ids. */
  private adapterType(adapterId: string | undefined): string | undefined {
    if (!adapterId) return undefined;
    return this.adapters.find(adapter => adapter.id === adapterId)?.type
      ?? (adapterId === "telegram" || adapterId === "discord" ? adapterId : undefined);
  }

  /** Deterministically choose the first configured adapter for a platform. */
  private adapterForType(type: string | undefined): string | undefined {
    if (!type) return undefined;
    const primary = this.adapters.find(adapter => adapter.id === this.primaryAdapterId);
    if (primary?.type === type) return primary.id;
    return this.adapters.find(adapter => adapter.type === type)?.id;
  }

  /** Preserve the pre-repair file once; instance/workspace data is never deleted. */
  private backupBeforeAdapterRepair(): boolean {
    const backupPath = `${this.configPath}.pre-adapter-repair.bak`;
    if (existsSync(backupPath) || !existsSync(this.configPath)) return true;
    try {
      copyFileSync(this.configPath, backupPath);
      return true;
    } catch (err) {
      this.logger.warn({ err, backupPath }, "Failed to back up classicBot.yaml before adapter repair");
      return false;
    }
  }

  /**
   * Load the persisted registry. Returns true when it migrated/repaired data
   * and the caller should write the normalized registry back to disk.
   */
  private load(): boolean {
    if (!existsSync(this.configPath)) return false;
    try {
      const raw = yaml.load(readFileSync(this.configPath, "utf-8")) as ClassicBotYaml | null;
      if (!raw) return false;
      this.defaults = raw.defaults ?? {};
      this.channels.clear();
      let repaired = false;
      if (raw.channels) {
        const loaded: LoadedClassicChannel[] = [];
        for (const [key, val] of Object.entries(raw.channels)) {
          // Old format: key IS the channelId, no adapterId/instanceName fields.
          const channelId = val.channelId ?? key;
          const inferredType = inferClassicChannelType(channelId);
          const inferredAdapterId = this.adapterForType(inferredType);
          // Prefer the adapter whose platform issued the id. Unknown/custom ids
          // retain the historical primary fallback.
          const adapterId = val.adapterId
            ?? (inferredType ? inferredAdapterId : this.primaryAdapterId);
          const name = val.name ?? channelId;
          // An explicit non-primary registration carries a suffix. A legacy
          // registration always keeps its historical unsuffixed instance name
          // even when platform inference moves it away from channels[0].
          const suffixAdapter = val.adapterId && adapterId !== this.primaryAdapterId ? adapterId : undefined;
          const instanceName = val.instanceName ?? classicInstanceName(sanitizeInstanceName(name), channelId, suffixAdapter);
          loaded.push({
            persistedAdapterId: val.adapterId,
            inferredType,
            channel: {
              channelId,
              adapterId,
              name,
              instanceName,
              backend: val.backend,
              model: val.model,
              displayName: val.display_name,
              description: val.description,
              autoPauseAfter: val.auto_pause_after,
              collab: val.collab,
              preTaskCommand: val.pre_task_command,
              contextLines: val.context_lines,
              createdAt: val.createdAt ?? "",
              createdBy: val.createdBy ?? "",
            },
          });
        }

        for (const entry of loaded) {
          const { channel, persistedAdapterId, inferredType } = entry;
          const inferredAdapterId = this.adapterForType(inferredType);
          const persistedType = this.adapterType(persistedAdapterId);
          const isLegacy = persistedAdapterId === undefined;
          const isCrossPlatformMisbind = !!(
            persistedAdapterId
            && inferredType
            && inferredAdapterId
            && persistedType
            && persistedType !== inferredType
          );

          if (isLegacy && channel.adapterId) {
            repaired = true;
            this.logger.warn(
              { channelId: channel.channelId, adapterId: channel.adapterId, instanceName: channel.instanceName, inferredType },
              "Migrated legacy Classic channel to inferred adapter",
            );
          }
          if (isLegacy && inferredType && !channel.adapterId) {
            this.logger.warn(
              { channelId: channel.channelId, inferredType, instanceName: channel.instanceName },
              "Classic legacy channel has no configured adapter for its platform; leaving it unbound",
            );
          }

          if (isCrossPlatformMisbind) {
            const correctlyBound = loaded.filter(candidate =>
              candidate !== entry
              && candidate.channel.channelId === channel.channelId
              && candidate.persistedAdapterId !== undefined
              && this.adapterType(candidate.persistedAdapterId) === inferredType,
            );
            if (correctlyBound.length > 0) {
              // A post-migration /start already created the right registration.
              // Keep the live/correct target, drop only the phantom registry row;
              // its instance/workspace remains on disk for manual recovery.
              repaired = true;
              this.logger.warn({
                channelId: channel.channelId,
                staleAdapterId: persistedAdapterId,
                staleInstanceName: channel.instanceName,
                activeAdapters: correctlyBound.map(candidate => candidate.persistedAdapterId),
                activeInstances: correctlyBound.map(candidate => candidate.channel.instanceName),
              }, "Removed phantom Classic channel registration; instance data retained on disk");
              continue;
            }

            channel.adapterId = inferredAdapterId;
            repaired = true;
            this.logger.warn({
              channelId: channel.channelId,
              fromAdapterId: persistedAdapterId,
              toAdapterId: inferredAdapterId,
              instanceName: channel.instanceName,
            }, "Repaired cross-platform Classic channel adapter binding");
          }

          const mapKey = this.compositeKey(channel.channelId, channel.adapterId);
          const existing = this.channels.get(mapKey);
          if (existing) {
            // Malformed/hand-edited duplicates: prefer the already normalized
            // explicit row and keep all instance data on disk.
            repaired = true;
            this.logger.warn({
              channelId: channel.channelId,
              adapterId: channel.adapterId,
              keptInstanceName: existing.instanceName,
              ignoredInstanceName: channel.instanceName,
            }, "Ignored duplicate Classic channel registration; instance data retained on disk");
            continue;
          }
          this.channels.set(mapKey, channel);
        }
      }
      this.rebuildChannelIds();
      this.lastMtime = statSync(this.configPath).mtimeMs;
      this.logger.info({ count: this.channels.size }, "Loaded classic channels");
      return repaired;
    } catch (err) {
      this.logger.warn({ err }, "Failed to load classicBot.yaml");
      return false;
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
      if (ch.displayName) entry.display_name = ch.displayName;
      if (ch.description) entry.description = ch.description;
      if (ch.autoPauseAfter !== undefined) entry.auto_pause_after = ch.autoPauseAfter;
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
    const repaired = this.load();
    if (repaired && this.backupBeforeAdapterRepair()) this.save();
    return true;
  }

  /** Reload immediately after an authenticated settings write. */
  reloadFromDisk(): void {
    const repaired = this.load();
    if (repaired && this.backupBeforeAdapterRepair()) this.save();
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
    return !!list && list.length > 0 && list.some(id => String(id) === String(userId));
  }

  /**
   * Grant access to a Discord guild / Telegram group, or promote a user to
   * ClassicBot admin, and persist. Returns what happened so the caller can say
   * so rather than claiming a change that did not occur.
   *
   * Ids are stored with String(): a Discord snowflake exceeds 2^53 and silently
   * loses precision as a YAML integer, after which the strict `includes()` in
   * the isAllowed checks stops matching it.
   *
   * "already-open" is not a no-op for tidiness — it is a guard. An empty
   * allowed_guilds/allowed_groups means allow-all, so writing the FIRST entry
   * would flip the fleet to an allow-list and lock out every other guild that
   * works today. The caller asked to allow this one, not to restrict the rest.
   */
  private grantTo(
    field: "allowed_guilds" | "allowed_groups" | "admin_users",
    id: string,
  ): "added" | "already" | "already-open" {
    const value = String(id);
    const list = this.defaults[field];
    // admin_users has no allow-all semantics: empty means nobody is admin.
    if (field !== "admin_users" && (!Array.isArray(list) || list.length === 0)) return "already-open";
    if (Array.isArray(list) && list.some(x => String(x) === value)) return "already";
    this.defaults[field] = [...(Array.isArray(list) ? list.map(String) : []), value];
    this.save();
    return "added";
  }

  /** Allow a Discord guild to use ClassicBot. */
  allowGuild(guildId: string): "added" | "already" | "already-open" {
    return this.grantTo("allowed_guilds", guildId);
  }

  /** Allow a Telegram group to use ClassicBot. */
  allowGroup(groupId: string): "added" | "already" | "already-open" {
    return this.grantTo("allowed_groups", groupId);
  }

  /** Promote a user to ClassicBot admin (start/stop/model on classic channels). */
  addAdminUser(userId: string): "added" | "already" | "already-open" {
    return this.grantTo("admin_users", userId);
  }

  /** Set the model override for the channel owning `instanceName` and persist. Returns true if found. */
  setModelByInstance(instanceName: string, model: string): boolean {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) { ch.model = model; this.save(); return true; }
    }
    return false;
  }

  /** Persist agent-selected identity for a Classic instance. */
  setDisplayNameByInstance(instanceName: string, displayName: string): boolean {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) {
        ch.displayName = displayName;
        this.save();
        return true;
      }
    }
    return false;
  }

  /** Persist agent-selected role/description for a Classic instance. */
  setDescriptionByInstance(instanceName: string, description: string): boolean {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) {
        ch.description = description;
        this.save();
        return true;
      }
    }
    return false;
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

  /** Auto-pause fallback: per-channel → Classic defaults → fleet default. */
  getAutoPauseAfter(channelId: string, adapterId?: string, fleetDefault?: number): number | undefined {
    const ch = this.find(channelId, adapterId);
    return ch?.autoPauseAfter ?? this.defaults.auto_pause_after ?? fleetDefault;
  }

  getAutoPauseAfterByInstance(instanceName: string, fleetDefault?: number): number | undefined {
    for (const ch of this.channels.values()) {
      if (ch.instanceName === instanceName) return this.getAutoPauseAfter(ch.channelId, ch.adapterId, fleetDefault);
    }
    return this.defaults.auto_pause_after ?? fleetDefault;
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
