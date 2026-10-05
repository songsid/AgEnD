/**
 * Web UI HTTP API handler.
 * All /ui/* routes are handled here, extracted from fleet-manager.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { LifecycleCreateArgs } from "./instance-lifecycle.js";
import { CreateInstanceArgs, validateArgs } from "./outbound-schemas.js";
import { readStatuslineModel, resolveInstanceContext } from "./topic-commands.js";
import { z } from "zod";
import { isPassiveWebRead, isWebRequestAuthorized, WEB_TOKEN_INVALID_MESSAGE } from "./web-auth.js";
import { parseLastEventId, type WebChatHistory } from "./web-chat-history.js";
import { attachmentDelivery, displayName, INLINE_MIME, isFileId, publicAttachment, sniffUpload, UPLOAD_LIMITS, type UploadEntry, type WebFileLedger } from "./web-upload.js";
import { getAgendHome } from "./paths.js";
import type { WebSessionStore } from "./web-session.js";
import { authorizeExplicitInstanceRemoval } from "./instance-removal.js";
import type { ExplicitInstanceRemoval } from "./instance-removal.js";

// ── Strict public-facing schemas ────────────────────────────────────────────
// web-api endpoints must reject unknown fields so the dashboard cannot inject
// internal-only flags that would reach handleCreate/scheduler/config writers.

const MAX_TEXT = 16_384;

const TaskCreateSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(MAX_TEXT).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignee: z.string().max(128).optional(),
}).strict();

const TaskUpdateSchema = z.object({
  action: z.enum(["claim", "complete", "update"]).optional(),
  assignee: z.string().max(128).optional(),
  result: z.string().max(MAX_TEXT).optional(),
  status: z.string().max(64).optional(),
  title: z.string().max(512).optional(),
  description: z.string().max(MAX_TEXT).optional(),
  priority: z.string().max(64).optional(),
}).strict();

const ScheduleCreateSchema = z.object({
  cron: z.string().min(1).max(256),
  message: z.string().min(1).max(MAX_TEXT),
  target: z.string().min(1).max(256),
  label: z.string().max(256).optional(),
  timezone: z.string().max(128).optional(),
}).strict();

const TeamCreateSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  members: z.array(z.string().min(1).max(256)).min(1).max(256),
  description: z.string().max(MAX_TEXT).optional(),
}).strict();

const ConfigUpdateSchema = z.object({
  channel: z.object({
    group_id: z.union([z.number(), z.string()]).optional(),
    access: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional(),
  defaults: z.object({
    backend: z.enum(["claude-code", "gemini-cli", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"]).optional(),
    model: z.string().max(128).optional(),
  }).strict().optional(),
  project_roots: z.array(z.string().min(1).max(1024)).max(64).optional(),
}).strict();

const SendMessageSchema = z.object({
  instance: z.string().min(1).max(128),
  message: z.string().max(MAX_TEXT),
  /** Ids from POST /ui/upload, for this instance, not yet sent. */
  attachments: z.array(z.string().regex(/^[0-9a-f]{32}$/)).max(UPLOAD_LIMITS.maxFiles).optional(),
}).strict().refine(v => v.message.trim().length > 0 || (v.attachments?.length ?? 0) > 0, { message: "a message or at least one file", path: ["message"] });

/** An instance name that is safe as one path segment (no separator, no NUL, not a dot name). */
const safeInstanceSegment = (name: string): boolean => /^[^\\/\x00]+$/.test(name) && name !== "." && name !== "..";

/**
 * Push a single SSE frame to every client. If a client throws (closed socket
 * after a network drop, etc.), evict it from the set and continue — without
 * the eviction the dead entry leaks forever, and without the try/catch a
 * single dead client breaks delivery to every client iterated after it.
 */
export function broadcastSseEvent(
  clients: Set<ServerResponse>,
  event: string,
  data: unknown,
  onError?: (err: unknown) => void,
  id?: string,
): void {
  const payload = sseFrame(event, data, id);
  const dead: ServerResponse[] = [];
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      dead.push(client);
      onError?.(err);
    }
  }
  for (const c of dead) {
    clients.delete(c);
    try { c.end(); } catch { /* socket already gone */ }
  }
}

