import { webHumanOrigin, type HumanOrigin } from "./human-delivery-receipts.js";
import { classifyWebPeer, confirmAfterBody, noAuthority, type HumanAuthority, type WebAuthorityResult, type WebPeer } from "./authority/web-authority.js";
import { guestChatRefusal, guestCommandText, guestDeliveries, guestFrameData, guestHistory, guestMessages, guestPollBody, guestPrefs, guestRequestOf, guestSeesMessage, guestStatus, type GuestRequest } from "./web-guest-access.js";
import { withSpawnHoldReply } from "./spawn-hold-reply.js";
import { binaryProbe } from "./binary-probe.js";
import type { CachedImage } from "./web-images.js";
import type { SettingsExecution } from "./settings-transaction.js";
import type { PaneContextSource } from "./pane-context-cache.js";
import { settingsRequestExecution, settingsWrite, isSettingsReplay } from "./settings-request-capability.js";
import { readBoundedWebBody } from "./web-body.js";
import type { OwnerCssStore } from "./web-owner-css-store.js";
import type { ModStore } from "./web-mod-store.js";
import { MOD_MAX_BYTES } from "./web-mod-bundle.js";
import { buildModBundle, type ModExportParts } from "./web-mod-export.js";
import { AGENT_WIDGET_SLOTS, checkWidgetData, checkWidgetSpec } from "./web-widget.js";
import { checkOwnerCss, ownerCssAssetRefs } from "./web-owner-css.js";
import { canonicalText } from "./web-theme.js";
import type { WebEffectService } from "./web-effect-service.js";
import type { EffectTrialActor } from "./web-effect-trials.js";
import { EFFECT_WIRE_LIMIT } from "./web-effect-upload.js";
import type { ThemeStore } from "./web-theme-store.js";
import type { WebAppearance } from "./web-appearance.js";
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
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LifecycleCreateArgs } from "./instance-lifecycle.js";
import { CreateInstanceArgs, CreateScheduleArgs, UpdateScheduleArgs, validateArgs } from "./outbound-schemas.js";
import { scheduleView } from "./web-schedules.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { Schedule, ScheduleRetry } from "./scheduler/types.js";
import { readStatuslineModel, resolveInstanceContext } from "./topic-commands.js";
import { z } from "zod";
import { evaluateWebRequest, isPassiveWebRead, isSecureRequest, isWebRequestAuthorized, WEB_TOKEN_INVALID_MESSAGE, type WebGateRequest } from "./web-auth.js";
import { dashboardOriginFor, type PreviewAvailability } from "./web-preview.js";
import { newWebMessageId, parseLastEventId, type WebChatHistory } from "./web-chat-history.js";
import { attachmentDelivery, createPartFile, displayName, fileTooLargeText, INLINE_MIME, isFileId, MEDIA_RANGE_MAX, publicAttachment, removeQuietly, UPLOAD_LIMITS, UPLOAD_MAX_MS, UPLOAD_STALL_MS, UploadSniffer, uploadLimits, wellFormed, type ServedFile, type UploadEntry, type WebFileLedger } from "./web-upload.js";
import { getAgendHome } from "./paths.js";
import type { WebSessionStore, SessionRecord } from "./web-session.js";
import { OPERATOR, isOwnerEffectKey, type WebPrefsStore } from "./web-prefs.js";
import { WEB_NAME_FALLBACK, type WebAccount, webPersonKey } from "./web-profile.js";
import { commitTeamCreate, commitTeamUpdate } from "./outbound-handlers.js";
import { parseMentionQuery, type MentionNames, type MentionQuery } from "./web-mentions.js";
import { authorizeExplicitInstanceRemoval } from "./instance-removal.js";
import type { ExplicitInstanceRemoval } from "./instance-removal.js";
import { measureSyncWork } from "./sync-work-attribution.js";
import { resolveTz } from "./tz-utils.js";
import { filesPlayInChat } from "./web-effect.js";

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

const TeamCreateSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  members: z.array(z.string().min(1).max(256)).min(1).max(256),
  description: z.string().max(MAX_TEXT).optional(),
}).strict();

// #1689: an edit of a team — its members as they should be, and its description ("" clears it). No name: a team is
// not renamed.
const TeamEditSchema = z.object({
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
/** #1920 phase 1b: the open streams that are a guest's, and whose — each event is projected for them (guestFrameData). */
const streamGuests = new WeakMap<ServerResponse, GuestRequest>();

/**
 * #1920 §5.2: one event for the guests' streams only, each as projected for it — a message that has just become what
 * its channel saw (an admin's page already has it, unchanged).
 */
export function broadcastToGuests(clients: Set<ServerResponse>, event: string, data: unknown, onError?: (err: unknown) => void): void {
  const guests = [...clients].filter((c) => streamGuests.has(c));
  if (!guests.length) return;
  const live = new Set(guests);
  broadcastSseEvent(live, event, data, onError);
  for (const c of guests) if (!live.has(c)) clients.delete(c);     // the ones it ended (their session went)
}

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
      // An admin's stream gets these bytes; a guest's, the event as projected for its scope now, or nothing (no id: it
      // never replays chat, so a cursor of the admin's stream is not its to hold).
      const guest = streamGuests.get(client);
      if (guest) {
        // The exact session that opened it ended (revoked, expired, rotated away): nothing more, and the stream goes.
        if (!guest.current()) { dead.push(client); continue; }
        const shown = guestFrameData(event, data, guest.scope(), guest);
        if (shown !== undefined) client.write(sseFrame(event, shown));
        continue;
      }
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
  /** #2072: what this host can run (the published snapshot); absent in a hand-built context. */
  backendAvailabilityRows?(): import("./backend-availability.js").BackendAvailability[];
  /** #2072: a backend's cached model catalog, for an instance's own account when one is named; never a probe. */
  modelCatalogFor?(backend: string, instance: string | null): Array<{ id: string; label: string; description?: string }>;
  /** Absent in a hand-built context: cookies are then simply not a credential, the header token still is. */
  readonly webSessions?: WebSessionStore | null;
  readonly dataDir: string;
  readonly sseClients: Set<ServerResponse>;
  readonly fleetConfig: {
    channel?: { group_id?: number | string; mode?: string };
    web?: { echo_to_channel?: boolean; usage_panel?: boolean; usage_report_on_public_link?: boolean; upload_max_file_mb?: number; upload_max_total_mb?: number };
    defaults?: { backend?: string; effort?: string };
    instances: Record<string, { topic_id?: number | string; working_directory: string; description?: string; display_name?: string; backend?: string }>;
    teams?: Record<string, { members: string[]; description?: string }>;
  } | null;
  readonly instanceIpcClients: Map<string, { send(msg: unknown): void }>;
  readonly adapter: { readonly id?: string; sendText(chatId: string, text: string, opts?: SendOpts): Promise<unknown> } | null;
  getAdapterForInstance?(name: string): { readonly id?: string; sendText(chatId: string, text: string, opts?: SendOpts): Promise<unknown> } | null;
  getGroupIdForInstance?(name: string): string;
  /** Reserve display ordering before IPC handoff, then settle delivery without waiting for the echo. */
  reserveWebChannelEcho?(name: string, sendEcho: () => Promise<unknown>, opts?: { copy?: boolean }): (accepted: boolean) => void;
  /** #1666: the cancel/progress bubble a platform inbound starts, posted in the instance's topic. */
  startWebChatProgress?(name: string): Promise<void>;
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
  sendClassicWebEcho?(instance: string, text: string, sender?: string): Promise<number>;
  /** #1920 §5.2: a web message's channel copy was sent — guests of that channel may see it now. */
  webMessageInChannel?(instance: string, messageId: string): void;
  /** false: definitely not delivered (the instance's IPC is gone, or it was restarted meanwhile). */
  deliverToInstance(instanceName: string, payload: Record<string, unknown>): Promise<boolean | void>;
  deliverHumanToInstance?(instanceName: string, payload: Record<string, unknown>, origin: HumanOrigin, originalBody: string): Promise<boolean | void>;
  getUiStatus(): unknown;
  /** Current owned pane reader shared with status; absent means context is unavailable. */
  getPaneContextSource?(name: string): PaneContextSource | null;
  /** #1306: which preview origin this /ui load may frame (Host and the TLS signal only); absent: previews off. */
  readonly effectBoot?: string;
  previewForUi?(hostHeader: string | undefined, secure: boolean): PreviewAvailability & { boot: string | null };
  /** #1723: the same for a page of the public link (exposure `exposureId`, at `dashboardOrigin`); absent: none there. */
  publicPreviewForUi?(exposureId: string, dashboardOrigin: string): PublicPreviewForUi;
  emitSseEvent(event: string, data: unknown): void;
  /** The web chat's recent messages (history + SSE replay); absent in contexts that have no chat. */
  readonly webChatHistory?: WebChatHistory;
  /** Uploads and the files the dashboard may fetch back (web track C2); absent: no file routes. */
  readonly webFiles?: WebFileLedger;
  /** #1630: a cached avatar (an own bot's, or the picture uploaded in View) — never a fetch; null when there is none. */
  webImage?(kind: "bot" | "avatar", key: string): CachedImage | null;
  /** #1630: one Discord server emoji of the fleet's bots, from the host cache (fetched once); null for any other id. */
  webEmoji?(id: string): Promise<CachedImage | null>;
  /** #1682: names for mention ids (only those asked; from memory, never a request); absent: no names. */
  webMentionNames?(query: MentionQuery): MentionNames;
  /** #1630: the custom emoji of the servers the fleet's Discord bots are in. */
  webEmojiList?(): Promise<Array<{ id: string; name: string; animated: boolean }>>;
  /** Absent means SSE_HEARTBEAT_MS; a test shortens it. */
  readonly sseHeartbeatMs?: number;
  /** #1665: the web preferences kept on the host (one bucket: the operator's); absent: /ui/prefs is not offered. */
  readonly webPrefs?: WebPrefsStore;
  /** #1629 r4 §3: each person's own CSS (human sessions only; never the public link, never an agent). */
  readonly ownerCss?: OwnerCssStore;
  /** #1629: every instance's theme (web-themes.json), read by the page; a person's reset and lock. */
  readonly themeStore?: ThemeStore;
  readonly webAppearance?: WebAppearance;
  /** #1629 r4-5: installed mods and a person's staged import. */
  readonly mods?: ModStore;
  /** #1629 B2: session-only effect library, runtime resources and reported host profiles. */
  readonly effectService?: WebEffectService;
  /** #1629 r4-5: an instance's card text as shown (a person's fields over the agent's), for a mod's export. */
  modCardText?(name: string): { tagline?: string; bio?: string };
  /** #1629 r4-5c: an effect this person may export (their own claim, or human-shared); null for anyone else's. */
  modPlacedEffect?(person: string, id: string): { name: string; files: ReadonlyMap<string, Uint8Array> } | null;
  /** A fleet.yaml instance (own key) or a ClassicBot room, now. */
  isKnownInstance?(name: string): boolean;
  startInstance(name: string, config: unknown, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<{ backgroundWorkEnded: boolean }>;
  /** The fleet prompts open on the dashboard (web track C4); absent: none are offered. */
  listWebPrompts?(): unknown[];
  /** #1386: everything waiting on the person, every world (the web is global). */
  needsYouItems?(): unknown[];
  /** #1389: the org chart's structure (fleet.yaml's teams, General, descriptions, thread links); absent: an empty chart. */
  orgChart?(): unknown;
  /** #1918: in-flight and recently finished cross-instance traffic, bounded (fleet-traffic.ts). */
  trafficSnapshot?(): { now: string; items: unknown[] };
  /** #1218: an instance's Log steps, read on demand (null: no such instance; `{ enabled: false }`: the Log is off). */
  logSteps?(name: string, q: import("./log-service.js").LogQuery): Promise<unknown>;
  /** #1468: the prompt-cache expiry analysis for a window ("24h" | "7d" | "30d"); absent: not offered. */
  cacheReport?(window: string): Promise<unknown>;
  /** #2122: the usage report (Fleet → Usage); absent: not offered. */
  usageReport?(params: { range: import("./usage-report.js").UsageRange; group: import("./usage-report.js").UsageGroup }): Promise<unknown>;
  /** #1269: an instance's chat command from the web chat (web-commands.ts); absent: not offered. */
  webCommand?(input: { instance: string; command: string; args?: string; confirm?: string }, opts: { publicLink: boolean; person?: WebPerson; authority?: HumanAuthority }): Promise<{ status: number; body: unknown }>;
  /** #1939 S2b: "Authorize this browser" — the Confirm card in the account's DM; and what the app shows for this browser. */
  requestSessionAuthorization?(input: { session: SessionRecord | null; gateway: boolean; peer: WebPeer }): Promise<{ ok: true; expiresInMs: number } | { ok: false; refusal: string; retryAfterMs?: number }>;
  webSessionAuthorization?(input: { session: SessionRecord | null; gateway: boolean; peer: WebPeer }): { state: string; until?: number; expiresInMs?: number; reason?: string };
  /** #1939 S1: the design's §3 for one request (`instance` once the body names it); absent: web carries no authority. */
  webAuthority?(input: { session: SessionRecord | null; gateway: boolean; peer: WebPeer; instance?: string }): WebAuthorityResult;
  /**
   * #1827: a web person — for the account a session is bound to (none: the operator) — as agents and chats see them.
   * Absent: everyone is "web-user", as before.
   */
  webPerson?(owner?: WebAccount): WebPerson;
  /** #1827: set (or, with null, clear) a person's own name; refused with a reason. */
  setWebPersonName?(owner: WebAccount | undefined, raw: unknown): { ok: true; person: WebPerson } | { ok: false; status: number; error: string };
  /** #1386: the web's Acknowledge of a delivery item; `principal` is "web:<session handle>" or "cli". */
  acknowledgeNeedsItem?(id: string, principal: string): { status: number; message: string };
  /** Answer one of them, exactly as a click on its platform button would. */
  clickWebPrompt?(instance: string, nonce: string, action: string): Promise<{ status: number; error?: string }>;
  /** #1266: a click on an agent reply's button. */
  clickWebReplyButton?(instance: string, id: string, index: number, voter?: { key: string; userId: string; name: string; guest?: true; authority?: HumanAuthority }): Promise<{ status: number; error?: string; options?: number[] }>;
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
    /** #1724: the update MCP update_schedule makes (cron and at clear each other). */
    update?(id: string, params: Record<string, unknown>): unknown;
    /** #1426: a pending retry of a schedule's occurrence, for the row's "retrying". */
    getRetry?(id: string): unknown;
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
 * #1630 (#1635 review): an answer that waited on something (a list, a download) is sent only if the request is still
 * allowed — the session not revoked meanwhile, a public link's exposure still current. Otherwise 401, and nothing.
 */
function stillAuthorized(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext): boolean {
  if (!permitWebContinuation(req, res, ctx)) return false;
  if (isWebRequestAuthorized(req, url, ctx.webToken, ctx.webSessions, { touch: false })) return true;
  json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE });
  return false;
}

/**
 * #1629 r4 §3: the owner-CSS routes (see their call site). `who()`, asked first and again after any body: the person a
 * signed-in human session is, or the status to answer.
 */
function handleOwnerCss(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  const store = ctx.ownerCss;
  if (!store) { json(res, 404, { error: "Owner CSS is not kept on this fleet" }); return true; }
  const reading = method === "GET" || method === "HEAD";
  if (gatewayRequestContext(req)) { json(res, reading ? 404 : 403, { error: "owner_css_not_over_public_link" }); return true; }
  const who = (): { person: string } | { status: number; error: string } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401, error: WEB_TOKEN_INVALID_MESSAGE };
    if (verdict.via !== "session" || !verdict.session) return { status: 403, error: "owner_css_needs_a_signed_in_person" };
    if (!reading && verdict.session.tier !== "admin") return { status: 403, error: "owner_css_read_only" };
    return { person: webPersonKey(verdict.session.owner) };
  };
  const first = who();
  if ("status" in first) { json(res, first.status, { error: first.error }); return true; }
  const again = (): string | null => {
    if (!permitWebContinuation(req, res, ctx)) return null;
    const now = who();
    if ("status" in now) { json(res, now.status, { error: now.error }); return null; }
    if (now.person !== first.person) { json(res, 409, { error: "owner_css_person_changed" }); return null; }
    return now.person;
  };
  const announce = () => ctx.emitSseEvent("status", ctx.getUiStatus());   // their other devices see the new prefs rev
  const fail = (err: unknown) => {
    ctx.logger.error({ err: (err as Error).message }, "Owner CSS request failed");
    try { json(res, 500, { error: "Owner CSS request failed" }); } catch { /* already answered */ }
  };

  if (path === "/ui/owner-css.css" && method === "GET") {
    const v = url.searchParams.get("v");
    const sha = v ?? store.state(first.person).active;
    const text = sha ? store.served(first.person, sha) : null;
    if (text === null) { json(res, 404, { error: "no owner CSS" }); return true; }
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8", "X-Content-Type-Options": "nosniff",
      // Keyed by its sha (?v): a version's text never changes. Without ?v it is whatever is in force now.
      "Cache-Control": v ? "private, max-age=31536000, immutable" : "private, no-store",
    });
    res.end(text);
    return true;
  }
  const assetPath = /^\/ui\/owner-css\/asset\/([0-9a-f]{32})$/.exec(path);
  if (assetPath && method === "GET") {
    const asset = store.asset(first.person, assetPath[1]!);
    if (!asset) { json(res, 404, { error: "no such asset" }); return true; }
    res.writeHead(200, {
      "Content-Type": asset.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.end(asset.bytes);
    return true;
  }
  if (path === "/ui/owner-css/state" && method === "GET") { json(res, 200, store.state(first.person)); return true; }
  if (assetPath && method === "DELETE") {
    const removed = store.removeAsset(first.person, assetPath[1]!);
    json(res, removed.ok ? 200 : removed.status, removed.ok ? { ok: true } : { error: removed.error });
    return true;
  }
  if (method !== "POST" || !["/ui/owner-css", "/ui/owner-css/keep", "/ui/owner-css/revert", "/ui/owner-css/restore", "/ui/owner-css/asset"].includes(path)) {
    json(res, 404, { error: "not found" });
    return true;
  }
  (async () => {
    if (path === "/ui/owner-css/asset") {
      let bytes: Buffer;
      try { bytes = await readBoundedWebBody(req, 1024 * 1024); } catch { json(res, 413, { error: "asset_quota", detail: "at most 1 MiB" }); return; }
      const person = again();
      if (!person) return;
      const added = store.addAsset(person, bytes);
      if (!added.ok) { json(res, added.status, { error: added.error, ...(added.detail ? { detail: added.detail } : {}) }); return; }
      json(res, 200, { id: added.id, kind: added.kind, bytes: added.bytes });
      return;
    }
    let body: Record<string, unknown>;
    try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
    const person = again();
    if (!person) return;
    if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "an object" }); return; }
    if (path === "/ui/owner-css") {
      const saved = store.save(person, body.text);
      if (!saved.ok) { json(res, saved.status, { error: saved.error, ...(saved.detail ? { detail: saved.detail } : {}) }); return; }
      announce();
      json(res, 200, { sha: saved.sha, previous: saved.previous, trial: saved.trial });
    } else if (path === "/ui/owner-css/keep") {
      const kept = store.keep(person, body.trial);
      if (!kept.ok) { json(res, kept.status, { error: kept.error }); return; }
      announce();                                                         // the person's other devices drop their bar
      json(res, 200, { active: kept.active });
    } else if (path === "/ui/owner-css/revert") {
      // Exactly this trial, while it still is one: a trial kept (or ended) on another device meanwhile stays (409).
      const reverted = store.revertTrial(person, body.trial);
      if (!reverted.ok) { json(res, reverted.status, { error: reverted.error }); return; }
      announce();
      json(res, 200, { active: reverted.active });
    } else {
      const restored = store.restore(person, body.sha);
      if (!restored.ok) { json(res, restored.status, { error: restored.error }); return; }
      announce();
      json(res, 200, { active: restored.active });
    }
  })().catch(fail);
  return true;
}

