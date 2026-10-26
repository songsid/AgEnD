import { canvasWorkerEnabled, CANVAS_WORKER_EXPERIMENTAL_MESSAGE } from "./web-experimental.js";
import { isCanvasWorkerHttpPath } from "./web-experimental-http.js";
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
import { APP_ICON_MAX_BYTES, type AppIconStore } from "./web-app-icon.js";
import { withAppIconLinks } from "./web-icons.js";
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
import type { OfficeStore, OfficeWriteLimiter } from "./web-office-store.js";
import { SKIN_WIRE_BYTES, type OfficeSkinStore } from "./web-office-skins.js";
import type { OfficeActs } from "./web-office-acts.js";
import type { OfficePackTools } from "./web-office-pack-tools.js";
import type { WebAppearance } from "./web-appearance.js";
import { gatewayRequestContext } from "./web-request-context.js";
import { crossInstanceVisibility } from "./cross-instance-notice.js";
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
import { ROUTE_WORKER_CSP, ROUTE_WORKER_PATH, sendPanelHtml } from "./web-host-guard.js";
import { libavoidFile } from "./web-libavoid.js";
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
import { CARD_PRIORITIES, CARD_SIZES, CARD_STATUSES, TaskBoardError, type Actor as BoardActor, type TaskBoard } from "./scheduler/task-board.js";
import { readStatuslineModel, resolveInstanceContext } from "./topic-commands.js";
import { z } from "zod";
import { evaluateWebRequest, isPassiveWebRead, isSecureRequest, isWebRequestAuthorized, WEB_TOKEN_INVALID_MESSAGE, type WebGateRequest } from "./web-auth.js";
import { dashboardOriginFor, type PreviewAvailability } from "./web-preview.js";
import { WEB_CHAT_CARDS_OVERFLOW, newWebMessageId, parseLastEventId, webChatReplyRef, webChatReplyText, type WebChatHistory, type WebChatMessage, type WebChatPost } from "./web-chat-history.js";
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
import { QUERY_MAX_CHARS, RESULT_MAX, SEARCH_SOURCES } from "./search/search-store.js";
import { xmsgShown } from "./search/search-docs.js";
import { WebSendDedupe, type WebSendClaim } from "./web-send-dedupe.js";

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
  // A status the task board knows: each carries its rules now (scheduler/task-board.ts).
  status: z.enum(CARD_STATUSES).optional(),
  title: z.string().max(512).optional(),
  description: z.string().max(MAX_TEXT).optional(),
  priority: z.string().max(64).optional(),
}).strict();

// The task board (scheduler/task-board.ts). Coarse bounds here; the board checks each field's own limit.
const BOARD_TEXT = 8_192;
const CardRef = z.string().min(1).max(64);
/** Who handed a card out: an instance, the person writing ({ kind: "person" }), or nobody. */
const DispatcherSchema = z.union([z.object({ kind: z.literal("instance"), name: z.string().min(1).max(128) }).strict(), z.object({ kind: z.literal("person") }).strict()]).nullable();
const CardCreateSchema = z.object({
  kind: z.enum(["main", "sub"]).optional(),
  project: z.union([z.number().int(), z.string().max(256)]).nullable().optional(),
  parent: CardRef.nullable().optional(),
  title: z.string().max(512),
  goal: z.string().max(BOARD_TEXT).optional(),
  scope: z.string().max(BOARD_TEXT).optional(),
  acceptance: z.array(z.string().max(1024)).max(50).optional(),
  context: z.string().max(BOARD_TEXT).optional(),
  size: z.enum(CARD_SIZES).nullable().optional(),
  priority: z.enum(CARD_PRIORITIES).optional(),
  dependsOn: z.array(CardRef).max(50).optional(),
  assignee: z.string().max(128).nullable().optional(),
  dispatcher: DispatcherSchema.optional(),
  needsReview: z.boolean().optional(),
}).strict();

const CardPatchSchema = z.object({
  version: z.number().int().optional(),
  title: z.string().max(512).optional(),
  goal: z.string().max(BOARD_TEXT).optional(),
  scope: z.string().max(BOARD_TEXT).optional(),
  context: z.string().max(BOARD_TEXT).optional(),
  state: z.string().max(BOARD_TEXT).optional(),
  result: z.string().max(BOARD_TEXT).optional(),
  blockedReason: z.string().max(BOARD_TEXT).optional(),
  size: z.enum(CARD_SIZES).nullable().optional(),
  priority: z.enum(CARD_PRIORITIES).optional(),
  assignee: z.string().max(128).nullable().optional(),
  dispatcher: DispatcherSchema.optional(),
  needsReview: z.boolean().optional(),
  dependsOn: z.array(CardRef).max(50).optional(),
  acceptance: z.array(z.string().max(1024)).max(50).optional(),
  addAcceptance: z.array(z.string().max(1024)).max(50).optional(),
  check: z.array(z.number().int()).max(50).optional(),
  uncheck: z.array(z.number().int()).max(50).optional(),
  projectId: z.number().int().nullable().optional(),
  log: z.string().max(BOARD_TEXT).optional(),
  comment: z.string().max(MAX_TEXT).optional(),
}).strict();

const CardMoveSchema = z.object({
  to: z.enum(CARD_STATUSES),
  reason: z.string().max(BOARD_TEXT).optional(),
  result: z.string().max(BOARD_TEXT).optional(),
  comment: z.string().max(MAX_TEXT).optional(),
  version: z.number().int().optional(),
}).strict();

const CardReorderSchema = z.object({ after: CardRef.nullable().optional(), before: CardRef.nullable().optional() }).strict();

const ProjectCreateSchema = z.object({ name: z.string().max(256), description: z.string().max(BOARD_TEXT).optional(), leadInstance: z.string().max(256).nullable().optional() }).strict();

/** #2352: a project's lead must be one of the fleet's instances now (the board keeps any name, as for an assignee). */
function checkLeadIsInstance(ctx: WebApiContext, lead: string | null | undefined): void {
  const name = lead?.trim();
  if (name && !(ctx.fleetConfig?.instances && Object.hasOwn(ctx.fleetConfig.instances, name))) {
    throw new TaskBoardError("invalid", `"${name.slice(0, 64)}" is not one of the fleet's instances`, "lead_not_instance");
  }
}

