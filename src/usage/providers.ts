/**
 * AI subscription usage providers — read the credentials the CLI backends
 * already saved on this machine and fetch live plan usage from each vendor's
 * own usage endpoint. Powers `GET /api/ai-usage` (usage-api.ts) and the
 * Usage panel on /view.
 *
 * Vendored from ai-usage-board (https://github.com/songsid/ai-usage-board, MIT),
 * whose provider protocol logic is in turn ported from OpenUsage
 * (https://github.com/robinebers/openusage, MIT, © Robin Ebers). See LICENSE.md
 * in this directory. Not affiliated with or endorsed by OpenUsage.
 *
 * Token policy:
 * - Claude/Codex: read-only, never refreshed — those vendors rotate refresh
 *   tokens, and refreshing behind the CLI's back could invalidate its login.
 *   Their credential files stay fresh as long as the CLIs are used (which, in
 *   a running fleet, they are).
 * - Grok: access tokens expire within hours, so we refresh exactly like the
 *   Grok CLI does and persist rotated tokens back to auth.json — refusing to
 *   refresh at all when the file isn't writable, rather than risk the login.
 */
import { readFile, writeFile, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";

export interface UsageMetric {
  label: string;
  type: "percent" | "dollars" | "count" | "text";
  used?: number;          // percent (0-100) or dollars
  limit?: number;         // dollars, when capped
  value?: number | string; // count / text
  unit?: string;
  note?: string;
  resetsAt?: string | null;
  windowMs?: number | null;
}

export interface ProviderUsage {
  id: string;
  name: string;
  status: "ok" | "error" | "no-credentials";
  plan?: string | null;
  error?: string;
  hint?: string;
  metrics: UsageMetric[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MS = 5 * 60 * 60 * 1000;

function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── Claude ───────────────────────────────────────────────────────────────────

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function claudeResetIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e10 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Where the Claude OAuth bearer comes from, in preference order:
 *
 * 1. `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) when present and
 *    unexpired — the interactive `/login` flow. Carries plan metadata.
 * 2. `CLAUDE_CODE_OAUTH_TOKEN` — the long-lived (annual) token minted by
 *    `claude setup-token`. Users on this flow often have NO credentials file at
 *    all (or a stale one from an old login), which is why /usage showed them
 *    "not logged in" / "token expired" while their CLI worked fine. Same token
 *    family (`sk-ant-oat…`), same usage endpoint; it just carries no plan
 *    metadata, so plan shows unknown.
 * 3. An expired file token with no env fallback stays an explicit error.
 * 4. `ANTHROPIC_API_KEY` alone is named in the hint but NOT used: console API
 *    keys are pay-per-token and have no subscription usage to query — the OAuth
 *    endpoint rejects them, and pretending otherwise would render a misleading
 *    error instead of an accurate "log in" hint.
 */
export function resolveClaudeAuth(
  file: { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string } | null,
  env: NodeJS.ProcessEnv = process.env,
): { token: string; plan: string | null } | { error: string; plan: string | null } | null {
  let plan: string | null = null;
  if (file?.subscriptionType?.trim()) {
    plan = file.subscriptionType.trim().replace(/^./, c => c.toUpperCase());
    const tier = file.rateLimitTier?.match(/\d+x/);
    if (tier) plan += ` ${tier[0]}`;
  }

  const fileFresh = !!file?.accessToken && !(file.expiresAt && file.expiresAt < Date.now());
  if (file?.accessToken && fileFresh) return { token: file.accessToken.trim(), plan };

  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return { token: envToken, plan };

  if (file?.accessToken) {
    return { error: "Access token expired. Run `claude` once to refresh it.", plan };
  }
  return null;
}

async function fetchClaudeUsage(): Promise<Omit<ProviderUsage, "id" | "name">> {
  const home = process.env.CLAUDE_HOME || join(homedir(), ".claude");
  let file: { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string } | null;
  try {
    file = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8")).claudeAiOauth ?? null;
  } catch {
    file = null;
  }

  const auth = resolveClaudeAuth(file);
  if (auth === null) {
    const hint = process.env.ANTHROPIC_API_KEY
      ? "API-key login has no subscription usage. Use `claude /login` or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`)."
      : "Log in with the Claude Code CLI (`claude`).";
    return { status: "no-credentials", hint, metrics: [] };
  }
  if ("error" in auth) {
    return { status: "error", plan: auth.plan, error: auth.error, metrics: [] };
  }
  const plan = auth.plan;

  let res: Response;
  try {
    res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.69",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: "error", plan, error: "Could not reach api.anthropic.com.", metrics: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "error", plan, error: "Token rejected. Run `claude` once to refresh the login.", metrics: [] };
  }
  if (res.status === 429) {
    return { status: "error", plan, error: "Rate limited by Anthropic — try again later.", metrics: [] };
  }
  if (!res.ok) return { status: "error", plan, error: `Usage request failed (HTTP ${res.status}).`, metrics: [] };

  let body: Record<string, unknown>;
  try { body = await res.json() as Record<string, unknown>; } catch {
    return { status: "error", plan, error: "Invalid response from usage endpoint.", metrics: [] };
  }

  const metrics: UsageMetric[] = [];
  const window = (obj: unknown, label: string, windowMs: number) => {
    const o = obj as { utilization?: unknown; resets_at?: unknown } | undefined;
    if (typeof o?.utilization !== "number") return;
    metrics.push({ label, type: "percent", used: o.utilization, resetsAt: claudeResetIso(o.resets_at), windowMs });
  };
  window(body.five_hour, "Session", SESSION_MS);
  window(body.seven_day, "Weekly", WEEK_MS);
  window(body.seven_day_sonnet, "Sonnet (weekly)", WEEK_MS);

  // Per-model weekly windows live in the `limits` array (kind: weekly_scoped).
  for (const entry of Array.isArray(body.limits) ? body.limits : []) {
    const e = entry as { kind?: string; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: string } } };
    if (e?.kind !== "weekly_scoped") continue;
    const model = e.scope?.model?.display_name;
    if (!model || typeof e.percent !== "number") continue;
    metrics.push({ label: `${model} (weekly)`, type: "percent", used: e.percent, resetsAt: claudeResetIso(e.resets_at), windowMs: WEEK_MS });
  }

  const extra = body.extra_usage as { is_enabled?: boolean; used_credits?: unknown; monthly_limit?: unknown } | undefined;
  if (extra?.is_enabled === true && typeof extra.used_credits === "number") {
    const used = extra.used_credits / 100;
    const limit = typeof extra.monthly_limit === "number" && extra.monthly_limit > 0 ? extra.monthly_limit / 100 : null;
    if (limit) metrics.push({ label: "Extra usage", type: "dollars", used, limit });
    else if (used > 0) metrics.push({ label: "Extra usage", type: "dollars", used });
  }

  return { status: "ok", plan, metrics };
}

