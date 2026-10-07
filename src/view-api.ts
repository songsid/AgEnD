/**
 * Web View (`/view`) — a terminal-streaming page plus editable instance
 * profiles. Separate from the operator Web UI (`/ui`):
 *
 *   GET  /view                 → static page
 *   GET  /api/pane/:instance    → `tmux capture-pane -ep` output (ANSI text),
 *                                plus X-Pane-Cols / X-Pane-Rows response headers
 *   GET  /api/profiles          → merged roster (live status + config + profile)
 *   GET  /api/profile/:instance → one profile row
 *   POST /api/profile/:instance → upsert profile              (signed in)
 *   GET  /api/avatar/:instance  → avatar image
 *   POST /api/avatar/:instance  → upload avatar               (signed in)
 *   GET/POST /api/sort-order    → sidebar order               (POST: signed in)
 *
 * Auth: reads follow `web.view_access` — `open` (the default; the page is a
 * read-only dashboard on a loopback listener) or `session` (a signed-in
 * session or the CLI's header token is required for every route here, the page
 * included). Writes always need a credential: a session (with the CSRF checks
 * every cookie-authenticated write gets) or `X-Agend-Token`. A `?token=` in the
 * URL is never a write credential, and nothing here compares a token itself —
 * that is `web-auth.ts`'s one decision. Instance names are whitelisted against
 * fleet config and tmux is invoked via execFile (no shell) to prevent command
 * injection.
 */