const ProjectPatchSchema = z.object({
  name: z.string().max(256).optional(),
  description: z.string().max(BOARD_TEXT).optional(),
  archived: z.boolean().optional(),
  /** #2352: the instance whose channel lists the project's waiting cards (null or "": General). */
  leadInstance: z.string().max(256).nullable().optional(),
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
  /** #2272: the message of this chat this one replies to — its row only; the server reads what it quotes. */
  replyTo: z.object({ boot: z.string().regex(/^[0-9a-f]{1,32}$/), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  /** The sending page's own id for its pending bubble: echoed on the live event only (never recorded), so that page
   *  swaps its "sending" bubble for the real one even when the stream beats this answer. */
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
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
 * The task board's rule over the public link: an instance kept out of sight (cross_instance_visibility: hidden) is not
 * shown, nor a card that names one as its assignee, creator or dispatcher. Off the link nothing is hidden. Read when
 * asked: the fleet's config as it is now.
 */
function boardHiding(ctx: WebApiContext, gateway: boolean) {
  const fleet = ctx.fleetConfig as Parameters<typeof crossInstanceVisibility>[0];
  const hiddenName = (n: unknown) => gateway && typeof n === "string" && !!n && !!ctx.fleetConfig?.instances?.[n] && crossInstanceVisibility(fleet, n) === "hidden";
  const hidden = (c: { assignee: string | null; createdBy: string; dispatcher: { name: string } | null }) => [c.assignee, c.createdBy, c.dispatcher?.name].some(hiddenName);
  return { hiddenName, hidden };
}

/**
 * Chat history as the public link may see it (#2341 review): a status line that names board cards (the daily summary)
 * is withheld while one of them is hidden there now — or no longer on the board — read when asked, so a card hidden
 * after the line was written is withheld too. Off the link, as is. The cards are read in one query per answer.
 */
function visibleMessages<T extends { cards?: string[] }>(ctx: WebApiContext, gateway: boolean, messages: T[]): T[] {
  if (!gateway) return messages;
  // #2341 review r2: a line that named too many cards to keep them all is withheld whole.
  messages = messages.filter((m) => !(m.cards ?? []).includes(WEB_CHAT_CARDS_OVERFLOW));
  const named = [...new Set(messages.flatMap((m) => m.cards ?? []))];
  if (!named.length) return messages;
  const board = ctx.scheduler?.db.board;
  const { hidden } = boardHiding(ctx, true);
  let found: Map<string, Parameters<typeof hidden>[0]>;
  try { found = new Map((board ? board.cardsByCode(named) : []).map((c) => [c.code, c])); } catch { found = new Map(); }
  const withheld = new Set(named.filter((code) => { const c = found.get(code); return !c || hidden(c); }));
  return messages.filter((m) => !(m.cards ?? []).some((code) => withheld.has(code)));
}

/**
 * Needs you as the public link may see it (#2306 review): a task item whose card the board hides there — or a card
 * the board no longer has — is left out, with its title and question; everything else as listed. Off the link, as is.
 * The link reads Needs you by /ui/poll only: its page has no stream (/ui/events answers it 404).
 */
function visibleNeeds(ctx: WebApiContext, gateway: boolean, items: unknown[]): unknown[] {
  if (!gateway) return items;
  const board = ctx.scheduler?.db.board;
  const { hidden } = boardHiding(ctx, true);
  return items.filter((i) => {
    const item = i as { type?: unknown; card?: { code?: unknown } };
    if (item.type !== "task") return true;
    const code = item.card?.code;
    if (!board || typeof code !== "string") return false;
    try { const card = board.findCard(code); return !!card && !hidden(card); } catch { return false; }
  });
}


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
  /** #2233: dashboard-started backend sign-ins (FleetManager); absent in a hand-built context. */
  readonly webBackendLogins?: import("./web-backend-login.js").WebBackendLogins;
  readonly browserBackendSignIns?: import("./browser-backend-signins.js").BrowserBackendSignIns;
  /** #2233: Settings → Agents' sign-in list (FleetManager.backendSignInTargets). */
  backendSignInTargets?(): import("./web-backend-login.js").SignInTarget[];
  readonly dataDir: string;
  readonly sseClients: Set<ServerResponse>;
  readonly fleetConfig: {
    channel?: { group_id?: number | string; mode?: string };
    health_port?: number;
    web?: { experimental?: { canvas_worker?: boolean }; echo_to_channel?: boolean; usage_panel?: boolean; usage_report_on_public_link?: boolean; upload_max_file_mb?: number; upload_max_total_mb?: number; search?: { enabled?: boolean; public_link?: boolean } };
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
  sendClassicWebEcho?(instance: string, text: string, sender?: string, copies?: import("./web-reactions.js").WebEchoCopy[], reply?: { posts: readonly WebChatPost[]; text: string }): Promise<number>;
  /** #1920 §5.2: a web message's channel copy was sent — guests of that channel may see it now. */
  /** #2305: `copies`, the copies' own message ids, so a reaction to the web message is put on them too. */
  webMessageInChannel?(instance: string, messageId: string, copies?: readonly import("./web-reactions.js").WebEchoCopy[]): void;
  /** false: definitely not delivered (the instance's IPC is gone, or it was restarted meanwhile). */
  deliverToInstance(instanceName: string, payload: Record<string, unknown>, options?: { stillCurrent?: () => boolean }): Promise<boolean | void>;
  deliverHumanToInstance?(instanceName: string, payload: Record<string, unknown>, origin: HumanOrigin, originalBody: string, options?: { stillCurrent?: () => boolean }): Promise<boolean | void>;
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
  /** #2293: the global search index (null or absent: off — web.search.enabled false — or not started). */
  readonly searchIndex?: Pick<import("./search/search-index.js").SearchIndex, "query" | "context" | "status"> | null;
  /** #2293: whose cross-instance messages search leaves out now (cross_instance_visibility "hidden"; see searchVisibility). */
  searchVisibility?(): import("./search/search-docs.js").XmsgVisibility;
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
  /** #2308: the person's own app icon; changed by a signed-in admin only (never the public link, a guest or the token). */
  readonly appIcon?: AppIconStore;
  /** #1629: every instance's theme (web-themes.json), read by the page; a person's reset and lock. */
  readonly themeStore?: ThemeStore;
  /** Fleet → Org chart → Office: the offices people made (web-offices.json); absent: /ui/offices is not offered. */
  readonly officeStore?: OfficeStore;
  /** How often a person may save the offices (absent: no limit, as in a test without it). */
  readonly officeWrites?: OfficeWriteLimiter;
  /** #2578: the agents' live acts in the Office view (office_set); absent: /ui/office-acts is not offered. */
  readonly officeActs?: Pick<OfficeActs, "live">;
  /** #2636: Office share links (office-share-service.ts): the open ones, making and ending one. */
  readonly officeShares?: {
    enabled(): boolean;
    list(): import("./office-share.js").OfficeShare[];
    create(opts: { office: string; minutes?: number; text?: boolean; owner: string }): Promise<import("./office-share-service.js").OfficeShareMade>;
    revoke(id: string): number;
  };
  /** #2636: a share was made or ended from the page — said in General (who, which office, until when). */
  officeShareNotice?(event: "created" | "revoked", who: string, share: import("./office-share.js").OfficeShare | null, count: number): void;
  /** #2692: the agents' skin-pack changes (approval mode, pending changes, log); absent: /ui/office-pack-changes is not offered. */
  readonly officePackTools?: Pick<OfficePackTools, "changes" | "setApproval" | "decide">;
  /** #2513: the Office view's uploaded skin packs (web-office-skins/); absent: /ui/office-skins is not offered. */
  readonly officeSkins?: OfficeSkinStore;
  /** How often a person may upload or delete a skin pack (absent: no limit). */
  readonly officeSkinWrites?: OfficeWriteLimiter;
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
  startInstance(name: string, config: unknown, topicMode: boolean, kind?: "fleet-topic" | "classic", resumePaused?: boolean): Promise<void>;
  stopInstance(name: string): Promise<{ backgroundWorkEnded: boolean }>;
  /** The fleet prompts open on the dashboard (web track C4); absent: none are offered. */
  listWebPrompts?(): unknown[];
  /** #1386: everything waiting on the person, every world (the web is global). */
  needsYouItems?(): unknown[];
  /** #1389: the org chart's structure (fleet.yaml's teams, General, descriptions, thread links); absent: an empty chart. */
  orgChart?(): unknown;
  /** #1918: in-flight and recently finished cross-instance traffic, bounded (fleet-traffic.ts). */
  trafficSnapshot?(): { now: string; items: unknown[]; delegations?: unknown[] };
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
  /** `text`: #2675 — the typed answer, for the one action the page shows a text box for. */
  clickWebPrompt?(instance: string, nonce: string, action: string, text?: string): Promise<{ status: number; error?: string }>;
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
      createTask(params: { title: string; description?: string; priority?: string; assignee?: string; created_by: string }, by?: BoardActor): unknown;
      updateTask(id: string, params: Record<string, unknown>, by?: BoardActor): unknown;
      claimTask(id: string, assignee: string, by?: BoardActor): unknown;
      completeTask(id: string, result?: string, by?: BoardActor): unknown;
      /** The task board on the same table (scheduler/task-board.ts); absent in a hand-built context. */
      board?: TaskBoard;
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
  jsonText(res, status, JSON.stringify(data));
}

/** A JSON answer already serialized (a body kept for reuse). */
function jsonText(res: ServerResponse, status: number, body: string): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(body);
}

/**
 * #2296: the last dashboard board read, serialized, per board: its key (revision, done=all, minute) and body. One per
 * board (the newest revision replaces the previous), so it holds one board's JSON at most.
 */
const boardBodies = new WeakMap<object, { key: string; body: string }>();
/** #2316 review: the same for who works on what (GET /ui/tasks/work), per (revision, names asked for). */
const workBodies = new WeakMap<object, { key: string; body: string }>();

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
 * #2308: the app icon. GET: its state, for the settings card (a signed-in person's session). PUT (one PNG, at most
 * 5 MiB) and DELETE (back to the bundled icon): a signed-in admin's session only — never the CLI's token, a read-only
 * session, a guest or the public link; checked again once the body has arrived.
 */
/** An app icon refusal as the page reads it: its code, the English detail and, when named, the detail's key (#2390). */
function appIconRefusal(r: { error: string; detail?: string; detail_key?: string; detail_args?: Array<string | number> }): Record<string, unknown> {
  return { error: r.error, ...(r.detail ? { detail: r.detail } : {}), ...(r.detail_key ? { detail_key: r.detail_key } : {}), ...(r.detail_args ? { detail_args: r.detail_args } : {}) };
}
function handleAppIcon(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, method: string): boolean {
  const store = ctx.appIcon;
  if (!store) { json(res, 404, { error: "app_icon_not_kept", detail: "The app icon is not kept on this fleet" }); return true; }
  const reading = method === "GET" || method === "HEAD";
  if (!reading && method !== "PUT" && method !== "DELETE") { res.setHeader("Allow", "GET, PUT, DELETE"); json(res, 405, { error: "method not allowed" }); return true; }
  if (gatewayRequestContext(req)) { json(res, reading ? 404 : 403, { error: "app_icon_not_over_public_link" }); return true; }
  const who = (): { person: string } | { status: number; error: string } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401, error: WEB_TOKEN_INVALID_MESSAGE };
    if (verdict.via !== "session" || !verdict.session || verdict.session.tier === "guest") return { status: 403, error: "app_icon_needs_a_signed_in_person" };
    if (!reading && verdict.session.tier !== "admin") return { status: 403, error: "app_icon_admin_only" };
    return { person: webPersonKey(verdict.session.owner) };
  };
  const first = who();
  if ("status" in first) { json(res, first.status, { error: first.error }); return true; }
  const state = () => { const s = store.current(); return s ? { custom: true, version: s.version, updatedAt: s.updatedAt } : { custom: false, version: "default", updatedAt: null }; };
  if (reading) { json(res, 200, state()); return true; }
  if (method === "DELETE") {
    const reset = store.reset();
    if (!reset.ok) { json(res, reset.status, appIconRefusal(reset)); return true; }
    json(res, 200, state());
    return true;
  }
  // Still allowed, still answering, the store still open: asked after each await (the body; the conversion).
  const again = (): string | null => {
    if (!permitWebContinuation(req, res, ctx)) return null;
    if (res.destroyed) return null;
    const now = who();
    if ("status" in now) { json(res, now.status, { error: now.error }); return null; }
    return now.person;
  };
  (async () => {
    let bytes: Buffer;
    try { bytes = await readBoundedWebBody(req, APP_ICON_MAX_BYTES); } catch { json(res, 413, { error: "app_icon_too_large", detail: "at most 5 MiB", detail_key: "max_size", detail_args: [5] }); return; }
    if (!again()) return;
    // #2308 review: decoding and making the sizes is seconds of CPU at worst — a worker thread's, not the fleet loop's.
    const prepared = await store.prepare(bytes);
    if (!prepared.ok) { json(res, prepared.status, appIconRefusal(prepared)); return; }
    const person = again();
    if (!person) return;
    const saved = store.commit(prepared.prepared, person);
    if (!saved.ok) { json(res, saved.status, appIconRefusal(saved)); return; }
    json(res, 200, state());
  })().catch((err) => {
    ctx.logger.error({ err: (err as Error).message }, "App icon request failed");
    try { json(res, 500, { error: "app_icon_failed", detail: "App icon request failed" }); } catch { /* already answered */ }
  });
  return true;
}

/**
 * #2636: Office share links — GET /ui/office-share (the open ones, and whether this fleet offers them), POST { office,
 * minutes?, text? } (a new one; answers its URL once its tunnel is up, or why not), DELETE /ui/office-share/<id|all>.
 * An admin session only — on the dashboard reached directly, or (the user, #2636 follow-up) a fleet admin signed in over
 * the /web public link: the same check either way. Never the CLI token, a read-only session or a guest. The share's own
 * tunnel and gateway stay apart from /web's. The person is asked again once the body is in.
 */
function handleOfficeShare(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  const service = ctx.officeShares;
  if (!service) { json(res, 404, { error: "Office share links are not kept on this fleet" }); return true; }
  const one = /^\/ui\/office-share\/([0-9a-f]{8}|all)$/.exec(path);
  const known = (method === "GET" && path === "/ui/office-share") || (method === "POST" && path === "/ui/office-share") || (method === "DELETE" && !!one);
  if (!known) { json(res, 404, { error: "not found" }); return true; }
  const who = (): { person: string; name: string } | { status: number } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401 };
    if (verdict.via !== "session" || verdict.session?.tier !== "admin") return { status: 403 };
    const owner = verdict.session.owner;
    return { person: owner ? webPersonKey(owner) : "admin-session", name: owner ? ctx.webPerson?.(owner)?.name ?? owner.userId : "admin" };
  };
  const refuse = (status: number) => json(res, status, { error: status === 401 ? WEB_TOKEN_INVALID_MESSAGE : "office_share_needs_an_admin_session" });
  const first = who();
  if ("status" in first) { refuse(first.status); return true; }
  res.setHeader("Cache-Control", "no-store");
  if (method === "GET") {
    // Each with its office's name as it is now (Settings' card has no office list of its own).
    const names = new Map((ctx.officeStore?.list().offices ?? []).map(o => [o.id, o.name]));
    json(res, 200, { enabled: service.enabled(), shares: service.list().map(s => ({ ...s, ...(names.has(s.office) ? { office_name: names.get(s.office) } : {}) })) });
    return true;
  }
  if (method === "DELETE") {
    const id = one![1]!;
    const before = id === "all" ? null : service.list().find(s => s.id === id) ?? null;
    const n = service.revoke(id);
    if (n) ctx.officeShareNotice?.("revoked", first.name, before, n);
    json(res, n ? 200 : 404, n ? { revoked: n } : { error: "not_found" });
    return true;
  }
  (async () => {
    let body: Record<string, unknown>;
    try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
    if (!permitWebContinuation(req, res, ctx)) return;
    const now = who();
    if ("status" in now) { refuse(now.status); return; }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.office !== "string"
      || (body.minutes !== undefined && typeof body.minutes !== "number") || (body.text !== undefined && typeof body.text !== "boolean")) {
      json(res, 400, { error: "office (string), minutes? (number), text? (boolean)" });
      return;
    }
    const made = await service.create({ office: body.office, owner: now.person, ...(typeof body.minutes === "number" ? { minutes: body.minutes } : {}),
      ...(typeof body.text === "boolean" ? { text: body.text } : {}) });
    if (!made.ok) {
      const status = made.error === "disabled" ? 404 : made.error === "tunnel" ? 503 : made.error === "too_many" ? 409 : 400;
      json(res, status, { error: made.error, ...(made.reason ? { reason: made.reason } : {}) });
      return;
    }
    ctx.officeShareNotice?.("created", now.name, made.share, 1);
    json(res, 200, { share: made.share, url: made.url });
  })().catch(err => {
    ctx.logger.error({ err: (err as Error).message }, "Office share failed");
    try { json(res, 500, { error: "Office share failed" }); } catch { /* already answered */ }
  });
  return true;
}