/** #1629: static current-placement posters, separate from the local human-only runtime API. */
function handleEffectPosters(res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const image = /^\/ui\/effect-posters\/([0-9a-f]{32})\.png$/.exec(path);
  const names = [...url.searchParams.keys()], instance = url.searchParams.get("instance");
  if (method !== "GET" || path !== "/ui/effect-posters" && !image || names.length !== 1 || names[0] !== "instance" || !instance || instance.length > 128) {
    json(res, 404, { error: "not_found" }); return true;
  }
  const service = ctx.effectService;
  if (!service) { json(res, 404, { error: "effects_unavailable" }); return true; }
  if (image) {
    const r = service.placedPoster(image[1]!, instance);
    if (!r.ok) json(res, 404, { error: "not_found" });
    else { res.writeHead(200, { "Content-Type": "image/png", "Content-Security-Policy": "default-src 'none'; sandbox" }); res.end(r.bytes); }
  } else {
    const result = service.posterPlacements(instance);
    json(res, result.error === "themes_unreadable" ? 503 : result.error ? 404 : 200, result);
  }
  return true;
}

/** #1629 Try: separate local-admin routes. These never borrow ordinary read-tier/placement authority. */
function handleEffectTrials(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const reading = method === "GET";
  if (gatewayRequestContext(req)) { json(res, reading ? 404 : 403, { error: "trials_not_over_public_link" }); return true; }
  const who = (): { actor: Omit<EffectTrialActor, "ownerCss"> & { ownerCss: "off" | "on" | "unknown" }; record: SessionRecord; sessions: WebSessionStore | null | undefined } | { error: string; status: number } => {
    const sessions = ctx.webSessions;
    const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, sessions, { touch: false });
    if (v.kind !== "allow") return { error: WEB_TOKEN_INVALID_MESSAGE, status: 401 } as const;
    if (v.via !== "session" || v.session.tier !== "admin" || v.session.surface !== "local") return { error: "trials_need_a_local_admin", status: 403 } as const;
    const person = webPersonKey(v.session.owner);
    let css: "off" | "on" | "unknown" = "unknown";
    try { const value = ctx.ownerCss?.effectState(person); if (value === "off" || value === "on") css = value; } catch { /* unavailable is never off */ }
    // CSS is diagnostic for Try; its host-owned shadow shell isolates controls and local paint.
    const actor = Object.freeze({ via: "session" as const, surface: "local" as const, tier: "admin" as const, sessionHash: v.session.idHash, epoch: v.session.handle, person, ownerCss: css });
    return { actor, record: v.session, sessions };
  };
  const first = who(); if ("error" in first) { json(res, first.status, { error: first.error }); return true; }
  const service = ctx.effectService; if (!service) { json(res, 404, { error: "trials_unavailable" }); return true; }
  const start = path === "/ui/effect-trials/start";
  const route = /^\/ui\/effect-trials\/([0-9a-f]{32})\/(resource|poster\.png|profile|stop)$/.exec(path);
  const resource = reading && route && ["resource", "poster.png", "profile"].includes(route[2]!);
  const stop = method === "POST" && route?.[2] === "stop";
  if (!(resource || stop || method === "POST" && start)) { json(res, 404, { error: "not_found" }); return true; }
  const allowed = resource ? ["ownerEpoch", "instance"] : ["ownerEpoch"];
  if ([...url.searchParams.keys()].some(k => !allowed.includes(k)) || allowed.some(k => url.searchParams.getAll(k).length !== 1)
    || url.searchParams.get("ownerEpoch") !== first.actor.epoch) { json(res, reading ? 404 : 409, { error: reading ? "not_found" : "trials_person_changed" }); return true; }
  const instance = url.searchParams.get("instance") ?? "";
  const answer = (result: Record<string, unknown>) => json(res, result.error ? result.error === "not_found" ? 404
    : ["profiles_unreadable", "profiles_busy", "profiles_write_failed"].includes(String(result.error)) ? 503 : 400 : 200, result);
  if (resource) {
    if (route[2] === "poster.png") {
      const result = service.trialPoster(route[1]!, instance, first.actor);
      if (!result.ok) json(res, 404, { error: "not_found" });
      else { res.writeHead(200, { "Content-Type": "image/png", "Content-Security-Policy": "default-src 'none'; sandbox" }); res.end(result.bytes); }
    } else answer(route[2] === "profile" ? service.trialProfile(route[1]!, instance, first.actor) : service.trialResource(route[1]!, instance, first.actor));
    return true;
  }
  (async () => {
    let bytes: Buffer;
    try { bytes = await readBoundedWebBody(req, 16 * 1024); } catch { json(res, 413, { error: "trial_body_bound" }); return; }
    if (!permitWebContinuation(req, res, ctx)) return;
    const now = who(); if ("error" in now) { json(res, now.status, { error: now.error }); return; }
    if (now.record !== first.record || now.sessions !== first.sessions || now.actor.sessionHash !== first.actor.sessionHash
      || now.actor.person !== first.actor.person || now.actor.epoch !== first.actor.epoch) { json(res, 409, { error: "trials_person_changed" }); return; }
    let body: unknown; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { json(res, 400, { error: "trial_json" }); return; }
    if (start) {
      const parsed = z.strictObject({ offer: z.string().regex(/^[0-9a-f]{32}$/), instance: z.string().min(1).max(128) }).safeParse(body);
      if (!parsed.success) { json(res, 400, { error: "trial_args" }); return; }
      answer(service.trialStart(parsed.data.offer, parsed.data.instance, now.actor));
    } else {
      if (!z.strictObject({}).safeParse(body).success) { json(res, 400, { error: "trial_args" }); return; }
      answer(service.trialStop(route![1]!, now.actor));
    }
  })().catch(() => { try { json(res, 500, { error: "trial_request_failed" }); } catch { /* response ended */ } });
  return true;
}

