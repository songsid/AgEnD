/**
 * Read-only Web View (`/view`) — a terminal-streaming page plus editable
 * instance profiles. Separate from the operator Web UI (`/ui`):
 *
 *   GET  /view                 → static page (view.token or web.token)
 *   GET  /api/pane/:instance    → `tmux capture-pane -ep` output (ANSI text)
 *   GET  /api/profiles          → merged roster (live status + config + profile)
 *   GET  /api/profile/:instance → one profile row
 *   POST /api/profile/:instance → upsert profile              (web.token only)
 *   GET  /api/avatar/:instance  → avatar image
 *   POST /api/avatar/:instance  → upload avatar               (web.token only)
 *
 * Auth: GET routes accept view.token OR web.token; POST routes require the
 * (read-write) web.token. Instance names are whitelisted against fleet config
 * and tmux is invoked via execFile (no shell) to prevent command injection.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import type { FleetConfig } from "./types.js";
import type { Logger } from "./logger.js";
import { getTmuxSession } from "./config.js";
import { getTmuxSocketName } from "./paths.js";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ViewApiContext {
  readonly viewToken: string | null;
  readonly webToken: string | null;
  readonly dataDir: string;
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  // Dynamically-created ClassicBot instances (not in fleet.yaml). Null before init.
  readonly classicChannels: {
    getAll(): { instanceName: string; name: string; backend?: string; channelId: string }[];
    getBackendByInstance(name: string, fleetDefault?: string): string;
  } | null;
  getInstanceStatus(name: string): "running" | "stopped" | "crashed";
  getUiStatus(): unknown;
}

interface ProfileRow {
  instance_name: string;
  display_name: string | null;
  avatar_path: string | null;
  role: string | null;
  description: string | null;
  updated_at: number;
}

// Lazy per-dataDir SQLite handle for instance profiles.
let _db: Database.Database | null = null;
let _dbPath = "";
function profileDb(dataDir: string): Database.Database {
  const p = join(dataDir, "profiles.db");
  if (_db && _dbPath === p) return _db;
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS instance_profile (
    instance_name TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_path TEXT,
    role TEXT,
    description TEXT,
    updated_at INTEGER
  );`);
  _db = db;
  _dbPath = p;
  return db;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
};
function extForMime(mime: string): string | null {
  if (mime.includes("png")) return ".png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";
  return null;
}

function tokenFrom(req: IncomingMessage, url: URL): string | null {
  const h = req.headers["x-agend-token"];
  return url.searchParams.get("token") ?? (typeof h === "string" ? h : null);
}
function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** All instance names the view knows about: fleet-config + dynamic classic. */
function allInstanceNames(ctx: ViewApiContext): Set<string> {
  const s = new Set(Object.keys(ctx.fleetConfig?.instances ?? {}));
  for (const c of ctx.classicChannels?.getAll() ?? []) s.add(c.instanceName);
  return s;
}

