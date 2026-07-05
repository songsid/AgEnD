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
 *   POST /api/settings/reload                   → SIGHUP hot-reload
 *
 * Auth: all routes require the web.token — enforced by the global web-token gate
 * in fleet-manager BEFORE this handler runs (settings paths are not exempt), so
 * no per-route auth is repeated here.
 *
 * Writes are validated first (config-validator): any error → 400 and nothing is
 * written; warnings are non-blocking and returned alongside the result.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { Logger } from "./logger.js";
import type { FleetConfig } from "./types.js";
import { validateFleetConfig, validateClassicBotConfig, type ValidationResult } from "./config-validator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SettingsApiContext {
  fleetConfig: FleetConfig | null;
  configPath: string | null;
  dataDir: string;
  logger: Logger;
  saveFleetConfig(): void;
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

function readClassic(ctx: SettingsApiContext): Record<string, unknown> {
  const p = classicPath(ctx);
  if (!existsSync(p)) return {};
  try { return (yaml.load(readFileSync(p, "utf-8")) as Record<string, unknown>) ?? {}; }
  catch (err) { ctx.logger.warn({ err }, "settings: failed to parse classicBot.yaml"); return {}; }
}

/** Reject write payloads whose validation fails; returns true if it responded 400. */
function rejectIfInvalid(res: ServerResponse, result: ValidationResult): boolean {
  if (!result.valid) {
    json(res, 400, { ok: false, errors: result.errors, warnings: result.warnings });
    return true;
  }
  return false;
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
  if (method === "GET" && path === "/api/settings/classic") {
    json(res, 200, readClassic(ctx));
    return true;
  }

  // Everything below mutates — needs an in-memory fleet config.
  const cfg = ctx.fleetConfig;

  // ── Fleet defaults ──
  if (method === "PUT" && path === "/api/settings/fleet/defaults") {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    readBody(req, 512 * 1024).then(buf => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const merged = { ...cfg.defaults, ...body };
      const result = validateFleetConfig({ ...cfg, defaults: merged });
      if (rejectIfInvalid(res, result)) return;
      cfg.defaults = merged as typeof cfg.defaults;
      ctx.saveFleetConfig();
      json(res, 200, { ok: true, warnings: result.warnings });
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
      const result = validateFleetConfig(next);
      if (rejectIfInvalid(res, result)) return;
      cfg.channels = body as FleetConfig["channels"];
      delete (cfg as { channel?: unknown }).channel;
      ctx.saveFleetConfig();
      json(res, 200, { ok: true, warnings: result.warnings });
    }).catch(() => json(res, 400, { error: "bad request" }));
    return true;
  }

  // ── Classic defaults ──
  if (method === "PUT" && path === "/api/settings/classic/defaults") {
    readBody(req, 512 * 1024).then(buf => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
      const classic = readClassic(ctx);
      const merged = { ...(classic.defaults as Record<string, unknown> ?? {}), ...body };
      const result = validateClassicBotConfig({ ...classic, defaults: merged });
      if (rejectIfInvalid(res, result)) return;
      classic.defaults = merged;
      writeFileSync(classicPath(ctx), yaml.dump(classic, { lineWidth: -1 }));
      ctx.logger.info("settings: updated classicBot defaults");
      json(res, 200, { ok: true, warnings: result.warnings });
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
  const instPrefix = "/api/settings/fleet/instances/";
  if (path.startsWith(instPrefix)) {
    if (!cfg) { json(res, 503, { error: "fleet not loaded" }); return true; }
    const name = decodeURIComponent(path.slice(instPrefix.length));
    // Guard against path separators / empty names.
    if (!name || !/^[^\\/\x00]+$/.test(name)) { json(res, 400, { error: "invalid instance name" }); return true; }

    if (method === "DELETE") {
      if (!cfg.instances[name]) { json(res, 404, { error: "instance not found" }); return true; }
      const next = { ...cfg, instances: { ...cfg.instances } };
      delete next.instances[name];
      const result = validateFleetConfig(next);
      // DELETE never blocks on validation errors, but surface warnings.
      delete cfg.instances[name];
      ctx.saveFleetConfig();
      json(res, 200, { ok: true, warnings: result.warnings });
      return true;
    }

    if (method === "POST" || method === "PATCH") {
      const exists = !!cfg.instances[name];
      if (method === "POST" && exists) { json(res, 409, { error: "instance already exists" }); return true; }
      if (method === "PATCH" && !exists) { json(res, 404, { error: "instance not found" }); return true; }
      readBody(req, 512 * 1024).then(buf => {
        let body: Record<string, unknown>;
        try { body = JSON.parse(buf.toString("utf-8") || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return json(res, 400, { error: "expected an object" });
        const base = (exists ? cfg.instances[name] : {}) as Record<string, unknown>;
        const mergedInst = { ...base, ...body };
        const next = { ...cfg, instances: { ...cfg.instances, [name]: mergedInst } };
        const result = validateFleetConfig(next);
        if (rejectIfInvalid(res, result)) return;
        cfg.instances[name] = mergedInst as unknown as FleetConfig["instances"][string];
        ctx.saveFleetConfig();
        json(res, 200, { ok: true, warnings: result.warnings });
      }).catch(() => json(res, 400, { error: "bad request" }));
      return true;
    }

    json(res, 405, { error: "method not allowed" });
    return true;
  }

  json(res, 404, { error: "not found" });
  return true;
}
