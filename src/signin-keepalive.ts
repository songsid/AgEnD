/**
 * #3292: "Keep sign-in alive" — an opt-in, per-sign-in daily refresh for Claude Code and Codex logins nothing else is using,
 * so an idle account does not lapse unnoticed, and a Needs-you item when one cannot be kept (or is about to end anyway).
 *
 * What refreshes, measured (static reading of Claude Code 2.1.319 and codex rust-v0.167.0, then the offline rigs in
 * scripts/manual/signin-keepalive/ and one maintainer-approved real check each, #3292 comments 6703454802 / 6703504753):
 * - Claude Code: `claude auth status --json` makes no model call; the start-up it shares with every subcommand renews the
 *   access token when it is expired or within five minutes of expiry (a server feature gate may turn that off for
 *   subcommands). Whether it did is read back from `.credentials.json` (`expiresAt` moved). A failed refresh the server
 *   refuses (`invalid_grant`) blanks the stored login (`expiresAt` 0, no refresh token) while `auth status` still says
 *   signed in, so "sign in again" is read from the file too, never from the answer. The login also has an absolute end
 *   (`refreshTokenExpiresAt`) a refresh can never move: that is warned about from ten days before, whatever this does.
 * - Codex: `codex login status` never refreshes. `codex app-server` → `account/read {refreshToken:true}` forces one with
 *   no model call. It answers the same either way; what happened is read back: `last_refresh` in `auth.json` moved (it
 *   refreshed), the answer's account is null (the server refused the refresh token: sign in again), else a transient
 *   failure. It runs in a scratch CODEX_HOME whose `auth.json` is a link to the sign-in's own file (the same layout an
 *   agent's home uses), so the refresh lands in that file and nothing else is written beside it. Codex refresh tokens
 *   are single-use: a sign-in a running agent or room uses is never refreshed here (its use keeps it alive anyway).
 *
 * Never: a token value read out of a file (only dates, booleans and a plan name leave the readers), any CLI output
 * logged or kept, a user-visible session, the default sign-in touched unless it is itself switched on, or a model call
 * — except the Claude fallback a person switched on for that one sign-in (a single tiny request, disclosed in the UI).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "./child-process.js";
import { parseClaudeAuthStatus } from "./claude-auth-status.js";
import { writeFileAtomic } from "./backend/kiro-engine-ledger.js";
import { isCredentialProfileName } from "./backend/credential-profile.js";

export const KEEPALIVE_BACKENDS = Object.freeze(["claude-code", "codex"] as const);
export type KeepAliveBackend = typeof KEEPALIVE_BACKENDS[number];
export const isKeepAliveBackend = (b: unknown): b is KeepAliveBackend => typeof b === "string" && (KEEPALIVE_BACKENDS as readonly string[]).includes(b);

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Claude Code's own window: it renews when the access token expires within five minutes. */
export const CLAUDE_REFRESH_WINDOW_MS = 5 * MIN;
/** Codex refreshes by itself after eight days; this keeps a margin under that. */
export const CODEX_REFRESH_AFTER_MS = 6 * DAY;
/** Claude Code's own warning starts ten days before the sign-in ends. */
export const END_WARNING_MS = 10 * DAY;
/** A transient failure becomes a Needs-you item on its second run in a row, or 48 hours after the first. */
export const TRANSIENT_RUNS = 2;
export const TRANSIENT_MS = 48 * HOUR;
/** Each sign-in is looked at about once a day; the timer itself wakes hourly. */
export const RUN_EVERY_MS = 23 * HOUR;
const WAKE_MS = HOUR, FIRST_WAKE_MS = 3 * MIN, SOON_MS = 2_000;
const CLAUDE_TIMEOUT_MS = 60_000, FALLBACK_TIMEOUT_MS = 120_000, CODEX_TIMEOUT_MS = 60_000;

export const SETTINGS_FILE = "signin-keepalive.json";
const WORK_DIR = "signin-keepalive";

// ── What a run decides ─────────────────────────────────────────────────────────────────────────────────────────

export type Outcome =
  | "refreshed" | "fallback_refreshed" | "not_needed" | "checked"   // fine ("checked": signed in, the renewal not readable — macOS Keychain)
  | "in_use" | "unsupported"                                       // left alone
  | "not_renewed" | "needs_sign_in" | "transient";                 // wants attention (transient: after a while)

export interface KeepAliveRecord {
  lastAt?: number;
  outcome?: Outcome;
  /** Epoch ms; dates only. */
  expiresAt?: number;
  endsAt?: number;
  lastRefresh?: number;
  planType?: string;
  failCount?: number;
  failSince?: number;
  attentionSince?: number;
}
export interface KeepAliveEntry { backend: KeepAliveBackend; profile: string | null; enabled: boolean; fallback?: boolean; record?: KeepAliveRecord }