/** Safe instance name that also exists as a fleet or classic instance. */
function knownInstance(ctx: ViewApiContext, name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && allInstanceNames(ctx).has(name);
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

/** Capture a pane's current contents (with ANSI escapes) for an instance. */
async function capturePane(ctx: ViewApiContext, name: string): Promise<string> {
  const widFile = join(ctx.dataDir, "instances", name, "window-id");
  if (!existsSync(widFile)) return "";
  const wid = readFileSync(widFile, "utf-8").trim();
  if (!wid) return "";
  const socket = getTmuxSocketName();
  const args = [
    ...(socket ? ["-L", socket] : []),
    "capture-pane", "-p", "-e", "-t", `${getTmuxSession()}:${wid}`,
  ];
  const { stdout } = await execFileP("tmux", args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** True if the path belongs to the view feature (so the caller can skip the
 * global web-token gate and let this module do its own token checks). */
export function isViewPath(path: string): boolean {
  return path === "/view"
    || path.startsWith("/api/pane/")
    || path === "/api/profiles"
    || path.startsWith("/api/profile/")
    || path.startsWith("/api/avatar/");
}

/**
 * Handle a `/view` feature request. Returns true if the request was a view
 * route (and has been answered), false if it isn't ours.
 */
export function handleViewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ViewApiContext,
): boolean {
  const path = url.pathname;
  if (!isViewPath(path)) return false;

  const method = req.method ?? "GET";
  const token = tokenFrom(req, url);
  const canRead = !!token && (token === ctx.viewToken || token === ctx.webToken);
  const canWrite = !!token && token === ctx.webToken;

  // ── GET /view — static page ──
  if (method === "GET" && path === "/view") {
    if (!canRead) { json(res, 401, { error: "Unauthorized" }); return true; }
    try {
      const html = readFileSync(join(__dirname, "ui", "view.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      json(res, 500, { error: "view.html not found" });
    }
    return true;
  }

  // ── GET /api/pane/:instance ──
  if (method === "GET" && path.startsWith("/api/pane/")) {
    if (!canRead) { json(res, 401, { error: "Unauthorized" }); return true; }
    const name = decodeURIComponent(path.slice("/api/pane/".length));
    if (!knownInstance(ctx, name)) { json(res, 404, { error: "unknown instance" }); return true; }
    capturePane(ctx, name)
      .then(text => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end(text); })
      .catch(err => { ctx.logger.debug({ err, name }, "capture-pane failed"); res.writeHead(200, { "Content-Type": "text/plain" }); res.end(""); });
    return true;
  }

  // ── GET /api/profiles — merged roster ──
  if (method === "GET" && path === "/api/profiles") {
    if (!canRead) { json(res, 401, { error: "Unauthorized" }); return true; }
    const ui = ctx.getUiStatus() as { instances: Array<{ name: string; status: string; context_pct: number; model: string }> };
    const live = new Map(ui.instances.map(i => [i.name, i]));
    const db = profileDb(ctx.dataDir);
    const profiles = new Map((db.prepare("SELECT * FROM instance_profile").all() as ProfileRow[]).map(r => [r.instance_name, r]));
    // Merge fleet-config instances with dynamically-created classic instances
    // (which have tmux windows + status but aren't in fleet.yaml).
    const classicByName = new Map((ctx.classicChannels?.getAll() ?? []).map(c => [c.instanceName, c]));
    const roster = [...allInstanceNames(ctx)].map(name => {
      const cfg = ctx.fleetConfig?.instances[name];
      const classic = classicByName.get(name);
      const l = live.get(name);
      const p = profiles.get(name);
      return {
        instance_name: name,
        status: l?.status ?? ctx.getInstanceStatus(name),
        context_pct: l?.context_pct ?? 0,
        model: l?.model ?? "",
        backend: cfg?.backend ?? (classic ? ctx.classicChannels!.getBackendByInstance(name) : "claude-code"),
        tags: cfg?.tags ?? (classic ? ["classic"] : []),
        display_name: p?.display_name ?? null,
        role: p?.role ?? null,
        avatar_path: p?.avatar_path ?? null,
        description: p?.description ?? cfg?.description ?? null,
        has_avatar: !!p?.avatar_path,
      };
    });
    json(res, 200, roster);
    return true;
  }

  // ── /api/profile/:instance ──
  if (path.startsWith("/api/profile/")) {
    const name = decodeURIComponent(path.slice("/api/profile/".length));
    if (!knownInstance(ctx, name)) { json(res, 404, { error: "unknown instance" }); return true; }

    if (method === "GET") {
      if (!canRead) { json(res, 401, { error: "Unauthorized" }); return true; }
      const db = profileDb(ctx.dataDir);
      const row = (db.prepare("SELECT * FROM instance_profile WHERE instance_name = ?").get(name) as ProfileRow | undefined)
        ?? { instance_name: name, display_name: null, avatar_path: null, role: null, description: null, updated_at: 0 };
      json(res, 200, row);
      return true;
    }

    if (method === "POST") {
      if (!canWrite) { json(res, 401, { error: "Unauthorized (web token required)" }); return true; }
      readBody(req, 256 * 1024).then(buf => {
        let body: { display_name?: string; role?: string; description?: string };
        try { body = JSON.parse(buf.toString("utf-8") || "{}"); }
        catch { json(res, 400, { error: "invalid JSON" }); return; }
        const db = profileDb(ctx.dataDir);
        // avatar_path is managed by the avatar upload route — don't clobber it here.
        db.prepare(`INSERT INTO instance_profile (instance_name, display_name, role, description, updated_at)
          VALUES (@n, @d, @r, @desc, @t)
          ON CONFLICT(instance_name) DO UPDATE SET
            display_name = @d, role = @r, description = @desc, updated_at = @t`)
          .run({ n: name, d: body.display_name ?? null, r: body.role ?? null, desc: body.description ?? null, t: Date.now() });
        json(res, 200, { ok: true });
      }).catch(err => json(res, 400, { error: (err as Error).message }));
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  // ── /api/avatar/:instance ──
  if (path.startsWith("/api/avatar/")) {
    const name = decodeURIComponent(path.slice("/api/avatar/".length));
    if (!knownInstance(ctx, name)) { json(res, 404, { error: "unknown instance" }); return true; }

    if (method === "GET") {
      if (!canRead) { json(res, 401, { error: "Unauthorized" }); return true; }
      const db = profileDb(ctx.dataDir);
      const row = db.prepare("SELECT avatar_path FROM instance_profile WHERE instance_name = ?").get(name) as { avatar_path: string | null } | undefined;
      const file = row?.avatar_path;
      if (!file || !existsSync(file)) { json(res, 404, { error: "no avatar" }); return true; }
      const ext = (file.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
      try {
        const data = readFileSync(file);
        res.writeHead(200, { "Content-Type": IMAGE_MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(data);
      } catch { json(res, 404, { error: "avatar unreadable" }); }
      return true;
    }

    if (method === "POST") {
      if (!canWrite) { json(res, 401, { error: "Unauthorized (web token required)" }); return true; }
      const ext = extForMime(String(req.headers["content-type"] ?? ""));
      if (!ext) { json(res, 400, { error: "unsupported image type (png/jpeg/gif/webp)" }); return true; }
      readBody(req, 4 * 1024 * 1024).then(buf => {
        if (buf.length === 0) { json(res, 400, { error: "empty body" }); return; }
        const dir = join(ctx.dataDir, "avatars");
        mkdirSync(dir, { recursive: true });
        // Remove any prior avatar for this instance (different extension).
        for (const f of (existsSync(dir) ? readdirSync(dir) : [])) {
          if (f.startsWith(`${name}.`)) { try { writeFileSync(join(dir, f), ""); } catch { /* best effort */ } }
        }
        const dest = join(dir, `${name}${ext}`);
        writeFileSync(dest, buf, { mode: 0o600 });
        const db = profileDb(ctx.dataDir);
        db.prepare(`INSERT INTO instance_profile (instance_name, avatar_path, updated_at)
          VALUES (@n, @a, @t)
          ON CONFLICT(instance_name) DO UPDATE SET avatar_path = @a, updated_at = @t`)
          .run({ n: name, a: dest, t: Date.now() });
        json(res, 200, { ok: true, avatar_path: dest });
      }).catch(err => json(res, 400, { error: (err as Error).message }));
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  return false;
}