/** One SSE frame; `id` (a chat message's) lets a reconnecting EventSource say what it last saw. */
export function sseFrame(event: string, data: unknown, id?: string): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseOrReject<T>(
  schema: z.ZodType<T>,
  data: unknown,
  res: ServerResponse,
): T | null {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue.path.join(".");
    json(res, 400, { error: `${path || "body"}: ${issue.message}` });
    return null;
  }
  return r.data;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** How often a stream is refreshed, and how often it re-checks that its session still stands. */
export const SSE_HEARTBEAT_MS = 10_000;

/** Minimal interface — only what web-api needs from FleetManager. */
export interface WebApiContext {
  readonly webToken: string | null;
  /** Absent in a hand-built context: cookies are then simply not a credential, the header token still is. */
  readonly webSessions?: WebSessionStore | null;
  readonly dataDir: string;
  readonly sseClients: Set<ServerResponse>;
  readonly fleetConfig: {
    channel?: { group_id?: number | string; mode?: string };
    defaults?: { backend?: string; effort?: string };
    instances: Record<string, { topic_id?: number | string; working_directory: string; description?: string; display_name?: string; backend?: string }>;
    teams?: Record<string, { members: string[]; description?: string }>;
  } | null;
  readonly instanceIpcClients: Map<string, { send(msg: unknown): void }>;
  readonly adapter: { sendText(chatId: string, text: string, opts?: { threadId?: string }): Promise<unknown> } | null;
  getAdapterForInstance?(name: string): { sendText(chatId: string, text: string, opts?: { threadId?: string }): Promise<unknown> } | null;
  getGroupIdForInstance?(name: string): string;
  readonly daemons: Map<string, unknown>;
  readonly eventLog: { logActivity(event: string, sender: string, summary: string, receiver?: string, detail?: string): void; listActivity(opts?: { since?: string; limit?: number }): unknown[] } | null;
  readonly logger: { info(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  getInstanceDir(name: string): string;
  getInstanceStatus(name: string): "running" | "paused" | "stopped" | "crashed";
  deliverToInstance(instanceName: string, payload: Record<string, unknown>): Promise<void>;
  getUiStatus(): unknown;
  emitSseEvent(event: string, data: unknown): void;
  /** The web chat's recent messages (history + SSE replay); absent in contexts that have no chat. */
  readonly webChatHistory?: WebChatHistory;
  /** Uploads and the files the dashboard may fetch back (web track C2); absent: no file routes. */
  readonly webFiles?: WebFileLedger;
  /** Absent means SSE_HEARTBEAT_MS; a test shortens it. */
  readonly sseHeartbeatMs?: number;
  startInstance(name: string, config: unknown, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<void>;
  restartSingleInstance(name: string, opts?: { explicit?: boolean }): Promise<void>;
  removeInstance(name: string, authorization: ExplicitInstanceRemoval): Promise<void>;
  lastInboundUser: Map<string, string>;
  saveFleetConfig(): void;
  readonly lifecycle: { handleCreate(args: LifecycleCreateArgs, respond: (result: unknown, error?: string) => void): Promise<void> };
  connectIpcToInstance(name: string): Promise<void>;
  /** Human-readable model string (aligned with /ctx). */
  modelDisplayForInstance?(name: string): string;
  /** Full model resolution with source. */
  resolveInstanceModel?(name: string): { model: string; source: string; display: string };
  /** Configured effort for an instance (no live file from CLI). */
  resolveInstanceEffort?(name: string): { effort: string | null; source: "instance" | "fleet-default" | "unset" };
  /** Effort strategy for backend capability check. */
  effortStrategyFor?(name: string): "runtime" | "restart" | "unsupported";
  readonly scheduler: {
    db: {
      listTasks(opts?: { assignee?: string; status?: string }): unknown[];
      createTask(params: { title: string; description?: string; priority?: string; assignee?: string; created_by: string }): unknown;
      updateTask(id: string, params: Record<string, unknown>): unknown;
      claimTask(id: string, assignee: string): unknown;
      completeTask(id: string, result?: string): unknown;
    };
    list(target?: string): unknown[];
    create(params: unknown): unknown;
    delete(id: string): void;
  } | null;
}

/** Parse JSON body from request. */
function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

/** Send JSON response. */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

/**
 * Handle a Web UI request. Returns true if handled, false to pass through.
 */
export function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: WebApiContext,
): boolean {
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Auth check for all /ui routes. Defence in depth behind the fleet-manager
  // gate: the same session cookie or header token, and an unset token closes
  // the panel instead of comparing null against a missing credential.
  if (path.startsWith("/ui")) {
    if (!isWebRequestAuthorized(req, url, ctx.webToken, ctx.webSessions, { touch: !isPassiveWebRead(method, path) })) {
      json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE });
      return true;
    }
  } else {
    return false;
  }

