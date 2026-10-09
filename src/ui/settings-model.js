// #1408 step 3: what Settings computes, apart from how it is shown — pure functions over the loaded configuration.
// Ported from settings.html with their reasons: every rule here was a fix (the review or issue named beside it).
// No DOM, no fetch; the panel (panel-settings.js) and the tests call these directly.

export const BACKENDS = ["claude-code", "kiro-cli", "codex", "opencode", "antigravity", "grok", "muse"];
export const CH_TYPES = ["discord", "telegram"];
export const LOCALES = [["en", "English"], ["zh-TW", "繁體中文 (zh-TW)"]];
export const VISIBILITY_MODES = ["full", "summary", "hidden"];
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];
export const TOOL_SETS = ["full", "standard", "minimal"];
export const TOOL_PROGRESS = ["off", "standard", "verbose"];
export const AGENT_MODES = ["mcp", "cli"];
export const ACCESS_MODES = ["locked", "open", "pairing"];
export const EFFORT_BACKENDS = new Set(["claude-code", "codex", "kiro-cli", "grok", "antigravity"]);
export const STATUS_ORDER = { running: 0, paused: 1, crashed: 2, stopped: 3 };

export const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
export const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The fields of `next` that differ from `baseline`. */
export function changedFields(next, baseline) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => !sameValue(value, baseline[key])));
}

/** #1302: cross-instance notices. Unset, or a value the fleet does not know, means full. */
export const visibilityDefault = (defaults) => (VISIBILITY_MODES.includes(defaults && defaults.cross_instance_visibility) ? defaults.cross_instance_visibility : "full");

export const replyGuardSupported = (backend, mode, kiroUi = "legacy") =>
  mode === "mcp" && (backend === "claude-code" || (backend === "kiro-cli" && ["legacy", "tui"].includes(kiroUi || "legacy")));

/**
 * The backend picker's options. A current value it does not offer (the removed gemini-cli, #1280 review) stays first
 * and selected: otherwise the select falls to its first option and an unrelated edit switches the CLI and account.
 */
export function backendOptions(value) {
  return BACKENDS.includes(value) ? BACKENDS.map((b) => ({ value: b, label: b })) : [{ value, label: null, unavailable: true }, ...BACKENDS.map((b) => ({ value: b, label: b }))];
}
/**
 * The locale picker (#1310): "Auto" for unset — without it the select falls to English and any unrelated defaults save
 * writes locale: en, pinning the language and disabling timezone auto-detect. A value it does not offer is kept.
 */
export function localeOptions(value) {
  const out = [{ value: "", auto: true }];
  if (value && !LOCALES.some(([v]) => v === value)) out.push({ value, label: value });
  for (const [v, label] of LOCALES) out.push({ value: v, label });
  return out;
}

// ── Connections ──
export const channelsOf = (fleet) => (fleet && fleet.channels) || (fleet && fleet.channel ? [fleet.channel] : []);
export const channelId = (ch, i) => ch.id || ch.type || `channel-${i}`;
export const chLabel = (i) => (i === 0 ? "primary" : "persona");

