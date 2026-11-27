import {HUB_ROOM_HISTORY_CAPABILITY} from "../room-history-model.js";
import { HUB_ROOM_REACT_ACK_CAPABILITY } from "../room-react-ack-model.js";
import { HubRoomAgentDiscovery } from "../room-agent-discovery.js";
import { roomDiscoverySupported } from "../room-agent-discovery-model.js";
import {HUB_ROOM_ANSWER_STATUS_CAPABILITY} from "../room-answer-status-model.js";
import {HUB_ROOM_MEMBERS_CAPABILITY} from "../room-members-model.js";
import {HUB_ROOM_BRIEF_CAPABILITY} from "../room-brief-model.js";
import {defaultAgentIntro,HUB_AGENT_INTRO_CAPABILITY} from "../agent-intro-model.js";
import { HubAgentIntroTool } from "../agent-intro-tool.js";
import { HubPreviousAccess } from "../sharing-previous-access.js";
import { HubAgentIntros } from "../agent-intro.js";
import { HubSharingRequests } from "../sharing-requests.js";
import { HubAgentCatalogs } from "../agent-catalog.js";
import { HubAgentPictures } from "../agent-pictures.js";
import {hubAdminOverviewPermit} from "../roles/overview.js";
import { HUB_ROOM_CONTEXT_CAPABILITY } from "../room-context-model.js";
/**
 * AgEnD Hub P1, slice 3 (server side): S3's composition entry (docs/design/hub-composition.md §5 step 5, §6).
 *
 * `createHubHttp(deps)` → `{ handle, receive, close }` plus `HUB_HTTP_MIGRATIONS`. S5's server factory imports this file
 * lazily, only with `hub.enabled` on and the manifest sealed; nothing here runs on the ordinary off path.
 *
 * - `handle(req, res)` serves the Hub web listener (its own origin; never the fleet's):
 *   - `/hub/v1/*`, with methods enumerated per path;
 *   - the Hub workspace pages (`/`, `/web`, `/ui`, `/ui/hub*`), drawn Hub-only;
 *   - the Hub's lazy modules under `/ui/js/` and the app's public `/assets/`.
 *   Anything else returns false (the ordinary not-found is S5's). It reads exactly one cookie,
 *   `__Host-agend_hub_<hubId>`, and never a fleet cookie, bearer token or member credential.
 * - `receive(frame, link)` is S1's HubServer callback for an authenticated member link.
 * - `close()` forgets the links. S5 closes the DB.
 */
import { HubAdminDashboard } from "../admin-dashboard.js";
import { HubVersionRecommendations, HubRecommendationRefusal } from "../recommendations.js";
import { HubSessionLimitSettings, HubSessionLimitRefusal } from "../session-limits.js";
import { HubFleetUpdates, HubFleetUpdateRefusal } from "../fleet-updates.js";
import { HubFleetVersions } from "../fleet-versions.js";
import { HubGroupPolicyError } from "../group-policy/errors.js";
import { GROUP_POLICY_FEATURE, handleGroupHttp } from "../group-policy/admin-api.js";
import { handleHubDirectorySettingsHttp, HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE, HUB_DIRECTORY_EDITOR_FEATURE } from "../settings-directory-http.js";
import { handleHubSettingsHttp } from "../settings-api.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HubProtocolError, parseStrictJson } from "../validation.js";
import { personKeyString } from "../identity.js";
import { parsePersonPrefs, readPersonPrefs, writePersonPrefs } from "../person-prefs.js";
import { HubEnrolmentCodeLimit } from "../enrolment-code.js";
import type { HubMemberFrame, HubServerFrame } from "../types.js";
import type { HubLinkContext } from "../server.js";
import type { HubDirectoryBrowserSessions } from "../settings-directory-runtime.js";
import { HubSessions, hubClearCookie, hubSetCookie, hubCookieName } from "../sessions.js";
import { HubCatalogService } from "../catalog.js";
import { HubGrantSearch } from "../grant-search.js";
import { HubPolicyService } from "../policy.js";
import { HubRoomsService } from "../rooms.js";
import { HubRoomAdmin } from "../rooms/admin.js";
import { HubGroupRooms, HubRoomRefusal } from "../rooms/service.js";
import { HUB_ROOM_OFFICE_FEATURE, type RoomCharacter, type RoomOfficeLook } from "../rooms/office.js";
import { SHARE_MODULES } from "../../office-share-page.js";
import { HubDirectPosts, HUB_DIRECT_POST_CAPABILITY } from "../direct-posts.js";
import { directMessages, directRoomView, directUnread, markDirectRead } from "../rooms/direct-view.js";
import { HubAttachmentRefused } from "../attachments/store.js";
import { HubQuotaService } from "../quota.js";
import { HubCore, pairingOwnerByLogin } from "./core.js";
import { HubSharingPaused, HubSharingService } from "../sharing.js";
import { HUB_HTTP_MIGRATIONS } from "./schema.js";
import type { HubHttpDeps, HubTxDatabase } from "./deps.js";
import { handleWebIconRequest } from "../../web-icons.js";
import { serveHubWorkspaceShell } from "../../web-api.js";
import { servePublicAsset } from "../../auth-api.js";
import { handleCompanyJoin, companyFlowCookie } from "../join/http.js";
import { CompanyJoinCodeRefusal, CompanyJoinLimit, CompanyJoinOfferPending } from "../join/service.js";
import { HubMemberAddressError } from "../settings-member-address-policy.js";
import { HubMcpDoor } from "../mcp/http.js";

export { HUB_HTTP_MIGRATIONS };
/** S5's lazy entry (HubHttpEntry): this module itself — `createHubHttp` and `migrations`. */
export const migrations = HUB_HTTP_MIGRATIONS;
export type { HubHttpDeps, HubTxDatabase };

/** The Hub's lazy modules a Hub page may load (the fleet's /ui/js/ modules are never served here). */
/**
 * M-3533 R1: the Office drawing a room's office loads (hub-room-office.js's import(), never a static import): the share
 * page's modules but its own page — the same drawing a share link shows, read-only, no fleet read behind it.
 */
export const HUB_OFFICE_MODULES: readonly string[] = Object.freeze(SHARE_MODULES.filter(f => f !== "office-share-page.js"));
export const HUB_UI_MODULES = Object.freeze(["panel-hub.js", "hub-notify-keep.js", "hub-personal-agent.js", "hub-personal-agent-strings.js", "runtime-commands.js", "hub-client.js", "hub-strings.js", "hub-chat-store.js", "hub-chat-strings.js", "hub-quota.js", "hub-agent-intro.js", "hub-intro-notice.js", "hub-owner-strings.js", "hub-grant-strings.js", "hub-button-actions.js", "hub-preview.js", "hub-attachments.js",
  // #3298 S-89 (lazy; loaded only when the session says "group-policy-v1"): the welcome, Group permissions and their words.
  "hub-welcome.js", "hub-group-policy.js", "hub-group-strings.js", "hub-read-strings.js", "hub-quick-pairing.js", "hub-quick-strings.js", "hub-company-join.js", "hub-company-join-strings.js", "hub-this-hub.js", "hub-directory-notices.js", "hub-directory-notice-strings.js", "hub-directory-editor.js", "hub-directory-editor-strings.js",
  // Hub UX U2 (M-2932): the group-search picker (its own words inside), shared with B2's join-code scope.
  "hub-my-agents.js", "hub-my-agents-model.js", "hub-my-agents-strings.js", "hub-group-search.js", "hub-join-steps.js", "hub-grant-picker.js", "hub-subject-picker.js", "hub-policy-subjects.js",
  // B2: code management and the same-request Hub approval queue.
  "hub-enrolment-code.js", "hub-enrolment-code-strings.js", "hub-join-queue.js", "hub-join-approval.js", "hub-joincode-flow-strings.js",
  // Hub rooms (hub-rooms-ux.md §§2,5): the rooms words (#3850) then the presence helper (pure, no DOM).
  "hub-room-strings.js", "hub-room-presence.js",
  // Hub rooms §12: unread counts and the Fleet desktop-notify rule (lazy; screens load it),
  // then the notifier that pings on @mention/answer/invitation.
  "hub-room-unread.js", "hub-room-notify.js",
  // Hub rooms, track U2 (dev-claude2; hub-rooms-split.md section 3): new room, room settings, members rail, invitations,
  // 管理 → 房間.
  "hub-room-new.js", "hub-room-purpose.js", "hub-room-new-strings.js", "hub-room-settings.js", "hub-room-owner-requests.js", "hub-room-owner-requests-strings.js", "hub-room-settings-strings.js", "hub-room-members.js", "hub-room-members-strings.js", "hub-invitations.js", "hub-invitations-strings.js", "hub-admin-rooms.js", "hub-admin-rooms-strings.js",
  // M-3092 (Hub rooms, track U): the conversation list, a room on the shared thread, its composer.
  "hub-room-list.js", "hub-room-thread.js", "hub-room-agent-strings.js", "hub-room-composer.js", "hub-assistant-admin.js", "hub-assistant-admin-strings.js",
  // M-3092 S-145: the list's favourites (the Fleet sidebar's #1664 rules; synced per person by the Hub).
  "hub-room-favorites.js",
  // M-3340: personal pins in a room (its list and 📌; the store keeps them in hub-room-thread.js).
  "hub-room-pins.js",
  // M-3533 R1: a room's office tab (the Office drawing itself is HUB_OFFICE_MODULES, loaded by its import()).
  "hub-room-office.js",
  // S-148: the working bar's words (#3857), shared by the room thread.
  "hub-room-working.js", "hub-teams.js", "hub-teams-strings.js", "hub-roles.js", "hub-roles-strings.js", "hub-role-view.js", "hub-role-forms.js", "hub-role-audit.js", "hub-role-notices.js", "hub-room-search.js",
  // M-3137: Fleet versions (Connected fleets' columns and summary, the older-Fleet banner) with its own words.
  "hub-fleet-versions.js",
  // M-3162: Administration → Overview (the counts dashboard), its own words.
  "hub-admin-overview.js", "hub-ai-apps.js", "hub-ai-apps-strings.js", "hub-room-source.js", "hub-room-source-strings.js",
  // M-3592: Administration → Sign-in.
  "hub-session-limits.js"]);
const BODY_LIMIT = 96 * 1024;
const UPLOADS_PER_SESSION = 2, UPLOADS_TOTAL = 8;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const API_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } as const;

export interface HubHttp {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  receive(frame: Exclude<HubMemberFrame, { type: "hello" }>, link: HubLinkContext): Promise<HubServerFrame | void>;
  close(): Promise<void>;
  /** Private retention root port; never a browser route or an authority source. */
  retainedContentRefs?(): readonly string[];
  memberClosed?(fleetId: string): void;
  memberConnected?(link: HubLinkContext): void;
  memberReady?(link: HubLinkContext): void;
  readonly agentIntroV1?: true;
  readonly agentCatalogV1?: true;
  /** M-3533 R2b: this Hub takes shared agents' pictures (agent-pictures-v1); the room page draws them. */
  readonly agentPicturesV1?: true;
  /** M-3533 R2c: the agents' own characters ride the pictures report (agent-characters-v1). */
  readonly agentCharactersV1?: true;
  readonly exposureRequestsV1?: true;
  readonly roomAskerIdentityV1?: true;
  /** #3298 S-89: what this Hub offers its pages ("group-policy-v1" only with deps.groupHttp). Presentation only. */
  readonly features: readonly string[];
  readonly directorySessions: HubDirectoryBrowserSessions;
}

