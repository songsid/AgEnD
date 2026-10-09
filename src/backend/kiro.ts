import { measureSyncWork } from "../sync-work-attribution.js";
import { EFFORT_CAPABILITIES } from "./effort-metadata.js";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { getAgendHome } from "../paths.js";
import {
  credentialHomeSpec,
  credentialProfileHome,
  credentialProfileStoreHome,
  prepareCredentialProfileHome,
  resolveCredentialProfile,
} from "./credential-profile.js";
import {
  type KiroAgentSpec, kiroAgentName, kiroFleetTag, writeKiroAgent, removeKiroAgent, writeSharedKiroMcpEntries,
  removeSharedKiroMcpEntries, writeTaggedKiroSteering, removeTaggedKiroSteering, kiroSteeringOwnership,
} from "./kiro-agent.js";
import {
  type KiroIdentityDecision, resolveKiroIdentity, listKiroV1Sessions, listKiroV2Sessions, confirmKiroAgentSwitch,
  kiroAgentConfirmed, forgetKiroIdentity, kiroIdentityNeedsStore, kiroCanonicalDirectory, KiroIdentityError, type KiroStoreRead,
} from "./kiro-identity.js";
import { readKiroLedger } from "./kiro-engine-ledger.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { type BackendAgentSwitch, type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, type RuntimeDialog, type SteerComposerMode, UnsupportedCliError, resolveBinary, shellQuote, validateEffort, validateModel, warnIfModelMismatch } from "./types.js";
import { PIE_CLASS } from "../tui-glyphs.js";
import { KIRO_EXPIRED_LOGIN_SCREEN } from "../login-flows.js";
import { t } from "../locale.js";
import { recordKiroLaunch } from "./kiro-engine-ledger.js";
import { forgetKiroV3Identity, resolveKiroV3Resume } from "./kiro-v3-identity.js";

// Kiro CLI feature gates. These are deliberately separate: the flags shipped
// in different releases, so one broad "old Kiro" check would still crash some
// supported versions with an unknown argument. Every row below was read from
// `chat --help` of the archived release binary (tests/fixtures/kiro-help/).
// - 1.27.0: --tui / --legacy-ui. Before this, classic was the only UI and
//   neither --legacy-ui nor --classic existed.
// - 2.3.0: --agent-engine, but its values were `rust` (default) | `kas`:
//   `--agent-engine=v1` exits 2 there.
// - 2.4.0: --agent-engine v1|v2|kas, and `--legacy-ui` only with v1.
// - 2.6.0: https://kiro.dev/changelog/cli/2-6/ (initial effort flag)
// - 2.8.0: --agent-engine v1|v2|v3, plus --v3.
export const KIRO_LEGACY_UI_MIN = "1.27.0";
export const KIRO_EFFORT_FLAG_MIN = "2.6.0";
/** Oldest kiro-cli AgEnD claims: older ones still launch, with a warning. */
export const KIRO_SUPPORTED_MIN = "2.21.0";
/**
 * Lowest version whose `--agent` and `--resume-id` the per-instance agent and conversation (#906) were verified on
 * (2.21.0 and 2.28.0, docs/design/kiro-per-instance-agent.md). Below it an instance launches as before.
 */
export const KIRO_INSTANCE_AGENT_MIN = "2.21.0";
/**
 * Newest kiro-cli run live under AgEnD. Above it the launch flags come from
 * the binary's own --help instead of the version table, and the operator is
 * told the version is unverified.
 */
export const KIRO_TESTED_MAX = "2.27.0";

/**
 * kiro-cli versions, per TUI front-end, whose mid-turn steering AgEnD drives (#1405). Only kiro's TUI steers — typed
 * input while a turn runs is injected into it ("steer", the default) or held for its end ("queue", Ctrl+S toggles); the
 * legacy UI swallows it. A version/front-end is listed once a live run of it — a real account, a steer and a
 * queued message mid-tool — has been captured (tests/fixtures/kiro-steer-1405, 2026-10-08: 2.27.1 `--tui
 * --agent-engine=v2` and `--v3`, 2.28.0 `--tui --agent-engine=v2`; identical rows on all three). Any other version,
 * 2.28.0's v3, the legacy UI and an undetected version all deliver a steer as an ordinary message after the turn.
 */
export const KIRO_STEER_VERIFIED: Readonly<Record<string, ReadonlyArray<"tui" | "v3">>> = {
  "2.27.1": ["tui", "v3"],
  "2.28.0": ["tui"],
};

/**
 * The TUI composer's interrupt mode, read off its own row: the LAST row starting at column 0 with `›` (transcript user
 * rows are indented), below which only blank rows or right-aligned hints (`/copy to clipboard`) may follow. Its text is
 * the empty composer's placeholder (tui.js, identical in 2.21.0, 2.27.1 and 2.28.0; 2.21.0 shows no elapsed time):
 *
 *   `› Kiro is working · 12s · Type to steer · Ctrl+S to queue`   → "steer"
 *   `› Kiro is working · 12s · Type to queue · Ctrl+S to steer`   → "queue"  (also `· Type to queue` alone: a spec task run)
 *   `› ask a question or describe a task ↵`                        → "idle"  (exactly; also plan mode's and tangent's
 *                                                                      complete forms — never a prefix of typed text)
 *
 * Any other text on the composer's row is typed text: "text" — positive evidence the box holds something. The goal,
 * editing, initializing, spec-description and shell placeholders are other modes, and the ASCII glyph set (`.`/`enter`,
 * never seen on a real pane of ours) is not read: null, like a screen with no composer row (a dialog) — null is never
 * evidence of either an empty or a full box. The toggle key's label is whatever the user bound; it is read past, never
 * pressed.
 */
function readKiroComposer(pane: string): { mode: SteerComposerMode; text: string } | null {
  const rows = pane.split("\n").map(row => row.replace(/\s+$/, ""));
  let i = rows.length - 1;
  while (i >= 0 && (rows[i] === "" || /^[ \t]{20,}\S/.test(rows[i]))) i--;
  // Typed text of more than one line continues below the `›` row, each row indented two spaces (live, 2.27.1 and
  // 2.28.0, TUI v2 and v3): the composer starts at the `›` row above them.
  let continued = 0;
  while (i >= 0 && /^ {2,19}\S/.test(rows[i]!)) { i--; continued++; }
  const row = rows[i];
  if (row === undefined || !/^›[ \t]+\S/.test(row)) return null;
  // A placeholder is one row: with continuation rows below it, this is typed text — unless its first row is another
  // mode's placeholder, which is then not ours to read.
  if (continued > 0) {
    if (/^›[ \t]+(?:Kiro is working\b|ask a question or describe a task\b|Goal (?:Active|Paused):|Editing queued message \d|Initializing\b|describe what "|running shell command\b)/.test(row)) return null;
    return { mode: "text", text: row.replace(/^›[ \t]+/, "") };
  }
  const working = String.raw`^›[ \t]+Kiro is working(?:[ \t]+·[ \t]+[^·]+?)?[ \t]+·[ \t]+`;
  const text = row.replace(/^›[ \t]+/, "");
  if (new RegExp(`${working}Type to steer[ \\t]+·[ \\t]+[^·]+?[ \\t]+to queue$`).test(row)) return { mode: "steer", text };
  if (new RegExp(`${working}Type to queue(?:[ \\t]+·[ \\t]+[^·]+?[ \\t]+to steer)?$`).test(row)) return { mode: "queue", text };
  const idle = String.raw`^›[ \t]+ask a question or describe a task`;
  if (new RegExp(`${idle}[ \\t]+↵$`).test(row)
    || new RegExp(`${idle}[ \\t]+↵[ \\t]+·[ \\t]+exit plan mode: shift\\+tab$`).test(row)
    || new RegExp(`${idle}[ \\t]+·[ \\t]+/tangent to go back[ \\t]+·[ \\t]+/tangent ls to view$`).test(row)) return { mode: "idle", text };
  // Other placeholders (and anything the ASCII glyph set paints) are not typed text.
  if (/^›[ \t]+(?:Kiro is working\b|Goal (?:Active|Paused):|Editing queued message \d|Initializing\b|describe what "|running shell command\b|ask a question or describe a task (?:\.|enter\b))/.test(row)) return null;
  return { mode: "text", text };
}

export function readKiroSteerComposer(pane: string): SteerComposerMode | null {
  return readKiroComposer(pane)?.mode ?? null;
}

/** The typed text on the composer's row when it reads "text" (its first row, as kiro paints it); else null. */
export function readKiroComposerText(pane: string): string | null {
  const c = readKiroComposer(pane);
  return c?.mode === "text" ? c.text : null;
}

export interface KiroCliCompatibility {
  version?: string;
  supportsLegacyUi: boolean;
  supportsTui: boolean;
  /** `--v3` exists, i.e. this binary has an engine AgEnD must not drift into. */
  supportsV3: boolean;
  /** Values `--agent-engine` accepts; null when the flag does not exist. */
  agentEngines: readonly string[] | null;
  supportsEffortFlag: boolean;
  /**
   * `chat --agent` and `chat --resume-id` both exist: the per-instance agent and conversation can be used (#906).
   * Absent means no — today's command.
   */
  supportsInstanceAgent?: boolean;
  source: "version" | "help" | "unknown";
}

type KiroProbeRunner = (binaryPath: string, args: string[]) => string;

const UNKNOWN_KIRO_COMPATIBILITY: KiroCliCompatibility = {
  supportsLegacyUi: false,
  supportsTui: false,
  supportsV3: false,
  agentEngines: null,
  supportsEffortFlag: false,
  supportsInstanceAgent: false,
  source: "unknown",
};

interface CachedKiroCompatibility {
  cacheKey: string;
  compatibility: KiroCliCompatibility;
  probedAt: number;
}

const compatibilityCache = new Map<string, CachedKiroCompatibility>();
const warnedUnsupportedEffortCacheKeys = new Set<string>();
/** Binary generations whose version-gate warning already went out. */
const warnedVersionGateCacheKeys = new Set<string>();

/**
 * A picker may change its model labels or credit wording between Kiro releases.
 * This broad test is only a safety hold: it must never select an option or
 * claim a service outage. A ready prompt below the picker makes it history.
 */
function kiroModelPickerAtTail(pane: string): boolean {
  const lines = pane.replace(/\r/g, "").split("\n");
  let pickerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/^\s*Select model \(type to search\):\s*$/.test(lines[index])) {
      pickerIndex = index;
      break;
    }
  }
  if (pickerIndex < 0) return false;
  const tail = lines.slice(pickerIndex + 1);
  if (tail.some(line => /^\s*\d+%[^\n]*[!❯>]\s+\S/.test(line))) return false;
  return tail.some(line => /^\s*[>❯›]\s*\*?\s*\S/.test(line));
}

const KIRO_TRUST_HEADER = "Warning: Kiro is running in trust all tools mode";
const KIRO_TRUST_PATTERN = /^\s*(?:Warning: Kiro is running in trust all tools mode|Do you trust the files\?)\s*$/m;
const KIRO_TRUST_OPTIONS = ["No, exit", "Yes, I accept", "Yes, and don't ask again"] as const;

/**
 * #849A: only the captured 2.27.1 TUI trust-all-tools layout can receive a
 * key. Unknown layouts remain held. A live composer or model picker below
 * the header makes it history, not a consent request. The old synthetic
 * workspace-trust shape is observable but never auto-accepted.
 */
export function kiroTrustPromptState(pane: string): KiroLaunchPromptState {
  const none: KiroLaunchPromptState = { active: false, cursor: null };
  if (kiroModelPickerAtTail(pane)) return none;
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.trimEnd());
  let header = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (KIRO_TRUST_PATTERN.test(rows[index])) { header = index; break; }
  }
  if (header < 0) return none;
  const body = rows.slice(header + 1);
  if (body.some(row => KIRO_COMPOSER_ROW.test(row))) return none;
  const choice = (row: string, label: string) => {
    if (row.trim() === label) return { glyph: null };
    const hit = /^\s*(\S)\s+(.+)$/.exec(row);
    return hit?.[2] === label ? { glyph: hit[1] } : null;
  };
  const held: KiroLaunchPromptState = { active: true, cursor: null };
  if (rows[header].trim() !== KIRO_TRUST_HEADER) {
    // A question alone is not permission evidence. A structurally selected
    // two-choice workspace prompt is held for a human, not navigated.
    return body.some(row => choice(row, KIRO_TRUST_OPTIONS[0]))
      && body.some(row => choice(row, KIRO_TRUST_OPTIONS[1])) ? held : none;
  }
  const first = body.findIndex(row => choice(row, KIRO_TRUST_OPTIONS[0]) !== null);
  if (first < 0) return held;
  if (body.slice(0, first).some(row => KIRO_TRUST_OPTIONS.some(label => choice(row, label)))) return held;
  const options = body.slice(first).filter(row => row.trim());
  // Exact labels/order, divider and key-hint tail from the native fixture.
  // No inferred two-option layout, added option, or arbitrary output suffix.
  if (options.length !== 5 || !/^─{3,}$/.test(options[3].trim())
    || !/^esc to cancel\s*·\s*↑↓ to navigate\s*·\s*↵ to select$/.test(options[4].trim())) return held;
  const hits = KIRO_TRUST_OPTIONS.map((label, index) => choice(options[index], label));
  if (hits.some(hit => !hit)) return held;
  const marked = hits.flatMap((hit, index) => hit!.glyph === null ? [] : [index]);
  if (marked.length !== 1 || !KIRO_PROMPT_CURSOR.test(hits[marked[0]]!.glyph!)) return held;
  return { active: true, cursor: marked[0] };
}