  // ── Static files ───────────────────────────────────────

  if (method === "GET" && path === "/ui") {
    try {
      const html = readFileSync(join(__dirname, "ui", "dashboard.html"), "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end(html);
    } catch {
      json(res, 500, { error: "dashboard.html not found" });
    }
    return true;
  }

  // Serve JS modules
  if (method === "GET" && path.startsWith("/ui/js/")) {
    const fileName = path.slice("/ui/js/".length);
    if (!/^[a-z0-9_-]+\.js$/.test(fileName)) {
      json(res, 400, { error: "Invalid file name" });
      return true;
    }
    try {
      const js = readFileSync(join(__dirname, "ui", fileName), "utf-8");
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.writeHead(200);
      res.end(js);
    } catch {
      json(res, 404, { error: "File not found" });
    }
    return true;
  }

  // ── Backend detection ─────────────────────────────────

  if (method === "GET" && path === "/ui/backends") {
    const BACKENDS: Array<{ name: string; binary: string; deprecated?: boolean }> = [
      { name: "claude-code", binary: "claude" },
      { name: "codex", binary: "codex" },
      { name: "gemini-cli", binary: "gemini", deprecated: true },
      { name: "opencode", binary: "opencode" },
      { name: "kiro-cli", binary: "kiro-cli" },
      { name: "antigravity", binary: "agy" },
      { name: "grok", binary: "grok" },
      { name: "muse", binary: "muse" },
    ];
    const backends = BACKENDS.map(b => {
      let installed = false;
      let binPath = "";
      // Timeout matches the other `which` probe (instance-lifecycle): these are
      // synchronous and run in the fleet process, so a hung lookup on a broken
      // PATH entry (a dead NFS mount) would block the event loop indefinitely.
      try { binPath = execFileSync("which", [b.binary], { stdio: "pipe", timeout: 2000 }).toString().trim(); installed = true; } catch { /* not installed */ }
      return { name: b.name, binary: b.binary, installed, path: binPath, deprecated: b.deprecated ?? false };
    });
    json(res, 200, { backends });
    return true;
  }

  // ── SSE ────────────────────────────────────────────────

  // The same data as the stream, over plain requests, for a path that cannot carry SSE (Cloudflare Quick
  // Tunnels do not; a buffering proxy looks like a mute server). `after` is the same `<boot>-<id>` cursor
  // as the stream's Last-Event-ID, so polling and the stream can take turns without a message twice or
  // a gap — and a cursor from before a fleet restart gets the new process's backlog. No cursor yet (the page
  // has not seen a single stream message): everything still retained, like a restart's backlog, so a message
  // that arrived while the stream was silent is not skipped by the cursor this answer hands out (#1251
  // review). The page keeps one entry per boot+id, so what it already loaded from /ui/history is not doubled.
  if (method === "GET" && path === "/ui/poll") {
    const history = ctx.webChatHistory;
    const after = url.searchParams.get("after");
    const fresh = after === null || after === "";              // a cursor that is not ours in shape still gets nothing
    json(res, 200, {
      status: ctx.getUiStatus(),
      messages: history ? (fresh ? history.after(0) : history.replayFor(parseLastEventId(after))) : [],
      cursor: history ? `${history.boot}-${history.lastId}` : null,
    });
    return true;
  }

  if (method === "GET" && path === "/ui/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`);
    // An EventSource that reconnects says what it last saw: send what it missed, before anything new.
    const lastSeen = parseLastEventId(req.headers["last-event-id"]);
    if (lastSeen !== null && ctx.webChatHistory) {
      const history = ctx.webChatHistory;
      for (const m of history.replayFor(lastSeen)) res.write(sseFrame("message", m, history.cursorOf(m)));
    }
    ctx.sseClients.add(res);
    const interval = setInterval(() => {
      // A stream authorized once must not outlive the authorization. Re-checked
      // without counting as activity, or an open tab would keep an idle session
      // alive forever; a revoked, expired or rotated-away session ends here.
      if (!isWebRequestAuthorized(req, url, ctx.webToken, ctx.webSessions, { touch: false })) {
        // Close the connection too, not just the response: an ended response leaves the socket idle in
        // keep-alive, still held open by whoever's session just ended.
        const socket = req.socket;
        try { res.end(() => socket?.destroy()); } catch { /* already closed */ }
        cleanup();
        return;
      }
      try {
        res.write(`event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`);
      } catch {
        cleanup();
      }
    }, ctx.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      ctx.sseClients.delete(res);
      clearInterval(interval);
    };
    // The *response's* `close` is the one that means the stream is over: it fires when the connection
    // goes away or the response is finished. The request's `close` means "the request has been read"
    // — on newer Node that can be as soon as it is consumed, which would drop a live stream from
    // sseClients and stop its session re-check while the response is still open. `error` covers
    // network resets that never deliver a clean FIN. Without these, dead clients accumulate in
    // sseClients and the heartbeat interval keeps firing forever.
    res.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);
    return true;
  }

