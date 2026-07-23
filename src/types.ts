export interface ContextStatus {
  used_percentage: number;
  remaining_percentage: number;
  context_window_size: number;
}

export interface StatusLineData {
  session_id: string;
  model: { id: string; display_name: string };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage: number | null;
    used_percentage: number | null;
    remaining_percentage: number | null;
  };
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
  };
  rate_limits?: {
    five_hour: { used_percentage: number; resets_at: string };
    seven_day: { used_percentage: number; resets_at: string };
  };
}

export interface AccessConfig {
  mode: "pairing" | "locked" | "open";
  allowed_users: (number | string)[];
  max_pending_codes: number;
  code_expiry_minutes: number;
}

export interface CostGuardConfig {
  daily_limit_usd: number;
  warn_at_percentage: number;
  timezone: string;
}

export interface HangDetectorConfig {
  enabled: boolean;
  timeout_minutes: number;
}

export interface DailySummaryConfig {
  enabled: boolean;
  hour: number;
  minute: number;
}

export interface ChannelConfig {
  id?: string;
  type: string;
  mode: "topic";
  bot_token_env: string;
  group_id?: number | string;
  access: AccessConfig;
  options?: Record<string, unknown>;
  /** Override the Telegram Bot API root URL (e.g. for testing with a mock server). */
  telegram_api_root?: string;
  /** Topic ID for mirroring all cross-instance messages (read-only observation). */
  mirror_topic_id?: number | string;
}

export interface InstanceConfig {
  working_directory: string;
  /** Minutes an idle CLI may remain resident before auto-pause. 0 disables it. */
  auto_pause_after?: number;
  /**
   * Fleet-wide cap on simultaneously warm (running) instances. Read from
   * `defaults.warm_cap`; when the running count exceeds it, the least-recently
   * active idle instance is auto-paused (general instances are never evicted).
   * 0 = unlimited (default). Complementary to auto_pause_after (time-based).
   */
  warm_cap?: number;
  /** Agent display name (e.g. "Kuro", "Luna") — chosen by the agent itself */
  display_name?: string;
  /** Human-readable description of what this instance does */
  description?: string;
  /** Tags for capability discovery (e.g. ["code-reviewer", "researcher", "executor"]) */
  tags?: string[];
  topic_id?: number | string;
  /** Which channel adapter this instance is bound to (matches channel `id` field). Used for multi-channel general routing. */
  channel_id?: string;
  general_topic?: boolean;
  restart_policy: {
    max_retries: number;
    backoff: "exponential" | "linear";
    reset_after: number;
    /** Health check polling interval in ms. Default: 30000 */
    health_check_interval_ms?: number;
  };
  context_guardian: {
    grace_period_ms: number;
    max_age_hours: number;
  };
  log_level: "trace" | "debug" | "info" | "warn" | "error";
  /** CLI backend to use. Default: "claude-code" */
  backend?: string;
  /** MCP tool profile: "full" (20 tools), "standard" (8), "minimal" (3). Default: "full" */
  tool_set?: string;
  /** Skip non-essential subsystems (transcript monitor, context guardian, approval server, prompt detector) */
  lightweight?: boolean;
  /** System prompt — supports comma-separated file: paths for modularization */
  systemPrompt?: string;
  /** Skip permission checks (dangerously-skip-permissions) */
  skipPermissions?: boolean;
  /** Claude model to use (e.g. "sonnet", "opus", "haiku", or full model ID) */
  model?: string;
  /** Ordered fallback models when primary hits rate limit (e.g. ["opus", "sonnet"]) */
  model_failover?: string[];
  /** Per-instance cost guard (overrides fleet defaults) */
  cost_guard?: CostGuardConfig;
  /** Original repo path when this instance uses a git worktree */
  worktree_source?: string;
  /** Workflow template: "builtin" (default), "file:path", inline string, or false to disable */
  workflow?: string | false;
  /** Total startup timeout in ms for CLI backend (split 60/40 between output detection and idle wait). Default: 25000 */
  startup_timeout_ms?: number;
  /** Agent communication mode: "mcp" (default) or "cli" (HTTP endpoint, no MCP server). */
  agent_mode?: "mcp" | "cli";
  /** Hang detector override for this instance. */
  hang_detector?: HangDetectorConfig;
  /** Command to paste raw before each user message (e.g. "/chat load base.json") */
  pre_task_command?: string;
}

export interface WebhookConfig {
  url: string;
  events: string[];
  headers?: Record<string, string>;
}

export interface FleetDefaults extends Partial<InstanceConfig> {
  /** UI/notification language for user-facing text: "en" or "zh-TW". Auto-detects from timezone if unset. */
  locale?: string;
  scheduler?: {
    max_schedules?: number;
    default_timezone?: string;
    retry_count?: number;
    retry_interval_ms?: number;
  };
  startup?: {
    concurrency?: number;
    stagger_delay_ms?: number;
  };
  cost_guard?: CostGuardConfig;
  hang_detector?: HangDetectorConfig;
  daily_summary?: DailySummaryConfig;
  webhooks?: WebhookConfig[];
}

// ── Context Rotation v3: Snapshot types ──────────────────────
export type RotationSnapshotEvent =
  | { type: "tool_use"; name: string; preview?: string }
  | { type: "tool_result"; name: string; preview?: string }
  | { type: "assistant_text"; preview: string };

export interface RotationSnapshot {
  instance: string;
  reason: string;
  created_at: string;
  working_directory: string;
  session_id?: string | null;
  context_pct?: number | null;
  recent_user_messages?: Array<{ text: string; ts: string }>;
  recent_events?: RotationSnapshotEvent[];
  recent_tool_activity?: string[];
  last_statusline?: {
    model?: string;
    cost_usd?: number;
    five_hour_pct?: number;
    seven_day_pct?: number;
  };
}

export interface TeamConfig {
  members: string[];
  description?: string;
}

export interface TemplateInstanceDef {
  description?: string;
  backend?: string;
  model?: string;
  model_failover?: string[];
  tool_set?: string;
  systemPrompt?: string;
  skipPermissions?: boolean;
  lightweight?: boolean;
  workflow?: string | false;
  tags?: string[];
  /** Reference to a profile in fleet.yaml profiles section */
  profile?: string;
}

export interface ProfileConfig {
  backend?: string;
  model?: string;
  model_failover?: string[];
  tool_set?: string;
  lightweight?: boolean;
}

export interface FleetTemplate {
  description?: string;
  /** Auto-create a team from all deployed instances */
  team?: boolean;
  instances: Record<string, TemplateInstanceDef>;
}

export interface FleetConfig {
  channel?: ChannelConfig;
  channels?: ChannelConfig[];
  project_roots?: string[];
  defaults: FleetDefaults;
  instances: Record<string, InstanceConfig>;
  teams?: Record<string, TeamConfig>;
  templates?: Record<string, FleetTemplate>;
  profiles?: Record<string, ProfileConfig>;
  health_port?: number;
}

/**
 * User-authored fleet.yaml before defaults are merged into instances.
 *
 * Keep this deliberately open: settings persistence must preserve config keys
 * introduced by newer AgEnD versions or third-party adapters even when this
 * runtime does not know their shape yet.
 */
export type RawFleetConfig = Record<string, unknown> & {
  channel?: ChannelConfig;
  channels?: ChannelConfig[];
  defaults?: FleetDefaults;
  instances?: Record<string, Partial<InstanceConfig> & Record<string, unknown>>;
};