/**
 * #2513: the Office view's skin packs (web-office-skins.ts). The reads are the offices' (GET /ui/offices): whoever may
 * open the org chart, the public link too (its manifest lists them; a guest's routes do not): the list, a pack's
 * manifest (?v=<sha>: immutable, else no-store) and its pictures (by the sha of their bytes: immutable, image/png,
 * nosniff, sandboxed). The writes are PUT /ui/offices's: an admin session only — never the CLI token, never the public
 * link (absent from its manifest, and refused here too) — asked again once the body is in; rate limited per person.
 * Every page hears `office_skins` on the stream and reads the list again.
 */
function handleOfficeSkins(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  const store = ctx.officeSkins;
  if (!store) { json(res, 404, { error: "Skin packs are not kept on this fleet" }); return true; }
  const one = /^\/ui\/office-skins\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  const picture = /^\/ui\/office-skins\/([A-Za-z0-9_-]{1,40})\/img\/([0-9a-f]{32})\.png$/.exec(path);
  if (method === "GET" || method === "HEAD") {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (path === "/ui/office-skins") { res.setHeader("Cache-Control", "private, no-store"); json(res, 200, store.list()); return true; }
    if (one) {
      const pack = store.get(one[1]!);
      if (!pack) { res.setHeader("Cache-Control", "private, no-store"); json(res, 404, { error: "skin_unknown" }); return true; }
      const v = url.searchParams.get("v");
      res.setHeader("Cache-Control", v === pack.sha ? "private, max-age=31536000, immutable" : "private, no-store");
      json(res, 200, pack);
      return true;
    }
    if (picture) {
      const bytes = store.picture(picture[1]!, picture[2]!);
      if (!bytes) { res.setHeader("Cache-Control", "private, no-store"); json(res, 404, { error: "No such image" }); return true; }
      res.setHeader("Content-Type", "image/png");
      // Keyed by the sha of its bytes: a picture at this URL never changes.
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.writeHead(200);
      res.end(method === "HEAD" ? undefined : bytes);
      return true;
    }
    json(res, 404, { error: "not found" });
    return true;
  }
  const upload = method === "POST" && path === "/ui/office-skins", removal = method === "DELETE" && !!one;
  if (!upload && !removal) { json(res, 404, { error: "not found" }); return true; }
  if (gatewayRequestContext(req)) { json(res, 403, { error: "skins_not_over_public_link" }); return true; }
  const who = (): { person: string } | { status: number } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401 };
    return verdict.via === "session" && verdict.session?.tier === "admin" ? { person: verdict.session.owner ? webPersonKey(verdict.session.owner) : "admin-session" } : { status: 403 };
  };
  const refuse = (status: number) => json(res, status, { error: status === 401 ? WEB_TOKEN_INVALID_MESSAGE : "skins_need_an_admin_session" });
  const first = who();
  if ("status" in first) { refuse(first.status); return true; }
  const limited = (person: string): boolean => {
    const allowed = ctx.officeSkinWrites ? ctx.officeSkinWrites.check(person) : { ok: true as const };
    if (allowed.ok) return false;
    res.setHeader("Retry-After", String(allowed.retry_after_s));
    json(res, 429, { error: "skins_rate_limited", retry_after_s: allowed.retry_after_s });
    return true;
  };
  const answer = (r: { ok: true; rev: string } | { ok: false; status: number; error: string; detail?: string }, body: () => unknown, person: string) => {
    if (!r.ok) { json(res, r.status, { error: r.error, ...(r.detail ? { detail: r.detail } : {}) }); return; }
    ctx.officeSkinWrites?.record(person);
    ctx.emitSseEvent("office_skins", { rev: r.rev });
    json(res, 200, body());
  };
  if (removal) {
    if (limited(first.person)) return true;
    const r = store.remove(one![1]!);
    answer(r, () => ({ rev: r.ok ? r.rev : "" }), first.person);
    return true;
  }
  (async () => {
    let bytes: Buffer;
    try { bytes = await readBoundedWebBody(req, SKIN_WIRE_BYTES); } catch { json(res, 413, { error: "skin_too_large", detail: `at most ${Math.floor(SKIN_WIRE_BYTES / 1024 / 1024)} MiB a request` }); return; }
    if (!permitWebContinuation(req, res, ctx)) return;
    const now = who();
    if ("status" in now) { refuse(now.status); return; }
    let body: unknown;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
    if (limited(now.person)) return;
    const r = store.add(body, now.person);
    answer(r, () => (r.ok ? { rev: r.rev, pack: r.pack } : null), now.person);
  })().catch(err => {
    ctx.logger.error({ err: (err as Error).message }, "Uploading a skin pack failed");
    try { json(res, 500, { error: "Uploading a skin pack failed" }); } catch { /* already answered */ }
  });
  return true;
}

/**
 * #2692: the agents' skin-pack changes, for the Office page (Edit offices → Skin packs) — an admin session only, never
 * the CLI token, a guest or the public link (as uploading a pack by hand). GET { approval, agents, pending, log };
 * POST { approval: "apply" | "approve" } sets the fleet's approval mode; POST /<id> { decision: "approve" | "reject" }
 * decides a pending change (judged again on a yes). Every change is `office_pack_changes` on the stream.
 */
function handleOfficePackChanges(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  const tools = ctx.officePackTools;
  if (!tools) { json(res, 404, { error: "Pack changes are not kept on this fleet" }); return true; }
  const one = /^\/ui\/office-pack-changes\/([0-9a-f]{32})$/.exec(path);
  if (!(method === "GET" && path === "/ui/office-pack-changes") && !(method === "POST" && (path === "/ui/office-pack-changes" || one))) { json(res, 404, { error: "not found" }); return true; }
  if (gatewayRequestContext(req)) { json(res, 403, { error: "pack_changes_not_over_public_link" }); return true; }
  const who = (): { person: string } | { status: number } => {
    const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (verdict.kind !== "allow") return { status: 401 };
    return verdict.via === "session" && verdict.session?.tier === "admin" ? { person: verdict.session.owner ? webPersonKey(verdict.session.owner) : "admin-session" } : { status: 403 };
  };
  const refuse = (status: number) => json(res, status, { error: status === 401 ? WEB_TOKEN_INVALID_MESSAGE : "pack_changes_need_an_admin_session" });
  const first = who();
  if ("status" in first) { refuse(first.status); return true; }
  if (method === "GET") { res.setHeader("Cache-Control", "private, no-store"); json(res, 200, tools.changes()); return true; }
  (async () => {
    let body: Record<string, unknown>;
    try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
    if (!permitWebContinuation(req, res, ctx)) return;
    const now = who();
    if ("status" in now) { refuse(now.status); return; }
    if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "an object" }); return; }
    if (!one) {
      if (Object.keys(body).some(k => k !== "approval")) { json(res, 400, { error: "pack_changes_invalid", detail: "{ approval }" }); return; }
      const r = tools.setApproval(body.approval, now.person);
      if (!r.ok) { json(res, 400, { error: "pack_changes_invalid", detail: r.error }); return; }
      json(res, 200, tools.changes());
      return;
    }
    if (Object.keys(body).some(k => k !== "decision") || (body.decision !== "approve" && body.decision !== "reject")) { json(res, 400, { error: "pack_changes_invalid", detail: '{ decision: "approve" | "reject" }' }); return; }
    const r = tools.decide(one[1]!, body.decision, now.person);
    json(res, r.ok ? 200 : r.status, r.ok ? { text: r.text, ...(r.applied ? { applied: r.applied } : {}) } : { error: r.error, detail: r.text });
  })().catch(err => {
    ctx.logger.error({ err: (err as Error).message }, "A pack change failed");
    try { json(res, 500, { error: "A pack change failed" }); } catch { /* already answered */ }
  });
  return true;
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
  if (method !== "POST" || !["/ui/owner-css", "/ui/owner-css/shown", "/ui/owner-css/keep", "/ui/owner-css/revert", "/ui/owner-css/restore", "/ui/owner-css/asset"].includes(path)) {
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
    } else if (path === "/ui/owner-css/shown") {
      // #2198: this page shows the trial (its stylesheet loaded): an agent's waiting trial starts its keep window now.
      const shown = store.shown(person, body.trial);
      if (!shown.ok) { json(res, shown.status, { error: shown.error }); return; }
      if (shown.started) announce();                                     // the person's other devices take the new deadline
      json(res, 200, { remaining_ms: shown.remaining_ms });
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
    if (!canvasWorkerEnabled(ctx.fleetConfig?.web)) { json(res, 403, { error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE }); return; }
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

/** #2599: the same closed browser controls as setup, for a current local human admin. */
function handleBrowserBackendSignIns(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext): boolean {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const reading = req.method === "GET";
  if (gatewayRequestContext(req)) { json(res, reading ? 404 : 403, { error: "sign_in_not_over_public_link" }); return true; }
  const who = () => {
    const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    return v.kind === "allow" && v.via === "session" && v.session.tier === "admin" && v.session.surface === "local" ? v.session : null;
  };
  const owner = who();
  if (!owner) { json(res, 403, { error: "sign_in_needs_a_local_admin" }); return true; }
  if (!["GET", "POST"].includes(req.method ?? "") || [...url.searchParams.keys()].length) { json(res, 404, { error: "not_found" }); return true; }
  const service = ctx.browserBackendSignIns;
  if (!service) { json(res, 404, { error: "sign_in_unavailable" }); return true; }
  void (async () => {
    let result;
    if (reading) result = await service.refresh(owner);
    else {
      let bytes: Buffer; try { bytes = await readBoundedWebBody(req, 8192); } catch { json(res, 413, { error: "sign_in_body_bound" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      if (who() !== owner) { json(res, 409, { error: "signin_session_expired" }); return; }
      let body: unknown; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { json(res, 400, { error: "sign_in_json" }); return; }
      const parsed = z.discriminatedUnion("operation", [
        z.strictObject({ operation: z.literal("select"), backends: z.array(z.enum(["kiro-cli", "claude-code", "codex", "antigravity"])).max(4) }),
        z.strictObject({ operation: z.literal("start"), backend: z.enum(["kiro-cli", "claude-code", "codex"]), relogin: z.boolean().optional() }),
        z.strictObject({ operation: z.literal("input"), id: z.string().regex(/^[0-9a-f]{32}$/), revision: z.number().int().nonnegative(), action: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("method"), choice: z.string().max(32) }),
          z.strictObject({ kind: z.enum(["code", "start_url", "region"]), value: z.string().max(4096) }),
        ]) }),
        z.strictObject({ operation: z.literal("skip"), backend: z.enum(["kiro-cli", "claude-code", "codex", "antigravity"]) }),
        z.strictObject({ operation: z.literal("cancel") }), z.strictObject({ operation: z.literal("refresh") }),
      ]).safeParse(body);
      if (!parsed.success) { json(res, 400, { error: "invalid_signin_action" }); return; }
      const action = parsed.data;
      if (action.operation === "select") result = await service.select(owner, action.backends);
      else if (action.operation === "start") result = await service.begin(owner, action.backend, action.relogin === true);
      else if (action.operation === "input") result = await service.input(owner, action.id, action.revision, action.action);
      else if (action.operation === "skip") result = await service.skip(owner, action.backend);
      else if (action.operation === "cancel") result = await service.cancel(owner);
      else result = await service.refresh(owner, true);
    }
    if (!permitWebContinuation(req, res, ctx)) return;
    if (who() !== owner) { json(res, 409, { error: "signin_session_expired" }); return; }
    json(res, 200, result);
  })().catch(error => {
    const code = error instanceof Error ? error.message : "";
    const safe = /^(?:signin_(?:session_expired|console_only|cleanup_failed|action_(?:stale|invalid|ended|busy))|invalid_signin_(?:action|checklist))$/.test(code) ? code : "signin_failed";
    if (!res.destroyed && !res.writableEnded) json(res, safe === "signin_cleanup_failed" || safe === "signin_failed" ? 503 : 409, { error: safe });
  });
  return true;
}

