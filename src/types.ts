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
    // resets_at is epoch SECONDS in the files claude-code actually writes
    // (verified 2026-08-02); the string form is kept for older/other writers.
    five_hour: { used_percentage: number; resets_at: number | string };
    seven_day: { used_percentage: number; resets_at: number | string };
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

/**
 * Stable logical terminal geometry for an instance's tmux window.
 *
 * `enabled: false` is the compatibility escape hatch: the window is pinned to
 * tmux's historical 80x24 geometry rather than inheriting the larger defaults.
 */
export interface TerminalConfig {
  enabled?: boolean;
  columns?: number;
  rows?: number;
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
  /**
   * Kiro CLI interface/engine profile. Only used when backend is "kiro-cli".
   * "legacy" preserves AgEnD's current --legacy-ui launch; "tui" uses Kiro's
   * default UI; "v3" opts into the experimental next-generation agent.
   */
  kiro_ui?: "legacy" | "tui" | "v3";
  /** MCP tool profile: "full" (20 tools), "standard" (8), "minimal" (3). Default: "full" */
  tool_set?: string;
  /**
   * Tool-progress detail shown in the channel processing bubble.
   * "standard" shows semantic labels with no shell arguments;
   * "verbose" adds truncated command previews; "off" disables the list.
   * Defaults to "off" so upgrades do not start broadcasting tool activity.
   */
  tool_progress?: "off" | "standard" | "verbose";
  /** Skip non-essential subsystems (transcript monitor, context guardian, approval server, prompt detector) */
  lightweight?: boolean;
  /** System prompt — supports comma-separated file: paths for modularization */
  systemPrompt?: string;
  /** Skip permission checks (dangerously-skip-permissions) */
  skipPermissions?: boolean;
  /** Claude model to use (e.g. "sonnet", "opus", "haiku", or full model ID) */
  model?: string;
  /** Reasoning effort: low | medium | high | xhigh | max. Clamped per backend. */
  effort?: string;
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
  /**
   * When the instance's MCP server dies, restart the instance automatically to
   * bring the tools back — waiting for an idle pane first so in-flight work is
   * not interrupted (the session is resumed, not reset). Default: true.
   * Set false to only notify, as before.
   */
  mcp_auto_restart?: boolean;
  /**
   * When the MCP server is dead at the end of a turn and the agent sent no
   * reply through any channel tool, the daemon relays the pane's final text to
   * the channel itself (marked ⚠️ as a proxy reply) — the daemon's IPC path to
   * the fleet manager does not go through the dead MCP server.
   *
   * Default: false (opt-in). A raw pane capture can contain secrets that the
   * regex redaction does not recognize; only enable this on instances whose
   * screen content is safe to mirror into the channel. Applies to channel
   * (user) turns only — cross-instance turns never trigger it.
   */
  mcp_proxy_reply?: boolean;
  /** Hang detector override for this instance. */
  hang_detector?: HangDetectorConfig;
  /** Logical terminal size. Defaults to 120x36; set enabled=false for 80x24 compatibility. */
  terminal?: TerminalConfig;
  /** Command to paste raw before each user message (e.g. "/chat load base.json") */
  pre_task_command?: string;
  /** Per-backend options keyed by backend name (e.g. { codex: { provider: "glm" } }) */
  backend_options?: Record<string, Record<string, unknown>>;
}

export interface WebhookConfig {
  url: string;
  events: string[];
  headers?: Record<string, string>;
}

export interface FleetDefaults extends Partial<InstanceConfig> {
  /** UI/notification language for user-facing text: "en" or "zh-TW". Auto-detects from timezone if unset. */
  locale?: string;
  /** Seconds before the cancel button starts showing elapsed time (default 30). */
  progress_min_elapsed?: number;
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

/** Web UI feature toggles (fleet.yaml `web:` section). */
export interface WebConfig {
  /** Show the AI subscription usage panel on /view and serve /api/ai-usage (default true). */
  usage_panel?: boolean;
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
  web?: WebConfig;
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
