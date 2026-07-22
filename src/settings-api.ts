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
  restartClassicInstanceFromSettings?(instanceName: string): Promise<void>;
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
    if (!cfg?.instances[name]) { json(res, 404, { error: "instance not found" }); return true; }
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
      const allowed = new Set(["backend", "model", "collab", "context_lines"]);
      const unknown = Object.keys(body).filter(field => !allowed.has(field));
      if (unknown.length) return json(res, 400, { error: `unsupported fields: ${unknown.join(", ")}` });
      if (body.backend !== undefined && (typeof body.backend !== "string" || !KNOWN_BACKENDS.includes(body.backend))) {
        return json(res, 400, { error: "backend must be a known backend" });
      }
      if (body.model !== undefined && body.model !== null && typeof body.model !== "string") return json(res, 400, { error: "model must be a string" });
      if (body.collab !== undefined && typeof body.collab !== "boolean") return json(res, 400, { error: "collab must be a boolean" });
      if (body.context_lines !== undefined && (!Number.isInteger(body.context_lines) || (body.context_lines as number) < 0)) {
        return json(res, 400, { error: "context_lines must be a non-negative integer" });
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
        if (instanceName && ctx.restartClassicInstanceFromSettings) await ctx.restartClassicInstanceFromSettings(instanceName);
      } catch (err) {
        // Keep disk and runtime consistent if the requested restart fails.
        try { writeClassicAtomic(ctx, previous); } catch (rollbackErr) {
          ctx.logger.error({ err: rollbackErr, key }, "settings: failed to roll back classic channel update");
        }
        if (instanceName && ctx.restartClassicInstanceFromSettings) {
          try { await ctx.restartClassicInstanceFromSettings(instanceName); }
          catch (recoveryErr) { ctx.logger.error({ err: recoveryErr, key, instanceName }, "settings: failed to restore classic instance after rollback"); }
        }
        ctx.logger.warn({ err, key, instanceName }, "settings: classic channel restart failed; config rolled back");
        return json(res, 409, { error: `classic instance restart failed: ${(err as Error).message}` });
      }
      ctx.logger.info({ key, instanceName }, "settings: updated classic channel");
      json(res, 200, { ok: true, warnings: saveWarnings(before, after), restarted: !!instanceName });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Reload (SIGHUP) ──
  if (method === "POST" && path === "/api/settings/reload") {
    ctx.logger.info("settings: reload requested — sending SIGHUP");
    try { process.kill(process.pid, "SIGHUP"); } catch (err) { ctx.logger.warn({ err }, "settings: SIGHUP failed"); }
    json(res, 200, { ok: true });
    return true;
  }

  // ── Instances (create / patch / delete) ──
  const validName = (n: string) => !!n && /^[^\\/\x00]+$/.test(n);
  const nullableInstanceOverrides = new Set(["auto_pause_after", "hang_detector", "agent_mode", "tool_set", "log_level", "lightweight", "model_failover", "display_name"]);
  const rawInstancePatches = (name: string, patch: Record<string, unknown>): RawConfigPatch[] => {
    const changes: RawConfigPatch[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === "hang_detector" && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
          changes.push({ path: ["instances", name, key, nestedKey], value: nestedValue, remove: nestedValue === null });
        }
      } else {
        changes.push({ path: ["instances", name, key], value, remove: value === null && nullableInstanceOverrides.has(key) });
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
      if (patch[key] === null) delete mergedInst[key];
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
