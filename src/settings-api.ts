import { normalizeSettingsInstancePatch, removesInstanceOverride } from "./settings-instance-patch.js";
import { settingsRequestExecution, settingsWrite } from "./settings-request-capability.js";
import { noteSettingsWrite, settingsUndo, undoSettingsPaths, type SettingsExecution } from "./settings-transaction.js";
import { readBoundedWebBody } from "./web-body.js";
import { validPublicLinkPatch } from "./public-web-link.js";
import { permitWebContinuation } from "./web-continuation.js";
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
import { sendPanelHtml } from "./web-host-guard.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
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
  builtinStatusEmojis, customEmojiValue, emojiImageUrl, previewStatusEmojis,
  type GuildEmoji, type GuildEmojiGroup,
} from "./status-emojis.js";



const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SettingsApiContext {
  readonly webToken?: string | null;
  readonly webSessions?: import("./web-session.js").WebSessionStore | null;
  fleetConfig: FleetConfig | null;
  configPath: string | null;
  dataDir: string;
  logger: Logger;
  getRawFleetConfig(): RawFleetConfig;
  saveFleetConfig(explicitPatches?: RawConfigPatch[]): void;
  lifecycle: {
    isPaused(name: string): boolean;
    pause(name: string): Promise<void>;
    wake(name: string, timeoutMs?: number): Promise<void>;
  };
  isClassicInstance?(name: string): boolean;
  /** Phase 2b: an operator wake that respects the warm hard cap (FleetManager.explicitWake). */
  explicitWake?(name: string, timeoutMs?: number): Promise<void>;
  restartClassicInstanceFromSettings?(instanceName: string, changedFields?: string[], execution?: SettingsExecution): Promise<void>;
  captureClassicSettingsRestoration?(instanceName: string, changedFields: string[]): () => Promise<void>;
  /** Present on a real fleet; absent in unit contexts that only exercise CRUD. */
  applyJobs?: ApplyJobStore;
  startSettingsApply?(key: string): { job: ApplyJob; reused: boolean } | { busy: ApplyJob | null };
  requestSettingsSelfRestart?(jobId: string, key: string): Promise<SelfRestartResult>;
  /** Non-null when the running config and fleet.yaml disagree on a
   * startup-only key, in which case a restart cannot clear the fleet row. */
  fleetSignatureMismatchKeys?(): string[] | null;
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
  return path === "/settings" || path.startsWith("/api/settings/");
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
  const method = req.method ?? "GET";

  // ── Static page ──
  if (method === "GET" && path === "/settings") {
    try {
      const html = readFileSync(join(__dirname, "ui", "settings.html"), "utf-8");
      sendPanelHtml(res, html);
    } catch {
      json(res, 500, { error: "settings.html not found" });
    }
    return true;
  }

  // ── Reads ──
  // What each field costs to change, derived from HOT_INSTANCE_CONFIG_KEYS.
  // The page used to carry its own copy of the hot set plus one hand-written
  // badge per field, which could disagree with what the fleet actually does.
  if (method === "GET" && path === "/api/settings/schema") {
    json(res, 200, {
      ...buildSettingsImpactSchema(),
      // Non-null means a restart cannot clear the fleet row, so the page shows
      // the mismatch instead of offering a button that can never succeed.
      fleet_signature_mismatch: ctx.fleetSignatureMismatchKeys?.() ?? null,
    });
    return true;
  }
  if (method === "GET" && path === "/api/settings/fleet") {
    json(res, 200, ctx.fleetConfig ?? {});
    return true;
  }
  if (method === "GET" && path === "/api/settings/fleet/raw") {
    json(res, 200, ctx.getRawFleetConfig());
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
        return { ...e, value, image_url: emojiImageUrl(value) };
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

  // Generic provider API-key registry.  Unlike the legacy connection token
  // routes, this endpoint accepts a code-owned spec id only; env key, origin,
  // auth header and verifier are resolved server-side.  The body is consumed
  // once and no secret-bearing value is ever placed in a URL, job, SSE frame,
  // or response.
  const providerSecretsEnabled = ctx.providerSecretsEnabled?.() === true;
  if (method === "GET" && (path === "/api/settings/provider-secrets" || path === "/api/settings/secrets")) {
    if (!providerSecretsEnabled) { json(res, 404, { error: "not found" }, true); return true; }
    if (!ctx.listProviderSecrets) { json(res, 501, { error: "provider secret registry unavailable" }, true); return true; }
    json(res, 200, ctx.listProviderSecrets().map(item => ({
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

  const providerSecretVerifyMatch = path.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/([^/]+)\/verify$/);
  if (method === "POST" && providerSecretVerifyMatch) {
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
      if (!secret) return json(res, 400, { error: "secret required" }, true);
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key required" }, true);
      const result = await ctx.verifyProviderSecret!({ specId, secret, sessionBinding: requestSessionBinding(req), idempotencyKey: key });
      if (!result.ok) {
        const code = result.status === "unsupported_verifier" ? 422 : result.status === "provider_unavailable" ? 503 : 422;
        return json(res, code, { ok: false, result: result.status, error: result.status === "unsupported_verifier" ? "unsupported verifier" : "provider secret verification failed" }, true);
      }
      json(res, 200, { ok: true, result: "verified", verification_id: result.verification_id, expires_at: result.expires_at, spec_id: result.spec_id, activation: result.activation }, true);
    }).catch(() => json(res, 400, { error: "bad request" }, true));
    return true;
  }

  const providerSecretApplyMatch = path.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/([^/]+)\/apply$/);
  if (method === "POST" && providerSecretApplyMatch) {
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

  const providerSecretStatusMatch = path.match(/^\/api\/settings\/(?:provider-secrets|secrets)\/[^/]+\/apply\/([A-Za-z0-9_-]+)$/);
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
    const operation = action === "pause"
      ? ctx.lifecycle.pause(name)
      : ctx.explicitWake ? ctx.explicitWake(name, 30_000) : ctx.lifecycle.wake(name, 30_000);
    operation.then(() => json(res, 200, { ok: true, name, status: action === "pause" ? "paused" : "running" }))
      .catch(err => json(res, 409, { error: (err as Error).message }));
    return true;
  }

  // One hot web toggle; an unrelated Settings edit never materializes defaults.
  if (method === "PUT" && path === "/api/settings/fleet/web") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 4096).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
      let body: unknown;
      try { body = JSON.parse(buf.toString("utf-8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => key !== "echo_to_channel" && key !== "public_link")) return json(res, 400, { error: "unknown web field" });
      const patch = body as { echo_to_channel?: unknown; public_link?: unknown };
      if (patch.echo_to_channel !== undefined && typeof patch.echo_to_channel !== "boolean") return json(res, 400, { error: "echo_to_channel must be a boolean" });
      if (patch.public_link !== undefined && !validPublicLinkPatch(patch.public_link)) return json(res, 400, { error: "invalid public_link settings" });
      const changes: RawConfigPatch[] = [];
      const web = { ...cfg.web };
      if (typeof patch.echo_to_channel === "boolean") { web.echo_to_channel = patch.echo_to_channel; changes.push({ path: ["web", "echo_to_channel"], value: patch.echo_to_channel }); }
      if (validPublicLinkPatch(patch.public_link)) {
        if (Object.keys(patch.public_link).length) web.public_link = { ...web.public_link, ...patch.public_link };
        for (const [key, value] of Object.entries(patch.public_link)) changes.push({ path: ["web", "public_link", key], value });
      }
      if (!changes.length) return json(res, 200, { ok: true });
      const before = validateFleetConfig(cfg);
      const after = validateFleetConfig({ ...cfg, web });
      if (rejectIfWorse(res, before, after)) return;
      settingsWrite(req, () => { cfg.web = web; ctx.saveFleetConfig(changes); });
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
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
      const merged = { ...cfg.defaults, ...body };
      // #1310: locale:null means "clear the key" (user chose Auto). Mirrors
      // how the instance save handles model ("" → delete) and nullable overrides.
      if (body.locale === null || body.locale === "") delete (merged as Record<string, unknown>).locale;
      const before = validateFleetConfig(cfg);
      const after = validateFleetConfig({ ...cfg, defaults: merged });
      if (rejectIfWorse(res, before, after)) return;
      settingsWrite(req, () => { cfg.defaults = merged as typeof cfg.defaults; ctx.saveFleetConfig(); });
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
        const candidate = { ...(raw as Record<string, unknown>) };
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
      const before = validateFleetConfig(cfg);
      const after = validateFleetConfig(next);
      if (rejectIfWorse(res, before, after)) return;
      settingsWrite(req, () => {
        cfg.channels = normalizedBody as FleetConfig["channels"];
        delete (cfg as { channel?: unknown }).channel; ctx.saveFleetConfig();
      });
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
      const restore = instanceName ? ctx.captureClassicSettingsRestoration?.(instanceName, Object.keys(body)) : undefined;
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
      if (key === "hang_detector" && value && typeof value === "object" && !Array.isArray(value)) {
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
    const patch = body as Record<string, unknown>;
    let mergedInst: Record<string, any>;
    try { mergedInst = normalizeSettingsInstancePatch(base, patch); }
    catch { json(res, 400, { error: "unsupported_instance_null" }); return; }
    const before = validateFleetConfig(cfg!);
    const after = validateFleetConfig({ ...cfg!, instances: { ...cfg!.instances, [name]: mergedInst } });
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
      // DELETE never blocks on validation; surface any resulting warnings.
      settingsWrite(req, () => {
        delete cfg.instances[name]; clearPausedMarker(join(ctx.dataDir, "instances", name)); ctx.saveFleetConfig();
      });
      json(res, 200, { ok: true, warnings: validateFleetConfig(cfg).warnings });
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
