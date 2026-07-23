/**
 * Shared config validation for fleet.yaml and classicBot.yaml.
 *
 * Pure functions with no fleet-manager / filesystem dependencies so both the
 * CLI (`agend validate`) and the Settings API can import them. `errors` block a
 * write (they break the fleet); `warnings` are advisory (write is allowed).
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

/** Backends the factory can instantiate (keep in sync with backend/factory.ts). */
export const KNOWN_BACKENDS = ["claude-code", "gemini-cli", "codex", "opencode", "kiro-cli", "antigravity", "grok", "mock"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every value is a non-empty string or a number (Telegram/Discord ids). */
function isIdArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(x => (typeof x === "string" && x.length > 0) || typeof x === "number");
}

/** The adapter id used to bind instances: explicit `id`, else `type`. */
function channelIdOf(ch: Record<string, unknown>): string | undefined {
  const id = ch.id ?? ch.type;
  return typeof id === "string" && id ? id : undefined;
}

export function validateFleetConfig(config: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });
  const validateAutoPause = (value: unknown, path: string) => {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      err(path, "must be a non-negative finite number of minutes (0 disables auto-pause)");
    }
  };
  const validateInstanceOptions = (value: Record<string, unknown>, path: string) => {
    if (value.agent_mode !== undefined && value.agent_mode !== "mcp" && value.agent_mode !== "cli") err(`${path}.agent_mode`, "must be mcp or cli");
    if (value.tool_set !== undefined && !["full", "standard", "minimal"].includes(String(value.tool_set))) err(`${path}.tool_set`, "must be full, standard, or minimal");
    if (value.log_level !== undefined && !["trace", "debug", "info", "warn", "error"].includes(String(value.log_level))) err(`${path}.log_level`, "must be trace, debug, info, warn, or error");
    if (value.lightweight !== undefined && typeof value.lightweight !== "boolean") err(`${path}.lightweight`, "must be a boolean");
    if (value.display_name !== undefined && typeof value.display_name !== "string") err(`${path}.display_name`, "must be a string");
    if (value.model_failover !== undefined && (!Array.isArray(value.model_failover) || !value.model_failover.every(v => typeof v === "string" && v.length > 0))) err(`${path}.model_failover`, "must be a list of non-empty model names");
    if (value.hang_detector !== undefined) {
      if (!isObj(value.hang_detector)) err(`${path}.hang_detector`, "must be a mapping");
      else {
        if (value.hang_detector.enabled !== undefined && typeof value.hang_detector.enabled !== "boolean") err(`${path}.hang_detector.enabled`, "must be a boolean");
        const timeout = value.hang_detector.timeout_minutes;
        if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) err(`${path}.hang_detector.timeout_minutes`, "must be a positive finite number");
      }
    }
  };

  if (!isObj(config)) {
    return { valid: false, errors: [{ path: "", message: "config must be a mapping" }], warnings: [] };
  }

  // ── Channels ──────────────────────────────────────────────
  // `channels: []` (multi) takes precedence; the legacy singular `channel:` is
  // used ONLY when `channels` is absent (matching fleet-manager's
  // `channels ?? [channel]`). Counting both would double-count a shared id and
  // wrongly flag a "duplicate channel id".
  const channelList: Record<string, unknown>[] = [];
  const usingChannels = Array.isArray(config.channels);
  if (usingChannels) {
    (config.channels as unknown[]).forEach((ch, i) => {
      if (!isObj(ch)) { err(`channels[${i}]`, "must be a mapping"); return; }
      channelList.push(ch);
    });
    if (config.channel !== undefined) warn("channel", "both `channel` (deprecated) and `channels` are set — `channel` is ignored");
  } else if (config.channels !== undefined) {
    err("channels", "must be a list");
  } else if (isObj(config.channel)) {
    channelList.push(config.channel);
  } else if (config.channel !== undefined) {
    err("channel", "must be a mapping");
  }

  if (channelList.length === 0) {
    warn("channels", "no channel configured — the fleet has no Telegram/Discord adapter");
  }

  const channelIds = new Set<string>();
  const multi = channelList.length > 1;
  channelList.forEach((ch, i) => {
    const at = Array.isArray(config.channels) && i < config.channels.length ? `channels[${i}]` : "channel";
    if (typeof ch.type !== "string" || !ch.type) err(`${at}.type`, "required (e.g. \"telegram\" or \"discord\")");
    if (typeof ch.bot_token_env !== "string" || !ch.bot_token_env) err(`${at}.bot_token_env`, "required — the env var holding the bot token");
    // With multiple channels an explicit id is needed to disambiguate bindings.
    if (multi && (ch.id === undefined || ch.id === null || ch.id === "")) {
      warn(`${at}.id`, "multiple channels present — set a unique `id` so instances can bind to this adapter");
    }
    const cid = channelIdOf(ch);
    if (cid) {
      if (channelIds.has(cid)) err(`${at}.id`, `duplicate channel id "${cid}"`);
      channelIds.add(cid);
    }
    if (isObj(ch.access) && ch.access.allowed_users !== undefined && !isIdArray(ch.access.allowed_users)) {
      err(`${at}.access.allowed_users`, "must be an array of strings/numbers");
    }
    if (isObj(ch.access) && ch.access.mode !== undefined && !["open", "locked", "pairing"].includes(String(ch.access.mode))) {
      err(`${at}.access.mode`, "must be open, locked, or pairing");
    }
  });

  // ── Defaults ──────────────────────────────────────────────
  if (config.defaults !== undefined && !isObj(config.defaults)) {
    err("defaults", "must be a mapping");
  } else if (isObj(config.defaults)) {
    const b = config.defaults.backend;
    if (b !== undefined && (typeof b !== "string" || !KNOWN_BACKENDS.includes(b))) {
      err("defaults.backend", `unknown backend "${String(b)}" (known: ${KNOWN_BACKENDS.join(", ")})`);
    }
    validateAutoPause(config.defaults.auto_pause_after, "defaults.auto_pause_after");
    if (config.defaults.warm_cap !== undefined && (!Number.isInteger(config.defaults.warm_cap) || (config.defaults.warm_cap as number) < 0)) {
      err("defaults.warm_cap", "must be a non-negative integer (0 = unlimited)");
    }
    validateInstanceOptions(config.defaults, "defaults");
    if (config.defaults.startup !== undefined) {
      if (!isObj(config.defaults.startup)) err("defaults.startup", "must be a mapping");
      else {
        const concurrency = config.defaults.startup.concurrency;
        if (concurrency !== undefined && (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 20)) err("defaults.startup.concurrency", "must be an integer from 1 to 20");
        const stagger = config.defaults.startup.stagger_delay_ms;
        if (stagger !== undefined && (typeof stagger !== "number" || !Number.isFinite(stagger) || stagger < 0 || stagger > 30_000)) err("defaults.startup.stagger_delay_ms", "must be between 0 and 30000 ms");
      }
    }
  }

  // ── Instances ─────────────────────────────────────────────
  let generalCount = 0;
  if (config.instances !== undefined && !isObj(config.instances)) {
    err("instances", "must be a mapping");
  } else if (isObj(config.instances)) {
    for (const [name, inst] of Object.entries(config.instances)) {
      if (!isObj(inst)) { err(`instances.${name}`, "must be a mapping"); continue; }
      if (inst.general_topic === true) generalCount++;
      // channel_id must reference a real channel id.
      if (inst.channel_id !== undefined && inst.channel_id !== null && inst.channel_id !== "") {
        const ref = String(inst.channel_id);
        if (!channelIds.has(ref)) {
          err(`instances.${name}.channel_id`, `references unknown channel "${ref}" (known: ${[...channelIds].join(", ") || "none"})`);
        }
      }
      const b = inst.backend;
      if (b !== undefined && (typeof b !== "string" || !KNOWN_BACKENDS.includes(b))) {
        err(`instances.${name}.backend`, `unknown backend "${String(b)}" (known: ${KNOWN_BACKENDS.join(", ")})`);
      }
      if (inst.working_directory !== undefined && typeof inst.working_directory !== "string") {
        err(`instances.${name}.working_directory`, "must be a string path");
      }
      validateAutoPause(inst.auto_pause_after, `instances.${name}.auto_pause_after`);
      validateInstanceOptions(inst, `instances.${name}`);
    }
  }
  if (generalCount === 0) {
    warn("instances", "no general_topic instance — there is no general dispatcher to receive un-topic'd messages");
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateClassicBotConfig(config: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const validateAutoPause = (value: unknown, path: string) => {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      err(path, "must be a non-negative finite number of minutes (0 disables auto-pause)");
    }
  };

  // An empty / absent classicBot.yaml is valid (classic bot is optional).
  if (config === null || config === undefined) return { valid: true, errors, warnings };
  if (!isObj(config)) {
    return { valid: false, errors: [{ path: "", message: "config must be a mapping" }], warnings: [] };
  }

  if (config.defaults !== undefined && !isObj(config.defaults)) {
    err("defaults", "must be a mapping");
  } else if (isObj(config.defaults)) {
    const d = config.defaults;
    const b = d.backend;
    if (b !== undefined && (typeof b !== "string" || !KNOWN_BACKENDS.includes(b))) {
      err("defaults.backend", `unknown backend "${String(b)}" (known: ${KNOWN_BACKENDS.join(", ")})`);
    }
    validateAutoPause(d.auto_pause_after, "defaults.auto_pause_after");
    for (const key of ["allowed_guilds", "admin_users", "allowed_groups", "allowed_users"]) {
      if (d[key] !== undefined && !isIdArray(d[key])) {
        err(`defaults.${key}`, "must be an array of strings/numbers");
      }
    }
  }

  if (config.channels !== undefined && !isObj(config.channels)) {
    err("channels", "must be a mapping (keyed by channelId or channelId#adapterId)");
  } else if (isObj(config.channels)) {
    for (const [key, channel] of Object.entries(config.channels)) {
      if (!isObj(channel)) { err(`channels.${key}`, "must be a mapping"); continue; }
      validateAutoPause(channel.auto_pause_after, `channels.${key}.auto_pause_after`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