  // ── Chat history ───────────────────────────────────────

  if (method === "GET" && path === "/ui/history") {
    const instance = url.searchParams.get("instance") ?? "";
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? 200 : Number(limitRaw);
    if (instance.length === 0 || instance.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      json(res, 400, { error: "instance (1-128 chars) and limit (1-500) required" });
      return true;
    }
    json(res, 200, { messages: ctx.webChatHistory?.list(instance, limit) ?? [], boot: ctx.webChatHistory?.boot ?? null, lastId: ctx.webChatHistory?.lastId ?? 0 });
    return true;
  }

  // ── Send message ───────────────────────────────────────

  if (method === "POST" && path === "/ui/send") {
    handleSendMessage(req, res, ctx);
    return true;
  }

  // ── Files (C2): upload one file for an instance; fetch a file by the id the fleet issued for it ──

  if (method === "POST" && path === "/ui/upload") {
    handleUpload(req, res, url, ctx);
    return true;
  }

  const fileMatch = path.match(/^\/ui\/file\/([^/]+)$/);
  if (method === "GET" && fileMatch) {
    const id = fileMatch[1]!;
    const got = isFileId(id) ? ctx.webFiles?.read(id) : null;
    if (!got) { json(res, 404, { error: "No such file" }); return true; }
    const { file, bytes } = got;
    const inline = INLINE_MIME.has(file.mime);
    // Only the four image types are shown in the page; anything else is a download, never rendered.
    res.setHeader("Content-Type", inline ? file.mime : (file.mime.startsWith("text/") ? "text/plain; charset=utf-8" : "application/octet-stream"));
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.writeHead(200);
    res.end(bytes);
    return true;
  }

  // ── Instance operations ────────────────────────────────