class SignedOut extends Error {}
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const STATUS: Record<string, number> = { invalid: 400, denied: 403, revoked: 403, "not-found": 404, conflict: 409, stale: 409, expired: 410,
  backpressure: 429, unavailable: 503, uncertain: 503, incompatible: 400 };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { ...API_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" || req.headers["content-encoding"] !== undefined) throw new HttpError(415, "invalid");
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of req) {
    const b = Buffer.from(part as Buffer); bytes += b.length;
    if (bytes > BODY_LIMIT) { req.destroy(); throw new HttpError(413, "invalid"); }
    chunks.push(b);
  }
  const value = parseStrictJson(Buffer.concat(chunks), BODY_LIMIT);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HubProtocolError("invalid");
  return value as Record<string, unknown>;
}
/** The upload's name: X-File-Name, percent-encoded UTF-8, one path segment. */
function fileName(v: unknown): string {
  let name: string;
  try { name = typeof v === "string" && v.length <= 1024 ? decodeURIComponent(v) : ""; } catch { name = ""; }
  if (!name || Buffer.byteLength(name, "utf8") > 255 || /[\\/\u0000-\u001f\u007f]/.test(name) || name.startsWith(".") || name.trim() !== name) throw new HubProtocolError("invalid");
  return name;
}
/** A raw request body, never decoded, cut off past `limit` bytes. */
async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (req.headers["content-encoding"] !== undefined) throw new HttpError(415, "invalid");
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d{1,10}$/.test(declared) || Number(declared) > limit)) { req.resume(); throw new HttpError(413, "too-large"); }
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of req) {
    const b = Buffer.from(part as Buffer); bytes += b.length;
    if (bytes > limit) { req.destroy(); throw new HttpError(413, "too-large"); }
    chunks.push(b);
  }
  if (bytes === 0) throw new HubProtocolError("invalid");
  return Buffer.concat(chunks);
}
const str = (v: unknown, max = 256): string => { if (typeof v !== "string" || !v || v.length > max) throw new HubProtocolError("invalid"); return v; };
const uuid = (v: unknown): string => { if (typeof v !== "string" || !UUID.test(v)) throw new HubProtocolError("invalid"); return v; };
const int = (v: unknown): number => { const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v; if (!Number.isSafeInteger(n) || (n as number) < 0) throw new HubProtocolError("invalid"); return n as number; };