// ── Impacts: the server's (/api/settings/schema, derived from HOT_INSTANCE_CONFIG_KEYS); this page never decides one ──
export const DEFAULT_SCHEMA = { impacts: {}, order: ["now", "instance", "fleet"] };
export const impactOf = (schema, field) => (schema.impacts && schema.impacts[field]) || "instance";
/** A batch costs as much as its worst member, in the order the server ships. */
export function batchImpact(schema, keys, impactFor) {
  const order = schema.order;
  return order[keys.reduce((worst, k) => Math.max(worst, order.indexOf(impactFor(k))), 0)];
}
/** A defaults key's cost. `startup` holds the fleet's spawn settings, which the schema names on their own. */
export function defaultsImpact(schema, key) {
  if (key === "startup") return worstImpact(schema, [impactOf(schema, "fleet.spawn_concurrency"), impactOf(schema, "fleet.spawn_stagger_ms")]);
  return impactOf(schema, `defaults.${key}`);
}
/** What one write costs, from the schema: the worst of the fields it changes (Developer YAML's writes). */
export function requestImpact(schema, { method, url, body }) {
  const keys = Object.keys(body && typeof body === "object" && !Array.isArray(body) ? body : {});
  if (/\/fleet\/defaults$/.test(url)) return batchImpact(schema, keys, (k) => defaultsImpact(schema, k));
  if (/\/fleet\/channels$/.test(url)) return impactOf(schema, "fleet.channels");
  if (/\/fleet\/instances\/[^/]+$/.test(url)) {
    if (method === "DELETE") return impactOf(schema, "instance.delete");
    return batchImpact(schema, keys, (k) => impactOf(schema, `instance.${k}`));
  }
  return schema.order[schema.order.length - 1];
}
export function worstImpact(schema, impacts) {
  const order = schema.order;
  return order[impacts.reduce((worst, k) => Math.max(worst, order.indexOf(k)), 0)];
}

// ── Agents ──
/** Profile display_name, else the name without its -t<topicId> suffix. */
export const shortName = (name, inst) => (inst && inst.display_name) || String(name).replace(/-t\d+$/, "");
export const groupOf = (inst) => (inst && inst.tags && inst.tags[0]) || "Other";

/** What an agent runs: live values first, then its config, then the defaults. */
export function effectiveSummary(live, config, fleetDefaults, classicDefaults) {
  const defaults = classicDefaults || fleetDefaults || {};
  const backend = live.backend || config.backend || defaults.backend || (fleetDefaults && fleetDefaults.backend) || "claude-code";
  const model = live.model_display || config.model || defaults.model || (fleetDefaults && fleetDefaults.model) || "default";
  const effortSupported = live.effort_supported ?? EFFORT_BACKENDS.has(backend);
  const effort = effortSupported ? (live.effort || config.effort || (fleetDefaults && fleetDefaults.effort) || "auto") : "—";
  return { backend, model, effort };
}

/** Group by first tag, "Other" last; within a group Running → Paused → Crashed → Stopped, then by name. */
export function groupAgents(instances, live, filter) {
  const needle = String(filter || "").trim().toLowerCase();
  let names = Object.keys(instances || {});
  if (needle) names = names.filter((n) => n.toLowerCase().includes(needle) || shortName(n, instances[n]).toLowerCase().includes(needle));
  const groups = {};
  for (const n of names) (groups[groupOf(instances[n])] ??= []).push(n);
  const order = (n) => STATUS_ORDER[(live[n] && live[n].status) || "stopped"] ?? 9;
  return Object.keys(groups).sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map((g) => ({ group: g, names: groups[g].sort((a, b) => order(a) - order(b) || a.localeCompare(b)) }));
}

/**
 * The agent form's patch: only what changed against what the form showed. An override toggle "inherit" sends null
 * (the key is removed); the visibility baseline is what the picker showed, so a value it cannot show (a typo, read as
 * unset) is never rewritten by an unrelated edit (#1302).
 */