/** What a sign-in's file says, without any token: Claude Code's `.credentials.json`. */
export type ClaudeMeta =
  | { state: "ok"; expiresAt?: number; endsAt?: number; hasRefresh: boolean; plan?: string }
  | { state: "missing" } | { state: "unreadable" };
/** Codex's `auth.json`. */
export type CodexMeta =
  | { state: "ok"; lastRefresh?: number; accessExp?: number; planType?: string; hasRefresh: boolean }
  | { state: "missing" } | { state: "api_key" } | { state: "unreadable" };

const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;

function readJson(path: string): { ok: true; value: Record<string, any> } | { ok: false; missing: boolean } {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (err) { return { ok: false, missing: (err as NodeJS.ErrnoException).code === "ENOENT" }; }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? { ok: true, value: value as Record<string, any> } : { ok: false, missing: false };
  } catch { return { ok: false, missing: false }; }
}

/** Claude Code's stored login, as dates and booleans. */
export function readClaudeMeta(home: string): ClaudeMeta {
  const r = readJson(join(home, ".credentials.json"));
  if (!r.ok) return r.missing ? { state: "missing" } : { state: "unreadable" };
  const o = r.value.claudeAiOauth;
  if (!o || typeof o !== "object") return { state: "missing" };
  const expiresAt = num(o.expiresAt), endsAt = num(o.refreshTokenExpiresAt);
  const plan = typeof o.subscriptionType === "string" && /^[a-z0-9_-]{1,32}$/i.test(o.subscriptionType) ? o.subscriptionType.toLowerCase() : undefined;
  return { state: "ok", hasRefresh: nonEmpty(o.refreshToken), ...(expiresAt !== undefined ? { expiresAt } : {}), ...(endsAt !== undefined ? { endsAt } : {}), ...(plan ? { plan } : {}) };
}

/** A JWT's payload, decoded for its claims only (never verified: only dates and a plan name are read from it). */
function jwtClaims(token: unknown): Record<string, any> | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part || part.length > 16_384) return undefined;
  try { const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8")); return v && typeof v === "object" ? v as Record<string, any> : undefined; } catch { return undefined; }
}

/** Codex's `auth.json`, as dates, a plan name and booleans. */
export function readCodexMeta(authJson: string): CodexMeta {
  const r = readJson(authJson);
  if (!r.ok) return r.missing ? { state: "missing" } : { state: "unreadable" };
  const tokens = r.value.tokens;
  if (!tokens || typeof tokens !== "object" || !nonEmpty(tokens.access_token)) return nonEmpty(r.value.OPENAI_API_KEY) ? { state: "api_key" } : { state: "missing" };
  const lr = typeof r.value.last_refresh === "string" ? Date.parse(r.value.last_refresh) : NaN;
  const exp = num(jwtClaims(tokens.access_token)?.exp);
  const plan = jwtClaims(tokens.id_token)?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
  return {
    state: "ok", hasRefresh: nonEmpty(tokens.refresh_token),
    ...(Number.isFinite(lr) ? { lastRefresh: lr } : {}), ...(exp !== undefined ? { accessExp: exp * 1000 } : {}),
    ...(typeof plan === "string" && /^[a-z0-9_-]{1,32}$/i.test(plan) ? { planType: plan.toLowerCase() } : {}),
  };
}

export const claudeDue = (m: { expiresAt?: number }, now: number): boolean => m.expiresAt === undefined || m.expiresAt <= now + CLAUDE_REFRESH_WINDOW_MS;
export const codexDue = (m: { lastRefresh?: number; accessExp?: number }, now: number): boolean =>
  m.lastRefresh === undefined || now - m.lastRefresh >= CODEX_REFRESH_AFTER_MS || m.lastRefresh > now + HOUR
  || (m.accessExp !== undefined && m.accessExp <= now + CLAUDE_REFRESH_WINDOW_MS);
/** A Claude login with no refresh token left, or one the CLI blanked after the server refused it. */
const claudeDead = (m: ClaudeMeta): boolean => m.state === "ok" && (!m.hasRefresh || m.expiresAt === 0);

