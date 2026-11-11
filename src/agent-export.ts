/**
 * AGEND-163: an agent's portable settings as one YAML file (`<role>.agend-agent.yaml`, `agend_export: 1`), and the way back.
 *
 * Allow-list only: a field is written, or read, because it is named here — never because it is not excluded. Accounts,
 * keys, channel ids, folders, machine ids, permissions, commands and status emojis are not in the allow-list, so they
 * are neither exported nor loaded; a file that carries them (a hand edit) has them skipped with the reason.
 *
 * Both directions are pure functions of their input: nothing here reads or writes fleet.yaml, so loading a file only
 * fills the form — the person still presses Apply and goes through the usual confirmations.
 */
import { parseDocument, stringify } from "yaml";
import { systemPromptParts } from "./prompt-file-ref.js";
import type { InstanceConfig } from "./types.js";

export const AGENT_EXPORT_VERSION = 1;
/**
 * The most an agent's `systemPrompt` ("Agent instructions") may hold, in characters: the editor's limit
 * (ui/agent-instructions-field.js INSTRUCTIONS_MAX_CHARS; tests/agent-export-163.test.ts keeps the two equal).
 */
export const AGENT_INSTRUCTIONS_MAX_CHARS = 24_000;
/** The largest file `parseAgentExport` reads, in characters (the instructions alone may take 24,000). */
export const AGENT_EXPORT_MAX_CHARS = 200_000;

const DESCRIPTION_MAX = 2_000;
const TAG_MAX_CHARS = 64;
const TAGS_MAX = 50;
const MODEL_MAX_CHARS = 200;
const ROLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]*$/;

/** What an export can carry, as the checkboxes of the export dialog. */
export const EXPORT_GROUPS = ["identity", "systemPrompt", "runtime", "behavior"] as const;
export type ExportGroup = (typeof EXPORT_GROUPS)[number];

const TOOL_SETS = ["worker", "coordinator", "standard", "minimal", "full"];
const TOOL_PROGRESS = ["off", "standard", "verbose"];
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];
const AGENT_MODES = ["mcp", "cli"];
const VISIBILITY = ["full", "summary", "hidden"];

/** Why a field of a file is not loaded (the page words each code). */
export type SkipReason =
  | "machine" | "binding" | "account" | "permission" | "command" | "emoji" | "notice" | "fleetOnly" | "name"
  | "runtimeSwitch" | "fileRef" | "unknown" | "badValue" | "tooLong";

/** The fields a file may name that are on purpose not loaded, and why. A name not here and not allowed is "unknown". */
const EXCLUDED: Record<string, SkipReason> = {
  display_name: "name",
  working_directory: "machine", runtime: "machine", machine_id: "machine", worktree_source: "machine",
  channel_id: "binding", topic_id: "binding", general_topic: "binding",
  backend_options: "account", credential_profile: "account",
  dashboard: "permission", office_access: "permission", office_pack_access: "permission", skipPermissions: "permission",
  pre_task_command: "command",
  status_emojis: "emoji",
  quota_notice: "notice",
  workflow: "fleetOnly", cost_guard: "fleetOnly", restart_policy: "fleetOnly", profile: "fleetOnly", mcp_proxy_reply: "permission",
};
const excludedReason = (key: string): SkipReason => (key.startsWith("native_") ? "machine" : Object.hasOwn(EXCLUDED, key) ? EXCLUDED[key]! : "unknown");

export interface Skipped { path: string; reason: SkipReason }