// ── Codex ────────────────────────────────────────────────────────────────────

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CREDIT_USD_RATE = 0.04;

type CodexWindow = { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown; reset_after_seconds?: unknown };

function codexResetIso(win: CodexWindow, nowMs: number): string | null {
  if (typeof win.reset_at === "number" && Number.isFinite(win.reset_at)) return new Date(win.reset_at * 1000).toISOString();
  if (typeof win.reset_after_seconds === "number" && Number.isFinite(win.reset_after_seconds)) {
    return new Date(nowMs + win.reset_after_seconds * 1000).toISOString();
  }
  return null;
}

// Codex normally puts the 5-hour window in primary and weekly in secondary, but
// a window's own limit_window_seconds wins when present. Some plans (e.g. Team)
// report a monthly window — label by actual duration, never by slot.
function codexWindows(
  rateLimit: { primary_window?: unknown; secondary_window?: unknown } | undefined,
  labels: { session: string; weekly: string; monthly: string; other: (days: number) => string },
  nowMs: number,
): UsageMetric[] {
  const candidates = [
    { win: rateLimit?.primary_window as CodexWindow | undefined, fallback: "session" as const },
    { win: rateLimit?.secondary_window as CodexWindow | undefined, fallback: "weekly" as const },
  ].filter(c => c.win && typeof c.win === "object");

  const metrics: UsageMetric[] = [];
  for (const { win, fallback } of candidates) {
    if (!win || typeof win.used_percent !== "number") continue;
    const explicitMs = typeof win.limit_window_seconds === "number" && Number.isFinite(win.limit_window_seconds)
      ? win.limit_window_seconds * 1000 : null;
    const windowMs = explicitMs ?? (fallback === "session" ? SESSION_MS : WEEK_MS);
    let label: string;
    if (windowMs === SESSION_MS) label = labels.session;
    else if (windowMs === WEEK_MS) label = labels.weekly;
    else if (windowMs >= 27 * 864e5 && windowMs <= 32 * 864e5) label = labels.monthly;
    else if (explicitMs) label = labels.other(Math.round(windowMs / 864e5));
    else label = fallback === "session" ? labels.session : labels.weekly;
    metrics.push({ label, type: "percent", used: win.used_percent, resetsAt: codexResetIso(win, nowMs), windowMs });
  }
  return metrics;
}