/** The record after a run's outcome: failures counted, attention dated (pure). */
export function nextRecord(prev: KeepAliveRecord | undefined, outcome: Outcome, now: number, facts: Partial<KeepAliveRecord> = {}): KeepAliveRecord {
  const base: KeepAliveRecord = { ...(prev ?? {}), ...facts, lastAt: now, outcome };
  if (outcome === "transient") {
    const failCount = (prev?.outcome === "transient" ? prev.failCount ?? 0 : 0) + 1;
    const failSince = prev?.outcome === "transient" && prev.failSince !== undefined ? prev.failSince : now;
    const due = failCount >= TRANSIENT_RUNS || now - failSince >= TRANSIENT_MS;
    return { ...base, failCount, failSince, attentionSince: due ? (prev?.outcome === "transient" && prev.attentionSince !== undefined ? prev.attentionSince : now) : undefined };
  }
  const { failCount: _c, failSince: _s, attentionSince: _a, ...rest } = base;
  if (outcome === "needs_sign_in" || outcome === "not_renewed") {
    return { ...rest, attentionSince: prev?.outcome === outcome && prev.attentionSince !== undefined ? prev.attentionSince : now };
  }
  return rest;
}

export type AttentionKind = "needs_sign_in" | "not_renewed" | "transient" | "ending" | "ended";
export interface KeepAliveAttention { backend: KeepAliveBackend; profile: string | null; kind: AttentionKind; since: number; endsAt?: number; failedSince?: number }

/** What wants a person now, from the switched-on sign-ins' records (pure; the end date is recomputed on each read). */
export function attentionOf(entries: readonly KeepAliveEntry[], now: number): KeepAliveAttention[] {
  const out: KeepAliveAttention[] = [];
  for (const e of entries) {
    if (!e.enabled || !e.record) continue;
    const r = e.record;
    if ((r.outcome === "needs_sign_in" || r.outcome === "not_renewed" || r.outcome === "transient") && r.attentionSince !== undefined) {
      out.push({ backend: e.backend, profile: e.profile, kind: r.outcome, since: r.attentionSince, ...(r.outcome === "transient" && r.failSince !== undefined ? { failedSince: r.failSince } : {}) });
    }
    // The end date: a refresh cannot move it, so it is said even when everything else is fine (not twice when a sign-in is already asked for).
    if (r.endsAt !== undefined && r.endsAt - now <= END_WARNING_MS && r.outcome !== "needs_sign_in") {
      out.push({ backend: e.backend, profile: e.profile, kind: r.endsAt <= now ? "ended" : "ending", since: Math.min(now, r.endsAt - END_WARNING_MS), endsAt: r.endsAt });
    }
  }
  return out;
}

// ── Settings file ──────────────────────────────────────────────────────────────────────────────────────────────

const entryKey = (backend: string, profile: string | null) => `${backend}:${profile ?? ""}`;

/** Read the settings (and each sign-in's last record). Anything malformed is dropped, never guessed at. */
export function readEntries(dataDir: string): KeepAliveEntry[] {
  const r = readJson(join(dataDir, SETTINGS_FILE));
  if (!r.ok || !Array.isArray(r.value.entries)) return [];
  const seen = new Set<string>(), out: KeepAliveEntry[] = [];
  for (const raw of r.value.entries as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, any>;
    const profile = e.profile === null ? null : typeof e.profile === "string" && isCredentialProfileName(e.profile) ? e.profile : undefined;
    if (!isKeepAliveBackend(e.backend) || profile === undefined || typeof e.enabled !== "boolean") continue;
    const k = entryKey(e.backend, profile);
    if (seen.has(k)) continue;
    seen.add(k);
    const rec = e.record && typeof e.record === "object" ? cleanRecord(e.record) : undefined;
    out.push({ backend: e.backend, profile, enabled: e.enabled, ...(e.backend === "claude-code" && e.fallback === true ? { fallback: true } : {}), ...(rec ? { record: rec } : {}) });
  }
  return out;
}
const OUTCOMES: ReadonlySet<string> = new Set(["refreshed", "fallback_refreshed", "not_needed", "checked", "in_use", "unsupported", "not_renewed", "needs_sign_in", "transient"]);
function cleanRecord(r: Record<string, any>): KeepAliveRecord | undefined {
  const out: KeepAliveRecord = {};
  for (const k of ["lastAt", "expiresAt", "endsAt", "lastRefresh", "failCount", "failSince", "attentionSince"] as const) { const v = num(r[k]); if (v !== undefined) out[k] = v; }
  if (typeof r.outcome === "string" && OUTCOMES.has(r.outcome)) out.outcome = r.outcome as Outcome;
  if (typeof r.planType === "string" && /^[a-z0-9_-]{1,32}$/.test(r.planType)) out.planType = r.planType;
  return Object.keys(out).length ? out : undefined;
}
export function writeEntries(dataDir: string, entries: readonly KeepAliveEntry[]): void {
  writeFileAtomic(join(dataDir, SETTINGS_FILE), JSON.stringify({ version: 1, entries }, null, 2) + "\n");
}

// ── The CLI runs (the only parts that start a process) ─────────────────────────────────────────────────────────

