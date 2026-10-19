import { readBoundedWebBody } from "./web-body.js";
import { permitWebContinuation } from "./web-continuation.js";
import { gatewayRequestContext } from "./web-request-context.js";
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
 *   DELETE /api/avatar/:instance → remove the uploaded avatar (signed in; #1630 follow-up)
 *   GET  /api/card/:instance    → the identity card as drawn: the person's fields over the agent's (#1629 r4 §1)
 *   GET  /api/card/:instance/:slot → its portrait or banner (slot = portrait | banner)
 *   POST|DELETE /api/card/:instance/:slot → the person's picture  (signed in; the public link too, r4.1 Q2)
 *   DELETE /api/card/:instance  → "Clear card": the person's fields  (signed in; the public link too)
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
import { isViewPage, shellRoute } from "./web-shell-routes.js";
import { serveAppShell, type AppShellContext } from "./web-api.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
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
import { bannerFocusOk, CARD_SLOTS, type CardSlot, HumanCardStore, resolveCard } from "./web-card.js";
import { IdentityColorStore } from "./web-identity-color.js";
import { effectiveAppearanceLimits } from "./web-appearance-limits.js";
import type { ThemeCard } from "./web-theme.js";

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
  /** #1306: the preview origin chosen for a signed-in shell load (the same hook web-api.ts uses). */
  previewForUi?: AppShellContext["previewForUi"];
  /** #1629 r4 §1: the agent's side of the identity card (theme.card) and its pictures. */
  readonly themeStore?: { get(name: string): { theme: { card?: ThemeCard } }; asset(name: string, id: string): { bytes: Buffer; mime: string } | null };
  /** #1958: a profile, card or colour write landed — every open page repaints (a status frame), not only the writer's. */
  identityChanged?(): void;
}

interface ProfileRow {
  instance_name: string;
  display_name: string | null;
  avatar_path: string | null;
  role: string | null;
  description: string | null;
  updated_at: number;
}

/**
 * The identity one instance shows on every page (alpha.2, docs/design/web-unified-instance-nav.md §3.1): the status
 * frame (SSE, poll — the sidebar, Chat, Fleet) and /api/profiles (View, its anonymous reader) both resolve it here, so
 * an alias or description set on a profile is the same everywhere.
 * - display_name: profile → fleet.yaml → ClassicBot room → none
 * - description: profile → fleet.yaml → none;  role: profile → none
 * - tags: fleet.yaml; a ClassicBot room without its own is "classic" (strings only)
 */
export interface InstanceIdentity { display_name: string | null; description: string | null; role: string | null; tags: string[] }
export function resolveInstanceIdentity(input: {
  cfg?: { display_name?: string; description?: string; tags?: unknown } | null;
  classic?: { displayName?: string } | null;
  profile?: { display_name: string | null; description: string | null; role: string | null } | null;
}): InstanceIdentity {
  const { cfg, classic, profile } = input;
  const tags = Array.isArray(cfg?.tags) ? cfg.tags : classic ? ["classic"] : [];
  // A blank profile alias is no alias (#1630): the agent's own name (set_display_name) or the room's shows again — also
  // for an alias cleared before View stored "" for it.
  const alias = typeof profile?.display_name === "string" && profile.display_name.trim() ? profile.display_name : null;
  return {
    display_name: alias ?? cfg?.display_name ?? classic?.displayName ?? null,
    description: profile?.description ?? cfg?.description ?? null,
    role: profile?.role ?? null,
    tags: tags.filter((t): t is string => typeof t === "string"),
  };
}
/**
 * The teams an instance is a member of (fleet.yaml `teams.<name>.members`), in fleet.yaml's order — what the sidebar
 * groups it under first (#2172): an agent in a team sits with its team, whatever its tags say. Strings only.
 */
export function instanceTeams(teams: Record<string, { members?: unknown }> | undefined | null, name: string): string[] {
  if (!teams || typeof teams !== "object") return [];
  return Object.keys(teams).filter(team => Array.isArray(teams[team]?.members) && (teams[team]!.members as unknown[]).includes(name));
}
/** Profiles by instance, for a status read: only when profiles.db already exists — a status read never creates it. */
export function profileIdentities(dataDir: string): Map<string, Pick<ProfileRow, "display_name" | "description" | "role" | "avatar_path">> {
  if (!existsSync(join(dataDir, "profiles.db"))) return new Map();
  try {
    // avatar_path: #1630 — the picture uploaded in View stands for the instance first.
    const rows = profileDb(dataDir).prepare("SELECT instance_name, display_name, description, role, avatar_path FROM instance_profile").all() as ProfileRow[];
    return new Map(rows.map(r => [r.instance_name, r]));
  } catch { return new Map(); }
}

/** The person's side of the identity card (#1629 r4 §1), in profiles.db's own table. */
let _cards: { dir: string; store: HumanCardStore } | null = null;
function cardStore(ctx: { dataDir: string }): HumanCardStore {
  if (_cards?.dir !== ctx.dataDir) _cards = { dir: ctx.dataDir, store: new HumanCardStore(ctx.dataDir, () => profileDb(ctx.dataDir)) };
  return _cards.store;
}
/** #1958: the people's identity colours, in profiles.db's own table (instance_color). */
let _colors: { dir: string; store: IdentityColorStore } | null = null;
function colorStore(ctx: { dataDir: string }): IdentityColorStore {
  if (_colors?.dir !== ctx.dataDir) _colors = { dir: ctx.dataDir, store: new IdentityColorStore(() => profileDb(ctx.dataDir)) };
  return _colors.store;
}
/** #2056: one instance's person-picked colour and places, as the Colour dialog (GET /api/profile) reads them. */
export function personIdentityColour(dataDir: string, name: string): { color: string | null; show: string[] | null } {
  const pick = colorStore({ dataDir }).get(name);
  return { color: pick.color ?? null, show: pick.show ? [...pick.show] : null };
}
/**
 * #2056: a person's colour for one instance — exactly POST /api/profile's colour fields: the store's own check (in set(),
 * before anything is written), the table made first, the write in a profiles.db transaction. The caller announces
 * (identityChanged).
 */
export function setPersonIdentityColour(dataDir: string, name: string, identity: { color?: unknown; show?: unknown }):
  { ok: true } | { ok: false; status: number; error: string; detail?: string } {
  const store = colorStore({ dataDir });
  store.get(name);                                    // set() checks the patch before it writes anything
  let refused: { ok: false; status: number; error: string; detail?: string } | null = null;
  const rollback = new Error("rollback");
  try {
    profileDb(dataDir).transaction(() => { const w = store.set(name, identity); if (!w.ok) { refused = w; throw rollback; } })();
  } catch (err) {
    if (err === rollback && refused) return refused;
    return { ok: false, status: 503, error: "profile_write_failed", detail: (err as Error).message };
  }
  return { ok: true };
}
/** #2086: the banner focus a person set for one instance (null: none; the agent's, else the centre, is drawn). */
export function personBannerFocus(dataDir: string, name: string): number | null {
  return bannerFocusOk(cardStore({ dataDir }).get(name).banner_focus);
}
/** #2086: a person's banner focus — exactly POST /api/profile's card_banner_focus (the store's check; its own write). */
export function setPersonBannerFocus(dataDir: string, name: string, focus: unknown): { ok: true } | { ok: false; status: number; error: string; detail?: string } {
  return cardStore({ dataDir }).setBannerFocus(name, focus);
}
/** Every person-picked colour, for a status read (never creates profiles.db or its table). */
export function identityColors(dataDir: string): ReturnType<typeof IdentityColorStore.all> {
  return IdentityColorStore.all(dataDir, () => profileDb(dataDir));
}
/** The card picture drawn for `slot`: the person's, else the agent's (the same rule as the card's JSON). */
export function cardPicture(ctx: { dataDir: string; themeStore?: ViewApiContext["themeStore"] }, name: string, slot: CardSlot): { bytes: Buffer; mime: string } | null {
  const own = cardStore(ctx).picture(name, slot);
  if (own) return { bytes: own.bytes, mime: own.mime };
  const agentId = ctx.themeStore?.get(name).theme.card?.[slot];
  return agentId ? ctx.themeStore?.asset(name, agentId) ?? null : null;
}
/** Every person-set card, for a status read (never creates profiles.db or its table). */
export function humanCards(dataDir: string): ReturnType<typeof HumanCardStore.all> {
  return HumanCardStore.all(dataDir, () => profileDb(dataDir));
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
  return readBoundedWebBody(req, maxBytes);
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
  return isViewPage(path)
    || path.startsWith("/api/pane/")
    || path === "/api/profiles"
    || path.startsWith("/api/profile/")
    || path.startsWith("/api/avatar/")
    || path.startsWith("/api/card/")
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
  if (isRead && (gatewayRequestContext(req) || ctx.fleetConfig?.web?.view_access === "session") && denied()) return true;
  // Writes: always a credential. Checked once here rather than per route, so a route
  // added later cannot forget it.
  if (!isRead && denied()) return true;

  // ── GET /view, /view/<name> — the app shell, on its View panel (#1408 step 2) ──
  // A signed-in browser gets the whole app. Anyone else got here because reads are open (`web.view_access: open`, not
  // the public link): they get the View-only shell — the same look, with nothing that needs a session in it.
  if (isViewPage(path)) {
    const m = shellRoute(method, path);
    if (!m) { json(res, 405, { error: "method not allowed" }); return true; }
    if (m.kind === "malformed") { json(res, 400, { error: "invalid instance name" }); return true; }
    const signedIn = verdict().kind !== "reject";
    serveAppShell(req, res, ctx, signedIn ? "full" : "view-only");
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
      card_v?: string;
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
      // The same identity as the status frame's (resolveInstanceIdentity).
      const identity = resolveInstanceIdentity({ cfg, classic, profile: p });
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
        tags: identity.tags,
        teams: instanceTeams(ctx.fleetConfig?.teams, name),
        display_name: identity.display_name,
        role: identity.role,
        avatar_path: p?.avatar_path ?? null,
        description: identity.description,
        has_avatar: !!p?.avatar_path,
        // #1629 r4 §1: the identity card's version (the status frame's): View reads the card when it moves.
        ...(l?.card_v ? { card_v: l.card_v } : {}),
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
      // #1665: not over the public link (its route manifest no longer offers this write either).
      if (gatewayRequestContext(req)) { json(res, 403, { error: "sort_order_not_over_public_link" }); return true; }
      readBody(req, 512 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
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
      // #1958: the person's choice (null fields: not chosen — the agent's, the bot's, the host's or the automatic one shows).
      const pick = colorStore(ctx).get(name);
      json(res, 200, { ...row, color: pick.color, color_show: pick.show });
      return true;
    }

    if (method === "POST") {
      readBody(req, 256 * 1024).then(buf => {
      if (!permitWebContinuation(req, res, ctx)) return;
        let body: Record<string, unknown>;
        try { body = JSON.parse(buf.toString("utf-8") || "{}"); }
        catch { json(res, 400, { error: "invalid JSON" }); return; }
        if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "expected an object" }); return; }
        // #1630: only the fields the request carries change — one left out stays as it is; a blank one ("" or spaces)
        // clears it (no override: a cleared display name lets the agent's own show again, #1644).
        const set: Array<[string, string | null]> = [];
        for (const key of ["display_name", "role", "description"] as const) {
          if (!Object.hasOwn(body, key)) continue;
          const v = body[key];
          if (v !== null && typeof v !== "string") { json(res, 400, { error: `${key} must be a string` }); return; }
          set.push([key, typeof v === "string" && v.trim() ? v : null]);
        }
        // #1629 r4 §1: the card's tagline and bio (the person's — they win over the agent's, field by field). Checked
        // before anything is written, so a bad one changes nothing.
        const cardText: { tagline?: unknown; bio?: unknown } = {};
        if (Object.hasOwn(body, "card_tagline")) cardText.tagline = body.card_tagline;
        if (Object.hasOwn(body, "card_bio")) cardText.bio = body.card_bio;
        // #2086: the banner's focus (0 top … 100 bottom; null follows the agent's, else the centre) — checked first too.
        const focus = Object.hasOwn(body, "card_banner_focus") ? body.card_banner_focus : undefined;
        if (focus !== undefined && focus !== null && bannerFocusOk(focus) === null) { json(res, 400, { error: "card_banner_focus", detail: "a whole number from 0 (top) to 100 (bottom), or null" }); return; }
        // #1958: the identity colour (a preset or #rrggbb; null or "" resets it) and where it shows (color_show: a list
        // of name / bar / ring, [] for nowhere; null resets it) — checked before anything is written.
        const identity: { color?: unknown; show?: unknown } = {};
        if (Object.hasOwn(body, "color")) identity.color = body.color;
        if (Object.hasOwn(body, "color_show")) identity.show = body.color_show;
        const idCheck = colorStore(ctx).check(identity);
        if (!idCheck.ok) { json(res, idCheck.status, { error: idCheck.error, detail: idCheck.detail }); return; }
        const texts = cardText.tagline !== undefined || cardText.bio !== undefined;
        const ids = identity.color !== undefined || identity.show !== undefined;
        if (!texts && !ids && focus === undefined && !set.length) { json(res, 200, { ok: true }); return; }
        // Fable #1966 P3: the card text, the identity choice and the profile row in one transaction (all profiles.db):
        // a write that fails takes the others back with it, so the answer is never "failed" with part of it applied.
        const db = profileDb(ctx.dataDir);
        // Prism #2003 P2-2: the stores' tables are made before the transaction, so a rollback never leaves this cached
        // handle believing in tables it does not have.
        if (texts || focus !== undefined) cardStore(ctx).get(name);
        if (ids) colorStore(ctx).get(name);
        let refused: { status: number; error: string; detail?: string } | null = null;
        const rollback = new Error("rollback");
        try {
          db.transaction(() => {
            if (texts) { const cw = cardStore(ctx).setText(name, cardText); if (!cw.ok) { refused = cw; throw rollback; } }
            if (focus !== undefined) { const fw = cardStore(ctx).setBannerFocus(name, focus); if (!fw.ok) { refused = fw; throw rollback; } }
            if (ids) { const w = colorStore(ctx).set(name, identity); if (!w.ok) { refused = w; throw rollback; } }
            if (set.length) {
              // Column names come only from the fixed list above; avatar_path is the avatar route's — never touched here.
              const cols = set.map(([k]) => k);
              db.prepare(`INSERT INTO instance_profile (instance_name, ${cols.join(", ")}, updated_at)
                VALUES (@n, ${cols.map(c => `@${c}`).join(", ")}, @t)
                ON CONFLICT(instance_name) DO UPDATE SET ${cols.map(c => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`)
                .run({ n: name, t: Date.now(), ...Object.fromEntries(set) });
            }
          })();
        } catch (err) {
          const r = refused as { status: number; error: string; detail?: string } | null;
          if (err === rollback && r) { json(res, r.status, { error: r.error, ...(r.detail ? { detail: r.detail } : {}) }); return; }
          json(res, 503, { error: "profile_write_failed", detail: (err as Error).message });
          return;
        }
        try { ctx.identityChanged?.(); } catch { /* the next status frame carries it */ }
        json(res, 200, { ok: true });
      }).catch(err => json(res, 400, { error: (err as Error).message }));
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  // ── /api/card/:instance[/:slot] (#1629 r4 §1, r4.1 Q2) ──
  if (path.startsWith("/api/card/")) {
    const m = /^\/api\/card\/([^/]+)(?:\/(portrait|banner))?$/.exec(path);
    let name = "";
    try { name = m ? decodeURIComponent(m[1]!) : ""; } catch { name = ""; }
    if (!m || !knownInstance(ctx, name)) { json(res, 404, { error: "unknown instance" }); return true; }
    const slot = m[2] as CardSlot | undefined;
    const store = cardStore(ctx);
    if (method === "GET" && !slot) {
      // The limits in force ride along, so View's editor can fit a picture before it is sent (r4.1 Q3 (b)).
      const limits = effectiveAppearanceLimits(ctx.fleetConfig?.web?.appearance).limits;
      const slot = (l: { maxWidth: number; maxHeight: number; maxBytes: number }) => ({ max_width: l.maxWidth, max_height: l.maxHeight, max_bytes: l.maxBytes });
      // #2089 review: the agent's own banner focus too (not only the one drawn), so Edit profile's "Follow the agent's" shows it.
      const agentCard = ctx.themeStore?.get(name).theme.card, agentFocus = bannerFocusOk(agentCard?.bannerFocus);
      json(res, 200, { ...resolveCard(name, store.get(name), agentCard), ...(agentFocus !== null ? { banner_focus_agent: agentFocus } : {}), limits: { portrait: slot(limits.portrait), banner: slot(limits.banner) } });
      return true;
    }
    if (method === "GET" && slot) {
      const pic = cardPicture(ctx, name, slot);
      if (!pic) { json(res, 404, { error: "no picture" }); return true; }
      res.writeHead(200, { "Content-Type": pic.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "no-cache" });
      res.end(pic.bytes);
      return true;
    }
    if (method === "POST" && slot) {
      const limits = effectiveAppearanceLimits(ctx.fleetConfig?.web?.appearance).limits;
      readBody(req, limits[slot].maxBytes + 1).then(buf => {
        if (!permitWebContinuation(req, res, ctx)) return;
        if (buf.length === 0) { json(res, 400, { error: "empty body" }); return; }
        // The limits in force when it is stored, not when the upload began (#1889 review): the body cap above only
        // bounded what was received.
        const w = store.setPicture(name, slot, buf, effectiveAppearanceLimits(ctx.fleetConfig?.web?.appearance).limits);
        if (!w.ok) { json(res, w.status, { error: w.error, ...(w.detail ? { detail: w.detail } : {}) }); return; }
        json(res, 200, { ok: true, id: w.id });
      }).catch(err => json(res, 413, { error: "card_too_large", detail: (err as Error).message }));
      return true;
    }
    if (method === "DELETE" && slot) {
      const w = store.removePicture(name, slot);
      if (!w.ok) { json(res, w.status, { error: w.error }); return true; }
      json(res, 200, { ok: true, removed: w.removed });
      return true;
    }
    if (method === "DELETE" && !slot) {
      const w = store.clear(name);
      if (!w.ok) { json(res, w.status, { error: w.error }); return true; }
      json(res, 200, { ok: true });
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
      if (!permitWebContinuation(req, res, ctx)) return;
        if (buf.length === 0) { json(res, 400, { error: "empty body" }); return; }
        const dir = join(ctx.dataDir, "avatars");
        mkdirSync(dir, { recursive: true });
        // Replace this instance's prior avatar (incl. a different extension): the file its row records, and the one
        // written below — never a prefix match, which took "a.b.png" along with "a"'s (names may hold a ".": the
        // quickstart wizard and hand-edited fleet.yaml allow it; #1630 follow-up).
        const db = profileDb(ctx.dataDir);
        const prior = (db.prepare("SELECT avatar_path FROM instance_profile WHERE instance_name = ?").get(name) as { avatar_path: string | null } | undefined)?.avatar_path;
        if (prior) { try { unlinkSync(join(dir, basename(prior))); } catch { /* already gone */ } }
        const filename = `${name}${ext}`;
        writeFileSync(join(dir, filename), buf, { mode: 0o600 });
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

    // #1630 follow-up: back to the default — the bot's avatar, the persona emoji or the initial (instance-avatar.ts).
    // Only the file this instance's row records is deleted, then the row's avatar_path is cleared.
    if (method === "DELETE") {
      const db = profileDb(ctx.dataDir);
      const row = db.prepare("SELECT avatar_path FROM instance_profile WHERE instance_name = ?").get(name) as { avatar_path: string | null } | undefined;
      if (row?.avatar_path) {
        try { unlinkSync(join(ctx.dataDir, "avatars", basename(row.avatar_path))); } catch { /* already gone */ }
        db.prepare("UPDATE instance_profile SET avatar_path = NULL, updated_at = ? WHERE instance_name = ?").run(Date.now(), name);
      }
      json(res, 200, { ok: true, removed: Boolean(row?.avatar_path) });
      return true;
    }
    json(res, 405, { error: "method not allowed" });
    return true;
  }

  return false;
}