/** Build S3's HTTP handler and member receiver over S5's deps. `sql` is S5's `hubTxDatabase`. */
export function createHubHttp(deps: HubHttpDeps, sql: HubTxDatabase): HubHttp {
  let closed = false;
  const teamFactory = deps.teams;
  const personalFactory=deps.personalAgents;
  // Keep the caller's other dependency reads live, without installing Team state on its shared object.
  const mountedDeps: HubHttpDeps = teamFactory||personalFactory ? Object.create(deps) : deps;
  const core = new HubCore(mountedDeps, sql, () => !closed);
  const teams = teamFactory?.(core);
  if (teams) Object.defineProperties(mountedDeps, {
    roomTeams: { value: teams }, roomTeamCandidates: { value: teams.candidates.bind(teams) },
  });
  const intros = new HubAgentIntros(core);
  const introTool = new HubAgentIntroTool(core);
  const sharing = new HubSharingService(core);
  const personal=personalFactory?.(core);
  if(personal)Object.defineProperty(mountedDeps,"personal",{value:personal.turns});
  const sessionLimits = new HubSessionLimitSettings(core);
  const sessions = new HubSessions(core), catalog = new HubCatalogService(core, publishSharingSettlement), policy = new HubPolicyService(core, deps.log);
  const grantSearch = new HubGrantSearch(core);
  const ownerIntro=(e:{id:string;fleetId:string|null})=>{
    const value=intros.projection(e.id),report=e.fleetId?agentCatalogs.reportOf(e.fleetId):null;
    const row=report?.link?.features.has(HUB_AGENT_INTRO_CAPABILITY)?report.catalog.agents.find(a=>a.exposure?.id===e.id):undefined;
    return {...value,...(!value.introBy&&row?{introDefault:defaultAgentIntro(row.description)}:{})};
  };

  const rooms = new HubRoomsService(core, policy);
  const groupRooms = new HubGroupRooms(core, deps.roomOffice === true);
  const directPosts=new HubDirectPosts(core,(roomId,asker,id)=>{
    if(id){groupRooms.publish({type:"message.added",roomId,data:{roomId,messageId:id},audiencePerson:asker});groupRooms.publish({type:"unread.changed",roomId,data:{roomId},audiencePerson:asker});}
    else groupRooms.publish({type:"room.changed",roomId,data:{roomId},audiencePerson:asker});
  });
  /**
   * M-3596: a 1:1 room's agent as its asker sees it. The room's own presence (offline, paused, held) wins; on a current link
   * the agent's reported state (agent.state: working, or paused with a reason) says whether it is busy right now.
   */
  const directPresence = (exposureId: string): ReturnType<typeof rooms.presence> => {
    const own = rooms.presence(exposureId);
    if (own !== "idle") return own;
    const reported = groupRooms.agents.presence(exposureId).presence;
    return reported === "working" || reported === "paused" ? reported : own;
  };
  const mcp = new HubMcpDoor(core,sessions,{groups:groupRooms,direct:rooms,catalog});
  const invitations = deps.roomInvitations?.(core, groupRooms.invitationHost());
  const roomAgentRequests = deps.roomAgentRequests?.(core, groupRooms.invitationHost());
  const roomDiscovery = core.atomic(roomDiscoverySupported) ? new HubRoomAgentDiscovery(core) : null;
  const roomAdmin = new HubRoomAdmin(core, event => groupRooms.publish(event), id => { groupRooms.assistant.forget(id); groupRooms.agents.sweep(id); });
  const quota = new HubQuotaService(core);
  const fleetVersions = new HubFleetVersions(core);
  const agentCatalogs = new HubAgentCatalogs(core);
  // M-3533 R2a: a room office draws each shared agent in its owner's colour and emoji, from the owner's catalog rows.
  // M-3533 R2b: and its pictures (the sidebar's disc, the identity card's portrait) as its Fleet last reported them.
  const agentPictures = new HubAgentPictures(core);
  groupRooms.looks = (fleetId) => {
    const report = agentCatalogs.reportOf(fleetId), pictures = agentPictures.looksOf(fleetId);
    if (!report && !pictures.size) return null;
    const out = new Map<string, RoomOfficeLook>(report ? report.catalog.agents.filter((a) => a.exposure && a.avatar).map((a) => [a.exposure!.id, { color: a.avatar!.color, emoji: a.avatar!.emoji }]) : []);
    for (const [id, p] of pictures) if (p.disc || p.portrait || p.character) out.set(id, { ...(out.get(id) ?? { color: null, emoji: null }), ...(p.disc ? { disc: p.disc } : {}),
      ...(p.portrait ? { portrait: p.portrait } : {}), ...(p.character ? { character: p.character as RoomCharacter } : {}) });
    return out;
  };
  groupRooms.pictureFile = (sha256) => agentPictures.file(sha256);
  agentPictures.changed = (ids) => { if (live()) groupRooms.lookChanged(ids); };
  agentPictures.start();
  /** The owner's own view: which of a Fleet's agents have a picture too large to show (My agents says so; nobody else sees it). */
  const picturesTooLarge = (fleetId: string) => {
    const out: Record<string, string[]> = Object.create(null);
    for (const [id, p] of agentPictures.looksOf(fleetId)) if (p.tooLarge?.length) out[id] = p.tooLarge;
    return Object.keys(out).length ? out : null;
  };
  const previousAccess = new HubPreviousAccess(core, agentCatalogs);
  const sharingRequests = new HubSharingRequests(core, agentCatalogs, publishSharingSettlement);
  const recommendations = new HubVersionRecommendations(core, fleetVersions);
  const fleetUpdates = new HubFleetUpdates(core, fleetVersions, recommendations);
  const dashboard = new HubAdminDashboard(core, fleetVersions, recommendations);
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui");
  const live = () => !closed && core.live();
  const grantSubjectsOffered = () => !!deps.grantDirectory && deps.directory.groupPolicy === "ad-direct-guid"
    && typeof deps.directory.searchPolicyGroups === "function" && typeof deps.directory.searchGrantPeople === "function"
    && typeof deps.directory.resolvePolicyGroup === "function" && typeof deps.directory.readPolicyGroups === "function";
  /** Upload bodies being read now, per session and in all (each up to the file limit in memory). */
  const uploading = new Map<string, number>(); let uploadingTotal = 0;
  const streams = new Set<() => void>();

  /** One API request: method and path enumerated, mutations same-origin with the session's CSRF token. */
  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? "GET";
    if (!live()) throw new HubProtocolError("unavailable");
    const ctx = sessions.context(req);
    const mutation = method !== "GET" && method !== "HEAD";
    if (mutation && !sessions.sameOrigin(req)) throw new HttpError(403, "cross-site");
    /** A session for this request (the second check after the body re-runs it inside each service call). */
    const signedIn = () => { const s = sessions.session(ctx.token); if (!s) throw new SignedOut(); return s; };
    const csrf = () => { const s = signedIn(); if (!sessions.csrfOk(req, s.token)) throw new HttpError(403, "csrf"); return s; };
    const body = async () => { const b = await readBody(req); if (!live()) throw new HubProtocolError("unavailable"); return b; };
    const guard = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await work(); } catch (e) { if (e instanceof HubProtocolError && e.code === "revoked" && !sessions.session(ctx.token)) throw new SignedOut(); throw e; }
    };
    const m = (re: RegExp) => re.exec(path);
    if(path==="/hub/v1/admin/personal-agents"){
      if(!personal)throw new HttpError(404,"not-found");
      if(query.size)throw new HubProtocolError("invalid");
      if(method!=="GET"&&method!=="PUT")throw new HttpError(405,"method");
      if(method==="PUT")csrf();else signedIn();
      const input=method==="PUT"?await body():undefined;
      return send(res,200,await guard(()=>personal.owner.settings(ctx,input)));
    }
    if(path==="/hub/v1/me/personal-agent"||path==="/hub/v1/me/personal-agent/enrollment"||path==="/hub/v1/me/personal-agent/refresh"){
      if(!personal)throw new HttpError(404,"not-found");
      if(query.size)throw new HubProtocolError("invalid");
      if(path.endsWith("/refresh")){
        if(method!=="POST")throw new HttpError(405,"method");csrf();const input=await body();
        return send(res,200,await guard(()=>personal.owner.refreshComputer(ctx,input)));
      }
      if(path.endsWith("/enrollment")){
        if(method!=="POST")throw new HttpError(405,"method");csrf();const input=await body();
        const installer=deps.personalInstaller?.();
        const enrollment=await guard(()=>personal.owner.enrollment(ctx,input));
        return send(res,200,{...enrollment,...(installer?{installer,server:deps.config.webOrigin}:{} )});
      }
      if(method==="GET"){signedIn();return send(res,200,await guard(()=>personal.owner.view(ctx)));}
      if(method==="DELETE"){csrf();const input=await body();const result=await guard(()=>personal.owner.disconnect(ctx,input));personal.turns.wake();return send(res,200,result);}
      if(method!=="PUT")throw new HttpError(405,"method");csrf();const input=await body();
      const exposure=await guard(()=>personal.owner.publish(ctx,input));groupRooms.agents.publicationChanged(undefined,exposure.id);
      personal.turns.wake();return send(res,200,{exposure});
    }
    if (path === "/hub/v1/me/fleets") {
      if (method !== "GET") throw new HttpError(405, "method");
      if (query.size) throw new HubProtocolError("invalid");
      signedIn(); const owner = await guard(() => ctx.requirePerson());
      return core.atomic(() => {
        signedIn();
        const recommendedVersion = recommendations.settings().recommendedVersion;
        const fleets = deps.store.read().fleets.filter(f => f.status === "active" && personKeyString(f.owner) === personKeyString(owner))
          .map(f => { const view = fleetVersions.view(f.id, recommendedVersion); return { id: f.id, label: f.label ?? null, version: view.version, versionState: view.versionState }; });
        send(res, 200, { fleets });
      });
    }
    if (path === "/hub/v1/me/agent-sharing" || /^\/hub\/v1\/me\/agent-sharing\/[a-f0-9-]{36}$/.test(path)) {
      if (query.size) throw new HubProtocolError("invalid");
      if (path === "/hub/v1/me/agent-sharing") {
        if (method !== "POST") throw new HttpError(405, "method");
        csrf(); const input = await body();
        return send(res, 200, await guard(() => sharingRequests.request(ctx, input)));
      }
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, await guard(() => sharingRequests.view(ctx, path.split("/").at(-1)!)));
    }
    if (path === "/hub/v1/me/agents/refresh") {
      if (method !== "POST") throw new HttpError(405, "method");
      if (query.size) throw new HubProtocolError("invalid");
      csrf(); const input = await body();
      return send(res, 200, await guard(() => agentCatalogs.refresh(ctx, input)));
    }
    const previousMatch = /^\/hub\/v1\/me\/agents\/([a-f0-9-]{36})\/previous-access$/.exec(path);
    if (previousMatch) {
      if (query.size) throw new HubProtocolError("invalid");
      if (method === "GET") { signedIn(); return send(res, 200, await guard(() => previousAccess.view(ctx, previousMatch[1]!))); }
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const input = await body();
      return send(res, 200, await guard(() => previousAccess.use(ctx, previousMatch[1]!, input)));
    }
    if (path === "/hub/v1/me/agents") {
      if (method !== "GET") throw new HttpError(405, "method");
      if (query.size) throw new HubProtocolError("invalid");
      signedIn(); return send(res, 200, await guard(async () => {
        const view = await agentCatalogs.view(ctx);
        return { ...view, fleets: view.fleets.map(f => { const tooLarge = picturesTooLarge(f.id); return tooLarge ? { ...f, picturesTooLarge: tooLarge } : f; }) };
      }));
    }
    // Composed routes, not enrollment authority or the administrator's on/off switch. Older Hubs omit unsupported cards.
    const offered = ["agent-intro-defaults-v1", "agent-sharing-v1", "agent-intros-v1", "admin-dashboard-v1", "rooms-v1", "room-purpose-v1", "room-pins-v1", "person-prefs-v1", ...(roomAgentRequests ? ["room-owner-requests-v1"] : []), ...(roomDiscovery ? ["room-agent-discovery-v1"] : []), ...(personal ? ["personal-agents-v1"] : []), ...(teams ? ["teams-v1"] : []), ...(deps.roleAdmin ? ["role-settings-v1"] : []), ...(deps.roomAssistant && deps.assistantAdmin ? ["room-assistant-v1"] : []), ...(deps.refreshAuthorization ? ["sharing-pause-v1"] : []), ...(deps.groupHttp ? [GROUP_POLICY_FEATURE, ...(deps.pairingNotices ? ["quick-pairing-v1"] : [])] : []), ...(grantSubjectsOffered() ? ["grant-subjects-v1"] : []),
      ...(deps.companyJoin ? ["company-join-v1", "enrolment-code-v1"] : []), ...(deps.directoryNotices ? ["directory-security-notices-v1"] : []), ...(deps.memberAddressNotices ? ["member-address-notices-v1"] : []),
      ...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE, HUB_DIRECTORY_EDITOR_FEATURE] : [])];
    offered.push("mcp-apps-v1");
    if (deps.roomOffice) offered.push(HUB_ROOM_OFFICE_FEATURE);
    const features = offered.length ? { features: offered } : {};
    let r: RegExpExecArray | null;

    if (deps.companyJoin && path === "/hub/v1/join/browser") {
      if (method !== "GET") throw new HttpError(405, "method");
      const requestId = uuid(query.get("request"));
      return send(res, 200, deps.companyJoin.browserView(companyFlowCookie(req, deps.config.hubId, requestId), requestId));
    }
    if (deps.companyJoin && path === "/hub/v1/join/approve") {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); if (Object.keys(b).length !== 1) throw new HubProtocolError("invalid");
      const requestId = uuid(b.requestId);
      return send(res, 200, await deps.companyJoin.approve(ctx, companyFlowCookie(req, deps.config.hubId, requestId), requestId));
    }
    if (deps.companyJoin && (path === "/hub/v1/admin/enrolment-codes" || /^\/hub\/v1\/admin\/enrolment-codes\/[0-9a-f-]+\/revoke$/.test(path))) {
      if (path === "/hub/v1/admin/enrolment-codes" && method === "GET") { signedIn(); return send(res, 200, await deps.companyJoin.listCodes(ctx)); }
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body();
      if (path === "/hub/v1/admin/enrolment-codes") return send(res, 201, await deps.companyJoin.createCode(ctx, b));
      if (Object.keys(b).length) throw new HubProtocolError("invalid");
      return send(res, 200, await deps.companyJoin.revokeCode(ctx, uuid(path.split("/")[5])));
    }
    if (deps.companyJoin && path === "/hub/v1/admin/company-join/invitations") {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); if (Object.keys(b).length !== 1) throw new HubProtocolError("invalid");
      const owner = await guard(() => pairingOwnerByLogin(core, ctx, str(b.login).trim()));
      if (!owner) throw new HubProtocolError("not-found");
      return send(res, 200, await deps.companyJoin.createInvitation(ctx, owner));
    }
    if (deps.companyJoin && path === "/hub/v1/admin/company-join") {
      if (method === "GET") { signedIn(); const permit = await core.management(ctx, "join.manage"), view = deps.companyJoin.adminView(); permit.assertCurrent(); return send(res, 200, view); }
      if (method !== "PUT") throw new HttpError(405, "method");
      csrf(); return send(res, 200, await deps.companyJoin.configure(ctx, await body()));
    }

    if (path === "/hub/v1/session") {
      if (method === "GET") {
        const s = sessions.session(ctx.token);
        const roleView = s && deps.roleAdmin ? await guard(() => deps.roleAdmin!.presentation(ctx)) : {};
        return send(res, 200, s ? { signedIn: true, displayName: s.displayName, login: s.login, admin: s.admin, csrf: s.csrf, hub: { name: deps.config.name }, ...features, ...roleView }
          : { signedIn: false, hub: { name: deps.config.name } });
      }
      if (method === "POST") {
        const b = await body();
        const out = await sessions.signIn(b.login, b.password);
        const { csrf: token, ...view } = out.view;
        const roleCtx = deps.roleAdmin ? sessions.context({headers:{cookie:`${hubCookieName(deps.config.hubId)}=${out.token}`}} as IncomingMessage) : null;
        const roleView = roleCtx ? await guard(() => deps.roleAdmin!.presentation(roleCtx)) : {};
        return send(res, 200, { signedIn: true, displayName: view.displayName, login: view.login, admin: view.admin, csrf: token, hub: { name: deps.config.name }, ...features, ...roleView },
          { "Set-Cookie": hubSetCookie(deps.config.hubId, out.token, out.maxAgeMs) });
      }
      if (method === "DELETE") { csrf(); sessions.signOut(ctx.token); return send(res, 200, { signedIn: false }, { "Set-Cookie": hubClearCookie(deps.config.hubId) }); }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/me/prefs") {
      if (method !== "GET" && method !== "PUT") throw new HttpError(405, "method");
      if ([...query.keys()].length) throw new HubProtocolError("invalid");
      if (method === "PUT") csrf(); else signedIn();
      const input = method === "PUT" ? parsePersonPrefs(await body()) : null;
      const person = await guard(() => ctx.requirePerson());
      return send(res, 200, core.atomic(db => {
        const current = signedIn();
        if (personKeyString(current.person) !== personKeyString(person)) throw new SignedOut();
        return input ? writePersonPrefs(db, personKeyString(person), input) : readPersonPrefs(db, personKeyString(person));
      }));
    }
    if (deps.memberAddressNotices) {
      const notices = deps.memberAddressNotices;
      if (path === "/hub/v1/security-notices/member-address") {
        if (method !== "GET") throw new HttpError(405, "method");
        signedIn();
        if ([...query.keys()].some(k => k !== "before") || query.getAll("before").length > 1
          || query.has("before") && !/^[1-9][0-9]{0,15}$/.test(query.get("before")!)) throw new HubProtocolError("invalid");
        const page = await guard(() => notices.forSession(ctx, query.has("before") ? Number(query.get("before")) : undefined));
        if (!live()) throw new HubProtocolError("unavailable");
        signedIn(); return send(res, 200, page);
      }
      if ((r = m(/^\/hub\/v1\/security-notices\/member-address\/([^/]+)\/ack$/))) {
        if (method !== "POST") throw new HttpError(405, "method");
        if ([...query.keys()].length) throw new HubProtocolError("invalid");
        csrf(); await guard(() => notices.acknowledgeSession(ctx, uuid(r![1])));
        if (!live()) throw new HubProtocolError("unavailable");
        signedIn(); return send(res, 200, { ok: true });
      }
    }
    if (deps.directoryNotices) {
      const notices = deps.directoryNotices;
      if (path === "/hub/v1/security-notices/directory") {
        if (method !== "GET") throw new HttpError(405, "method");
        signedIn();
        for (const key of query.keys()) if (!["before", "limit", "unread"].includes(key) || query.getAll(key).length !== 1) throw new HubProtocolError("invalid");
        if (query.has("unread") && !["0", "1"].includes(query.get("unread")!)) throw new HubProtocolError("invalid");
        const page = await guard(() => notices.forSession(ctx, {
          ...(query.has("before") ? { before: uuid(query.get("before")) } : {}),
          ...(query.has("limit") ? { limit: int(query.get("limit")) } : {}),
          ...(query.has("unread") ? { unread: query.get("unread") === "1" } : {}),
        }));
        if (!live()) throw new HubProtocolError("unavailable");
        signedIn(); return send(res, 200, page);
      }
      if ((r = m(/^\/hub\/v1\/security-notices\/directory\/([^/]+)\/ack$/))) {
        if (method !== "POST") throw new HttpError(405, "method");
        csrf(); await guard(() => notices.acknowledgeSession(ctx, uuid(r![1])));
        if (!live()) throw new HubProtocolError("unavailable");
        signedIn(); return send(res, 200, { ok: true });
      }
    }
    if (deps.pairingNotices && deps.groupHttp) {
      const notices = deps.pairingNotices;
      if (path === "/hub/v1/quick-pairing") {
        if (method === "POST") {
          csrf(); const b = await body();
          const offer = await guard(() => deps.pairing.createQuick(ctx, b));
          return send(res, 200, { ...offer, memberOrigin: deps.config.memberOrigin });
        }
        if (method !== "GET") throw new HttpError(405, "method");
        signedIn(); const who = personKeyString(await guard(() => ctx.requirePerson())), wanted = query.get("id");
        const state = deps.store.read();
        const attempt = [...state.pairings].reverse().find(p => p.automatic && personKeyString(p.owner) === who && p.expiresAt > core.now()
          && (!wanted || p.id === wanted) && ["offered", "pending", "claimed"].includes(p.state)
          && (p.state !== "claimed" || state.fleets.some(f => f.id === p.fleetId && f.status === "active" && f.credentialHash)));
        if (wanted && !attempt) throw new HubProtocolError("expired");
        return send(res, 200, { attempt: attempt ? { id: attempt.id, state: attempt.state, fingerprint: attempt.fingerprint,
          expiresAt: attempt.expiresAt, ownerConfirmed: attempt.ownerConfirmed,
          connected: attempt.state === "claimed" && !!attempt.fleetId && rooms.features(attempt.fleetId) !== null,
          fleetId: attempt.fleetId } : null, memberOrigin: deps.config.memberOrigin });
      }
      if ((r = m(/^\/hub\/v1\/quick-pairing\/([^/]+)\/stop$/))) {
        if (method !== "POST") throw new HttpError(405, "method");
        csrf(); await guard(() => deps.pairing.stopQuick(ctx, uuid(r![1]))); return send(res, 200, { ok: true });
      }
      if ((r = m(/^\/hub\/v1\/fleets\/([^/]+)\/revoke$/))) {
        if (method !== "POST") throw new HttpError(405, "method");
        csrf(); const b = await body(); await guard(() => deps.pairing.revokeOwned(ctx, uuid(r![1]), int(b.generation))); agentCatalogs.prune();
        notices.committed(); return send(res, 200, { ok: true });
      }
      if (path === "/hub/v1/notices") {
        if (method !== "GET") throw new HttpError(405, "method");
        signedIn(); return send(res, 200, { notices: await guard(() => notices.forSession(ctx, query.get("v") === "3" ? 3 : query.get("v") === "2" ? 2 : 1)) });
      }
      if ((r = m(/^\/hub\/v1\/notices\/([^/]+)\/ack$/))) {
        if (method !== "POST") throw new HttpError(405, "method");
        csrf(); await guard(() => notices.acknowledgeSession(ctx, uuid(r![1]))); return send(res, 200, { ok: true });
      }
      if (path === "/hub/v1/notices/events") {
        if (method !== "GET") throw new HttpError(405, "method");
        signedIn(); if (streams.size >= 64) throw new HubProtocolError("backpressure");
        const initial = await guard(() => notices.forSession(ctx, query.get("v") === "3" ? 3 : query.get("v") === "2" ? 2 : 1));
        if (streams.size >= 64 || !live() || ctx.isCurrent?.() !== true) throw new HubProtocolError("backpressure");
        res.writeHead(200, { ...API_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        let ended = false, running = false, dirty = false;
        const close = () => { if (ended) return; ended = true; off(); clearInterval(heartbeat); streams.delete(close); res.end(); };
        const push = async () => {
          if (ended) return;
          if (running) { dirty = true; return; }
          running = true;
          try {
            do {
              dirty = false; const rows = await notices.forSession(ctx, query.get("v") === "3" ? 3 : query.get("v") === "2" ? 2 : 1);
              if (ended || !ctx.isCurrent?.()) return close();
              res.write(`event: notices\ndata: ${JSON.stringify({ notices: rows })}\n\n`);
            } while (dirty);
          } catch { close(); } finally { running = false; }
        };
        const off = notices.subscribe(() => void push());
        const heartbeat = setInterval(() => { if (!live() || !ctx.isCurrent?.()) close(); else res.write(": heartbeat\n\n"); }, 15_000); heartbeat.unref();
        streams.add(close); res.on("close", close);
        res.write(`event: notices\ndata: ${JSON.stringify({ notices: initial })}\n\n`);
        return;
      }
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/grant-subjects\/search$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const input = await body(), response = await guard(() => grantSearch.search(ctx, uuid(r![1]), input));
      const limited = (response as { reason?: string })?.reason === "limited";
      return send(res, limited ? 429 : 200, response, limited ? { "Retry-After": "60" } : {});
    }
    if(path === "/hub/v1/me/intro-notice"){
      if(method === "GET"){signedIn();return send(res,200,await guard(()=>introTool.notice(ctx)));}
      if(method === "DELETE"){csrf();return send(res,200,await guard(()=>introTool.acknowledge(ctx)));}
      throw new HttpError(405,"method");
    }
    if (path === "/hub/v1/exposures" || path === "/hub/v1/grants") {
      if (method === "GET") {
        signedIn(); const view = await guard(() => catalog.visible(ctx));
        return send(res, 200, { ...view, askable: view.askable.map(row => ({...row,exposure:{...row.exposure,...intros.projection(row.exposure.id)}})), mine: view.mine.map(e => ({ ...e, ...ownerIntro(e), quotaVisible: quota.visible(e.id), ...quota.projection(e.id) })) });
      }
      if (path === "/hub/v1/grants" && method === "POST") {
        csrf(); const b = await body();
        const g = await guard(() => catalog.grant(ctx, { exposureId: uuid(b.exposureId), exposureRevision: int(b.exposureRevision),
          ...(b.login !== undefined ? { login: str(b.login) } : {}), ...(b.subject !== undefined ? { subject: b.subject } : {}), days: int(b.days) }));
        return send(res, 200, { grant: g });
      }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/grants\/([^/]+)$/))) {
      if (method !== "DELETE") throw new HttpError(405, "method");
      csrf(); await guard(() => catalog.revokeGrant(ctx, uuid(r![1]), int(query.get("revision")))); return send(res, 200, { ok: true });
    }
    // #3226 C: who asked the owner's agent and when (no content), for its owner only.
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/activity$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, { activity: await guard(() => rooms.activity(ctx, uuid(r![1]))) });
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/rooms$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, { rooms: await guard(() => groupRooms.roomsForExposure(ctx, uuid(r![1]))) });
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/sharing$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => sharing.change(ctx, uuid(r![1]), b)); groupRooms.agents.publicationChanged(undefined, uuid(r![1]));
      return send(res, 200, { ok: true });
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/freeze$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => catalog.freeze(ctx, uuid(r![1]), int(b.revision), false)); return send(res, 200, { ok: true });
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/room-discovery$/))) {
      if (!roomDiscovery) throw new HttpError(404, "not-found");
      if (query.size) throw new HubProtocolError("invalid");
      if (method === "GET") { signedIn(); return send(res, 200, await guard(() => roomDiscovery.setting(ctx, uuid(r![1])))); }
      if (method !== "PUT") throw new HttpError(405, "method");
      csrf(); const input = await body(); return send(res, 200, await guard(() => roomDiscovery.setting(ctx, uuid(r![1]), input)));
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/intro$/))) {
      if (method !== "PUT") throw new HttpError(405,"method");
      csrf(); const b=await body();
      if(Object.keys(b).some(k=>!["revision","text"].includes(k)))throw new HubProtocolError("invalid");
      return send(res,200,await guard(()=>intros.save(ctx,uuid(r![1]),int(b.revision),b.text)));
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/quota$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body();
      if (typeof b.visible !== "boolean" || Object.keys(b).some(k => !["revision", "visible"].includes(k))) throw new HubProtocolError("invalid");
      const exposureId = uuid(r[1]);
      await guard(() => quota.setVisible(ctx, exposureId, int(b.revision), b.visible as boolean));
      return send(res, 200, { quotaVisible: b.visible, ...quota.projection(exposureId) });
    }
    if (path === "/hub/v1/roles" || path.startsWith("/hub/v1/roles/")) {
      const roles = deps.roleAdmin;
      if (!roles) throw new HttpError(404,"not-found");
      const answer = (out: unknown) => {
        const result = out as {ok?:boolean;code?:string};
        const status = result?.ok !== false ? 200 : result.code === "denied" || result.code === "self-target" ? 403
          : result.code === "invalid" ? 400 : ["conflict","stale-preview","expired"].includes(result.code ?? "") ? 409 : 503;
        return send(res,status,out);
      };
      if (method === "GET") {
        signedIn();
        if (path === "/hub/v1/roles") { if (query.size) throw new HubProtocolError("invalid"); return answer({view:await guard(() => roles.read(ctx))}); }
        if (path === "/hub/v1/roles/search") {
          if ([...query.keys()].some(k => !["kind","q"].includes(k)) || query.getAll("kind").length !== 1 || query.getAll("q").length !== 1) throw new HubProtocolError("invalid");
          return answer({candidates:await guard(() => roles.search(ctx,{kind:query.get("kind"),q:query.get("q")}))});
        }
        if (path === "/hub/v1/roles/audit") {
          const fields=["cursor","from","to","person","action"];
          if ([...query.keys()].some(k => !fields.includes(k)) || fields.some(k=>query.getAll(k).length>1) || ["from","to"].some(k=>query.has(k)&&!/^\d{1,16}$/.test(query.get(k)!))) throw new HubProtocolError("invalid");
          return answer(await guard(() => roles.audit(ctx,Object.fromEntries([...query].map(([key,value])=>[key,key==="from"||key==="to"?Number(value):value])))));
        }
        if (path === "/hub/v1/roles/notices") { if(query.size)throw new HubProtocolError("invalid");return answer(await guard(() => roles.notices(ctx))); }
      } else if (method === "POST") {
        csrf(); if (query.size) throw new HubProtocolError("invalid"); const b = await body();
        if (path === "/hub/v1/roles/preview") { if(Object.keys(b).length !== 1 || !Object.hasOwn(b,"policy"))throw new HubProtocolError("invalid");return answer(await guard(() => roles.preview(ctx,b.policy))); }
        if (path === "/hub/v1/roles/apply") return answer(await guard(() => roles.apply(ctx,b)));
        if (path === "/hub/v1/roles/root-self/preview") { if(Object.keys(b).length)throw new HubProtocolError("invalid");return answer(await guard(() => roles.previewRootSelf(ctx))); }
        if (path === "/hub/v1/roles/root-self/apply") return answer(await guard(() => roles.applyRootSelf(ctx,b)));
        const notice = /^\/hub\/v1\/roles\/notices\/([^/]+)\/ack$/.exec(path);
        if (notice) { if(Object.keys(b).length)throw new HubProtocolError("invalid");return answer(await guard(() => roles.acknowledge(ctx,uuid(notice[1])))); }
      }
      throw new HttpError(method === "GET" || method === "POST" ? 404 : 405,method === "GET" || method === "POST" ? "not-found" : "method");
    }
    if (path === "/hub/v1/teams/settings") {
      if (!teams) throw new HttpError(404,"not-found");
      if (method === "GET") { signedIn(); return send(res,200,{settings:await guard(() => teams.settings(ctx))}); }
      if (method === "PUT") { csrf(); const b = await body(); return send(res,200,{settings:await guard(() => teams.saveSettings(ctx,b))}); }
      throw new HttpError(405,"method");
    }
    if (path === "/hub/v1/teams/candidates") {
      if (!teams) throw new HttpError(404, "not-found");
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn();
      return send(res, 200, { candidates: await guard(() => teams.suggestions(ctx, {
        kind: query.get("kind"), q: query.get("q"), ...(query.has("teamId") ? { teamId: query.get("teamId") } : {}),
      })) });
    }
    if (path === "/hub/v1/teams") {
      if (!teams) throw new HttpError(404, "not-found");
      if (method === "GET") { signedIn(); return send(res, 200, { teams: await guard(() => teams.list(ctx)) }); }
      if (method === "POST") { csrf(); const b = await body(); return send(res, 201, { team: await guard(() => teams.create(ctx, b)) }); }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/teams\/([^/]+)$/))) {
      if (!teams) throw new HttpError(404, "not-found");
      const id = uuid(r[1]);
      if (method === "GET") { signedIn(); return send(res, 200, { team: await guard(() => teams.get(ctx, id)) }); }
      if (method === "PATCH") { csrf(); const b = await body(); return send(res, 200, { team: await guard(() => teams.update(ctx, id, b)) }); }
      if (method === "DELETE") { csrf(); await guard(() => teams.remove(ctx, id)); return send(res, 200, { ok: true }); }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/admin/assistant" || path === "/hub/v1/admin/assistant/usage" || /^\/hub\/v1\/admin\/assistant\/rooms\/[^/]+\/stop$/.test(path)) {
      const port = deps.roomAssistant && deps.assistantAdmin;
      if (!port) throw new HttpError(404, "not-found");
      if (mutation) csrf(); else signedIn();
      const permit = await guard(() => core.management(ctx, "hub.admin"));
      const call = async (work: () => Promise<unknown>) => {
        permit.assertCurrent();
        let result: unknown;
        try { result = await work(); } catch { permit.assertCurrent(); throw new HttpError(503, "unavailable"); }
        permit.assertCurrent(); return result;
      };
      if (path === "/hub/v1/admin/assistant") {
        if (method === "GET") return send(res, 200, await guard(() => call(() => port.settings())));
        if (method === "PUT") { const b = await body(); return send(res, 200, await guard(() => call(() => port.configure(b)))); }
      } else if (path.endsWith("/usage") && method === "GET") return send(res, 200, await guard(() => call(() => port.usage())));
      else if (method === "POST") {
        const id = uuid(path.split("/")[6]);
        await guard(() => call(() => { groupRooms.assistant.cancel(id); return port.stopRoom(id); })); return send(res, 200, { ok: true });
      }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/admin/rooms/creators") {
      if (method === "GET") { signedIn(); return send(res, 200, await guard(() => roomAdmin.creators(ctx))); }
      if (method === "PUT") { csrf(); const b = await body(); return send(res, 200, await guard(() => roomAdmin.creators(ctx, b))); }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/admin/rooms") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, await guard(() => roomAdmin.list(ctx)));
    }
    if ((r = m(/^\/hub\/v1\/admin\/rooms\/([^/]+)(?:\/(join))?$/))) {
      const roomId = uuid(r[1]); csrf();
      if (r[2] === "join" && method === "POST") return send(res, 200, await guard(() => roomAdmin.join(ctx, roomId)));
      if (!r[2] && method === "PATCH") { const b = await body(); return send(res, 200, await guard(() => roomAdmin.archive(ctx, roomId, b))); }
      throw new HttpError(405, "method");
    }
    // M-3127 C: message search across the group rooms I am in (Ctrl K).
    if (path === "/hub/v1/rooms/search") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, await guard(() => groupRooms.search(ctx, query.get("q") ?? "", query.get("limit") ?? "20", query.get("cursor"))));
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/own-agent-candidates$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, { candidates: await guard(() => groupRooms.ownAgentCandidates(ctx, uuid(r![1]), query.get("q") ?? "")) });
    }
    if (path === "/hub/v1/rooms/candidates") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, { candidates: await guard(() => groupRooms.candidates(ctx, query.get("q") ?? "", query.get("kind") ?? "person", !!roomDiscovery && query.get("discovery") === "1")) });
    }
    if ((r = m(/^\/hub\/v1\/rooms\/candidates\/group\/([^/]+)$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, await guard(() => groupRooms.groupCandidate(ctx, uuid(r![1]))));
    }
    if (path === "/hub/v1/me/agent-request-settings") {
      if (!roomAgentRequests) throw new HttpError(404, "not-found");
      if (query.size) throw new HubProtocolError("invalid");
      if (method === "GET") { signedIn(); return send(res, 200, await guard(() => roomAgentRequests.settings(ctx))); }
      if (method === "PUT") { csrf(); const input = await body(); return send(res, 200, await guard(() => roomAgentRequests.settings(ctx, input))); }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/agent-requests") {
      if (!roomAgentRequests) throw new HttpError(404, "not-found");
      if (method !== "GET") throw new HttpError(405, "method");
      if ([...query.keys()].some(key => key !== "after")) throw new HubProtocolError("invalid");
      signedIn(); return send(res, 200, await guard(() => roomAgentRequests.pending(ctx, query.get("after") ?? undefined)));
    }
    if ((r = m(/^\/hub\/v1\/agent-requests\/([^/]+)(?:\/(accept|decline))?$/))) {
      if (!roomAgentRequests) throw new HttpError(404, "not-found");
      if (query.size) throw new HubProtocolError("invalid");
      const id = uuid(r[1]), action = r[2];
      if (method === "GET" && !action) { signedIn(); return send(res, 200, await guard(() => roomAgentRequests.choices(ctx, id, () => agentCatalogs.view(ctx)))); }
      if (method !== "POST" || !action) throw new HttpError(405, "method");
      csrf(); const input = await body();
      if (action === "decline" && Object.keys(input).length) throw new HubProtocolError("invalid");
      return send(res, 200, await guard(() => action === "accept" ? roomAgentRequests.accept(ctx, id, input) : roomAgentRequests.decline(ctx, id)));
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/agent-requests(?:\/([^/]+))?$/))) {
      if (!roomAgentRequests) throw new HttpError(404, "not-found");
      const roomId = uuid(r[1]);
      if (method === "GET" && !r[2]) {
        if ([...query.keys()].some(key => key !== "after")) throw new HubProtocolError("invalid");
        signedIn(); return send(res, 200, await guard(() => roomAgentRequests.forRoom(ctx, roomId, query.get("after") ?? undefined)));
      }
      if (query.size) throw new HubProtocolError("invalid");
      csrf();
      if (method === "POST" && !r[2]) { const input = await body(); return send(res, 200, await guard(() => roomAgentRequests.request(ctx, roomId, input))); }
      if (method === "DELETE" && r[2]) return send(res, 200, await guard(() => roomAgentRequests.cancel(ctx, roomId, uuid(r![2]))));
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/invitations") {
      if (!invitations) throw new HttpError(404, "not-found");
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, await guard(() => invitations.pending(ctx)));
    }
    if ((r = m(/^\/hub\/v1\/invitations\/([^/]+)\/(accept|decline)$/))) {
      if (!invitations) throw new HttpError(404, "not-found");
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const id = uuid(r[1]); return send(res, 200, await guard(() => r![2] === "accept" ? invitations.accept(ctx, id) : invitations.decline(ctx, id)));
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/invitations(?:\/([^/]+))?$/))) {
      if (!invitations) throw new HttpError(404, "not-found");
      csrf(); const id = uuid(r[1]);
      if (method === "DELETE" && r[2]) return send(res, 200, await guard(() => invitations.cancel(ctx, id, uuid(r![2]))));
      if (method === "POST" && !r[2]) {
        const b = await body();
        if (Object.keys(b).length !== 1 || !(Array.isArray(b.agents) || typeof b.team === "string")) throw new HubProtocolError("invalid");
        const input = Array.isArray(b.agents) ? { agents: b.agents.map(value => uuid(value)) } : { team: uuid(b.team) };
        if (input.agents && input.agents.length > 64) throw new HubProtocolError("invalid");
        return send(res, 200, await guard(() => invitations.invite(ctx, id, input)));
      }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/rooms/events") {
      if (method !== "GET") throw new HttpError(405, "method");
      const streamSession = signedIn(), streamPerson = personKeyString(await guard(() => ctx.requirePerson()));
      const requestedNotices = query.get("notices"), notices = deps.pairingNotices;
      const noticeVersion = requestedNotices === "3" && deps.companyJoin ? 3 : requestedNotices === "2" || requestedNotices === "3" ? 2 : null;
      const initialNotices = notices && noticeVersion ? await guard(() => notices.forSession(ctx, noticeVersion)) : null;
      if (streams.size >= 64 || !ctx.isCurrent?.()) throw new HubProtocolError("backpressure");
      res.writeHead(200, { ...API_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      let ended = false, queued = 0, tail = Promise.resolve(), noticesRunning = false, noticesDirty = false;
      let offNotices = () => {};
      const close = () => { if (ended) return; ended = true; off(); offNotices(); clearInterval(heartbeat); streams.delete(close); res.end(); };
      const off = groupRooms.subscribe(event => {
        if (ended) return;
        if (event.audiencePerson && event.audiencePerson !== streamPerson) return;
        if (!event.audiencePerson && !groupRooms.interested(streamPerson, event)) return;
        if (++queued > 64) { close(); return; }
        tail = tail.then(async () => {
          if (ended) return;
          let data: Record<string, unknown> | null;
          // Concurrent agent checks can briefly fill the person's physical read slots. Keep this event in the bounded
          // queue and re-read it after a short delay; persistent overload and all other failures still close the stream.
          for (let attempt = 0; ; attempt++) {
            try {
              if (event.audiencePerson) {
                if (event.type === "invitation.changed") {
                  data = personKeyString(await ctx.requirePerson()) === event.audiencePerson ? {} : null;
                } else if (event.type === "pins.changed") {
                  // M-3340: the person's own pins changed (another tab or device): which room only; the page reads them again.
                  data = personKeyString(await ctx.requirePerson()) === event.audiencePerson ? { roomId: event.roomId } : null;
                } else {
                  const view = await rooms.view(ctx, event.roomId);
                  if (event.type === "unread.changed") data = { roomId: event.roomId, unread: directUnread(core, view) };
                  else if (event.type === "room.changed") data = { roomId: event.roomId, room: directRoomView(view, directPresence(view.exposureId), directUnread(core, view), intros.projection(view.exposureId), groupRooms.agents.reported(view.exposureId)) };
                  else {
                    const page = await rooms.readPage(ctx, event.roomId, 0, streamSession.sessionId, { before: null, limit: 100 });
                    const message = directMessages(page.room, page.entries, streamSession.displayName).find(m => m.id === event.data.messageId);
                    data = message ? { roomId: event.roomId, message } : null;
                  }
                }
              } else data = await groupRooms.event(ctx, event);
              break;
            } catch (error) {
              if (!(error instanceof HubProtocolError) || error.code !== "backpressure" || attempt >= 3) throw error;
              await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
              if (ended || !live() || !ctx.isCurrent?.()) return close();
            }
          }
          if (ended || !live() || !ctx.isCurrent?.()) return close();
          if (data && !res.write(`event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`)) close();
        }).catch(close).finally(() => { queued--; });
      });
      const pushNotices = async () => {
        if (ended || !notices || !noticeVersion) return;
        if (noticesRunning) { noticesDirty = true; return; }
        noticesRunning = true;
        try {
          do {
            noticesDirty = false; const rows = await notices.forSession(ctx, noticeVersion);
            if (ended || !live() || !ctx.isCurrent?.()) return close();
            if (!res.write(`event: notices\ndata: ${JSON.stringify({ notices: rows })}\n\n`)) return close();
          } while (noticesDirty);
        } catch { close(); } finally { noticesRunning = false; }
      };
      const heartbeat = setInterval(() => { if (!live() || !ctx.isCurrent?.()) close(); else if (!res.write(": heartbeat\n\n")) close(); }, 15_000); heartbeat.unref();
      try { if (notices && noticeVersion) offNotices = notices.subscribe(() => void pushNotices()); }
      catch { close(); return; }
      streams.add(close); res.on("close", close);
      if (initialNotices) res.write(`event: notices\ndata: ${JSON.stringify({ notices: initialNotices })}\n\n`);
      res.write(": connected\n\n"); return;
    }
    if (path === "/hub/v1/rooms") {
      if (method === "GET") { signedIn(); const view = await guard(() => rooms.listAuthorized(ctx));
        // Cached clients draw every row as a direct agent conversation. New roomList() opts into group rows.
        if (query.get("v") !== "2") return send(res, 200, { rooms: view.rooms.map(room => ({ ...room, ...intros.projection(room.exposureId), ...quota.roomProjection(room, view.grantProof) })) });
        const groups = await guard(() => groupRooms.list(ctx));
        const pending = invitations ? await guard(() => invitations.pending(ctx)) : null;
        const ownerRequests = roomAgentRequests && query.get("ownerRequests") === "1" ? await guard(() => roomAgentRequests.pendingCount(ctx)) : 0;
        return send(res, 200, { ...groups, invitations: (pending?.invitations.length ?? 0) + ownerRequests, rooms: [...groups.rooms, ...view.rooms.map(room => ({ ...directRoomView(room, directPresence(room.exposureId), directUnread(core, room), intros.projection(room.exposureId), groupRooms.agents.reported(room.exposureId)), ...quota.roomProjection(room, view.grantProof) }))] }); }
      if (method === "POST") {
        csrf(); const b = await body();
        if (b.exposureId === undefined) return send(res, 200, await guard(() => groupRooms.create(ctx, b)));
        const room = await guard(() => rooms.open(ctx, uuid(b.exposureId), uuid(b.grantId)));
        return send(res, 200, { room: { id: room.id, exposureId: room.exposureId, grantId: room.grantId, state: room.state, exposureName: room.exposure.displayName, features: rooms.features(room.exposure.fleetId), ...intros.projection(room.exposureId), ...quota.roomProjection(room, room.grantProof) } });
      }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)$/))) {
      signedIn(); const roomId = uuid(r[1]);
      if (groupRooms.has(roomId)) {
        if (method === "GET") {
          const view = await guard(() => groupRooms.detail(ctx, roomId));
          const invited = invitations && view.me.role === "manager" && !view.room.archived ? await guard(() => invitations.forRoom(ctx, roomId)) : [];
          const ownerRequests = roomAgentRequests && view.me.role === "manager" && !view.room.archived
            ? await guard(() => roomAgentRequests.forRoom(ctx, roomId)) : null;
          return send(res, 200, { ...view, invited, ...(ownerRequests ? {
            settings: { ...view.settings, ownerAgentRequests: true }, agentRequests: ownerRequests,
          } : {}) });
        }
        if (method === "PATCH") { csrf(); const b = await body(); return send(res, 200, await guard(() => groupRooms.patch(ctx, roomId, b))); }
      } else if(method==="PATCH") {
        csrf();const b=await body();if(Object.keys(b).length!==1||typeof b.directMessagesMuted!=="boolean")throw new HubProtocolError("invalid");
        const room=await guard(()=>rooms.view(ctx,roomId));await ctx.current();directPosts.setMuted(roomId,personKeyString(room.asker),b.directMessagesMuted);return send(res,200,{ok:true});
      } else if (method === "GET") {
        const room = await guard(() => rooms.view(ctx, roomId)); const person = personKeyString(room.asker), name = signedIn().displayName;
        return send(res, 200, { room: directRoomView(room, directPresence(room.exposureId), directUnread(core, room), intros.projection(room.exposureId), groupRooms.agents.reported(room.exposureId)), me: { id: person, role: "member" },
          members: [{ id: person, kind: "person", name, role: "member", presence: "online" }, { id: room.exposureId, kind: "agent", name: room.exposureName,
            ...(room.answerOnly?{answerOnly:true}:{}), owner: { name: room.ownerName }, role: "member", presence: directPresence(room.exposureId), canAsk: room.state === "active" }],
          settings: { allMention: false, historyForNew: "all" }, invited: [] });
      }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/members(?:\/([^/]+))?$/))) {
      csrf(); const roomId = uuid(r[1]), memberId = r[2] ? uuid(r[2]) : null;
      if (method === "POST" && !memberId) { const b = await body(); return send(res, 200, await guard(() => groupRooms.add(ctx, roomId, b))); }
      if (method === "DELETE" && memberId) return send(res, 200, await guard(() => groupRooms.changeMember(ctx, roomId, memberId)));
      if (method === "PATCH" && memberId) { const b = await body(); if (Object.keys(b).length !== 1 || !["manager", "member"].includes(String(b.role))) throw new HubProtocolError("invalid");
        return send(res, 200, await guard(() => groupRooms.changeMember(ctx, roomId, memberId, b.role as "manager" | "member"))); }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/read$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(), roomId = uuid(r[1]);
      if (groupRooms.has(roomId)) return send(res, 200, await guard(() => groupRooms.markRead(ctx, roomId, b.upTo)));
      const room = await guard(() => rooms.view(ctx, roomId)); markDirectRead(core, roomId, str(b.upTo));
      groupRooms.publish({ type: "unread.changed", roomId, data: { roomId }, audiencePerson: personKeyString(room.asker) }); return send(res, 200, { ok: true });
    }
    // M-3533 R1: a group room's office, for its members (room-office-v1; 404 while the Hub does not offer it).
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/office\/state$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      if ([...query.keys()].length) throw new HubProtocolError("invalid");
      signedIn(); const roomId = uuid(r[1]);
      if (!groupRooms.has(roomId)) throw new HttpError(404, "not-found");
      return send(res, 200, await guard(() => groupRooms.officeState(ctx, roomId)));
    }
    // M-3340: personal pins in a group room — the signed-in person's own (GET), pin (PUT) or unpin (DELETE) one message.
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/pins$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      if ([...query.keys()].length) throw new HubProtocolError("invalid");
      signedIn(); const roomId = uuid(r[1]);
      if (!groupRooms.has(roomId)) throw new HttpError(404, "not-found");
      return send(res, 200, await guard(() => groupRooms.pins(ctx, roomId)));
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/pins\/([^/]+)$/))) {
      if (method !== "PUT" && method !== "DELETE") throw new HttpError(405, "method");
      csrf(); const roomId = uuid(r[1]);
      if (!groupRooms.has(roomId)) throw new HttpError(404, "not-found");
      return send(res, 200, await guard(() => groupRooms.pin(ctx, roomId, r![2], method === "PUT")));
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/messages\/([^/]+)\/reactions$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const roomId = uuid(r[1]);
      if (!groupRooms.has(roomId)) throw new HttpError(404, "not-found");
      const b = await body(); return send(res, 200, await guard(() => groupRooms.react(ctx, roomId, r![2], b)));
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/buttons$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(), roomId = uuid(r[1]);
      // M-3127: a group room's answer buttons and polls (the same body as a direct chat's).
      if (groupRooms.has(roomId)) return send(res, 200, await guard(() => groupRooms.click(ctx, roomId, b)));
      return send(res, 200, { receipt: await guard(() => rooms.buttons.click(ctx, roomId, b)) });
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/messages$/))) {
      const roomId = uuid(r[1]);
      if (groupRooms.has(roomId)) {
        if (method === "GET") { signedIn(); return send(res, 200, await guard(() => groupRooms.messages(ctx, roomId, query.get("before"), int(query.get("limit") ?? "50")))); }
        if (method === "POST") { csrf(); const b = await body(); return send(res, 200, await guard(() => groupRooms.post(ctx, roomId, b))); }
        throw new HttpError(405, "method");
      }
      if (method === "GET") {
        const s = signedIn();
        // #3226 B + G: the room comes with its entries, fresh each poll — its view (state, grant's end, what its link
        // negotiated) and its quota projection (G; absent when hidden or not shared).
        const { entries, room: view, grantProof, more } = await guard(() => rooms.readPage(ctx, roomId, int(query.get("after") ?? "0"), s.sessionId,
          query.has("after") ? undefined : { before: query.get("before"), limit: int(query.get("limit") ?? "50") }));
        let messages = directMessages(view, entries, s.displayName);
        const cursor = query.get("before"), index = cursor ? messages.findIndex(m => m.id === cursor) : -1;
        if (index >= 0) messages = messages.slice(0, index);
        const limit = int(query.get("limit") ?? "50"), overflow = !query.has("after") && messages.length > limit;
        if (overflow) messages = messages.slice(-limit);
        return send(res, 200, { entries, room: { ...view, ...intros.projection(view.exposureId), ...quota.roomProjection(view, grantProof) }, messages, more: (more ?? false) || overflow });
      }
      if (method === "POST") {
        csrf(); const b = await body();
        const files = b.files === undefined ? [] : Array.isArray(b.files) && b.files.length <= 10 ? b.files.map(uuid) : (() => { throw new HubProtocolError("invalid"); })();
        if (b.mentions !== undefined && (!Array.isArray(b.mentions) || b.mentions.length > 64)) throw new HubProtocolError("invalid");
        if (b.mentions?.length) {
          // M-3604: the shared room composer names the room's own agent when the text @-mentions it ("@Desk …"). In a 1:1
          // that agent is the only one, so the mention changes nothing: the question goes as written. Anything else stays refused.
          const own = (await guard(() => rooms.view(ctx, roomId))).exposureId;
          if (!b.mentions.every((x: unknown) => x === own || x === "all")) throw new HubProtocolError("invalid");
        }
        const receipt = await guard(() => rooms.ask(ctx, roomId, uuid(b.idempotencyKey), typeof b.text === "string" ? b.text : "", files));
        const room = await guard(() => rooms.view(ctx, roomId));
        groupRooms.publish({ type: "message.added", roomId, data: { roomId, messageId: receipt.messageId }, audiencePerson: personKeyString(room.asker) });
        return send(res, 200, { id: receipt.messageId, roomId, at: receipt.at, author: { kind: "person", id: personKeyString(room.asker), name: signedIn().displayName },
          text: typeof b.text === "string" ? b.text : "", mentions: [], idempotencyKey: b.idempotencyKey, receipt });
      }
      throw new HttpError(405, "method");
    }
    // attachments-v1: the asker's upload (raw body, streamed under the file limit) and the room's files.
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/files$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      // Nothing of the body is read until the request is admitted: a closed connection, never a buffer, for a refusal.
      res.once("finish", () => { if (!req.readableEnded) req.destroy(); });
      const roomId = uuid(r[1]); const s = csrf();
      const store = deps.attachments; if (!store) throw new HubProtocolError("incompatible");
      const name = fileName(req.headers["x-file-name"]);
      const declared = req.headers["content-length"];
      if (declared === undefined || !/^\d{1,10}$/.test(declared)) throw new HttpError(411, "length-required");
      if (Number(declared) > store.limits.fileBytes) throw new HttpError(413, "too-large");
      // At most UPLOADS_PER_SESSION bodies per session and UPLOADS_TOTAL in all are read at once.
      if ((uploading.get(s.sessionId) ?? 0) >= UPLOADS_PER_SESSION || uploadingTotal >= UPLOADS_TOTAL) throw new HubProtocolError("backpressure");
      uploading.set(s.sessionId, (uploading.get(s.sessionId) ?? 0) + 1); uploadingTotal++;
      try {
        // M-3125: a group room's member uploads the same way (HubGroupRooms has the same three methods).
        const owner = groupRooms.has(roomId) ? groupRooms : rooms;
        await guard(() => owner.uploadAdmit(ctx, roomId, Number(declared)));
        const bytes = await readRaw(req, Number(declared)); if (!live()) throw new HubProtocolError("unavailable");
        if (bytes.length !== Number(declared)) throw new HubProtocolError("invalid");
        return send(res, 200, { file: await guard(() => owner.upload(ctx, roomId, name, bytes)) });
      } finally {
        const n = (uploading.get(s.sessionId) ?? 1) - 1; if (n > 0) uploading.set(s.sessionId, n); else uploading.delete(s.sessionId); uploadingTotal--;
      }
    }
    // `/inline` (a plain path, as the shared thread's renderer takes it) is the same as `?inline=1`: images only.
    // M-3533 R2b: a room agent's disc or portrait, for the room's members. `?v=` is the hash the room showed: kept while it matches.
    // M-3533 R2c: and one pose of its own character (its strip's PNG), the same way.
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/agents\/([^/]+)\/(?:picture\/(disc|portrait)|character\/([A-Za-z]{1,16}))$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      const roomId = uuid(r[1]), exposureId = uuid(r[2]); signedIn();
      const file = await guard(() => r![3] ? groupRooms.picture(ctx, roomId, exposureId, r![3] as "disc" | "portrait") : groupRooms.characterStrip(ctx, roomId, exposureId, r![4]!));
      res.writeHead(200, { "Content-Type": file.mime, "Content-Length": String(file.bytes.length), "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": query.get("v") === file.sha256 ? "private, max-age=86400" : "private, no-cache",
        ETag: `"${file.sha256}"`, "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" });
      res.end(file.bytes); return;
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/files\/([^/]+)(\/inline)?$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      const roomId = uuid(r[1]), fileId = uuid(r[2]); signedIn();
      const file = await guard(() => (groupRooms.has(roomId) ? groupRooms : rooms).download(ctx, roomId, fileId));
      // Never executed or sniffed: a download, in a sandbox; only a magic-checked image may show inline when asked.
      const inline = (query.get("inline") === "1" || r[3] === "/inline") && file.image;
      res.writeHead(200, { "Content-Type": file.mime, "Content-Length": String(file.bytes.length), "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}` });
      res.end(file.bytes); return;
    }
    if (path === "/hub/v1/audit") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn();
      const exposureId = query.get("exposureId"), after = query.get("after");
      return send(res, 200, { records: await guard(() => deps.audit.read(ctx, { ...(exposureId ? { exposureId: uuid(exposureId) } : {}), ...(after ? { after: int(after) } : {}) })) });
    }
    if (path === "/hub/v1/pairings") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn();
      const me = personKeyString(await guard(() => ctx.requirePerson())), now = core.now();
      const mine = deps.store.read().pairings.filter((p) => p.state === "pending" && p.expiresAt > now && personKeyString(p.owner) === me)
        .map((p) => ({ id: p.id, fingerprint: p.fingerprint, expiresAt: p.expiresAt, ownerConfirmed: p.ownerConfirmed, adminApproved: p.adminApproved }));
      return send(res, 200, { pairings: mine });
    }
    if ((r = m(/^\/hub\/v1\/pairings\/([^/]+)\/confirm$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); const fp = str(b.fingerprint, 64);
      if (!HEX64.test(fp)) throw new HubProtocolError("invalid");
      await guard(() => deps.pairing.confirmOwner(ctx, uuid(r![1]), fp)); return send(res, 200, { ok: true });
    }
    // #3298 S-89: the group routes (404 until S-88's control is composed), ahead of the other admin routes.
    if (await handleGroupHttp(deps.groupHttp, { path, method, signedIn, csrf, body, send: (status, value, headers) => send(res, status, value, headers),
      // The synchronous fence is this server's lifetime and the session row; who is asking is only ever the session's own require*.
      ctx: { requestId: ctx.requestId, current: () => live() && ctx.isCurrent?.() === true, requireAdmin: () => ctx.requireAdmin(), requirePerson: () => ctx.requirePerson(),roleContext:ctx } })) return;
    // M-2682: Administration → This Hub (what it is; its rename through the host's writer for sealed settings).
    if (await handleHubDirectorySettingsHttp(deps.directorySettings, { req, res, path, method, query, signedIn, csrf, body,
      send: (status, value) => send(res, status, value), sessions,
      ...(deps.directoryResponse ? { capture: (proof: () => boolean) => deps.directoryResponse!.capture(req, res, proof) } : {}),
      ctx: { token: ctx.token, requestId: ctx.requestId, current: () => live() && ctx.isCurrent?.() === true, requireAdmin: () => ctx.requireAdmin(),...(deps.roleAdmin&&deps.management?{configuredRoot:deps.config.administrator,authorizeAdmin:()=>deps.management!.require(ctx,"hub.admin")}: {}) } })) return;
    if (await handleHubSettingsHttp(deps.hubSettings ? { ...deps.hubSettings, name: deps.config.name } : undefined, { path, method, signedIn, csrf, body,
      send: (status, value) => send(res, status, value),
      ctx: { requestId: ctx.requestId, current: () => live() && ctx.isCurrent?.() === true, requireAdmin: () => ctx.requireAdmin() },
      audit: (event) => core.atomic((_db, tx) => core.audit(tx, { requestId: event.requestId, actor: { kind: "person", person: event.actor.person }, action: event.action,
        result: event.result, ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}) })) })) return;
    if (path === "/hub/v1/admin/dashboard") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); const permit = await guard(() => core.management(ctx, "hub.admin"));
      return send(res, 200, dashboard.view(query, permit));
    }
    if (path.startsWith("/hub/v1/admin/")) return admin(req, res, path, ctx, method, signedIn, csrf, body, guard);
    throw new HttpError(404, "not-found");
  }

  async function admin(req: IncomingMessage, res: ServerResponse, path: string, ctx: ReturnType<HubSessions["context"]>, method: string,
    signedIn: () => unknown, csrf: () => unknown, body: () => Promise<Record<string, unknown>>, guard: <T>(w: () => Promise<T>) => Promise<T>): Promise<void> {
    let r: RegExpExecArray | null;
    // M-3592: how long a sign-in lasts (absolute and idle), the administrator's.
    if (path === "/hub/v1/admin/session-limits") {
      if ((req.url ?? "").includes("?")) throw new HubProtocolError("invalid");
      if (method !== "GET" && method !== "PUT") throw new HttpError(405, "method");
      try {
        if (method === "GET") { signedIn(); return send(res, 200, await guard(() => sessionLimits.settings(ctx))); }
        csrf(); const input = await body(); return send(res, 200, await guard(() => sessionLimits.save(ctx, input)));
      } catch (error) {
        if (!(error instanceof HubSessionLimitRefusal)) throw error;
        return send(res, error.status, { code: error.code });
      }
    }
    if (path === "/hub/v1/admin/recommended-version" || path === "/hub/v1/admin/recommended-version/preview") {
      try {
        if (path.endsWith("/preview")) {
          if (method !== "POST") throw new HttpError(405, "method");
          csrf(); return send(res, 200, await recommendations.preview(ctx, await body()));
        }
        if (method === "GET") { signedIn(); const permit = await core.management(ctx, "hub.admin"); permit.assertCurrent(); return send(res, 200, recommendations.settings()); }
        if (method !== "PUT") throw new HttpError(405, "method");
        csrf(); return send(res, 200, await recommendations.save(ctx, await body()));
      } catch (error) {
        if (!(error instanceof HubRecommendationRefusal)) throw error;
        return send(res, error.status, { code: error.code, ...(error.version ? { version: error.version } : {}) });
      }
    }
    if (path === "/hub/v1/admin/fleet-updates" || /^\/hub\/v1\/admin\/fleet-updates\/[^/]+\/cancel$/.test(path)) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf();
      try {
        const b = await body();
        if (path.endsWith("/cancel") && Object.keys(b).length) throw new HubProtocolError("invalid");
        return send(res, 200, path.endsWith("/cancel") ? await fleetUpdates.cancel(ctx, path.split("/")[5]!) : await fleetUpdates.request(ctx, b));
      } catch (error) { if (!(error instanceof HubFleetUpdateRefusal)) throw error; return send(res, error.status, { code: error.code }); }
    }
    if (path === "/hub/v1/admin/overview") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn();
      const scoped=deps.roleAdmin&&deps.management?await guard(()=>hubAdminOverviewPermit(ctx,deps.management!)):null;
      if(!scoped)await guard(()=>ctx.requireAdmin());
      const canFleets=scoped?.fleets??true,canJoin=scoped?.joining??true;
      const state = deps.store.read(), now = core.now(), recommendation = canFleets?recommendations.settings():null;
      if(canFleets)fleetUpdates.reconcile();
      const name = (key: { realm: string; objectId: string }) => {
        const id = personKeyString(key);
        const row = core.atomic((db) => db.prepare("SELECT display_name, login_label FROM hub_people WHERE person=?").get(id) as { display_name: string; login_label: string } | undefined);
        return row ? { name: row.display_name, login: row.login_label } : null;
      };
      scoped?.assertCurrent();
      const overview={
        permissions:[...(canFleets?["fleets.manage"]:[]),...(canJoin?["join.manage"]:[])],
        ...(recommendation?{recommendedVersion:recommendation.recommendedVersion,recommendationRevision:recommendation.revision}:{}),
        fleets: !canFleets?[]:state.fleets.map((f) => ({ id: f.id, status: f.status, generation: f.generation, owner: name(f.owner), label: f.label ?? null, ...fleetVersions.view(f.id, recommendation!.recommendedVersion), recommendationNotifiedAt: recommendations.notifiedAt(f.id, recommendation!), updatesAllowed: fleetUpdates.allowed(f.id), updateRequest: fleetUpdates.view(f.id),
          ...(deps.companyJoin?.fleetDisplay(f.id) ?? { source: null, createdAt: null }) })),
        pairings: !canJoin?[]:state.pairings.filter((p) => p.expiresAt > now && (p.state === "offered" || p.state === "pending"))
          .map((p) => ({ id: p.id, state: p.state, expiresAt: p.expiresAt, fingerprint: p.fingerprint, ownerConfirmed: p.ownerConfirmed, adminApproved: p.adminApproved, owner: name(p.owner) })),
      };
      scoped?.assertCurrent();if(ctx.isCurrent?.()!==true)throw new HubProtocolError("unavailable");
      return send(res,200,overview);
    }
    if (path === "/hub/v1/admin/pairings") {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); const login = str(b.login).trim();
      const owner = await guard(() => pairingOwnerByLogin(core, ctx, login));
      if (!owner) throw new HubProtocolError("not-found");
      const offer = await guard(() => deps.pairing.create(ctx, owner));
      return send(res, 200, { ...offer, memberOrigin: deps.config.memberOrigin });
    }
    if ((r = /^\/hub\/v1\/admin\/pairings\/([^/]+)\/approve$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); const fp = str(b.fingerprint, 64);
      if (!HEX64.test(fp)) throw new HubProtocolError("invalid");
      await guard(() => deps.pairing.approve(ctx, uuid(r![1]), fp)); return send(res, 200, { ok: true });
    }
    if ((r = /^\/hub\/v1\/admin\/fleets\/([^/]+)\/revoke$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); await guard(() => deps.pairing.revoke(ctx, uuid(r![1]))); agentCatalogs.prune(); deps.pairingNotices?.committed(); return send(res, 200, { ok: true });
    }
    if ((r = /^\/hub\/v1\/admin\/exposures\/([^/]+)\/freeze$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => catalog.freeze(ctx, uuid(r![1]), int(b.revision), true)); return send(res, 200, { ok: true });
    }
    void req;
    throw new HttpError(404, "not-found");
  }

  function fail(res: ServerResponse, e: unknown, method: string, path: string): void {
    if (e instanceof HubRoomRefusal) return send(res, e.status, { code: e.code, ...e.details });
    if (e instanceof HubEnrolmentCodeLimit) return send(res, 429, { code: "backpressure", reason: e.reason });
    if (e instanceof CompanyJoinCodeRefusal) return send(res, 403, { code: "denied", reason: e.reason });
    if (e instanceof CompanyJoinOfferPending) return send(res, 409, { code: "offer-pending" });
    if (e instanceof CompanyJoinLimit) return send(res, 429, { code: "limit-reached" });
    if (e instanceof SignedOut) return send(res, 401, { code: "signed-out" });
    if (e instanceof HttpError) return send(res, e.status, { code: e.code });
    if (e instanceof HubSharingPaused) return send(res, 409, { code: "sharing-paused" });
    if (e instanceof HubMemberAddressError) return send(res, STATUS[e.code] ?? 503, { code: e.code });
    if (e instanceof HubAttachmentRefused) return send(res, 415, { code: e.refusal });
    if (e instanceof HubProtocolError) {
      const status = STATUS[e.code] ?? 400;
      if (status === 503) {
        try { deps.log?.("warn", "Hub HTTP unavailable", { method, path, code: e.code,
          cause: e.cause instanceof HubGroupPolicyError ? e.cause.message : e.code }); } catch { /* diagnostics cannot replace the response */ }
      }
      return send(res, status, { code: e.code }, status === 429 ? { "Retry-After": "10" } : {});
    }
    send(res, 500, { code: "unavailable" });
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://hub.invalid"); } catch { return false; }
    const path = url.pathname, method = req.method ?? "GET";
    if(mcp.handle(req,res,url))return true;
    if (deps.companyJoin && live() && handleCompanyJoin(req, res, deps.companyJoin)) return true;
    if (path.startsWith("/hub/v1/")) {
      void api(req, res, path, url.searchParams).catch((e) => fail(res, e, method, path));
      return true;
    }
    if (method !== "GET" && method !== "HEAD") return false;
    if (!live()) { send(res, 503, { code: "unavailable" }); return true; }
    if (handleWebIconRequest(req, res, path)) return true;
    if (path === "/") { res.writeHead(302, { Location: "/ui/hub", "Cache-Control": "no-store" }); res.end(); return true; }
    if (path === "/web" || path === "/ui" || path === "/ui/hub" || path === "/ui/hub/exposures" || path === "/ui/hub/admin") {
      serveHubWorkspaceShell(res, { name: deps.config.name, preview: deps.preview, loginWithoutAt: deps.config.loginWithoutAt === true });
      return true;
    }
    if (path.startsWith("/ui/js/")) {
      const file = path.slice("/ui/js/".length);
      if (!HUB_UI_MODULES.includes(file) && !HUB_OFFICE_MODULES.includes(file)) return false;
      try {
        const js = readFileSync(join(uiDir, file));
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" });
        res.end(js);
      } catch { send(res, 404, { code: "not-found" }); }
      return true;
    }
    if (path.startsWith("/assets/")) return servePublicAsset(res, path.slice("/assets/".length));
    return false;
  }

  /** M-3533 R2b: a pictures exchange refused for the link's state answers so; a malformed or unnegotiated frame stays an error. */
  function pictureCall<T>(fn: () => T): T | { ok: false; code: "stale" | "revoked" | "unavailable" } {
    try { return fn(); }
    catch (error) {
      if (!(error instanceof HubProtocolError) || error.code === "incompatible" || error.code === "invalid") throw error;
      return { ok: false, code: error.code === "stale" || error.code === "revoked" ? error.code : "unavailable" };
    }
  }
  function roomPostCode(error: HubProtocolError): "invalid" | "denied" | "revoked" | "not-found" | "unavailable" | "stale" | "backpressure" {
    switch (error.code) { case "invalid": case "denied": case "revoked": case "not-found": case "stale": case "backpressure": return error.code; default: return "unavailable"; }
  }
  async function receive(frame: Exclude<HubMemberFrame, { type: "hello" }>, link: HubLinkContext): Promise<HubServerFrame | void> {
    if (!live() || !link.current()) throw new HubProtocolError("stale");
    fleetVersions.connected(link);
    rooms.noteLink(link);
    quota.noteLink(link);
    groupRooms.agents.noteLink(link);
    groupRooms.postReplies.noteLink(link);
    deps.pairingNotices?.noteLink(link);
    const reply = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
    switch (frame.type) {
      case "agent.intro": return {...reply,type:"agent.intro-result",payload:introTool.receive(frame.payload,link,frame.requestId)};
      case "fleet.recommendation-ack": recommendations.acknowledge(frame.payload, link); return;
      case "agent.catalog":
        agentCatalogs.report(frame.payload, link);
        rooms.shareLapsesChanged(link.fleetId);
        groupRooms.agents.publicationChanged(link.fleetId);
        sharingRequests.wake(); return;
      case "agent.pictures": return { ...reply, type: "agent.pictures-result", payload: pictureCall(() => agentPictures.report(frame.payload, link)) };
      case "agent.picture": return { ...reply, type: "agent.picture-result", payload: pictureCall(() => agentPictures.chunk(frame.payload, link)) };
      case "exposure.request-result": sharingRequests.result(frame.requestId, frame.payload, link); return { ...reply, type: "exposure.request-ack", payload: { ok: true } };
      case "exposure.undo": sharingRequests.undo(frame.requestId, frame.payload, link); return { ...reply, type: "exposure.undo-result", payload: { ok: true } };
      case "fleet.info": fleetVersions.report(frame.payload, link); fleetUpdates.report(frame.payload, link); return;
      case "fleet.update-status": await fleetUpdates.status(frame.payload, link); return;
      case "room.list":
        try { return { ...reply, type: "room.list-result", payload: await (async()=>{const result=await groupRooms.agentRooms(frame.payload,link);if(!result.ok||!link.features.has(HUB_DIRECT_POST_CAPABILITY))return result;const all=[...result.rooms,...await directPosts.rooms(frame.payload.exposureId,link)];return {...result,rooms:all.slice(0,200),...(all.length>200?{truncated:true}:{})};})() }; }
        catch (error) { if (!(error instanceof HubProtocolError)) throw error; return { ...reply, type: "room.list-result", payload: { ok: false, exposureId: frame.payload.exposureId, code: roomPostCode(error) } }; }
      case "room.post-answer-ack": groupRooms.postReplies.acknowledge(frame.payload, link); return;
      case "room.history":
        try { return { ...reply,type:"room.history-result",payload:await groupRooms.agentHistory(frame.payload,link) }; }
        catch(error){if(!(error instanceof HubProtocolError))throw error;return {...reply,type:"room.history-result",payload:{ok:false,code:roomPostCode(error)}};}
      case "room.members":
        try { return { ...reply, type: "room.members-result", payload: await groupRooms.agentMembers(frame.payload, link) }; }
        catch (error) { if (!(error instanceof HubProtocolError)) throw error; return { ...reply, type: "room.members-result", payload: { ok: false, code: roomPostCode(error), } }; }
      case "people.search":
        try { return { ...reply, type: "people.search-result", payload: await groupRooms.agentPeople(frame.payload, link) }; }
        catch (error) { if (!(error instanceof HubProtocolError)) throw error; return { ...reply, type: "people.search-result", payload: { ok: false, code: roomPostCode(error), } }; }
      case "room.post":
        try { return { ...reply, type: "room.post-result", payload: await (frame.payload.direct?directPosts.post(frame.payload,link):groupRooms.agentPost(frame.payload, link)) }; }
        catch (error) { if (!(error instanceof HubProtocolError)) throw error; return { ...reply, type: "room.post-result", payload: { ok: false, code: roomPostCode(error),...(frame.payload.direct?{message:error.code==="stale"?"The sharing or sending connection changed; check hub_room_list before trying again.":"The person is no longer allowed to ask this agent, or their permission expired."}:{}) } }; }
      case "room.context-state": return { ...reply, type: "room.context-state-result", payload: groupRooms.agents.contextState(frame.payload,link) };
      case "room.context-input": return { ...reply, type: "room.context-input-result", payload: groupRooms.agents.contextInput(frame.payload,link) };
      case "room.answer":
        try { return { ...reply, type: "room.answer-ack", payload: await groupRooms.agents.answer(frame.payload, link) }; }
        catch (error) {
          // No ACK means the Fleet retains its frozen answer. A pause or transient read must not break its member link.
          if (error instanceof HubProtocolError && ["unavailable", "backpressure", "revoked", "not-found", "stale"].includes(error.code)) return;
          throw error;
        }
      case "agent.state": groupRooms.agents.state(frame.payload, link); directAgentChanged(frame.payload.exposureId); return;
      // M-3127 (agent reactions, on room-answer-buttons-v1): an agent's reaction to the room question it was asked; the result says why not.
      case "room.react":
        try { return { ...reply, type: "room.react-result", payload: await groupRooms.agentReact(frame.payload, link) }; }
        catch (error) { if (!(error instanceof HubProtocolError) || !["invalid", "denied", "not-found", "revoked"].includes(error.code)) throw error;
          return { ...reply, type: "room.react-result", payload: { messageId: frame.payload.messageId, ok: false, code: error.code as "invalid" | "denied" | "not-found" | "revoked" } }; }
      case "exposure.snapshot": await catalog.receiveSnapshot(frame.payload, link, frame.requestId); try { agentPictures.prune(); } catch { /* the periodic sweep */ }
        await sharingRequests.snapshot(link); quota.prune(); groupRooms.agents.publicationChanged(link.fleetId); return;
      case "exposure.quota": quota.receive(frame.payload, link); return;
      case "pairing.notice-ack":
        if (!deps.pairingNotices) throw new HubProtocolError("incompatible");
        deps.pairingNotices.acknowledgeFleet(link, frame.payload.id); return;
      case "question.close": { const payload = rooms.closeQuestion(frame.payload, link); directChanged(payload.messageId, false); return { ...reply, type: "question.close-result", payload }; }
      case "receipt": { const payload = rooms.receipt(frame.payload, link); directChanged(payload.messageId, false); return { ...reply, type: "receipt", payload }; }
      case "answer": { const payload = await rooms.answer(frame.payload, link); directChanged(payload.messageId, true); return { ...reply, type: "receipt", payload }; }
      case "authorize.request": {
        const payload = await policy.authorize(frame.payload, link);
        // M-3596: a begin lease is the hand-off to the agent: the asker's question now reads "working on it".
        if (payload.ok && frame.payload.phase === "begin") directStarted(frame.payload.messageId);
        return { ...reply, type: "authorize.result", payload };
      }
      case "reconcile": {
        const page = rooms.reconcile(frame.payload, link);
        // The link becomes ready once S1 has sent this last page; questions follow it (retrying briefly until it is).
        if (!page.more) flushSoon(link);
        return { ...reply, type: "reconcile", payload: page };
      }
      case "attachment.get": return { ...reply, type: "attachment.chunk", payload: await (groupRooms.agents.ownsFile(frame.payload.id)
        ? groupRooms.agents.attachmentGet(frame.payload, link) : rooms.attachmentGet(frame.payload, link)) };
      case "attachment.put": return { ...reply, type: "attachment.ack", payload: rooms.attachmentPut(frame.payload, link) };
      case "error": return;
    }
  }
  function publishSharingSettlement(settlement: import("../sharing-withdrawal.js").SharingSettlement): void {
    for (const id of settlement.direct) {
      const message = core.atomic(db => db.prepare("SELECT room_id,asker FROM hub_messages WHERE id=?").get(id) as { room_id: string; asker: string } | undefined);
      if (message) groupRooms.publish({ type: "room.changed", roomId: message.room_id, data: { roomId: message.room_id }, audiencePerson: message.asker });
    }
    groupRooms.agents.publicationSettled(settlement.group);
  }
  /** M-3596: the agent of these 1:1 rooms changed state (working, idle, paused): each asker's room view is read again. */
  function directAgentChanged(exposureId: string): void {
    const rows = core.atomic(db => db.prepare("SELECT id,asker FROM hub_rooms WHERE exposure_id=? AND state='active'").all(exposureId) as { id: string; asker: string }[]);
    for (const r of rows) groupRooms.publish({ type: "room.changed", roomId: r.id, data: { roomId: r.id }, audiencePerson: r.asker });
  }
  /** M-3596: the question was handed to its agent — its pending answer row reads "working" now (the asker only). */
  function directStarted(messageId: string): void {
    const row = core.atomic(db => db.prepare("SELECT room_id,asker FROM hub_messages WHERE id=?").get(messageId) as { room_id: string; asker: string } | undefined);
    if (row) groupRooms.publish({ type: "message.updated", roomId: row.room_id, data: { roomId: row.room_id, messageId: `${messageId}:answer` }, audiencePerson: row.asker });
  }
  function directChanged(messageId: string, answer: boolean): void {
    const row = core.atomic(db => db.prepare("SELECT room_id,asker FROM hub_messages WHERE id=?").get(messageId) as { room_id: string; asker: string } | undefined);
    if (!row) return;
    groupRooms.publish({ type: answer ? "message.added" : "message.updated", roomId: row.room_id, data: { roomId: row.room_id, messageId: answer ? `${messageId}:answer` : messageId }, audiencePerson: row.asker });
    groupRooms.publish({ type: "unread.changed", roomId: row.room_id, data: { roomId: row.room_id }, audiencePerson: row.asker });
  }
  function flushSoon(link: HubLinkContext, attempt = 0): void {
    const t = setTimeout(() => {
      if (!live() || !link.current()) return;
      void rooms.flush(link.fleetId).then((sent) => { if (!sent && attempt < 5) flushSoon(link, attempt + 1); }, () => {});
      groupRooms.agents.wake();
      void deps.pairingNotices?.flushFleet(link).catch(() => {});
    }, attempt === 0 ? 0 : 100 * attempt);
    t.unref?.();
  }

  personal?.turns.start({direct:rooms.personalQuestions(id=>directChanged(id,true)),room:groupRooms.agents.personalQuestions()});
  rooms.buttons.start(); groupRooms.agents.wake(); groupRooms.assistant.start();
  return {
    ...(roomAgentRequests ? { retainedContentRefs: () => roomAgentRequests.retainedNoteRefs() } : {}),
    directorySessions: Object.freeze({
      recentAuthentication: (actor, permit) => sessions.recentAuthentication(actor, permit),
      prepareDirectoryRotation: (token, actor) => sessions.prepareDirectoryRotation(token, actor),
      completeDirectoryRotation: (rotation, operationId) => sessions.completeDirectoryRotation(rotation, operationId),
    } satisfies HubDirectoryBrowserSessions),
    handle, receive,...(deps.issuer.signRoomAsker?{roomAskerIdentityV1:true as const}:{}), memberReady: link => { recommendations.ready(link); fleetUpdates.ready(link); }, memberConnected: link => { fleetVersions.connected(link); agentCatalogs.connected(link); }, memberClosed: fleetId => { if (live()) groupRooms.agents.disconnected(fleetId); }, agentIntroV1: true, agentCatalogV1: true, agentPicturesV1: true,agentCharactersV1: true, exposureRequestsV1: true, features: Object.freeze(["agent-intro-defaults-v1", "agent-sharing-v1", "agent-intros-v1", "admin-dashboard-v1", "fleet-update-v1", "rooms-v1", "room-purpose-v1", "room-ask-v1", "room-post-v1", HUB_DIRECT_POST_CAPABILITY, HUB_ROOM_CONTEXT_CAPABILITY, HUB_ROOM_BRIEF_CAPABILITY, HUB_ROOM_MEMBERS_CAPABILITY, HUB_ROOM_HISTORY_CAPABILITY, HUB_ROOM_ANSWER_STATUS_CAPABILITY, HUB_ROOM_REACT_ACK_CAPABILITY, "person-prefs-v1", ...(roomAgentRequests ? ["room-owner-requests-v1"] : []), ...(roomDiscovery ? ["room-agent-discovery-v1"] : []), ...(personal ? ["personal-agents-v1"] : []), ...(teams ? ["teams-v1"] : []), ...(deps.roleAdmin ? ["role-settings-v1"] : []), ...(deps.roomAssistant && deps.assistantAdmin ? ["room-assistant-v1"] : []), ...(deps.refreshAuthorization ? ["sharing-pause-v1"] : []), ...(deps.groupHttp ? [GROUP_POLICY_FEATURE, ...(deps.pairingNotices ? ["quick-pairing-v1"] : [])] : []), ...(grantSubjectsOffered() ? ["grant-subjects-v1"] : []),
      ...(deps.directoryNotices ? ["directory-security-notices-v1"] : []), ...(deps.memberAddressNotices ? ["member-address-notices-v1"] : []), ...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE, HUB_DIRECTORY_EDITOR_FEATURE] : [])]),
    async close() { closed = true; sharingRequests.close(); agentCatalogs.close(); agentPictures.close(); personal?.owner.close(); await personal?.turns.close(); fleetUpdates.close(); recommendations.close(); fleetVersions.close(); grantSearch.close(); for (const end of streams) end(); await mcp.close(); await groupRooms.close(); await rooms.buttons.close(); rooms.forget(); quota.close(); },
  };
}