export function agentPatch(form, inst, defaults, visibilityBaseline, statusEmojisBaseline) {
  const hang = inst.hang_detector || {};
  const next = {
    backend: form.backend, model: form.model.trim() || null,
    working_directory: form.working_directory, channel_id: form.channel_id || undefined,
    description: form.description || undefined, systemPrompt: form.systemPrompt || undefined,
    tags: form.tags.length ? form.tags : undefined, general_topic: form.general_topic,
    auto_pause_after: form.inherit.auto_pause_after ? null : Number(form.auto_pause_after),
    hang_detector: { timeout_minutes: form.inherit.hang ? null : Number(form.hang) },
    agent_mode: form.inherit.agent_mode ? null : form.agent_mode,
    tool_set: form.inherit.tool_set ? null : form.tool_set,
    tool_progress: form.inherit.tool_progress ? null : form.tool_progress,
    cross_instance_visibility: form.inherit.cross_instance_visibility ? null : form.cross_instance_visibility,
    reply_completion_guard: form.inherit.reply_completion_guard ? null : form.reply_completion_guard,
    log_level: form.inherit.log_level ? null : form.log_level,
    lightweight: form.inherit.lightweight ? null : form.lightweight,
    model_failover: form.inherit.model_failover ? null : (form.model_failover.trim() ? [form.model_failover.trim()] : []),
    display_name: form.inherit.display_name ? null : form.display_name.trim(),
    status_emojis: form.status_emojis,
  };
  return changedFields(next, {
    backend: inst.backend || defaults.backend || "claude-code",
    model: (inst.model && inst.model.trim()) || null,
    working_directory: inst.working_directory || "",
    channel_id: inst.channel_id || undefined,
    description: inst.description || undefined,
    systemPrompt: inst.systemPrompt || undefined,
    tags: inst.tags && inst.tags.length ? inst.tags : undefined,
    general_topic: !!inst.general_topic,
    auto_pause_after: hasOwn(inst, "auto_pause_after") ? inst.auto_pause_after : null,
    hang_detector: { timeout_minutes: hasOwn(hang, "timeout_minutes") ? hang.timeout_minutes : null },
    agent_mode: hasOwn(inst, "agent_mode") ? inst.agent_mode : null,
    tool_set: hasOwn(inst, "tool_set") ? inst.tool_set : null,
    tool_progress: hasOwn(inst, "tool_progress") ? inst.tool_progress : null,
    cross_instance_visibility: visibilityBaseline,
    reply_completion_guard: hasOwn(inst, "reply_completion_guard") ? inst.reply_completion_guard : null,
    log_level: hasOwn(inst, "log_level") ? inst.log_level : null,
    lightweight: hasOwn(inst, "lightweight") ? inst.lightweight : null,
    model_failover: hasOwn(inst, "model_failover") ? inst.model_failover : null,
    display_name: hasOwn(inst, "display_name") ? inst.display_name : null,
    status_emojis: statusEmojisBaseline,
  });
}

/** The agent form's starting values (an override shows the inherited value while "inherit" is on). */
export function agentForm(inst, defaults) {
  const hang = inst.hang_detector || {};
  const inherit = (key) => !hasOwn(inst, key);
  return {
    backend: inst.backend || defaults.backend || "claude-code",
    model: inst.model || "", working_directory: inst.working_directory || "", channel_id: inst.channel_id || "",
    description: inst.description || "", systemPrompt: inst.systemPrompt || "", tags: [...(inst.tags || [])],
    general_topic: !!inst.general_topic,
    auto_pause_after: String(inst.auto_pause_after ?? defaults.auto_pause_after ?? 0),
    hang: String(hang.timeout_minutes ?? (defaults.hang_detector && defaults.hang_detector.timeout_minutes) ?? 15),
    agent_mode: inst.agent_mode || defaults.agent_mode || "mcp",
    tool_set: inst.tool_set || defaults.tool_set || "full",
    tool_progress: inst.tool_progress ?? defaults.tool_progress ?? "off",
    // #1302: a value the fleet does not know (a typo) is read as unset — the picker shows "full", as the old page did,
    // and the baseline is that same "full", so an unrelated edit never writes the typo back (the server refuses it).
    cross_instance_visibility: hasOwn(inst, "cross_instance_visibility")
      ? (VISIBILITY_MODES.includes(inst.cross_instance_visibility) ? inst.cross_instance_visibility : VISIBILITY_MODES[0])
      : visibilityDefault(defaults),
    reply_completion_guard: inst.reply_completion_guard ?? defaults.reply_completion_guard ?? true,
    log_level: inst.log_level || defaults.log_level || "info",
    lightweight: inst.lightweight ?? defaults.lightweight ?? false,
    model_failover: Array.isArray(inst.model_failover) ? (inst.model_failover[0] || "") : ((defaults.model_failover && defaults.model_failover[0]) || ""),
    display_name: inst.display_name ?? defaults.display_name ?? "",
    status_emojis: inst.status_emojis || null,
    inherit: {
      auto_pause_after: inherit("auto_pause_after"), hang: !hasOwn(hang, "timeout_minutes"), agent_mode: inherit("agent_mode"),
      tool_set: inherit("tool_set"), tool_progress: inherit("tool_progress"), cross_instance_visibility: inherit("cross_instance_visibility"),
      reply_completion_guard: inherit("reply_completion_guard"), log_level: inherit("log_level"), lightweight: inherit("lightweight"),
      model_failover: inherit("model_failover"), display_name: inherit("display_name"),
    },
  };
}