// ── The secret scan ────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["api_key", /\b(?:sk-[A-Za-z0-9_-]{16,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-\d-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9._-]{20,})/],
  ["bot_token", /\b\d{7,12}:[A-Za-z0-9_-]{30,}\b/],
  // A Discord bot token has no label of its own: <base64 id>.<timestamp>.<hmac>. This fleet's own credential, so the shape most likely to be pasted.
  ["discord_token", /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/],
  ["webhook", /\b(?:discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]{20,}|hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,})/i],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["bearer", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/],
  ["assignment", /\b[\w.-]{0,40}(?:api[_-]?key|secret|token|passwd|password|credential)[\w.-]{0,20}["']?\s*[:=]\s*["']?(?![<{$]|your|xxx|changeme|example)[A-Za-z0-9/+_.~=-]{16,}/i],
  ["url_password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/i],
];

export interface SecretFinding { field: string; line: number; kind: string }

/** Where a text looks like it holds a secret: the field, the line and the kind — never the secret itself. */
export function scanForSecrets(field: string, text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // A very long line is read in overlapping pieces, so the patterns' cost stays small however long a line is.
    for (let at = 0; at === 0 || at < line.length; at += 3000) {
      const piece = line.slice(at, at + 4000);
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(piece));
      if (hit) { found.push({ field, line: i + 1, kind: hit[0] }); break; }
    }
  });
  return found;
}

// ── Export ─────────────────────────────────────────────────────────────