import { sendPanelHtml } from "./web-host-guard.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import type { FleetConfig } from "./types.js";
import type { Logger } from "./logger.js";
import { getTmuxSession } from "./config.js";
import { getTmuxSocketName } from "./paths.js";
import { evaluateWebRequest, type WebGateRequest } from "./web-auth.js";
import type { WebSessionStore } from "./web-session.js";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ViewApiContext {
  readonly webToken: string | null;
  /** Absent in a hand-built context: cookies are then not a credential; the header token still is. */
  readonly webSessions?: WebSessionStore | null;
  readonly dataDir: string;
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  // Dynamically-created ClassicBot instances (not in fleet.yaml). Null before init.
  readonly classicChannels: {
    getAll(): { instanceName: string; name: string; backend?: string; channelId: string; displayName?: string }[];
    getBackendByInstance(name: string, fleetDefault?: string): string;
  } | null;
  getInstanceStatus(name: string): "running" | "paused" | "stopped" | "crashed";
  getUiStatus(): unknown;
  resolveInstanceModel?(name: string): { model: string };
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
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS instance_profile (
    instance_name TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_path TEXT,
    role TEXT,
    description TEXT,
    updated_at INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS view_sort_order (
    item_type TEXT NOT NULL,   -- 'group' or 'instance'
    item_name TEXT NOT NULL,
    sort_index INTEGER NOT NULL,
    group_name TEXT,           -- owning group (for instances)
    PRIMARY KEY (item_type, item_name)
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

/** Safe instance name that also exists as a fleet or classic instance. The
 * exact-match against the known-instances set IS the whitelist (a traversal or
 * injected name simply won't be in it), so we only additionally block path
 * separators / null bytes — the previous ASCII-only regex wrongly rejected
 * legitimate non-ASCII names (e.g. `classic-鬥破串接-1843`). */
function knownInstance(ctx: ViewApiContext, name: string): boolean {
  return /^[^\\/\x00]+$/.test(name) && allInstanceNames(ctx).has(name);
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

/** tmux target for an instance's window, or null if it has no window yet. */
function paneTarget(ctx: ViewApiContext, name: string): string | null {
  const widFile = join(ctx.dataDir, "instances", name, "window-id");
  if (!existsSync(widFile)) return null;
  const wid = readFileSync(widFile, "utf-8").trim();
  if (!wid) return null;
  return `${getTmuxSession()}:${wid}`;
}

function tmuxArgs(rest: string[]): string[] {
  const socket = getTmuxSocketName();
  return socket ? ["-L", socket, ...rest] : rest;
}

/** A pane's logical grid size in cells, as tmux sees it. */
export interface PaneSize { cols: number; rows: number }

/**
 * Capture a pane's contents (with ANSI escapes) **and** its logical grid size.
 *
 * The size matters as much as the text: the web view sizes its font from
 * `cols`/`rows` rather than from the captured text's longest line, because a
 * sparse frame (a freshly-started CLI printing three short lines) would
 * otherwise fit to ~3 columns and blow the font up to the 48px ceiling.
 */
async function capturePane(ctx: ViewApiContext, name: string): Promise<{ text: string; size: PaneSize | null }> {
  const target = paneTarget(ctx, name);
  if (!target) return { text: "", size: null };
  const [text, size] = await Promise.all([
    execFileP("tmux", tmuxArgs(["capture-pane", "-p", "-e", "-t", target]), { maxBuffer: 8 * 1024 * 1024 })
      .then(r => r.stdout),
    // display-message resolves the window's *active* pane, matching capture-pane.
    execFileP("tmux", tmuxArgs(["display-message", "-p", "-t", target, "#{pane_width}x#{pane_height}"]))
      .then(r => parsePaneSize(r.stdout))
      // A missing size must not fail the whole capture — the client falls back
      // to its last known size (or skips refitting) when the headers are absent.
      .catch(() => null),
  ]);
  return { text, size };
}

/** Parse `display-message`'s `<cols>x<rows>` output. Returns null if unusable. */
export function parsePaneSize(out: string): PaneSize | null {
  const m = /^(\d+)x(\d+)$/.exec(out.trim());
  if (!m) return null;
  const cols = Number(m[1]), rows = Number(m[2]);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
  return { cols, rows };
}

/** True if the path belongs to the view feature (so the caller can skip the
 * global web-token gate and let this module do its own token checks). */
export function isViewPath(path: string): boolean {
  return path === "/view"
    || path.startsWith("/api/pane/")
    || path === "/api/profiles"
    || path.startsWith("/api/profile/")
    || path.startsWith("/api/avatar/")
    || path === "/api/sort-order";
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
  // The gate in front of this handler has usually decided already; deciding again
  // here keeps the module safe when it is reached any other way, and is the only
  // place the refusal can say *why* (signed out, cross-site, missing CSRF value).
  const verdict = () => evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken, ctx.webSessions);
  const isRead = method === "GET" || method === "HEAD";
  const denied = (): boolean => {
    const decision = verdict();
    if (decision.kind === "reject") { json(res, decision.status, { error: decision.message }); return true; }
    return false;
  };

  // Reads: open unless the operator asked for a session (`web.view_access: session`).
  if (isRead && ctx.fleetConfig?.web?.view_access === "session" && denied()) return true;
  // Writes: always a credential. Checked once here rather than per route, so a route
  // added later cannot forget it.
  if (!isRead && denied()) return true;

  // ── GET /view — static page ──
  if (method === "GET" && path === "/view") {
    try {
      const html = readFileSync(join(__dirname, "ui", "view.html"), "utf-8");
      sendPanelHtml(res, html);
    } catch {
      json(res, 500, { error: "view.html not found" });
    }
    return true;
  }

  // ── GET /api/pane/:instance ──
  // Body is the raw ANSI capture; the pane's cell grid rides along in
  // X-Pane-Cols / X-Pane-Rows so the client can size its font from the pane's
  // real dimensions instead of guessing from the captured text.
  if (method === "GET" && path.startsWith("/api/pane/")) {
    const name = decodeURIComponent(path.slice("/api/pane/".length));
    if (!knownInstance(ctx, name)) { json(res, 404, { error: "unknown instance" }); return true; }
    capturePane(ctx, name)
      .then(({ text, size }) => {
        const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" };
        if (size) { headers["X-Pane-Cols"] = String(size.cols); headers["X-Pane-Rows"] = String(size.rows); }
        res.writeHead(200, headers);
        res.end(text);
      })
      .catch(err => { ctx.logger.debug({ err, name }, "capture-pane failed"); res.writeHead(200, { "Content-Type": "text/plain" }); res.end(""); });
    return true;
  }

  // ── GET /api/profiles — merged roster ──
  if (method === "GET" && path === "/api/profiles") {
    const ui = ctx.getUiStatus() as { instances: Array<{
      name: string;
      status: string;
      context_pct: number | null;
      model: string;
      model_source: string;
      effort: string | null;
      effort_source: string | null;
      display_name?: string;
    }> };
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
      // display_name priority: profile DB > fleet config > classic channel > null
      const display_name = p?.display_name
        ?? cfg?.display_name
        ?? classic?.displayName
        ?? l?.display_name
        ?? null;
      return {
        instance_name: name,
        status: l?.status ?? ctx.getInstanceStatus(name),
        context_pct: l?.context_pct ?? null, // null when unavailable, not 0
        // Prefer the CLI's live statusline when it reports a model; Classic and
        // non-statusline backends fall back to the shared effective resolver.
        model: l?.model || ctx.resolveInstanceModel?.(name).model || "",
        model_source: l?.model_source ?? "unresolved",
        // Effort: only the configured value (no live file from CLI), with capability check.
        effort: l?.effort ?? null,
        effort_source: l?.effort_source ?? null,
        // Prefer explicit instance backend; else classic resolver; else fleet
        // default — never hardcode "claude-code" when defaults.backend is kiro.
        backend: cfg?.backend
          ?? (classic
            ? ctx.classicChannels!.getBackendByInstance(name, ctx.fleetConfig?.defaults?.backend)
            : ctx.fleetConfig?.defaults?.backend)
          ?? "claude-code",
        tags: cfg?.tags ?? (classic ? ["classic"] : []),
        display_name,
        role: p?.role ?? null,
        avatar_path: p?.avatar_path ?? null,
        description: p?.description ?? cfg?.description ?? null,
        has_avatar: !!p?.avatar_path,
      };
    });
    json(res, 200, roster);
    return true;
  }

  // ── /api/sort-order — sidebar drag-sort override ──
  if (path === "/api/sort-order") {
    if (method === "GET") {
      const db = profileDb(ctx.dataDir);
      const rows = db.prepare("SELECT item_type, item_name, sort_index, group_name FROM view_sort_order ORDER BY sort_index").all();
      json(res, 200, rows);
      return true;
    }
    if (method === "POST") {
      readBody(req, 512 * 1024).then(buf => {
        let body: Array<{ item_type: string; item_name: string; sort_index: number; group_name?: string | null }>;
        try { body = JSON.parse(buf.toString("utf-8") || "[]"); } catch { json(res, 400, { error: "invalid JSON" }); return; }
        if (!Array.isArray(body)) { json(res, 400, { error: "expected an array" }); return; }
        const db = profileDb(ctx.dataDir);
        // Replace the whole ordering atomically — the client always sends the
        // complete order, so a full swap keeps the table consistent.
        const replace = db.transaction((rows: typeof body) => {
          db.prepare("DELETE FROM view_sort_order").run();
          const ins = db.prepare("INSERT OR REPLACE INTO view_sort_order (item_type, item_name, sort_index, group_name) VALUES (@t, @n, @i, @g)");
          for (const r of rows) {
            if (r.item_type !== "group" && r.item_type !== "instance") continue;
            if (typeof r.item_name !== "string") continue;
            ins.run({ t: r.item_type, n: r.item_name, i: Number(r.sort_index) || 0, g: r.group_name ?? null });
          }
        });
        replace(body);
        json(res, 200, { ok: true, count: body.length });
      }).catch(err => json(res, 400, { error: (err as Error).message }));
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  // ── /api/profile/:instance ──
  if (path.startsWith("/api/profile/")) {
    const name = decodeURIComponent(path.slice("/api/profile/".length));
    if (!knownInstance(ctx, name)) { json(res, 404, { error: "unknown instance" }); return true; }

    if (method === "GET") {
      const db = profileDb(ctx.dataDir);
      const row = (db.prepare("SELECT * FROM instance_profile WHERE instance_name = ?").get(name) as ProfileRow | undefined)
        ?? { instance_name: name, display_name: null, avatar_path: null, role: null, description: null, updated_at: 0 };
      json(res, 200, row);
      return true;
    }

    if (method === "POST") {
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
      const db = profileDb(ctx.dataDir);
      const row = db.prepare("SELECT avatar_path FROM instance_profile WHERE instance_name = ?").get(name) as { avatar_path: string | null } | undefined;
      if (!row?.avatar_path) { json(res, 404, { error: "no avatar" }); return true; }
      // Resolve by filename under the current dataDir/avatars — robust to a
      // stored ABSOLUTE path from a different dataDir resolution (the cause of
      // "avatar gone after restart"). basename() handles legacy absolute paths.
      const file = join(ctx.dataDir, "avatars", basename(row.avatar_path));
      if (!existsSync(file)) { json(res, 404, { error: "no avatar" }); return true; }
      const ext = (file.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
      try {
        const data = readFileSync(file);
        res.writeHead(200, { "Content-Type": IMAGE_MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(data);
      } catch { json(res, 404, { error: "avatar unreadable" }); }
      return true;
    }

    if (method === "POST") {
      const ext = extForMime(String(req.headers["content-type"] ?? ""));
      if (!ext) { json(res, 400, { error: "unsupported image type (png/jpeg/gif/webp)" }); return true; }
      readBody(req, 4 * 1024 * 1024).then(buf => {
        if (buf.length === 0) { json(res, 400, { error: "empty body" }); return; }
        const dir = join(ctx.dataDir, "avatars");
        mkdirSync(dir, { recursive: true });
        // Remove any prior avatar for this instance (incl. a different extension).
        for (const f of (existsSync(dir) ? readdirSync(dir) : [])) {
          if (f.startsWith(`${name}.`)) { try { unlinkSync(join(dir, f)); } catch { /* best effort */ } }
        }
        const filename = `${name}${ext}`;
        writeFileSync(join(dir, filename), buf, { mode: 0o600 });
        const db = profileDb(ctx.dataDir);
        // Store the FILENAME only (not an absolute path) so it resolves against
        // whatever dataDir the fleet runs under after a restart.
        db.prepare(`INSERT INTO instance_profile (instance_name, avatar_path, updated_at)
          VALUES (@n, @a, @t)
          ON CONFLICT(instance_name) DO UPDATE SET avatar_path = @a, updated_at = @t`)
          .run({ n: name, a: filename, t: Date.now() });
        json(res, 200, { ok: true, avatar_path: filename });
      }).catch(err => json(res, 400, { error: (err as Error).message }));
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  return false;
}
