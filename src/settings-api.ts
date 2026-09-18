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
 *
 * Auth: all routes require the web.token — enforced by the global web-token gate
 * in fleet-manager BEFORE this handler runs (settings paths are not exempt), so
 * no per-route auth is repeated here.
 *
 * Writes are validated first (config-validator): any error → 400 and nothing is
 * written; warnings are non-blocking and returned alongside the result.
 */
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
import {
  detectWizardBackends,
  nextChannelId,
  planQuickstart,
  runProviderProbe,
  writeQuickstartSecret,
  type WizardEnvironment,
  type WizardPlanInput,
} from "./quickstart-api.js";

/** The channels as the wizard sees them, from either config shape. */
function wizardChannels(cfg: FleetConfig | null): WizardEnvironment["channels"] {
  const channels = (cfg?.channels ?? (cfg?.channel ? [cfg.channel] : [])) as unknown as Array<Record<string, unknown>>;
  return channels.map((channel, index) => ({
    id: String(channel.id ?? channel.type ?? `channel-${index}`),
    type: String(channel.type ?? ""),
    token_env: channel.bot_token_env ? String(channel.bot_token_env) : null,
    group_id: channel.group_id != null ? String(channel.group_id) : null,
    allowed_users: ((channel.access as { allowed_users?: unknown[] } | undefined)?.allowed_users ?? []).map(String),
  }));
}