export interface BuildResult {
  /** The file, or null when something in it looks like a secret (nothing is offered to copy or download). */
  text: string | null;
  findings: SecretFinding[];
  /** What the file holds, by group (the page's preview of "what will be in it"). */
  groups: ExportGroup[];
  /** True when none of the chosen settings is saved on this agent: the file would hold nothing. */
  empty: boolean;
  /** A chosen setting this agent has but the file does not carry, and why (the dialog says so beside the preview). */
  omitted: Array<{ field: "systemPrompt"; reason: "fileRef" | "tooLong" }>;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Only what this agent itself sets (a field that follows the fleet's defaults is not written). */
export function buildAgentExport(role: string, inst: Partial<InstanceConfig>, include: readonly string[]): BuildResult {
  const want = new Set(include.filter((g): g is ExportGroup => (EXPORT_GROUPS as readonly string[]).includes(g)));
  const agent: Record<string, unknown> = {};
  const behavior: Record<string, unknown> = {};
  const findings: SecretFinding[] = [];
  const omitted: BuildResult["omitted"] = [];
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

  if (want.has("identity")) {
    const d = text(inst.description);
    if (d) { agent.description = d; findings.push(...scanForSecrets("description", d)); }
    if (Array.isArray(inst.tags) && inst.tags.length) {
      agent.tags = inst.tags.filter((x): x is string => typeof x === "string");
      findings.push(...scanForSecrets("tags", (agent.tags as string[]).join("\n")));
    }
  }
  if (want.has("systemPrompt")) {
    // Agent instructions: an inline text only. A `file:` part (prompt-file-ref.ts systemPromptParts, the rule the editor and the
    // daemon both use) names a file on the exporter's computer, which means nothing elsewhere: the whole value is left out.
    const s = text(inst.systemPrompt);
    // A text longer than the editor's limit would be written but then refused on load (`tooLong`), so it is left out here and said so.
    if (s && systemPromptParts(s).some((part) => part.startsWith("file:"))) omitted.push({ field: "systemPrompt", reason: "fileRef" });
    else if (s && s.length > AGENT_INSTRUCTIONS_MAX_CHARS) omitted.push({ field: "systemPrompt", reason: "tooLong" });
    else if (s) { agent.systemPrompt = s.replace(/\s+$/, ""); findings.push(...scanForSecrets("systemPrompt", s)); }
  }
  if (want.has("runtime")) {
    if (text(inst.backend)) agent.backend = inst.backend;
    if (text(inst.model)) agent.model = inst.model;
    if (Array.isArray(inst.model_failover) && inst.model_failover.length) agent.model_failover = inst.model_failover;
    if (text(inst.tool_set)) agent.tool_set = inst.tool_set;
    if (typeof inst.lightweight === "boolean") agent.lightweight = inst.lightweight;
  }
  if (want.has("behavior")) {
    const hang = inst.hang_detector;
    if (hang && typeof hang === "object" && typeof hang.timeout_minutes === "number") behavior.hang_detector = { timeout_minutes: hang.timeout_minutes };
    for (const key of ["tool_progress", "reply_completion_guard", "log_level", "auto_pause_after", "agent_mode", "cross_instance_visibility", "board_cards_at_once", "resume_interrupted_work"] as const) {
      if (own(inst, key) && inst[key] !== undefined && inst[key] !== null) behavior[key] = inst[key];
    }
  }

  const empty = !Object.keys(agent).length && !Object.keys(behavior).length;
  if (findings.length) return { text: null, findings, groups: [...want], empty, omitted };
  const doc: Record<string, unknown> = { agend_export: AGENT_EXPORT_VERSION, kind: "agent" };
  if (ROLE_RE.test(role)) doc.role = role;
  doc.agent = agent;
  if (Object.keys(behavior).length) doc.behavior = behavior;
  doc.library = { skills: [], mcp: [] };
  return { text: stringify(doc, { lineWidth: 0, blockQuote: "literal" }), findings: [], groups: [...want], empty, omitted };
}

// ── Load ───────────────────────────────────────────────────────────────

/** What a file fills into the form: only the values that passed every check, under the form's own names. */
export interface FillValues {
  description?: string; tags?: string[]; systemPrompt?: string;
  model?: string; model_failover?: string; tool_set?: string; lightweight?: boolean;
  hang_detector?: number; tool_progress?: string; reply_completion_guard?: boolean; log_level?: string; auto_pause_after?: number;
  agent_mode?: string; cross_instance_visibility?: string; board_cards_at_once?: number; resume_interrupted_work?: boolean;
}
export type FillKey = keyof FillValues;

export type ParseResult =
  | { ok: true; role?: string; fill: FillValues; skipped: Skipped[]; libraryUsed: boolean; extraFailover: boolean }
  | { ok: false; error: "empty" | "too_large" | "invalid_yaml" | "not_export" | "unsupported_version" | "wrong_kind" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const num = (v: unknown, min: number, max = 100_000): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/** Read a file: the allow-listed values that are fine, and for every other field why it was left out. */
export function parseAgentExport(input: unknown): ParseResult {
  if (typeof input !== "string" || input.trim() === "") return { ok: false, error: "empty" };
  if (input.length > AGENT_EXPORT_MAX_CHARS) return { ok: false, error: "too_large" };
  // YAML 1.2 core schema, no aliases (nothing to expand), duplicate keys refused: plain data in, nothing else.
  const doc = parseDocument(input, { version: "1.2", schema: "core", uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) return { ok: false, error: "invalid_yaml" };
  let root: unknown;
  try { root = doc.toJS({ maxAliasCount: 0 }); } catch { return { ok: false, error: "invalid_yaml" }; }
  if (!isObj(root) || !own(root, "agend_export")) return { ok: false, error: "not_export" };
  if (root.agend_export !== AGENT_EXPORT_VERSION) return { ok: false, error: "unsupported_version" };
  if (own(root, "kind") && root.kind !== "agent") return { ok: false, error: "wrong_kind" };

  const fill: FillValues = {};
  const skipped: Skipped[] = [];
  const skip = (path: string, reason: SkipReason): void => { skipped.push({ path, reason }); };
  let role: string | undefined;
  let libraryUsed = false;
  let extraFailover = false;

  for (const key of Object.keys(root)) {
    if (key === "agend_export" || key === "kind") continue;
    if (key === "role") { if (typeof root.role === "string" && ROLE_RE.test(root.role)) role = root.role; else skip("role", "badValue"); continue; }
    if (key === "agent") { if (isObj(root.agent)) readAgent(root.agent); else skip("agent", "badValue"); continue; }
    if (key === "behavior") { if (isObj(root.behavior)) readBehavior(root.behavior); else skip("behavior", "badValue"); continue; }
    if (key === "library") { readLibrary(root.library); continue; }
    skip(key, "unknown");
  }

  function readAgent(a: Record<string, unknown>): void {
    for (const key of Object.keys(a)) {
      const path = `agent.${key}`, v = a[key];
      switch (key) {
        case "description": { const s = str(v, DESCRIPTION_MAX); if (s === null) skip(path, typeof v === "string" ? "tooLong" : "badValue"); else if (s.trim()) fill.description = s; break; }
        case "tags": {
          if (!Array.isArray(v) || v.length > TAGS_MAX || v.some((x) => typeof x !== "string" || !x.trim() || x.length > TAG_MAX_CHARS)) skip(path, "badValue");
          else fill.tags = [...new Set((v as string[]).map((x) => x.trim()))];
          break;
        }
        case "systemPrompt": {
          const s = str(v, AGENT_INSTRUCTIONS_MAX_CHARS);
          if (s === null) skip(path, typeof v === "string" ? "tooLong" : "badValue");
          // A `file:` part would make the daemon read a path on the computer that loads this file: never filled from a file.
          else if (systemPromptParts(s).some((part) => part.startsWith("file:"))) skip(path, "fileRef");
          else if (s.trim()) fill.systemPrompt = s;
          break;
        }
        case "backend": skip(path, "runtimeSwitch"); break;
        case "model": { const s = str(v, MODEL_MAX_CHARS); if (s === null || !MODEL_RE.test(s)) skip(path, "badValue"); else fill.model = s; break; }
        case "model_failover": {
          if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || x.length > MODEL_MAX_CHARS || !MODEL_RE.test(x))) skip(path, "badValue");
          else { fill.model_failover = v[0] as string; extraFailover = v.length > 1; }
          break;
        }
        case "tool_set": if (typeof v === "string" && TOOL_SETS.includes(v)) fill.tool_set = v; else skip(path, "badValue"); break;
        case "lightweight": if (typeof v === "boolean") fill.lightweight = v; else skip(path, "badValue"); break;
        default: skip(path, excludedReason(key));
      }
    }
  }

  function readBehavior(b: Record<string, unknown>): void {
    for (const key of Object.keys(b)) {
      const path = `behavior.${key}`, v = b[key];
      switch (key) {
        case "hang_detector": {
          const m = isObj(v) ? num(v.timeout_minutes, 1) : null;
          if (m === null) skip(path, "badValue"); else fill.hang_detector = m;
          if (isObj(v)) for (const k of Object.keys(v)) if (k !== "timeout_minutes") skip(`${path}.${k}`, "unknown");
          break;
        }
        case "tool_progress": if (typeof v === "string" && TOOL_PROGRESS.includes(v)) fill.tool_progress = v; else skip(path, "badValue"); break;
        case "reply_completion_guard": if (typeof v === "boolean") fill.reply_completion_guard = v; else skip(path, "badValue"); break;
        case "log_level": if (typeof v === "string" && LOG_LEVELS.includes(v)) fill.log_level = v; else skip(path, "badValue"); break;
        case "auto_pause_after": { const n = num(v, 0); if (n === null) skip(path, "badValue"); else fill.auto_pause_after = n; break; }
        case "agent_mode": if (typeof v === "string" && AGENT_MODES.includes(v)) fill.agent_mode = v; else skip(path, "badValue"); break;
        case "cross_instance_visibility": if (typeof v === "string" && VISIBILITY.includes(v)) fill.cross_instance_visibility = v; else skip(path, "badValue"); break;
        case "board_cards_at_once": if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000) fill.board_cards_at_once = v; else skip(path, "badValue"); break;
        case "resume_interrupted_work": if (typeof v === "boolean") fill.resume_interrupted_work = v; else skip(path, "badValue"); break;
        default: skip(path, excludedReason(key));
      }
    }
  }

  function readLibrary(lib: unknown): void {
    if (lib === undefined || lib === null) return;
    if (!isObj(lib)) { skip("library", "badValue"); return; }
    for (const key of Object.keys(lib)) {
      if (key !== "skills" && key !== "mcp") { skip(`library.${key}`, "unknown"); continue; }
      const list = lib[key];
      if (!Array.isArray(list)) skip(`library.${key}`, "badValue");
      else if (list.length) libraryUsed = true;
    }
  }

  return { ok: true, ...(role ? { role } : {}), fill, skipped, libraryUsed, extraFailover };
}