/** #1629 B2: effect routes require a human session; route bodies never supply an actor or reference holder. */
function handleEffects(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const reading = method === "GET";
  // Reports are bounded untrusted diagnostics, not an appearance or admission write (r2 §6).
  const profilePost = method === "POST" && /^\/ui\/effects\/profile\/[0-9a-f]{32}$/.test(path);
  const gateway = gatewayRequestContext(req), guest = guestRequestOf(req);
  const instanceQuery = url.searchParams.get("instance"), keys = [...url.searchParams.keys()];
  const chatRead = reading && (path === "/ui/effects/placements" || /^\/ui\/effects\/resource\/[0-9a-f]{32}$/.test(path))
    && keys.length === 2 && keys.includes("instance") && keys.includes("ownerEpoch") && !!instanceQuery && instanceQuery.length <= 128;
  // Public viewing grants current Chat reads, never ordinary library/owner/Trial access or writes.
  if (gateway && (!chatRead || !gateway.isCurrent())) { json(res, reading ? 404 : 403, { error: "effects_not_over_public_link" }); return true; }
  const who = (): { person: string; canWrite: boolean; epoch: string; guest: boolean } | { status: number; error: string } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401, error: WEB_TOKEN_INVALID_MESSAGE };
    if (verdict.via !== "session" || !verdict.session) return { status: 403, error: "effects_need_a_signed_in_person" };
    if (!reading && !profilePost && verdict.session.tier !== "admin") return { status: 403, error: "effects_read_only" };
    if (verdict.session.tier === "guest" && (!chatRead || !guest || !guest.current() || !guest.scope().has(instanceQuery!))) return { status: 404, error: "not_found" };
    return { person: webPersonKey(verdict.session.owner), canWrite: verdict.session.tier === "admin", epoch: verdict.session.handle, guest: verdict.session.tier === "guest" };
  };
  const first = who(); if ("status" in first) { json(res, first.status, { error: first.error }); return true; }
  const service = ctx.effectService; if (!service) { json(res, 404, { error: "effects_unavailable" }); return true; }
  const unavailable = new Set(["themes_unreadable", "profiles_unreadable", "library_unreadable", "references_unreadable", "library_busy", "profiles_busy", "profiles_write_failed", "library_write_failed", "prefs_unreadable"]);
  const answer = (result: Record<string, unknown>) => json(res, typeof result.error === "string" ? result.error === "not_found" ? 404 : result.error === "profile_rate_limited" ? 429 : unavailable.has(result.error) ? 503 : 400 : 200, result);
  const idPath = /^\/ui\/effects\/(resource|profile)\/([0-9a-f]{32})$/.exec(path);
  const instance = url.searchParams.get("instance") ?? undefined, slot = url.searchParams.get("slot");
  if (slot !== null && instance !== undefined) { json(res, 404, { error: "not_found" }); return true; }
  const runtimeRead = reading && (slot !== null || path === "/ui/effects/owner" || path === "/ui/effects/placements" || idPath?.[1] === "resource" || instance !== undefined && /^\/ui\/effects\/image\//.test(path));
  if ((runtimeRead || profilePost) && (url.searchParams.getAll("ownerEpoch").length !== 1 || url.searchParams.get("ownerEpoch") !== first.epoch)) {
    const privateResource = reading && (slot !== null || idPath?.[1] === "resource" || /^\/ui\/effects\/image\//.test(path));
    json(res, privateResource ? 404 : 409, { error: privateResource ? "not_found" : "effects_person_changed" }); return true;
  }
  if (reading) {
    const image = /^\/ui\/effects\/image\/([0-9a-f]{32})\/(poster|cursor)\.png$/.exec(path);
    if (image) {
      const r = slot === null ? service.image(first.person, image[1]!, image[2] as "poster" | "cursor", instance) : service.ownerImage(first.person, image[1]!, image[2] as "poster" | "cursor", slot);
      if (!r.ok) json(res, 404, { error: "not_found" });
      else { res.writeHead(200, { "Content-Type": "image/png", "Content-Security-Policy": "default-src 'none'; sandbox" }); res.end(r.bytes); }
      return true;
    }
    if (path === "/ui/effects") answer({ ...service.list(first.person), canWrite: first.canWrite });
    else if (path === "/ui/effects/owner" && instance === undefined && slot === null) answer(service.ownerSelections(first.person));
    else if (path === "/ui/effects/placements" && instance !== undefined) answer(service.placements(first.person, instance, !!gateway || first.guest));
    else if (idPath?.[1] === "resource") answer(slot === null ? service.resource(first.person, idPath[2]!, instance, !!gateway || first.guest) : service.ownerResource(first.person, idPath[2]!, slot));
    else if (idPath?.[1] === "profile" && instance === undefined) answer(service.profile(first.person, idPath[2]!));
    else json(res, 404, { error: "not_found" });
    return true;
  }
  const deletion = /^\/ui\/effects\/([0-9a-f]{32})$/.exec(path);
  if (method === "DELETE" && deletion) { answer(service.delete(first.person, deletion[1]!)); return true; }
  if (method !== "POST" || !["/ui/effects/upload", "/ui/effects/apply", "/ui/effects/remove", "/ui/effects/share"].includes(path) && idPath?.[1] !== "profile") { json(res, 404, { error: "not_found" }); return true; }
  (async () => {
    let bytes: Buffer;
    try { bytes = await readBoundedWebBody(req, path === "/ui/effects/upload" ? EFFECT_WIRE_LIMIT : 16 * 1024); }
    catch { json(res, 413, { error: "effect_body_bound" }); return; }
    if (!permitWebContinuation(req, res, ctx)) return;
    const now = who(); if ("status" in now) { json(res, now.status, { error: now.error }); return; }
    if (now.person !== first.person || now.epoch !== first.epoch) { json(res, 409, { error: "effects_person_changed" }); return; }
    if (path === "/ui/effects/upload") { answer(service.upload(now.person, bytes)); return; }
    let body: unknown; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { json(res, 400, { error: "effect_json" }); return; }
    if (path === "/ui/effects/apply") answer(service.apply(now.person, body));
    else if (path === "/ui/effects/remove") answer(service.remove(now.person, body));
    else if (path === "/ui/effects/share") answer(service.share(now.person, body));
    else {
      if (body && typeof body === "object" && (body as Record<string, unknown>).kind === "playback" && (url.searchParams.getAll("instance").length !== 1 || slot !== null)) { json(res, 400, { error: "playback_report" }); return; }
      answer(service.report(now.person, idPath![2]!, body, instance, now.epoch));
    }
  })().catch(() => { try { json(res, 500, { error: "effect_request_failed" }); } catch { /* response ended */ } });
  return true;
}

/**
 * #1629 r4 §4 (r4-5): mods — a person's import (stage, then commit), uninstall and export. Every route is a signed-in
 * session's, writes an admin's: never the CLI's header token (the way an agent could reach it) and never the public link
 * (absent from its manifest, and refused here too). `who()` is asked first and again once a body is in.
 */
function handleMods(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  const mods = ctx.mods;
  if (!mods) { json(res, 404, { error: "Mods are not kept on this fleet" }); return true; }
  const reading = method === "GET";
  if (gatewayRequestContext(req)) { json(res, reading ? 404 : 403, { error: "mods_not_over_public_link" }); return true; }
  const who = (): { person: string } | { status: number; error: string } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401, error: WEB_TOKEN_INVALID_MESSAGE };
    if (verdict.via !== "session" || !verdict.session) return { status: 403, error: "mods_need_a_signed_in_session" };
    if (!reading && verdict.session.tier !== "admin") return { status: 403, error: "mods_need_an_admin_session" };
    return { person: webPersonKey(verdict.session.owner) };
  };
  const first = who();
  if ("status" in first) { json(res, first.status, { error: first.error }); return true; }
  const again = (): string | null => {
    if (!permitWebContinuation(req, res, ctx)) return null;
    const now = who();
    if ("status" in now) { json(res, now.status, { error: now.error }); return null; }
    if (now.person !== first.person) { json(res, 409, { error: "mods_person_changed" }); return null; }
    return now.person;
  };
  const answer = (r: { ok: boolean; status?: number; error?: string; detail?: string; problems?: unknown }, body: unknown) => {
    if (r.ok) json(res, 200, body);
    else json(res, r.status ?? 500, { error: r.error, ...(r.detail ? { detail: r.detail } : {}), ...(r.problems ? { problems: r.problems } : {}) });
  };
  const fail = (err: unknown) => {
    ctx.logger.error({ err: (err as Error).message }, "Mod request failed");
    try { json(res, 500, { error: "Mod request failed" }); } catch { /* already answered */ }
  };

  if (path === "/ui/mods" && method === "GET") { json(res, 200, { ...mods.list(), staged: mods.staged(first.person), proposals: mods.proposals() }); return true; }
  // A staged mod's picture (this session's person's stage only): the plan shows the actual pictures before install.
  const stagedPic = /^\/ui\/mods\/staged\/([0-9a-f]{32})$/.exec(path);
  if (stagedPic && method === "GET") {
    const pic = mods.stagedPicture(first.person, stagedPic[1]!);
    if (!pic) { json(res, 404, { error: "No such image" }); return true; }
    res.writeHead(200, { "Content-Type": pic.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox" });
    res.end(Buffer.from(pic.bytes));
    return true;
  }
  const fileMatch = /^\/ui\/mods\/file\/([0-9a-f]{32})$/.exec(path);
  if (fileMatch && method === "GET") {
    const text = mods.bundleText(fileMatch[1]!);
    const rec = mods.list().mods.find(m => m.id === fileMatch[1]);
    if (text === null || !rec) { json(res, 404, { error: "no_such_mod" }); return true; }
    // The file is the installed bundle, effects and all — also effects its import left out, which nobody installed.
    // So the export ACL judges what the file carries, not what was installed: it downloads only when this person may
    // read every effect in it (their own claim on that content, or a shared one). A file without effects is any admin's.
    const fx = mods.bundleEffects(fileMatch[1]!);
    if (fx === "unknown" || (fx ?? []).some(id => !ctx.modPlacedEffect?.(first.person, id))) { json(res, 403, { error: "mod_effects_not_yours", detail: "this mod's file carries effects that are not yours to share: export your own look instead" }); return true; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${rec.name}-${rec.version}.agendmod.json"` });
    res.end(text);
    return true;
  }
  if (method !== "POST" || !["/ui/mods/stage", "/ui/mods/abort", "/ui/mods/commit", "/ui/mods/uninstall", "/ui/mods/export", "/ui/mods/proposal/stage", "/ui/mods/proposal/dismiss"].includes(path)) {
    json(res, 404, { error: "not found" });
    return true;
  }
  (async () => {
    if (path === "/ui/mods/stage") {
      // Too large by its own declared length: answered before a byte is read (the body is drained, not cut off).
      if (Number(req.headers["content-length"]) > MOD_MAX_BYTES) { req.resume(); json(res, 413, { error: "mod_too_large", detail: `at most ${MOD_MAX_BYTES / 1024 / 1024} MiB` }); return; }
      let raw: Buffer;
      try { raw = await readBoundedWebBody(req, MOD_MAX_BYTES); } catch { json(res, 413, { error: "mod_too_large", detail: `at most ${MOD_MAX_BYTES / 1024 / 1024} MiB` }); return; }
      const person = again();
      if (!person) return;
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { json(res, 400, { error: "mod_invalid", problems: [{ path: "", problem: "not UTF-8" }] }); return; }
      const r = mods.stage(person, text);
      answer(r, r.ok ? { stage: r.stage, plan: r.plan, plan_hash: r.plan_hash } : null);
      return;
    }
    let body: Record<string, unknown>;
    try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
    const person = again();
    if (!person) return;
    if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "an object" }); return; }
    if (path === "/ui/mods/abort") { const r = mods.abort(person, body.stage); answer(r, { ok: true }); return; }
    // r4-5b: an agent's proposal, opened into the usual review (staged as this person's), or dismissed.
    if (path === "/ui/mods/proposal/stage") { const r = mods.stageProposal(person, body.instance); answer(r, r.ok ? { stage: r.stage, plan: r.plan, plan_hash: r.plan_hash } : null); return; }
    if (path === "/ui/mods/proposal/dismiss") { const r = mods.dismiss(body.instance); answer(r, { ok: true }); return; }
    if (path === "/ui/mods/commit") {
      const r = mods.commit(person, body);
      if (r.ok) ctx.emitSseEvent("status", ctx.getUiStatus());   // themes_rev and prefs_rev moved: every page re-reads
      answer(r, r.ok ? { id: r.id, applied: r.applied, ...(r.css ? { css: r.css } : {}) } : null);
      return;
    }
    if (path === "/ui/mods/uninstall") { const r = mods.uninstall(body.id); answer(r, r.ok ? { ok: true, released: r.released } : null); return; }
    // Export: what is in force now, as a bundle file.
    const r = exportMod(ctx, person, body);
    if (!r.ok) { json(res, r.status, { error: r.error, ...(r.detail ? { detail: r.detail } : {}) }); return; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${r.filename}"`, "X-AgEnD-Effects-Omitted": String(r.omitted) });
    res.end(r.text);
  })().catch(fail);
  return true;
}

/** A person's export: an instance's look (theme, identity, its widgets), their sidebar widget and their own CSS. */
export function exportMod(ctx: WebApiContext, person: string, body: Record<string, unknown>): { ok: true; text: string; filename: string; omitted: number } | { ok: false; status: number; error: string; detail?: string } {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const inc = isObj(body.include) ? body.include : null;
  if (!inc) return { ok: false, status: 400, error: "include" };
  const meta = { name: body.name, version: body.version, title: body.title };
  if (typeof meta.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.name)) return { ok: false, status: 400, error: "name", detail: "a-z, 0-9 and - (1..64)" };
  if (typeof meta.version !== "string" || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(meta.version)) return { ok: false, status: 400, error: "version", detail: "MAJOR.MINOR.PATCH" };
  // The importer's own rule (#1897 review): what is exported always imports.
  const title = canonicalText(meta.title, 1, 60);
  if (title === null) return { ok: false, status: 400, error: "title", detail: "1..60 characters on one line" };
  const parts: ModExportParts = {};
  let omitted = 0;
  const wantsInstance = inc.theme === true || inc.identity === true || inc.ambient === true || (isObj(inc.widgets) && AGENT_WIDGET_SLOTS.some(s => (inc.widgets as Record<string, unknown>)[s] === true));
  let name: string | null = null;
  if (wantsInstance) {
    if (typeof body.instance !== "string" || !ctx.isKnownInstance?.(body.instance) || !ctx.themeStore) return { ok: false, status: 400, error: "instance" };
    name = body.instance;
  }
  if (name && ctx.themeStore) {
    const store = ctx.themeStore;
    const rec = store.get(name);
    if (inc.theme === true) {
      // The effects the theme places travel with it, as the library keeps them (a person may export what is placed).
      // Only effects this person may carry away travel (Sol's ACL); the rest are counted, never packaged.
      // #2017: an older placement of an effect that doesn't play in chat stays out (a mod can't place it): counted.
      const effects = rec.placements.effects.flatMap(p => { const e = ctx.modPlacedEffect?.(person, p.id); if (!e || !filesPlayInChat(e.files)) { omitted++; return []; } return [{ name: e.name, files: e.files, params: p.params ?? {} }]; });
      parts.theme = { theme: rec.theme, picture: id => { const a = rec.assets.find(x => x.id === id); const b = store.asset(name!, id); return a && b ? { bytes: b.bytes, kind: a.kind } : null; }, effects };
    }
    if (inc.identity === true) parts.identity = ctx.modCardText?.(name) ?? {};
    for (const slot of AGENT_WIDGET_SLOTS) {
      const w = rec.placements.widgets[slot];
      if (isObj(inc.widgets) && inc.widgets[slot] === true && w) (parts.widgets ??= {})[slot] = { spec: w.spec, data: w.data };
    }
    // #2117: its ambients, whoever set them (a person exports what is on the chat).
    if (inc.ambient === true) {
      const specs = Object.fromEntries(Object.entries(rec.placements.ambient).flatMap(([k, a]) => a ? [[k, a.spec]] : []));
      parts.ambient = { specs, picture: id => { const a = rec.assets.find(x => x.id === id); const b = store.asset(name!, id); return a && b ? { bytes: b.bytes, kind: a.kind } : null; } };
    }
  }
  if (isObj(inc.widgets) && inc.widgets.sidebar === true && ctx.webPrefs) {
    const v = ctx.webPrefs.read(OPERATOR).values["widget.sidebar"] as { spec?: unknown; data?: unknown } | undefined;
    const spec = v ? checkWidgetSpec(v.spec, "sidebar") : null;
    const data = spec?.ok ? checkWidgetData(v!.data, spec.value) : null;
    if (spec?.ok && data?.ok) (parts.widgets ??= {}).sidebar = { spec: spec.value, data: { ...data.value } };
  }
  if (inc.ownerCss === true && ctx.ownerCss) {
    const state = ctx.ownerCss.state(person);
    const checked = state.text ? checkOwnerCss(state.text, new Set(state.assets.map(a => a.id))) : null;
    if (state.text && checked?.ok) {
      // Only the assets this text names travel (read from its tokens: url("\\61sset:<id>") names one too).
      const named = ownerCssAssetRefs(checked.tokens);
      const assets = state.assets.filter(a => named.has(a.id)).flatMap(a => { const b = ctx.ownerCss!.asset(person, a.id); return b ? [{ id: a.id, bytes: b.bytes, kind: a.kind }] : []; });
      parts.ownerCss = { text: state.text, assets };
    }
  }
  const built = buildModBundle({ name: meta.name, version: meta.version, title }, parts);
  return built.ok ? { ...built, omitted } : { ok: false, status: built.error === "nothing_to_export" ? 400 : 409, error: built.error };
}