export interface ClaudeStatusRun { code: number | null; loggedIn: boolean | null; loginExpiresAt?: number }
export interface CodexRefreshRun { answered: boolean; accountNull: boolean }
/**
 * Each run resolves only once its CLI has exited (#3313 review P2: the sign-in's writer is not done before that), and
 * `signal` stops it: SIGINT, then SIGKILL. A child that cannot be ended keeps its run (and so its hold) unresolved.
 */
export interface KeepAliveRunners {
  /** `claude auth status --json`; `configDir` null: the CLI's default sign-in (CLAUDE_CONFIG_DIR left as the fleet has it). */
  claudeStatus(configDir: string | null, cwd: string, signal: AbortSignal): Promise<ClaudeStatusRun>;
  /** The opt-in fallback: one tiny `claude -p` on the smallest model, no tools, no MCP, no settings, no saved session. */
  claudeFallback(configDir: string | null, cwd: string, signal: AbortSignal): Promise<{ code: number | null }>;
  /** `codex app-server` → initialize → `account/read {refreshToken:true}`, CODEX_HOME = `runHome`. */
  codexRefresh(runHome: string, signal: AbortSignal): Promise<CodexRefreshRun>;
}

/** Variables a keep-alive run never inherits: another credential would answer instead of the sign-in being kept. */
const STRIP_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_PROFILE", "OPENAI_API_KEY", "CODEX_API_KEY"];
function runEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return { ...env, DISABLE_AUTOUPDATER: "1", ...extra };
}

const KILL_AFTER_MS = 5_000, CODEX_EXIT_GRACE_MS = 5_000;
type Child = ReturnType<typeof spawn>;
/** `exited`: the child's exit code once it has exited — never before (null: by a signal, or it never started). `stop()`: SIGINT, then SIGKILL. */
export function watchChild(child: Child): { exited: Promise<number | null>; stop(): void } {
  let stopping = false;
  const exited = new Promise<number | null>(resolve => {
    child.once("exit", code => resolve(typeof code === "number" ? code : null));
    child.once("error", () => { if (child.pid === undefined) resolve(null); });   // it never started: nothing to wait for
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { child.kill("SIGINT"); } catch { /* gone */ }
    const k = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, KILL_AFTER_MS);
    k.unref?.();
    void exited.then(() => clearTimeout(k));
  };
  return { exited, stop };
}

/** Run a CLI to its exit; keep only its stdout (bounded) for the caller to parse, never log it. Code null: timed out, stopped, or did not start. */
async function runCli(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; signal: AbortSignal }): Promise<{ code: number | null; stdout: string }> {
  if (opts.signal.aborted) return { code: null, stdout: "" };
  let child: Child;
  try { child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); } catch { return { code: null, stdout: "" }; }
  let stdout = "", cut = false;
  child.stdout?.on("data", (d: Buffer) => { if (stdout.length < 64 * 1024) stdout += d.toString("utf8"); });
  const w = watchChild(child);
  const end = () => { cut = true; w.stop(); };
  const timer = setTimeout(end, opts.timeoutMs); timer.unref?.();
  opts.signal.addEventListener("abort", end, { once: true });
  try { const code = await w.exited; return { code: cut ? null : code, stdout }; }
  finally { clearTimeout(timer); opts.signal.removeEventListener("abort", end); }
}