/** Reject anything that would land in fleet.yaml or a shell env file unchecked. */
function validateWizardInput(input: Partial<WizardPlanInput>): string | null {
  if (input.platform !== "telegram" && input.platform !== "discord") return "platform must be telegram or discord";
  if (!input.token_env || !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.token_env)) return "token_env must be an UPPER_SNAKE env var name";
  if (!input.backend || !KNOWN_BACKENDS.includes(input.backend)) return "backend must be a known backend";
  if (!input.working_directory || !input.working_directory.startsWith("/")) return "working_directory must be an absolute path";
  if (!input.instance_name || !/^[A-Za-z0-9._-]{1,128}$/.test(input.instance_name)) return "instance_name must be [A-Za-z0-9._-]";
  for (const [field, value] of Object.entries({
    group_id: input.group_id, guild_id: input.guild_id,
    general_channel_id: input.general_channel_id, admin_user_id: input.admin_user_id,
  })) {
    if (value !== undefined && value !== "" && !/^-?\d{1,20}$/.test(String(value))) return `${field} must be numeric`;
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SettingsApiContext {
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
  restartClassicInstanceFromSettings?(instanceName: string, changedFields?: string[]): Promise<void>;
  /** Present on a real fleet; absent in unit contexts that only exercise CRUD. */
  applyJobs?: ApplyJobStore;
  startSettingsApply?(key: string): { job: ApplyJob; reused: boolean } | { busy: ApplyJob | null };
  requestSettingsSelfRestart?(jobId: string, key: string): Promise<SelfRestartResult>;
  /** Non-null when the running config and fleet.yaml disagree on a
   * startup-only key, in which case a restart cannot clear the fleet row. */
  fleetSignatureMismatchKeys?(): string[] | null;
  /** True when a running adapter is already long-polling this bot token. */
  isBotTokenInUse?(token: string): boolean;
}

/** An explicit user-authored YAML mutation that must be persisted even when
 * its value equals the defaults-expanded runtime snapshot. */
export interface RawConfigPatch {
  path: Array<string | number>;
  value?: unknown;
  remove?: boolean;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
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

  // Everything below mutates — needs an in-memory fleet config.
  const cfg = ctx.fleetConfig;

  // ── Manual pause / wake ──
  const actionMatch = path.match(/^\/api\/settings\/instances\/([^/]+)\/(pause|wake)$/);
  if (method === "POST" && actionMatch) {
    const name = decodeURIComponent(actionMatch[1]);
    if (!name || !/^[^\\/\x00]+$/.test(name)) { json(res, 400, { error: "invalid instance name" }); return true; }
    if (!cfg?.instances[name] && !ctx.isClassicInstance?.(name)) { json(res, 404, { error: "instance not found" }); return true; }
    const action = actionMatch[2];
    const operation = action === "pause" ? ctx.lifecycle.pause(name) : ctx.lifecycle.wake(name, 30_000);
    operation.then(() => json(res, 200, { ok: true, name, status: action === "pause" ? "paused" : "running" }))
      .catch(err => json(res, 409, { error: (err as Error).message }));
    return true;
  }

  // ── Fleet defaults ──
  if (method === "PUT" && path === "/api/settings/fleet/defaults") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const merged = { ...cfg.defaults, ...body };
      const before = validateFleetConfig(cfg);
      const after = validateFleetConfig({ ...cfg, defaults: merged });
      if (rejectIfWorse(res, before, after)) return;
      cfg.defaults = merged as typeof cfg.defaults;
      ctx.saveFleetConfig();
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Fleet channels (full replace) ──
  if (method === "PUT" && path === "/api/settings/fleet/channels") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      let body: unknown;
      try { body = JSON.parse(buf.toString("utf-8") || "[]"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (!Array.isArray(body)) return json(res, 400, { error: "expected an array of channels" });
      const next = { ...cfg, channels: body as FleetConfig["channels"] };
      delete (next as { channel?: unknown }).channel; // channels[] supersedes the legacy single channel
      const before = validateFleetConfig(cfg);
      const after = validateFleetConfig(next);
      if (rejectIfWorse(res, before, after)) return;
      cfg.channels = body as FleetConfig["channels"];
      delete (cfg as { channel?: unknown }).channel;
      ctx.saveFleetConfig();
      json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Classic defaults ──
  if (method === "PUT" && path === "/api/settings/classic/defaults") {
    readBody(req, 512 * 1024).then(buf => {
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
      try { writeClassicAtomic(ctx, classic); }
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

      let classic: Record<string, unknown>;
      try { classic = readClassic(ctx); }
      catch (err) { return json(res, 409, { error: (err as Error).message }); }
      const channels = classic.channels;
      if (!channels || typeof channels !== "object" || Array.isArray(channels)) return json(res, 404, { error: "classic channel not found" });
      const current = (channels as Record<string, unknown>)[key];
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
      try { writeClassicAtomic(ctx, classic); }
      catch (err) {
        ctx.logger.warn({ err, key }, "settings: failed to atomically update classic channel");
        return json(res, 500, { error: "failed to write classicBot.yaml" });
      }
      const instanceName = typeof merged.instanceName === "string" ? merged.instanceName : undefined;
      try {
        if (instanceName && ctx.restartClassicInstanceFromSettings) {
          await ctx.restartClassicInstanceFromSettings(instanceName, Object.keys(body));
        }
      } catch (err) {
        // Keep disk and runtime consistent if the requested restart fails.
        try { writeClassicAtomic(ctx, previous); } catch (rollbackErr) {
          ctx.logger.error({ err: rollbackErr, key }, "settings: failed to roll back classic channel update");
        }
        if (instanceName && ctx.restartClassicInstanceFromSettings) {
          try { await ctx.restartClassicInstanceFromSettings(instanceName, Object.keys(body)); }
          catch (recoveryErr) { ctx.logger.error({ err: recoveryErr, key, instanceName }, "settings: failed to restore classic instance after rollback"); }
        }
        ctx.logger.warn({ err, key, instanceName }, "settings: classic channel restart failed; config rolled back");
        return json(res, 409, { error: `classic instance restart failed: ${(err as Error).message}` });
      }
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
  //
  // The same four steps as `agend quickstart`, asking the providers the same
  // questions through the same probes. Nothing here applies: the last step
  // writes the files and the page then starts an ordinary apply job.
  if (method === "GET" && path === "/api/settings/quickstart/environment") {
    json(res, 200, {
      backends: detectWizardBackends(),
      has_fleet: !!cfg && Object.keys(cfg.instances ?? {}).length > 0,
      channels: wizardChannels(cfg),
    } satisfies WizardEnvironment);
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/probe") {
    readBody(req, 16 * 1024).then(async buf => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as Record<string, unknown>; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const token = typeof body.token === "string" ? body.token : "";
      if (!token) return json(res, 400, { error: "token required" });
      const action = String(body.action ?? "");
      if (action !== "verify" && action !== "guilds" && action !== "await-telegram-start") {
        return json(res, 400, { error: "unknown probe" });
      }
      const platform = body.platform === "discord" ? "discord" : "telegram";
      // The token is read, used for one outbound call, and dropped. It is never
      // logged and never echoed back in the response.
      ctx.logger.info({ action, platform }, "settings: quickstart probe");
      const result = await runProviderProbe(
        { action, platform, token, offset: typeof body.offset === "number" ? body.offset : 0 } as never,
        { isTokenInUse: candidate => ctx.isBotTokenInUse?.(candidate) ?? false },
      );
      json(res, result.ok ? 200 : 409, result);
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/plan") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 16 * 1024).then(buf => {
      let body: WizardPlanInput;
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as WizardPlanInput; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const invalid = validateWizardInput(body);
      if (invalid) return json(res, 400, { error: invalid });
      json(res, 200, planQuickstart(body, {
        backends: detectWizardBackends(),
        has_fleet: Object.keys(cfg.instances ?? {}).length > 0,
        channels: wizardChannels(cfg),
      }));
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  if (method === "POST" && path === "/api/settings/quickstart/commit") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 16 * 1024).then(buf => {
      let body: WizardPlanInput & { token?: string };
      try { body = JSON.parse(buf.toString("utf-8") || "{}") as WizardPlanInput & { token?: string }; }
      catch { return json(res, 400, { error: "invalid JSON" }); }
      const invalid = validateWizardInput(body);
      if (invalid) return json(res, 400, { error: invalid });
      if (!body.token) return json(res, 400, { error: "token required" });

      const summary = wizardChannels(cfg);
      const plan = planQuickstart(body, {
        backends: detectWizardBackends(),
        has_fleet: Object.keys(cfg.instances ?? {}).length > 0,
        channels: summary,
      });

      // Everything is assembled and validated on a copy. Nothing on disk and
      // nothing in memory moves until the whole result is known to be valid —
      // the previous order wrote the token first and left the running config
      // rewritten when validation then failed.
      const draft = structuredClone(cfg) as FleetConfig;
      const channels = (draft.channels ?? (draft.channel ? [draft.channel] : [])) as unknown as Array<Record<string, unknown>>;
      const existingIndex = channels.findIndex(channel => channel.bot_token_env === body.token_env);
      const entry = { id: nextChannelId(body.platform, body.token_env, summary), ...plan.channel };
      if (existingIndex >= 0) channels[existingIndex] = { ...channels[existingIndex], ...entry };
      else channels.push(entry);
      draft.channels = channels as unknown as typeof draft.channels;
      delete (draft as { channel?: unknown }).channel;
      draft.instances[body.instance_name] = {
        ...(draft.instances[body.instance_name] ?? {}),
        working_directory: body.working_directory,
        backend: body.backend,
      } as typeof draft.instances[string];

      const validation = validateFleetConfig(draft);
      if (!validation.valid) {
        return json(res, 400, { error: validation.errors.map(e => `${e.path}: ${e.message}`).join("; ") });
      }

      const secret = writeQuickstartSecret(ctx.dataDir, body.token_env, body.token);
      const before = {
        channels: cfg.channels,
        channel: (cfg as { channel?: unknown }).channel,
        instance: cfg.instances[body.instance_name],
        hadInstance: Object.prototype.hasOwnProperty.call(cfg.instances, body.instance_name),
      };
      cfg.channels = draft.channels;
      delete (cfg as { channel?: unknown }).channel;
      cfg.instances[body.instance_name] = draft.instances[body.instance_name]!;
      try { ctx.saveFleetConfig(); }
      catch (err) {
        // The file is the authority. If it did not take the change, the running
        // config must not keep it either.
        cfg.channels = before.channels;
        if (before.channel !== undefined) (cfg as { channel?: unknown }).channel = before.channel;
        if (before.hadInstance) cfg.instances[body.instance_name] = before.instance!;
        else delete cfg.instances[body.instance_name];
        return json(res, 500, { error: (err as Error).message });
      }
      ctx.logger.info({ instance: body.instance_name, platform: body.platform }, "settings: quickstart committed");
      // No apply here: the page starts the ordinary job so the wizard's last
      // step has the same progress, deadline and restart recovery as everything
      // else the panel applies.
      json(res, 200, { ok: true, plan, secret_mode_ok: secret.ok, warnings: plan.warnings });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Restart AgEnD itself ──
  //
  // Deliberately not part of Apply. The panel is reachable from outside the
  // LAN, so restarting the whole fleet is its own action with its own
  // confirmation, its own idempotency key, and its own rate limit.
  if (method === "POST" && path === "/api/settings/restart-fleet") {
    if (!ctx.requestSettingsSelfRestart) { json(res, 501, { error: "self restart unavailable" }); return true; }
    readBody(req, 64 * 1024).then(async buf => {
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
  const nullableInstanceOverrides = new Set(["model", "auto_pause_after", "hang_detector", "agent_mode", "tool_set", "tool_progress", "reply_completion_guard", "log_level", "lightweight", "model_failover", "display_name"]);
  const removesInstanceOverride = (key: string, value: unknown): boolean =>
    nullableInstanceOverrides.has(key)
    && (value === null || (key === "model" && typeof value === "string" && value.trim() === ""));
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
    const mergedInst = { ...base, ...patch };
    if (patch.hang_detector && typeof patch.hang_detector === "object" && !Array.isArray(patch.hang_detector)) {
      const hangPatch = patch.hang_detector as Record<string, unknown>;
      const mergedHang = { ...((base.hang_detector as Record<string, unknown>) ?? {}), ...hangPatch };
      // Nested null removes only the timeout override while preserving any
      // independently configured `enabled` override.
      if (hangPatch.timeout_minutes === null) delete mergedHang.timeout_minutes;
      if (Object.keys(mergedHang).length) mergedInst.hang_detector = mergedHang;
      else delete mergedInst.hang_detector;
    }
    // JSON has no `undefined`; null is the PATCH sentinel for removing an
    // optional override so the instance inherits the fleet default again.
    for (const key of nullableInstanceOverrides) {
      if (removesInstanceOverride(key, patch[key])) delete mergedInst[key];
    }
    const before = validateFleetConfig(cfg!);
    const after = validateFleetConfig({ ...cfg!, instances: { ...cfg!.instances, [name]: mergedInst } });
    if (rejectIfWorse(res, before, after)) return;
    cfg!.instances[name] = mergedInst as unknown as FleetConfig["instances"][string];
    if (!exists) clearPausedMarker(join(ctx.dataDir, "instances", name));
    ctx.saveFleetConfig(rawInstancePatches(name, patch));
    json(res, 200, { ok: true, warnings: saveWarnings(before, after) });
  };

  // POST /api/settings/fleet/instances  — create, name taken from the body.
  if (method === "POST" && path === "/api/settings/fleet/instances") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!validName(name)) return json(res, 400, { error: "missing or invalid instance name (provide `name` in the body)" });
      if (cfg.instances[name]) return json(res, 409, { error: "instance already exists" });
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
      if (!cfg.instances[name]) { json(res, 404, { error: "instance not found" }); return true; }
      // DELETE never blocks on validation; surface any resulting warnings.
      delete cfg.instances[name];
      clearPausedMarker(join(ctx.dataDir, "instances", name));
      ctx.saveFleetConfig();
      json(res, 200, { ok: true, warnings: validateFleetConfig(cfg).warnings });
      return true;
    }

    if (method === "POST" || method === "PATCH") {
      const exists = !!cfg.instances[name];
      if (method === "POST" && exists) { json(res, 409, { error: "instance already exists" }); return true; }
      if (method === "PATCH" && !exists) { json(res, 404, { error: "instance not found" }); return true; }
      readBody(req, 512 * 1024).then(buf => {
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