/** Every field the agent dialog shows, for its footer's impact summary. */
export const AGENT_FIELDS = [
  "instance.display_name", "instance.description", "instance.backend", "instance.model", "instance.working_directory",
  "instance.auto_pause_after", "instance.topic_id", "instance.hang_detector", "instance.agent_mode", "instance.tool_set",
  "instance.tool_progress", "instance.cross_instance_visibility", "instance.reply_completion_guard", "instance.log_level",
  "instance.lightweight", "instance.model_failover", "instance.systemPrompt", "instance.tags", "instance.general_topic",
  "instance.status_emojis",
];
export const CLASSIC_FIELDS = ["classic.backend", "classic.model", "classic.auto_pause_after", "classic.tool_progress",
  "classic.reply_completion_guard", "classic.collab", "classic.context_lines", "classic.web_echo"];
export const BOT_FIELDS = ["fleet.channel.access.mode", "fleet.channel.access.allowed_users", "fleet.channels", "fleet.channel.options.status_emojis"];

/** Validation messages (keys of the settings namespace), or "" when the value is fine. */
export const nonNegative = (v) => (!Number.isFinite(Number(v)) || String(v).trim() === "" || Number(v) < 0 ? "mustNonNegative" : "");
export const positive = (v) => (!Number.isFinite(Number(v)) || String(v).trim() === "" || Number(v) <= 0 ? "mustPositive" : "");
export const nonNegativeInteger = (v) => (!Number.isInteger(Number(v)) || String(v).trim() === "" || Number(v) < 0 ? "nonnegativeInteger" : "");

/**
 * The confirmations an access change needs (#996): opening a locked connection, and locking one with nobody allowed
 * (which shuts everyone out). Keys of the settings namespace, in order.
 */
export function accessConfirmations(previousAccess, nextMode, nextUsers) {
  const previousMode = (previousAccess && previousAccess.mode) || "locked";
  const previousUsers = (previousAccess && previousAccess.allowed_users) || [];
  const out = [];
  if (previousMode !== "open" && nextMode === "open") out.push("confirmOpenAccess");
  if (nextMode === "locked" && nextUsers.length === 0 && (previousMode !== "locked" || previousUsers.length > 0)) out.push("confirmLockedEmpty");
  return out;
}

/** #1320: only a short positive numeric id is a Telegram private chat; Discord snowflakes and negative ids are groups. */
export const webEchoIsGroup = (channelIdValue) => !/^\d{1,12}$/.test(String(channelIdValue || ""));