/** #1827: a web person as the web chat shows them to agents and chats. */
export interface WebPerson {
  /** Their key in the web preferences (web-profile.ts webPersonKey): never shown. */
  readonly key: string;
  /** Signed in as an account (a sign-in code DMed to it), or the operator. */
  readonly bound: boolean;
  /** What agents see as the id: the bound account's user id on its platform (still `via web`), or "web-user". */
  readonly userId: string;
  /** Their poll ballot's key: the account's `<connection>:<user id>` (as on the platform), or the operator's. */
  readonly voterKey: string;
  /** The name in use: the one they chose, else their account's name at sign-in, else "web-user". */
  readonly name: string;
  /** Whether the name in use is one they chose. */
  readonly set: boolean;
  /** Their account's name at sign-in, made safe (bound only). */
  readonly platformName?: string;
}
/**
 * #1827: whose a request is, asked NOW (after its body arrived: a session revoked, expired or rotated away meanwhile is
 * no one — `null`, never the operator). An authorized session is the account it was signed in as, or (an `agend web`
 * session, the CLI's header token) none: the operator. For recognition only; nothing here authorizes anything.
 */
function webAccountOf(req: IncomingMessage, url: URL, ctx: WebApiContext): { owner?: WebAccount } | null {
  const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (verdict.kind !== "allow") return null;
  return verdict.via === "session" && verdict.session?.owner ? { owner: verdict.session.owner } : {};
}
function webPersonOf(req: IncomingMessage, url: URL, ctx: WebApiContext): WebPerson | null {
  // No people kept here: everyone is "web-user", as before, and there is no identity to protect.
  if (!ctx.webPerson) return { key: OPERATOR, bound: false, userId: WEB_NAME_FALLBACK, voterKey: "web:operator", name: WEB_NAME_FALLBACK, set: false };
  const who = webAccountOf(req, url, ctx);
  return who ? ctx.webPerson(who.owner) : null;
}
/**
 * #1939 S1: whether this request carries `web-session` authority, asked as it stands now — on arrival without an instance,
 * after the body with the one it names (then confirmAfterBody joins the two). Never touches the session.
 */
function webAuthorityOf(req: IncomingMessage, url: URL, ctx: WebApiContext, instance?: string): WebAuthorityResult {
  if (!ctx.webAuthority) return { authority: noAuthority(0), refusal: "not_session" };
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  return ctx.webAuthority({ session: v.kind === "allow" && v.via === "session" ? v.session : null, gateway: !!gatewayRequestContext(req),
    peer: classifyWebPeer(req), ...(instance !== undefined ? { instance } : {}) });
}
/**
 * #2122: what let this request in, asked now — its session (by handle, under the token it was signed in with) or the
 * header token; null when nothing does any more (the gate also refuses a public link that is no longer the current
 * one). Equal before and after an await: the same admission still holds. Never touches the session.
 */
function admissionOf(req: IncomingMessage, url: URL, ctx: WebApiContext): string | null {
  const gateway = gatewayRequestContext(req);
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (v.kind !== "allow") return null;
  const via = v.via === "session" ? `session:${v.session.handle}:${v.session.tokenEpoch}` : "token";
  return gateway ? `${via}@${gateway.exposureId}` : via;
}
/** #1827: the person, or the request is answered 401 here (it is no longer authorized) and null is returned. */
function webPersonOr401(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext): WebPerson | null {
  const p = webPersonOf(req, url, ctx);
  if (!p) json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE });
  return p;
}
/** #1827: what the page's profile card reads — the name they chose (or null), the one in use, and how agents know them. */
function profileBody(p: WebPerson): Record<string, unknown> {
  return { name: p.set ? p.name : null, shown: p.name, id: p.userId, bound: p.bound, ...(p.platformName !== undefined ? { platform_name: p.platformName } : {}) };
}