function codexPlan(planType: unknown): string | null {
  if (typeof planType !== "string" || !planType.trim()) return null;
  switch (planType.trim().toLowerCase()) {
    case "prolite": return "Pro 5x";
    case "pro": return "Pro 20x";
    default: return planType.trim().split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
}

async function fetchCodexUsage(): Promise<Omit<ProviderUsage, "id" | "name">> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  let auth: { tokens?: { access_token?: string; account_id?: string } };
  try {
    auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
  } catch {
    return { status: "no-credentials", hint: "Log in with the Codex CLI (`codex`).", metrics: [] };
  }
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) {
    return { status: "no-credentials", hint: "auth.json has no OAuth login (API-key-only auth cannot read usage).", metrics: [] };
  }

  const exp = jwtExpiryMs(accessToken);
  if (exp && exp < Date.now()) {
    return { status: "error", error: "Access token expired. Run `codex` once to refresh it.", metrics: [] };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "agend-usage",
  };
  if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;

  let res: Response;
  try {
    res = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { status: "error", error: "Could not reach chatgpt.com.", metrics: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "error", error: "Token rejected. Run `codex` once to refresh the login.", metrics: [] };
  }
  if (!res.ok) return { status: "error", error: `Usage request failed (HTTP ${res.status}).`, metrics: [] };

  let body: Record<string, unknown>;
  try { body = await res.json() as Record<string, unknown>; } catch {
    return { status: "error", error: "Invalid response from usage endpoint.", metrics: [] };
  }

  const nowMs = Date.now();
  const metrics = codexWindows(body.rate_limit as never, {
    session: "Session", weekly: "Weekly", monthly: "Monthly", other: d => `${d}-day window`,
  }, nowMs);

  // Model-specific limits (e.g. Spark) ride in additional_rate_limits, same window shape.
  for (const entry of Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : []) {
    const e = entry as { limit_name?: string; metered_feature?: string; rate_limit?: unknown };
    if (!e || typeof e !== "object" || !e.rate_limit) continue;
    const rawName = e.limit_name || e.metered_feature || "Model limit";
    metrics.push(...codexWindows(e.rate_limit as never, {
      session: rawName, weekly: `${rawName} (weekly)`, monthly: `${rawName} (monthly)`, other: d => `${rawName} (${d}d)`,
    }, nowMs));
  }

  const resets = body.rate_limit_reset_credits as { available_count?: unknown } | undefined;
  if (typeof resets?.available_count === "number" && resets.available_count >= 0) {
    metrics.push({ label: "Rate limit resets", type: "count", value: Math.floor(resets.available_count), unit: "available" });
  }

  const credits = body.credits as { balance?: unknown; has_credits?: unknown } | undefined;
  let remaining: number | null = null;
  if (typeof credits?.balance === "number") remaining = credits.balance;
  else if (credits?.has_credits === false) remaining = 0;
  if (remaining !== null) {
    const count = Math.max(0, Math.floor(remaining));
    metrics.push({ label: "Credits", type: "count", value: count, unit: "credits", note: `≈ $${(count * CREDIT_USD_RATE).toFixed(2)}` });
  }

  return { status: "ok", plan: codexPlan(body.plan_type), metrics };
}