/**
 * #2233: signing a backend in from the dashboard (web-backend-login.ts). A signed-in admin session on the local surface
 * only — never the CLI's header token (an agent's), a guest, a read session or the public link (refused before the body
 * is read, and again after it). Every answer is no-store: the starter's view carries the terminal's access code.
 */
function handleBackendLogin(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, path: string, method: string): boolean {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const reading = method === "GET";
  if (gatewayRequestContext(req)) { json(res, reading ? 404 : 403, { error: "sign_in_not_over_public_link" }); return true; }
  const who = (): { handle: string; label: string } | { error: string; status: number } => {
    const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
    if (v.kind !== "allow") return { error: WEB_TOKEN_INVALID_MESSAGE, status: 401 };
    if (v.via !== "session" || v.session.tier !== "admin" || v.session.surface !== "local") return { error: "sign_in_needs_a_local_admin", status: 403 };
    return { handle: v.session.handle, label: v.session.label };
  };
  const first = who(); if ("error" in first) { json(res, first.status, { error: first.error }); return true; }
  const logins = ctx.webBackendLogins;
  if (!logins) { json(res, 404, { error: "sign_in_unavailable" }); return true; }
  const action = /^\/ui\/backend-login\/(check|start|cancel)$/.exec(path)?.[1];
  if (reading && path === "/ui/backend-login" && [...url.searchParams.keys()].length === 0) { json(res, 200, { login: logins.view(first.handle), targets: ctx.backendSignInTargets?.() ?? [] }); return true; }
  if (method !== "POST" || !action) { json(res, 404, { error: "not_found" }); return true; }
  (async () => {
    let bytes: Buffer;
    try { bytes = await readBoundedWebBody(req, 4 * 1024); } catch { json(res, 413, { error: "sign_in_body_bound" }); return; }
    if (!permitWebContinuation(req, res, ctx)) return;
    const now = who(); if ("error" in now) { json(res, now.status, { error: now.error }); return; }
    if (now.handle !== first.handle) { json(res, 409, { error: "sign_in_session_changed" }); return; }
    let body: unknown; try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { json(res, 400, { error: "sign_in_json" }); return; }
    if (action === "check") {
      const parsed = z.strictObject({ backend: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i), profile: z.string().min(1).max(64).optional() }).safeParse(body);
      if (!parsed.success) { json(res, 400, { error: "sign_in_args" }); return; }
      json(res, 200, await logins.check(now, parsed.data.backend, parsed.data.profile));
    } else if (action === "start") {
      const parsed = z.strictObject({ confirm: z.string().regex(/^[0-9a-f]{32}$/), tunnel: z.boolean().optional() }).safeParse(body);
      if (!parsed.success) { json(res, 400, { error: "sign_in_args" }); return; }
      const result = await logins.begin(now, parsed.data.confirm, parsed.data.tunnel === true);
      json(res, "error" in result ? 409 : 200, result);
    } else {
      if (!z.strictObject({}).safeParse(body).success) { json(res, 400, { error: "sign_in_args" }); return; }
      json(res, 200, { message: await logins.cancel() });
    }
  })().catch(() => { try { json(res, 500, { error: "sign_in_request_failed" }); } catch { /* response ended */ } });
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
    if (!canvasWorkerEnabled(ctx.fleetConfig?.web)) { json(res, 403, { error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE }); return; }
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
    if (!canvasWorkerEnabled(ctx.fleetConfig?.web) && (fx === "unknown" || (fx?.length ?? 0) > 0)) {
      json(res, 403, { error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE }); return true;
    }
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
      const effects = (canvasWorkerEnabled(ctx.fleetConfig?.web) ? rec.placements.effects : []).flatMap(p => { const e = ctx.modPlacedEffect?.(person, p.id); if (!e || !filesPlayInChat(e.files)) { omitted++; return []; } return [{ name: e.name, files: e.files, params: p.params ?? {} }]; });
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
    peer: webPeerOf(req), ...(instance !== undefined ? { instance } : {}) });
}
/**
 * #1939 §3.4 / #2453 §0.2 / §0.3: where this request came from — over the public gateway, the link itself by the
 * gateway's own provenance (never a header): the admin's named tunnel on its exact hostname, else the temporary
 * quick-tunnel link. Off the gateway, what the TCP peer and Host say.
 */
export function webPeerOf(req: IncomingMessage): WebPeer {
  const gateway = gatewayRequestContext(req);
  return gateway ? (gateway.named === true ? "named_link" : "quick_link") : classifyWebPeer(req);
}
/**
 * #2122: what let this request in, asked now — its session (by handle, under the token it was signed in with) or the
 * header token; null when nothing does any more (the gate also refuses a public link that is no longer the current
 * one). Equal before and after an await: the same admission still holds. Never touches the session.
 */
/** #2293: an admin's admission — the header token or an admin session — else null (a guest's or a read-only session's). */
function adminAdmissionOf(req: IncomingMessage, url: URL, ctx: WebApiContext): string | null {
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  if (v.kind !== "allow" || (v.via === "session" && v.session.tier !== "admin")) return null;
  return admissionOf(req, url, ctx);
}
const SEARCH_LIMIT_DEFAULT = 50;
/**
 * #2293: GET /ui/search's parameters: q (1–QUERY_MAX_CHARS), instance (repeated), team (its members join `instance`),
 * source (repeated: chat, xmsg, task), since / until (epoch ms), mine=1, limit (1–RESULT_MAX).
 */
function parseSearchQuery(url: URL, ctx: WebApiContext): { filters: import("./search/search-store.js").SearchFilters; mine: boolean } | { error: string } {
  const p = url.searchParams;
  const q = (p.get("q") ?? "").trim();
  if (!q || q.length > QUERY_MAX_CHARS) return { error: `q required (1-${QUERY_MAX_CHARS} chars)` };
  const instances = new Set(p.getAll("instance").filter(n => n.length > 0 && n.length <= 128));
  const team = p.get("team");
  if (team) {
    const def = ctx.fleetConfig?.teams && Object.hasOwn(ctx.fleetConfig.teams, team) ? ctx.fleetConfig.teams[team] : undefined;
    if (!def) return { error: "unknown team" };
    for (const member of def.members ?? []) instances.add(member);
    if (!instances.size) return { error: "team has no members" };
  }
  const sources = p.getAll("source");
  if (sources.some(s => !(SEARCH_SOURCES as readonly string[]).includes(s))) return { error: `source must be one of: ${SEARCH_SOURCES.join(", ")}` };
  const time = (name: string): number | undefined | null => {
    const raw = p.get(name);
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const since = time("since"), until = time("until");
  if (since === null || until === null) return { error: "since/until must be epoch milliseconds" };
  const limitRaw = p.get("limit");
  const limit = limitRaw === null ? SEARCH_LIMIT_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > RESULT_MAX) return { error: `limit must be 1-${RESULT_MAX}` };
  return {
    filters: { q, limit, ...(instances.size ? { instances: [...instances] } : {}), ...(sources.length ? { sources: sources as import("./search/search-store.js").SearchSource[] } : {}),
      ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) },
    mine: p.get("mine") === "1",
  };
}

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
/**
 * Who a dashboard request acts as on the task board. The person only through a signed-in local session: the header
 * token is the CLI's or a script's (any agent on this machine can read the token file), and the temporary public link
 * carries no verified authority (docs/web-dashboard.md) — either is a script, held to the rules an instance is held to,
 * so neither confirms work waiting for the person.
 */
function boardActor(req: IncomingMessage, url: URL, ctx: WebApiContext, p: WebPerson): BoardActor {
  if (gatewayRequestContext(req)) return { kind: "script", name: "public-link" };
  const v = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
  return v.kind === "allow" && v.via === "session" ? { kind: "person", name: p.name } : { kind: "script", name: "web-token" };
}

/**
 * A board refusal as the dashboard reads it: the board's sentence, its code and the status that fits, and — when the
 * person can meet it — the key and values the page says it with in its own language.
 */
function boardError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return;
  if (err instanceof TaskBoardError) {
    const status = err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : err.code === "conflict" ? 409 : 400;
    json(res, status, { error: err.message, code: err.code, ...(err.key ? { key: err.key, args: err.args } : {}) });
    return;
  }
  json(res, 400, { error: (err as Error).message });
}

/**
 * One board write from the dashboard: the body read and checked, the request still allowed, the person asked for
 * again now the body is in (#1827), then the write as that person. The board's own routes take a signed-in session
 * only (instances use their task tool, scripts the old /ui/tasks routes).
 */