function kiroTrustPromptDialogs(trustAll: boolean): RuntimeDialog[] {
  const guarded = { pattern: KIRO_TRUST_PATTERN, blocksDelivery: true, inputBlocked: true, verifyAfterKeys: true } as const;
  const at = (pane: string, cursor: number) => {
    const state = kiroTrustPromptState(pane);
    return trustAll && state.active && state.cursor === cursor;
  };
  return [
    {
      ...guarded, keys: ["Down"], autoResolutionKey: "kiro-trust-all-tools-step",
      description: "Kiro trust confirmation — one step off 'No, exit'",
      isActive: pane => at(pane, 0),
    },
    {
      ...guarded, keys: ["Enter"], autoResolutionKey: "kiro-trust-all-tools-confirm",
      description: "Kiro trust confirmation — confirm per-session 'Yes, I accept'",
      isActive: pane => at(pane, 1),
    },
    {
      pattern: KIRO_TRUST_PATTERN, keys: [], holdOnly: true, blocksDelivery: true, inputBlocked: true,
      description: "Kiro trust confirmation — unsafe or unverified choice; holding for a human",
      isActive: pane => kiroTrustPromptState(pane).active,
    },
  ];
}

/**
 * Kiro's service-unavailable path opens the same picker as `/model`, but only
 * the former needs incident escalation. The runtime scanner and delivery gate
 * share this bottom-anchored test: a warning in old scrollback, an ordinary
 * `/model` picker, or a quoted transcript followed by a prompt is not enough.
 * Model rows are validated for their credit multiplier; it is precisely why
 * AgEnD must not pick a replacement on the user's behalf.
 */
export function kiroUnavailableModelPickerActive(pane: string): boolean {
  const lines = pane.replace(/\r/g, "").split("\n");
  let pickerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Select model \(type to search\):\s*$/.test(lines[i])) {
      pickerIndex = i;
      break;
    }
  }
  if (pickerIndex < 0) return false;

  const context = lines.slice(Math.max(0, pickerIndex - 8), pickerIndex);
  let troubleIndex = -1;
  for (let i = context.length - 1; i >= 0; i--) {
    if (/^\s*Kiro is having trouble responding right now:\s*$/.test(context[i])) {
      troubleIndex = i;
      break;
    }
  }
  if (troubleIndex < 0) return false;
  const warning = context.slice(troubleIndex + 1).join(" ").replace(/\s+/g, " ");
  if (!/^ ?The model you['’]ve selected is temporarily unavailable\. Please select a different model\. ?$/.test(warning)) return false;

  const cursorRow = /^\s*[>❯›]\s*\*?\s*[a-z0-9][a-z0-9._/-]*\s+\d+(?:\.\d+)?x credits\b/i;
  const modelRow = /^\s*\*?\s*[a-z0-9][a-z0-9._/-]*\s+\d+(?:\.\d+)?x credits\b/i;
  let cursorCount = 0;
  let modelCount = 0;
  let wrappedDescription = false;
  for (const line of lines.slice(pickerIndex + 1)) {
    if (!line.trim()) continue;
    if (cursorRow.test(line)) {
      cursorCount++;
      modelCount++;
      wrappedDescription = false;
    } else if (modelRow.test(line)) {
      modelCount++;
      wrappedDescription = false;
    } else if (modelCount > 0 && !wrappedDescription && /^(?:[a-z][a-z ]+|[0-9]+)$/i.test(line)) {
      // tmux capture-pane does not join a long description that wraps at the
      // viewport edge. The real 80-column picker splits "DeepSeek V3.2"
      // across lines, leaving just "2" on the second line.
      wrappedDescription = true;
    } else {
      return false;
    }
  }
  return cursorCount === 1 && modelCount >= 1;
}

export interface KiroLaunchPromptSpec {
  /** Text that identifies the prompt; the LAST occurrence heads it. */
  header: string;
  /** Option labels, in screen order (matched as a row prefix). */
  options: readonly string[];
}

export interface KiroLaunchPromptState {
  /** The prompt is the current interactive region of the pane. */
  active: boolean;
  /** Index into `options` of the one row with a recognised cursor; null = unknown. */
  cursor: number | null;
}

const KIRO_PROMPT_CURSOR = /^[❯›>]$/;
const KIRO_PROMPT_FOOTER = /navigate|select|↑|↓|\benter\b|\besc\b/i;

/**
 * Whether a kiro launch prompt owns the pane right now, and where its cursor
 * is. Bottom-anchored on purpose: below the header come only its description,
 * then exactly its option rows in order, then at most a short key-hint footer.
 * A quoted copy of the prompt in a transcript has the reply and the composer
 * row (`12% !>`) below it, so it is not active and never receives a key.
 *
 * The cursor is known only when exactly one option row carries a glyph AgEnD
 * recognises; any other glyph, none, or two is "unknown" — still active, so
 * it is held for a human, never answered.
 */
export function kiroLaunchPromptState(pane: string, spec: KiroLaunchPromptSpec): KiroLaunchPromptState {
  const none: KiroLaunchPromptState = { active: false, cursor: null };
  const rows = pane.replace(/\r/g, "").split("\n").map(row => row.replace(/\s+$/, ""));
  let header = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].includes(spec.header)) { header = i; break; }
  }
  if (header < 0) return none;
  const body = rows.slice(header + 1);
  const optionRow = (row: string, label: string) => {
    const match = /^\s*(?:(\S)\s+)?(.*)$/.exec(row);
    if (match && match[2].startsWith(label)) return { glyph: match[1] ?? null };
    // No glyph: the label itself starts the row.
    return row.trim().startsWith(label) ? { glyph: null } : null;
  };
  const first = body.findIndex(row => optionRow(row, spec.options[0]) !== null);
  if (first < 0) return none;
  // A composer row anywhere below the header — before the options or after
  // them — means this is quoted history with the input box back on screen.
  // Checked before the footer test, whose keywords (enter/select/esc) a
  // composer line can contain.
  if (body.some(row => KIRO_COMPOSER_ROW.test(row))) return none;
  const optionRows = body.slice(first).filter(row => row.trim());
  if (optionRows.length < spec.options.length) return none;
  const glyphs: (string | null)[] = [];
  for (let i = 0; i < spec.options.length; i++) {
    const hit = optionRow(optionRows[i], spec.options[i]);
    if (!hit) return none;
    glyphs.push(hit.glyph);
  }
  const trailing = optionRows.slice(spec.options.length);
  if (trailing.length > 2 || !trailing.every(row => KIRO_PROMPT_FOOTER.test(row))) return none;
  const marked = glyphs.map((g, i) => (g !== null ? i : -1)).filter(i => i >= 0);
  if (marked.length !== 1 || !KIRO_PROMPT_CURSOR.test(glyphs[marked[0]]!)) return { active: true, cursor: null };
  return { active: true, cursor: marked[0] };
}

/** kiro's input row: legacy `12% !>` / `[agent] 3% λ !>`, or a bare `>`/`❯`. */
const KIRO_COMPOSER_ROW = /^\s*(?:\[[^\]]*\]\s*)?\d+%\s*\S{0,2}\s*!?\s*[❯>]|^\s*[!❯>]\s*$/;