  const stopMatch = path.match(/^\/ui\/stop\/(.+)$/);
  if (method === "POST" && stopMatch) {
    const name = decodeURIComponent(stopMatch[1]);
    if (!ctx.fleetConfig?.instances[name]) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    (async () => {
      try {
        await ctx.stopInstance(name);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { stopped: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const startMatch = path.match(/^\/ui\/start\/(.+)$/);
  if (method === "POST" && startMatch) {
    const name = decodeURIComponent(startMatch[1]);
    const config = ctx.fleetConfig?.instances[name];
    if (!config) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const topicMode = ctx.fleetConfig?.channel?.mode === "topic";
    (async () => {
      try {
        await ctx.startInstance(name, config, topicMode ?? false);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { started: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const deleteMatch = path.match(/^\/ui\/instances\/(.+)\/delete$/);
  if (method === "POST" && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    if (!ctx.fleetConfig?.instances[name]) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    (async () => {
      try {
        const body = await parseBody(req);
        if (body.confirm !== `delete ${name}`) {
          json(res, 400, { error: `Confirmation required: { "confirm": "delete ${name}" }` });
          return;
        }
        await ctx.removeInstance(name, authorizeExplicitInstanceRemoval("dashboard-confirmed"));
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { deleted: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Instance detail ────────────────────────────────────

  const detailMatch = path.match(/^\/ui\/instance\/(.+)$/);
  if (method === "GET" && detailMatch) {
    const name = decodeURIComponent(detailMatch[1]);
    const config = ctx.fleetConfig?.instances[name];
    if (!config) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const statusFile = join(ctx.getInstanceDir(name), "statusline.json");
    let statusline: Record<string, unknown> = {};
    try { statusline = JSON.parse(readFileSync(statusFile, "utf-8")); } catch { /* */ }

    const activity = ctx.eventLog?.listActivity({ since: new Date(Date.now() - 3600_000).toISOString(), limit: 50 }) ?? [];
    const instanceActivity = (activity as { sender?: string; receiver?: string }[]).filter(
      a => a.sender === name || a.receiver === name,
    );

    // Backend: instance → fleet default → claude-code
    const backend = config.backend ?? ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    // Context: aligned with /ctx — resolveInstanceContext, not statusline
    const { context } = resolveInstanceContext(ctx.dataDir, name, backend);
    const context_pct = context; // null when unavailable, not 0
    // Model: Claude Code has live statusline, others use the effective resolver (aligned with /ctx).
    const statuslineModel = backend === "claude-code" ? readStatuslineModel(ctx.dataDir, name) : null;
    const resolved = ctx.resolveInstanceModel?.(name);
    const model = statuslineModel ?? resolved?.display ?? ctx.modelDisplayForInstance?.(name);
    const model_source = statuslineModel ? "live" : (resolved?.source ?? "unresolved");
    // Effort: aligned with /ctx's effortLineFor — unsupported and antigravity don't show effort.
    const effortStrategy = ctx.effortStrategyFor?.(name) ?? "unsupported";
    const isAgy = backend === "antigravity" || backend === "agy";
    const effortResolved = ctx.resolveInstanceEffort?.(name);
    const effort = (effortStrategy === "unsupported" || isAgy) ? null : (effortResolved?.effort ?? null);
    const effort_source = (effortStrategy === "unsupported" || isAgy) ? null : (effortResolved?.source ?? "unset");

    json(res, 200, {
      name,
      status: ctx.getInstanceStatus(name),
      description: config.description,
      display_name: config.display_name,
      working_directory: config.working_directory,
      backend,
      context_pct,
      model,
      model_source,
      effort,
      effort_source,
      statusline,
      recent_activity: instanceActivity.slice(0, 20),
    });
    return true;
  }

  // ── Restart (with auth — unifies /restart/:name) ─────

  const restartMatch = path.match(/^\/ui\/restart\/(.+)$/);
  if (method === "POST" && restartMatch) {
    const name = decodeURIComponent(restartMatch[1]);
    (async () => {
      try {
        await ctx.restartSingleInstance(name, { explicit: true });
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { restarted: name });
      } catch (err) {
        const status = (err as Error).message.includes("not found") ? 404 : 500;
        json(res, status, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Create instance ────────────────────────────────────

  if (method === "POST" && path === "/ui/instances") {
    (async () => {
      try {
        const body = await parseBody(req);
        const v = validateArgs(CreateInstanceArgs, body, "create_instance");
        if (!v.ok) { json(res, 400, { error: v.error }); return; }
        let result: unknown = null;
        let error: string | undefined;
        await ctx.lifecycle.handleCreate(v.data, (r, e) => { result = r; error = e; });
        if (error) {
          json(res, 400, { error });
        } else {
          ctx.emitSseEvent("status", ctx.getUiStatus());
          json(res, 200, result);
        }
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Task board ─────────────────────────────────────────

  if (method === "GET" && path === "/ui/tasks") {
    if (!ctx.scheduler) {
      json(res, 200, { tasks: [] });
      return true;
    }
    const tasks = ctx.scheduler.db.listTasks();
    json(res, 200, { tasks });
    return true;
  }

  if (method === "POST" && path === "/ui/tasks") {
    if (!ctx.scheduler) {
      json(res, 500, { error: "Scheduler not initialized" });
      return true;
    }
    (async () => {
      try {
        const body = await parseBody(req);
        const parsed = parseOrReject(TaskCreateSchema, body, res);
        if (!parsed) return;
        const task = ctx.scheduler!.db.createTask({
          title: parsed.title,
          description: parsed.description,
          priority: parsed.priority,
          assignee: parsed.assignee,
          created_by: "web-user",
        });
        json(res, 200, task);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const taskMatch = path.match(/^\/ui\/tasks\/(.+)$/);
  if (method === "POST" && taskMatch) {
    if (!ctx.scheduler) {
      json(res, 500, { error: "Scheduler not initialized" });
      return true;
    }
    const id = decodeURIComponent(taskMatch[1]);
    (async () => {
      try {
        const body = await parseBody(req);
        const parsed = parseOrReject(TaskUpdateSchema, body, res);
        if (!parsed) return;
        let result: unknown;
        if (parsed.action === "claim") {
          result = ctx.scheduler!.db.claimTask(id, parsed.assignee || "web-user");
        } else if (parsed.action === "complete") {
          result = ctx.scheduler!.db.completeTask(id, parsed.result);
        } else {
          // Strip action before passing remaining fields to updateTask
          const { action: _a, ...rest } = parsed;
          result = ctx.scheduler!.db.updateTask(id, rest);
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Schedules ───────────────────────────────────────────

  if (method === "GET" && path === "/ui/schedules") {
    if (!ctx.scheduler) { json(res, 200, { schedules: [] }); return true; }
    json(res, 200, { schedules: ctx.scheduler.list() });
    return true;
  }

  if (method === "POST" && path === "/ui/schedules") {
    if (!ctx.scheduler) { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    (async () => {
      try {
        const body = await parseBody(req);
        const parsed = parseOrReject(ScheduleCreateSchema, body, res);
        if (!parsed) return;
        const schedule = ctx.scheduler!.create(parsed);
        json(res, 200, schedule);
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  const schedDelMatch = path.match(/^\/ui\/schedules\/(.+)$/);
  if (method === "DELETE" && schedDelMatch) {
    if (!ctx.scheduler) { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    try {
      ctx.scheduler.delete(decodeURIComponent(schedDelMatch[1]));
      json(res, 200, { deleted: true });
    } catch (err) { json(res, 400, { error: (err as Error).message }); }
    return true;
  }

  // ── Teams ──────────────────────────────────────────────

  if (method === "GET" && path === "/ui/teams") {
    const teams = ctx.fleetConfig?.teams ?? {};
    json(res, 200, { teams });
    return true;
  }

  if (method === "POST" && path === "/ui/teams") {
    (async () => {
      try {
        const body = await parseBody(req);
        const parsed = parseOrReject(TeamCreateSchema, body, res);
        if (!parsed) return;
        if (!ctx.fleetConfig) { json(res, 500, { error: "No fleet config" }); return; }
        if (!ctx.fleetConfig.teams) (ctx.fleetConfig as { teams: Record<string, unknown> }).teams = {};
        (ctx.fleetConfig.teams as Record<string, unknown>)[parsed.name] = {
          members: parsed.members,
          description: parsed.description,
        };
        ctx.saveFleetConfig();
        json(res, 200, { created: parsed.name });
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  const teamDelMatch = path.match(/^\/ui\/teams\/(.+)$/);
  if (method === "DELETE" && teamDelMatch) {
    const name = decodeURIComponent(teamDelMatch[1]);
    if (!ctx.fleetConfig?.teams?.[name]) { json(res, 404, { error: `Team not found: ${name}` }); return true; }
    delete (ctx.fleetConfig.teams as Record<string, unknown>)[name];
    ctx.saveFleetConfig();
    json(res, 200, { deleted: name });
    return true;
  }

  // ── Fleet config (read-only, sanitized) ────────────────

  if (method === "GET" && path === "/ui/config") {
    const config = ctx.fleetConfig;
    if (!config) { json(res, 200, {}); return true; }
    const ch = config.channel as Record<string, unknown> | undefined;
    const defaults = (config as Record<string, unknown>).defaults as Record<string, unknown> | undefined;
    json(res, 200, {
      channel: ch ? {
        type: ch.type, mode: config.channel!.mode,
        bot_token_env: ch.bot_token_env,
        group_id: config.channel!.group_id,
        access: ch.access,
      } : undefined,
      defaults: defaults ? { backend: defaults.backend, model: defaults.model } : undefined,
      project_roots: (config as Record<string, unknown>).project_roots,
      health_port: (config as Record<string, unknown>).health_port,
    });
    return true;
  }

  if (method === "POST" && path === "/ui/config") {
    (async () => {
      try {
        const body = await parseBody(req);
        const parsed = parseOrReject(ConfigUpdateSchema, body, res);
        if (!parsed) return;
        const config = ctx.fleetConfig;
        if (!config) { json(res, 500, { error: "No fleet config" }); return; }
        const ch = config.channel as Record<string, unknown> | undefined;
        // Update channel settings
        if (parsed.channel && ch) {
          if (parsed.channel.group_id != null) (config.channel as Record<string, unknown>).group_id = parsed.channel.group_id;
          if (parsed.channel.access) (config.channel as Record<string, unknown>).access = parsed.channel.access;
        }
        // Update defaults
        if (parsed.defaults) {
          const d = (config as Record<string, unknown>).defaults as Record<string, unknown>;
          if (parsed.defaults.backend) d.backend = parsed.defaults.backend;
          if (parsed.defaults.model) d.model = parsed.defaults.model;
        }
        // Update project_roots
        if (parsed.project_roots) {
          (config as Record<string, unknown>).project_roots = parsed.project_roots;
        }
        ctx.saveFleetConfig();
        const needsRestart = parsed.channel?.group_id != null;
        json(res, 200, { saved: true, needs_restart: needsRestart });
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  // Not handled
  json(res, 404, { error: "not found" });
  return true;
}

/** Handle POST /ui/send — extracted for readability. */
function handleSendMessage(req: IncomingMessage, res: ServerResponse, ctx: WebApiContext): void {
  let body = "";
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_TEXT * 2) {
      // Stop accumulating early on obviously oversized bodies.
      req.destroy();
      return;
    }
    body += chunk.toString();
  });
  req.on("end", async () => {
    try {
      const raw = JSON.parse(body);
      const parsed = SendMessageSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        json(res, 400, { error: `${issue.path.join(".") || "body"}: ${issue.message}` });
        return;
      }
      const { instance, message: typed, attachments = [] } = parsed.data;
      const ipc = ctx.instanceIpcClients.get(instance);
      if (!ipc) {
        json(res, 404, { error: `Instance not found: ${instance}` });
        return;
      }
      let files: UploadEntry[] = [];
      if (attachments.length > 0) {
        const taken = ctx.webFiles?.takeForMessage(instance, attachments);
        if (!taken || !taken.ok) { json(res, 400, { error: taken && !taken.ok ? taken.error : "files are not available here" }); return; }
        files = taken.entries;
      }
      // The same tags and meta a Telegram photo/document produces, so the agent needs nothing new.
      const delivery = attachmentDelivery(typed, files);
      const message = typed;
      const ts = new Date().toISOString();
      // Use real Telegram context so daemon's lastChatId/lastThreadId are set,
      // enabling reply tool even when first message comes from Web UI.
      // Pure Web UI mode (no channel config) leaves these empty — TODO: needs
      // a separate reply path for that case.
      const groupId = ctx.fleetConfig?.channel?.group_id;
      const topicId = ctx.fleetConfig?.instances[instance]?.topic_id;
      try {
        await ctx.deliverToInstance(instance, {
          type: "fleet_inbound",
          content: delivery.text,
          targetSession: instance,
          meta: {
            chat_id: groupId ? String(groupId) : "",
            message_id: `web-${Date.now()}`,
            user: "web-user", user_id: "web-user",
            ts,
            thread_id: topicId != null ? String(topicId) : "",
            source: "web",
            ...delivery.meta,
          },
        });
      } catch (err) {
        ctx.logger.error({ err, instance }, "Web message delivery failed");
        json(res, 503, { error: "Instance delivery failed" });
        return;
      }
      ctx.lastInboundUser.set(instance, "web-user");
      ctx.eventLog?.logActivity("message", "web-user", (message || `[${files.length} file(s)]`).slice(0, 200), instance);
      ctx.emitSseEvent("message", { instance, sender: "web-user", text: message, ts, attachments: files.map(publicAttachment) });
      // Sync to Telegram/Discord
      const syncAdapter = ctx.getAdapterForInstance?.(instance) ?? ctx.adapter;
      const syncGroupId = ctx.getGroupIdForInstance?.(instance) ?? String(ctx.fleetConfig?.channel?.group_id ?? "");
      if (syncAdapter && syncGroupId) {
        const topicId = ctx.fleetConfig?.instances[instance]?.topic_id;
        const preview = (message.length > 500 ? message.slice(0, 500) + " [...]" : message)
          + (files.length ? `${message ? " " : ""}[📎 ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map(f => f.name).join(", ")}]` : "");
        syncAdapter.sendText(
          syncGroupId,
          `🌐 web-user: ${preview}`,
          { threadId: topicId != null ? String(topicId) : undefined },
        ).catch(() => ctx.logger.debug({}, "Web→Channel sync failed"));
      }
      json(res, 200, { sent: true });
    } catch {
      json(res, 400, { error: "Invalid JSON" });
    }
  });
}

/**
 * One file for one instance's chat. The body is the file itself (Content-Type is ignored: the type is
 * read from the bytes), `X-Agend-Filename` its name for the label only. Stored in the instance's
 * workspace inbox under a name chosen here; answered with the id the message will name.
 */
function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext): void {
  const instance = url.searchParams.get("instance") ?? "";
  if (!ctx.webFiles) { json(res, 404, { error: "uploads are not available" }); return; }
  if (!instance || instance.length > 128 || !safeInstanceSegment(instance) || !ctx.instanceIpcClients.has(instance)) {
    json(res, 404, { error: `Instance not found: ${instance}` });
    return;
  }
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > UPLOAD_LIMITS.maxFileBytes) {
    json(res, 413, { error: `a file can be at most ${UPLOAD_LIMITS.maxFileBytes / 1024 / 1024} MB` });
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  req.on("data", (c: Buffer) => {
    if (refused) return;
    size += c.length;
    if (size > UPLOAD_LIMITS.maxFileBytes) {
      refused = true;
      json(res, 413, { error: `a file can be at most ${UPLOAD_LIMITS.maxFileBytes / 1024 / 1024} MB` });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("error", () => { /* the client went away */ });
  req.on("end", () => {
    if (refused) return;
    const bytes = Buffer.concat(chunks);
    const name = displayName(typeof req.headers["x-agend-filename"] === "string" ? req.headers["x-agend-filename"] : "", "file");
    const type = sniffUpload(bytes, name);
    if (!type) { json(res, 415, { error: "unsupported file type — images (PNG, JPEG, GIF, WebP), PDF and text files only" }); return; }
    try {
      const entry = ctx.webFiles!.storeUpload({ instance, inboxDir: join(getAgendHome(), "workspaces", instance, "inbox"), bytes, name, type });
      json(res, 200, publicAttachment(entry));
    } catch (err) {
      ctx.logger.error({ err: (err as Error).message, instance }, "Web upload could not be stored");
      json(res, 500, { error: "the file could not be stored" });
    }
  });
}