/** The runners for these binaries (tests point them at a scratch fake; the fleet uses `claude` and `codex` from PATH). */
export function makeRunners(bin: { claude: string; codex: string }): KeepAliveRunners { return {
  async claudeStatus(configDir, cwd, signal) {
    const r = await runCli(bin.claude, ["auth", "status", "--json"], { env: runEnv(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}), cwd, timeoutMs: CLAUDE_TIMEOUT_MS, signal });
    if (r.code === null) return { code: null, loggedIn: null };
    const parsed = parseClaudeAuthStatus(r.stdout);
    const m = /"loginExpiresAt"\s*:\s*"([0-9TZ:.+-]{10,40})"/.exec(r.stdout), at = m ? Date.parse(m[1]) : NaN;
    return { code: r.code, loggedIn: parsed.loggedIn, ...(Number.isFinite(at) ? { loginExpiresAt: at } : {}) };
  },
  async claudeFallback(configDir, cwd, signal) {
    const r = await runCli(bin.claude, ["-p", "Reply with the single word OK.", "--model", "haiku", "--max-turns", "1", "--tools", "", "--strict-mcp-config",
      "--no-session-persistence", "--disable-slash-commands", "--setting-sources", "project", "--output-format", "json"],
    { env: runEnv(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}), cwd, timeoutMs: FALLBACK_TIMEOUT_MS, signal });
    return { code: r.code };
  },
  async codexRefresh(runHome, signal) {
    if (signal.aborted) return { answered: false, accountNull: false };
    let child: Child;
    try { child = spawn(bin.codex, ["app-server"], { env: runEnv({ CODEX_HOME: runHome }), cwd: runHome, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }); } catch { return { answered: false, accountNull: false }; }
    const w = watchChild(child);
    let buf = "", answered = false, accountNull = false, grace: NodeJS.Timeout | null = null, ended = false;
    // #3313 review r2: once stopped (withdrawn, stopped, or past its deadline) nothing more is sent — a late answer to
    // `initialize` never starts the refresh — and the process is still owned until it exits.
    const end = () => { ended = true; w.stop(); };
    const send = (o: unknown) => { if (ended || signal.aborted) return; try { child.stdin?.write(JSON.stringify(o) + "\n"); } catch { /* closed */ } };
    // After its answer it is asked to leave (stdin closed); if it has not within the grace, it is stopped.
    const finish = () => { if (grace) return; ended = true; try { child.stdin?.end(); } catch { /* closed */ } grace = setTimeout(w.stop, CODEX_EXIT_GRACE_MS); grace.unref?.(); };
    child.stdin?.on("error", () => { /* it left first */ });
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > 1024 * 1024) { buf = ""; return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m?.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "account/read", params: { refreshToken: true } }); }
        else if (m?.id === 2 && !ended) { answered = !m.error; accountNull = !m.error && m.result?.account === null; finish(); }
      }
    });
    const timer = setTimeout(end, CODEX_TIMEOUT_MS); timer.unref?.();
    signal.addEventListener("abort", end, { once: true });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agend-signin-keepalive", version: "1" } } });
    try { await w.exited; } finally { clearTimeout(timer); if (grace) clearTimeout(grace); signal.removeEventListener("abort", end); }
    return { answered, accountNull };
  },
}; }
export const realRunners: KeepAliveRunners = makeRunners({ claude: "claude", codex: "codex" });

// ── The service ────────────────────────────────────────────────────────────────────────────────────────────────

export interface KeepAliveDeps {
  dataDir: string;
  now?: () => number;
  log(level: "info" | "warn", msg: string, fields: Record<string, unknown>): void;
  /** The folder holding the sign-in: CLAUDE_CONFIG_DIR, or the folder with Codex's `auth.json`. Null: unknown backend. */
  homeOf(backend: KeepAliveBackend, profile: string | null): string | null;
  /**
   * A run's admission, decided at once: "in_use" when an agent or ClassicBot room is starting or running on this sign-in
   * (or who does cannot be read) or a sign-in for it runs; "busy" when the shared login window is held; else a hold that
   * keeps the window, keeps agents from starting on this sign-in, and counts as an account writer until `release()`.
   */
  acquire(backend: KeepAliveBackend, profile: string | null): { release(): void } | "in_use" | "busy";
  /** Something a page or Needs you shows changed. */
  changed(): void;
  runners?: KeepAliveRunners;
  /** macOS keeps Claude Code's token in the Keychain: no file to read the renewal back from. */
  claudeKeychain?: boolean;
}

export interface KeepAliveView { enabled: boolean; fallback?: boolean; endsAt?: string; expiresAt?: string; lastAt?: string; lastOutcome?: Outcome; planType?: string }
export type SetResult = { ok: true } | { ok: false; error: "backend" | "profile" | "fallback" | "write" };

const iso = (ms: number | undefined) => ms === undefined ? undefined : new Date(ms).toISOString();
/** A run whose setting changed (or whose service stopped) since it began: it does nothing more and records nothing. */
class Withdrawn extends Error {}

export class SignInKeepAlive {
  private entries: KeepAliveEntry[];
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  /** Raised by each stop: a run begun before never goes on after it. */
  private epoch = 0;
  /** Raised by each change of a sign-in's setting: its run in flight is withdrawn. */
  private readonly generation = new Map<string, number>();
  /** The run in flight: which sign-in, and how to stop its CLI. */
  private inFlight: { key: string; controller: AbortController } | null = null;
  private readonly runners: KeepAliveRunners;
  private readonly now: () => number;