// ── Grok ─────────────────────────────────────────────────────────────────────

const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const GROK_REFRESH_URL = "https://auth.x.ai/oauth2/token";
const GROK_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_WEEKLY_PERIOD = "USAGE_PERIOD_TYPE_WEEKLY";
const GROK_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface GrokAuthEntry {
  key?: string;
  refresh_token?: string;
  refresh?: string;
  id_token?: string;
  expires_at?: string;
  expires?: string;
  oidc_client_id?: string;
}

function grokEntryExpiryMs(entry: GrokAuthEntry, token: string): number | null {
  const fromJwt = jwtExpiryMs(token);
  if (fromJwt) return fromJwt;
  const raw = entry.expires_at || entry.expires;
  if (typeof raw === "string") {
    const ms = new Date(raw).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

async function grokRefreshAndPersist(
  file: string,
  auth: Record<string, GrokAuthEntry>,
  entryKey: string,
  entry: GrokAuthEntry,
): Promise<{ token?: string; error?: string }> {
  // Refuse to refresh unless the rotated tokens can be written back — a rotated
  // refresh token that only lives in our memory would break `grok` itself.
  try { await access(file, constants.W_OK); } catch {
    return { error: "Token expired and auth.json is read-only. Run `grok` once to refresh it." };
  }
  const refreshToken = (entry.refresh_token || entry.refresh || "").trim();
  if (!refreshToken) return { error: "Token expired and no refresh token found. Run `grok login`." };

  const clientId = entry.oidc_client_id?.trim()
    || entryKey.split("::").pop()?.trim()
    || GROK_DEFAULT_CLIENT_ID;

  let res: Response;
  try {
    res = await fetch(GROK_REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { error: "Could not reach auth.x.ai to refresh the token." };
  }
  if (!res.ok) return { error: "Grok session expired. Run `grok login` again." };

  let body: { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  try { body = await res.json() as typeof body; } catch {
    return { error: "Invalid refresh response from auth.x.ai." };
  }
  if (!body.access_token) return { error: "Grok session expired. Run `grok login` again." };

  // Update only this entry's fields, preserving everything else in the file
  // (other accounts' entries included).
  const updated: GrokAuthEntry = { ...(auth[entryKey] ?? {}) };
  updated.key = body.access_token;
  if (body.refresh_token) updated.refresh_token = body.refresh_token;
  if (body.id_token) updated.id_token = body.id_token;
  if (typeof body.expires_in === "number") updated.expires_at = new Date(Date.now() + body.expires_in * 1000).toISOString();
  try {
    await writeFile(file, JSON.stringify({ ...auth, [entryKey]: updated }, null, 2));
  } catch {
    return { error: "Refreshed but could not write auth.json — refusing to continue without persisting. Run `grok` once instead." };
  }
  return { token: body.access_token };
}

function grokHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token.trim()}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "agend-usage",
  };
}

async function fetchGrokUsage(): Promise<Omit<ProviderUsage, "id" | "name">> {
  const home = process.env.GROK_HOME || join(homedir(), ".grok");
  const file = join(home, "auth.json");
  let auth: Record<string, GrokAuthEntry>;
  try {
    auth = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { status: "no-credentials", hint: "Log in with the Grok CLI (`grok login`).", metrics: [] };
  }

  const entries = Object.entries(auth).filter(([, e]) => typeof e?.key === "string" && e.key.trim());
  if (!entries.length) return { status: "no-credentials", hint: "auth.json has no usable login. Run `grok login`.", metrics: [] };

  const [entryKey, entry] = entries[0];
  let token = (entry.key as string).trim();

  const expiry = grokEntryExpiryMs(entry, token);
  if (expiry && expiry - Date.now() <= GROK_REFRESH_BUFFER_MS) {
    const refreshed = await grokRefreshAndPersist(file, auth, entryKey, entry);
    if (refreshed.error) return { status: "error", error: refreshed.error, metrics: [] };
    token = refreshed.token as string;
  }

  const fetchBoth = async (tok: string) => {
    const [credits, settings] = await Promise.all([
      fetch(GROK_CREDITS_URL, { headers: grokHeaders(tok), signal: AbortSignal.timeout(10_000) }),
      fetch(GROK_SETTINGS_URL, { headers: grokHeaders(tok), signal: AbortSignal.timeout(10_000) }).catch(() => null),
    ]);
    return { credits, settings };
  };

  let credits: Response, settings: Response | null;
  try {
    ({ credits, settings } = await fetchBoth(token));
    if (credits.status === 401 || credits.status === 403) {
      const refreshed = await grokRefreshAndPersist(file, auth, entryKey, entry);
      if (refreshed.error) return { status: "error", error: refreshed.error, metrics: [] };
      token = refreshed.token as string;
      ({ credits, settings } = await fetchBoth(token));
    }
  } catch {
    return { status: "error", error: "Could not reach cli-chat-proxy.grok.com.", metrics: [] };
  }
  if (credits.status === 401 || credits.status === 403) {
    return { status: "error", error: "Grok session expired. Run `grok login` again.", metrics: [] };
  }
  if (!credits.ok) return { status: "error", error: `Billing request failed (HTTP ${credits.status}).`, metrics: [] };

  let body: { config?: { creditUsagePercent?: unknown; currentPeriod?: { type?: string; start?: string; end?: string }; onDemandCap?: { val?: unknown } } };
  try { body = await credits.json() as typeof body; } catch {
    return { status: "error", error: "Invalid response from billing endpoint.", metrics: [] };
  }

  const config = body?.config;
  const period = config?.currentPeriod;
  if (!config || !period?.type) return { status: "error", error: "Grok billing response changed.", metrics: [] };

  const metrics: UsageMetric[] = [];
  if (period.type === GROK_WEEKLY_PERIOD) {
    // proto-JSON drops zero-valued fields: an absent creditUsagePercent means 0%.
    const pct = typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : 0;
    const start = new Date(period.start ?? "").getTime();
    const end = new Date(period.end ?? "").getTime();
    metrics.push({
      label: "Weekly limit",
      type: "percent",
      used: Math.min(100, Math.max(0, pct)),
      resetsAt: Number.isNaN(end) ? null : new Date(end).toISOString(),
      windowMs: Number.isNaN(end - start) ? null : end - start,
    });
  }
  const cap = typeof config.onDemandCap?.val === "number" ? config.onDemandCap.val : 0;
  metrics.push({ label: "Pay as you go", type: "text", value: cap > 0 ? `${cap} cap` : "Disabled" });

  let plan: string | null = null;
  if (settings?.ok) {
    try {
      const s = await settings.json() as { subscription_tier_display?: string };
      if (typeof s.subscription_tier_display === "string" && s.subscription_tier_display.trim()) {
        plan = s.subscription_tier_display.trim();
      }
    } catch { /* plan is optional */ }
  }

  return { status: "ok", plan, metrics };
}

// ── Kiro (Amazon Q Developer) ────────────────────────────────────────────────
// Original research, no OpenUsage upstream: the Kiro CLI stores its login in
// data.sqlite3 `auth_kv` (social or Identity Center token) and usage rides on
// the CodeWhisperer GetUsageLimits API — the exact call the CLI itself makes.
// Read-only: the CLI refreshes its own tokens.

const KIRO_TARGET = "AmazonCodeWhispererService.GetUsageLimits";

interface KiroToken {
  access_token?: string;
  expires_at?: string;
  region?: string;
  profile_arn?: string;
  /** IAM Identity Center portal URL — present only for Q Developer Pro logins. */
  start_url?: string;
  /** Social login provider (google/github/…) — present only for free-tier logins. */
  provider?: string;
}

/**
 * Which Kiro login is in use. Verified against a real kiro-cli auth store:
 * - IAM Identity Center (Amazon Q Developer Pro) tokens carry `start_url`
 *   (e.g. `https://d-xxxx.awsapps.com/start/`) and no social `provider`.
 * - Free-tier social logins (Builder ID / Google / GitHub) carry `provider`
 *   and a `profile_arn`.
 * Q Developer Pro is a seat-licensed subscription, so the credit/usage endpoint
 * that Builder ID reports against does not describe it.
 */
export type KiroAuthKind = "q-developer-pro" | "builder-id";

export function kiroAuthKind(token: KiroToken): KiroAuthKind {
  return typeof token.start_url === "string" && token.start_url.trim().length > 0
    ? "q-developer-pro"
    : "builder-id";
}

function readKiroToken(): { token?: KiroToken; kind?: KiroAuthKind; missing?: boolean } {
  const home = process.env.KIRO_CLI_HOME || join(homedir(), ".local", "share", "kiro-cli");
  let db: Database.Database;
  try {
    db = new Database(join(home, "data.sqlite3"), { readonly: true, fileMustExist: true });
  } catch {
    return { missing: true };
  }
  try {
    const rows = db.prepare("SELECT key, value FROM auth_kv WHERE key IN ('kirocli:social:token','codewhisperer:odic:token')").all() as { key: string; value: string }[];
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const parse = (raw?: string): KiroToken | null => {
      if (!raw) return null;
      try {
        const t = JSON.parse(raw) as KiroToken;
        return t.access_token ? t : null;
      } catch { return null; }
    };
    const candidates = [parse(byKey["kirocli:social:token"]), parse(byKey["codewhisperer:odic:token"])]
      .filter((t): t is KiroToken => t !== null);
    if (candidates.length === 0) return { missing: true };
    // Switching login type leaves the old token behind, so "first key wins"
    // could report a stale account. Prefer a token that has not expired, then
    // the one that expires latest.
    const expiry = (t: KiroToken) => (t.expires_at ? new Date(t.expires_at).getTime() : 0);
    const now = Date.now();
    const live = candidates.filter(t => expiry(t) > now);
    const token = (live.length ? live : candidates).sort((a, b) => expiry(b) - expiry(a))[0];
    return { token, kind: kiroAuthKind(token) };
  } catch {
    return { missing: true };
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

function kiroTitleCase(s: string): string {
  return s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
}

function kiroEpochIso(sec: unknown): string | null {
  return typeof sec === "number" && Number.isFinite(sec) && sec > 0
    ? new Date(sec * 1000).toISOString()
    : null;
}

/** Exported for tests: the Q-Pro and expired paths return without any network call. */
export async function fetchKiroUsage(): Promise<Omit<ProviderUsage, "id" | "name">> {
  const { token, kind, missing } = readKiroToken();
  if (missing || !token) {
    return { status: "no-credentials", hint: "Log in with the Kiro CLI (`kiro-cli`).", metrics: [] };
  }
  const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : null;
  if (expiresAt && expiresAt < Date.now()) {
    // Not an error state: kiro-cli refreshes its own login on next use, and the
    // panel showing a red failure for a routine token rollover is just noise.
    return { status: "no-credentials", hint: "Sign-in needed — run `kiro-cli` once and it refreshes itself.", metrics: [] };
  }
  if (kind === "q-developer-pro") {
    // Seat-licensed subscription: GetUsageLimits describes Builder-ID credit
    // buckets, not this, so there is nothing to meter and no call to make.
    return {
      status: "ok",
      plan: "Q Developer Pro",
      hint: "Subscription — no credit usage to report.",
      metrics: [],
    };
  }

  const region = token.region
    || (typeof token.profile_arn === "string" ? token.profile_arn.split(":")[3] : "")
    || "us-east-1";

  let res: Response;
  try {
    res = await fetch(`https://codewhisperer.${region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": KIRO_TARGET,
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify(token.profile_arn ? { profileArn: token.profile_arn } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "error", error: `Could not reach codewhisperer.${region}.amazonaws.com.`, metrics: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: "error", error: "Token rejected. Use `kiro-cli` once to refresh the login.", metrics: [] };
  }
  if (!res.ok) return { status: "error", error: `Usage request failed (HTTP ${res.status}).`, metrics: [] };

  interface KiroBreakdown {
    displayName?: string; displayNamePlural?: string;
    currentUsage?: number; currentUsageWithPrecision?: number;
    usageLimit?: number; usageLimitWithPrecision?: number;
    currentOverages?: number; currentOveragesWithPrecision?: number;
    overageCharges?: number; nextDateReset?: number;
    bonuses?: { status?: string; currentUsage?: number; usageLimit?: number; expiresAt?: number }[];
  }
  let body: {
    nextDateReset?: number;
    subscriptionInfo?: { subscriptionTitle?: string };
    overageConfiguration?: { overageStatus?: string };
    usageBreakdownList?: KiroBreakdown[];
  };
  try { body = await res.json() as typeof body; } catch {
    return { status: "error", error: "Invalid response from GetUsageLimits.", metrics: [] };
  }

  const plan = typeof body.subscriptionInfo?.subscriptionTitle === "string"
    ? kiroTitleCase(body.subscriptionInfo.subscriptionTitle)
    : null;

  const metrics: UsageMetric[] = [];
  for (const ub of Array.isArray(body.usageBreakdownList) ? body.usageBreakdownList : []) {
    const unit = (ub.displayNamePlural || ub.displayName || "credits").toLowerCase();
    const used = ub.currentUsageWithPrecision ?? ub.currentUsage ?? null;
    const limit = ub.usageLimitWithPrecision ?? ub.usageLimit ?? null;
    if (used !== null && limit !== null && limit > 0) {
      metrics.push({
        label: `${ub.displayNamePlural || ub.displayName || "Usage"} (monthly)`,
        type: "percent",
        used: Math.min(100, (used / limit) * 100),
        resetsAt: kiroEpochIso(ub.nextDateReset ?? body.nextDateReset),
        note: `${+used.toFixed(1)} / ${+limit.toFixed(0)} ${unit}`,
      });
    }

    // Bonus / gift credits (redeemed promo codes), aggregated across active codes.
    const bonuses = (ub.bonuses ?? []).filter(b => b?.status === "ACTIVE");
    if (bonuses.length) {
      const bUsed = bonuses.reduce((s, b) => s + (b.currentUsage ?? 0), 0);
      const bLimit = bonuses.reduce((s, b) => s + (b.usageLimit ?? 0), 0);
      const expiries = bonuses.map(b => b.expiresAt).filter((e): e is number => typeof e === "number" && e > 0);
      if (bLimit > 0) {
        metrics.push({
          label: "Bonus credits",
          type: "percent",
          used: Math.min(100, (bUsed / bLimit) * 100),
          resetsAt: expiries.length ? kiroEpochIso(Math.min(...expiries)) : null,
          note: `${+bUsed.toFixed(1)} / ${+bLimit.toFixed(0)} ${unit} · ${bonuses.length} codes`,
        });
      }
    }

    const overages = ub.currentOveragesWithPrecision ?? ub.currentOverages ?? 0;
    if (overages > 0 && typeof ub.overageCharges === "number") {
      metrics.push({ label: "Overage charges", type: "dollars", used: ub.overageCharges });
    }
  }

  const overageStatus = body.overageConfiguration?.overageStatus;
  if (typeof overageStatus === "string") {
    metrics.push({ label: "Pay-per-use", type: "text", value: kiroTitleCase(overageStatus.replace(/_/g, " ")) });
  }

  return { status: "ok", plan, metrics };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const PROVIDERS: { id: string; name: string; fetch: () => Promise<Omit<ProviderUsage, "id" | "name">> }[] = [
  { id: "claude", name: "Claude", fetch: fetchClaudeUsage },
  { id: "codex", name: "Codex", fetch: fetchCodexUsage },
  { id: "grok", name: "Grok", fetch: fetchGrokUsage },
  { id: "kiro", name: "Kiro", fetch: fetchKiroUsage },
];

/** Fetch every provider in parallel. Providers without local credentials are
 * skipped (per the panel's contract: absent CLIs simply don't show). */
export async function fetchAllUsage(): Promise<{ fetchedAt: string; providers: ProviderUsage[] }> {
  const results = await Promise.all(PROVIDERS.map(async (p): Promise<ProviderUsage> => {
    try {
      return { id: p.id, name: p.name, ...(await p.fetch()) };
    } catch (err) {
      return { id: p.id, name: p.name, status: "error", error: String((err as Error)?.message ?? err), metrics: [] };
    }
  }));
  return {
    fetchedAt: new Date().toISOString(),
    providers: results.filter(r => r.status !== "no-credentials"),
  };
}