function boardWrite<T>(
  req: IncomingMessage, res: ServerResponse, url: URL, ctx: WebApiContext, board: TaskBoard, schema: z.ZodType<T>,
  write: (body: T, person: BoardActor) => unknown,
): void {
  void (async () => {
    try {
      const body = await parseBody(req);
      if (!permitWebContinuation(req, res, ctx)) return;
      const parsed = parseOrReject(schema, body, res);
      if (!parsed) return;
      const person = webPersonOr401(req, res, url, ctx);
      if (!person) return;
      const actor = boardActor(req, url, ctx, person);
      if (actor.kind !== "person") { json(res, 403, { error: "The task board takes changes from a signed-in dashboard", code: "forbidden", key: "signed_in_only" }); return; }
      json(res, 200, write(parsed, actor));
    } catch (err) {
      boardError(res, err);
    }
  })();
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
/**
 * #1956: the status the SSE heartbeat sends, built once per tick for every open stream instead of once per stream.
 * Every open dashboard tab sent its own heartbeat every 10 s, each rebuilding and serializing the whole fleet's status
 * on the fleet's loop (#1235): T tabs cost T builds. Now one timer per server ticks for all of them:
 *   - each stream's own check runs first (its session, a guest's exact session); one that fails is closed, as before;
 *   - if any stream is left, the status is built once (measured as web.sseStatus);
 *   - the admin frame is serialized once; a guest's frame is projected per scope (guestStatus) from that same build,
 *     never from another stream's frame.
 * A stream's first frame (on connecting) is still its own build.
 */
interface StatusTickStream {
  /** Whether it may still be sent to: false when it was just closed. */
  alive(): boolean;
  /** A guest's scope, read at the tick; null for an admin's stream (the whole status). */
  scope: (() => ReadonlySet<string>) | null;
  write(frame: string): void;
}
const statusTicks = new WeakMap<WebApiContext, { streams: Set<StatusTickStream>; timer: ReturnType<typeof setInterval> | null }>();
function subscribeStatusTick(ctx: WebApiContext, stream: StatusTickStream): () => void {
  let tick = statusTicks.get(ctx);
  if (!tick) statusTicks.set(ctx, tick = { streams: new Set(), timer: null });
  const t = tick;
  t.streams.add(stream);
  t.timer ??= setInterval(() => statusTick(ctx, t), ctx.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
  return () => {
    t.streams.delete(stream);
    if (!t.streams.size && t.timer) { clearInterval(t.timer); t.timer = null; }
  };
}
function statusTick(ctx: WebApiContext, t: { streams: Set<StatusTickStream> }): void {
  const live = [...t.streams].filter((s) => s.alive());
  if (!live.length) return;
  let status: unknown, admin: string | null = null;
  const guests = new Map<string, string>();
  try { status = measureSyncWork("web.sseStatus", () => ctx.getUiStatus()); }
  catch { return; }                                           // nothing to send this tick; the next one tries again
  const frameFor = (s: StatusTickStream): string => {
    if (!s.scope) return admin ??= `event: status\ndata: ${JSON.stringify(status)}\n\n`;
    const scope = s.scope(), key = [...scope].sort().join("\u0000");
    let frame = guests.get(key);
    if (frame === undefined) guests.set(key, frame = `event: status\ndata: ${JSON.stringify(guestStatus(status, scope))}\n\n`);
    return frame;
  };
  for (const s of live) {
    let frame: string;
    try { frame = frameFor(s); } catch { continue; }
    s.write(frame);
  }
}

export function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: WebApiContext,
): boolean {
  const path = url.pathname;
  const method = req.method ?? "GET";
  if (!canvasWorkerEnabled(ctx.fleetConfig?.web) && isCanvasWorkerHttpPath(path)) {
    json(res, 403, { error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE });
    return true;
  }

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
      // #2182: the route worker's own, narrower-reaching policy (ROUTE_WORKER_CSP); every other file keeps the page's.
      if (path === ROUTE_WORKER_PATH) res.setHeader("Content-Security-Policy", ROUTE_WORKER_CSP);
      res.writeHead(200);
      res.end(js);
    } catch {
      json(res, 404, { error: "File not found" });
    }
    return true;
  }

  // #2182: libavoid (libavoid-js, LGPL-2.1-or-later) — the npm package's own two files, unmodified, at a versioned path.
  const vendor = method === "GET" ? libavoidFile(path) : null;
  if (vendor) {
    try {
      const body = readFileSync(vendor.file);
      res.writeHead(200, { "Content-Type": vendor.type, "Cache-Control": "private, max-age=31536000, immutable" });
      res.end(body);
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
      // #2085 review: with what became the channel's after its cursor (an older row, its copy sent since), once each —
      // replayFor counts a row where it was seen (seenSeq), as for every reader (#1774).
      json(res, 200, guestPollBody(ctx.getUiStatus(), guest.scope(), Date.now(), guest, after, () => {
        if (!history) return [];
        return fresh ? history.after(0) : history.replayFor(parseLastEventId(after));
      }));
      return true;
    }
    json(res, 200, {
      status: ctx.getUiStatus(),
      // #2341 review: over the public link, without a summary line that names a card hidden there.
      messages: history ? visibleMessages(ctx, !!gatewayRequestContext(req), fresh ? history.after(0) : history.replayFor(parseLastEventId(after))) : [],
      // The ticks too, so polling never has to re-read a chat's history — that read would count as the person's
      // activity; this poll does not (isPassiveWebRead).
      deliveries: history ? history.deliveries() : [],
      // #1266: a reply's buttons that ended after the page saw the reply (the message itself is not sent again).
      reply_buttons: history ? history.buttonStates() : [],
      // #2305: the instance's reactions, likewise (a reaction is no new message).
      reactions: history ? history.reactionStates() : [],
      // And the fleet prompts open on the dashboard (C4): prompt events are stream-only too.
      prompts: ctx.listWebPrompts?.() ?? [],
      // #1386: "Needs you" rides the passive channels only — no endpoint of its own to poll. Over the public link,
      // without the task board's hidden cards (#2306 review).
      needs: visibleNeeds(ctx, !!gatewayRequestContext(req), ctx.needsYouItems?.() ?? []),
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
    // #1956: the heartbeat's status comes from the one build every open stream shares each tick (statusTick), with
    // this stream's own projection; this stream's checks stay its own.
    const unsubscribe = subscribeStatusTick(ctx, {
      // A stream authorized once must not outlive the authorization. Re-checked
      // without counting as activity, or an open tab would keep an idle session
      // alive forever; a revoked, expired or rotated-away session ends here.
      // #2049 review: a guest's stream also needs the exact session that opened it — another cookie on the same request
      // still authenticating does not keep a revoked device's stream (with its scope) alive.
      alive: () => {
        if (isWebRequestAuthorized(req, url, ctx.webToken, ctx.webSessions, { touch: false }) && (!guest || guest.current())) return true;
        // Close the connection too, not just the response: an ended response leaves the socket idle in
        // keep-alive, still held open by whoever's session just ended.
        const socket = req.socket;
        try { res.end(() => socket?.destroy()); } catch { /* already closed */ }
        cleanup();
        return false;
      },
      scope: guest ? () => guest.scope() : null,
      write: (frame) => { try { res.write(frame + sseClock()); } catch { cleanup(); } },
    });
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      ctx.sseClients.delete(res);
      unsubscribe();
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
    const messages = !ctx.webChatHistory ? [] : guest ? guestHistory(ctx.webChatHistory, instance, limit, guest, guest.scope())
      : visibleMessages(ctx, !!gatewayRequestContext(req), ctx.webChatHistory.list(instance, limit));
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

  // ── Fleet → Org chart → Office: the offices people made (web-offices.json, web-office-store.ts) ──
  // GET /ui/offices: { rev, offices, readable } for whoever may open the org chart (the public link too: it reads the
  // chart; a guest's routes do not include it). PUT /ui/offices { offices, rev? }: a person's change, as a theme's reset
  // or lock is — an admin session only, never the CLI token, never the public link (absent from its manifest, and
  // refused here too); asked again once the body is in. Every page hears `offices` on the stream and reads again.
  if (method === "GET" && path === "/ui/offices") {
    const store = ctx.officeStore;
    if (!store) { json(res, 404, { error: "Offices are not kept on this fleet" }); return true; }
    json(res, 200, store.list());
    return true;
  }
  if (method === "PUT" && path === "/ui/offices") {
    const store = ctx.officeStore;
    if (!store) { json(res, 404, { error: "Offices are not kept on this fleet" }); return true; }
    if (gatewayRequestContext(req)) { json(res, 403, { error: "offices_not_over_public_link" }); return true; }
    // The person (an admin session's account), or the status that refuses the request.
    const who = (): { person: string } | { status: number } => {
      const verdict = evaluateWebRequest(req as unknown as WebGateRequest, url, ctx.webToken ?? null, ctx.webSessions, { touch: false });
      if (verdict.kind !== "allow") return { status: 401 };
      return verdict.via === "session" && verdict.session?.tier === "admin" ? { person: verdict.session.owner ? webPersonKey(verdict.session.owner) : "admin-session" } : { status: 403 };
    };
    const refuse = (status: number) => json(res, status, { error: status === 401 ? WEB_TOKEN_INVALID_MESSAGE : "offices_need_an_admin_session" });
    const first = who();
    if ("status" in first) { refuse(first.status); return true; }
    (async () => {
      let body: Record<string, unknown>;
      try { body = await parseBody(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
      if (!permitWebContinuation(req, res, ctx)) return;
      const now = who();
      if ("status" in now) { refuse(now.status); return; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "offices required" }); return; }
      const extra = Object.keys(body).find(k => k !== "offices" && k !== "rev");
      if (extra !== undefined) { json(res, 400, { error: "offices_invalid", detail: `unknown key "${extra}"` }); return; }
      // Office review: the rev the page read is required — a save without one would overwrite another person's unseen.
      if (body.rev === undefined) { json(res, 428, { error: "offices_rev_required", detail: "send the rev you read (GET /ui/offices)" }); return; }
      if (!Number.isSafeInteger(body.rev)) { json(res, 400, { error: "offices_invalid", detail: "rev: an integer" }); return; }
      const limiter = ctx.officeWrites, allowed = limiter ? limiter.check(now.person) : { ok: true as const };
      if (!allowed.ok) { res.setHeader("Retry-After", String(allowed.retry_after_s)); json(res, 429, { error: "offices_rate_limited", retry_after_s: allowed.retry_after_s }); return; }
      const r = store.replace(body.offices, body.rev as number);
      if (!r.ok) { json(res, r.status, { error: r.error, ...(r.detail ? { detail: r.detail } : {}) }); return; }
      limiter?.record(now.person);
      ctx.emitSseEvent("offices", { rev: r.rev });
      json(res, 200, { rev: r.rev, offices: r.offices });
    })().catch(err => {
      ctx.logger.error({ err: (err as Error).message }, "Saving offices failed");
      try { json(res, 500, { error: "Saving offices failed" }); } catch { /* already answered */ }
    });
    return true;
  }

  // #2578: GET /ui/office-acts { acts }: the agents' live acts (office_set), read as the offices are (the public link
  // too, which has no stream); every change also comes as `office_acts` on the stream. Nothing here writes one.
  if (method === "GET" && path === "/ui/office-acts") {
    const acts = ctx.officeActs;
    if (!acts) { json(res, 404, { error: "Office acts are not kept on this fleet" }); return true; }
    json(res, 200, { acts: acts.live(), now: Date.now() });              // now: the host's clock, for the page's offset
    return true;
  }

  if (path === "/ui/office-skins" || path.startsWith("/ui/office-skins/")) return handleOfficeSkins(req, res, url, ctx, path, method);
  if (path === "/ui/office-pack-changes" || path.startsWith("/ui/office-pack-changes/")) return handleOfficePackChanges(req, res, url, ctx, path, method);
  if (path === "/ui/office-share" || path.startsWith("/ui/office-share/")) return handleOfficeShare(req, res, url, ctx, path, method);

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
      const { instance, nonce, action, text } = body;
      if (typeof instance !== "string" || typeof nonce !== "string" || typeof action !== "string" || (text !== undefined && typeof text !== "string")) {
        json(res, 400, { error: "instance, nonce and action required" });
        return;
      }
      const r = text === undefined ? await click(instance, nonce, action) : await click(instance, nonce, action, text);
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
      if (personal && !canvasWorkerEnabled(ctx.fleetConfig?.web)) { json(res, 403, { error: "canvas_worker_experimental", message: CANVAS_WORKER_EXPERIMENTAL_MESSAGE }); return; }
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

  // #2308: the app icon (handleAppIcon: its state for a signed-in person; changing it, an admin's session only).
  if (path === "/ui/app-icon") return handleAppIcon(req, res, url, ctx, method);

  // #1629 r4-5: mods — a person's import, uninstall and export (handleMods: sessions only, never the public link).
  if (path === "/ui/mods" || path.startsWith("/ui/mods/")) return handleMods(req, res, url, ctx, path, method);

  // Posters remain behind the common session gate, with a closed GET-only public manifest.
  if (path === "/ui/effect-posters" || path.startsWith("/ui/effect-posters/")) return handleEffectPosters(res, url, ctx, path, method);

  // Canvas effects are absent from the public gateway manifest and independently refused above.
  if (path === "/ui/effect-trials" || path.startsWith("/ui/effect-trials/")) return handleEffectTrials(req, res, url, ctx, path, method);
  // #2233: backend sign-in — absent from the public manifest and the guest table, and refused here too.
  if (path === "/ui/browser-backend-signins") return handleBrowserBackendSignIns(req, res, url, ctx);
  if (path === "/ui/backend-login" || path.startsWith("/ui/backend-login/")) return handleBackendLogin(req, res, url, ctx, path, method);
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
      return { session: v.kind === "allow" && v.via === "session" ? v.session : null, gateway: !!gatewayRequestContext(req), peer: webPeerOf(req) };
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
    const known = registeredChatInstance(ctx, name) || ctx.daemons.has(name);
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
          () => ctx.startInstance(name, config, topicMode ?? false, "fleet-topic", true));
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

  // #2246: the public link writes no task — the old list's create and update are board writes now (see below).
  if (method === "POST" && (path === "/ui/tasks" || /^\/ui\/tasks\/[^/]+$/.test(path)) && gatewayRequestContext(req)) {
    json(res, 403, { error: "task_board_not_over_public_link", code: "forbidden", key: "not_over_public_link" });
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
        }, boardActor(req, url, ctx, person));
        json(res, 200, task);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Task board (scheduler/task-board.ts) ──────────────
  // Reads are the session's; every write is the signed-in person's, through the same rules an instance's tools use.

  if (path === "/ui/tasks/board" || path === "/ui/tasks/search" || path === "/ui/tasks/work" || path.startsWith("/ui/tasks/cards") || path.startsWith("/ui/tasks/projects")) {
    const board = ctx.scheduler?.db.board;
    if (!board) { json(res, 503, { error: "The task board is not available", code: "unavailable", key: "unavailable" }); return true; }
    // The temporary public link reads the board and changes nothing on it: confirming, sending back, cancelling and
    // assigning are the person's authority, which the public link never carries (docs/web-dashboard.md).
    const gateway = gatewayRequestContext(req);
    if (gateway && method !== "GET") { json(res, 403, { error: "task_board_not_over_public_link", code: "forbidden", key: "not_over_public_link" }); return true; }
    // …nor shows the cards of instances kept out of sight (cross_instance_visibility: hidden).
    const { hiddenName, hidden } = boardHiding(ctx, !!gateway);
    // #2303 review: what a visible card shows of the cards around it follows the same rule — its children, its main
    // task (a search hit's too) — and so do the words and the history a hidden instance left on it.
    // …and a hidden instance's words on a visible card are not counted, named or found there (#2304 review).
    const scope = { leaveOutAuthors: gateway ? Object.keys(ctx.fleetConfig?.instances ?? {}).filter(hiddenName) : [] };
    const hiddenRef = (ref: string | null) => { const c = ref ? board.findCard(ref) : undefined; return !!c && hidden(c); };
    const mentionsHidden = (v: unknown): boolean => (typeof v === "string" ? hiddenName(v) : !!v && typeof v === "object" && Object.values(v).some(mentionsHidden));
    const shown = (d: ReturnType<typeof board.detail>): typeof d => !gateway ? d : {
      ...d,
      parent: d.card.parentId && hiddenRef(d.card.parentId) ? null : d.parent,
      children: d.children.filter((c) => !hidden(c)),
      comments: d.comments.filter((e) => !hiddenName(e.author)),
      logs: d.logs.filter((e) => !hiddenName(e.author)),
      history: d.history.filter((e) => !hiddenName(e.actor) && !mentionsHidden(e.data)),
    };
    const card = /^\/ui\/tasks\/cards\/([^/]+)(?:\/(move|reorder))?$/.exec(path);
    const project = /^\/ui\/tasks\/projects\/(\d+)$/.exec(path);
    try {
      const ref = card ? decodeURIComponent(card[1]!) : "";
      if (method === "GET" && path === "/ui/tasks/board") {
        // A page that has this revision already is told so, not sent the board again.
        const rev = board.revision();
        if (url.searchParams.get("rev") === String(rev)) { json(res, 200, { rev, unchanged: true }); return true; }
        const allDone = url.searchParams.get("done") === "all";
        // #2296: every open Tasks tab reads the board again after each change; on the dashboard they all get the same
        // board for a revision, so it is built once per (revision, done=all, minute) — the minute for the 14-day
        // window. The public link's reads are filtered per request (hidden instances) and are built each time.
        const key = gateway ? null : `${rev}:${allDone ? 1 : 0}:${Math.floor(Date.now() / 60_000)}`;
        const kept = key ? boardBodies.get(board) : undefined;
        if (kept && kept.key === key) { jsonText(res, 200, kept.body); return true; }
        const cards = board.boardCards(undefined, allDone).filter((c) => !hidden(c));
        // #2352: over the public link a hidden lead is not named (the project reads as having none).
        const projects = board.listProjects(true).map((p) => (p.leadInstance && hiddenName(p.leadInstance) ? { ...p, leadInstance: null } : p));
        // #2355 review: the names a project's lead may be — the fleet's instances (a Classic-only room is not one); over the
        // public link, not a hidden one.
        const leads = Object.keys(ctx.fleetConfig?.instances ?? {}).filter((n) => !hiddenName(n)).sort();
        const body = JSON.stringify({ rev, cards: board.views(cards, scope), projects, leads, stats: board.projectStats() });
        if (key) boardBodies.set(board, { key, body });
        jsonText(res, 200, body);
        return true;
      }
      if (method === "GET" && path === "/ui/tasks/work") {
        // #2246 step 3: each instance's work on the board — what its `task mine` reads (myWork) — for the board's
        // Instance list and an instance's Details page (`?instance=`): the fleet's instances and anyone else a live
        // card is assigned to. Over the public link, not those kept out of sight, nor a card that names one. Every
        // name's work is one workOf() read and the cards one views() read, whatever the number of instances (#2316
        // review); on the dashboard the answer is built once per board revision and the names asked for, and shared
        // by every open drawer (the public link's is filtered per request, as the board's).
        const only = url.searchParams.get("instance");
        const names = (only ? [only] : [...new Set([...Object.keys(ctx.fleetConfig?.instances ?? {}), ...board.liveAssignees()])]).filter((n) => !hiddenName(n));
        const key = gateway ? null : `${board.revision()}:${only === null ? "*" : `=${only}`}:${names.join("\u0000")}`;
        const kept = key ? workBodies.get(board) : undefined;
        if (kept && kept.key === key) { jsonText(res, 200, kept.body); return true; }
        const byName = board.workOf(names);
        const works = names.map((name) => ({ name, w: byName.get(name)! }));
        const all = new Map<string, Parameters<typeof board.views>[0][number]>();
        for (const { w } of works) for (const c of [...w.doing, ...w.blocked, ...w.review, ...w.ready, ...w.waiting.map((x) => x.card), ...w.mains.map((x) => x.card)]) if (!hidden(c)) all.set(c.uuid, c);
        const viewOf = new Map(board.views([...all.values()], scope).map((v) => [v.uuid, v]));
        const drawn = (cards: Array<{ uuid: string }>) => cards.flatMap((c) => (viewOf.has(c.uuid) ? [viewOf.get(c.uuid)!] : []));
        const codes = (cards: Array<{ card: { uuid: string; code: string } }>) => cards.filter((x) => all.has(x.card.uuid)).map((x) => x.card.code);
        const body = JSON.stringify({ instances: works.map(({ name, w }) => ({
          name,
          doing: drawn(w.doing), blocked: drawn(w.blocked), review: drawn(w.review), ready: drawn(w.ready),
          waiting: drawn(w.waiting.map((x) => x.card)), mains: drawn(w.mains.map((x) => x.card)),
          sentBack: codes(w.sentBack), newComments: codes(w.newComments),
        })) });
        if (key) workBodies.set(board, { key, body });
        jsonText(res, 200, body);
        return true;
      }
      if (method === "GET" && path === "/ui/tasks/search") {
        const names = new Map(board.listProjects(true).map((p) => [p.id, p.name]));
        const hits = board.search(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit")) || 20, scope).filter((h) => !hidden(h.card));
        const views = board.views(hits.map((h) => h.card), scope);
        const results = hits.map(({ card: c, match }, i) => ({
          card: views[i],
          match,
          project: c.projectId === null ? null : names.get(c.projectId) ?? null,
          parentTitle: c.parent && !hiddenRef(c.parent) ? board.findCard(c.parent)?.title ?? null : null,
        }));
        json(res, 200, { results });
        return true;
      }
      if (method === "GET" && card && !card[2]) {
        const found = board.getCard(ref);
        if (hidden(found)) { json(res, 404, { error: "no such card", code: "not_found" }); return true; }
        json(res, 200, shown(board.detail(ref, scope)));
        return true;
      }
      if (method === "POST" && path === "/ui/tasks/cards") {
        boardWrite(req, res, url, ctx, board, CardCreateSchema, (spec, person) => {
          const { cards, said } = board.createCards(person, { cards: [spec] });
          return { card: board.view(cards[0]!), notes: said };
        });
        return true;
      }
      if (method === "POST" && card) {
        if (card[2] === "move") {
          boardWrite(req, res, url, ctx, board, CardMoveSchema, ({ to, ...move }, person) => {
            const { card: moved, said } = board.moveCard(person, ref, to, move);
            return { card: board.view(moved), notes: said };
          });
        } else if (card[2] === "reorder") {
          boardWrite(req, res, url, ctx, board, CardReorderSchema, ({ after, before }, person) => ({ card: board.view(board.reorder(person, ref, after ?? null, before ?? null)) }));
        } else {
          boardWrite(req, res, url, ctx, board, CardPatchSchema, (patch, person) => {
            const { card: updated, said } = board.updateCard(person, ref, patch);
            return { card: board.view(updated), notes: said };
          });
        }
        return true;
      }
      if (method === "POST" && path === "/ui/tasks/projects") {
        boardWrite(req, res, url, ctx, board, ProjectCreateSchema, (input, person) => { checkLeadIsInstance(ctx, input.leadInstance); return { project: board.createProject(person, input) }; });
        return true;
      }
      if (method === "POST" && project) {
        boardWrite(req, res, url, ctx, board, ProjectPatchSchema, (patch, person) => { checkLeadIsInstance(ctx, patch.leadInstance); return { project: board.updateProject(person, Number(project[1]), patch) }; });
        return true;
      }
    } catch (err) {
      // A malformed %-escape in the card's address is the caller's mistake, not the server's.
      if (err instanceof URIError) { json(res, 400, { error: "bad card reference", code: "invalid" }); return true; }
      boardError(res, err);
      return true;
    }
    json(res, 404, { error: "Not found" });
    return true;
  }

  const taskMatch = path.match(/^\/ui\/tasks\/(.+)$/);
  if (method === "POST" && taskMatch) {
    if (!ctx.scheduler) {
      json(res, 500, { error: "Scheduler not initialized" });
      return true;
    }
    (async () => {
      try {
        const id = decodeURIComponent(taskMatch[1]);
        const body = await parseBody(req);
        if (!permitWebContinuation(req, res, ctx)) return;
        const parsed = parseOrReject(TaskUpdateSchema, body, res);
        if (!parsed) return;
        let result: unknown;
        // #1827: the person, who is also the default assignee of a claim; the task board's review gate needs to know
        // a person (not an instance) made the move.
        const person = webPersonOr401(req, res, url, ctx);
        if (!person) return;
        const by = boardActor(req, url, ctx, person);
        if (parsed.action === "claim") {
          result = ctx.scheduler!.db.claimTask(id, parsed.assignee || person.name, by);
        } else if (parsed.action === "complete") {
          result = ctx.scheduler!.db.completeTask(id, parsed.result, by);
        } else {
          // Strip action before passing remaining fields to updateTask
          const { action: _a, ...rest } = parsed;
          result = ctx.scheduler!.db.updateTask(id, rest, by);
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

  // #2293: global search — an admin's only: the header token or an admin session. Never a guest (not in GUEST_ROUTES).
  // #2478 (the user's request): over the public link too, unless web.search.public_link is false. Asked on arrival and
  // again before the answer is sent.
  if (method === "GET" && (path === "/ui/search" || path === "/ui/search/context")) {
    const refusal = (): [number, string] | null => {
      if (gatewayRequestContext(req) && ctx.fleetConfig?.web?.search?.public_link === false) return [404, "search_not_over_public_link"];
      if (guestRequestOf(req)) return [403, "guest_forbidden"];
      if (ctx.fleetConfig?.web?.search?.enabled === false || !ctx.searchIndex || ctx.searchIndex.status() === "unavailable") return [404, "search_unavailable"];
      return null;
    };
    const first = refusal();
    if (first) { json(res, first[0], { error: first[1] }); return true; }
    const admitted = adminAdmissionOf(req, url, ctx);
    if (!admitted) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return true; }
    const index = ctx.searchIndex!;
    // cross_instance_visibility "hidden" (fleet-traffic's rule): a message to or from such a name is not found.
    const visibility = () => ctx.searchVisibility?.() ?? { hidden: [] };
    const shown = (doc: { source: string; instance: string; peer: string | null }) => xmsgShown(doc, visibility());
    const finish = (status: number, body: unknown) => {
      const now = refusal();
      if (now) return json(res, now[0], { error: now[1] });
      if (adminAdmissionOf(req, url, ctx) !== admitted) return json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE });
      json(res, status, body);
    };
    const failed = (reason: string) => finish(reason === "timeout" || reason === "busy" ? 503 : 404, { error: `search_${reason}` });
    if (path === "/ui/search/context") {
      const key = url.searchParams.get("key") ?? "";
      if (!key || key.length > 300) { json(res, 400, { error: "key required" }); return true; }
      void index.context(key).then(r => {
        if (!r.ok) return failed(r.reason);
        const doc = r.value?.doc;
        // A message to or from an instance that is hidden now is not shown, as in the search itself.
        if (!doc || !shown(doc)) return finish(404, { error: "not_found" });
        finish(200, { ...r.value, building: r.building });
      }, () => failed("unavailable"));
      return true;
    }
    const parsed = parseSearchQuery(url, ctx);
    if ("error" in parsed) { json(res, 400, { error: parsed.error }); return true; }
    if (parsed.mine) {
      const person = webPersonOf(req, url, ctx);
      if (!person) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return true; }
      parsed.filters.mine = [person.voterKey];
    }
    const v = visibility();
    if ("hidden" in v) parsed.filters.hidden = v.hidden; else parsed.filters.xmsgAmong = v.among;
    void index.query(parsed.filters).then(r => {
      if (!r.ok) return failed(r.reason);
      // A chat row still in the history opens in place (#m=); one that has left it opens as the index's copy.
      const history = ctx.webChatHistory;
      // The visibility as it is now (#2295 review): a name hidden while the query ran is left out too.
      const now = visibility();
      const hits = r.value.hits.filter(h => xmsgShown(h, now)).map(h => h.source !== "chat" ? h
        : { ...h, live: !!history?.find(h.instance, String(h.ref.boot ?? ""), Number(h.ref.id)) });
      finish(200, { hits, limited: r.value.limited, building: r.building });
    }, () => failed("unavailable"));
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
    // Over the public link, where to turn it on: Settings → Web dashboard on the dashboard reached directly (this computer's own
    // address — the public link's Settings only reads). Never the public origin's own Settings, which cannot change it.
    const answer = ([status, error]: [number, string]) => json(res, status, {
      error, ...(status === 403 ? { settings: `http://localhost:${ctx.fleetConfig?.health_port ?? 19280}/settings/web-dashboard` } : {}) });
    const first = refusal();
    if (first) { answer(first); return true; }
    const admitted = admissionOf(req, url, ctx);
    if (!admitted) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return true; }
    void import("./usage-report.js").then(({ usageRange, usageGroup }) => ctx.usageReport!({
      range: usageRange(url.searchParams.get("range"), url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined),
      group: usageGroup(url.searchParams.get("group")),
    })).then(
      (report) => {
        const now = refusal();
        if (now) return answer(now);
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
    json(res, 200, ctx.trafficSnapshot?.() ?? { now: new Date().toISOString(), items: [], delegations: [] });
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

/**
 * #2272: the line a web reply's channel copy opens with — the quoted sender and first words when that message reached
 * the channel (its members saw it); a web-only one is only named, never copied out to the channel.
 */
export function webReplyEchoLine(quoted: WebChatMessage): string {
  if (!quoted.channel) return t("web.echo_reply_web_only");
  const ref = webChatReplyRef(quoted);
  const words = ref.text.slice(0, 120) || (ref.media === "photo" ? "[photo]" : ref.media ? "[file]" : "");
  return t("web.echo_reply", quoted.sender.slice(0, 80), words);
}

/** Keep the echo in a single platform message, including its attachment names. */
function webEchoPreview(message: string, names: string[]): string {
  const text = wellFormed(message.slice(0, 500));
  const files = names.length ? `[📎 ${names.map(name => displayName(name, "attachment")).join(", ")}]` : "";
  const preview = [text, files].filter(Boolean).join(" ");
  const truncated = message.length > 500 || preview.length > 1400;
  return wellFormed(preview.slice(0, 1400)) + (truncated ? ` … (${t("web.echo_full_text")})` : "");
}

/** Registration and liveness are different: a paused CLI may have neither daemon nor IPC. */
function registeredChatInstance(ctx: WebApiContext, name: string): boolean {
  return (!!ctx.fleetConfig && Object.hasOwn(ctx.fleetConfig.instances, name)) || ctx.isClassicInstance?.(name) === true;
}
function uploadRecipient(ctx: WebApiContext, name: string): boolean {
  return registeredChatInstance(ctx, name)
    && (ctx.instanceIpcClients.has(name) || ctx.getInstanceStatus?.(name) === "paused");
}
/** Closed, path-free explanations; arbitrary launch errors stay in the host log. */
function webDeliveryFailure(err: unknown): { reason: string; error: string } {
  const message = err instanceof Error ? err.message : "";
  if (/No warm slot is free/.test(message)) return { reason: "wake_capacity", error: "No slot is free to wake this instance. Retry when another instance is idle." };
  if (/login|log in|sign in|\bauth(?:entication|orization)?\b|credential|api.?key/i.test(message)) return { reason: "wake_credentials", error: "The instance could not sign in. Check its account on the host, then retry." };
  if (/timed? out|timeout/i.test(message)) return { reason: "wake_timeout", error: "The instance did not become ready in time. Retry, or check its status on the host." };
  if (/Cannot wake stopped|no longer configured/.test(message)) return { reason: "instance_stopped", error: "This instance was stopped or removed. Start it on the host before retrying." };
  return { reason: "delivery_unavailable", error: "The instance could not receive this message. Check its status on the host, then retry." };
}

/** Handle POST /ui/send — extracted for readability. */
/** Each web server's own memory of the sends it accepted by clientId (web-send-dedupe.ts). */
const webSendDedupes = new WeakMap<object, WebSendDedupe>();
function webSendDedupeOf(ctx: WebApiContext): WebSendDedupe {
  let d = webSendDedupes.get(ctx);
  if (!d) webSendDedupes.set(ctx, d = new WebSendDedupe());
  return d;
}

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
    // A claimed clientId is settled however this ends: with the messageId once accepted, else forgotten.
    let claim: Extract<WebSendClaim, { kind: "new" }> | undefined;
    let acceptedId: string | null = null;
    try {
      const raw = JSON.parse(body);
      const parsed = SendMessageSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        json(res, 400, { error: `${issue.path.join(".") || "body"}: ${issue.message}` });
        return;
      }
      const { instance, message: typed, attachments = [], replyTo, clientId } = parsed.data;
      // #1920 step 2b: a guest writes only to an in-scope instance, while guests may chat, and never a command.
      const guest = guestRequestOf(req);
      const refused = guestChatRefusal(guest, instance);
      if (refused) { json(res, refused.status, { error: refused.error }); return; }
      if (guest && guestCommandText(typed)) { json(res, 403, { error: "guest_no_commands" }); return; }
      // #2272: a reply names a message this chat still keeps — and, for a guest, one it may see. What it quotes is read
      // from that row here, never taken from the page.
      let quoted: WebChatMessage | undefined;
      if (replyTo) {
        quoted = ctx.webChatHistory?.find(instance, replyTo.boot, replyTo.id);
        if (!quoted || quoted.effectTrial || (guest && !guestSeesMessage(quoted, guest, guest.scope()))) {
          json(res, 409, { error: t("web.reply_gone"), reason: "reply_gone" });
          return;
        }
      }
      const registered = registeredChatInstance(ctx, instance);
      if (!registered && !ctx.instanceIpcClients.has(instance)) {
        json(res, 404, { error: `Instance not found: ${instance}` });
        return;
      }
      // #1827: who is writing — the name agents and chats see, and the id they tell people apart by. Asked now that the
      // body is in: a session revoked meanwhile sends nothing (not as the operator).
      const person = webPersonOf(req, new URL(req.url ?? "/", "http://localhost"), ctx);
      if (!person) { json(res, 401, { error: WEB_TOKEN_INVALID_MESSAGE }); return; }
      // #2438 follow-up: the page's Retry of a send that already went (its answer and the live copy lost) is that send:
      // answered with its messageId, delivered once. One still going is waited for; one that failed is sent anew.
      if (clientId) {
        const key = WebSendDedupe.key(person.key, instance, clientId);
        for (;;) {
          const seen = webSendDedupeOf(ctx).claim(key);
          if (seen.kind === "going") { await seen.settled; if (res.destroyed) return; continue; }
          if (seen.kind === "accepted") { json(res, 200, { sent: true, messageId: seen.messageId, repeated: true }); return; }
          claim = seen;
          break;
        }
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
      // Recheck the same admission all the way through a wake, before the facade's actual IPC handoff.
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      const admission = admissionOf(req, requestUrl, ctx);
      const stillCurrent = () => !res.destroyed && admission !== null && admissionOf(req, requestUrl, ctx) === admission
        && (!guest || (guest.current() && !guestChatRefusal(guest, instance)))
        && (registered ? registeredChatInstance(ctx, instance) : ctx.instanceIpcClients.has(instance));
      const message = typed;
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
      // Add no runtime credentials or local attachment paths to the display copy. A reply opens with the line it
      // answers (#2272) — quoted only if that message reached the channel; a web-only one is named, never copied out.
      const quoteLine = quoted ? webReplyEchoLine(quoted) : "";
      const plainPreview = webEchoPreview(message, files.map(f => f.name));
      const preview = (quoteLine ? `${quoteLine}\n` : "") + plainPreview;
      // #2281: where the quoted message is on a platform. An echo to the same place is a native reply to it there, and
      // then needs no quoted line; anywhere else (or a message with no known post) keeps the line, as before.
      const quotedPosts = quoted ? ctx.webChatHistory?.postsOf(quoted) ?? [] : [];
      const echoText = (p: string) => formatWebChannelEcho(person.name, p, t("web.echo_full_text"), { guest: !!guest });
      // ClassicBot echo (#1320 part B): same ordering lane, each room's setting (#2054: on unless it says false, or
      // the fleet-wide switch is off for a room that is unset) resolved at send time inside sendClassicWebEcho.
      const canClassicEcho = ctx.isClassicInstance?.(instance) === true && !!ctx.sendClassicWebEcho;
      const settleClassicEcho = canClassicEcho ? ctx.reserveWebChannelEcho?.(instance, async () => {
        const copies: import("./web-reactions.js").WebEchoCopy[] = [];
        const posted = await ctx.sendClassicWebEcho!(instance, echoText(preview), person.name, copies, quotedPosts.length ? { posts: quotedPosts, text: echoText(plainPreview) } : undefined);
        if (posted > 0) ctx.webMessageInChannel?.(instance, messageId, copies); // #1920 §5.2: the room saw it (#2305: its copies)
      }) : undefined;
      const settleEcho = canEcho ? ctx.reserveWebChannelEcho?.(instance, async () => {
        // A replacement adapter or edited binding is not the route we reserved.
        if ((ctx.getAdapterForInstance ? ctx.getAdapterForInstance(instance) : ctx.adapter) !== syncAdapter
          || (ctx.getGroupIdForInstance?.(instance) ?? String(ctx.fleetConfig?.channel?.group_id ?? "")) !== groupId
          || ctx.fleetConfig?.instances[instance]?.topic_id !== topicId) return;
        const native = quotedPosts.find(p => p.adapterId === syncAdapter.id && p.chatId === String(groupId) && (p.threadId ?? "") === String(topicId));
        const sent = await syncAdapter.sendText(String(groupId), echoText(native ? plainPreview : preview),
          { threadId: String(topicId), format: "text", allowedMentions: { parse: [] }, ...(native ? { replyTo: native.messageId } : {}) });
        const copyId = sent && typeof sent === "object" && typeof (sent as { messageId?: unknown }).messageId === "string" ? (sent as { messageId: string }).messageId : "";
        // #1920 §5.2: the topic saw it. #2305: and where it is, for a reaction to the web message (#2281: and a reply).
        const reacting = syncAdapter as unknown as import("./web-reactions.js").WebEchoCopy["adapter"];
        ctx.webMessageInChannel?.(instance, messageId, copyId
          ? [{ adapter: reacting, adapterId: syncAdapter.id, chatId: String(groupId), threadId: String(topicId), messageId: copyId }] : []);
        return sent;
      }) : undefined;
      let delivered: boolean | void;
      try {
        const deliver = (name: string, payload: Record<string, unknown>) => ctx.deliverHumanToInstance
          ? ctx.deliverHumanToInstance(name, payload, webHumanOrigin(false, authority), typed, { stillCurrent })
          : ctx.deliverToInstance(name, payload, { stillCurrent });
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
            // #2272: `(reply_to: "…")`, as a Discord or Telegram reply gives the agent.
            ...(quoted ? { reply_to_text: webChatReplyText(quoted) } : {}),
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
        json(res, 503, webDeliveryFailure(err));
        return;
      }
      if (delivered === false) {
        settleEcho?.(false);
        settleClassicEcho?.(false);
        ctx.webFiles?.release(files);
        ctx.logger.error({ instance }, "Web message not delivered (the instance went away or restarted)");
        json(res, 503, { reason: "delivery_changed", error: "The session or instance changed before this message was sent. Sign in again if needed, then retry." });
        return;
      }
      // The agent has it: from here on a repeat of this clientId is this send, whatever fails after (the echo, the
      // stream's copy) — a Retry then gets this messageId, never a second delivery.
      acceptedId = messageId;
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
      ctx.emitSseEvent("message", { instance, sender: person.name, role: "user", text: message, ts, attachments: files.map(publicAttachment), messageId, ...(person.bound ? { from: person.voterKey } : {}),
        ...(quoted ? { replyTo: webChatReplyRef(quoted) } : {}), ...(clientId ? { clientId } : {}) });
      json(res, 200, { sent: true, messageId });
    } catch {
      // A failure after the agent has it is no failed send: the page is told it went (a Retry would only find it).
      if (res.headersSent) { /* answered already: the failure was in or after the answer */ }
      else if (acceptedId) json(res, 200, { sent: true, messageId: acceptedId });
      else json(res, 400, { error: "Invalid JSON" });
    } finally {
      claim?.settle(acceptedId);
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
  if (!instance || instance.length > 128 || !safeInstanceSegment(instance) || !uploadRecipient(ctx, instance)) {
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
  // Recheck registration and delivery readiness after both waits. A paused recipient may have no IPC;
  // staging a file never wakes it. A stopped or deleted recipient must not regain an upload id.
  const deliverable = () => uploadRecipient(ctx, instance);
  const gone = () => drop(() => json(res, 404, { error: `Instance not found: ${instance}` }));
  // #2366: a guest's scope (and whether guests may chat) is asked again at each commit point — narrowed, revoked or made
  // read-only while the body was arriving, the upload is refused and its part file removed, as it would have been at
  // the start. Read now: the scope is never stored (guestRequestOf's scope() is the fleet's guestScope as it is now).
  const guestNow = () => guestChatRefusal(guestRequestOf(req), instance);
  const refuseGuest = (r: { status: number; error: string }) => drop(() => json(res, r.status, { error: r.error }));
  req.on("end", () => {
    if (over) return;
    clocks();
    if (!permitWebContinuation(req, res, ctx)) { drop(); return; }
    const name = displayName(typeof req.headers["x-agend-filename"] === "string" ? req.headers["x-agend-filename"] : "", "file");
    const type = sniffer.result(name);
    if (!type) { drop(() => json(res, 415, { error: "the file is empty" })); return; }
    const refusedAtEnd = guestNow();
    if (refusedAtEnd) { refuseGuest(refusedAtEnd); return; }
    if (!deliverable()) { gone(); return; }
    out.end(() => {
      if (over) return;
      // The write's finish is another wait (Prism #1941 P2-1): the session or the public link may have ended in it.
      if (!permitWebContinuation(req, res, ctx)) { drop(); return; }
      const refusedAtFinish = guestNow();                     // #2366: and the guest's scope may have changed in it
      if (refusedAtFinish) { refuseGuest(refusedAtFinish); return; }
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
  readonly fleetConfig?: { web?: { usage_panel?: boolean; log_tab?: boolean; upload_max_file_mb?: number; upload_max_total_mb?: number; experimental?: { canvas_worker?: boolean }; search?: { public_link?: boolean } } } | null;
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
    + ` data-canvas-worker="${canvasWorkerEnabled(ctx.fleetConfig?.web) ? "1" : "0"}"`
    // #1937: the upload limits in force for this page (the config's; the public link's own cap on it) — what the chat
    // checks before sending a file, and the numbers its words say. The server checks again on every upload.
    + ` data-upload-limits="${attr(JSON.stringify(uploadLimits(ctx.fleetConfig?.web, { publicLink: gatewayRequestContext(req) !== undefined })))}"`
    // #1770: the fleet's zone (chat-logs' and fleet.log's), in which the chat reads its message times and days.
    + ` data-fleet-tz="${attr(resolveTz())}"`
    // #1629 r4 §3: the person's owner CSS in force (a sha), linked by the page unless this device or this load says not.
    + ` data-owner-css-state="${ownerCssState}"${ownerCss ? ` data-owner-css="${attr(ownerCss)}"` : ""}`
    // #1589: the public link shows attachments as downloads only (no inline text or media): its scope is unchanged.
    + `${gatewayRequestContext(req) ? ' data-public-link="1"' : ""}`
    // #2478: search is offered over the public link unless web.search.public_link is false (the page then shows no entry).
    + `${gatewayRequestContext(req) && ctx.fleetConfig?.web?.search?.public_link === false ? ' data-search-link="0"' : ""}`
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
    sendPanelHtml(res, withAppIconLinks(html).replace('<html lang="en">', shellHtmlTag(ctx, mode, viewer)).replace("<body>", shellBodyTag(req, ctx, mode, viewer)), 200, {}, { ...(frameSrc ? { frameSrc } : {}), mediaSrc });
  } catch {
    json(res, 500, { error: "app.html not found" });
  }
}