  constructor(private readonly deps: KeepAliveDeps) {
    this.entries = readEntries(deps.dataDir);
    this.runners = deps.runners ?? realRunners;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    for (const t of [this.timer, this.first]) if (t) clearTimeout(t);
    this.first = setTimeout(() => { void this.tick(); }, FIRST_WAKE_MS); this.first.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, WAKE_MS); this.timer.unref?.();
  }
  /** No new run; the one in flight stops its CLI. Resolves once that run (and its CLI) has ended. */
  stop(): Promise<void> {
    this.stopped = true;
    this.epoch++;
    for (const t of [this.timer, this.first, this.soon]) if (t) clearTimeout(t);
    this.timer = this.first = this.soon = null;
    this.inFlight?.controller.abort();
    return this.running ? this.running.then(() => undefined, () => undefined) : Promise.resolve();
  }

  list(): readonly KeepAliveEntry[] { return this.entries; }

  /** Switch a sign-in on or off (and, for Claude Code, its fallback). On: it is looked at within seconds. Any change withdraws its run in flight. */
  set(backend: unknown, profile: unknown, enabled: unknown, fallback?: unknown): SetResult {
    if (!isKeepAliveBackend(backend)) return { ok: false, error: "backend" };
    if (!(profile === null || (typeof profile === "string" && isCredentialProfileName(profile)))) return { ok: false, error: "profile" };
    if (typeof enabled !== "boolean") return { ok: false, error: "profile" };
    if (fallback !== undefined && (typeof fallback !== "boolean" || (fallback && backend !== "claude-code"))) return { ok: false, error: "fallback" };
    const next = this.entries.filter(e => !(e.backend === backend && e.profile === profile));
    const prev = this.entries.find(e => e.backend === backend && e.profile === profile);
    const fb = fallback === undefined ? prev?.fallback === true : fallback;
    // Off forgets the record: switched on again, it starts clean (no old failure counted twice).
    next.push({ backend, profile, enabled, ...(fb && backend === "claude-code" ? { fallback: true } : {}), ...(enabled && prev?.record ? { record: prev.record } : {}) });
    try { writeEntries(this.deps.dataDir, next); } catch { return { ok: false, error: "write" }; }
    this.entries = next;
    const key = entryKey(backend, profile);
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    if (this.inFlight?.key === key) this.inFlight.controller.abort();
    this.deps.log("info", "Sign-in keep-alive setting changed", { backend, profile: profile ?? "(default)", enabled, fallback: fb && backend === "claude-code" });
    this.deps.changed();
    if (enabled && !this.stopped) { if (this.soon) clearTimeout(this.soon); this.soon = setTimeout(() => { this.soon = null; void this.tick({ only: { backend, profile } }); }, SOON_MS); this.soon.unref?.(); }
    return { ok: true };
  }

  /** The Accounts row's part: the setting, the last run, and the dates read now from the sign-in's own file. */
  view(backend: string, profile: string | null): KeepAliveView | undefined {
    if (!isKeepAliveBackend(backend)) return undefined;
    const e = this.entries.find(x => x.backend === backend && x.profile === profile);
    const r = e?.enabled ? e.record : undefined;
    const home = this.deps.homeOf(backend, profile);
    let endsAt = r?.endsAt, expiresAt = r?.expiresAt, planType = r?.planType;
    if (home) {
      if (backend === "claude-code") { const m = readClaudeMeta(home); if (m.state === "ok") { endsAt = m.endsAt ?? endsAt; expiresAt = m.expiresAt ?? expiresAt; } }
      else { const m = readCodexMeta(join(home, "auth.json")); if (m.state === "ok") { expiresAt = m.accessExp ?? expiresAt; planType = m.planType ?? planType; } }
    }
    return {
      enabled: e?.enabled === true, ...(backend === "claude-code" ? { fallback: e?.fallback === true } : {}),
      ...(endsAt !== undefined && endsAt > 0 ? { endsAt: iso(endsAt) } : {}), ...(expiresAt !== undefined && expiresAt > 0 ? { expiresAt: iso(expiresAt) } : {}),
      ...(r?.lastAt !== undefined ? { lastAt: iso(r.lastAt) } : {}), ...(r?.outcome ? { lastOutcome: r.outcome } : {}), ...(planType ? { planType } : {}),
    };
  }

  attention(): KeepAliveAttention[] { return attentionOf(this.entries, this.now()); }

  /** One pass: every switched-on sign-in not looked at for about a day (or just the one switched on), one at a time. */
  tick(opts: { force?: boolean; only?: { backend: KeepAliveBackend; profile: string | null } } = {}): Promise<void> {
    if (this.running) return this.running.then(() => !this.stopped && (opts.only || opts.force) ? this.tick(opts) : undefined);
    this.running = this.pass(opts).finally(() => { this.running = null; });
    return this.running;
  }

  private find(key: string): KeepAliveEntry | undefined { return this.entries.find(x => entryKey(x.backend, x.profile) === key); }

  private async pass(opts: { force?: boolean; only?: { backend: KeepAliveBackend; profile: string | null } }): Promise<void> {
    let changed = false;
    // Each sign-in as it is NOW: one switched off while an earlier one ran is not run.
    for (const key of this.entries.map(x => entryKey(x.backend, x.profile))) {
      if (this.stopped) break;
      const e = this.find(key);
      if (!e?.enabled) continue;
      if (opts.only && !(opts.only.backend === e.backend && opts.only.profile === e.profile)) continue;
      const now = this.now(), last = e.record?.lastAt;
      if (!opts.force && !opts.only && last !== undefined && now - last < RUN_EVERY_MS && last <= now + HOUR) continue;
      const home = this.deps.homeOf(e.backend, e.profile);
      if (!home) continue;
      if (e.profile !== null && !existsSync(home)) {          // the profile was removed: forget it, never ask anyone to sign it in
        this.entries = this.entries.filter(x => x !== e); changed = true; continue;
      }
      let record: KeepAliveRecord;
      const hold = this.deps.acquire(e.backend, e.profile);
      if (hold === "busy") continue;                          // a sign-in holds the window: the next wake tries again
      if (hold === "in_use") record = nextRecord(e.record, "in_use", now, this.datesOf(e.backend, home));
      else {
        const epoch = this.epoch, gen = this.generation.get(key) ?? 0, controller = new AbortController();
        // Still wanted: the service not stopped, this sign-in's setting unchanged and on (and, for the fallback, allowing it).
        const wanted = (fallback = false) => {
          const cur = this.find(key);
          if (this.stopped || this.epoch !== epoch || (this.generation.get(key) ?? 0) !== gen || !cur?.enabled || (fallback && cur.fallback !== true)) throw new Withdrawn();
        };
        this.inFlight = { key, controller };
        try {
          record = e.backend === "claude-code" ? await this.runClaude(e, home, now, wanted, controller.signal) : await this.runCodex(e, home, now, wanted, controller.signal);
          wanted();
        } catch (err) {
          if (err instanceof Withdrawn) continue;                // withdrawn: nothing more, nothing recorded
          record = nextRecord(e.record, "transient", now);
        } finally {
          if (this.inFlight?.controller === controller) this.inFlight = null;
          hold.release();                                      // only now: every CLI of this run has exited
        }
      }
      const current = this.find(key);
      if (!current?.enabled) continue;
      this.entries = this.entries.map(x => x === current ? { ...current, record } : x);
      changed = true;
      this.deps.log(record.outcome === "transient" || record.outcome === "needs_sign_in" || record.outcome === "not_renewed" ? "warn" : "info", "Sign-in keep-alive", {
        backend: e.backend, profile: e.profile ?? "(default)", outcome: record.outcome,
        ...(record.expiresAt ? { expiresAt: iso(record.expiresAt) } : {}), ...(record.endsAt ? { endsAt: iso(record.endsAt) } : {}),
        ...(record.lastRefresh ? { lastRefresh: iso(record.lastRefresh) } : {}), ...(record.planType ? { planType: record.planType } : {}),
      });
    }
    if (changed) {
      try { writeEntries(this.deps.dataDir, this.entries); } catch (err) { this.deps.log("warn", "Sign-in keep-alive: could not save", { err: String((err as Error)?.message ?? err) }); }
      this.deps.changed();
    }
  }

  /** The dates a sign-in's own file says now (kept on a record that ran nothing). */
  private datesOf(backend: KeepAliveBackend, home: string): Partial<KeepAliveRecord> {
    if (backend === "claude-code") { const m = readClaudeMeta(home); return m.state === "ok" ? { ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}), ...(m.endsAt ? { endsAt: m.endsAt } : {}) } : {}; }
    const m = readCodexMeta(join(home, "auth.json"));
    return m.state === "ok" ? { ...(m.lastRefresh ? { lastRefresh: m.lastRefresh } : {}), ...(m.accessExp ? { expiresAt: m.accessExp } : {}), ...(m.planType ? { planType: m.planType } : {}) } : {};
  }

  private workDir(sub: string): string {
    const dir = join(this.deps.dataDir, WORK_DIR, sub);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** `wanted()` is asked right before every CLI starts (it throws when the run was withdrawn). */
  private async runClaude(e: KeepAliveEntry, home: string, now: number, wanted: (fallback?: boolean) => void, signal: AbortSignal): Promise<KeepAliveRecord> {
    const configDir = e.profile === null ? null : home, cwd = this.workDir("claude-cwd");
    const before = readClaudeMeta(home);
    const dates = (m: ClaudeMeta): Partial<KeepAliveRecord> => m.state === "ok" ? { ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}), ...(m.endsAt ? { endsAt: m.endsAt } : {}) } : {};
    if (before.state === "unreadable") return nextRecord(e.record, "transient", now);
    if (before.state === "missing") {
      // No file: signed out — or, on macOS, the login is in the Keychain and only the CLI can say (not whether it renewed).
      if (!this.deps.claudeKeychain) return nextRecord(e.record, "needs_sign_in", now);
      wanted();
      const r = await this.runners.claudeStatus(configDir, cwd, signal);
      if (r.code === null || r.loggedIn === null) return nextRecord(e.record, "transient", now);
      return nextRecord(e.record, r.loggedIn ? "checked" : "needs_sign_in", now, r.loginExpiresAt ? { endsAt: r.loginExpiresAt } : {});
    }
    if (claudeDead(before)) return nextRecord(e.record, "needs_sign_in", now, dates(before));
    if (!claudeDue(before, now)) return nextRecord(e.record, "not_needed", now, dates(before));
    wanted();
    const r = await this.runners.claudeStatus(configDir, cwd, signal);
    wanted();
    if (r.code === null) return nextRecord(e.record, "transient", now, dates(before));
    const after = readClaudeMeta(home);
    if (after.state !== "ok") return nextRecord(e.record, after.state === "missing" ? "needs_sign_in" : "transient", now, dates(before));
    if (claudeDead(after)) return nextRecord(e.record, "needs_sign_in", now, dates(after));
    const moved = (m: ClaudeMeta) => m.state === "ok" && m.expiresAt !== undefined && m.expiresAt > now && (before.expiresAt === undefined || m.expiresAt > before.expiresAt);
    if (moved(after)) return nextRecord(e.record, "refreshed", now, dates(after));
    if (r.loggedIn === false) return nextRecord(e.record, "needs_sign_in", now, dates(after));
    // The fallback only when the person allows it NOW (it is a model request): asked again right before it starts.
    if (this.find(entryKey(e.backend, e.profile))?.fallback !== true) return nextRecord(e.record, "not_renewed", now, dates(after));
    wanted(true);
    const f = await this.runners.claudeFallback(configDir, cwd, signal);
    const last = readClaudeMeta(home);
    if (claudeDead(last)) return nextRecord(e.record, "needs_sign_in", now, dates(last));
    if (moved(last)) return nextRecord(e.record, "fallback_refreshed", now, dates(last));
    return nextRecord(e.record, f.code === null ? "transient" : "not_renewed", now, dates(last));
  }

  private async runCodex(e: KeepAliveEntry, home: string, now: number, wanted: () => void, signal: AbortSignal): Promise<KeepAliveRecord> {
    const authJson = join(home, "auth.json");
    const before = readCodexMeta(authJson);
    const facts = (m: CodexMeta): Partial<KeepAliveRecord> => m.state === "ok" ? { ...(m.lastRefresh ? { lastRefresh: m.lastRefresh } : {}), ...(m.accessExp ? { expiresAt: m.accessExp } : {}), ...(m.planType ? { planType: m.planType } : {}) } : {};
    if (before.state === "missing") return nextRecord(e.record, "needs_sign_in", now);
    if (before.state === "api_key") return nextRecord(e.record, "unsupported", now);
    if (before.state === "unreadable") return nextRecord(e.record, "transient", now);
    if (!before.hasRefresh) return nextRecord(e.record, "needs_sign_in", now, facts(before));
    // Only a real file is refreshed through the link (a link would be replaced by a copy elsewhere, or point anywhere).
    let st; try { st = lstatSync(authJson); } catch { return nextRecord(e.record, "transient", now); }
    if (!st.isFile()) return nextRecord(e.record, "unsupported", now, facts(before));
    if (!codexDue(before, now)) return nextRecord(e.record, "not_needed", now, facts(before));
    wanted();
    const runHome = this.workDir("codex-home"), link = join(runHome, "auth.json");
    // The scratch home: this sign-in's auth.json linked in, codex told to keep it in that file (never a keyring).
    writeFileSync(join(runHome, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    try { unlinkSync(link); } catch { /* none */ }
    symlinkSync(authJson, link);
    let r: CodexRefreshRun;
    // The link goes only once the app-server has exited (the runner resolves no sooner).
    try { r = await this.runners.codexRefresh(runHome, signal); }
    finally { try { unlinkSync(link); } catch { /* gone */ } }
    wanted();
    const after = readCodexMeta(authJson);
    if (after.state === "ok" && after.lastRefresh !== undefined && (before.lastRefresh === undefined || after.lastRefresh > before.lastRefresh)) return nextRecord(e.record, "refreshed", now, facts(after));
    if (after.state === "missing") return nextRecord(e.record, "needs_sign_in", now);
    if (r.answered && r.accountNull) return nextRecord(e.record, "needs_sign_in", now, facts(after));
    return nextRecord(e.record, "transient", now, facts(after));
  }
}
