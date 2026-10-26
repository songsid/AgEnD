import { officeInputPatch } from "./dashboard-permissions.js";
import { setNoticeMode } from "./notice-delivery.js";
import { DEFAULT_REPLY_TRIGGERS } from "./reply-triggers.js";
import { PUBLIC_TUNNEL_SECRET_ID, PUBLIC_TUNNEL_TOKEN_HINT } from "./public-tunnel-config.js";
import { withSpawnHoldReply } from "./spawn-hold-reply.js";
import { normalizeSettingsInstancePatch, removesInstanceOverride } from "./settings-instance-patch.js";
import { isSettingsReplay, settingsRequestExecution, settingsRequestLocalAdmin, settingsWrite } from "./settings-request-capability.js";
import { noteSettingsWrite, settingsUndo, undoSettingsPaths, type SettingsExecution } from "./settings-transaction.js";
import { readBoundedWebBody } from "./web-body.js";
import { gatewayRequestContext } from "./web-request-context.js";
import { applyAppearanceChanges, applyGuestsPatch, applyVerifiedAuthorityPatch, parseAppearanceSettingsBody, parseWebSettingsBody } from "./web-settings-patch.js";
import { APPEARANCE_BOUNDS, APPEARANCE_DEFAULTS, effectiveAppearanceLimits } from "./web-appearance-limits.js";
import { permitWebContinuation } from "./web-continuation.js";
import { evaluateWebRequest } from "./web-auth.js";
import { redactInlineSecrets, restoreRedactedSecrets } from "./settings-redaction.js";
/**
 * Settings Web API (`/settings`) — CRUD over fleet.yaml + classicBot.yaml.
 *
 *   GET  /settings                              → static page
 *   GET  /api/settings/fleet                    → fleet config as JSON
 *   GET  /api/settings/classic                  → classicBot.yaml as JSON
 *   PUT  /api/settings/fleet/defaults           → merge fleet defaults
 *   PUT  /api/settings/fleet/channels           → replace channels[]
 *   POST /api/settings/fleet/instances/:name    → create instance
 *   PATCH/api/settings/fleet/instances/:name    → merge into instance
 *   DELETE /api/settings/fleet/instances/:name  → remove instance
 *   PUT  /api/settings/classic/defaults         → merge classic defaults
 *   PATCH/api/settings/classic/channels/:key    → update + restart a Classic channel
 *   POST /api/settings/reload                   → SIGHUP hot-reload
 *   POST /api/settings/instances/:name/pause    → manually pause a running instance
 *   POST /api/settings/instances/:name/wake     → manually wake a paused instance
 *   GET  /api/settings/status-emojis            → status-emoji keys, built-ins, pickable sets
 *   POST /api/settings/status-emojis/preview    → resolve a map exactly as the bots will
 *   GET  /api/settings/status-emojis/guild-emojis?channel=<id>[&refresh=1] → a Discord bot's servers' emojis
 *
 * Auth: all routes require the web.token — enforced by the global web-token gate
 * in fleet-manager BEFORE this handler runs (settings paths are not exempt), so
 * no per-route auth is repeated here.
 *
 * Writes are validated first (config-validator): any error → 400 and nothing is
 * written; warnings are non-blocking and returned alongside the result.
 */
import { serveAppShell, type AppShellContext } from "./web-api.js";
import { authorizeExplicitInstanceRemoval, type ExplicitInstanceRemoval } from "./instance-removal.js";
import { isSettingsPage } from "./web-shell-routes.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { channelWithDefaults } from "./config.js";
import type { Logger } from "./logger.js";
import type { FleetConfig, RawFleetConfig } from "./types.js";
import { KNOWN_BACKENDS, validateFleetConfig, validateClassicBotConfig, type ValidationResult } from "./config-validator.js";
import { clearPausedMarker } from "./pause-marker.js";
import { buildSettingsImpactSchema, CLASSIC_HOT_CONFIG_KEYS } from "./instance-config-impact.js";
import { viewOf, type ApplyJob, type ApplyJobStore, type SelfRestartResult } from "./apply-job.js";
import { handleQuickstartRequest } from "./quickstart-api.js";
import {
  requestSessionBinding,
  type ConnectionMetadata,
  type ConnectionBinding,
  type BindingProbe,
  type SecretApplyJob,
  type SecretApplyResult,
  type ProviderSecretApplyJob,
} from "./connection-secrets.js";
import type { ProviderSecretStatus } from "./provider-secret-registry.js";
import { providerRegistryEnvKeys, isReservedProviderEnvKey } from "./provider-secret-registry.js";
import {
  STATUS_EMOJI_CONFIG_KEYS, STATUS_EMOJI_SUGGESTIONS, TELEGRAM_REACTION_EMOJIS,
  builtinStatusEmojis, customEmojiValue, emojiProxyUrl, previewStatusEmojis,
  type GuildEmoji, type GuildEmojiGroup,
} from "./status-emojis.js";




/**
 * #2103 review: who may change guest sign-in outside the settings transaction — an admin's session (by its handle) or
 * the header token, as the request is judged NOW; null otherwise. A caller asked again after an await must come back
 * the same: its session revoked, expired or rotated away (or the token rotated) is no one.
 */
