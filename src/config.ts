import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { unshareParsed } from "./yaml-shared-nodes.js";
import { getAgendHome, getTmuxSessionName, ensureWorkspaceGit } from "./paths.js";
import type { CostGuardConfig, HangDetectorConfig, DailySummaryConfig, FleetConfig, FleetDefaults, FleetTemplate, InstanceConfig, RawFleetConfig } from "./types.js";

export function deepMergeGeneric<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;

  for (const key of Object.keys(sourceRecord)) {
    const sourceVal = sourceRecord[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMergeGeneric(
        targetVal as object,
        sourceVal as Partial<object>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as unknown as T;
}

export function getTmuxSession(): string {
  return process.env.AGEND_TMUX_SESSION ?? getTmuxSessionName();
}

export const DEFAULT_COST_GUARD: CostGuardConfig = {
  daily_limit_usd: 0, // 0 = disabled
  warn_at_percentage: 80,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

/** #1854: matches the stuck detector's DEFAULT_STUCK_TIMEOUT_MS (src/daemon.ts, 10 min); factual-ui-1854.test.ts holds them together. */
export const DEFAULT_HANG_DETECTOR: HangDetectorConfig = {
  enabled: true,
  timeout_minutes: 10,
};

export const DEFAULT_DAILY_SUMMARY: DailySummaryConfig = {
  enabled: true,
  hour: 21,
  minute: 0,
};

/** Product-level context protection for cross-instance message bodies (12 KiB). */
export const DEFAULT_MAX_CROSS_INSTANCE_MESSAGE_BYTES = 12 * 1024;

/** Output size budget for list_instances progressive disclosure (8 KiB). */
export const DEFAULT_LIST_INSTANCES_OUTPUT_BUDGET = 8 * 1024;

/** Maximum lines for get_instance_logs to prevent context flooding. */
export const MAX_INSTANCE_LOG_LINES = 200;

export const DEFAULT_INSTANCE_CONFIG: Omit<InstanceConfig, "working_directory"> = {
  auto_pause_after: 0, // minutes; 0 = disabled (opt-in)
  mcp_auto_restart: true, // restart (idle-gated) when the MCP server dies
  mcp_proxy_reply: false, // opt-in: relaying raw pane text can leak more than regex redaction catches
  tool_progress: "off", // opt-in: the bubble tool list broadcasts activity into the channel
  reply_completion_guard: true, // detect and recover a human turn that ended without a delivered reply

  kiro_ui: "legacy",
  terminal: {
    enabled: true,
    columns: 120,
    rows: 36,
  },
  restart_policy: {
    max_retries: 10,
    backoff: "exponential",
    reset_after: 300,
  },
  // context_guardian removed from built-in defaults (#1296): context rotation is
  // gone, neither field is read, and an empty {} would propagate into fleet.yaml
  // whenever create_instance persists an instance config. Users who still have
  // max_age_hours / grace_period_ms in fleet.yaml get a validator warning.
  log_level: "info",
};

/** Effective instance defaults, including AgEnD built-ins and fleet overrides. */
export function getEffectiveInstanceDefaults(
  fleetDefaults: FleetDefaults = {},
): Partial<InstanceConfig> {
  // Fleet-only controls live under defaults for YAML ergonomics but must not
  // leak into every daemon's InstanceConfig (where an on/off toggle would look
  // like an unknown cold field and restart the whole fleet).
  //
  // Rule: strip every key that exists in FleetDefaults but NOT in InstanceConfig.
  // (cost_guard, hang_detector appear in both → keep them as instance defaults.)
  const {
    // Already stripped in the original code:
    tips: _tips,
    max_cross_instance_message_bytes: _maxCrossInstanceMessageBytes,
    // #1302: read by the fleet when it posts a notice, so changing the default never touches a daemon's config.
    cross_instance_visibility: _crossInstanceVisibility,
    // Fleet-level startup controls (concurrency, stagger_delay_ms) are read
    // directly from fleetConfig.defaults.startup by the fleet manager and must
    // NOT be merged into instance configs — they have no meaning there and cause
    // every instance to appear "changed" when defaults.startup is updated.
    startup: _startup,
    // All remaining fleet-only keys (not in InstanceConfig):
    locale: _locale,
    progress_min_elapsed: _progressMinElapsed,
    reply_overdue_minutes: _replyOverdueMinutes,
    reply_obligation_ttl_hours: _replyObligationTtlHours,
    scheduler: _scheduler,
    retention_days: _retentionDays,
    daily_summary: _dailySummary,
    webhooks: _webhooks,
    // #2246 step 3: the board's daily summary is the fleet's (task-board-summary.ts), read at every look.
    task_board: _taskBoard,
    ...instanceDefaults
  } = fleetDefaults;
  return deepMergeGeneric(
    DEFAULT_INSTANCE_CONFIG as Partial<InstanceConfig>,
    instanceDefaults,
  );
}

/** Validate IANA timezone string. Throws if invalid. */
export function validateTimezone(tz: string, field: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(`${field}: invalid timezone "${tz}". Use IANA format (e.g. Asia/Taipei)`);
  }
}

/**
 * A connection as a load gives it: `id` defaults to its `type`, `mode` to `topic`. Every channels write is judged and
 * kept in this shape too (#2211), so a key the file leaves to its default is never "changed" by being absent.
 */
export function channelWithDefaults<T extends { id?: string; type?: string; mode?: string }>(ch: T): T & { id: string | undefined; mode: NonNullable<T["mode"]> | "topic" } {
  return { ...ch, id: ch.id ?? ch.type, mode: ch.mode ?? "topic" as const };
}

export function loadFleetConfig(configPath: string): FleetConfig {
  if (!existsSync(configPath)) {
    return { defaults: {}, instances: {} };
  }

  const raw = readFileSync(configPath, "utf-8");
  // Quote bare 16+ digit integers before parsing to prevent precision loss.
  // Discord snowflakes and Telegram group IDs are 64-bit and exceed JS MAX_SAFE_INTEGER.
  const safeRaw = raw.replace(/(?<=:\s+|[-]\s+)(\d{16,})(?=\s*$)/gm, (_, d) => `"${d}"`);

  // #2208: an anchor and its aliases become separate copies, so editing one place never changes another.
  const parsed = unshareParsed(yaml.load(safeRaw), "fleet.yaml") as {
    channel?: FleetConfig["channel"];
    channels?: FleetConfig["channels"];
    project_roots?: string[];
    defaults?: FleetDefaults;
    instances?: Record<string, Partial<InstanceConfig>>;
    teams?: FleetConfig["teams"];
    templates?: Record<string, FleetTemplate>;
    profiles?: FleetConfig["profiles"];
    health_port?: number;
    web?: FleetConfig["web"];
    needs_you?: unknown;
    hostname?: string;
    fleet_label?: string;
    login?: FleetConfig["login"];
    web_terminal?: FleetConfig["web_terminal"];
  } | null;

  if (!parsed) {
    return { defaults: {}, instances: {} };
  }

  const fleetDefaults: FleetDefaults = parsed.defaults ?? {};
  const rawInstances = parsed.instances ?? {};
  const instances: Record<string, InstanceConfig> = {};

  for (const [name, overrides] of Object.entries(rawInstances)) {
    const merged = deepMergeGeneric(
      getEffectiveInstanceDefaults(fleetDefaults),
      overrides,
    ) as Partial<InstanceConfig>;

    if (!merged.working_directory) {
      const defaultDir = join(getAgendHome(), "workspaces", name);
      mkdirSync(defaultDir, { recursive: true });
      ensureWorkspaceGit(defaultDir);
      merged.working_directory = defaultDir;
    }

    instances[name] = merged as InstanceConfig;
  }

  // Validate templates: each must have at least one instance definition
  const templates: Record<string, FleetTemplate> = {};
  if (parsed.templates) {
    for (const [name, tpl] of Object.entries(parsed.templates)) {
      if (!tpl.instances || Object.keys(tpl.instances).length === 0) {
        throw new Error(`Template "${name}" must define at least one instance`);
      }
      templates[name] = tpl;
    }
  }

  // Normalize channel → channels (backward compat: single channel auto-wraps into array)
  const channelSingle = parsed.channel
    ? channelWithDefaults(parsed.channel)
    : undefined;
  const channels: FleetConfig["channels"] = parsed.channels
    ? parsed.channels.map(ch => channelWithDefaults(ch))
    : channelSingle ? [channelSingle] : undefined;

  // Always set channel to first entry (fallback for code using fleetConfig.channel)
  const primaryChannel = channelSingle ?? (channels?.[0] ?? undefined);

  return {
    channel: primaryChannel,
    channels,
    project_roots: parsed.project_roots,
    defaults: fleetDefaults,
    instances,
    teams: parsed.teams ?? {},
    templates,
    profiles: parsed.profiles,
    health_port: parsed.health_port,
    web: parsed.web,
    needs_you: needsYouConfig(parsed.needs_you),
    hostname: parsed.hostname,
    fleet_label: parsed.fleet_label,
    login: validateLoginConfig(parsed.login),
    web_terminal: validateWebTerminalConfig(parsed.web_terminal),
  };
}

/** #1386: only the two known booleans; anything else is dropped (the validator reports it). */
function needsYouConfig(raw: unknown): FleetConfig["needs_you"] {
  if (!isPlainObject(raw)) return undefined;
  const out: NonNullable<FleetConfig["needs_you"]> = {};
  if (typeof raw.live_message === "boolean") out.live_message = raw.live_message;
  if (typeof raw.dm === "boolean") out.dm = raw.dm;
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateLoginConfig(raw: unknown): FleetConfig["login"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) throw new Error(`login: expected a mapping, got ${JSON.stringify(raw)}`);
  // "relay" was removed (#1139) but stays accepted: rejecting it would stop an existing fleet from starting after an upgrade.
  if (raw.mode !== undefined && raw.mode !== "web" && raw.mode !== "relay") {
    throw new Error(`login.mode: expected "web" or "relay", got ${JSON.stringify(raw.mode)}`);
  }
  return raw as FleetConfig["login"];
}

function validateWebTerminalConfig(raw: unknown): FleetConfig["web_terminal"] {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) throw new Error(`web_terminal: expected a mapping, got ${JSON.stringify(raw)}`);
  const out = { ...raw } as NonNullable<FleetConfig["web_terminal"]> & Record<string, unknown>;
  // A security feature gate must be a real boolean: YAML `enabled: "false"` is
  // the string "false", which would read as "not disabled" (sol M2).
  if (out.enabled !== undefined && typeof out.enabled !== "boolean") {
    throw new Error(`web_terminal.enabled: expected true or false (unquoted), got ${JSON.stringify(out.enabled)}`);
  }
  if (out.ttl_minutes !== undefined) {
    if (typeof out.ttl_minutes !== "number" || !Number.isFinite(out.ttl_minutes)) {
      throw new Error(`web_terminal.ttl_minutes: expected a number 1..20, got ${JSON.stringify(out.ttl_minutes)}`);
    }
    out.ttl_minutes = Math.min(20, Math.max(1, Math.floor(out.ttl_minutes)));   // engine hard cap
  }
  if (out.bind !== undefined && (typeof out.bind !== "string" || !out.bind.trim())) {
    throw new Error("web_terminal.bind: expected a non-empty host/IP string");
  }
  if (out.tunnel !== undefined) out.tunnel = validateWebTerminalTunnelConfig(out.tunnel);
  return out;
}

/**
 * Strict, because this is the switch that lets a login terminal leave the machine: a quoted
 * "false" would read as truthy, and a misspelt key silently doing nothing is how an operator
 * ends up believing a setting is on (or off) when it is not.
 */
function validateWebTerminalTunnelConfig(raw: unknown): NonNullable<FleetConfig["web_terminal"]>["tunnel"] {
  if (!isPlainObject(raw)) throw new Error(`web_terminal.tunnel: expected a mapping, got ${JSON.stringify(raw)}`);
  const known = new Set(["provider", "allow_public", "protocol"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`web_terminal.tunnel.${key}: unknown key (expected provider, allow_public, protocol)`);
  }
  if (raw.allow_public !== undefined && typeof raw.allow_public !== "boolean") {
    throw new Error(`web_terminal.tunnel.allow_public: expected true or false (unquoted), got ${JSON.stringify(raw.allow_public)}`);
  }
  if (raw.provider !== undefined && raw.provider !== "cloudflared") {
    throw new Error(`web_terminal.tunnel.provider: only "cloudflared" is supported, got ${JSON.stringify(raw.provider)}`);
  }
  if (raw.protocol !== undefined && raw.protocol !== "http2" && raw.protocol !== "quic" && raw.protocol !== "auto") {
    throw new Error(`web_terminal.tunnel.protocol: expected http2, quic or auto, got ${JSON.stringify(raw.protocol)}`);
  }
  return { ...raw } as NonNullable<FleetConfig["web_terminal"]>["tunnel"];
}

/** Read the user-authored config without applying defaults or normalization. */
export function loadRawFleetConfig(configPath: string): RawFleetConfig {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf-8");
  // Match loadFleetConfig(): preserve platform IDs that exceed MAX_SAFE_INTEGER.
  const safeRaw = raw.replace(/(?<=:\s+|[-]\s+)(\d{16,})(?=\s*$)/gm, (_, d) => `"${d}"`);
  const parsed = unshareParsed(yaml.load(safeRaw), "fleet.yaml");          // #2208, as loadFleetConfig
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as RawFleetConfig
    : {};
}
