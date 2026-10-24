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

export type DeliveryWorkerMode = "off" | "wake_only" | "on";
export const DELIVERY_WORKER_MODES: readonly DeliveryWorkerMode[] = ["off", "wake_only", "on"];
export const DEFAULT_DELIVERY_WORKER_MODE: DeliveryWorkerMode = "wake_only";

/**
 * The delivery_worker mode for `name`: instance override, then fleet default,
 * then `wake_only` (#1129). The built-in default used to be `off`, which
 * never woke a target paused across a fleet restart for queued work: the
 * delegated task waited until someone ran /wake. An explicit `off` is kept.
 */
export function resolveDeliveryWorkerMode(
  config: { defaults?: { delivery_worker?: unknown }; instances?: Record<string, { delivery_worker?: unknown }> } | null | undefined,
  name: string,
): DeliveryWorkerMode {
  for (const value of [config?.instances?.[name]?.delivery_worker, config?.defaults?.delivery_worker]) {
    if (typeof value === "string" && (DELIVERY_WORKER_MODES as readonly string[]).includes(value)) return value as DeliveryWorkerMode;
  }
  return DEFAULT_DELIVERY_WORKER_MODE;
}

export interface InstanceConfig {
  /** Proactive interrupted-work continuation; defaults true, inherited from fleet defaults. */
  resume_interrupted_work?: boolean;
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
  /**
   * Phase 2b: how far `defaults.warm_cap` may be exceeded to wake targets for
   * queued durable work (delivery_worker ≠ off). Default 2. The hard cap is
   * warm_cap + warm_overflow; with warm_cap 0 there is no cap at all.
   */
  warm_overflow?: number;
  /**
   * Phase 2 delivery owner for this target (docs/design/929-durable-outbox.md):
   * `off` keeps the outbox pump alone, `wake_only` (default since #1129) adds
   * the wake coordinator (2b), `on` hands claim/submit to the per-target
   * worker (2c). Read from `defaults.delivery_worker` with a per-instance
   * override.
   */
  delivery_worker?: DeliveryWorkerMode;
  /** Agent display name (e.g. "Kuro", "Luna") — chosen by the agent itself */
  display_name?: string;
  /**
   * #1005: this instance's own delivery-status emojis, overriding its
   * channel's `options.status_emojis` per key. Keys: received, queued,
   * processing, delivered, failed, progress_prefix, photo, attachment.
   */
  status_emojis?: import("./status-emojis.js").StatusEmojiConfig;
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
  /** Retained for backwards compat; context rotation was removed (#1296). */
  context_guardian?: {
    /** Retained for backwards compat but has no effect; context rotation was removed. */
    grace_period_ms?: number;
    /** Retained for backwards compat but has no effect; context rotation was removed. */
    max_age_hours?: number;
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
  /**
   * MCP tool profile (src/tool-permissions.ts): "worker", "coordinator", "standard", "minimal" or "full". Unset: the
   * fleet default's, else "general" for a General, else "worker".
   */
  tool_set?: string;
  /**
   * Tool-progress detail shown in the channel processing bubble.
   * "standard" shows semantic labels with no shell arguments;
   * "verbose" adds truncated command previews; "off" disables the list.
   * Defaults to "off" so upgrades do not start broadcasting tool activity.
   */
  tool_progress?: "off" | "standard" | "verbose";
  /**
   * #1302: how much of a cross-instance (bot-to-bot) message is posted in this instance's topic, whether it sent the
   * message or received it: "full" (the whole message), "summary" (one line), "hidden" (nothing). Delivery and the
   * Mirror Topic are unaffected. Unset inherits `defaults.cross_instance_visibility`, else "full".
   */
  cross_instance_visibility?: "full" | "summary" | "hidden";
  /**
   * #2303: how many task board cards handed to this instance it may have in progress at once (claiming another at the
   * limit is refused). A whole number of at least 1; unset is 1. Cards it opened for itself never count. The fleet
   * reads it at each claim; the daemon only keeps it current.
   */
  board_cards_at_once?: number;
  /**
   * Which dashboard features this instance may use, on top of its `tool_set` (dashboard-permissions.ts): `appearance`
   * (its own look: theme, pictures, widgets, ambient, effects, mod proposals), `task_board` (the `task` tool) and
   * `web_settings` (Settings → Web appearance for the person). `false` switches one off; unset allows. `defaults.dashboard`
   * sets it for every instance and merges key by key with an instance's own. The fleet reads it at each tool call; the
   * daemon keeps it current, and an agent's tool menu follows from its next start.
   */
  dashboard?: import("./dashboard-permissions.js").DashboardAccess;
  /**
   * Detect a human-channel turn that ended without a delivered reply and ask
   * the agent to send one bounded recovery reply. Only capable backends use
   * this switch; evidence tracking remains active for reply/tool correctness.
   * Default: true.
   */
  reply_completion_guard?: boolean;
  /** Fleet-wide default for native replies addressing ClassicBot collab rooms. */
  reply_triggers?: boolean;
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
  /** Maximum UTF-8 byte size of one cross-instance tool message body. Default: 12288. */
  max_cross_instance_message_bytes?: number;
  /**
   * #926: minutes after the last ask (or reminder) before a requester is told
   * that an idle owner has not answered a requires_reply request. Default 15;
   * 0 turns the notice off. The owner reminder is not affected.
   */
  reply_overdue_minutes?: number;
  /** #1694: hours since the last ask before an open reply obligation expires (default 24; positive finite duration). */
  reply_obligation_ttl_hours?: number;
  scheduler?: {
    max_schedules?: number;
    default_timezone?: string;
    retry_count?: number;
    retry_interval_ms?: number;
  };
  /** #1335: retention for delivery-outbox.db and Task Board. Days to keep terminal
   * deliveries (delivered/failed) and done/cancelled tasks. Default: 30.
   * Uncertain and non-terminal rows are never pruned. */
  retention_days?: number;
  startup?: {
    concurrency?: number;
    stagger_delay_ms?: number;
  };
  cost_guard?: CostGuardConfig;
  hang_detector?: HangDetectorConfig;
  daily_summary?: DailySummaryConfig;
  /** Daily tips: true/topic, dm with topic fallback, or false/off. Update-completion tips stay with the result. Default: true. */
  tips?: boolean | "dm";
  /** #2246 step 3: the task board's fleet-level settings. */
  task_board?: {
    /** The daily summary's time in the fleet's zone ("HH:MM", 24 h), or "off". Default "09:00". */
    summary_at?: string;
  };
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
  /** Canvas Worker effects are experimental and off unless explicitly enabled. Ambient effects are independent. */
  experimental?: { canvas_worker?: boolean };
  /**
   * Only menu availability; every exposure requires explicit admin consent. `ttl_minutes`: 1..480 for a quick tunnel;
   * with a fixed `hostname` (named tunnel) 1..10080, or 0 = no expiry. `auto_open` (named only, default false): reopen
   * the link after the fleet starts, for the admin who last opened it — no sign-in code is sent by that.
   */
  public_link?: { allow_public?: boolean; ttl_minutes?: number; protocol?: "http2" | "quic" | "auto"; hostname?: string; tunnel_token_env?: string; origin_port?: number; auto_open?: boolean };
  /** Echo web chat to the owning fleet topic (default true); never ClassicBot rooms. */
  echo_to_channel?: boolean;
  /** Show the AI subscription usage panel on /view and serve /api/ai-usage (default true). */
  usage_panel?: boolean;
  /**
   * #2122: serve the usage report (Fleet → Usage, GET /ui/usage-report) over the temporary public link too (default
   * false). It is up to 400 days of per-agent, per-model, per-profile activity and amounts — more than the live quota
   * rail or the cache report the link already shows. Guests never get it.
   */
  usage_report_on_public_link?: boolean;
  /**
   * #1937: the largest file the web chat takes, in MB (whole number, 1–500; default 50). Never more than
   * upload_max_total_mb; over the public link a file is at most 95 MB whatever this says (the quick tunnel's limit).
   * Read on each upload: `agend reload` applies a change; an open page uses the new limits after it reloads.
   */
  upload_max_file_mb?: number;
  /** #1937: all files on one web chat message together, in MB (whole number, 1–500; default 100). At most 5 files. */
  upload_max_total_mb?: number;
  /**
   * #1218: the instance Log tab (紀錄) — each agent's steps (prompts, replies, tool calls and results, errors) read on
   * demand from its own transcript, secrets masked. Default false: off, it does no work at all. Turning it on is an
   * admin's change, confirmed like any access change (Settings → Web).
   */
  log_tab?: boolean;
  /**
   * #2293: the dashboard's global search (Ctrl+K) over chat messages, cross-instance messages and Task Board tasks — an
   * index of its own (search.db; `retention_days` unset or 0 = no age limit, ROW_CAP 300,000 still applies;
   * search/search-index.ts). `enabled: false`: no index from the next fleet start (the file is left as it is), and
   * searches are refused at once.
   */
  /** #2293 global search. #2478: `public_link` (default true) — false keeps it off the temporary public link. */
  search?: { enabled?: boolean; retention_days?: number; public_link?: boolean };
  /** Expose provider API-key verify/apply endpoints (default false until dark-shipped). */
  provider_secrets?: boolean;
  /**
   * Extra `Host` names the dashboard answers to, for a reverse proxy or port
   * forward that presents a name other than localhost / 127.0.0.1 / [::1] / `hostname`.
   * Names only (a port is ignored); anything not listed is refused with 403.
   */
  allowed_hosts?: string[];
  /**
   * Who may read /view (the page, the terminal capture, the roster, usage).
   * `open` (default): anyone who can reach the listener — the page is a read-only dashboard on loopback.
   * `session`: a signed-in web session or the CLI header token. Writes need a credential either way.
   */
  view_access?: "open" | "session";
  /** Sign-in notices: true/topic (existing default), false/operator notices off, or dm with topic fallback. */
  notify_login?: boolean | "dm";
  /**
   * #1620: how long a web session lasts. Only the LOCAL surface (the dashboard reached directly — loopback, a LAN, a
   * tailnet) is configurable; a public-link session's limits stay fixed. Hours, 1 ≤ idle_hours ≤ absolute_hours ≤ 720;
   * defaults 48 (absolute, from sign-in) and 48 (idle, since the last use; #1670). Shortening applies to existing sessions.
   */
  session?: { local?: { absolute_hours?: number; idle_hours?: number } };
  /**
   * #1306: HTML previews in the web chat (default true). false: no preview listener; cards show Source and
   * Download only. Even when true, a browser runs a preview only after that device opted in.
   */
  preview?: boolean;
  /** The preview listener's port on 127.0.0.1 (default health_port + 1, i.e. 19281). */
  preview_port?: number;
  /**
   * A separate host name a proxy maps to the preview listener, as a bare origin (`https://preview.example.net`):
   * previews through a tunnel or proxy need one. It must not be a name the dashboard answers to.
   */
  preview_origin?: string;
  /**
   * #1723: previews over the temporary public link (default true): the link opens a second quick tunnel of its own
   * for them, in the background, closed with the link. false: none on the public link. A web.preview_origin is used
   * instead of it; web.preview: false turns previews off everywhere.
   */
  preview_on_public_link?: boolean;
  /**
   * #1629: agents' own web themes and effects. `agent_edit` (default true): false refuses every agent appearance write,
   * fleet-wide; what is stored stays, and people can still reset and lock.
   */
  themes?: { agent_edit?: boolean };
  /**
   * #1629 r4.1 Q3 (b): the identity card's upload limits and each agent's picture quota. Defaults: portrait
   * 1024×1536 / 1536 KiB, banner 1600×600 / 768 KiB, quota 8 files / 4 MiB. A value outside its hard bound is clamped
   * (and warned about); a change applies to new uploads only.
   */
  appearance?: import("./web-appearance-limits.js").AppearanceLimitsConfig;
  /**
   * #1920: guest web sign-in — a non-admin signed in as their own Discord or Telegram account, seeing only the instances
   * they already use in chat (derived on every request). Default off.
   */
  guests?: WebGuestsConfig;
  /**
   * #1939: when a signed-in web session's messages carry authority (docs/design/1939-verified-web-sessions.md §3).
   * S1 records it in receipts only; no agent acts on it yet.
   */
  verified_authority?: WebVerifiedAuthorityConfig;
}

/** #1939: fleet.yaml `web.verified_authority` (docs/design/1939-verified-web-sessions.md §0, §3, §10). */
export interface WebVerifiedAuthorityConfig {
  /**
   * The server switch (§10): web messages carry authority only while it is on (default true, §0.1). Turning it off makes
   * every web authority read as none at once; turning it back on never brings back authority given before.
   */
  enabled?: boolean;
  /** "Only this computer can authorize": only loopback requests qualify (default false: LAN and tailnet too). */
  loopback_only?: boolean;
  /** A session's authorization lasts this many hours after it was given, 1–48 (default 48). */
  max_session_hours?: number;
  /**
   * #2453 (§0.2): sessions over the admin's own named tunnel (`web.public_link.hostname`) may be authorized too — off by
   * default. Turning it on is confirmed in a General or on the host (never by the asking session); off applies at once
   * and every receipt from a named-link session reads as none. A quick tunnel is `quick_link`'s (§0.3).
   */
  named_link?: boolean;
  /**
   * #1939 §0.3: sessions over the temporary public link (the quick tunnel `/web` opens) may be authorized too — off by
   * default (the user's decision, 2026-10-23). Turning it on is confirmed in a General or on the host (never by the
   * asking session); off applies at once and every receipt from a quick-link session reads as none.
   */
  quick_link?: boolean;
}

/** #1920: fleet.yaml `web.guests`. */
export interface WebGuestsConfig {
  /** Guest sign-in at all (default false). Turning it off ends every guest session. */
  enabled?: boolean;
  /** Guests may chat (default true); false: read-only. */
  chat?: boolean;
  /**
   * An `open` connection's guests reach nothing until an admin names instances here, per connection id (the user's
   * decision: least privilege, since an open group has no list of people).
   */
  open_instances?: Record<string, string[]>;
  /** An admin's narrowing, per `<connection id>:<user id>`: intersected with the derived scope, never widening it. */
  narrow?: Record<string, string[]>;
  /**
   * #2348: an admin's explicit grants, per `<connection id>:<user id>` — the agents that person may see as a guest. Once
   * this key exists it is the only scope there is (default deny): the derived scope above (connection access, rooms,
   * open_instances, narrow) no longer gives anything. `name` is display only (who it was when granted).
   */
  grants?: Record<string, { name?: string; instances: string[] }>;
  /** A guest session's limits: absolute 1–24 h (default 12), idle 15–720 min (default 120). */
  session?: { absolute_hours?: number; idle_minutes?: number };
}

/** `login:` section — remote /login behaviour. */
export interface LoginConfig {
  /**
   * /login always runs in the token-gated browser terminal. `relay` (the pre-2.1.6 chat relay) was
   * removed in #1139: it is still accepted so an upgrade cannot stop a fleet from starting, is ignored,
   * and logs one warning.
   */
  mode?: "web" | "relay";
}

/**
 * `web_terminal.tunnel:` — the escape hatch for finishing a /login from somewhere that cannot
 * reach this machine (a phone away from the desk). Offered by default (#1137): each login asks
 * first, and only flows marked `tunnelOk` may use it.
 */
export interface WebTerminalTunnelConfig {
  /** The only provider today: a Cloudflare Quick Tunnel. */
  provider?: "cloudflared";
  /**
   * Whether /login may offer to open a temporary public HTTPS link to its terminal.
   * Unset or true: offered, and each login's button press is the consent (#1137).
   * false: the operator's kill switch — never offered, cloudflared never downloaded.
   */
  allow_public?: boolean;
  /** How cloudflared reaches Cloudflare. Default http2 (QUIC is blocked on many networks); auto lets cloudflared choose. */
  protocol?: "http2" | "quic" | "auto";
}

/** `web_terminal:` section — the browser terminal behind /login (sign-in and install). */
export interface WebTerminalConfig {
  /** Default true. false makes /login refuse in web mode. */
  enabled?: boolean;
  /** Interface to bind the per-session listener to. Default 127.0.0.1 (reach it like /dashboard: SSH/tailscale/reverse proxy). */
  bind?: string;
  /** Session time limit. 1..20 (engine hard cap 20), default 10. */
  ttl_minutes?: number;
  /** Optional public link for /login (see WebTerminalTunnelConfig). Absent = never. */
  tunnel?: WebTerminalTunnelConfig;
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
  /** #1386 "Needs you": the live list in each world's General (default on) and DMs to that world's admins (default off). */
  /** `task_board` (default false, #2425): the task board's cards that wait for the person are Needs-you items too. */
  needs_you?: { live_message?: boolean; dm?: boolean; task_board?: boolean };
  /** Host name used when building URLs handed to users (/dashboard, web terminal). Default "localhost". */
  hostname?: string;
  /**
   * How this fleet names itself in `/login` (slash command
   * descriptions, backend pickers) — tells apart several fleets' bots in one
   * guild. Default: the machine's host name.
   */
  fleet_label?: string;
  login?: LoginConfig;
  web_terminal?: WebTerminalConfig;
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