function guestSettingsCaller(req: IncomingMessage, url: URL, ctx: { webToken?: string | null; webSessions?: import("./web-session.js").WebSessionStore | null }): string | null {
  const v = evaluateWebRequest(req as never, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (v.kind !== "allow") return null;
  if (v.via === "header-token") return "header-token";
  return v.session.tier === "admin" ? `session:${v.session.handle}` : null;
}

export interface SettingsApiContext extends AppShellContext {
  retryAdapterNow?(id: string): { queued: boolean; already_running?: boolean };
  /** #1920 phase 3: Settings → Web sign-ins → Guests. */
  guestOverview?(): unknown;
  /** #2667: the ClassicBot rooms' instance names — a guest grant may name one, so a save's validation knows them. */
  classicRoomNames?(): string[];
  revokeGuestWebSessions?(owner: { adapterId: string; userId: string }): { count: number; durable: boolean };
  /** #2348 delta §5: one audit entry per person whose granted agents changed with a save (event log, the Log tab). */
  noteGuestGrantChange?(change: { by: string | null; via: "direct" | "confirmed"; account: string; added: string[]; removed: string[]; endedSessions: number }): void;
  /** #2348: the people AgEnD has seen in chat (the Guests picker), never a fleet admin or a bot. */
  guestPeople?(): unknown;
  /** #2348: why an account may not be granted (not seen in chat, a fleet admin, an unknown connection), or null. */
  guestGrantRefusal?(adapterId: string, userId: string): string | null;
  /** #2348: an admin's "Send sign-in code": DM only; the outcome as the Settings card shows it. */
  sendGuestCodeByAdmin?(owner: { adapterId: string; userId: string }, by: string, current?: () => boolean): Promise<{ status: number; body: Record<string, unknown> }>;
  /** #1939 S2a: Settings → Web → Web authority — what is in force, the actions to pick from, and the revocation. */
  webAuthorityOverview?(): unknown;
  revokeWebAuthority?(): { epoch: number; durable: boolean };
  readonly webToken?: string | null;
  readonly webSessions?: import("./web-session.js").WebSessionStore | null;
  fleetConfig: FleetConfig | null;
  configPath: string | null;
  dataDir: string;
  logger: Logger;
  getRawFleetConfig(): RawFleetConfig;
  saveFleetConfig(explicitPatches?: RawConfigPatch[]): void;
  /** Refresh managed guidance and web clients after a committed experimental setting change. */
  canvasWorkerSettingChanged?(): void;
  lifecycle: {
    isPaused(name: string): boolean;
    pause(name: string): Promise<void>;
    wake(name: string, timeoutMs?: number): Promise<void>;
  };
  isClassicInstance?(name: string): boolean;
  /** Delete an agent the way delete_instance and the chat's Delete do (FleetManager.removeInstance): stopped, its schedules
   *  and team places dropped, its fleet.yaml entry removed. Absent in unit contexts that only exercise CRUD. */
  removeInstance?(name: string, authorization: ExplicitInstanceRemoval, execution?: SettingsExecution): Promise<void>;
  /** Phase 2b: an operator wake that respects the warm hard cap (FleetManager.explicitWake). */
  explicitWake?(name: string, timeoutMs?: number, retryStoppedSession?: boolean): Promise<void>;
  restartClassicInstanceFromSettings?(instanceName: string, changedFields?: string[], execution?: SettingsExecution): Promise<void>;
  captureClassicSettingsRestoration?(instanceName: string, changedFields: string[], execution?: SettingsExecution): () => Promise<void>;
  /** Present on a real fleet; absent in unit contexts that only exercise CRUD. */
  applyJobs?: ApplyJobStore;
  startSettingsApply?(key: string): { job: ApplyJob; reused: boolean } | { busy: ApplyJob | null };
  requestSettingsSelfRestart?(jobId: string, key: string): Promise<SelfRestartResult>;
  /** Non-null when the running config and fleet.yaml disagree on a
   * startup-only key, in which case a restart cannot clear the fleet row. */
  fleetSignatureMismatchKeys?(): string[] | null;
  /** #2347: saved changes waiting for an AgEnD restart, and the apply job a restart can be asked for. */
  settingsRestartPending?(): { keys: string[]; job_id: string | null } | null;
  /** #2346: whether a connection added now starts at once (another one is running), or needs AgEnD restarted. */
  connectionsStartLive?(): boolean;
  /** #1005/#1021: a Discord connection's server emojis, from each server its
   * bot can draw on, fetched with its bot token and cached. */
  listGuildEmojis?(channelId: string, refresh?: boolean): Promise<
    { ok: true; fetched_at: number; emojis: GuildEmoji[]; guilds?: GuildEmojiGroup[] }
    | { ok: false; error: string }
  >;
  /** True when a running adapter is already long-polling this bot token. */
  isBotTokenInUse?(token: string): boolean;
  /** Secure Connections & Bots operations. The outer fleet HTTP server has
   * already authenticated the Settings web session before this handler runs. */
  listSecureConnections?(): ConnectionMetadata[];
  verifyConnectionSecret?(input: {
    connectionId: string;
    secret: string;
    sessionBinding: string;
    idempotencyKey: string;
  }): Promise<{ ok: true; verification_id: string; expires_at: number; identity?: { id: string | null; username: string | null } } | { ok: false; error: string }>;
  startConnectionSecretApply?(input: {
    connectionId: string;
    verificationId: string;
    sessionBinding: string;
    idempotencyKey: string;
    execution?: SettingsExecution;
  }): { job: SecretApplyJob; reused: boolean } | { busy: SecretApplyJob | null } | { error: string };
  getConnectionSecretApply?(jobId: string, sessionBinding: string): SecretApplyJob | null;
  /** Generic provider API-key verifier registry (#861). */
  providerSecretsEnabled?(): boolean;
  listProviderSecrets?(): ProviderSecretStatus[];
  verifyProviderSecret?(input: {
    specId: string;
    secret: string;
    clear?: boolean;
    sessionBinding: string;
    idempotencyKey: string;
  }): Promise<{ ok: true; verification_id: string; expires_at: number; spec_id: string; activation: "next_use" | "reload_hook" } | { ok: false; status: string; error: string }>;
  startProviderSecretApply?(input: {
    specId: string;
    verificationId: string;
    sessionBinding: string;
    idempotencyKey: string;
    execution?: SettingsExecution;
  }): { job: ProviderSecretApplyJob; reused: boolean } | { busy: ProviderSecretApplyJob | null } | { error: string };
  getProviderSecretApply?(jobId: string, sessionBinding: string): ProviderSecretApplyJob | null;
  verifyConnectionBinding?(input: {
    connectionId: string;
    binding: { group_id?: unknown; general_channel_id?: unknown };
    sessionBinding: string;
    idempotencyKey: string;
  }): Promise<{ ok: true; verification_id: string; expires_at: number; binding: ConnectionBinding; probe: BindingProbe } | { ok: false; error: string }>;
  startConnectionBindingApply?(input: {
    connectionId: string;
    verificationId: string;
    sessionBinding: string;
    idempotencyKey: string;
    execution?: SettingsExecution;
  }): { job: SecretApplyJob; reused: boolean } | { busy: SecretApplyJob | null } | { error: string };
  getConnectionBindingApply?(jobId: string, sessionBinding: string): SecretApplyJob | null;
}

/** An explicit user-authored YAML mutation that must be persisted even when
 * its value equals the defaults-expanded runtime snapshot. */
export interface RawConfigPatch {
  path: Array<string | number>;
  value?: unknown;
  remove?: boolean;
}

function json(res: ServerResponse, code: number, body: unknown, noStore = false): void {
  res.writeHead(code, {
    "Content-Type": "application/json",
    ...(noStore ? { "Cache-Control": "no-store" } : {}),
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return readBoundedWebBody(req, maxBytes);
}

/**
 * Channel/group identifiers are opaque provider coordinates.  JSON numbers
 * are accepted only while they are still exactly representable, then
 * canonicalized to strings before validation/persistence.  An unsafe number
 * is rejected rather than silently rounding a Discord snowflake.
 */
function normalizeChannelIdValue(value: unknown, path: string):
  { ok: true; value: unknown } | { ok: false; error: string } {
  if (value === undefined || value === null || typeof value === "string") {
    return { ok: true, value };
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return { ok: true, value: String(value) };
  }
  return { ok: false, error: `${path} must be a string (or a safe integer)` };
}

export function isSettingsPath(path: string): boolean {
  return isSettingsPage(path) || path.startsWith("/api/settings/");
}

const classicPath = (ctx: SettingsApiContext) => join(ctx.dataDir, "classicBot.yaml");

class ClassicConfigParseError extends Error {}

function readClassic(ctx: SettingsApiContext): Record<string, unknown> {
  const p = classicPath(ctx);
  if (!existsSync(p)) return {};
  try {
    const parsed = yaml.load(readFileSync(p, "utf-8"));
    if (parsed == null) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be a mapping");
    return parsed as Record<string, unknown>;
  } catch (err) {
    ctx.logger.warn({ err }, "settings: failed to parse classicBot.yaml");
    throw new ClassicConfigParseError(`classicBot.yaml is invalid: ${(err as Error).message}`);
  }
}

function writeClassicAtomic(ctx: SettingsApiContext, classic: Record<string, unknown>): void {
  const target = classicPath(ctx);
  const temp = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const mode = existsSync(target) ? statSync(target).mode : 0o600;
  noteSettingsWrite(target, readClassic(ctx), classic);
  try {
    writeFileSync(temp, yaml.dump(classic, { lineWidth: -1 }), { encoding: "utf-8", mode });
    renameSync(temp, target);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* temp may not have been created */ }
    throw err;
  }
}

const issueKey = (i: { path: string; message: string }) => i.path + "\u0000" + i.message;

/**
 * #1490 (Fable's 2.2 audit): the connection fields Settings writes. A PUT carries whole connections back, so a field
 * outside these (one added by hand to fleet.yaml) passes through unchanged — but it is never added or changed here:
 * an inline `bot_token`, or anything else, cannot reach fleet.yaml through this endpoint.
 */
const CHANNEL_FIELDS = new Set(["id", "type", "mode", "bot_token_env", "group_id", "access", "options", "telegram_api_root", "mirror_topic_id"]);
const CHANNEL_ACCESS_FIELDS = new Set(["mode", "allowed_users", "max_pending_codes", "code_expiry_minutes"]);
const CHANNEL_OPTION_FIELDS = new Set(["category_name", "general_channel_id", "topic_probe", "sticker_sets", "status_emojis"]);
function unownedChannelField(candidate: Record<string, unknown>, previous: Record<string, unknown> | undefined): string | null {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const check = (fields: ReadonlySet<string>, next: Record<string, unknown>, prev: unknown, at: string): string | null => {
    const before = record(prev) ? prev : {};
    for (const key of Object.keys(next)) {
      if (fields.has(key)) continue;
      if (Object.hasOwn(before, key) && JSON.stringify(before[key]) === JSON.stringify(next[key])) continue;
      return `${at}${key}`;
    }
    return null;
  };
  return check(CHANNEL_FIELDS, candidate, previous, "")
    ?? (record(candidate.access) ? check(CHANNEL_ACCESS_FIELDS, candidate.access, previous?.access, "access.") : null)
    ?? (record(candidate.options) ? check(CHANNEL_OPTION_FIELDS, candidate.options, previous?.options, "options.") : null);
}

/**
 * Reject a write only if it INTRODUCES new validation errors. Pre-existing
 * errors elsewhere in the config (common while a fleet is being assembled)
 * must not block an unrelated edit — otherwise one bad channel would lock the
 * user out of saving anything, which reads as "save didn't persist".
 * Returns true (and responds 400) when the edit adds errors.
 */
function rejectIfWorse(res: ServerResponse, before: ValidationResult, after: ValidationResult): boolean {
  const had = new Set(before.errors.map(issueKey));
  const introduced = after.errors.filter(e => !had.has(issueKey(e)));
  if (introduced.length) {
    json(res, 400, { ok: false, errors: introduced, warnings: after.warnings });
    return true;
  }
  return false;
}

/** Warnings to surface on a successful save: new warnings + any pre-existing errors (informational). */
function saveWarnings(before: ValidationResult, after: ValidationResult): Array<{ path: string; message: string }> {
  const had = new Set(before.errors.map(issueKey));
  const preExisting = after.errors.filter(e => had.has(issueKey(e))).map(e => ({ path: e.path, message: "pre-existing: " + e.message }));
  return [...after.warnings, ...preExisting];
}

export function handleSettingsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: SettingsApiContext,
): boolean {
  const path = url.pathname;
  if (!isSettingsPath(path)) return false;
  // #2667: validated with the ClassicBot rooms there are now — a guest grant naming one is not an unknown name.
  const validateFleet = (config: unknown) => validateFleetConfig(config, { rooms: ctx.classicRoomNames?.() ?? [] });
  const method = req.method ?? "GET";

  // ── The page: the app shell, which mounts the Settings panel (#1408 step 3) ──
  if (isSettingsPage(path)) {
    if (method !== "GET" && method !== "HEAD") { json(res, 405, { error: "Method not allowed" }); return true; }
    serveAppShell(req, res, ctx, "full");
    return true;
  }

  // ── Reads ──
  // What each field costs to change, derived from HOT_INSTANCE_CONFIG_KEYS.
  // The page used to carry its own copy of the hot set plus one hand-written
  // badge per field, which could disagree with what the fleet actually does.
  if (method === "GET" && path === "/api/settings/schema") {
    json(res, 200, {
      ...buildSettingsImpactSchema(),
      reply_triggers_default: DEFAULT_REPLY_TRIGGERS,
      // Non-null means a restart cannot clear the fleet row, so the page shows
      // the mismatch instead of offering a button that can never succeed.
      fleet_signature_mismatch: ctx.fleetSignatureMismatchKeys?.() ?? null,
      // Whether the provider-secret routes exist on this fleet: the page reads them only then (no 404 on every load).
      provider_secrets: ctx.providerSecretsEnabled?.() === true,
      // #2346: a new connection starts without a restart while another one runs (#1519 P6); the first one needs one.
      connections_start_live: ctx.connectionsStartLive?.() === true,
    });
    return true;
  }
  // #2347: what the app-wide "Restart now" banner reads — small, so every page can ask after a Save settles.
  if (method === "GET" && path === "/api/settings/restart-pending") {
    const pending = ctx.settingsRestartPending?.() ?? null;
    json(res, 200, pending ? { pending: true, keys: pending.keys, job_id: pending.job_id } : { pending: false });
    return true;
  }
  if (method === "GET" && path === "/api/settings/fleet") {
    json(res, 200, redactInlineSecrets(ctx.fleetConfig ?? {}));
    return true;
  }
  if (method === "GET" && path === "/api/settings/fleet/raw") {
    json(res, 200, redactInlineSecrets(ctx.getRawFleetConfig()));
    return true;
  }
  if (method === "GET" && path === "/api/settings/classic") {
    try { json(res, 200, readClassic(ctx)); }
    catch (err) { json(res, 409, { error: (err as Error).message }); }
    return true;
  }

  // ── Status emojis (#1005) ──
  // The picker and preview resolve on the server with the same code the
  // reaction path runs, so what Settings shows is what a bot stamps.
  if (method === "GET" && path === "/api/settings/status-emojis") {
    json(res, 200, {
      keys: STATUS_EMOJI_CONFIG_KEYS,
      builtins: { discord: builtinStatusEmojis("discord"), telegram: builtinStatusEmojis("telegram") },
      telegram_allowed: [...TELEGRAM_REACTION_EMOJIS],
      suggestions: STATUS_EMOJI_SUGGESTIONS,
    });
    return true;
  }
  if (method === "POST" && path === "/api/settings/status-emojis/preview") {
    readBody(req, 64 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      // The platform is the connection's type when one is named; an explicit
      // platform covers a connection that is not saved yet.
      const channels = ctx.fleetConfig?.channels ?? (ctx.fleetConfig?.channel ? [ctx.fleetConfig.channel] : []);
      const named = typeof body.channel_id === "string" && body.channel_id
        ? channels.find(ch => (ch.id ?? ch.type) === body.channel_id) : channels[0];
      const platform = typeof body.platform === "string" ? body.platform : named?.type;
      json(res, 200, previewStatusEmojis({
        platform,
        platformConfig: "channel_config" in body ? body.channel_config : named?.options?.status_emojis,
        instanceConfig: body.instance_config,
        imageUrl: emojiProxyUrl,          // #1630: the page shows it from the dashboard's own route, never Discord's CDN
      }));
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }
  if (method === "GET" && path === "/api/settings/status-emojis/guild-emojis") {
    if (!ctx.listGuildEmojis) { json(res, 501, { error: "guild emoji listing unavailable" }); return true; }
    const channelId = url.searchParams.get("channel") ?? "";
    if (!channelId) { json(res, 400, { error: "channel required" }); return true; }
    ctx.listGuildEmojis(channelId, url.searchParams.get("refresh") === "1").then(result => {
      if (!result.ok) return json(res, 409, { error: result.error });
      const pickable = (e: GuildEmoji) => {
        const value = customEmojiValue(e);
        return { ...e, value, image_url: emojiProxyUrl(value) };     // #1630: from the dashboard's own route
      };
      json(res, 200, {
        fetched_at: result.fetched_at,
        emojis: result.emojis.map(pickable),
        guilds: (result.guilds ?? [{ id: "", name: "", primary: true, emojis: result.emojis }]).map(g => ({
          id: g.id, name: g.name, primary: g.primary,
          ...(g.emojis ? { emojis: g.emojis.map(pickable) } : { error: g.error ?? "unavailable" }),
        })),
      });
    }).catch(() => json(res, 502, { error: "guild emoji listing failed" }));
    return true;
  }

  // ── Secure Connections & Bots ──
  // These routes deliberately do not reuse the broad fleet/channel CRUD API:
  // a token is accepted only in a body, verified server-side, and never echoed
  // or written to a log/SSE frame. Adapter replacement is owned by FleetManager
  // so writing .env alone can never be reported as "applied".
  if (method === "GET" && path === "/api/settings/connections") {
    if (!ctx.listSecureConnections) { json(res, 501, { error: "connection secrets unavailable" }); return true; }
    json(res, 200, ctx.listSecureConnections().map(connection => ({
      ...connection,
      token_present: !!connection.token_present,
    })), true);
    return true;
  }

  const retryConnection = path.match(/^\/api\/settings\/connections\/([^/]+)\/retry$/);
  if (method === "POST" && retryConnection) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Connection retries are not permitted over a public link" }); return true; }
    if (!guestSettingsCaller(req, url, ctx)) { json(res, 403, { error: "An admin sign-in is required" }); return true; }
    if (!ctx.retryAdapterNow) { json(res, 503, { error: "The fleet is not running" }); return true; }
    try {
      const result = ctx.retryAdapterNow(decodeURIComponent(retryConnection[1]));
      json(res, result.queued ? 202 : 200, result);
    } catch {
      json(res, 409, { error: "This connection cannot be retried. Check that it is configured and the fleet is running." });
    }
    return true;
  }

  // Generic provider API-key registry.  Unlike the legacy connection token
  // routes, this endpoint accepts a code-owned spec id only; env key, origin,
  // auth header and verifier are resolved server-side.  The body is consumed
  // once and no secret-bearing value is ever placed in a URL, job, SSE frame,
  // or response.
  const tunnelSecretRoute = /^\/api\/settings\/public-tunnel-token(?:\/(?:verify|apply)(?:\/[A-Za-z0-9_-]+)?)?$/.test(path);
  const providerPath = tunnelSecretRoute ? path === "/api/settings/public-tunnel-token" ? "/api/settings/secrets"
    : path.replace("/api/settings/public-tunnel-token", `/api/settings/secrets/${PUBLIC_TUNNEL_SECRET_ID}`) : path;
  const providerSecretsEnabled = tunnelSecretRoute || ctx.providerSecretsEnabled?.() === true;
  if (method === "GET" && (providerPath === "/api/settings/provider-secrets" || providerPath === "/api/settings/secrets")) {
    if (!providerSecretsEnabled) { json(res, 404, { error: "not found" }, true); return true; }
    if (!ctx.listProviderSecrets) { json(res, 501, { error: "provider secret registry unavailable" }, true); return true; }
    json(res, 200, ctx.listProviderSecrets().filter(item => tunnelSecretRoute ? item.id === PUBLIC_TUNNEL_SECRET_ID : item.id !== PUBLIC_TUNNEL_SECRET_ID).map(item => ({
      id: item.id,
      display_name: item.display_name,
      kind: item.kind,
      token_present: item.token_present,
      verifier: item.verifier,
      activation: item.activation,
      stale_consumers: item.stale_consumers,
    })), true);
    return true;
  }

  const providerSecretVerifyMatch = providerPath.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/([^/]+)\/verify$/);
  if (method === "POST" && providerSecretVerifyMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Secret operations are not permitted over a public link" }, true); return true; }
    if (!providerSecretsEnabled) { json(res, 404, { error: "not found" }, true); return true; }
    if (!ctx.verifyProviderSecret) { json(res, 501, { error: "provider secret registry unavailable" }, true); return true; }
    const specId = decodeURIComponent(providerSecretVerifyMatch[1]!);
    readBody(req, 16 * 1024).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }, true); }
      const secret = typeof body.secret === "string" ? body.secret : "";
      const key = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"] : typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      if (!secret && specId !== PUBLIC_TUNNEL_SECRET_ID) return json(res, 400, { error: "secret required" }, true);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = await ctx.verifyProviderSecret!({ specId, secret, ...(tunnelSecretRoute ? { clear: body.clear === true } : {}), sessionBinding: requestSessionBinding(req), idempotencyKey: key });
      if (!result.ok) {
        const code = result.status === "unsupported_verifier" ? 422 : result.status === "provider_unavailable" ? 503 : 422;
        if (specId === PUBLIC_TUNNEL_SECRET_ID && result.status === "invalid") {
          return json(res, code, { ok: false, result: "invalid", error_code: "invalid_tunnel_token", error: PUBLIC_TUNNEL_TOKEN_HINT }, true);
        }
        return json(res, code, { ok: false, result: result.status, error: result.status === "unsupported_verifier" ? "unsupported verifier" : "provider secret verification failed" }, true);
      }
      json(res, 200, { ok: true, result: tunnelSecretRoute || specId === PUBLIC_TUNNEL_SECRET_ID ? "prepared" : "verified", verification_id: result.verification_id, expires_at: result.expires_at, spec_id: result.spec_id, activation: result.activation }, true);
    }).catch(() => json(res, 400, { error: "bad request" }, true));
    return true;
  }

  const providerSecretApplyMatch = providerPath.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/([^/]+)\/apply$/);
  if (method === "POST" && providerSecretApplyMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Secret operations are not permitted over a public link" }, true); return true; }
    if (!providerSecretsEnabled) { json(res, 404, { error: "not found" }, true); return true; }
    if (!ctx.startProviderSecretApply) { json(res, 501, { error: "provider secret registry unavailable" }, true); return true; }
    const specId = decodeURIComponent(providerSecretApplyMatch[1]!);
    readBody(req, 16 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }, true); }
      const verificationId = typeof body.verification_id === "string" ? body.verification_id : "";
      const key = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"] : typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      if (!verificationId) return json(res, 400, { error: "verification_id required" }, true);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = ctx.startProviderSecretApply!({ specId, verificationId, sessionBinding: requestSessionBinding(req), idempotencyKey: key, execution: settingsRequestExecution(req) });
      if ("error" in result) return json(res, 422, { ok: false, error: "provider secret apply rejected" }, true);
      if ("busy" in result) return json(res, 409, { ok: false, result: "applying", job_id: result.busy?.id ?? null }, true);
      json(res, result.reused ? 200 : 202, { ok: true, result: result.job.result, job_id: result.job.id, reused: result.reused, stale_consumers: result.job.stale_consumers ?? [] }, true);
    }).catch(() => json(res, 400, { error: "bad request" }, true));
    return true;
  }

  const providerSecretStatusMatch = providerPath.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/[^/]+\/apply\/([A-Za-z0-9_-]+)$/);
  if (method === "GET" && providerSecretStatusMatch) {
    if (!providerSecretsEnabled) { json(res, 404, { error: "not found" }, true); return true; }
    if (!ctx.getProviderSecretApply) { json(res, 501, { error: "provider secret registry unavailable" }, true); return true; }
    const job = ctx.getProviderSecretApply(providerSecretStatusMatch[1]!, requestSessionBinding(req));
    if (!job) { json(res, 404, { error: "job not found" }, true); return true; }
    json(res, 200, job, true);
    return true;
  }

  const secretVerifyMatch = path.match(/^\/api\/settings\/connections\/([^/]+)\/secret\/verify$/);
  if (method === "POST" && secretVerifyMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Secret operations are not permitted over a public link" }, true); return true; }
    const verifyConnectionSecret = ctx.verifyConnectionSecret;
    if (!verifyConnectionSecret) { json(res, 501, { error: "connection secret verification unavailable" }); return true; }
    const connectionId = decodeURIComponent(secretVerifyMatch[1]!);
    readBody(req, 16 * 1024).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const secret = typeof body.secret === "string" ? body.secret : "";
      const key = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"] : typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      if (!secret) return json(res, 400, { error: "secret required" }, true);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = await verifyConnectionSecret({
        connectionId,
        secret,
        sessionBinding: requestSessionBinding(req),
        idempotencyKey: key,
      });
      // The provider may have echoed request material in an SDK error. Keep
      // the HTTP contract deliberately generic; FleetManager logs only a
      // redacted diagnostic and the browser has no need for the raw reason.
      if (!result.ok) return json(res, 422, { ok: false, error: "secret verification failed" }, true);
      json(res, 200, {
        ok: true,
        result: "verified" satisfies SecretApplyResult,
        verification_id: result.verification_id,
        expires_at: result.expires_at,
        identity: result.identity,
      }, true);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  const secretApplyMatch = path.match(/^\/api\/settings\/connections\/([^/]+)\/secret\/apply$/);
  if (method === "POST" && secretApplyMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Secret operations are not permitted over a public link" }, true); return true; }
    if (!ctx.startConnectionSecretApply) { json(res, 501, { error: "connection secret apply unavailable" }); return true; }
    const connectionId = decodeURIComponent(secretApplyMatch[1]!);
    readBody(req, 16 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const verificationId = typeof body.verification_id === "string" ? body.verification_id : "";
      const key = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"] : typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      if (!verificationId) return json(res, 400, { error: "verification_id required" }, true);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = ctx.startConnectionSecretApply!({
        connectionId,
        verificationId,
        sessionBinding: requestSessionBinding(req),
        idempotencyKey: key, execution: settingsRequestExecution(req),
      });
      if ("error" in result) return json(res, 422, { ok: false, error: "secret apply rejected" }, true);
      if ("busy" in result) return json(res, 409, {
        ok: false,
        result: "applying" satisfies SecretApplyResult,
        job_id: result.busy?.id ?? null,
      }, true);
      json(res, result.reused ? 200 : 202, {
        ok: true,
        result: result.job.result,
        job_id: result.job.id,
        reused: result.reused,
      }, true);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  const secretApplyStatusMatch = path.match(/^\/api\/settings\/connections\/[^/]+\/secret\/apply\/([A-Za-z0-9_-]+)$/);
  if (method === "GET" && secretApplyStatusMatch) {
    if (!ctx.getConnectionSecretApply) { json(res, 501, { error: "connection secret apply unavailable" }); return true; }
    const job = ctx.getConnectionSecretApply(secretApplyStatusMatch[1]!, requestSessionBinding(req));
    if (!job) { json(res, 404, { error: "job not found" }, true); return true; }
    // Job errors are already provider-redacted by FleetManager. Never add raw
    // request data here, and never expose a secret-bearing provider response.
    json(res, 200, job, true);
    return true;
  }

  const bindingVerifyMatch = path.match(/^\/api\/settings\/connections\/([^/]+)\/binding\/verify$/);
  if (method === "POST" && bindingVerifyMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Secret operations are not permitted over a public link" }, true); return true; }
    if (!ctx.verifyConnectionBinding) { json(res, 501, { error: "connection binding verification unavailable" }); return true; }
    const connectionId = decodeURIComponent(bindingVerifyMatch[1]!);
    readBody(req, 16 * 1024).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      // Provider IDs must arrive as strings. Accepting a JSON number here can
      // round a Discord snowflake before the verifier ever sees it.
      if (typeof body.group_id !== "string"
        || (body.general_channel_id !== undefined
          && body.general_channel_id !== null
          && typeof body.general_channel_id !== "string")) {
        return json(res, 400, { error: "binding IDs must be strings" }, true);
      }
      const key = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"] : typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = await ctx.verifyConnectionBinding!({
        connectionId,
        binding: { group_id: body.group_id, general_channel_id: body.general_channel_id },
        sessionBinding: requestSessionBinding(req),
        idempotencyKey: key,
      });
      if (!result.ok) return json(res, 422, { ok: false, error: "binding verification failed" }, true);
      json(res, 200, {
        ok: true, result: "verified" satisfies SecretApplyResult,
        verification_id: result.verification_id, expires_at: result.expires_at,
        binding: result.binding, probe: result.probe,
      }, true);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  const bindingApplyMatch = path.match(/^\/api\/settings\/connections\/([^/]+)\/binding\/apply$/);
  if (method === "POST" && bindingApplyMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "Secret operations are not permitted over a public link" }, true); return true; }
    if (!ctx.startConnectionBindingApply) { json(res, 501, { error: "connection binding apply unavailable" }); return true; }
    const connectionId = decodeURIComponent(bindingApplyMatch[1]!);
    readBody(req, 16 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const verificationId = typeof body.verification_id === "string" ? body.verification_id : "";
      const key = typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"] : typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      if (!verificationId) return json(res, 400, { error: "verification_id required" }, true);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = ctx.startConnectionBindingApply!({
        connectionId, verificationId, sessionBinding: requestSessionBinding(req), idempotencyKey: key, execution: settingsRequestExecution(req),
      });
      if ("error" in result) return json(res, 422, { ok: false, error: "binding apply rejected" }, true);
      if ("busy" in result) return json(res, 409, { ok: false, result: "applying" satisfies SecretApplyResult, job_id: result.busy?.id ?? null }, true);
      json(res, result.reused ? 200 : 202, { ok: true, result: result.job.result, job_id: result.job.id, reused: result.reused }, true);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  const bindingApplyStatusMatch = path.match(/^\/api\/settings\/connections\/[^/]+\/binding\/apply\/([A-Za-z0-9_-]+)$/);
  if (method === "GET" && bindingApplyStatusMatch) {
    if (!ctx.getConnectionBindingApply) { json(res, 501, { error: "connection binding apply unavailable" }); return true; }
    const job = ctx.getConnectionBindingApply(bindingApplyStatusMatch[1]!, requestSessionBinding(req));
    if (!job) { json(res, 404, { error: "job not found" }, true); return true; }
    json(res, 200, job, true);
    return true;
  }

  // Everything below mutates — needs an in-memory fleet config.
  const cfg = ctx.fleetConfig;

  // ── Manual pause / wake ──
  const actionMatch = path.match(/^\/api\/settings\/instances\/([^/]+)\/(pause|wake)$/);
  if (method === "POST" && actionMatch) {
    const name = decodeURIComponent(actionMatch[1]);
    if (!name || !/^[^\\/\x00]+$/.test(name)) { json(res, 400, { error: "invalid instance name" }); return true; }
    if (!cfg?.instances[name] && !ctx.isClassicInstance?.(name)) { json(res, 404, { error: "instance not found" }); return true; }
    const action = actionMatch[2];
    let held = false;
    const operation = withSpawnHoldReply(async message => { held = true; json(res, 202, { ok: true, held: true, message, name }); },
      () => action === "pause"
        ? ctx.lifecycle.pause(name)
        : ctx.explicitWake ? ctx.explicitWake(name, 30_000, true) : ctx.lifecycle.wake(name, 30_000));
    operation.then(() => { if (!held) json(res, 200, { ok: true, name, status: action === "pause" ? "paused" : "running" }); })
      .catch(err => { if (!held) json(res, 409, { error: (err as Error).message }); else ctx.logger.error({ err, name }, "Held wake failed"); });
    return true;
  }

  // ── #1920 phase 3: Settings → Web sign-ins → Guests. The list (GET) and an account's sign-out (POST — it only takes
  // away, so it is not a confirmed change). Never over the public link. The switches and lists are fleet/web's PUT.
  if (path === "/api/settings/guests" && method === "GET") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "guest_settings_not_over_public_link" }); return true; }
    if (!ctx.guestOverview) { json(res, 404, { error: "not available" }); return true; }
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, ctx.guestOverview());
    return true;
  }
  // #2348: the picker's people (GET) and an admin's "Send sign-in code" (POST: a DM to an applied grant's account, once
  // a minute per account — a code is not a settings change: the grant it needs was already confirmed). Never over the
  // public link; the caller asked again after the body, as the sign-out below.
  if (path === "/api/settings/guests/people" && method === "GET") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "guest_settings_not_over_public_link" }); return true; }
    if (!ctx.guestPeople) { json(res, 404, { error: "not available" }); return true; }
    if (!guestSettingsCaller(req, url, ctx)) { json(res, 401, { error: "not authorized" }); return true; }
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, ctx.guestPeople());
    return true;
  }
  if (path === "/api/settings/guests/send-code" && method === "POST") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "guest_settings_not_over_public_link" }); return true; }
    if (!ctx.sendGuestCodeByAdmin) { json(res, 404, { error: "not available" }); return true; }
    const caller = guestSettingsCaller(req, url, ctx);
    if (!caller) { json(res, 401, { error: "not authorized" }); return true; }
    readBody(req, 4096).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      if (guestSettingsCaller(req, url, ctx) !== caller) return json(res, 401, { error: "no longer authorized" });
      let body: { adapterId?: unknown; userId?: unknown };
      try { body = JSON.parse(buf.toString("utf-8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body?.adapterId !== "string" || !body.adapterId || typeof body.userId !== "string" || !body.userId) return json(res, 400, { error: "adapterId and userId required" });
      // #2365 review: the initiating admin's session, asked again after every wait inside the issuance.
      const out = await ctx.sendGuestCodeByAdmin!({ adapterId: body.adapterId, userId: body.userId }, caller, () => guestSettingsCaller(req, url, ctx) === caller);
      json(res, out.status, out.body);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }
  if (path === "/api/settings/guests/revoke" && method === "POST") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "guest_settings_not_over_public_link" }); return true; }
    if (!ctx.revokeGuestWebSessions) { json(res, 404, { error: "not available" }); return true; }
    // #2103 review: not a gated settings change (it only takes away), so no transaction fences it — the caller is
    // asked again after the body: the same admin session (or the header token) still current, else nothing happens.
    const caller = guestSettingsCaller(req, url, ctx);
    if (!caller) { json(res, 401, { error: "not authorized" }); return true; }
    readBody(req, 4096).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      if (guestSettingsCaller(req, url, ctx) !== caller) return json(res, 401, { error: "no longer authorized" });
      let body: { adapterId?: unknown; userId?: unknown };
      try { body = JSON.parse(buf.toString("utf-8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body?.adapterId !== "string" || !body.adapterId || typeof body.userId !== "string" || !body.userId) return json(res, 400, { error: "adapterId and userId required" });
      const ended = ctx.revokeGuestWebSessions!({ adapterId: body.adapterId, userId: body.userId });
      json(res, 200, { ok: true, count: ended.count, durable: ended.durable });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── #1939 S2a: Settings → Web → Web authority. What is in force (GET) and "Revoke web authority" (POST — it only
  // takes away, so it is not a confirmed change; the caller is asked again after the body, as the guests' sign-out).
  // Never over the public link. The switches and the lists are fleet/web's PUT.
  if (path === "/api/settings/web-authority" && method === "GET") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "web_authority_not_over_public_link" }); return true; }
    if (!ctx.webAuthorityOverview) { json(res, 404, { error: "not available" }); return true; }
    res.setHeader("Cache-Control", "no-store");
    json(res, 200, ctx.webAuthorityOverview());
    return true;
  }
  if (path === "/api/settings/web-authority/revoke" && method === "POST") {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "web_authority_not_over_public_link" }); return true; }
    if (!ctx.revokeWebAuthority) { json(res, 404, { error: "not available" }); return true; }
    const caller = guestSettingsCaller(req, url, ctx);
    if (!caller) { json(res, 401, { error: "not authorized" }); return true; }
    readBody(req, 1024).then(() => {
      if (!permitWebContinuation(req, res, ctx)) return;
      if (guestSettingsCaller(req, url, ctx) !== caller) return json(res, 401, { error: "no longer authorized" });
      const r = ctx.revokeWebAuthority!();
      json(res, 200, { ok: true, epoch: r.epoch, durable: r.durable });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // One hot web toggle; an unrelated Settings edit never materializes defaults.
  if (method === "PUT" && path === "/api/settings/fleet/web") {
    // #1620: never over the temporary public link — refused before the body is read (the confirmation gate refuses it
    // first; this is the second wall, for any path that reaches the handler without it).
    if (gatewayRequestContext(req)) { json(res, 403, { error: "web_settings_not_over_public_link" }); return true; }
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    // #1920 phase 3: room for guest lists (open_instances, narrow — up to 200 names each); the gate reads up to 512 KiB.
    readBody(req, 256 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: unknown;
      try { body = JSON.parse(buf.toString("utf-8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const parsed = parseWebSettingsBody(body);
      if ("error" in parsed) return json(res, 400, { error: parsed.error });
      if (parsed.canvasWorker !== undefined && !settingsRequestLocalAdmin(req)) {
        const actor = evaluateWebRequest(req as never, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
        if (actor.kind !== "allow" || actor.via !== "session" || actor.session.tier !== "admin" || actor.session.surface !== "local") {
          return json(res, 403, { error: "canvas_worker_setting_needs_local_admin" });
        }
      }
      const { session: sessionPatch, terminal: terminalPatch } = parsed;
      // #2499 review: who is saving, asked now, before the save — a session policy saved with it can end this very session
      // (a shorter sign-in time), and the audit must still name who did it. A confirmation's replay is no one's: null.
      const auditBy = parsed.guests?.grants !== undefined && !isSettingsReplay(req) ? guestSettingsCaller(req, url, ctx) : null;
      const changes: RawConfigPatch[] = [];
      let web = { ...cfg.web };
      let webTerminal = cfg.web_terminal;
      if (parsed.canvasWorker !== undefined) {
        web.experimental = { ...web.experimental, canvas_worker: parsed.canvasWorker };
        changes.push({ path: ["web", "experimental", "canvas_worker"], value: parsed.canvasWorker });
      }
      if (parsed.notifyLogin !== undefined) {
        const holder = { defaults: cfg.defaults, web }; setNoticeMode(holder, "login", parsed.notifyLogin); web = holder.web;
        changes.push({ path: ["web", "notify_login"], value: web.notify_login },
          { path: ["web", "notice_delivery", "login"], remove: true });
      }
      if (parsed.echo !== undefined) { web.echo_to_channel = parsed.echo; changes.push({ path: ["web", "echo_to_channel"], value: parsed.echo }); }
      if (parsed.logTab !== undefined) { web.log_tab = parsed.logTab; changes.push({ path: ["web", "log_tab"], value: parsed.logTab }); }
      if (parsed.usageOnPublicLink !== undefined) { web.usage_report_on_public_link = parsed.usageOnPublicLink; changes.push({ path: ["web", "usage_report_on_public_link"], value: parsed.usageOnPublicLink }); }
      if (parsed.publicLink) {
        if (Object.keys(parsed.publicLink).length) web.public_link = { ...web.public_link, ...parsed.publicLink };
        for (const [key, value] of Object.entries(parsed.publicLink)) changes.push({ path: ["web", "public_link", key], value });
      }
      if (sessionPatch) {
        const local: Record<string, number> = { ...web.session?.local };
        for (const [key, value] of Object.entries(sessionPatch)) {
          if (value === null) { delete local[key]; changes.push({ path: ["web", "session", "local", key], value: undefined, remove: true }); }
          else { local[key] = value; changes.push({ path: ["web", "session", "local", key], value }); }
        }
        web.session = { ...web.session, local };
      }
      if (terminalPatch) {
        const wt: Record<string, unknown> = { ...cfg.web_terminal };
        for (const [key, value] of Object.entries(terminalPatch)) {
          if (value === null) { delete wt[key]; changes.push({ path: ["web_terminal", key], value: undefined, remove: true }); }
          else { wt[key] = value; changes.push({ path: ["web_terminal", key], value }); }
        }
        webTerminal = wt as typeof cfg.web_terminal;
      }
      // #1920 phase 3: guest sign-in (Settings → Web sign-ins → Guests); widening it is confirmed (settings-change.ts).
      if (parsed.guests) {
        // #2348: a new grant names someone AgEnD has seen in chat, on a connection of this fleet, who is not a fleet admin
        // (admins sign in as admins). One already granted may be edited or removed whatever the list says now.
        for (const [key, grant] of Object.entries(parsed.guests.grants ?? {})) {
          if (grant === null || (cfg.web?.guests?.grants && Object.hasOwn(cfg.web.guests.grants, key))) continue;
          const at = key.indexOf(":");
          const refused = ctx.guestGrantRefusal ? ctx.guestGrantRefusal(key.slice(0, at), key.slice(at + 1)) : "guest grants are not available";
          if (refused) return json(res, 400, { error: refused, key: "guest_grant_refused", account: key });
        }
        const applied = applyGuestsPatch(cfg.web?.guests, parsed.guests);
        if (applied.next) web.guests = applied.next; else delete web.guests;
        changes.push(...applied.changes);
      }
      // #1939 S2a: web authority; loosening it is confirmed, tightening applies at once (settings-change.ts).
      if (parsed.verifiedAuthority) {
        const applied = applyVerifiedAuthorityPatch(cfg.web?.verified_authority, parsed.verifiedAuthority);
        if (applied.next) web.verified_authority = applied.next; else delete web.verified_authority;
        changes.push(...applied.changes);
      }
      if (!changes.length) return json(res, 200, { ok: true });
      const before = validateFleet(cfg);
      const after = validateFleet({ ...cfg, web, web_terminal: webTerminal });
      if (rejectIfWorse(res, before, after)) return;
      const previous = { web: cfg.web, hadWeb: "web" in cfg, terminal: cfg.web_terminal, hadTerminal: "web_terminal" in cfg };
      try {
        settingsWrite(req, () => { cfg.web = web; if (terminalPatch) cfg.web_terminal = webTerminal; ctx.saveFleetConfig(changes); });
      } catch (err) {
        // #1627 review: the save refused (fleet.yaml unchanged): memory goes back to what the file still says — a session
        // limit or the browser terminal must never be live while the file (and the next start) says otherwise.
        if (previous.hadWeb) cfg.web = previous.web; else delete (cfg as { web?: unknown }).web;
        if (previous.hadTerminal) cfg.web_terminal = previous.terminal; else delete (cfg as { web_terminal?: unknown }).web_terminal;
        ctx.logger.warn({ err }, "settings: web save refused");
        return json(res, 500, { ok: false, error: (err as Error).message });
      }
      if (parsed.canvasWorker !== undefined && (previous.web?.experimental?.canvas_worker === true) !== parsed.canvasWorker) {
        ctx.canvasWorkerSettingChanged?.();
      }
      // #2348: a grant taken away (or emptied) ends that person's guest access now — sessions, an outstanding code, and
      // remembered browsers — not at their next request. A narrowed grant keeps its sessions; they see less from now on.
      const ended = new Map<string, number>();
      for (const [key, grant] of Object.entries(parsed.guests?.grants ?? {})) {
        if (grant !== null && grant.instances.length) continue;
        const at = key.indexOf(":");
        try { ended.set(key, ctx.revokeGuestWebSessions?.({ adapterId: key.slice(0, at), userId: key.slice(at + 1) })?.count ?? 0); }
        catch (err) { ctx.logger.warn({ err }, "settings: could not end a removed guest's sessions"); }
      }
      // #2348 delta §5: every grant change is audited, widening (confirmed in General, replayed here) or narrowing (at
      // once) alike: who, how, the agents added and taken away. Agent names only; never message content. Shown under
      // Recent changes in Settings → Guests (guestOverview), never to a guest or over the public link.
      if (parsed.guests?.grants !== undefined && ctx.noteGuestGrantChange) {
        const was = previous.web?.guests?.grants ?? {}, now = cfg.web?.guests?.grants ?? {};
        const by = auditBy, via = isSettingsReplay(req) ? "confirmed" as const : "direct" as const;
        for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
          const a = new Set(Object.hasOwn(was, key) ? was[key]!.instances : []), b = new Set(Object.hasOwn(now, key) ? now[key]!.instances : []);
          const added = [...b].filter((n) => !a.has(n)), removed = [...a].filter((n) => !b.has(n));
          if (!added.length && !removed.length) continue;
          try { ctx.noteGuestGrantChange({ by, via, account: key, added, removed, endedSessions: ended.get(key) ?? 0 }); }
          catch (err) { ctx.logger.warn({ err }, "settings: could not audit a guest grant change"); }
        }
      }
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── #1629 r4.1 Q3 (b): the identity card's upload limits (Settings → Appearance) — never over the public link: absent
  // from its manifest, and refused here too. A lower limit applies directly; a higher one is confirmed (settings-change.ts).
  if (path === "/api/settings/fleet/appearance" && (method === "GET" || method === "PUT")) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "appearance_settings_not_over_public_link" }); return true; }
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    const view = (configured: unknown) => {
      const { limits, warnings } = effectiveAppearanceLimits(configured);
      const kib = (n: number) => n / 1024;
      return {
        configured: configured ?? {},
        effective: {
          portrait: { max_width: limits.portrait.maxWidth, max_height: limits.portrait.maxHeight, max_kib: kib(limits.portrait.maxBytes) },
          banner: { max_width: limits.banner.maxWidth, max_height: limits.banner.maxHeight, max_kib: kib(limits.banner.maxBytes) },
          instance_quota: { files: limits.quota.files, mib: limits.quota.bytes / 1024 / 1024 },
        },
        defaults: APPEARANCE_DEFAULTS, bounds: APPEARANCE_BOUNDS, warnings,
      };
    };
    if (method === "GET") { json(res, 200, view(cfg.web?.appearance)); return true; }
    readBody(req, 4096).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: unknown;
      try { body = JSON.parse(buf.toString("utf-8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const parsed = parseAppearanceSettingsBody(body);
      if ("error" in parsed) return json(res, 400, { error: parsed.error });
      if (!parsed.length) return json(res, 200, { ok: true, ...view(cfg.web?.appearance) });
      const appearance = applyAppearanceChanges(cfg.web?.appearance, parsed);
      const web = { ...cfg.web };
      if (appearance) web.appearance = appearance; else delete web.appearance;
      const changes: RawConfigPatch[] = parsed.map(c => c.value === null
        ? { path: ["web", "appearance", c.group, c.key], value: undefined, remove: true }
        : { path: ["web", "appearance", c.group, c.key], value: c.value });
      const before = validateFleet(cfg);
      const after = validateFleet({ ...cfg, web });
      if (rejectIfWorse(res, before, after)) return;
      const previous = { web: cfg.web, hadWeb: "web" in cfg };
      try {
        settingsWrite(req, () => { cfg.web = web; ctx.saveFleetConfig(changes); });
      } catch (err) {
        if (previous.hadWeb) cfg.web = previous.web; else delete (cfg as { web?: unknown }).web;
        ctx.logger.warn({ err }, "settings: appearance save refused");
        return json(res, 500, { ok: false, error: (err as Error).message });
      }
      json(res, 200, { ok: true, ...view(web.appearance) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Fleet defaults ──
  if (method === "PUT" && path === "/api/settings/fleet/defaults") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const restored = restoreRedactedSecrets(body, cfg.defaults);
      if ("path" in restored) return json(res, 400, { error: `redacted value has no stored credential: defaults.${restored.path}` });
      const merged = { ...cfg.defaults, ...officeInputPatch(restored.value) };
      // #1310: locale:null means "clear the key" (user chose Auto). Mirrors
      // how the instance save handles model ("" → delete) and nullable overrides.
      if (body.locale === null || body.locale === "") delete (merged as Record<string, unknown>).locale;
      // General → Defaults' "not set" for the tool profile: the key goes (worker for an agent, general for a General).
      if (body.tool_set === null || body.tool_set === "") delete (merged as Record<string, unknown>).tool_set;
      const before = validateFleet(cfg);
      const after = validateFleet({ ...cfg, defaults: merged });
      if (rejectIfWorse(res, before, after)) return;
      settingsWrite(req, () => { cfg.defaults = merged as typeof cfg.defaults;
        if (typeof body.tips === "boolean" || body.tips === "dm") setNoticeMode(cfg, "tips", body.tips);
        ctx.saveFleetConfig(); });
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Fleet channels (full replace) ──
  if (method === "PUT" && path === "/api/settings/fleet/channels") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: unknown;
      try { body = JSON.parse(buf.toString("utf-8") || "[]"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (!Array.isArray(body)) return json(res, 400, { error: "expected an array of channels" });
      const normalizedBody: unknown[] = [];
      // Rebinding an existing provider connection is security-sensitive: a
      // broad channel replace must not bypass the positive provider probe and
      // ready-adapter fence exposed by /connections/:id/binding/*.
      const currentChannels = cfg.channels ?? (cfg.channel ? [cfg.channel] : []);
      const currentById = new Map(currentChannels.map((channel, index) => [channel.id ?? channel.type ?? `channel-${index}`, channel]));
      const currentTokenEnvs = new Set(currentChannels.map(channel => channel.bot_token_env).filter(Boolean));
      for (const [index, raw] of (body as unknown[]).entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          normalizedBody.push(raw);
          continue;
        }
        const sent = raw as Record<string, unknown>;
        const sentId = typeof sent.id === "string" ? sent.id : typeof sent.type === "string" ? sent.type : `channel-${index}`;
        // A placeholder is put back only from the one connection that owns the id: with two owners, refused.
        const owners = currentChannels.filter((channel, i) => (channel.id ?? channel.type ?? `channel-${i}`) === sentId).length;
        const restored = restoreRedactedSecrets(sent, owners === 1 ? currentById.get(sentId) : undefined);
        if ("path" in restored) return json(res, 400, { ok: false, error: `redacted value has no stored credential: channels[${index}].${restored.path}` }, true);
        const candidate = { ...restored.value };
        const group = normalizeChannelIdValue(candidate.group_id, `channels[${index}].group_id`);
        if (!group.ok) return json(res, 400, { ok: false, error: group.error }, true);
        if (group.value !== undefined) candidate.group_id = group.value;
        if (candidate.options && typeof candidate.options === "object" && !Array.isArray(candidate.options)) {
          const options = { ...(candidate.options as Record<string, unknown>) };
          const general = normalizeChannelIdValue(options.general_channel_id, `channels[${index}].options.general_channel_id`);
          if (!general.ok) return json(res, 400, { ok: false, error: general.error }, true);
          if (general.value !== undefined) options.general_channel_id = general.value;
          candidate.options = options;
        }
        normalizedBody.push(candidate);
        const id = typeof candidate.id === "string" ? candidate.id
          : typeof candidate.type === "string" ? candidate.type : `channel-${index}`;
        const previous = currentById.get(id);
        const unowned = unownedChannelField(candidate, previous as Record<string, unknown> | undefined);
        if (unowned) return json(res, 400, { ok: false, error: `unsupported connection field: channels[${index}].${unowned}` }, true);
        const tokenEnv = typeof candidate.bot_token_env === "string" ? candidate.bot_token_env : null;
        if (tokenEnv && (providerRegistryEnvKeys().has(tokenEnv) || isReservedProviderEnvKey(tokenEnv))) {
          return json(res, 409, { ok: false, error: "bot token env conflicts with a protected provider secret key" }, true);
        }
        const reusedByAnotherChannel = tokenEnv !== null && currentChannels.some((channel, channelIndex) => {
          const ownerId = channel.id ?? channel.type ?? `channel-${channelIndex}`;
          return ownerId !== id && channel.bot_token_env === tokenEnv;
        });
        if ((!previous && tokenEnv !== null && currentTokenEnvs.has(tokenEnv))
          || (previous && tokenEnv !== previous.bot_token_env && reusedByAnotherChannel)) {
          return json(res, 409, { ok: false, error: "new connections reusing an existing bot token require verified rebind" }, true);
        }
        if (!previous) continue;
        const oldGeneral = previous.options?.general_channel_id == null ? null : String(previous.options.general_channel_id);
        const nextOptions = candidate.options && typeof candidate.options === "object" && !Array.isArray(candidate.options)
          ? candidate.options as Record<string, unknown> : {};
        const nextGeneral = nextOptions.general_channel_id == null ? null : String(nextOptions.general_channel_id);
        const oldGroup = previous.group_id == null ? null : String(previous.group_id);
        const nextGroup = candidate.group_id == null ? null : String(candidate.group_id);
        if (oldGroup !== nextGroup || oldGeneral !== nextGeneral) {
          return json(res, 409, { ok: false, error: "connection binding changes require verified rebind" }, true);
        }
      }
      const next = { ...cfg, channels: normalizedBody as FleetConfig["channels"] };
      delete (next as { channel?: unknown }).channel; // channels[] supersedes the legacy single channel
      const before = validateFleet(cfg);
      const after = validateFleet(next);
      if (rejectIfWorse(res, before, after)) return;
      const previous = { channels: cfg.channels, channel: cfg.channel, hadChannel: "channel" in cfg };
      try {
        settingsWrite(req, () => {
          // #2211: kept as a load gives it (id and mode defaults filled in), so memory and the next diff agree with the file.
          cfg.channels = normalizedBody.map(item => item && typeof item === "object" && !Array.isArray(item)
            ? channelWithDefaults(item as Record<string, unknown> & { id?: string; type?: string; mode?: string }) : item) as FleetConfig["channels"];
          delete (cfg as { channel?: unknown }).channel; ctx.saveFleetConfig();
        });
      } catch (err) {
        // #1056: the save refused (fleet.yaml unchanged): memory goes back to what the file still says.
        cfg.channels = previous.channels;
        if (previous.hadChannel) cfg.channel = previous.channel;
        ctx.logger.warn({ err }, "settings: channels save refused");
        return json(res, 500, { ok: false, error: (err as Error).message });
      }
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Classic defaults ──
  if (method === "PUT" && path === "/api/settings/classic/defaults") {
    readBody(req, 512 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      let classic: Record<string, unknown>;
      try { classic = readClassic(ctx); }
      catch (err) { return json(res, 409, { error: (err as Error).message }); }
      const merged = { ...(classic.defaults as Record<string, unknown> ?? {}), ...body };
      if (body.tool_progress === null) delete merged.tool_progress;
      if (body.reply_completion_guard === null) delete merged.reply_completion_guard;
      if (body.reply_triggers === null) delete merged.reply_triggers;
      const before = validateClassicBotConfig(classic);
      const after = validateClassicBotConfig({ ...classic, defaults: merged });
      if (rejectIfWorse(res, before, after)) return;
      classic.defaults = merged;
      try { settingsWrite(req, () => writeClassicAtomic(ctx, classic)); }
      catch (err) {
        ctx.logger.warn({ err }, "settings: failed to atomically update classicBot.yaml");
        return json(res, 500, { error: "failed to write classicBot.yaml" });
      }
      ctx.logger.info("settings: updated classicBot defaults");
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Classic channel settings ──
  const classicChannelMatch = path.match(/^\/api\/settings\/classic\/channels\/([^/]+)$/);
  if (method === "PATCH" && classicChannelMatch) {
    let key: string;
    try { key = decodeURIComponent(classicChannelMatch[1]); }
    catch { json(res, 400, { error: "invalid channel key" }); return true; }
    if (!key || /[\\/\x00]/.test(key)) { json(res, 400, { error: "invalid channel key" }); return true; }
    readBody(req, 512 * 1024).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const allowed = new Set([
        "backend",
        "model",
        "auto_pause_after",
        "collab",
        "reply_triggers",
        "context_lines",
        "tool_progress",
        "reply_completion_guard",
        "web_echo",
      ]);
      const unknown = Object.keys(body).filter(field => !allowed.has(field));
      if (unknown.length) return json(res, 400, { error: `unsupported fields: ${unknown.join(", ")}` });
      if (body.backend !== undefined && (typeof body.backend !== "string" || !KNOWN_BACKENDS.includes(body.backend))) {
        return json(res, 400, { error: "backend must be a known backend" });
      }
      if (body.model !== undefined && body.model !== null && typeof body.model !== "string") return json(res, 400, { error: "model must be a string" });
      if (body.auto_pause_after !== undefined && body.auto_pause_after !== null
        && (typeof body.auto_pause_after !== "number" || !Number.isFinite(body.auto_pause_after) || body.auto_pause_after < 0)) {
        return json(res, 400, { error: "auto_pause_after must be a non-negative finite number" });
      }
      if (body.reply_triggers !== undefined && body.reply_triggers !== null && typeof body.reply_triggers !== "boolean") {
        return json(res, 400, { error: "reply_triggers must be a boolean" });
      }
      if (body.collab !== undefined && typeof body.collab !== "boolean") return json(res, 400, { error: "collab must be a boolean" });
      if (body.context_lines !== undefined && (!Number.isInteger(body.context_lines) || (body.context_lines as number) < 0)) {
        return json(res, 400, { error: "context_lines must be a non-negative integer" });
      }
      if (body.tool_progress !== undefined && body.tool_progress !== null
        && !["off", "standard", "verbose"].includes(String(body.tool_progress))) {
        return json(res, 400, { error: "tool_progress must be off, standard, or verbose" });
      }
      if (body.reply_completion_guard !== undefined && body.reply_completion_guard !== null
        && typeof body.reply_completion_guard !== "boolean") {
        return json(res, 400, { error: "reply_completion_guard must be a boolean" });
      }
      if (body.web_echo !== undefined && typeof body.web_echo !== "boolean") {
        return json(res, 400, { error: "web_echo must be a boolean" });
      }

      let classic: Record<string, unknown>;
      try { classic = readClassic(ctx); }
      catch (err) { return json(res, 409, { error: (err as Error).message }); }
      const channels = classic.channels;
      if (!channels || typeof channels !== "object" || Array.isArray(channels)) return json(res, 404, { error: "classic channel not found" });
      const current = Object.hasOwn(channels, key) ? (channels as Record<string, unknown>)[key] : undefined;
      if (!current || typeof current !== "object" || Array.isArray(current)) return json(res, 404, { error: "classic channel not found" });
      const previous = structuredClone(classic);
      const merged = { ...(current as Record<string, unknown>), ...body };
      if (body.model === null || body.model === "") delete merged.model;
      if (body.auto_pause_after === null) delete merged.auto_pause_after;
      if (body.tool_progress === null) delete merged.tool_progress;
      if (body.reply_completion_guard === null) delete merged.reply_completion_guard;
      if (body.reply_triggers === null) delete merged.reply_triggers;
      (channels as Record<string, unknown>)[key] = merged;
      const before = validateClassicBotConfig(previous);
      const after = validateClassicBotConfig(classic);
      if (rejectIfWorse(res, before, after)) return;
      try { settingsWrite(req, () => writeClassicAtomic(ctx, classic), false); }
      catch (err) {
        ctx.logger.warn({ err, key }, "settings: failed to atomically update classic channel");
        return json(res, 500, { error: "failed to write classicBot.yaml" });
      }
      const undo = settingsUndo(classicPath(ctx), previous, classic, Object.keys(body).map(field => ["channels", key, field]));
      const execution = settingsRequestExecution(req);
      const instanceName = typeof merged.instanceName === "string" ? merged.instanceName : undefined;
      const restore = instanceName ? ctx.captureClassicSettingsRestoration?.(instanceName, Object.keys(body), execution) : undefined;
      try {
        if (instanceName && ctx.restartClassicInstanceFromSettings) {
          if (execution) await ctx.restartClassicInstanceFromSettings(instanceName, Object.keys(body), execution);
          else await ctx.restartClassicInstanceFromSettings(instanceName, Object.keys(body));
          execution?.assert();
        }
      } catch (err) {
        // Keep disk and runtime consistent if the requested restart fails.
        try {
          const retained = undoSettingsPaths(classicPath(ctx), readClassic(ctx), undo);
          writeClassicAtomic(ctx, retained.value);
          if (retained.conflicts) throw new Error("concurrent Classic edit retained");
        } catch (rollbackErr) {
          ctx.logger.error({ err: rollbackErr, key }, "settings: failed to roll back classic channel update");
        }
        if (instanceName && ctx.restartClassicInstanceFromSettings) {
          try { if (restore) await restore(); else await ctx.restartClassicInstanceFromSettings(instanceName, Object.keys(body)); }
          catch (recoveryErr) { ctx.logger.error({ err: recoveryErr, key, instanceName }, "settings: failed to restore classic instance after rollback"); }
        }
        ctx.logger.warn({ err, key, instanceName }, "settings: classic channel restart failed; config rolled back");
        return json(res, 409, { error: `classic instance restart failed: ${(err as Error).message}` });
      }
      execution?.complete();
      ctx.logger.info({ key, instanceName }, "settings: updated classic channel");
      const hotOnly = Object.keys(body).length > 0
        && Object.keys(body).every(field => CLASSIC_HOT_CONFIG_KEYS.has(field));
      json(res, 200, {
        ok: true,
        warnings: saveWarnings(before, after),
        restarted: !!instanceName && !hotOnly,
        hot_updated: !!instanceName && hotOnly,
      });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Apply (observable) ──
  //
  // Replaces the fire-and-forget SIGHUP below for anything that wants to watch:
  // the answer is a job, and the job is the authority. `apply_progress` SSE
  // frames are an accelerator carrying no event id, so a client that reconnects
  // cannot replay what it missed — it re-reads the job.
  if (method === "POST" && path === "/api/settings/apply") {
    if (!ctx.startSettingsApply) { json(res, 501, { error: "apply jobs unavailable" }); return true; }
    readBody(req, 64 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; } catch { /* key may come from the header */ }
      // The client generates the key before its first attempt. A server-minted
      // id cannot deduplicate a retry whose first response was lost.
      const header = req.headers["idempotency-key"];
      const key = (typeof header === "string" ? header : undefined)
        ?? (typeof body.idempotency_key === "string" ? body.idempotency_key : undefined);
      if (!key || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) {
        json(res, 400, { error: "Idempotency-Key required (8-128 chars of [A-Za-z0-9_.:-])" });
        return;
      }
      const result = ctx.startSettingsApply!(key);
      if ("busy" in result) {
        // One reconcile at a time: two of them stop and start the same agent in
        // parallel. The running job's id lets the client watch that one instead.
        ctx.logger.info({ runningJobId: result.busy?.id ?? null }, "settings: apply refused — a reconcile is already running");
        json(res, 409, {
          error: "a configuration reload is already running",
          running_job_id: result.busy?.id ?? null,
        });
        return;
      }
      ctx.logger.info({ jobId: result.job.id, reused: result.reused }, result.reused
        ? "settings: apply retry rejoined the existing job"
        : "settings: apply job started");
      json(res, result.reused ? 200 : 202, viewOf(result.job));
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Setup wizard ──
  // Served by the same handlers the pre-fleet setup host serves, so the wizard
  // asks the same questions whether or not a fleet is running yet.
  if (handleQuickstartRequest(req, res, url, ctx)) return true;

  // ── Restart AgEnD itself ──
  //
  // Deliberately not part of Apply. The panel is reachable from outside the
  // LAN, so restarting the whole fleet is its own action with its own
  // confirmation, its own idempotency key, and its own rate limit.
  if (method === "POST" && path === "/api/settings/restart-fleet") {
    if (!ctx.requestSettingsSelfRestart) { json(res, 501, { error: "self restart unavailable" }); return true; }
    readBody(req, 64 * 1024).then(async buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; } catch { /* reported below */ }
      const header = req.headers["idempotency-key"];
      const key = (typeof header === "string" ? header : undefined)
        ?? (typeof body.idempotency_key === "string" ? body.idempotency_key : undefined);
      if (!key || !/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) {
        json(res, 400, { error: "Idempotency-Key required (8-128 chars of [A-Za-z0-9_.:-])" });
        return;
      }
      // A literal, not a boolean: a stray `true` in a replayed body should not
      // be able to mean "yes, restart the fleet".
      if (body.confirm !== "restart-agend") {
        json(res, 400, { error: 'confirm must be the literal "restart-agend"' });
        return;
      }
      const jobId = typeof body.job_id === "string" ? body.job_id : "";
      if (!jobId) { json(res, 400, { error: "job_id required" }); return; }

      const result = await ctx.requestSettingsSelfRestart!(jobId, key);
      if (result.ok) {
        ctx.logger.info({ jobId: result.jobId, reused: !!result.reused }, "settings: self restart accepted");
        json(res, result.reused ? 200 : 202, { job_id: result.jobId, restarting: true });
        return;
      }
      ctx.logger.warn({ jobId, status: result.status, reason: result.error }, "settings: self restart refused");
      if (result.retryAfterSeconds) res.setHeader("Retry-After", String(result.retryAfterSeconds));
      json(res, result.status, {
        error: result.error,
        ...(result.retryAfterSeconds ? { retry_after_seconds: result.retryAfterSeconds } : {}),
      });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  const jobMatch = path.match(/^\/api\/settings\/apply\/([A-Za-z0-9-]+)$/);
  if (method === "GET" && jobMatch) {
    const job = ctx.applyJobs?.get(jobMatch[1]!) ?? null;
    if (!job) { json(res, 404, { error: "job not found" }); return true; }
    json(res, 200, viewOf(job));
    return true;
  }

  // ── Reload (SIGHUP) ──
  // The unobserved path, kept for scripts. Nothing reports what it did.
  if (method === "POST" && path === "/api/settings/reload") {
    ctx.logger.info("settings: reload requested — sending SIGHUP");
    try { process.kill(process.pid, "SIGHUP"); } catch (err) { ctx.logger.warn({ err }, "settings: SIGHUP failed"); }
    json(res, 200, { ok: true });
    return true;
  }

  // ── Instances (create / patch / delete) ──
  const validName = (n: string) => !!n && /^[^\\/\x00]+$/.test(n);
  const rawInstancePatches = (name: string, patch: Record<string, unknown>): RawConfigPatch[] => {
    const changes: RawConfigPatch[] = [];
    for (const [key, value] of Object.entries(patch)) {
      // A nested switch set to null follows the default again: its key goes from fleet.yaml, never a literal null (#2391
      // review: a saved `dashboard.task_board: null` hid the default's false after a reload).
      if ((key === "hang_detector" || key === "dashboard") && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          changes.push({ path: ["instances", name, key, nestedKey], value: nestedValue, remove: nestedValue === null });
        }
      } else {
        changes.push({ path: ["instances", name, key], value, remove: removesInstanceOverride(key, value) });
      }
    }
    return changes;
  };
  // Create-or-merge an instance, blocking only on newly-introduced errors.
  const commitInstance = (name: string, exists: boolean, body: unknown): void => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) { json(res, 400, { error: "expected an object" }); return; }
    const base = (exists ? cfg!.instances[name] : {}) as Record<string, unknown>;
    const restored = restoreRedactedSecrets(body as Record<string, unknown>, base);
    if ("path" in restored) { json(res, 400, { error: `redacted value has no stored credential: instances.${name}.${restored.path}` }); return; }
    const patch = officeInputPatch(restored.value);
    let mergedInst: Record<string, any>;
    try { mergedInst = normalizeSettingsInstancePatch(base, patch); }
    catch { json(res, 400, { error: "unsupported_instance_null" }); return; }
    const before = validateFleet(cfg!);
    const after = validateFleet({ ...cfg!, instances: { ...cfg!.instances, [name]: mergedInst } });
    if (rejectIfWorse(res, before, after)) return;
    settingsWrite(req, () => {
      Object.defineProperty(cfg!.instances, name, { value: mergedInst, writable: true, enumerable: true, configurable: true });
      if (!exists) clearPausedMarker(join(ctx.dataDir, "instances", name));
      ctx.saveFleetConfig(rawInstancePatches(name, patch));
    });
    json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
  };

  // POST /api/settings/fleet/instances  — create, name taken from the body.
  if (method === "POST" && path === "/api/settings/fleet/instances") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!validName(name)) return json(res, 400, { error: "missing or invalid instance name (provide `name` in the body)" });
      if (Object.hasOwn(cfg.instances, name)) return json(res, 409, { error: "instance already exists" });
      const { name: _n, ...instBody } = body;
      commitInstance(name, false, instBody);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // /api/settings/fleet/instances/:name  — create / patch / delete.
  const instPrefix = "/api/settings/fleet/instances/";
  if (path.startsWith(instPrefix)) {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    const name = decodeURIComponent(path.slice(instPrefix.length));
    if (!validName(name)) { json(res, 400, { error: "invalid instance name" }); return true; }

    if (method === "DELETE") {
      if (!Object.hasOwn(cfg.instances, name)) { json(res, 404, { error: "instance not found" }); return true; }
      if (ctx.removeInstance) {
        // Settings → Agents → Delete, confirmed: the same removal as delete_instance — the agent stops, nothing of it is
        // left behind (schedules, team places), and its fleet.yaml entry goes.
        const execution = settingsRequestExecution(req), authorization = authorizeExplicitInstanceRemoval("dashboard-confirmed");
        (execution ? ctx.removeInstance(name, authorization, execution) : ctx.removeInstance(name, authorization)).then(
          () => json(res, 200, { ok: true, deleted: name, warnings: validateFleet(cfg).warnings }),
          (err: unknown) => json(res, 500, { error: (err as Error).message }));
        return true;
      }
      // DELETE never blocks on validation; surface any resulting warnings.
      settingsWrite(req, () => {
        delete cfg.instances[name]; clearPausedMarker(join(ctx.dataDir, "instances", name)); ctx.saveFleetConfig();
      });
      json(res, 200, { ok: true, warnings: validateFleet(cfg).warnings });
      return true;
    }

    if (method === "POST" || method === "PATCH") {
      const exists = Object.hasOwn(cfg.instances, name);
      if (method === "POST" && exists) { json(res, 409, { error: "instance already exists" }); return true; }
      if (method === "PATCH" && !exists) { json(res, 404, { error: "instance not found" }); return true; }
      readBody(req, 512 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
        let body: Record<string, unknown>;
        try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
        commitInstance(name, exists, body);
      }).catch(() => json(res, 400, { error: "bad request" }));
      return true;
    }

    json(res, 405, { error: "method not allowed" });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
