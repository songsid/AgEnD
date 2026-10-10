import { binaryProbe } from "./binary-probe.js";
import type { SettingsExecution } from "./settings-transaction.js";
import type { PaneContextSource } from "./pane-context-cache.js";
import { settingsRequestExecution, settingsWrite, isSettingsReplay } from "./settings-request-capability.js";
import { readBoundedWebBody } from "./web-body.js";
import { gatewayRequestContext } from "./web-request-context.js";
import { permitWebContinuation } from "./web-continuation.js";
/**
 * Web UI HTTP API handler.
 * All /ui/* routes are handled here, extracted from fleet-manager.ts.
 */
import { formatWebChannelEcho } from "./web-channel-echo.js";
import type { SendOpts } from "./channel/types.js";
import { t } from "./locale.js";
import { isSafeInstanceName } from "./web-shell-routes.js";
import { MAX_COMMAND_ARGS } from "./web-commands.js";
import { sendPanelHtml } from "./web-host-guard.js";
import { shellRoute } from "./web-shell-routes.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LifecycleCreateArgs } from "./instance-lifecycle.js";
import { CreateInstanceArgs, validateArgs } from "./outbound-schemas.js";
import { readStatuslineModel, resolveInstanceContext } from "./topic-commands.js";
import { z } from "zod";
import { evaluateWebRequest, isPassiveWebRead, isSecureRequest, isWebRequestAuthorized, WEB_TOKEN_INVALID_MESSAGE, type WebGateRequest } from "./web-auth.js";
import type { PreviewAvailability } from "./web-preview.js";
import { newWebMessageId, parseLastEventId, type WebChatHistory } from "./web-chat-history.js";
import { attachmentDelivery, displayName, INLINE_MIME, isFileId, publicAttachment, sniffUpload, UPLOAD_LIMITS, wellFormed, type UploadEntry, type WebFileLedger } from "./web-upload.js";
import { getAgendHome } from "./paths.js";
import type { WebSessionStore } from "./web-session.js";
import { authorizeExplicitInstanceRemoval } from "./instance-removal.js";
import type { ExplicitInstanceRemoval } from "./instance-removal.js";
import { measureSyncWork } from "./sync-work-attribution.js";

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
    backend: z.enum(["claude-code", "codex", "opencode", "kiro-cli", "antigravity", "grok", "muse"]).optional(),
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
    web?: { echo_to_channel?: boolean };
    defaults?: { backend?: string; effort?: string };
    instances: Record<string, { topic_id?: number | string; working_directory: string; description?: string; display_name?: string; backend?: string }>;
    teams?: Record<string, { members: string[]; description?: string }>;
  } | null;
  readonly instanceIpcClients: Map<string, { send(msg: unknown): void }>;
  readonly adapter: { readonly id?: string; sendText(chatId: string, text: string, opts?: SendOpts): Promise<unknown> } | null;
  getAdapterForInstance?(name: string): { readonly id?: string; sendText(chatId: string, text: string, opts?: SendOpts): Promise<unknown> } | null;
  getGroupIdForInstance?(name: string): string;
  /** Reserve display ordering before IPC handoff, then settle delivery without waiting for the echo. */
  reserveWebChannelEcho?(name: string, sendEcho: () => Promise<unknown>): (accepted: boolean) => void;
  readonly daemons: Map<string, unknown>;
  readonly eventLog: { logActivity(event: string, sender: string, summary: string, receiver?: string, detail?: string): void; listActivity(opts?: { since?: string; limit?: number }): unknown[] } | null;
  readonly logger: { info(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  getInstanceDir(name: string): string;
  getInstanceStatus(name: string): "running" | "paused" | "stopped" | "crashed";
  /** A ClassicBot room (registered in classicBot.yaml, not fleet.yaml) — shown on the dashboard like any instance. */
  isClassicInstance?(name: string): boolean;
  /** #1523 N2: a ClassicBot room's own summary for Details (classicBot.yaml, not fleet.yaml), or null. */
  classicRoomFor?(name: string): { name: string; channel_id: string; adapter_id: string | null; backend: string; display_name: string | null; description: string | null } | null;
  /**
   * Post an owner web-chat echo to `instance`'s opted-in ClassicBot channels
   * (#1320 part B). Resolves the entries and adapters itself; returns how
   * many channels were posted to. Never rejects the web send on failure.
   */
  sendClassicWebEcho?(instance: string, text: string): Promise<number>;
  /** false: definitely not delivered (the instance's IPC is gone, or it was restarted meanwhile). */
  deliverToInstance(instanceName: string, payload: Record<string, unknown>): Promise<boolean | void>;
  getUiStatus(): unknown;
  /** Current owned pane reader shared with status; absent means context is unavailable. */
  getPaneContextSource?(name: string): PaneContextSource | null;
  /** #1306: which preview origin this /ui load may frame (Host and the TLS signal only); absent: previews off. */
  previewForUi?(hostHeader: string | undefined, secure: boolean): PreviewAvailability & { boot: string | null };
  emitSseEvent(event: string, data: unknown): void;
  /** The web chat's recent messages (history + SSE replay); absent in contexts that have no chat. */
  readonly webChatHistory?: WebChatHistory;
  /** Uploads and the files the dashboard may fetch back (web track C2); absent: no file routes. */
  readonly webFiles?: WebFileLedger;
  /** Absent means SSE_HEARTBEAT_MS; a test shortens it. */
  readonly sseHeartbeatMs?: number;
  startInstance(name: string, config: unknown, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<void>;
  /** The fleet prompts open on the dashboard (web track C4); absent: none are offered. */
  listWebPrompts?(): unknown[];
  /** #1386: everything waiting on the person, every world (the web is global). */
  needsYouItems?(): unknown[];
  /** #1389: the org chart's structure (fleet.yaml's teams, General, descriptions, thread links); absent: an empty chart. */
  orgChart?(): unknown;
  /** #1468: the prompt-cache expiry analysis for a window ("24h" | "7d" | "30d"); absent: not offered. */
  cacheReport?(window: string): Promise<unknown>;
  /** #1269: an instance's chat command from the web chat (web-commands.ts); absent: not offered. */
  webCommand?(input: { instance: string; command: string; args?: string; confirm?: string }, opts: { publicLink: boolean }): Promise<{ status: number; body: unknown }>;
  /** #1386: the web's Acknowledge of a delivery item; `principal` is "web:<session handle>" or "cli". */
  acknowledgeNeedsItem?(id: string, principal: string): { status: number; message: string };
  /** Answer one of them, exactly as a click on its platform button would. */
  clickWebPrompt?(instance: string, nonce: string, action: string): Promise<{ status: number; error?: string }>;
  /** #1266: a click on an agent reply's button. */
  clickWebReplyButton?(instance: string, id: string, index: number): Promise<{ status: number; error?: string }>;
  /** Interrupt the current reply and drop what was queued for it; false when the instance is not running. */
  cancelInstance?(name: string): boolean;
  restartSingleInstance(name: string, opts?: { explicit?: boolean }): Promise<void>;
  removeInstance(name: string, authorization: ExplicitInstanceRemoval, execution?: SettingsExecution): Promise<void>;
  lastInboundUser: Map<string, string>;
  saveFleetConfig(): void;
  readonly lifecycle: { handleCreate(args: LifecycleCreateArgs, respond: (result: unknown, error?: string) => void, adapterId?: string, execution?: SettingsExecution): Promise<void> };
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
async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await readBoundedWebBody(req, 512 * 1024)).toString("utf8"));
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
    const approved = isSettingsReplay(req) && method === "POST"
      && (path === "/ui/config" || path === "/ui/instances" || /^\/ui\/instances\/[^/]+\/delete$/.test(path))
      ? settingsRequestExecution(req) : undefined;
    if (approved) {
      try { approved.assert(); } catch { json(res, 409, { error: "settings_execution_stale" }); return true; }
    } else if (!isWebRequestAuthorized(req, url, ctx.webToken, ctx.webSessions, { touch: !isPassiveWebRead(method, path) })) {
      json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE });
      return true;
    }
  } else {
    return false;
  }

  // ── Static files ───────────────────────────────────────

  // #1408: the app shell, for exactly the paths the classifier names (src/web-shell-routes.ts). One page for every
  // route; the client router mounts the panel. A malformed instance name is a 400, an unknown one is the shell (the
  // panel says "not found"), so the response never tells which names exist.
  const shell = shellRoute(method, path);
  if (shell?.kind === "malformed") { json(res, 400, { error: "invalid instance name" }); return true; }
  if (shell?.kind === "shell") { serveAppShell(req, res, ctx, "full"); return true; }

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
      { name: "opencode", binary: "opencode" },
      { name: "kiro-cli", binary: "kiro-cli" },
      { name: "antigravity", binary: "agy" },
      { name: "grok", binary: "grok" },
      { name: "muse", binary: "muse" },
    ];
    // #1490: seven sequential 2 s `execFileSync("which")` calls used to block the event loop here. The shared probe
    // runs `which` as bounded async children and reuses an answer for BINARY_PROBE_TTL_MS. `unknown`: no answer in
    // time (shown as not installed, as the old timeout was).
    void Promise.all(BACKENDS.map(async (b) => {
      const found = await binaryProbe.probe(b.binary);
      const path = found.known ? found.path : null;
      return { name: b.name, binary: b.binary, installed: path !== null, path: path ?? "", deprecated: b.deprecated ?? false,
        ...(found.known ? {} : { unknown: true }) };
    })).then(
      (backends) => { if (!res.headersSent) json(res, 200, { backends }); },
      () => { if (!res.headersSent) json(res, 500, { error: "backend probe failed" }); },
    );
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
      // The ticks too, so polling never has to re-read a chat's history — that read would count as the person's
      // activity; this poll does not (isPassiveWebRead).
      deliveries: history ? history.deliveries() : [],
      // #1266: a reply's buttons that ended after the page saw the reply (the message itself is not sent again).
      reply_buttons: history ? history.buttonStates() : [],
      // And the fleet prompts open on the dashboard (C4): prompt events are stream-only too.
      prompts: ctx.listWebPrompts?.() ?? [],
      // #1386: "Needs you" rides the passive channels only — no endpoint of its own to poll.
      needs: ctx.needsYouItems?.() ?? [],
      cursor: history ? `${history.boot}-${history.lastId}` : null,
    });
    return true;
  }

  if (method === "GET" && path === "/ui/events") {
    if (gatewayRequestContext(req)) { json(res, 404, { error: "Use polling on the public link" }); return true; }
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
    // Ticks change messages already sent and carry no cursor: every (re)connect gets where each one is now, so a
    // report that fell into a gap is not lost until a reload (#1253 review). No id: it is not a message.
    if (ctx.webChatHistory) res.write(`event: deliveries\ndata: ${JSON.stringify(ctx.webChatHistory.deliveries())}\n\n`);
    // The same for the fleet prompts (C4): one posted, answered or expired during a gap is caught up here.
    if (ctx.listWebPrompts) res.write(`event: prompts\ndata: ${JSON.stringify(ctx.listWebPrompts())}\n\n`);
    // #1386: and "Needs you" as it is now; changes follow as `needs` events.
    if (ctx.needsYouItems) res.write(`event: needs\ndata: ${JSON.stringify({ items: ctx.needsYouItems() })}\n\n`);
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
        // Every open dashboard tab, every 10 s: the status of every instance, serialized on the fleet's loop (#1235).
        res.write(measureSyncWork("web.sseStatus", () => `event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`));
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
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(wellFormed(file.name))}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.writeHead(200);
    res.end(bytes);
    return true;
  }

  // ── Fleet prompts (C4): the hang / exit / interactive-prompt buttons, answerable here too ──

  if (method === "GET" && path === "/ui/prompts") {
    json(res, 200, { prompts: ctx.listWebPrompts?.() ?? [] });
    return true;
  }

  // The nonce is the capability, so it travels in the body: never in a URL a log or a history could keep.
  if (method === "POST" && path === "/ui/prompt") {
    if (!ctx.clickWebPrompt) { json(res, 404, { error: "No prompts here" }); return true; }
    const click = ctx.clickWebPrompt.bind(ctx);
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      if (!body || typeof body !== "object") { json(res, 400, { error: "instance, nonce and action required" }); return; }
      const { instance, nonce, action } = body;
      if (typeof instance !== "string" || typeof nonce !== "string" || typeof action !== "string") {
        json(res, 400, { error: "instance, nonce and action required" });
        return;
      }
      const r = await click(instance, nonce, action);
      // 409: answered elsewhere first, expired, or never open — the page drops the buttons on `gone`.
      json(res, r.status, r.status === 200 ? { answered: true } : { error: r.error ?? "Refused", ...(r.status === 409 ? { gone: true } : {}) });
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Web prompt answer failed");
      try { json(res, 500, { error: "Prompt answer failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #1266: a click on an agent reply's button. The set id travels in the body; the public link may click too (a click
  // is a message, and the public link may send messages).
  if (method === "POST" && path === "/ui/reply-button") {
    if (!ctx.clickWebReplyButton) { json(res, 404, { error: "No buttons here" }); return true; }
    const click = ctx.clickWebReplyButton.bind(ctx);
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const { instance, id, index } = (body ?? {}) as Record<string, unknown>;
      if (typeof instance !== "string" || typeof id !== "string" || typeof index !== "number") {
        json(res, 400, { error: "instance, id and index required" });
        return;
      }
      const r = await click(instance, id, index);
      json(res, r.status, r.status === 200 ? { answered: true } : { error: r.error ?? "Refused", ...(r.status === 409 ? { gone: true } : {}) });
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Web reply-button click failed");
      try { json(res, 500, { error: "Click failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #1386: Acknowledge a "Needs you" delivery item — a session write (CSRF, checked by the gate) or the CLI's header
  // token. Who did it is recorded by principal: the session's public handle, never the session id or a credential.
  if (method === "POST" && path === "/ui/needs/ack") {
    if (!ctx.acknowledgeNeedsItem) { json(res, 404, { error: "Nothing to acknowledge here" }); return true; }
    const acknowledge = ctx.acknowledgeNeedsItem.bind(ctx);
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const id = body && typeof body === "object" ? body.id : undefined;
      if (typeof id !== "string") { json(res, 400, { error: "id required" }); return; }
      const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
      if (verdict.kind !== "allow") { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
      const principal = verdict.via === "session" && verdict.session ? `web:${verdict.session.handle}` : "cli";
      const r = acknowledge(id, principal);
      json(res, r.status, r.status === 200 ? { acknowledged: true, message: r.message } : { error: r.message });
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Needs you acknowledge failed");
      try { json(res, 500, { error: "Acknowledge failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #1269: an instance's chat command (/ctx, /compact, /clear, /model, …) — a session write (CSRF, checked by the
  // gate), run through the platforms' own handlers and command table. The public link is told it is one (/save is
  // refused there).
  if (method === "POST" && path === "/ui/command") {
    if (!ctx.webCommand) { json(res, 404, { error: "Not available" }); return true; }
    const run = ctx.webCommand.bind(ctx);
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
      const instance = str(body?.instance, 128), command = str(body?.command, 32);
      if (!instance || !isSafeInstanceName(instance) || !command) { json(res, 400, { error: "instance and command required" }); return; }
      if (body.args !== undefined && str(body.args, MAX_COMMAND_ARGS) === undefined) { json(res, 400, { error: "args too long" }); return; }
      if (body.confirm !== undefined && !(typeof body.confirm === "string" && /^[0-9a-f]{32}$/.test(body.confirm))) { json(res, 400, { error: "invalid confirmation" }); return; }
      const r = await run({ instance, command, args: str(body.args, MAX_COMMAND_ARGS), confirm: body.confirm as string | undefined }, { publicLink: !!gatewayRequestContext(req) });
      json(res, r.status, r.body);
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Web command failed");
      try { json(res, 500, { error: "Command failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // ── Instance operations ────────────────────────────────

  // Stop the agent's current reply — what Telegram's cancel button and /cancel do: Esc into the CLI, and the
  // messages still waiting for it are dropped. Not /ui/stop, which stops the instance's process.
  const cancelMatch = path.match(/^\/ui\/cancel\/([^/]+)$/);
  if (method === "POST" && cancelMatch) {
    let name: string;
    try { name = decodeURIComponent(cancelMatch[1]!); } catch { json(res, 400, { error: "Bad instance name" }); return true; }
    // Own keys only: "constructor" is in every object and names no instance.
    const known = (ctx.fleetConfig ? Object.hasOwn(ctx.fleetConfig.instances, name) : false) || ctx.daemons.has(name);
    if (!ctx.cancelInstance || !known) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    if (!ctx.cancelInstance(name)) { json(res, 409, { error: `${name} is not running` }); return true; }
    ctx.eventLog?.logActivity("cancel", "web-user", "stop the current reply", name);
    json(res, 200, { cancelled: name });
    return true;
  }

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
        if (!permitWebContinuation(req, res, ctx)) return;
        if (body.confirm !== `delete ${name}`) {
          json(res, 400, { error: `Confirmation required: { "confirm": "delete ${name}" }` });
          return;
        }
        const execution = settingsRequestExecution(req);
        if (execution) await ctx.removeInstance(name, authorizeExplicitInstanceRemoval("dashboard-confirmed"), execution);
        else await ctx.removeInstance(name, authorizeExplicitInstanceRemoval("dashboard-confirmed"));
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
    // An own key only: an inherited name ("constructor") is no instance. #1523 N2: a ClassicBot room is one too — its
    // own summary (classicBot.yaml), never read as a fleet.yaml agent.
    const instances = ctx.fleetConfig?.instances ?? {};
    const fleetConfig = Object.prototype.hasOwnProperty.call(instances, name) ? instances[name] : undefined;
    const room = fleetConfig ? null : ctx.classicRoomFor?.(name) ?? null;
    if (!fleetConfig && !room) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const config = fleetConfig ?? { working_directory: "", backend: room!.backend, display_name: room!.display_name ?? undefined, description: room!.description ?? undefined };
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
    const { context } = resolveInstanceContext(ctx.dataDir, name, backend, { source: ctx.getPaneContextSource?.(name) });
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

    // The instance's other fleet.yaml fields this read shows (the context's type names only the ones it always needed).
    const more = config as { tags?: unknown; channel_id?: unknown; general_topic?: unknown };
    // Where it is bound, as the fleet resolves it (getInstanceAdapterId): no channel_id means the first connection —
    // "web only" only when the fleet has none (#1561 review).
    const fc = ctx.fleetConfig as { channels?: Array<{ id?: string; type?: string }>; channel?: { id?: string; type?: string } } | undefined;
    const connections = fc?.channels ?? (fc?.channel ? [fc.channel] : []);
    const first = connections[0] ? (connections[0].id ?? connections[0].type ?? null) : null;
    const explicit = typeof more.channel_id === "string" ? more.channel_id : null;
    json(res, 200, {
      name,
      status: ctx.getInstanceStatus(name),
      description: config.description,
      display_name: config.display_name,
      working_directory: room ? null : config.working_directory,
      // #1523 N2 (Q1 = B): the read-only config summary on Details — tags and where it is bound. Nothing secret.
      kind: room ? "classic" : "agent",
      tags: room ? ["classic"] : Array.isArray(more.tags) ? more.tags.filter((x: unknown): x is string => typeof x === "string") : [],
      binding: room ? null : {
        channel_id: explicit ?? first,
        implicit: explicit === null && first !== null,      // bound to the first connection by default
        topic_id: config.topic_id != null ? String(config.topic_id) : null,
        general_topic: more.general_topic === true,
      },
      ...(room ? { room: { name: room.name, channel_id: room.channel_id, adapter_id: room.adapter_id } } : {}),
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
        if (!permitWebContinuation(req, res, ctx)) return;
        const v = validateArgs(CreateInstanceArgs, body, "create_instance");
        if (!v.ok) { json(res, 400, { error: v.error }); return; }
        let result: unknown = null;
        let error: string | undefined;
        const respond = (r: unknown, e?: string): void => { result = r; error = e; };
        const execution = settingsRequestExecution(req);
        if (execution) await ctx.lifecycle.handleCreate(v.data, respond, undefined, execution);
        else await ctx.lifecycle.handleCreate(v.data, respond);
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
        if (!permitWebContinuation(req, res, ctx)) return;
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
        if (!permitWebContinuation(req, res, ctx)) return;
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
        if (!permitWebContinuation(req, res, ctx)) return;
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

  // #1468: the prompt-cache expiry analysis. Opening it is a person's navigation, like any Fleet tab (it counts as
  // use); the page never re-reads it on a timer. Answered from the ledgers as they are; a catch-up runs behind.
  if (method === "GET" && path === "/ui/cache") {
    if (!ctx.cacheReport) { json(res, 404, { error: "Not available" }); return true; }
    ctx.cacheReport(url.searchParams.get("window") ?? "7d").then(
      (report) => json(res, 200, report),
      (err) => { ctx.logger.error({ err }, "cache analysis failed"); json(res, 500, { error: "Cache analysis failed" }); },
    );
    return true;
  }

  // ── Teams ──────────────────────────────────────────────

  // #1389: the org chart. Opening it is a person's navigation (it counts as use, like a Fleet tab); nothing re-reads
  // it on a timer — the live state comes over the stream the page already has.
  if (method === "GET" && path === "/ui/org") {
    json(res, 200, ctx.orgChart?.() ?? { general: [], teams: [], instances: {} });
    return true;
  }

  if (method === "GET" && path === "/ui/teams") {
    const teams = ctx.fleetConfig?.teams ?? {};
    json(res, 200, { teams });
    return true;
  }

  if (method === "POST" && path === "/ui/teams") {
    (async () => {
      try {
        const body = await parseBody(req);
        if (!permitWebContinuation(req, res, ctx)) return;
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
        if (!permitWebContinuation(req, res, ctx)) return;
        const parsed = parseOrReject(ConfigUpdateSchema, body, res);
        if (!parsed) return;
        const config = ctx.fleetConfig;
        if (!config) { json(res, 500, { error: "No fleet config" }); return; }
        const ch = config.channel as Record<string, unknown> | undefined;
        settingsWrite(req, () => {
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
        });
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

/** Keep the echo in a single platform message, including its attachment names. */
function webEchoPreview(message: string, names: string[]): string {
  const text = wellFormed(message.slice(0, 500));
  const files = names.length ? `[📎 ${names.map(name => displayName(name, "attachment")).join(", ")}]` : "";
  const preview = [text, files].filter(Boolean).join(" ");
  const truncated = message.length > 500 || preview.length > 1400;
  return wellFormed(preview.slice(0, 1400)) + (truncated ? ` … (${t("web.echo_full_text")})` : "");
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
      if (!permitWebContinuation(req, res, ctx)) return;
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
      // #1269: `/raw ` is pasted into the CLI with no [user:] envelope (the daemon's own check, on this exact text).
      // A signed-in local session may do that, as a fleet admin on the platform may; the public link — the outward-
      // facing surface — may not.
      if (gatewayRequestContext(req) && delivery.text.startsWith("/raw ")) {
        ctx.webFiles?.release(files);
        json(res, 403, { error: t("web.raw_public_refused") });
        return;
      }
      const message = typed;
      const ts = new Date().toISOString();
      // The id the agent is given, and the one its delivery reports come back under: the page's ticks.
      const messageId = newWebMessageId();
      // Use real Telegram context so daemon's lastChatId/lastThreadId are set,
      // enabling reply tool even when first message comes from Web UI.
      // Pure Web UI mode (no channel config) leaves these empty; the agent's reply then comes back to the
      // web chat alone (FleetManager's web-only reply sink).
      const syncAdapter = ctx.getAdapterForInstance ? ctx.getAdapterForInstance(instance) : ctx.adapter;
      const groupId = ctx.getGroupIdForInstance?.(instance) ?? String(ctx.fleetConfig?.channel?.group_id ?? "");
      const topicId = ctx.fleetConfig?.instances[instance]?.topic_id;
      const canEcho = ctx.fleetConfig?.web?.echo_to_channel !== false
        && !ctx.isClassicInstance?.(instance) && syncAdapter && groupId && topicId != null;
      // Add no runtime credentials or local attachment paths to the display copy.
      const preview = webEchoPreview(message, files.map(f => f.name));
      // ClassicBot echo (#1320 part B): same ordering lane, per-entry
      // opt-in resolved at send time inside sendClassicWebEcho.
      const canClassicEcho = ctx.isClassicInstance?.(instance) === true && !!ctx.sendClassicWebEcho;
      const settleClassicEcho = canClassicEcho ? ctx.reserveWebChannelEcho?.(instance, async () => {
        await ctx.sendClassicWebEcho!(instance, formatWebChannelEcho("web-user", preview, t("web.echo_full_text")));
      }) : undefined;
      const settleEcho = canEcho ? ctx.reserveWebChannelEcho?.(instance, async () => {
        // A replacement adapter or edited binding is not the route we reserved.
        if ((ctx.getAdapterForInstance ? ctx.getAdapterForInstance(instance) : ctx.adapter) !== syncAdapter
          || (ctx.getGroupIdForInstance?.(instance) ?? String(ctx.fleetConfig?.channel?.group_id ?? "")) !== groupId
          || ctx.fleetConfig?.instances[instance]?.topic_id !== topicId) return;
        return syncAdapter.sendText(String(groupId), formatWebChannelEcho("web-user", preview, t("web.echo_full_text")), { threadId: String(topicId), format: "text", allowedMentions: { parse: [] } });
      }) : undefined;
      let delivered: boolean | void;
      try {
        delivered = await ctx.deliverToInstance(instance, {
          type: "fleet_inbound",
          content: delivery.text,
          targetSession: instance,
          meta: {
            chat_id: groupId ? String(groupId) : "",
            message_id: messageId,
            user: "web-user", user_id: "web-user",
            ts,
            thread_id: topicId != null ? String(topicId) : "",
            source: "web",
            adapter_id: syncAdapter?.id,
            ...delivery.meta,
          },
        });
      } catch (err) {
        settleEcho?.(false);
        // A throw must release the Classic ordering lane too: otherwise the
        // next accepted echo queues behind a reservation that never settles
        // and is dropped by expiry (#1330 R2).
        settleClassicEcho?.(false);
        ctx.webFiles?.release(files);                  // not delivered: the same ids can be sent again
        ctx.logger.error({ err, instance }, "Web message delivery failed");
        json(res, 503, { error: "Instance delivery failed" });
        return;
      }
      if (delivered === false) {
        settleEcho?.(false);
        settleClassicEcho?.(false);
        ctx.webFiles?.release(files);
        ctx.logger.error({ instance }, "Web message not delivered (the instance went away or restarted)");
        json(res, 503, { error: "Instance delivery failed" });
        return;
      }
      settleEcho?.(true);
      settleClassicEcho?.(true);
      ctx.webFiles?.commit(files);
      ctx.lastInboundUser.set(instance, "web-user");
      ctx.eventLog?.logActivity("message", "web-user", (message || `[${files.length} file(s)]`).slice(0, 200), instance);
      ctx.emitSseEvent("message", { instance, sender: "web-user", role: "user", text: message, ts, attachments: files.map(publicAttachment), messageId });
      json(res, 200, { sent: true, messageId });
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
      if (!permitWebContinuation(req, res, ctx)) return;
    if (refused) return;
    const bytes = Buffer.concat(chunks);
    const name = displayName(typeof req.headers["x-agend-filename"] === "string" ? req.headers["x-agend-filename"] : "", "file");
    const type = sniffUpload(bytes, name);
    if (!type) { json(res, 415, { error: "unsupported file type — images (PNG, JPEG, GIF, WebP), PDF and text files only" }); return; }
    // The instance is checked again now the whole body is here: it may have been deleted (and its files
    // forgotten) or stopped while the upload streamed in; storing now would bring its id back (#1252 review).
    // Still deliverable means: its IPC is up (a paused one is woken by the send) and it is still registered —
    // in fleet.yaml, or as a ClassicBot room in classicBot.yaml.
    const registered = !!ctx.fleetConfig?.instances?.[instance] || ctx.isClassicInstance?.(instance) === true;
    if (!ctx.instanceIpcClients.has(instance) || !registered) {
      json(res, 404, { error: `Instance not found: ${instance}` });
      return;
    }
    try {
      const entry = ctx.webFiles!.storeUpload({ instance, inboxDir: join(getAgendHome(), "workspaces", instance, "inbox"), bytes, name, type });
      json(res, 200, publicAttachment(entry));
    } catch (err) {
      ctx.logger.error({ err: (err as Error).message, instance }, "Web upload could not be stored");
      json(res, 500, { error: "the file could not be stored" });
    }
  });
}

// ── #1408: what the server tells the app shell on its <body> ──
// One function for every entry, so arriving at /ui/fleet or /view and then opening a chat is the same as arriving at
// /ui. The mode decides what the page may do (§3):
// - "full", signed in: a local session gets the live stream (with polling while it is down); the public link polls from
//   the start (its manifest has no /ui/events). #1306: the origin the server believes it is at, the preview origin
//   chosen for this load (empty: previews off, with the reason) and the preview listener's boot id; the public link
//   has no previews.
// - "view-only": an anonymous reader of /view under `web.view_access: open`. No stream, no previews, no session-only
//   panel: the page shows View and a way to sign in, nothing else.
export interface AppShellContext {
  previewForUi?(hostHeader: string | undefined, secure: boolean): (PreviewAvailability & { boot: string | null }) | null;
}
export type AppShellMode = "full" | "view-only";

function shellPreview(req: IncomingMessage, ctx: AppShellContext, mode: AppShellMode) {
  if (mode !== "full" || gatewayRequestContext(req)) return null;
  return ctx.previewForUi?.(typeof req.headers.host === "string" ? req.headers.host : undefined, isSecureRequest(req)) ?? null;
}
function shellBodyTag(req: IncomingMessage, ctx: AppShellContext, mode: AppShellMode): string {
  const p = shellPreview(req, ctx, mode);
  const attr = (v: string | null | undefined) => String(v ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `<body data-mode="${mode}"${mode === "full" && gatewayRequestContext(req) ? ' data-web-transport="poll"' : ""} data-dashboard-origin="${attr(p?.dashboardOrigin)}" data-preview-origin="${attr(p?.previewOrigin)}"`
    + ` data-preview-boot="${attr(p?.previewOrigin ? p.boot : "")}" data-preview-reason="${attr(p ? p.reason : "Previews are not available on this fleet.")}"`
    // #1554: no availability asked (the public link, or not the full app) still says why, in the page's language.
    + ` data-preview-reason-code="${attr(p ? p.code ?? "" : gatewayRequestContext(req) ? "publicLink" : "notOffered")}">`;
}
/** The app shell page for one entry, under the panels' CSP; it may frame exactly <preview origin>/frame, and only
 *  when this load chose one. */
export function serveAppShell(req: IncomingMessage, res: ServerResponse, ctx: AppShellContext, mode: AppShellMode): void {
  try {
    const html = readFileSync(join(__dirname, "ui", "app.html"), "utf-8");
    const p = shellPreview(req, ctx, mode);
    sendPanelHtml(res, html.replace("<body>", shellBodyTag(req, ctx, mode)), 200, {}, p?.previewOrigin ? { frameSrc: `${p.previewOrigin}/frame` } : {});
  } catch {
    json(res, 500, { error: "app.html not found" });
  }
}