// ── Developer YAML: the config subset's writer and reader, exactly as settings.html had them (round-trip verified) ──
export function toYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const scalar = (v) => { if (v === null || v === undefined) return "null"; if (typeof v === "boolean" || typeof v === "number") return String(v); const s = String(v); if (s === "") return '""'; if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s) || /[:#\[\]{}&*!|>'"%@`]/.test(s) || /^[\s-]/.test(s) || /\s$/.test(s) || s.includes("\n")) return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; return s; };
  if (Array.isArray(value)) { if (!value.length) return "[]"; return value.map(item => { if (item !== null && typeof item === "object") { const d = toYaml(item, indent + 1); const lines = d.split("\n"); return pad + "- " + lines[0].slice((indent + 1) * 2) + (lines.length > 1 ? "\n" + lines.slice(1).join("\n") : ""); } return pad + "- " + scalar(item); }).join("\n"); }
  if (value !== null && typeof value === "object") { const keys = Object.keys(value); if (!keys.length) return "{}"; return keys.map(k => { const v = value[k]; if (v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) return pad + k + ":\n" + toYaml(v, indent + 1); if (v !== null && typeof v === "object") return pad + k + ": " + (Array.isArray(v) ? "[]" : "{}"); return pad + k + ": " + scalar(v); }).join("\n"); }
  return pad + scalar(value);
}
function parseScalar(s) { s = s.trim(); if (s === "" || s === "~" || s === "null") return null; if (s === "true") return true; if (s === "false") return false; if (/^-?\d+$/.test(s)) return parseInt(s, 10); if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s); if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"); if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1); if (s === "[]") return []; if (s === "{}") return {}; return s; }
export function fromYaml(text) {
  const lines = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) { let inS = false, inD = false, out = ""; for (let i = 0; i < raw.length; i++) { const c = raw[i]; if (c === "'" && !inD) inS = !inS; else if (c === '"' && !inS) inD = !inD; else if (c === "#" && !inS && !inD) break; out += c; } if (out.trim() === "") continue; lines.push({ indent: out.match(/^ */)[0].length, text: out.trim() }); }
  let pos = 0;
  function block() { if (pos >= lines.length) return null; const first = lines[pos]; if (first.text.startsWith("- ")) { const arr = []; while (pos < lines.length && lines[pos].indent === first.indent && lines[pos].text.startsWith("- ")) { const at = lines[pos].indent, rest = lines[pos].text.slice(2); if (rest.includes(":") && !/^".*"$/.test(rest) && !rest.startsWith("[") && !rest.startsWith("{")) { lines[pos] = { indent: at + 2, text: rest }; arr.push(map(at + 2)); } else { arr.push(parseScalar(rest)); pos++; } } return arr; } return map(first.indent); }
  function map(indent) { const obj = {}; while (pos < lines.length && lines[pos].indent === indent) { const line = lines[pos].text, ci = line.indexOf(":"); if (ci < 0) { pos++; continue; } const key = line.slice(0, ci).trim(), val = line.slice(ci + 1).trim(); if (val === "") { pos++; if (pos < lines.length && lines[pos].indent > indent) obj[key] = block(); else obj[key] = null; } else { obj[key] = parseScalar(val); pos++; } } return obj; }
  return block();
}

/** The fleet model the Developer view shows and edits. */
export const fleetModel = (fleet) => ({
  ...(fleet.channels ? { channels: fleet.channels } : fleet.channel ? { channel: fleet.channel } : {}),
  defaults: fleet.defaults || {}, instances: fleet.instances || {},
});

/** The same value, whatever the order of its keys (a YAML edit may reorder them). */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const sameConfig = (a, b) => canon(a) === canon(b);

/**
 * The requests an edited full model makes — only for what it changes against the configuration it was edited from
 * (#1408 step 5: an unchanged section is not written again): defaults, channels, then each instance added, changed
 * or removed.
 */
export function fullModelRequests(model, current) {
  const out = [];
  const fleet = current || {};
  if (model.defaults && !sameConfig(model.defaults, fleet.defaults || {})) out.push({ method: "PUT", url: "/api/settings/fleet/defaults", body: model.defaults });
  const chs = model.channels || (model.channel ? [model.channel] : null);
  if (chs && !sameConfig(chs, channelsOf(fleet))) out.push({ method: "PUT", url: "/api/settings/fleet/channels", body: chs });
  if (model.instances && typeof model.instances === "object") {
    const cur = fleet.instances || {};
    for (const [n, cfg] of Object.entries(model.instances)) {
      if (cur[n] && sameConfig(cfg, cur[n])) continue;
      out.push({ method: cur[n] ? "PATCH" : "POST", url: `/api/settings/fleet/instances/${encodeURIComponent(n)}`, body: cfg });
    }
    for (const n of Object.keys(cur)) if (!(n in model.instances)) out.push({ method: "DELETE", url: `/api/settings/fleet/instances/${encodeURIComponent(n)}` });
  }
  return out;
}