/**
 * Launch prompts that would move an instance off its engine (#1109). Text
 * from the kiro-cli 2.27.0 binary (crates/chat-cli/src/launch/v3_ease_in.rs,
 * auto_migrate.rs); not yet seen live — the V3 prompt is offered to 25% of
 * internal users only.
 *
 * The first option of each is the one that switches, so it is never confirmed:
 * a cursor verified on it gets ONE Down, and only a later capture that shows
 * the cursor on the option that changes nothing gets Enter. Anything else —
 * an unrecognised cursor, "Don't ask again" (saved for the whole machine), or
 * a Down that did not move the cursor — is held for a human: deliveries stay
 * blocked and the parked-dialog report fires.
 */
const KIRO_V3_EASE_IN: KiroLaunchPromptSpec = {
  header: "CLI 3.0 is becoming the default experience",
  options: ["Switch to 3.0 and upgrade my configs", "Remind me later", "Don't ask again"],
};
const KIRO_AGENT_UPGRADE: KiroLaunchPromptSpec = {
  header: "Your agent configs are still in the 2.0 format",
  options: ["Enable auto-upgrade", "Not now"],
};
/**
 * #1308: kiro-cli 2.28.0's Classic nudge (crates/chat-cli/src/launch/classic_nudge.rs), shown before a Classic
 * session starts, including one launched with the pinned `--legacy-ui --agent-engine=v1`. "Switch to 3.0" saves v3 as
 * the machine-wide default and reruns the session in 3.0; "Remind me later" only stores a 7-day snooze
 * (`classicNudge.snoozeUntil`). It has no "don't ask again", so it returns weekly. Captured live from 2.28.0
 * (tests/fixtures/kiro-2.28.0-classic-nudge/). The header is the description's first words, which stay on its first
 * row however narrow the pane; the rest of the description re-wraps with the width.
 */
export const KIRO_CLASSIC_NUDGE: KiroLaunchPromptSpec = {
  header: "Classic is being deprecated with the Kiro CLI 3.0",
  options: ["Switch to 3.0 and upgrade my agent configs", "Remind me later"],
};

function kiroLaunchPromptDialogs(spec: KiroLaunchPromptSpec, name: string, key: string, keep: number): RuntimeDialog[] {
  const pattern = new RegExp(spec.header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const state = (pane: string) => kiroLaunchPromptState(pane, spec);
  const guarded = { pattern, blocksDelivery: true, inputBlocked: true, verifyAfterKeys: true } as const;
  return [
    {
      ...guarded,
      keys: ["Down"],
      description: `${name} — cursor on '${spec.options[0]}': one step down`,
      isActive: pane => { const s = state(pane); return s.active && s.cursor === 0; },
      autoResolutionKey: `${key}-step`,
    },
    {
      ...guarded,
      keys: ["Enter"],
      description: `${name} — confirm '${spec.options[keep]}'`,
      isActive: pane => { const s = state(pane); return s.active && s.cursor === keep; },
      autoResolutionKey: `${key}-confirm`,
    },
    {
      pattern,
      keys: [],
      holdOnly: true,
      blocksDelivery: true,
      inputBlocked: true,
      description: `${name} — not on a choice AgEnD can make safely; holding for a human`,
      isActive: pane => state(pane).active,
    },
  ];
}

const KIRO_ENGINE_PROMPT_DIALOGS: RuntimeDialog[] = [
  ...kiroLaunchPromptDialogs(KIRO_V3_EASE_IN, "Kiro V3 ease-in prompt", "kiro-v3-ease-in", 1),
  ...kiroLaunchPromptDialogs(KIRO_AGENT_UPGRADE, "Kiro 3.0 agent-config upgrade prompt", "kiro-agent-upgrade", 1),
  ...kiroLaunchPromptDialogs(KIRO_CLASSIC_NUDGE, "Kiro Classic deprecation nudge", "kiro-classic-nudge", 1),
];

function parseSemver(value: string | undefined): [number, number, number] | undefined {
  const match = value?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: [number, number, number], minimum: string): boolean {
  const required = parseSemver(minimum)!;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== required[i]) return version[i] > required[i];
  }
  return true;
}

function helpAdvertisesFlag(help: string, flag: string): boolean {
  // clap prints a short alias first when there is one: `  -r, --resume`.
  return new RegExp(`^\\s*(?:-[A-Za-z0-9],\\s*)?${flag}(?:[ =<,]|$)`, "m").test(help);
}

/**
 * The values `chat --help` lists for --agent-engine, or null without the flag.
 * clap prints them as `[possible values: v2, v1, v3]` a few lines below the
 * flag; the quoted names in its description are the fallback.
 */
export function parseKiroAgentEngines(help: string): string[] | null {
  const lines = help.split("\n");
  const at = lines.findIndex(line => KIRO_HELP_OPTION_ROW.test(line) && /--agent-engine\b/.test(line));
  if (at < 0) return null;
  // Only this option's own description/value block: it ends at the next
  // option row, so a neighbour's `[possible values: …]` is never read as ours.
  let end = at + 1;
  while (end < lines.length && !KIRO_HELP_OPTION_ROW.test(lines[end])) end++;
  const block = lines.slice(at, end);
  for (const line of block) {
    const listed = line.match(/\[possible values:\s*([^\]]+)\]/);
    if (listed) return listed[1].split(",").map(v => v.trim()).filter(Boolean);
  }
  const quoted = [...block.slice(1).join(" ").matchAll(/"([a-z0-9]+)"/gi)].map(m => m[1]);
  // Present but without legible values: [] — nothing to pin to, so refused.
  return [...new Set(quoted)];
}

/** A clap option row: `  -r, --resume`, `      --agent-engine <ENGINE>`. */
const KIRO_HELP_OPTION_ROW = /^\s*(?:-[A-Za-z0-9],\s*)?--[a-z][a-z0-9-]*/;

/**
 * Whether `help` is kiro's `chat --help` at all. Every release from 1.26 to
 * 2.27 prints the clap usage line and the --trust-all-tools / --resume options
 * AgEnD launches with. An empty or truncated help proves nothing — in
 * particular not that the binary is old enough to have no engine to pin.
 */
function isKiroChatHelp(help: string): boolean {
  return /^Usage:\s+\S*kiro\S*\s+chat\b/m.test(help)
    && helpAdvertisesFlag(help, "--trust-all-tools")
    && helpAdvertisesFlag(help, "--resume");
}

/** What a released kiro-cli version accepts, per the table above. */
function compatibilityFromVersion(version: string, parsed: [number, number, number]): KiroCliCompatibility {
  const has = (min: string) => versionAtLeast(parsed, min);
  return {
    version,
    supportsLegacyUi: has(KIRO_LEGACY_UI_MIN),
    supportsTui: has(KIRO_LEGACY_UI_MIN),
    supportsV3: has("2.8.0"),
    agentEngines: has("2.8.0") ? ["v2", "v1", "v3"]
      : has("2.4.0") ? ["v2", "v1", "kas"]
      : has("2.3.0") ? ["rust", "kas"]
      : null,
    supportsEffortFlag: has(KIRO_EFFORT_FLAG_MIN),
    supportsInstanceAgent: has(KIRO_INSTANCE_AGENT_MIN),
    source: "version",
  };
}

function compatibilityFromHelp(version: string | undefined, help: string): KiroCliCompatibility {
  if (!isKiroChatHelp(help)) return { ...UNKNOWN_KIRO_COMPATIBILITY, version };
  return {
    version,
    supportsLegacyUi: helpAdvertisesFlag(help, "--legacy-ui"),
    supportsTui: helpAdvertisesFlag(help, "--tui"),
    supportsV3: helpAdvertisesFlag(help, "--v3"),
    agentEngines: parseKiroAgentEngines(help),
    supportsEffortFlag: helpAdvertisesFlag(help, "--effort"),
    // The flags are listed long before 2.21, but the behaviour #906 relies on was verified from 2.21 on: an unknown or
    // older version keeps today's command.
    supportsInstanceAgent: helpAdvertisesFlag(help, "--agent") && helpAdvertisesFlag(help, "--resume-id")
      && (() => { const v = parseSemver(version); return !!v && versionAtLeast(v, KIRO_INSTANCE_AGENT_MIN); })(),
    source: "help",
  };
}

/**
 * Probe once per binary generation. A version AgEnD has run (<= TESTED_MAX)
 * is answered from the table without a second CLI call; anything newer, or a
 * version string that does not parse, is answered by the binary's own
 * `chat --help` — 3.0 included, which is exactly where the table stops being
 * evidence.
 */
export function probeKiroCliCompatibility(
  binaryPath: string,
  run: KiroProbeRunner = (binary, args) => measureSyncWork(args[0] === "--version" ? "kiro.version" : "kiro.help", () => execFileSync(binary, args, {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  })),
): KiroCliCompatibility {
  return measureSyncWork("kiro.compatibilitySync", () => probeKiroCliCompatibilitySync(binaryPath, run));
}
function probeKiroCliCompatibilitySync(binaryPath: string, run: KiroProbeRunner): KiroCliCompatibility {
  let version: string | undefined;
  try {
    version = run(binaryPath, ["--version"]).trim().split("\n")[0].slice(0, 80) || undefined;
  } catch { /* fall through to capability help */ }

  const parsed = parseSemver(version);
  if (parsed && !versionAtLeast(parsed, nextPatch(KIRO_TESTED_MAX))) {
    return compatibilityFromVersion(version!, parsed);
  }
  try {
    return compatibilityFromHelp(version, run(binaryPath, ["chat", "--help"]));
  } catch {
    // An untested 2.x whose help cannot be read is still a 2.x; a 3.x or an
    // unidentified binary is not something to guess about.
    if (parsed && !versionAtLeast(parsed, "3.0.0")) return compatibilityFromVersion(version!, parsed);
    return { ...UNKNOWN_KIRO_COMPATIBILITY, version };
  }
}

function nextPatch(version: string): string {
  const [major, minor, patch] = parseSemver(version)!;
  return `${major}.${minor}.${patch + 1}`;
}

export type KiroLaunchPlan =
  | { kind: "launch"; ui: "legacy" | "tui" | "v3"; flags: string[] }
  | { kind: "refuse"; reason: string };

/**
 * Pin the UI AND the engine on every launch (#1109). A flag outranks kiro's
 * persisted `chat.agentEngine`, which the V3 ease-in prompt writes for the
 * whole machine and which kiro 3.0 may default to V3. An instance's
 * conversation lives in its engine's store — classic sqlite, V2 JSON, V3 KAS —
 * and moving between them forks it one way, so a launch AgEnD cannot pin to
 * the instance's own engine is refused, never run on whatever kiro defaults to.
 */