/** #1823: an SSE frame with the server's clock (no id: it is not a message, and a reconnect gets a fresh one). */
function sseClock(): string { return `event: clock\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`; }

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

  // #2072: the model a Settings field offers — the cached catalog of that backend (that instance's account's). Read only.
  if (method === "GET" && path === "/ui/models") {
    const backend = url.searchParams.get("backend") ?? "";
    const instance = url.searchParams.get("instance");
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(backend) || (instance !== null && (instance.length < 1 || instance.length > 256))) { json(res, 400, { error: "backend (and optional instance) required" }); return true; }
    json(res, 200, { backend, models: ctx.modelCatalogFor?.(backend, instance) ?? [] });
    return true;
  }

  if (method === "GET" && path === "/ui/backends") {
    // #2072 (#2098 review P3-3): the backend an agent created with "fleet default" runs, so its model list can be shown.
    const defaultBackend = ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    const BACKENDS: Array<{ name: string; binary: string; deprecated?: boolean }> = [
      { name: "claude-code", binary: "claude" },
      { name: "codex", binary: "codex" },
      { name: "opencode", binary: "opencode" },
      { name: "kiro-cli", binary: "kiro-cli" },
      { name: "antigravity", binary: "agy" },
      { name: "grok", binary: "grok" },
      { name: "muse", binary: "muse" },
    ];
    // #2072: the published availability snapshot — installed, signed in, new enough — when the fleet has one.
    if (ctx.backendAvailabilityRows) {
      const binaryOf = new Map(BACKENDS.map(b => [b.name, b]));
      const backends = ctx.backendAvailabilityRows().filter(r => binaryOf.has(r.backend)).map(r => ({
        name: r.backend, binary: binaryOf.get(r.backend)!.binary, installed: r.state !== "not_installed" && r.path !== null, path: r.path ?? "",
        deprecated: binaryOf.get(r.backend)!.deprecated ?? false, state: r.state, minVersion: r.minVersion, ...(r.state === "unknown" ? { unknown: true } : {}),
      }));
      json(res, 200, { backends, defaultBackend });
      return true;
    }
    // #1490: seven sequential 2 s `execFileSync("which")` calls used to block the event loop here. The shared probe
    // runs `which` as bounded async children and reuses an answer for BINARY_PROBE_TTL_MS. `unknown`: no answer in
    // time (shown as not installed, as the old timeout was).
    void Promise.all(BACKENDS.map(async (b) => {
      const found = await binaryProbe.probe(b.binary);
      const path = found.known ? found.path : null;
      return { name: b.name, binary: b.binary, installed: path !== null, path: path ?? "", deprecated: b.deprecated ?? false,
        ...(found.known ? {} : { unknown: true }) };
    })).then(
      (backends) => { if (!res.headersSent) json(res, 200, { backends, defaultBackend }); },
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
    // #1920: a guest's poll is projected for its scope (web-guest-access.ts) — the same rule as its stream.
    const guest = guestRequestOf(req);
    const history = ctx.webChatHistory;
    const after = url.searchParams.get("after");
    const fresh = after === null || after === "";              // a cursor that is not ours in shape still gets nothing
    if (guest) {
      // #2085 review: and what became the channel's after its cursor (an older row, its copy sent since), once each.
      json(res, 200, guestPollBody(ctx.getUiStatus(), guest.scope(), Date.now(), guest, after, () => {
        if (!history) return [];
        if (fresh) return history.after(0);
        const cursor = parseLastEventId(after);
        const rows = [...history.replayFor(cursor), ...history.seenAfter(cursor)];
        return rows.filter((m, i) => rows.findIndex((x) => x.boot === m.boot && x.id === m.id) === i);
      }));
      return true;
    }
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
      // #1577: the newest message this answer accounts for — after a restart, the last restored one until this process
      // records its own (`<boot>-0` would be after(0): the whole restored history again on every poll).
      cursor: history ? history.pollCursor() : null,
      // #1823 (#1830 review): the server's clock now, for the page's poll countdown (a poll's deadline is the server's).
      now: Date.now(),
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
    // #1823 (#1830 review): with the status, the server's clock — now and with every heartbeat — that the page counts a
    // poll down by (one write: the frames a connect sends are unchanged in number).
    // #1920: a guest's stream: its projected status now and with each heartbeat, its replay and ticks as it may see them
    // (§5.2), then only what guestFrameData lets through — no prompts or Needs you.
    const guest = guestRequestOf(req);
    if (guest) { streamGuests.set(res, guest); guest.streamOpened?.(); }
    const statusFrame = () => `event: status\ndata: ${JSON.stringify(guest ? guestStatus(ctx.getUiStatus(), guest.scope()) : ctx.getUiStatus())}\n\n`;
    res.write(`${statusFrame()}${sseClock()}`);
    // An EventSource that reconnects says what it last saw: send what it missed, before anything new.
    const lastSeen = parseLastEventId(req.headers["last-event-id"]);
    if (lastSeen !== null && ctx.webChatHistory) {
      const history = ctx.webChatHistory;
      if (guest) {
        // Its own projection, with no cursor: an admin's ids are not a guest's to hold (it reloads its history instead).
        for (const m of guestMessages(history.replayFor(lastSeen), guest, guest.scope())) res.write(sseFrame("message", m));
      } else {
        for (const m of history.replayFor(lastSeen)) res.write(sseFrame("message", m, history.cursorOf(m)));
      }
    }
    // Ticks change messages already sent and carry no cursor: every (re)connect gets where each one is now, so a
    // report that fell into a gap is not lost until a reload (#1253 review). No id: it is not a message.
    if (ctx.webChatHistory) {
      const ticks = guest ? guestDeliveries(ctx.webChatHistory, guest, guest.scope()) : ctx.webChatHistory.deliveries();
      res.write(`event: deliveries\ndata: ${JSON.stringify(ticks)}\n\n`);
    }
    // The same for the fleet prompts (C4): one posted, answered or expired during a gap is caught up here.
    if (!guest && ctx.listWebPrompts) res.write(`event: prompts\ndata: ${JSON.stringify(ctx.listWebPrompts())}\n\n`);
    // #1386: and "Needs you" as it is now; changes follow as `needs` events.
    if (!guest && ctx.needsYouItems) res.write(`event: needs\ndata: ${JSON.stringify({ items: ctx.needsYouItems() })}\n\n`);
    ctx.sseClients.add(res);
    const interval = setInterval(() => {
      // A stream authorized once must not outlive the authorization. Re-checked
      // without counting as activity, or an open tab would keep an idle session
      // alive forever; a revoked, expired or rotated-away session ends here.
      // #2049 review: a guest's stream also needs the exact session that opened it — another cookie on the same request
      // still authenticating does not keep a revoked device's stream (with its scope) alive.
      if (!isWebRequestAuthorized(req, url, ctx.webToken, ctx.webSessions, { touch: false }) || (guest && !guest.current())) {
        // Close the connection too, not just the response: an ended response leaves the socket idle in
        // keep-alive, still held open by whoever's session just ended.
        const socket = req.socket;
        try { res.end(() => socket?.destroy()); } catch { /* already closed */ }
        cleanup();
        return;
      }
      try {
        // Every open dashboard tab, every 10 s: the status of every instance, serialized on the fleet's loop (#1235).
        res.write(measureSyncWork("web.sseStatus", statusFrame) + sseClock());
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
    // #1920 §5.2: a guest gets what the channel showed of it, and its own messages (the gate checked the scope).
    const guest = guestRequestOf(req);
    const messages = !ctx.webChatHistory ? [] : guest ? guestHistory(ctx.webChatHistory, instance, limit, guest, guest.scope()) : ctx.webChatHistory.list(instance, limit);
    json(res, 200, { messages, boot: ctx.webChatHistory?.boot ?? null, lastId: ctx.webChatHistory?.lastId ?? 0 });
    return true;
  }

  // ── #1218: the Log tab ─────────────────────────────────
  // An instance's steps, read on demand from its own transcript (log-service.ts). Read-only, and offered on the public
  // link on purpose (the user's decision): the same masking applies to every viewer. Passive (web-auth.ts).

  if (method === "GET" && path === "/ui/steps") {
    const p = url.searchParams;
    const instance = p.get("instance") ?? "";
    const num = (k: string): number | undefined | null => {
      const v = p.get(k);
      if (v === null) return undefined;
      const n = Number(v);
      return /^\d{1,15}$/.test(v) && Number.isSafeInteger(n) ? n : null;
    };
    const after = num("after"), before = num("before"), ev = num("ev"), limit = num("limit");
    const key = p.get("key");
    if (!instance || instance.length > 128 || after === null || before === null || ev === null || limit === null
      || (limit !== undefined && (limit < 1 || limit > 200)) || (key !== null && !/^\d{1,20}-\d{1,20}$/.test(key))) {
      json(res, 400, { error: "instance (1-128 chars); after, before, ev: offsets; limit 1-200; key: <dev>-<ino>" });
      return true;
    }
    if (!ctx.logSteps) { json(res, 404, { error: "not available" }); return true; }
    ctx.logSteps(instance, {
      ...(after !== undefined ? { after } : {}), ...(before !== undefined ? { before } : {}), ...(ev !== undefined ? { ev } : {}),
      ...(limit !== undefined ? { limit } : {}), ...(key !== null ? { key } : {}),
      skip: p.get("skip") === "1", watch: p.get("watch") === "1",
    }).then(answer => {
      if (answer === null) json(res, 404, { error: `Instance not found: ${instance}` });
      else json(res, 200, answer);
    }).catch(err => {
      ctx.logger.error({ err: (err as Error).message, instance }, "Log steps read failed");
      json(res, 500, { error: "could not read the steps" });
    });
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
    // #1920: a guest gets a file only when its stored instance is in scope — "no such file" otherwise, like an unknown id
    // (an id from another instance's chat is useless).
    const guest = guestRequestOf(req);
    if (guest) {
      const served = isFileId(id) ? ctx.webFiles?.servedFile?.(id) ?? null : null;
      if (!served || !guest.scope().has(served.instance)) { json(res, 404, { error: "No such file" }); return true; }
    }
    // #1589: audio and video, played in the page — one byte range at a time (206), by id only, never a whole video in
    // memory. Every other type is answered exactly as before.
    const media = isFileId(id) ? ctx.webFiles?.mediaOf?.(id) ?? null : null;
    if (media) { serveMediaRange(req, res, ctx.webFiles!, id, media); return true; }
    // #1937: a file over MEDIA_RANGE_MAX streams from the descriptor its checks were made on — never whole in memory.
    const big = isFileId(id) && (ctx.webFiles?.servedFile?.(id)?.size ?? 0) > MEDIA_RANGE_MAX ? ctx.webFiles?.open?.(id) ?? null : null;
    const got = big ? null : isFileId(id) ? ctx.webFiles?.read(id) : null;
    const file = big?.file ?? got?.file;
    if (!file) { json(res, 404, { error: "No such file" }); return true; }
    const inline = INLINE_MIME.has(file.mime);
    // Only the four image types are shown in the page; anything else is a download, never rendered.
    res.setHeader("Content-Type", inline ? file.mime : (file.mime.startsWith("text/") ? "text/plain; charset=utf-8" : "application/octet-stream"));
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(wellFormed(file.name))}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    if (big) { streamWhole(res, big); return true; }
    res.writeHead(200);
    res.end(got!.bytes);
    return true;
  }

  // ── #1629: agents' themes — read by every page (the public link included: it views them), changed by a person ──
  // GET /ui/themes: { rev, themes, locked, widgets, ambient (#2117) } when the status frame's themes_rev moves (passive, web-auth.ts).
  // GET /ui/img/theme/<instance>/<id>: a theme's picture (same headers as #1630's images; the id is the content hash).
  // POST /ui/themes/<instance>/reset | lock | widget (r4-4: { slot } — take an agent's widget out) | ambient (#2117: { spec } sets one,
  // { which? } alone clears that kind or both): a person's, from an admin session — never the CLI token, never the public
  // link (absent from its manifest, and refused here too).
  if (method === "GET" && path === "/ui/themes") {
    const store = ctx.themeStore;
    if (!store) { json(res, 404, { error: "Themes are not kept on this fleet" }); return true; }
    json(res, 200, { rev: store.rev(), themes: store.themes(), locked: store.lockedNames(), widgets: store.widgets(), ambient: store.ambients() });
    return true;
  }
  const themeImage = path.match(/^\/ui\/img\/theme\/([^/]+)\/([0-9a-f]{32})$/);
  if (method === "GET" && themeImage) {
    let name: string;
    try { name = decodeURIComponent(themeImage[1]!); } catch { json(res, 404, { error: "No such image" }); return true; }
    const image = ctx.themeStore?.asset(name, themeImage[2]!) ?? null;
    if (!image) { json(res, 404, { error: "No such image" }); return true; }
    res.setHeader("Content-Type", image.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.writeHead(200);
    res.end(image.bytes);
    return true;
  }
  const themeWrite = path.match(/^\/ui\/themes\/([^/]+)\/(reset|lock|widget|ambient)$/);
  if (method === "POST" && themeWrite) {
    const service = ctx.webAppearance;
    if (!service) { json(res, 404, { error: "Themes are not kept on this fleet" }); return true; }
    if (gatewayRequestContext(req)) { json(res, 403, { error: "theme_not_over_public_link" }); return true; }
    let name: string;
    try { name = decodeURIComponent(themeWrite[1]!); } catch { json(res, 400, { error: "instance" }); return true; }
    const who = (): number => {
      const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
      if (verdict.kind !== "allow") return 401;
      return verdict.via === "session" && verdict.session?.tier === "admin" ? 200 : 403;
    };
    const first = who();
    if (first !== 200) { json(res, first, { error: first === 401 ? WEB_TOKEN_INVALID_MESSAGE : "theme_needs_an_admin_session" }); return true; }
    (async () => {
      let body: Record<string, unknown> = {};
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const now = who();
      if (now !== 200) { json(res, now, { error: now === 401 ? WEB_TOKEN_INVALID_MESSAGE : "theme_needs_an_admin_session" }); return; }
      if (!ctx.isKnownInstance?.(name)) { json(res, 404, { error: "unknown instance" }); return; }
      const r = themeWrite[2] === "reset" ? service.humanReset(name)
        : themeWrite[2] === "widget" ? service.humanRemoveWidget(name, body.slot)
        : themeWrite[2] === "ambient" ? service.humanSetAmbient(name, body.spec ?? null, body.which)
        : typeof body.locked === "boolean" ? service.humanLock(name, body.locked) : { error: "locked: true or false", status: 400 };
      if (typeof r.error === "string") { json(res, typeof r.status === "number" ? r.status : 503, { error: r.error }); return; }
      json(res, 200, r);
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Theme reset/lock failed");
      try { json(res, 500, { error: "Theme change failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // ── #1630: avatars and Discord server emoji, same-origin (the page never loads a platform's CDN; img-src stays 'self') ──

  const imageMatch = path.match(/^\/ui\/img\/(bot|avatar|emoji)\/([^/]+)$/);
  if (method === "GET" && imageMatch) {
    const kind = imageMatch[1] as "bot" | "avatar" | "emoji";
    let key: string;
    try { key = decodeURIComponent(imageMatch[2]!); } catch { json(res, 404, { error: "No such image" }); return true; }
    const send = (image: CachedImage | null): void => {
      if (res.headersSent || res.destroyed) return;
      if (!stillAuthorized(req, res, url, ctx)) return;
      if (!image) { json(res, 404, { error: "No such image" }); return; }
      res.setHeader("Content-Type", image.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      // A changed avatar is a new URL (?v=); an emoji id is one picture for good.
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.writeHead(200);
      res.end(image.bytes);
    };
    if (kind === "emoji") { (ctx.webEmoji ? ctx.webEmoji(key) : Promise.resolve(null)).then(send, () => send(null)); return true; }
    send(ctx.webImage?.(kind, key) ?? null);
    return true;
  }
  if (method === "GET" && path === "/ui/emojis") {
    const answer = (emojis: Array<{ id: string; name: string; animated: boolean }>) => { if (!res.headersSent && !res.destroyed && stillAuthorized(req, res, url, ctx)) json(res, 200, { emojis }); };
    (ctx.webEmojiList ? ctx.webEmojiList() : Promise.resolve([])).then(answer, () => answer([]));
    return true;
  }

  // #1682: the names of the mention ids a page found in what it rendered (at most MAX_MENTION_IDS, digits only) — only
  // those, so no page (the public link included) ever gets a directory; from memory, never a request.
  if (method === "GET" && path === "/ui/mentions") {
    const parsed = parseMentionQuery(url.searchParams);
    if (!parsed.ok) { json(res, 400, { error: parsed.error }); return true; }
    let names: MentionNames = { u: {}, r: {}, c: {} };
    try { names = ctx.webMentionNames?.(parsed.query) ?? names; } catch (err) { ctx.logger.debug({ err: (err as Error).message }, "mention names unavailable"); }
    json(res, 200, names);
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

  // #1827: the person's own name — the one agents and chats see for their web messages. Their own profile, so the public
  // link may read and set it too (profile edits are allowed there); a read-only session may as well: it is about them.
  if (path === "/ui/profile" && method === "GET") {
    if (!ctx.webPerson) { json(res, 404, { error: "Profiles are not kept on this fleet" }); return true; }
    const p = webPersonOr401(req, res, url, ctx);
    if (p) json(res, 200, profileBody(p));
    return true;
  }
  if (path === "/ui/profile" && method === "POST") {
    if (!ctx.setWebPersonName) { json(res, 404, { error: "Profiles are not kept on this fleet" }); return true; }
    const set = ctx.setWebPersonName.bind(ctx);
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "name")) { json(res, 400, { error: "name required (text, or null to clear)" }); return; }
      // Whose: asked once the body is in. A session revoked, expired or rotated away meanwhile writes nothing — it is
      // not the operator (#1833 review).
      const who = webAccountOf(req, url, ctx);
      if (!who) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
      const r = set(who.owner, body.name);
      if (!r.ok) { json(res, r.status, { error: r.error }); return; }
      // The person's other devices read it at their next status (the prefs rev moved).
      ctx.emitSseEvent("status", ctx.getUiStatus());
      json(res, 200, profileBody(r.person));
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Saving the web name failed");
      try { json(res, 500, { error: "Saving the name failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #1266: a click on an agent reply's button. The set id travels in the body; the public link may click too (a click
  // is a message, and the public link may send messages).
  if (method === "POST" && path === "/ui/reply-button") {
    if (!ctx.clickWebReplyButton) { json(res, 404, { error: "No buttons here" }); return true; }
    const click = ctx.clickWebReplyButton.bind(ctx);
    const arrival = webAuthorityOf(req, url, ctx);                         // #1939 §3: on arrival, and again after the body
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const { instance, id, index } = (body ?? {}) as Record<string, unknown>;
      if (typeof instance !== "string" || typeof id !== "string" || typeof index !== "number") {
        json(res, 400, { error: "instance, id and index required" });
        return;
      }
      // #1920 step 2b: a guest clicks only on a reply it may see (§5.2), of an in-scope instance, while guests may chat.
      const guest = guestRequestOf(req);
      const refused = guestChatRefusal(guest, instance);
      if (refused) { json(res, refused.status, { error: refused.error }); return; }
      if (guest) {
        const row = guest.history?.()?.findByButtons(instance, id);
        if (!row || !guestSeesMessage(row, guest, guest.scope())) { json(res, 404, { error: "not found" }); return; }
      }
      // #1823/#1827: the click is this page's person's — on a poll their vote (one per person, on every device of
      // theirs), on one-click buttons their choice — under their web id and name. A request that no longer passes the
      // gate (a session revoked meanwhile) clicks nothing as anyone.
      const person = webPersonOr401(req, res, url, ctx);
      if (!person) return;
      // #1920 review: a guest's choice reaches the agent marked as a guest's, as its typed messages do.
      const { authority } = confirmAfterBody(arrival, webAuthorityOf(req, url, ctx, instance));
      const r = await click(instance, id, index, { key: person.voterKey, userId: person.userId, name: person.name, ...(guest ? { guest: true as const } : {}), authority });
      json(res, r.status, r.status === 200 ? { answered: true, ...(r.options ? { options: r.options } : {}) } : { error: r.error ?? "Refused", ...(r.status === 409 ? { gone: true } : {}) });
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Web reply-button click failed");
      try { json(res, 500, { error: "Click failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #1723: the public link page's preview, asked while it says "Preview is starting…" — its state and, once up, its
  // origin and boot. Public link only: a local page's preview is decided by its own load.
  if (path === "/ui/preview-status" && method === "GET") {
    const gateway = gatewayRequestContext(req);
    if (!gateway || !ctx.publicPreviewForUi) { json(res, 404, { error: "not offered here" }); return true; }
    const p = ctx.publicPreviewForUi(gateway.exposureId, gateway.expectedOrigin);
    json(res, 200, { code: p.code, previewOrigin: p.previewOrigin, boot: p.previewOrigin ? p.boot : null, detail: p.detail ?? null });
    return true;
  }

  // Host preferences preserve their scope; only five declared owner slots use the current human session bucket.
  if (path === "/ui/prefs" && method === "GET") {
    if (!ctx.webPrefs) { json(res, 404, { error: "Preferences are not kept on this fleet" }); return true; }
    const viewer = prefsViewer(req, url, ctx); if (!viewer) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return true; }
    res.setHeader("Cache-Control", "private, no-store");
    json(res, 200, prefsView(ctx.webPrefs, viewer)); return true;
  }
  if (path === "/ui/prefs" && method === "POST") {
    const prefs = ctx.webPrefs;
    if (!prefs) { json(res, 404, { error: "Preferences are not kept on this fleet" }); return true; }
    if (gatewayRequestContext(req)) { json(res, 403, { error: "prefs_not_over_public_link" }); return true; }
    const refuse = (viewer: PrefsViewer | null) => json(res, viewer ? 403 : 401, { error: viewer ? "prefs_read_only" : WEB_TOKEN_INVALID_MESSAGE });
    const first = prefsViewer(req, url, ctx);
    if (!first?.canWrite) { refuse(first); return true; }
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "set required" }); return; }
      const parsed = prefs.parsePatch(body.set);
      if (!parsed.ok) { json(res, 400, { error: parsed.error }); return; }
      const now = prefsViewer(req, url, ctx);
      if (!now?.canWrite) { refuse(now); return; }
      if (now.person !== first.person || now.epoch !== first.epoch || now.via !== first.via) { json(res, 409, { error: "prefs_person_changed" }); return; }
      const personal = [...parsed.patch.keys()].some(isOwnerEffectKey);
      if (personal && now.person === null) { json(res, 403, { error: "prefs_need_a_signed_in_person" }); return; }
      // A scope marker rejects a queued old page after a different login, including the same person's new session.
      // It supplies neither identity nor authority; the current verified session still chooses the bucket.
      if (personal && body.ownerEpoch !== now.epoch) { json(res, 409, { error: "prefs_person_changed" }); return; }
      const before = prefs.readForViewer(now.person);
      const written = prefs.writeForViewer(now.person, parsed.patch, { onlyIfUnset: body.onlyIfUnset === true,
        validateEffect: (person, key, id) => ctx.effectService ? ctx.effectService.validateOwnerSelection(person, key, id) : "effects_unavailable" });
      if (!written.ok) { json(res, written.status, { error: written.error }); return; }
      const dropped = written.changed.filter(isOwnerEffectKey).flatMap(key => typeof before.values[key] === "string" && before.values[key] !== written.view.values[key] ? [before.values[key] as string] : []);
      if (dropped.length) ctx.effectService?.collectOwnerReplaced(dropped);
      if (written.changed.length) ctx.emitSseEvent("status", ctx.getUiStatus());
      json(res, 200, { ...written.view, ...prefsScope(now), changed: written.changed });
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Saving web preferences failed");
      try { json(res, 500, { error: "Saving preferences failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #1629 r4 §3: owner CSS — one person's own stylesheet, for their own screens. Every route is a signed-in human's
  // session: never the CLI's header token (no person, and the way an agent could reach it), never the public link
  // (absent from its manifest, and refused here too), reads included. The stylesheet and its assets are that session's
  // person's only: no name or identity in any URL.
  if (path === "/ui/owner-css.css" || path === "/ui/owner-css" || path.startsWith("/ui/owner-css/")) {
    return handleOwnerCss(req, res, url, ctx, path, method);
  }

  // #1629 r4-5: mods — a person's import, uninstall and export (handleMods: sessions only, never the public link).
  if (path === "/ui/mods" || path.startsWith("/ui/mods/")) return handleMods(req, res, url, ctx, path, method);

  // Posters remain behind the common session gate, with a closed GET-only public manifest.
  if (path === "/ui/effect-posters" || path.startsWith("/ui/effect-posters/")) return handleEffectPosters(res, url, ctx, path, method);

  // Canvas effects are absent from the public gateway manifest and independently refused above.
  if (path === "/ui/effect-trials" || path.startsWith("/ui/effect-trials/")) return handleEffectTrials(req, res, url, ctx, path, method);
  if (path === "/ui/effects" || path.startsWith("/ui/effects/")) return handleEffects(req, res, url, ctx, path, method);

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
  // ── #1939 S2b: this browser's authorization — what the app shows (GET), and "Authorize this browser" (POST: posts the
  // Confirm card in the account's DM). Judged on this request (§3), never touching the session.
  if (path === "/ui/authorization" && (method === "GET" || method === "POST")) {
    const judge = () => {
      const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
      return { session: v.kind === "allow" && v.via === "session" ? v.session : null, gateway: !!gatewayRequestContext(req), peer: classifyWebPeer(req) };
    };
    res.setHeader("Cache-Control", "no-store");
    if (method === "GET") {
      if (!ctx.webSessionAuthorization) { json(res, 404, { error: "not available" }); return true; }
      json(res, 200, ctx.webSessionAuthorization(judge()));
      return true;
    }
    if (!ctx.requestSessionAuthorization) { json(res, 404, { error: "not available" }); return true; }
    const ask = ctx.requestSessionAuthorization.bind(ctx);
    (async () => {
      try { await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const r = await ask(judge());                                              // asked again now the body is in
      // A refusal is an answer the page shows (pending, three this hour, why not), not a failed request: 200 with
      // ok: false — a 4xx would be logged as an error in the browser's console every time.
      json(res, 200, r);
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Web authorization request failed");
      try { json(res, 500, { error: "Request failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  if (method === "POST" && path === "/ui/command") {
    if (!ctx.webCommand) { json(res, 404, { error: "Not available" }); return true; }
    const run = ctx.webCommand.bind(ctx);
    const arrival = webAuthorityOf(req, url, ctx);                         // #1939 §3: on arrival, and again after the body
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
      const instance = str(body?.instance, 128), command = str(body?.command, 32);
      if (!instance || !isSafeInstanceName(instance) || !command) { json(res, 400, { error: "instance and command required" }); return; }
      if (body.args !== undefined && str(body.args, MAX_COMMAND_ARGS) === undefined) { json(res, 400, { error: "args too long" }); return; }
      if (body.confirm !== undefined && !(typeof body.confirm === "string" && /^[0-9a-f]{32}$/.test(body.confirm))) { json(res, 400, { error: "invalid confirmation" }); return; }
      const person = webPersonOr401(req, res, url, ctx);                    // #1827: asked again, now the body is in
      if (!person) return;
      const { authority } = confirmAfterBody(arrival, webAuthorityOf(req, url, ctx, instance));
      const r = await run({ instance, command, args: str(body.args, MAX_COMMAND_ARGS), confirm: body.confirm as string | undefined },
        { publicLink: !!gatewayRequestContext(req), person, authority });
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
    // #1920 step 2b: a guest's Cancel is the platform button's (anyone allowed there), while guests may chat.
    const cancelRefused = guestChatRefusal(guestRequestOf(req), name);
    if (cancelRefused) { json(res, cancelRefused.status, { error: cancelRefused.error }); return true; }
    if (!ctx.cancelInstance(name)) { json(res, 409, { error: `${name} is not running` }); return true; }
    ctx.eventLog?.logActivity("cancel", webPersonOf(req, url, ctx)?.name ?? WEB_NAME_FALLBACK, "stop the current reply", name);
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
      let held = false;
      try {
        await withSpawnHoldReply(async message => { held = true; json(res, 202, { held: true, message, instance: name }); },
          () => ctx.startInstance(name, config, topicMode ?? false));
        ctx.emitSseEvent("status", ctx.getUiStatus());
        if (!held) json(res, 200, { started: name });
      } catch (err) {
        if (!held) json(res, 500, { error: (err as Error).message });
        else ctx.logger.error({ err, name }, "Held instance action failed");
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
      let held = false;
      try {
        await withSpawnHoldReply(async message => { held = true; json(res, 202, { held: true, message, instance: name }); },
          () => ctx.restartSingleInstance(name, { explicit: true }));
        ctx.emitSseEvent("status", ctx.getUiStatus());
        if (!held) json(res, 200, { restarted: name });
      } catch (err) {
        const status = (err as Error).message.includes("not found") ? 404 : 500;
        if (!held) json(res, status, { error: (err as Error).message });
        else ctx.logger.error({ err, name }, "Held instance action failed");
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
        const person = webPersonOr401(req, res, url, ctx);                // #1827: asked again, now the body is in
        if (!person) return;
        const task = ctx.scheduler!.db.createTask({
          title: parsed.title,
          description: parsed.description,
          priority: parsed.priority,
          assignee: parsed.assignee,
          created_by: person.name,                                           // #1827
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
          const person = parsed.assignee ? null : webPersonOr401(req, res, url, ctx);   // #1827: the default is the person
          if (!parsed.assignee && !person) return;
          result = ctx.scheduler!.db.claimTask(id, parsed.assignee || person!.name);
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
    // #1724: each row with its next run and one-shot time in the fleet's zone — worked out here, not on the page.
    const scheduler = ctx.scheduler;
    const now = Date.now();
    json(res, 200, {
      schedules: (scheduler.list() as Schedule[]).map((s) => scheduleView(s, (scheduler.getRetry?.(s.id) as ScheduleRetry | null) ?? null, now)),
      // The zone a new schedule (and a "Once" date and time typed without one) is read in.
      default_timezone: (ctx.fleetConfig as { defaults?: { scheduler?: { default_timezone?: string } } } | null | undefined)?.defaults?.scheduler?.default_timezone
        ?? DEFAULT_SCHEDULER_CONFIG.default_timezone,
    });
    return true;
  }

  // #1724: who may write a schedule, asked again once the body is in (a session revoked meanwhile, a non-admin tier).
  const scheduleWriterGone = (): boolean => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    return verdict.kind !== "allow" || (verdict.via === "session" && verdict.session?.tier !== "admin");
  };

  if (method === "POST" && path === "/ui/schedules") {
    // #1724: schedules are not created, edited or deleted over the public link (absent from its manifest too, #1689).
    if (gatewayRequestContext(req)) { json(res, 403, { error: "schedule_not_over_public_link" }); return true; }
    if (!ctx.scheduler) { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    (async () => {
      try {
        const body = await parseBody(req);
        if (!permitWebContinuation(req, res, ctx)) return;
        if (scheduleWriterGone()) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
        // #1724: the create_schedule tool's own schema — cron or at (exactly one) — plus a target, which the web names.
        const parsed = parseOrReject(CreateScheduleArgs, body, res);
        if (!parsed) return;
        if (typeof parsed.target !== "string" || !parsed.target) { json(res, 400, { error: "target: an instance is required" }); return; }
        const schedule = ctx.scheduler!.create({
          cron: parsed.cron, at: parsed.at, message: parsed.message, target: parsed.target, label: parsed.label, timezone: parsed.timezone,
          ...(parsed.silent !== undefined ? { silent: parsed.silent } : {}),
          source: "web", reply_chat_id: "", reply_thread_id: null,
        });
        json(res, 200, schedule);
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  const schedDelMatch = path.match(/^\/ui\/schedules\/(.+)$/);
  // #1724: Edit — the update_schedule tool's validation (UpdateScheduleArgs) and its call (scheduler.update): cron and at
  // clear each other there; silent is not touched.
  if (method === "PATCH" && schedDelMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "schedule_not_over_public_link" }); return true; }
    if (!ctx.scheduler || typeof ctx.scheduler.update !== "function") { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    const id = decodeURIComponent(schedDelMatch[1]);
    (async () => {
      try {
        const body = await parseBody(req);
        if (!permitWebContinuation(req, res, ctx)) return;
        if (scheduleWriterGone()) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.hasOwn(body, "id")) { json(res, 400, { error: "expected the fields to change (the id is the path's)" }); return; }
        const parsed = parseOrReject(UpdateScheduleArgs, { ...(body as Record<string, unknown>), id }, res);
        if (!parsed) return;
        const { id: _id, ...changes } = parsed;
        json(res, 200, ctx.scheduler!.update!(id, changes));
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }
  if (method === "DELETE" && schedDelMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "schedule_not_over_public_link" }); return true; }
    if (!ctx.scheduler) { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    try {
      ctx.scheduler.delete(decodeURIComponent(schedDelMatch[1]));
      json(res, 200, { deleted: true });
    } catch (err) { json(res, 400, { error: (err as Error).message }); }
    return true;
  }

  // #2122: the usage report. Signed-in sessions by default (guests never: not in GUEST_ROUTES); hidden with the rest of
  // usage by web.usage_panel: false; over the public link only when web.usage_report_on_public_link is true. Answered
  // from the ledgers and rollups as they are; a catch-up runs behind. The page's CSV is built from this same answer.
  if (method === "GET" && path === "/ui/usage-report") {
    // Who may have it, asked on arrival and again before it is sent (the report is awaited: a switch turned off, a
    // session signed out or a public link ended meanwhile gets nothing). The same boundary both times, no new gate.
    const refusal = (): [number, string] | null => {
      if (!ctx.usageReport || ctx.fleetConfig?.web?.usage_panel === false) return [404, "Not available"];
      if (gatewayRequestContext(req) && ctx.fleetConfig?.web?.usage_report_on_public_link !== true) return [403, "usage_report_not_over_public_link"];
      return null;
    };
    const first = refusal();
    if (first) { json(res, first[0], { error: first[1] }); return true; }
    const admitted = admissionOf(req, url, ctx);
    if (!admitted) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return true; }
    void import("./usage-report.js").then(({ usageRange, usageGroup }) => ctx.usageReport!({
      range: usageRange(url.searchParams.get("range"), url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined),
      group: usageGroup(url.searchParams.get("group")),
    })).then(
      (report) => {
        const now = refusal();
        if (now) return json(res, now[0], { error: now[1] });
        if (admissionOf(req, url, ctx) !== admitted) return json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE });
        json(res, 200, report);
      },
      (err) => { ctx.logger.error({ err }, "usage report failed"); json(res, 500, { error: "Usage report failed" }); },
    );
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
  // #1918: the org canvas's traffic on opening, and the public link's (which has no stream) on its poll cadence. The
  // fleet works it out at most once every two seconds and caps it, whoever asks how often.
  if (method === "GET" && path === "/ui/traffic") {
    json(res, 200, ctx.trafficSnapshot?.() ?? { now: new Date().toISOString(), items: [] });
    return true;
  }

  if (method === "GET" && path === "/ui/teams") {
    const teams = ctx.fleetConfig?.teams ?? {};
    json(res, 200, { teams });
    return true;
  }

  if (method === "POST" && path === "/ui/teams") {
    // #1689: not over the public link (absent from its manifest too), like editing and deleting a team.
    if (gatewayRequestContext(req)) { json(res, 403, { error: "teams_not_over_public_link" }); return true; }
    (async () => {
      try {
        const body = await parseBody(req);
        if (!permitWebContinuation(req, res, ctx)) return;
        // #1692: who may write, asked again once the body is in (as the edit does).
        const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
        if (verdict.kind !== "allow" || (verdict.via === "session" && verdict.session?.tier !== "admin")) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
        const parsed = parseOrReject(TeamCreateSchema, body, res);
        if (!parsed) return;
        // #1692: the create_team path — members checked, an existing team never overwritten, a failed save undone.
        const r = commitTeamCreate(ctx.fleetConfig as Parameters<typeof commitTeamCreate>[0], parsed, () => ctx.saveFleetConfig());
        if (!r.ok) { json(res, r.status, { error: r.error }); return; }
        json(res, 200, r.result);
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  // #1689: edit a team — the same update as the update_team tool (applyTeamUpdate), from the members the page sends:
  // what to add and remove is worked out against the team as it is now. Never over the public link.
  const teamEditMatch = path.match(/^\/ui\/teams\/(.+)$/);
  if ((method === "PATCH" || method === "PUT") && teamEditMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "teams_not_over_public_link" }); return true; }
    const name = decodeURIComponent(teamEditMatch[1]);
    // Who may write, asked again once the body is in (#1693 review): a session revoked or a token rotated meanwhile
    // writes nothing.
    const writerNow = (): boolean => {
      const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
      return verdict.kind === "allow" && !(verdict.via === "session" && verdict.session?.tier !== "admin");
    };
    (async () => {
      try {
        const body = await parseBody(req);
        if (!permitWebContinuation(req, res, ctx)) return;
        if (!writerNow()) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
        const parsed = parseOrReject(TeamEditSchema, body, res);
        if (!parsed) return;
        const teams = ctx.fleetConfig?.teams;
        const current = teams && Object.hasOwn(teams, name) ? teams[name].members : null;
        if (!current) { json(res, 404, { error: `Team not found: ${name}` }); return; }
        const want = [...new Set(parsed.members)];
        // The update and its save as one: a failed save leaves the team as it was (500).
        const r = commitTeamUpdate(ctx.fleetConfig as Parameters<typeof commitTeamUpdate>[0], {
          name, add: want.filter(m => !current.includes(m)), remove: current.filter(m => !want.includes(m)), description: parsed.description,
        }, () => ctx.saveFleetConfig());
        if (!r.ok) { json(res, r.status, { error: r.error }); return; }
        json(res, 200, { updated: r.result });
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  const teamDelMatch = path.match(/^\/ui\/teams\/(.+)$/);
  if (method === "DELETE" && teamDelMatch) {
    if (gatewayRequestContext(req)) { json(res, 403, { error: "teams_not_over_public_link" }); return true; }
    const name = decodeURIComponent(teamDelMatch[1]);
    // Own keys (#1689): a team is one fleet.yaml defines — "__proto__" or "constructor" is not found.
    if (!ctx.fleetConfig?.teams || !Object.hasOwn(ctx.fleetConfig.teams, name)) { json(res, 404, { error: `Team not found: ${name}` }); return true; }
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
  const arrival = webAuthorityOf(req, new URL(req.url ?? "/", "http://localhost"), ctx);   // #1939 §3: again after the body
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
      // #1920 step 2b: a guest writes only to an in-scope instance, while guests may chat, and never a command.
      const guest = guestRequestOf(req);
      const refused = guestChatRefusal(guest, instance);
      if (refused) { json(res, refused.status, { error: refused.error }); return; }
      if (guest && guestCommandText(typed)) { json(res, 403, { error: "guest_no_commands" }); return; }
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
      // #1827: who is writing — the name agents and chats see, and the id they tell people apart by. Asked now that the
      // body is in: a session revoked meanwhile sends nothing (not as the operator).
      const person = webPersonOf(req, new URL(req.url ?? "/", "http://localhost"), ctx);
      if (!person) { ctx.webFiles?.release(files); json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
      // #1939 S1: what the receipt records about who authorized it (observe only: agents still read web as recognition).
      const { authority } = confirmAfterBody(arrival, webAuthorityOf(req, new URL(req.url ?? "/", "http://localhost"), ctx, instance));
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
      // ClassicBot echo (#1320 part B): same ordering lane, each room's setting (#2054: on unless it says false, or
      // the fleet-wide switch is off for a room that is unset) resolved at send time inside sendClassicWebEcho.
      const canClassicEcho = ctx.isClassicInstance?.(instance) === true && !!ctx.sendClassicWebEcho;
      const settleClassicEcho = canClassicEcho ? ctx.reserveWebChannelEcho?.(instance, async () => {
        const posted = await ctx.sendClassicWebEcho!(instance, formatWebChannelEcho(person.name, preview, t("web.echo_full_text"), { guest: !!guest }), person.name);
        if (posted > 0) ctx.webMessageInChannel?.(instance, messageId);       // #1920 §5.2: the room saw it
      }) : undefined;
      const settleEcho = canEcho ? ctx.reserveWebChannelEcho?.(instance, async () => {
        // A replacement adapter or edited binding is not the route we reserved.
        if ((ctx.getAdapterForInstance ? ctx.getAdapterForInstance(instance) : ctx.adapter) !== syncAdapter
          || (ctx.getGroupIdForInstance?.(instance) ?? String(ctx.fleetConfig?.channel?.group_id ?? "")) !== groupId
          || ctx.fleetConfig?.instances[instance]?.topic_id !== topicId) return;
        const sent = await syncAdapter.sendText(String(groupId), formatWebChannelEcho(person.name, preview, t("web.echo_full_text"), { guest: !!guest }), { threadId: String(topicId), format: "text", allowedMentions: { parse: [] } });
        ctx.webMessageInChannel?.(instance, messageId);                          // #1920 §5.2: the topic saw it
        return sent;
      }) : undefined;
      let delivered: boolean | void;
      try {
        const deliver = (name: string, payload: Record<string, unknown>) => ctx.deliverHumanToInstance
          ? ctx.deliverHumanToInstance(name, payload, webHumanOrigin(false, authority), typed)
          : ctx.deliverToInstance(name, payload);
        delivered = await deliver(instance, {
          type: "fleet_inbound",
          content: delivery.text,
          targetSession: instance,
          meta: {
            chat_id: groupId ? String(groupId) : "",
            message_id: messageId,
            user: person.name, user_id: person.userId,
            ts,
            thread_id: topicId != null ? String(topicId) : "",
            source: "web",
            ...(guest ? { web_guest: "1" } : {}),          // #1920: "[user:… via web (guest), id:…]" (authority none)
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
      // #1666: the same cancel/progress bubble a platform inbound starts, in the topic the echo went to — a second turn
      // on the echo's lane, so the topic reads "echo, then bubble" and a cancel in between drops it (the lane's epoch).
      // Not a copy (#1668): a slow bubble never drops the next message's echo, and a slow echo never drops the bubble.
      if (settleEcho && ctx.startWebChatProgress) {
        const startProgress = ctx.startWebChatProgress.bind(ctx);
        ctx.reserveWebChannelEcho?.(instance, () => startProgress(instance), { copy: false })(true);
      }
      ctx.webFiles?.commit(files);
      ctx.lastInboundUser.set(instance, person.name);
      ctx.eventLog?.logActivity("message", person.name, (message || `[${files.length} file(s)]`).slice(0, 200), instance);
      // #1920: the account that wrote it (a guest sees its own); channel-visible once its copy was sent (above).
      ctx.emitSseEvent("message", { instance, sender: person.name, role: "user", text: message, ts, attachments: files.map(publicAttachment), messageId, ...(person.bound ? { from: person.voterKey } : {}) });
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
 *
 * #1937: streamed to a part file in that inbox (web-pending-….part) as it arrives — never held whole in memory — and
 * counted by the bytes that came, whatever Content-Length said. The limits are the ones in force for this request
 * (uploadLimits(): the config, and the public link's own cap). An upload that goes UPLOAD_STALL_MS without a byte, or
 * runs past UPLOAD_MAX_MS, is dropped; any upload that does not end in a stored file takes its part file with it.
 */
function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext): void {
  const instance = url.searchParams.get("instance") ?? "";
  if (!ctx.webFiles) { json(res, 404, { error: "uploads are not available" }); return; }
  // #1920 step 2b: a guest's upload is for an in-scope instance's message, while guests may chat.
  const guestRefused = guestChatRefusal(guestRequestOf(req), instance);
  if (guestRefused) { req.resume(); json(res, guestRefused.status, { error: guestRefused.error }); return; }
  if (!instance || instance.length > 128 || !safeInstanceSegment(instance) || !ctx.instanceIpcClients.has(instance)) {
    json(res, 404, { error: `Instance not found: ${instance}` });
    return;
  }
  const limits = uploadLimits(ctx.fleetConfig?.web, { publicLink: gatewayRequestContext(req) !== undefined });
  const tooLarge = () => json(res, 413, { error: fileTooLargeText(limits), max_bytes: limits.maxFileBytes, ...(limits.publicLinkCapped ? { public_link: true } : {}) });
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > limits.maxFileBytes) {
    tooLarge();
    req.resume();
    return;
  }
  let part: string, fd: number, discard: () => void;
  try { ({ path: part, fd, discard } = createPartFile(join(getAgendHome(), "workspaces", instance, "inbox"))); } catch (err) {
    ctx.logger.error({ err: (err as Error).message, instance }, "Web upload could not be stored");
    json(res, 500, { error: "the file could not be stored" });
    req.resume();
    return;
  }
  const out = createWriteStream(part, { fd, autoClose: true });
  const sniffer = new UploadSniffer();
  let size = 0;
  let over = false;              // ended without a stored file: no further write, and the part file goes
  let stall: ReturnType<typeof setTimeout> | undefined;
  const clocks = () => { clearTimeout(stall); clearTimeout(deadline); };
  /** Stop here: answer (when the client is still there), remove the part file, and stop a body still arriving. */
  const drop = (answer?: () => void) => {
    if (over) return;
    over = true;
    clocks();
    answer?.();
    out.destroy();
    discard();
    if (!req.complete) req.destroy();
  };
  const armStall = () => { clearTimeout(stall); stall = setTimeout(() => drop(() => json(res, 408, { error: "the upload stalled — attach the file again" })), UPLOAD_STALL_MS); stall.unref?.(); };
  const deadline = setTimeout(() => drop(() => json(res, 408, { error: "the upload took too long — attach the file again" })), UPLOAD_MAX_MS);
  deadline.unref?.();
  armStall();
  out.on("error", (err) => { ctx.logger.error({ err: err.message, instance }, "Web upload could not be stored"); drop(() => json(res, 500, { error: "the file could not be stored" })); });
  out.on("drain", () => { if (!over) req.resume?.(); });
  req.on("data", (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > limits.maxFileBytes) { drop(tooLarge); return; }
    armStall();
    sniffer.push(c);
    if (!out.write(c)) req.pause?.();
  });
  req.on("error", () => drop());                              // the client went away
  req.on("close", () => { if (!over && req.complete === false) drop(); });
  // The instance is checked again now the whole body is here: it may have been deleted (and its files
  // forgotten) or stopped while the upload streamed in; storing now would bring its id back (#1252 review).
  // Still deliverable means: its IPC is up (a paused one is woken by the send) and it is still registered —
  // in fleet.yaml, or as a ClassicBot room in classicBot.yaml. Asked when the body ends and again just before storing.
  const deliverable = () => ctx.instanceIpcClients.has(instance) && (!!ctx.fleetConfig?.instances?.[instance] || ctx.isClassicInstance?.(instance) === true);
  const gone = () => drop(() => json(res, 404, { error: `Instance not found: ${instance}` }));
  req.on("end", () => {
    if (over) return;
    clocks();
    if (!permitWebContinuation(req, res, ctx)) { drop(); return; }
    const name = displayName(typeof req.headers["x-agend-filename"] === "string" ? req.headers["x-agend-filename"] : "", "file");
    const type = sniffer.result(name);
    if (!type) { drop(() => json(res, 415, { error: "the file is empty" })); return; }
    if (!deliverable()) { gone(); return; }
    out.end(() => {
      if (over) return;
      // The write's finish is another wait (Prism #1941 P2-1): the session or the public link may have ended in it.
      if (!permitWebContinuation(req, res, ctx)) { drop(); return; }
      if (!deliverable()) { gone(); return; }
      over = true;
      try {
        const entry = ctx.webFiles!.storeUploadedFile({ instance, partPath: part, name, type });
        json(res, 200, publicAttachment(entry));
      } catch (err) {
        discard();
        ctx.logger.error({ err: (err as Error).message, instance }, "Web upload could not be stored");
        json(res, 500, { error: "the file could not be stored" });
      }
    });
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
/**
 * #1723: a public-link page's preview: where it may frame from (`frameSrc` — the quick-tunnel wildcard while its own
 * preview tunnel is starting or up, the exact origin for a configured web.preview_origin, null for none) and, once
 * the preview tunnel failed, why (`detail`, a fixed reason the page words).
 */
export type PublicPreviewForUi = PreviewAvailability & { boot: string | null; frameSrc: string | null; detail?: string };

export interface AppShellContext {
  /** #2118: independent trusted opaque effect document, never HTML-preview consent or listener state. */
  readonly effectBoot?: string;
  previewForUi?(hostHeader: string | undefined, secure: boolean): (PreviewAvailability & { boot: string | null }) | null;
  publicPreviewForUi?(exposureId: string, dashboardOrigin: string): PublicPreviewForUi;
  /** #1523 N3: `web.usage_panel` — the header's ◔ is offered unless it is false (the page needs no probe read for it). */
  readonly fleetConfig?: { web?: { usage_panel?: boolean; log_tab?: boolean; upload_max_file_mb?: number; upload_max_total_mb?: number } } | null;
  /** #1665: the host's theme and language go into the page itself, so a device paints them before any script reads. */
  readonly webPrefs?: WebPrefsStore;
  /** #1629 r4 §3: which owner CSS this load's person has in force (data-owner-css), for a signed-in human session only. */
  readonly ownerCss?: OwnerCssStore;
  readonly webToken?: string | null;
  readonly webSessions?: WebApiContext["webSessions"];
  /** #1920 phase 3: a guest's page says who it is signed in as (its web name and platform), for its "Guest" chip. */
  guestBadge?(owner: WebAccount): { name: string; platform: string };
}
export type AppShellMode = "full" | "view-only";

function shellPreview(req: IncomingMessage, ctx: AppShellContext, mode: AppShellMode): ((PreviewAvailability & { boot: string | null }) & { frameSrc?: string | null; detail?: string }) | null {
  if (mode !== "full") return null;
  // #1723: a page of the public link asks its own exposure's preview — never the local listener's Host-based choice.
  const gateway = gatewayRequestContext(req);
  if (gateway) return ctx.publicPreviewForUi?.(gateway.exposureId, gateway.expectedOrigin) ?? null;
  return ctx.previewForUi?.(typeof req.headers.host === "string" ? req.headers.host : undefined, isSecureRequest(req)) ?? null;
}
/**
 * #1589: an audio/video file, by id (the ledger re-checks the file on every read). One `Range: bytes=a-b`, `a-` or `-n`
 * → 206 with at most MEDIA_RANGE_MAX bytes and its Content-Range (a player asks again for the rest); past the end → 416.
 * No Range, several, or one not in that form → 200 with the whole file, as every file is served (the Download link).
 * Inline, nosniff, no caching, and the route's own sandbox policy, as for every file.
 */
/** #1937: a whole file (headers already set) streamed from the descriptor its checks were made on: 200, its length. */
function streamWhole(res: ServerResponse, opened: { file: ServedFile; fd: number }): void {
  res.setHeader("Content-Length", String(opened.file.size));
  res.writeHead(200);
  const stream = createReadStream("", { fd: opened.fd, start: 0, end: Math.max(0, opened.file.size - 1), autoClose: true });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function serveMediaRange(req: IncomingMessage, res: ServerResponse, files: WebFileLedger, id: string, file: ServedFile): void {
  const total = file.size;
  const header = typeof req.headers.range === "string" ? req.headers.range.trim() : "";
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  let start = 0, end = total - 1;
  const ranged = !!m && (m[1] !== "" || m[2] !== "");
  if (ranged) {
    if (m[1] === "") { const n = Number(m[2]); start = Math.max(0, total - n); }
    else { start = Number(m[1]); if (m[2] !== "") end = Number(m[2]); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) {
      res.setHeader("Content-Range", `bytes */${total}`);
      json(res, 416, { error: "Range not satisfiable" });
      return;
    }
  }
  end = ranged ? Math.min(end, total - 1, start + MEDIA_RANGE_MAX - 1) : total - 1;
  const mediaHeaders = () => {
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(wellFormed(file.name))}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  };
  // #1937 (Prism #1941 P3-2): the whole of a file over MEDIA_RANGE_MAX (no Range asked) streams, as /ui/file's do.
  if (!ranged && total > MEDIA_RANGE_MAX) {
    const opened = files.open(id);
    if (!opened) { json(res, 404, { error: "No such file" }); return; }
    mediaHeaders();
    streamWhole(res, opened);
    return;
  }
  const got = files.readSlice(id, start, end);
  if (!got || (!ranged && got.bytes.length !== total)) { json(res, 404, { error: "No such file" }); return; }
  mediaHeaders();
  if (ranged) res.setHeader("Content-Range", `bytes ${got.start}-${got.end}/${total}`);
  res.setHeader("Content-Length", String(got.bytes.length));
  res.writeHead(ranged ? 206 : 200);
  res.end(got.bytes);
}

/**
 * #1665: `<html>` carrying the host's preferences (data-prefs: `{"rev":n,"values":{…}}`, attribute-escaped). theme.js (a
 * blocking script in <head>) and the app's dictionary take the theme and language from it over the browser's cache,
 * and app-prefs.js copies every value into that cache before any panel reads it — so no device paints a stale theme
 * or replays a tour already seen, a new device included. Only for the signed-in app (the public link reads what is in
 * force too); the anonymous View reader and the sign-in page keep the browser's own.
 */
type PrefsViewer = { person: string | null; epoch: string | null; scope: "none" | "person" | "operator"; canWrite: boolean; via: string; guest?: boolean; owner?: WebAccount };
function prefsViewer(req: IncomingMessage, url: URL, ctx: Partial<Pick<WebApiContext, "webToken" | "webSessions">>): PrefsViewer | null {
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (v.kind !== "allow") return null;
  // #1920: a guest is a guest on every listener. The public link's page and reads too — before, a guest signed in through
  // it (#2094) read the host's preferences unfiltered: the sidebar's order and favourites, naming instances out of its
  // scope. Its account (phase 3) names it on its page.
  const guest = v.via === "session" && v.session?.tier === "guest" ? { guest: true, ...(v.session.owner ? { owner: v.session.owner } : {}) } : {};
  if (!gatewayRequestContext(req) && v.via === "session" && v.session) {
    const person = webPersonKey(v.session.owner);
    return { person, epoch: v.session.handle, scope: person === OPERATOR ? "operator" : "person", canWrite: v.session.tier === "admin", via: "session", ...guest };
  }
  return { person: null, epoch: null, scope: "none", canWrite: v.via !== "session" || v.session?.tier === "admin", via: v.via, ...guest };
}
const prefsScope = (v: PrefsViewer | null) => ({ ownerScope: v?.scope ?? "none", ownerEpoch: v?.epoch ?? null });
// #1920: a guest reads the host's look and its own, never a preference that names an instance (guestPrefs).
const prefsView = (prefs: WebPrefsStore, v: PrefsViewer | null) => {
  const view = { ...prefs.readForViewer(v?.person ?? null), ...prefsScope(v) };
  return v?.guest ? guestPrefs(view) : view;
};
function shellHtmlTag(ctx: AppShellContext, mode: AppShellMode, viewer: PrefsViewer | null): string {
  if (mode !== "full" || !ctx.webPrefs) return '<html lang="en">';
  const view = prefsView(ctx.webPrefs, viewer);
  const lang = view.values.lang === "zh-TW" ? "zh-Hant" : "en";
  const attr = (v: string) => v.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `<html lang="${lang}" data-prefs="${attr(JSON.stringify(view))}">`;
}

/**
 * #1629 r4 §3: the owner CSS this load links (its sha), or null. Only the full app of a signed-in human session — never
 * the public link, the anonymous View reader, the CLI's header token or the sign-in and setup pages (other panels).
 */
function shellOwnerCss(ctx: AppShellContext, mode: AppShellMode, viewer: PrefsViewer | null): string | null {
  return mode === "full" && !viewer?.guest && viewer?.person !== null && viewer?.person !== undefined && ctx.ownerCss ? ctx.ownerCss.active(viewer.person) : null;
}

function guestBodyAttrs(ctx: AppShellContext, owner: WebAccount, attr: (v: string | null | undefined) => string): string {
  const badge = ctx.guestBadge?.(owner);
  return ` data-tier="guest"${badge ? ` data-guest-name="${attr(badge.name)}" data-guest-platform="${attr(badge.platform)}"` : ""}`;
}
/** A separate session fence for Chat playback: public/guest viewers acquire no owner-pref identity. */
function shellEffect(req: IncomingMessage, ctx: AppShellContext, mode: AppShellMode): { boot: string; epoch: string; scope: "owner" | "chat" } | null {
  if (mode !== "full" || typeof ctx.effectBoot !== "string" || !/^[0-9a-f]{32}$/.test(ctx.effectBoot)) return null;
  const v = evaluateWebRequest(req as unknown as WebGateRequest, new URL(req.url ?? "/", "http://localhost"), ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (v.kind !== "allow" || v.via !== "session" || !v.session || !/^[a-f0-9]{16}$/.test(v.session.handle)) return null;
  return { boot: ctx.effectBoot, epoch: v.session.handle, scope: gatewayRequestContext(req) || v.session.tier === "guest" ? "chat" : "owner" };
}
function shellBodyTag(req: IncomingMessage, ctx: AppShellContext, mode: AppShellMode, viewer: PrefsViewer | null): string {
  const p = shellPreview(req, ctx, mode);
  const ownerCss = shellOwnerCss(ctx, mode, viewer), effect = shellEffect(req, ctx, mode);
  let ownerCssState: "off" | "on" | "unknown" = mode === "full" && (gatewayRequestContext(req) || viewer?.guest) ? "off" : "unknown";
  if (mode === "full" && !viewer?.guest && viewer?.person != null && ctx.ownerCss) {
    ownerCssState = ctx.ownerCss.effectState(viewer.person);
    if (ownerCssState === "off" && ownerCss !== null || ownerCssState === "on" && ownerCss === null) ownerCssState = "unknown";
  }
  const attr = (v: string | null | undefined) => String(v ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return `<body data-mode="${mode}"${mode === "full" && gatewayRequestContext(req) ? ' data-web-transport="poll"' : ""} data-dashboard-origin="${attr(p?.dashboardOrigin)}" data-preview-origin="${attr(p?.previewOrigin)}"`
    + `${effect ? ` data-effect-boot="${effect.boot}" data-effect-epoch="${effect.epoch}" data-effect-scope="${effect.scope}"` : ""}`
    + ` data-preview-boot="${attr(p?.previewOrigin ? p.boot : "")}" data-preview-reason="${attr(p ? p.reason : "Previews are not available on this fleet.")}"`
    // #1554: no availability asked (the public link, or not the full app) still says why, in the page's language.
    + ` data-preview-reason-code="${attr(p ? p.code ?? "" : gatewayRequestContext(req) ? "publicLink" : "notOffered")}"`
    // #1723: why the public link's preview tunnel failed (a fixed reason the page words), when it did.
    + `${p?.detail ? ` data-preview-detail="${attr(p.detail)}"` : ""}`
    // #1523 N3: whether the fleet serves /api/ai-usage (web.usage_panel), for every page's ◔ — never to a guest (#1920).
    + ` data-usage-panel="${ctx.fleetConfig?.web?.usage_panel === false || viewer?.guest ? "0" : "1"}"`
    // #1218: whether the Log tab is on (web.log_tab; off by default): the tab says so and offers to turn it on.
    + ` data-log-tab="${ctx.fleetConfig?.web?.log_tab === true ? "1" : "0"}"`
    // #1937: the upload limits in force for this page (the config's; the public link's own cap on it) — what the chat
    // checks before sending a file, and the numbers its words say. The server checks again on every upload.
    + ` data-upload-limits="${attr(JSON.stringify(uploadLimits(ctx.fleetConfig?.web, { publicLink: gatewayRequestContext(req) !== undefined })))}"`
    // #1770: the fleet's zone (chat-logs' and fleet.log's), in which the chat reads its message times and days.
    + ` data-fleet-tz="${attr(resolveTz())}"`
    // #1629 r4 §3: the person's owner CSS in force (a sha), linked by the page unless this device or this load says not.
    + ` data-owner-css-state="${ownerCssState}"${ownerCss ? ` data-owner-css="${attr(ownerCss)}"` : ""}`
    // #1589: the public link shows attachments as downloads only (no inline text or media): its scope is unchanged.
    + `${gatewayRequestContext(req) ? ' data-public-link="1"' : ""}`
    // #1920 phase 3: a guest's page — the shell shows only what a guest may use, and who it is signed in as.
    + `${mode === "full" && viewer?.guest && viewer.owner ? guestBodyAttrs(ctx, viewer.owner, attr) : ""}>`;
}
/** The app shell page for one entry, under the panels' CSP; it may frame exactly <preview origin>/frame, and only
 *  when this load chose one. */
export function serveAppShell(req: IncomingMessage, res: ServerResponse, ctx: AppShellContext, mode: AppShellMode): void {
  try {
    const html = readFileSync(join(__dirname, "ui", "app.html"), "utf-8");
    const viewer = mode === "full" ? prefsViewer(req, new URL(req.url ?? "/", "http://localhost"), ctx) : null;
    const p = shellPreview(req, ctx, mode);
    // #1589: media plays only from this listener's own file route (path-scoped, like frame-src), at the address this page
    // was loaded from (a Host the host guard accepted); never on the public link, nor where no chat is shown.
    const own = mode === "full" && !gatewayRequestContext(req)
      ? dashboardOriginFor(typeof req.headers.host === "string" ? req.headers.host : undefined, isSecureRequest(req)) : null;
    const mediaSrc = own ? `${own}/ui/file/` : "'none'";
    // A public-link page frames what its exposure's preview names (the quick-tunnel wildcard: its host is not known when
    // the page may load); every other page frames exactly the origin this load chose (#1723).
    const previewFrames = p && "frameSrc" in p ? p.frameSrc : p?.previewOrigin ? `${p.previewOrigin}/frame` : null;
    // This fixed trusted document is independent of HTML preview. Its own response confines all Worker execution.
    const effectOrigin = gatewayRequestContext(req)?.expectedOrigin ?? dashboardOriginFor(typeof req.headers.host === "string" ? req.headers.host : undefined, isSecureRequest(req));
    const effectFrame = shellEffect(req, ctx, mode) && effectOrigin ? `${effectOrigin}/effect-bootstrap` : null;
    const frameSrc = [previewFrames, effectFrame].filter(Boolean).join(" ");
    sendPanelHtml(res, html.replace('<html lang="en">', shellHtmlTag(ctx, mode, viewer)).replace("<body>", shellBodyTag(req, ctx, mode, viewer)), 200, {}, { ...(frameSrc ? { frameSrc } : {}), mediaSrc });
  } catch {
    json(res, 500, { error: "app.html not found" });
  }
}