/** One attempt's launch plan (#906): see KiroBackend.planInstanceLaunch. */
interface KiroInstanceLaunch {
  cwd: string;
  skipResume: boolean;
  engine: "v1" | "v2" | "v3" | null;
  credentialProfile: string | null;
  mode: "legacy" | "resume" | "fresh";
  /** Legacy mode's launch warning, if any. */
  reason: string | null;
  agent: string | null;
  id?: string;
  agentConfirmed: boolean;
}

/** Binary generations already told they cannot isolate (once each). */
const warnedNoInstanceAgentKeys = new Set<string>();
/** Instances already told about an untagged steering file (once each). */
const warnedUntaggedSteering = new Set<string>();

/** The classic (v1) conversation store an instance launches with: its credential profile's, else the shared one. */
export function kiroV1DbPath(credentialProfile: string | null): string {
  const home = credentialProfile
    ? credentialProfileStoreHome(getAgendHome(), "kiro-cli", credentialProfile)
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-cli");
  return join(home, "data.sqlite3");
}

/** The TUI (v2) session files: `<KIRO_HOME or ~/.kiro>/sessions/cli` — not per credential profile. */
export function kiroV2SessionsDir(): string {
  return join(process.env.KIRO_HOME?.trim() || join(homedir(), ".kiro"), "sessions", "cli");
}

/**
 * Adoption evidence (#906 §2): the engine ledger shows this instance launched here — same directory, credential
 * profile and engine — before #906 (no "--agent" in that launch). A new instance has no such record and starts fresh
 * instead of taking a sibling's conversation.
 */
export function kiroLaunchedHereBefore(instance: string, workingDirectory: string, credentialProfile: string | null, engine: "v1" | "v2", ledgerPath?: string): boolean {
  const entry = readKiroLedger(ledgerPath)[instance];
  if (!entry || resolve(entry.workingDirectory) !== resolve(workingDirectory) || entry.credentialProfile !== credentialProfile) return false;
  return entry.lastLaunch.ui === (engine === "v1" ? "legacy" : "tui") && !entry.lastLaunch.flags.includes("--agent");
}

/** The legacy UI's prompt row: an optional `[agent]`, the context percentage, an optional mode glyph, the marker. */
const LEGACY_PROMPT_ROW = /^\s*(?:\[([^\]]+)\]\s*)?\d+%\s*(?:[^\s\d%!❯>]{1,2}\s+)?(?:!\s?[❯>]|❯|>)/;
/** A TUI status row: `<agent> · <model> · …`. */
const TUI_STATUS_ROW = /^\s*(\S+) · /;
const RULE_ROW = /^[\s─━│┃╭╮╰╯┌┐└┘]*$/;
/** The right-aligned hint under the TUI input row: far right, a slash command or two. */
const TUI_HINT_ROW = /^\s{20,}\/[\w-]+(?: [\w-]+)*(?: · \/[\w-]+(?: [\w-]+)*)*$/;

/**
 * The agent the live layout shows (#906 §3) — never a name quoted in the conversation above it:
 *  - legacy: the pane's last non-empty row, only when it is the prompt row; `[name]` on it, or the default agent;
 *  - TUI / v3: the status row directly above the input row (the last `›` row; earlier `›` rows are the user's past
 *    messages, which sit above it), skipping rule rows.
 * Null when the layout cannot be read.
 */
export function readActiveKiroAgent(pane: string, ui: "legacy" | "tui" | "v3"): string | null {
  const rows = pane.split("\n").map(r => r.replace(/\s+$/, ""));
  if (ui === "legacy") {
    const last = [...rows].reverse().find(r => r.trim() !== "");
    const m = last ? LEGACY_PROMPT_ROW.exec(last) : null;
    return m ? (m[1] ?? "kiro_default") : null;
  }
  let input = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (/^\s*›/.test(rows[i]!)) { input = i; break; }
  if (input < 0) return null;
  // The live bottom layout ends with the input row: below it only blank or rule rows and the right-aligned hint
  // (`/copy to clipboard`, `/sessions to resume · …`). Anything else — a modal, a panel, output — means the pair
  // above it is not the live one (#1416 review).
  for (let i = input + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.trim() === "" || RULE_ROW.test(row) || TUI_HINT_ROW.test(row)) continue;
    return null;
  }
  for (let i = input - 1; i >= 0; i--) {
    if (RULE_ROW.test(rows[i]!)) continue;
    const m = TUI_STATUS_ROW.exec(rows[i]!);
    return m ? m[1]! : null;
  }
  return null;
}

export function planKiroLaunch(ui: "legacy" | "tui" | "v3", compat: KiroCliCompatibility): KiroLaunchPlan {
  const version = compat.version ?? "of unknown version";
  if (ui === "v3") return { kind: "launch", ui, flags: ["--v3"] };
  const engines = compat.agentEngines;
  // A binary with no engine choice at all (before 2.3) has nowhere to drift —
  // but only a version AgEnD knows proves that. Read from --help, a missing
  // selector is just a missing selector: a new release that dropped it must
  // not be launched on its default.
  const knownOld = compat.source === "version";
  const singleEngine = knownOld && engines === null && !compat.supportsV3;
  // 2.3 offered rust|kas with rust (the legacy engine) as its default. Only
  // the version table may say "this is 2.3": a newer help that happens to
  // list `rust` without v1/v2 is a new release, and its default is unknown.
  const rustEra = knownOld && engines?.includes("rust") === true && !compat.supportsV3;
  if (ui === "legacy") {
    if (!compat.supportsLegacyUi) {
      // Before 1.27 classic was the only UI: nothing to select.
      if (!compat.supportsTui && singleEngine) return { kind: "launch", ui, flags: [] };
      return {
        kind: "refuse",
        reason: `kiro-cli ${version} no longer offers the legacy UI (--legacy-ui) this instance runs on. `
          + "AgEnD will not start it on another UI or engine: its conversation would not come along (#1109). "
          + "Install a kiro-cli 2.x to keep using it; moving instances to the terminal UI is #1110.",
      };
    }
    if (engines?.includes("v1")) return { kind: "launch", ui, flags: ["--legacy-ui", "--agent-engine=v1"] };
    if (singleEngine || rustEra) return { kind: "launch", ui, flags: ["--legacy-ui"] };
    return {
      kind: "refuse",
      reason: `kiro-cli ${version} has --legacy-ui but no v1 agent engine to pin it to `
        + `(--agent-engine accepts: ${engines?.join(", ") || "nothing AgEnD recognises"}). `
        + "AgEnD will not let it pick an engine on its own (#1109).",
    };
  }
  // tui
  if (!compat.supportsTui) {
    if (singleEngine) return { kind: "launch", ui, flags: [] };
    return { kind: "refuse", reason: `kiro-cli ${version} has no --tui flag; AgEnD cannot tell which UI it would start (#1109).` };
  }
  if (engines?.includes("v2")) return { kind: "launch", ui, flags: ["--tui", "--agent-engine=v2"] };
  if (singleEngine || rustEra) return { kind: "launch", ui, flags: ["--tui"] };
  return {
    kind: "refuse",
    reason: `kiro-cli ${version} has no v2 agent engine to pin the terminal UI to `
      + `(--agent-engine accepts: ${engines?.join(", ") || "nothing AgEnD recognises"}). `
      + "AgEnD will not let it pick an engine on its own (#1109).",
  };
}

function kiroBinaryCacheKey(binaryPath: string): string {
  try {
    const stat = statSync(binaryPath);
    // Kiro may upgrade its binary in place. Metadata makes a new binary
    // generation probe again without putting synchronous CLI calls on every
    // createBackend() hot path.
    return `${binaryPath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    // If the binary is installed later, its new stat-derived key invalidates
    // this conservative "unavailable" result automatically.
    return `${binaryPath}\0unavailable`;
  }
}

/**
 * How long an "unknown" probe result is reused. A binary that exists but did
 * not answer (a 5s timeout on a loaded host) refuses its launch, and the
 * fleet's startup retry must get a fresh probe rather than the same miss.
 */
const UNKNOWN_COMPATIBILITY_TTL_MS = 60_000;

function cachedKiroCliCompatibility(binaryPath: string, run?: KiroProbeRunner): CachedKiroCompatibility {
  const cacheKey = kiroBinaryCacheKey(binaryPath);
  const cached = compatibilityCache.get(cacheKey);
  if (cached && (cached.compatibility.source !== "unknown" || Date.now() - cached.probedAt < UNKNOWN_COMPATIBILITY_TTL_MS)) {
    return cached;
  }
  const entry = { cacheKey, compatibility: probeKiroCliCompatibility(binaryPath, run), probedAt: Date.now() };
  compatibilityCache.set(cacheKey, entry);
  return entry;
}

/** Process-level memo used by backend construction; exported for regression tests. */
export function getCachedKiroCliCompatibility(
  binaryPath: string,
  run?: KiroProbeRunner,
): KiroCliCompatibility {
  return cachedKiroCliCompatibility(binaryPath, run).compatibility;
}

/** Test-only reset for the process-level compatibility and warning memo. */
export function resetKiroCompatibilityCacheForTests(): void {
  compatibilityCache.clear();
  warnedUnsupportedEffortCacheKeys.clear();
  warnedVersionGateCacheKeys.clear();
}

/** The kiro-cli compatibility AgEnD last probed for a launch: read by kiro_engine_status, which never probes itself. */
export interface KiroCompatibilitySnapshot {
  binaryPath: string;
  compatibility: KiroCliCompatibility;
  at: string;
}
let lastKiroCompatibility: KiroCompatibilitySnapshot | null = null;
export function lastKiroCompatibilitySnapshot(): KiroCompatibilitySnapshot | null {
  return lastKiroCompatibility;
}
function publishKiroCompatibility(binaryPath: string, compatibility: KiroCliCompatibility): void {
  lastKiroCompatibility = { binaryPath, compatibility, at: new Date().toISOString() };
}

/** Startup budget for a `--resume` launch (60% first output, 40% ready). */
export const KIRO_RESUME_STARTUP_BUDGET_MS = 60_000;

export class KiroBackend implements CliBackend {
  readonly binaryName = "kiro-cli";
  private replyGuardOptedIn = false;

  /** Only legacy/TUI launch plans have verified turn-end signals (#1144). */
  get replyCompletionGuard(): boolean {
    return this.replyGuardOptedIn;
  }

  private binaryPath: string;
  private compatibility: KiroCliCompatibility;
  private compatibilityCacheKey?: string;
  /** Injected by tests: never re-probed. */
  private readonly fixedCompatibility: boolean;
  private warnedUnsupportedEffort = false;
  /**
   * UI flavour and trust mode of the LAST command built. The Enter-drop
   * delivery gate (dropsEnterWhileBusy / getBottomReadyPattern) is specific to
   * the legacy UI's prompt row, so both are derived from what was actually
   * launched rather than assumed. Defaults match kiro's config defaults
   * (`kiro_ui: legacy`, `--trust-all-tools`) for a backend that has not built a
   * command yet.
   */
  private activeUi: "legacy" | "tui" | "v3" = "legacy";
  private activeTrustAll = true;
  /** Version-gate notice for the launch just built (consumeLaunchWarning). */
  private launchWarning: string | null = null;
  /**
   * What this launch attempt resumes and as which agent (#906), resolved once per attempt in writeConfig — it claims
   * conversations and records fresh starts — and read by the buildCommand that follows it.
   */
  private launchPlan: KiroInstanceLaunch | null = null;
  /** The plan of the command last built: what agentSwitch() works from. */
  private activePlan: KiroInstanceLaunch | null = null;
  private preparedV2Store: { key: string; store: KiroStoreRead } | null = null;
  private storePreparation = 0;
  private storeKey(config: CliBackendConfig): string {
    return JSON.stringify([config.instanceName, config.workingDirectory, kiroCanonicalDirectory(config.workingDirectory), config.kiroUi,
      resolveCredentialProfile(config.backendOptions), !!config.skipResume, getAgendHome(), kiroV2SessionsDir(), kiroCanonicalDirectory(kiroV2SessionsDir())]);
  }

  private readPreparedV2Store(config: CliBackendConfig): KiroStoreRead {
    if (this.preparedV2Store?.key !== this.storeKey(config)) {
      throw new KiroIdentityError("v2 session discovery was not prepared for this launch");
    }
    return this.preparedV2Store.store;
  }

  /** Metadata only: identity claims/config writes remain synchronous, after
   * the daemon rechecks its launch admission following this await. */
  async prepareLaunch(config?: CliBackendConfig): Promise<void> {
    const preparation = ++this.storePreparation;
    this.preparedV2Store = null;
    if (!config || config.kiroUi !== "tui") return;
    if (!this.fixedCompatibility) this.compatibility = cachedKiroCliCompatibility(this.binaryPath).compatibility;
    const key = this.storeKey(config);
    const plan = planKiroLaunch("tui", this.compatibility);
    if (plan.kind !== "launch" || !plan.flags.includes("--agent-engine=v2") || !this.compatibility.supportsInstanceAgent) return;
    const opts = { instance: config.instanceName, engine: "v2" as const, workingDirectory: config.workingDirectory,
      credentialProfile: resolveCredentialProfile(config.backendOptions), skipResume: config.skipResume, agendHome: getAgendHome() };
    if (kiroIdentityNeedsStore(opts)) {
      const store = await listKiroV2Sessions(config.workingDirectory, kiroV2SessionsDir());
      if (preparation === this.storePreparation && key === this.storeKey(config)) this.preparedV2Store = { key, store };
    }
  }

  constructor(private instanceDir: string, compatibility?: KiroCliCompatibility) {
    this.binaryPath = resolveBinary("kiro-cli");
    this.fixedCompatibility = compatibility !== undefined;
    if (compatibility) {
      this.compatibility = compatibility;
    } else {
      const cached = cachedKiroCliCompatibility(this.binaryPath);
      this.compatibility = cached.compatibility;
      this.compatibilityCacheKey = cached.cacheKey;
      publishKiroCompatibility(this.binaryPath, this.compatibility);
    }
  }

  requiresDeliveryEnterRetry(): boolean {
    // Kiro has no native Enter-submitted input queue, and its TUI can swallow
    // Enter while still processing a paste (post-restart redraw, or a large
    // paste on a slow host) while producing output that looks busy — so
    // observation alone cannot decide whether the message was submitted. A
    // second bare Enter is safe for Kiro on every delivery: verified live that
    // it is a no-op both at an empty prompt and during generation.
    return true;
  }

  dropsEnterWhileBusy(): boolean {
    // Verified live (kiro-cli 2.21.0, --legacy-ui): text pasted while a shell
    // tool ran surfaced in the prompt row after the turn, UNSUBMITTED, and the
    // next message's Enter submitted both as one. Enter during a turn is
    // discarded, not queued — so the daemon must not treat a quiet pane as an
    // open prompt (tool execution and backend retries are silent for seconds).
    //
    // Legacy UI with --trust-all-tools only: the gate needs a prompt row it can
    // recognise row-locally, and the daemon fails CLOSED without one. The
    // v3/new TUI paints a different screen; without trust-all the legacy row
    // would be a bare `N% >`, indistinguishable from tool output such as
    // `100% > done` — and never verified live. Both keep the silence gate until
    // their ready marker is verified.
    return this.activeUi === "legacy" && this.activeTrustAll;
  }

  /** #1405: the TUI front-end this instance was launched with, on a version listed in KIRO_STEER_VERIFIED. */
  supportsSteer(): boolean {
    if (this.activeUi === "legacy") return false;
    // compatibility.version is kiro-cli's own `--version` line ("kiro-cli 2.27.1").
    const version = parseSemver(this.compatibility.version)?.join(".");
    return version !== undefined && Object.hasOwn(KIRO_STEER_VERIFIED, version)
      && KIRO_STEER_VERIFIED[version].includes(this.activeUi);
  }

  /** #1405: the TUI composer's mode; never read on the legacy UI, whose prompt row has no such mode. */
  readSteerComposer(pane: string): SteerComposerMode | null {
    return this.activeUi === "legacy" ? null : readKiroSteerComposer(pane);
  }

  readSteerComposerText(pane: string): string | null {
    return this.activeUi === "legacy" ? null : readKiroComposerText(pane);
  }

  /**
   * Live evidence (kiro-cli 2.21.0, 2026-09-03): `--resume` prints nothing
   * until the conversation comes back from the backend ("Picking up where we
   * left off…") — >15s blank while runtime.us-east-1.kiro.dev timed out and
   * kiro retried every 10s — and the default 25s budget (15s to first output)
   * declared it dead, cleared the session, and started fresh. A fresh prompt
   * is local (~5s even with MCP), so it keeps the default budget.
   */
  getStartupBudgetMs(ctx: { resume: boolean }): number | undefined {
    return ctx.resume ? KIRO_RESUME_STARTUP_BUDGET_MS : undefined;
  }

  retriesResumeOnStartupFailure(): boolean {
    // A resume miss is far more often "the backend was slow" than "the session
    // is broken"; one more attempt before abandoning the conversation is cheap.
    return true;
  }

  getBottomReadyPattern(): RegExp | null {
    if (!this.dropsEnterWhileBusy()) return null;
    // Legacy-UI prompt row, live captures: "51% !>", "1% !> How can I help?",
    // "2% !> Not sure where to start? …" (placeholder hint shares the row), and
    // the mode-glyph form "20% λ !>". While a tool runs the bottom row is the
    // tool banner ("Purpose: …"); while generating it is "⠇ Thinking…" — neither
    // matches, which is exactly the point.
    //
    // Anchored to the ROW START: the context percentage is the first thing on
    // the prompt row, then an optional mode glyph, then the marker. Unanchored
    // (`\d+%[^\n]*[!❯>]`) matched ordinary tool output such as
    // `Progress 50% > /tmp/output` or `download 100% -> done` and declared a busy
    // pane ready. Under --trust-all-tools (the only mode the gate runs in) the
    // ASCII marker is `!>` and its `!` is REQUIRED, so a bare `100% > done` at a
    // row start is not a prompt either; the glyph form `8% ❯` (see
    // getReadyPattern) needs no `!` because `❯` never occurs in tool output.
    //
    // kiro-cli 2.14+ may prefix the prompt row with a bracketed agent name, e.g.
    // "[global_zh_tw] 31% !>" (user-defined agent names can be any string). Allow
    // an optional bracketed prefix before the percentage — but ONLY a single
    // `[name]` at the start; anything else (like `Progress [x] 50%`) must not match.
    return /^\s*(?:\[[^\]]*\]\s*)?\d+%\s*(?:[^\s\d%!❯>]{1,2}\s+)?(?:!\s?[❯>]|❯)/;
  }

  buildCommand(config: CliBackendConfig): string {
    // Fail closed before a launch, including refused/failed command builds.
    // V3 has a different engine and no verified completion signal yet (#1144).
    this.replyGuardOptedIn = false;
    const ui = config.kiroUi ?? "legacy";
    // Every launch re-reads the binary generation: a crash-respawn reuses this
    // backend, and kiro-cli may have replaced itself in place since the last
    // launch (an auto-update to a release without this instance's engine).
    // Cheap — a stat and a map lookup unless the binary changed.
    if (!this.fixedCompatibility) {
      const current = cachedKiroCliCompatibility(this.binaryPath);
      this.compatibility = current.compatibility;
      this.compatibilityCacheKey = current.cacheKey;
    }
    // What this launch is judged by, for kiro_engine_status to read without probing.
    publishKiroCompatibility(this.binaryPath, this.compatibility);
    if (this.compatibility.source === "unknown") {
      // Neither --version nor chat --help answered: a missing or wedged binary,
      // or a loaded host timing out. Launching blind could start kiro on its
      // default engine; fail this attempt and let the startup retry re-probe.
      throw new Error(`kiro-cli at ${this.binaryPath} did not answer --version or chat --help, so AgEnD cannot pin its UI and engine; not launching (#1109)`);
    }
    const plan = planKiroLaunch(ui, this.compatibility);
    if (plan.kind === "refuse") throw new UnsupportedCliError(plan.reason);
    let cmd = `${this.binaryPath} chat`;
    for (const flag of plan.flags) cmd += ` ${flag}`;
    this.noteVersionGate();
    const credentialProfile = resolveCredentialProfile(config.backendOptions);
    // #906: the plan writeConfig resolved for this attempt (a direct buildCommand, as in tests, resolves its own).
    const lp = this.launchPlan && this.launchPlan.cwd === config.workingDirectory && this.launchPlan.skipResume === !!config.skipResume
      ? this.launchPlan : this.planInstanceLaunch(config);
    this.launchPlan = null;
    this.activePlan = lp;
    this.activeSpec = lp.mode === "legacy" ? null : this.agentSpec(config);
    this.activeInstance = config.instanceName;
    recordKiroLaunch({
      instance: config.instanceName,
      workingDirectory: config.workingDirectory,
      credentialProfile,
      kiroVersion: this.compatibility.version ?? null,
      ui,
      // "--agent" marks a launch made after #906: such an instance is never adopted again (kiroLaunchedHereBefore).
      flags: lp.mode !== "legacy" ? [...plan.flags, "--agent"] : plan.flags,
    });
    // Record what is actually being launched for the delivery gate (see
    // dropsEnterWhileBusy): the legacy prompt row exists only under
    // --legacy-ui; a binary from before 1.27 paints its own classic screen.
    this.activeUi = plan.flags.includes("--legacy-ui") ? "legacy" : ui === "v3" ? "v3" : "tui";
    this.activeTrustAll = config.skipPermissions !== false;
    if (config.skipPermissions !== false) cmd += " --trust-all-tools";
    if (lp.mode !== "legacy") {
      // Its own agent: on a fresh start it takes effect at once; on a resume kiro brings back the conversation's saved
      // agent instead (E6), and the daemon switches it on screen (agentSwitch).
      cmd += ` --agent ${shellQuote(lp.agent!)}`;
      if (lp.mode === "resume") cmd += ` --resume-id ${shellQuote(lp.id!)}`;
    } else if (ui === "v3") {
      // Legacy mode, V3: it resumes only the session it owns, by id (kiro-v3-identity.ts) — its `--resume` would take
      // the newest conversation in the directory from ANY engine and convert a classic one into a new V3 copy.
      const id = resolveKiroV3Resume(config.instanceName, config.workingDirectory, credentialProfile, { skipResume: config.skipResume });
      if (id) cmd += ` --resume-id ${shellQuote(id)}`;
    } else if (!config.skipResume) {
      // Legacy mode, classic/TUI: the boolean form — kiro resumes the directory's newest conversation. Not isolated
      // between instances sharing the directory (#1410); an instance launches like this only without the
      // per-instance plan (an old kiro-cli, or a conversation store AgEnD could not read on adoption).
      cmd += " --resume";
    }
    if (config.model) {
      const model = validateModel(config.model);
      warnIfModelMismatch("kiro-cli", model);
      cmd += ` --model ${shellQuote(model)}`;
    }
    if (config.effort) {
      const effort = validateEffort(config.effort);
      if (this.compatibility.supportsEffortFlag) {
        cmd += ` --effort ${effort}`;
      } else if (this.shouldWarnUnsupportedEffort()) {
        const detected = this.compatibility.version
          ? `detected ${this.compatibility.version}`
          : "unknown version";
        console.warn(`[agend] kiro-cli ${detected} does not support the --effort launch flag (requires >= ${KIRO_EFFORT_FLAG_MIN}); configured effort "${effort}" was not applied`);
      }
    }
    // Deliberately NOT `--require-mcp-startup` (#1111). Kiro has no per-server
    // "required": the flag exits 3 when ANY enabled MCP server fails, and that
    // includes the user's own servers from ~/.kiro/settings/mcp.json. One
    // third-party server breaking on a kiro-cli update (outline, 2.27) took
    // down every kiro instance at once. Like claude and codex, a broken
    // third-party server now costs only its own tools; whether AgEnD's fleet
    // server connected is the daemon's check (fleet MCP startup watch), which
    // knows which server is which.
    const command = this.withCredentialProfile(config, cmd);
    this.replyGuardOptedIn = plan.ui === "legacy" || plan.ui === "tui";
    return command;
  }

  /**
   * Point this instance at its own copy of the kiro credential store.
   *
   * Without `credential_profile` nothing is prepended and nothing is created,
   * so an instance that has not opted in launches byte-for-byte the command it
   * launched before this existed.
   */
  private withCredentialProfile(config: CliBackendConfig, cmd: string): string {
    const profile = resolveCredentialProfile(config.backendOptions);
    if (!profile) return cmd;
    const spec = credentialHomeSpec(this.binaryName)!;
    const home = credentialProfileHome(getAgendHome(), this.binaryName, profile);
    prepareCredentialProfileHome(spec, home);
    return `${spec.env}=${shellQuote(home)} ${cmd}`;
  }

  /**
   * P3 of #1109: tell the operator, once per binary generation, when the
   * kiro-cli in use is outside the range AgEnD has run. Never blocks a launch:
   * below KIRO_SUPPORTED_MIN it still works, and above KIRO_TESTED_MAX the
   * flags were already checked against the binary's own --help.
   */
  private noteVersionGate(): void {
    const parsed = parseSemver(this.compatibility.version);
    if (!parsed) return;
    const key = this.compatibilityCacheKey ?? `instance:${this.compatibility.version}`;
    if (warnedVersionGateCacheKeys.has(key)) return;
    let warning: string | null = null;
    if (!versionAtLeast(parsed, KIRO_SUPPORTED_MIN)) {
      warning = t("kiro.version_below_supported", this.compatibility.version!, KIRO_SUPPORTED_MIN);
    } else if (versionAtLeast(parsed, nextPatch(KIRO_TESTED_MAX))) {
      warning = t("kiro.version_untested", this.compatibility.version!, KIRO_TESTED_MAX);
    }
    if (!warning) return;
    warnedVersionGateCacheKeys.add(key);
    // Appended: the launch's isolation warnings (#906, recorded by writeConfig) must not be overwritten by this one.
    this.addLaunchWarning(warning);
  }

  consumeLaunchWarning(): string | null {
    const warning = this.launchWarning;
    this.launchWarning = null;
    return warning;
  }

  private shouldWarnUnsupportedEffort(): boolean {
    if (!this.compatibilityCacheKey) {
      if (this.warnedUnsupportedEffort) return false;
      this.warnedUnsupportedEffort = true;
      return true;
    }
    if (warnedUnsupportedEffortCacheKeys.has(this.compatibilityCacheKey)) return false;
    warnedUnsupportedEffortCacheKeys.add(this.compatibilityCacheKey);
    return true;
  }

  writeConfig(config: CliBackendConfig): void {
    // WORKAROUND: kiro-cli ignores the "env" block of an MCP server entry — the server subprocess inherits the fleet
    // manager's env, with a stale AGEND_SOCKET_PATH from whichever daemon wrote last. Each server therefore runs
    // through a wrapper script that exports this instance's env and execs the real server.
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };
      const wrapperPath = join(this.instanceDir, `mcp-wrapper-${name}.sh`);
      const envExports = Object.entries(allEnv)
        .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
        .join("\n");
      // 0o700 (owner-only rwx): wrapper inlines sensitive env (tokens, socket paths).
      // Other users on the host must not be able to read it. Set mode at creation
      // to avoid a world-readable window between writeFileSync and chmodSync.
      writeFileSync(
        wrapperPath,
        `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${entry.command} ${entry.args.map((a: string) => JSON.stringify(a)).join(" ")}\n`,
        { mode: 0o700 },
      );
      // Re-chmod in case the file already existed with looser permissions (writeFileSync's
      // mode only applies on create).
      chmodSync(wrapperPath, 0o700);
    }

    // #906: which conversation this attempt resumes, and as which agent — resolved once, here.
    const plan = this.planInstanceLaunch(config);
    this.preparedV2Store = null;
    this.launchPlan = plan;
    const spec = this.agentSpec(config);
    const root = dirname(this.instanceDir);
    if (plan.mode === "legacy") {
      // Not isolated (an old kiro-cli, or adoption with an unreadable store): the shared files as before, each
      // written only where it is free, and removed only by provenance.
      if (plan.reason) this.addLaunchWarning(plan.reason);
      this.noteShared("mcp.json", writeSharedKiroMcpEntries(spec));
      if (config.instructions) this.noteShared("steering", writeTaggedKiroSteering(spec, config.instructions));
      this.noteShared("mcp.json", removeSharedKiroMcpEntries(spec, root, false));
      return;
    }
    // Throws when a file that is not this instance's agent is in the way: never overwritten, launch refused.
    writeKiroAgent(spec, config.instructions);
    if (plan.mode === "resume" && !plan.agentConfirmed) {
      // The resumed conversation comes back as its saved agent (`--agent` is ignored on resume), so until the switch
      // is confirmed on screen it gets its AgEnD server and instructions from the shared files (design §3).
      this.noteShared("mcp.json", writeSharedKiroMcpEntries(spec));
      if (config.instructions) this.noteShared("steering", writeTaggedKiroSteering(spec, config.instructions));
      this.noteShared("mcp.json", removeSharedKiroMcpEntries(spec, root, false));
      return;
    }
    // Running as its own agent: nothing of this instance belongs in the shared files any more.
    this.noteShared("mcp.json", removeSharedKiroMcpEntries(spec, root, true));
    this.noteShared("steering", removeTaggedKiroSteering(spec));
  }

  /** This instance's agent, by its fleet and its own wrapper scripts. */
  private agentSpec(config: CliBackendConfig): KiroAgentSpec {
    return {
      workingDirectory: config.workingDirectory,
      instance: config.instanceName,
      fleet: kiroFleetTag(getAgendHome()),
      instanceDir: this.instanceDir,
      serverNames: Object.keys(config.mcpServers),
    };
  }

  /** A shared file AgEnD could not bring to the state isolation needs: said, never reported as isolated. */
  private noteShared(file: "mcp.json" | "steering", outcome: string): void {
    if (outcome === "conflict") this.addLaunchWarning(t("kiro.shared_conflict", file));
    else if (outcome === "unreadable" || outcome === "failed") this.addLaunchWarning(t("kiro.shared_unreadable", file));
    else if (outcome === "untagged-legacy" && !warnedUntaggedSteering.has(this.instanceDir)) {
      warnedUntaggedSteering.add(this.instanceDir);
      this.addLaunchWarning(t("kiro.untagged_steering"));
    }
  }

  private addLaunchWarning(message: string): void {
    this.launchWarning = this.launchWarning ? `${this.launchWarning}\n${message}` : message;
  }

  /**
   * The launch plan of one attempt (#906, design §2/§5): the engine the plan pins, and — when this kiro-cli has
   * `--agent` and `--resume-id` — the conversation this instance owns and whether it already runs as its agent.
   * Anything else is legacy mode: today's command, not isolated.
   */
  private planInstanceLaunch(config: CliBackendConfig): KiroInstanceLaunch {
    const ui = config.kiroUi ?? "legacy";
    if (!this.fixedCompatibility) {
      const current = cachedKiroCliCompatibility(this.binaryPath);
      this.compatibility = current.compatibility;
      this.compatibilityCacheKey = current.cacheKey;
    }
    const plan = planKiroLaunch(ui, this.compatibility);
    const flags = plan.kind === "launch" ? plan.flags : [];
    const engine: KiroInstanceLaunch["engine"] = flags.includes("--agent-engine=v1") ? "v1"
      : flags.includes("--agent-engine=v2") ? "v2" : ui === "v3" ? "v3" : null;
    const credentialProfile = resolveCredentialProfile(config.backendOptions);
    const base = { cwd: config.workingDirectory, skipResume: !!config.skipResume, engine, credentialProfile };
    const legacy = (reason: string | null): KiroInstanceLaunch => ({ ...base, mode: "legacy", reason, agent: null, agentConfirmed: false });
    if (plan.kind !== "launch" || this.compatibility.source === "unknown") return legacy(null); // buildCommand refuses
    if (!this.compatibility.supportsInstanceAgent || !engine) {
      const key = this.compatibilityCacheKey ?? this.binaryPath;
      if (warnedNoInstanceAgentKeys.has(key)) return legacy(null);
      warnedNoInstanceAgentKeys.add(key);
      return legacy(t("kiro.no_instance_agent", this.compatibility.version ?? "?", KIRO_INSTANCE_AGENT_MIN));
    }
    const agent = kiroAgentName(config.instanceName, kiroFleetTag(getAgendHome()));
    const agendHome = getAgendHome();
    let decision: KiroIdentityDecision;
    if (engine === "v3") {
      // V3 keeps its own identity (kiro-v3-identity.ts); only whether it runs as the agent is recorded here.
      const id = resolveKiroV3Resume(config.instanceName, config.workingDirectory, credentialProfile, { skipResume: config.skipResume });
      decision = id
        ? { mode: "resume", id, agentConfirmed: kiroAgentConfirmed(agendHome, config.instanceName, "v3", config.workingDirectory, credentialProfile, id) }
        : { mode: "fresh" };
    } else {
      decision = resolveKiroIdentity({
        instance: config.instanceName,
        engine,
        workingDirectory: config.workingDirectory,
        credentialProfile,
        skipResume: config.skipResume,
        agendHome,
        readStore: () => engine === "v1"
          ? listKiroV1Sessions(config.workingDirectory, kiroV1DbPath(credentialProfile))
          : this.readPreparedV2Store(config),
        launchedBefore: () => kiroLaunchedHereBefore(config.instanceName, config.workingDirectory, credentialProfile, engine),
      });
    }
    if (decision.mode === "legacy") return legacy(t("kiro.identity_legacy", decision.reason));
    return decision.mode === "resume"
      ? { ...base, mode: "resume", id: decision.id, agent, agentConfirmed: decision.agentConfirmed, reason: null }
      : { ...base, mode: "fresh", agent, agentConfirmed: true, reason: null };
  }

  /**
   * After a resume as the instance's agent (#906 §3): what the daemon needs to read the active agent off the live
   * layout and, when it is not ours, switch to it with `/agent swap` and confirm. Null when there is nothing to do.
   */
  agentSwitch(): BackendAgentSwitch | null {
    const plan = this.activePlan;
    if (!plan || plan.mode !== "resume" || !plan.agent || !plan.id || !plan.engine) return null;
    const { agent, id, engine, cwd, credentialProfile } = plan;
    const ui = this.activeUi;
    return {
      agent,
      alreadyConfirmed: plan.agentConfirmed,
      readActive: (pane: string) => readActiveKiroAgent(pane, ui),
      command: `/agent swap ${agent}`,
      confirm: () => {
        const warnings: string[] = [];
        if (!this.activeInstance || !confirmKiroAgentSwitch(getAgendHome(), this.activeInstance, engine, cwd, credentialProfile, id)) {
          warnings.push(t("kiro.switch_unrecorded"));
          return warnings;
        }
        plan.agentConfirmed = true;
        const spec = this.activeSpec;
        if (spec) {
          const mcp = removeSharedKiroMcpEntries(spec, dirname(this.instanceDir), true);
          if (mcp === "unreadable" || mcp === "failed") warnings.push(t("kiro.shared_unreadable", "mcp.json"));
          const steering = removeTaggedKiroSteering(spec);
          if (steering === "failed" || steering === "unreadable") warnings.push(t("kiro.shared_unreadable", "steering"));
        }
        return warnings;
      },
    };
  }

  /**
   * An instance running as its own agent reads its instructions from the agent file's prompt (#906). Until a resumed
   * conversation's switch is confirmed it still runs as its saved agent, reading the steering file (the default).
   */
  instructionsSource(): string | null {
    const plan = this.activePlan;
    return plan && plan.mode !== "legacy" && plan.agent && plan.agentConfirmed ? `.kiro/agents/${plan.agent}.json (its "prompt" field)` : null;
  }

  private activeSpec: KiroAgentSpec | null = null;
  private activeInstance: string | null = null;

  getReadyPattern(): RegExp {
    // Startup: trust/banner text. Daily prompt: "22% !>" / "8% ❯";
    // Kiro may insert mode glyphs between them, e.g. "20% λ !>".
    // TUI statusline: the context indicator shown while waiting for input,
    // e.g. "◑ 27%". The glyph steps through PIE_GLYPHS as the window fills,
    // so all of them have to match — not just the low-usage "◔".
    return new RegExp(
      `All tools are now trusted|Trust All Tools active|Credits:.*Time:`
      + `|ask a question or describe a task|\\d+%.*[!❯>]|${PIE_CLASS}\\s*\\d+%`,
      "m",
    );
  }

  getBusyPattern(): RegExp {
    // Live legacy-UI capture (2026-08-13): Kiro leaves its ordinary ready
    // statusline ("64% λ !>") on screen while the model is generating, and
    // paints a separate braille-spinner line such as "⠹ Thinking...".  The
    // ready marker therefore cannot distinguish idle from thinking by itself.
    //
    // Kiro does not always erase the spinner row after a turn. A multiline
    // search across the whole pane therefore treated a historical spinner as
    // live forever, even when a newer `72% λ !>` prompt was visible below it.
    // The live spinner is the last non-blank row in every captured working
    // frame; require that position so completed-turn history cannot veto ready.
    // Use horizontal whitespace explicitly — `\s` would cross row boundaries.
    // TUI/v2 also leaves its context-ready indicator visible while working.
    // Live 2.27.1 capture: the bottom composer becomes "› Kiro is working ·
    // 1s · Type to steer · Ctrl+S to queue". Only that live bottom row vetoes
    // idle; historical copies above a fresh prompt must not pin it busy.
    return /(?:^|\n)[ \t]*[\u2800-\u28ff][ \t]+(?:Thinking|Working)(?:\.{3}|…)[ \t]*(?:\n[ \t]*)*$|(?:^|\n)[ \t]*›[ \t]+Kiro is working[ \t]+·[^\n]*(?:\n[ \t]*)*$/i;
  }

  /**
   * The tool kiro is running right now, for the live progress line.
   *
   * kiro announces every tool call in the pane and reports its completion
   * separately. Captured from a live pane:
   *
   *   I will run the following command: … (using tool: shell)
   *   Purpose: Merge #419
   *    - Completed in 67.914s
   *
   * So "running" is not a marker but a *relationship*: the last announcement with
   * no completion line after it. Comparing positions is what makes this usable —
   * matching `(using tool: …)` alone would leave the last tool of the turn pinned
   * to the progress line forever.
   *
   * `Purpose:` is included when kiro emitted one, because "shell: Merge #419" says
   * far more than "shell". It is agent-written text; the caller flattens and caps
   * it.
   */
  getPaneActivity(pane: string): string | null {
    const announcements = [...pane.matchAll(/\(using tool: ([^)\n]+)\)/g)];
    const last = announcements.at(-1);
    if (last?.index === undefined) return null; // index 0 is a valid position

    const after = pane.slice(last.index);
    if (/^\s*-\s*Completed in\b/m.test(after)) return null; // that tool has finished

    const purpose = after.match(/^\s*Purpose:\s*(.+)$/m);
    return purpose ? `${last[1]}: ${purpose[1].trim()}` : last[1];
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /model.*not available|Please use '\/model'/i, type: "model_error", action: "notify", message: "Model unavailable — use /model to switch" },
      { pattern: /Response timed out/i, type: "timeout", action: "notify", message: "Kiro response timed out (generation too long) — please try again", skipCooldown: true, skipRecoveryWait: true },
      // Session/login expiry. kiro had NO auth pattern, so an expired login was
      // silent: it kept accepting work and failing every turn. Strings taken from
      // the kiro-cli binary itself ("You are not logged in, please log in with",
      // AWS SSO "ExpiredTokenException", "no device registration found for token")
      // rather than guessed. Deliberately specific — bare "Unauthorized"/"Not
      // logged in" would false-positive on an agent merely discussing auth code.
      {
        // Ordering is load-bearing: the monitor takes the FIRST matching pattern,
        // and kiro prints `Kiro is having trouble responding right now:` as the
        // header for *every* failure kind — so the generic entry (now last) used
        // to swallow auth failures and label them "Rate limit". Worse than the
        // wrong label: classified as rate_limit it only notified, so the
        // auth auto-pause never fired and the instance kept feeding messages to a
        // CLI that could not answer (issue #440).
        //
        // `No token` / `dispatch failure` are what an expired-or-missing login
        // actually prints at runtime; the other three come from the kiro-cli
        // binary. The No-token alternative is anchored to kiro's numbered error
        // list (`   2: dispatch failure (other): No token`) rather than matched as
        // a bare keyword, because this fleet maintains AgEnD and an agent quoting
        // this very error must not pause itself.
        // The last alternative is the sign-in screen kiro-cli drops to BY
        // ITSELF when the stored token expires (kiro-cli 2.14.2). It prints no
        // error at all — the prompt is simply replaced — so none of the strings
        // above appear, nothing matches, and the pane then sits unchanged until
        // the hang detector reports "no screen change for 10 minutes, no ready
        // prompt": a whole fleet of kiro instances showing "working / possibly
        // stuck" with deliveries failing, when the real answer was "log in
        // again" (reported by an external user on AgEnD beta.13).
        //
        // It lives in THIS entry rather than a new one on purpose: same cause,
        // same remedy, same action, so one message covers both and the
        // first-match ordering above stays intact.
        //
        // Both of its lines are required together (the binary contains
        // ", let's get you signed in!" — the product name is runtime-filled),
        // so a transcript quoting one of them is not a sign-in screen. Any
        // match here is still only a TRIGGER: the lifecycle confirms every
        // auth_error with the token-free `kiro-cli whoami` probe before pausing
        // anything, and drops it when the credentials turn out to be fine.
        pattern: new RegExp(
          "You are not logged in|ExpiredTokenException|no device registration found for token"
          + "|Access denied:.*bearer token.*invalid"
          + "|^\\s*\\d+:\\s*(?:dispatch failure[^\\n]*?)?No token\\s*$"
          + `|${KIRO_EXPIRED_LOGIN_SCREEN.source}`,
          "im",
        ),
        type: "auth_error",
        action: "pause",
        message: "Kiro login is missing or expired — run `kiro-cli login` to restore all kiro instances",
      },
      // Backend unreachable. Live 2026-09-03: runtime.us-east-1.kiro.dev stopped
      // answering for hours; every kiro instance printed
      //   `1: dispatch failure (timeout): request timed out: error sending
      //    request for url (https://runtime.us-east-1.kiro.dev/)`
      // and retried every 10s. Distinct from the auth line above
      // (`dispatch failure (other): No token`, matched first). fleetWide: this is
      // one outage, not N incidents — the lifecycle notifies once and the daemon
      // stops burning `--resume` attempts (and sessions) while it lasts.
      // skipRecoveryWait: kiro is back at its prompt between retries.
      //
      // Matched on kiro's numbered error structure (`   1: dispatch failure
      // (timeout)` at a row start — the live line wraps after it, which is why
      // the URL alternative is unanchored) rather than on the bare phrase: an
      // agent quoting "dispatch failure (timeout)" in conversation must not mark
      // the whole backend down and change every instance's startup semantics.
      // The URL alternative requires the complete sentence plus a kiro.dev host.
      {
        pattern: /^\s*\d+:\s*dispatch failure \(timeout\)|request timed out: error sending request for url \((https?:\/\/[^)\s]*kiro\.dev[^)\s]*)\)/im,
        type: "network",
        action: "notify",
        message: "Kiro backend unreachable — requests to the kiro.dev runtime are timing out",
        formatMessage: match => {
          const host = match[1]?.match(/^https?:\/\/([^/]+)/)?.[1];
          return host
            ? `Kiro backend unreachable — requests to ${host} are timing out`
            : "Kiro backend unreachable — requests to the kiro.dev runtime are timing out";
        },
        skipRecoveryWait: true,
        fleetWide: true,
      },
      // #384: the AgEnD MCP server died, or something wrote non-JSON-RPC to its
      // stdout and kiro dropped the connection. kiro keeps running and keeps
      // answering, so nothing looks broken — but every fleet tool is gone, which
      // for an AgEnD instance means it can no longer reply, report, or delegate.
      // It cannot reconnect in-session; only a restart re-establishes the
      // transport, which is why this is the one kiro error with action "restart".
      //
      // Both alternatives are matched on their full structure rather than on a
      // keyword. An agent discussing this very failure — plausible in a fleet that
      // maintains AgEnD — must not restart itself, so "MCP" or "transport closed"
      // alone would be far too eager. The quoted server name and the complete
      // stdout sentence are things kiro prints, not things people paraphrase.
      //
      // No skipCooldown: if MCP is broken in a way a restart cannot fix, the
      // default 5-minute per-pattern cooldown is what keeps this from becoming a
      // restart loop.
      {
        pattern: /Transport to MCP server '[^']+' is closed|non-JSON-RPC output to stdout which caused the connection to close/,
        type: "crash",
        action: "restart",
        message: "MCP transport closed — fleet tools were unavailable, restarting to reconnect",
        // No formatMessage. The obvious thing to extract is the quoted server
        // name, but it is always `agend-<instance-name>` and the notification is
        // already addressed to that instance — it would restate the one thing the
        // reader already knows. It would also only work half the time:
        // resolveErrorMessage formats the LAST match in the pane, and kiro prints
        // the stdout sentence after the transport line, so the name is usually not
        // in the match that gets formatted.
      },
      // Real throttling, matched on the exceptions kiro actually raises (all four
      // are present in the binary) rather than on the shared header.
      {
        pattern: /ThrottlingException|TooManyRequestsException|RequestThrottledException|SlowDownException/,
        type: "rate_limit",
        action: "notify",
        message: "Kiro is being throttled by the service — retry shortly",
      },
      // LAST on purpose: this header wraps every failure kind, so it must only
      // catch what nothing above explained. Message no longer claims a rate limit
      // — that assertion is what sent operators looking at quota for an auth bug.
      // (Dedup is keyed by `type:pattern.source`, so this keeps its own baseline
      // independent of the throttling entry above.)
      {
        pattern: /having trouble responding/i,
        type: "rate_limit",
        action: "notify",
        message: "Kiro reported a failure — see the instance pane for the cause",
      },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      ...KIRO_ENGINE_PROMPT_DIALOGS,
      ...kiroTrustPromptDialogs(this.activeTrustAll),
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      // The engine prompts can paint after the startup scan has moved on.
      ...KIRO_ENGINE_PROMPT_DIALOGS,
      {
        // A service/model outage can drop Kiro into the interactive /model
        // picker. Its choices range across credit multipliers and capability
        // tiers, so this must be a human decision, never an automatic Enter or
        // Escape. The ordinary /model menu alone is intentionally not matched.
        pattern: /^\s*Select model \(type to search\):\s*$/m,
        keys: [],
        description: "Kiro model unavailable — choose a replacement model in the instance pane",
        blocksDelivery: true,
        holdOnly: true,
        inputBlocked: true,
        isActive: kiroUnavailableModelPickerActive,
      },
      {
        // Any active /model picker owns stdin, even if a future Kiro release
        // changes the exact warning, credit wording or row layout. Keep this
        // after the verified-outage case: it never labels /model as an outage.
        pattern: /^\s*Select model \(type to search\):\s*$/m,
        keys: [],
        description: "Kiro model picker — manual selection required",
        blocksDelivery: true,
        holdOnly: true,
        inputBlocked: true,
        isActive: kiroModelPickerAtTail,
      },
      ...kiroTrustPromptDialogs(this.activeTrustAll),
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // Kiro manages sessions internally via SQLite keyed by working directory.
    // No external session ID needed — --resume handles it automatically.
    return null;
  }

  getQuitCommand(): string { return "/quit"; }

  getCompactCommand(): string { return "/compact"; }
  getClearCommand(): string { return "/clear"; }
  getClearConfirmationDialog(): RuntimeDialog {
    return {
      pattern: /Are you sure\?[\s\S]{0,240}?This will erase the conversation history[\s\S]{0,240}?\[y\/n\]:/i,
      keys: ["y", "Enter"],
      description: "Kiro conversation clear confirmation — auto-confirm",
    };
  }

  // kiro's in-session `/model` opens an interactive picker (not a one-shot
  // command), so a runtime paste can't select a specific model — use restart.
  getModelSwitchStrategy(): "runtime" | "restart" { return "restart"; }

  /**
   * Parse `chat --list-models --format json` once. Verified format:
   * `{ "models": [{ model_name, model_id, description, ... }], "default_model": "auto" }`.
   * A bare array (older/other shape) is tolerated. Never throws.
   */
  private readModelsPayload(): { models: import("./types.js").ModelOption[]; defaultModel?: string } {
    try {
      const out = execFileSync(this.binaryPath, ["chat", "--list-models", "--format", "json"],
        { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const parsed = JSON.parse(out);
      const arr: unknown[] = Array.isArray(parsed) ? parsed : (parsed?.models ?? []);
      const models = arr.map((m: unknown) => {
        if (typeof m === "string") return { id: m, label: m };
        const o = m as Record<string, unknown>;
        const id = String(o.model_id ?? o.id ?? o.name ?? o.model ?? "");
        const label = String(o.model_name ?? o.name ?? o.label ?? id);
        const desc = typeof o.description === "string" ? o.description : undefined;
        return desc ? { id, label, description: desc } : { id, label };
      }).filter(o => o.id);
      const dm = Array.isArray(parsed) ? undefined : parsed?.default_model;
      return { models, defaultModel: typeof dm === "string" && dm.trim() ? dm.trim() : undefined };
    } catch { /* unknown flag/format — fall back to free-text */ }
    return { models: [] };
  }

  async listModels(): Promise<import("./types.js").ModelOption[]> {
    return this.readModelsPayload().models;
  }

  async probeCLIEnv() {
    const { models, defaultModel } = this.readModelsPayload();
    return { version: this.compatibility.version, models, currentModel: defaultModel };
  }

  // kiro-cli interrupts generation on Ctrl+C (others use Escape).
  getCancelKey(): string { return "C-c"; }

  // `kiro-cli chat --effort <EFFORT>` (low|medium|high|xhigh|max) — it is on the
  // `chat` SUBCOMMAND, which is why a top-level `--help` search misses it. No
  // `/effort` in the TUI command table, so changing it needs a respawn. Keep
  // this capability surface stable when the binary is absent or old; buildCommand
  // is the compatibility boundary that omits an unsupported flag and warns.
  getEffortStrategy(): "runtime" | "restart" { return EFFORT_CAPABILITIES["kiro-cli"].strategy; }
  getEffortLevels(): string[] { return [...EFFORT_CAPABILITIES["kiro-cli"].levels]; }

  cleanup(config: CliBackendConfig): void {
    // By provenance only (#906 §4/§6): the agent file and its .bak when they are this instance's, the shared mcp.json
    // entries run by this instance's own wrappers, and a steering file carrying this fleet's tag for it. The user's,
    // another fleet's, and untagged steering from before the tag existed are kept.
    try {
      const spec = this.agentSpec(config);
      removeKiroAgent(spec);
      removeSharedKiroMcpEntries(spec, dirname(this.instanceDir), true);
      removeTaggedKiroSteering(spec);
    } catch { /* best effort */ }
  }

  /** Delete or replace: forget which conversations this instance owns (they stay in kiro's store). */
  forget(instanceName: string): void {
    try { forgetKiroIdentity(getAgendHome(), instanceName); } catch { /* best effort */ }
    try { forgetKiroV3Identity(instanceName, getAgendHome()); } catch { /* best effort */ }
  }
}
