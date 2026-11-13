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
import { GROUP_POLICY_FEATURE, handleGroupHttp } from "../group-policy/admin-api.js";
import { handleHubDirectorySettingsHttp, HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE, HUB_DIRECTORY_EDITOR_FEATURE } from "../settings-directory-http.js";
import { handleHubSettingsHttp } from "../settings-api.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HubProtocolError, parseStrictJson } from "../validation.js";
import { personKeyString } from "../identity.js";
import { HubEnrolmentCodeLimit } from "../enrolment-code.js";
import type { HubMemberFrame, HubServerFrame } from "../types.js";
import type { HubLinkContext } from "../server.js";
import type { HubDirectoryBrowserSessions } from "../settings-directory-runtime.js";
import { HubSessions, hubClearCookie, hubSetCookie } from "../sessions.js";
import { HubCatalogService } from "../catalog.js";
import { HubGrantSearch } from "../grant-search.js";
import { HubPolicyService } from "../policy.js";
import { HubRoomsService } from "../rooms.js";
import { HubGroupRooms, HubRoomRefusal } from "../rooms/service.js";
import { directMessages, directRoomView, directUnread, markDirectRead } from "../rooms/direct-view.js";
import { HubAttachmentRefused } from "../attachments/store.js";
import { HubQuotaService } from "../quota.js";
import { HubCore, pairingOwnerByLogin } from "./core.js";
import { HubSharingPaused, HubSharingService } from "../sharing.js";
import { HUB_HTTP_MIGRATIONS } from "./schema.js";
import type { HubHttpDeps, HubTxDatabase } from "./deps.js";
import { serveHubWorkspaceShell } from "../../web-api.js";
import { servePublicAsset } from "../../auth-api.js";
import { handleCompanyJoin, companyFlowCookie } from "../join/http.js";
import { CompanyJoinCodeRefusal, CompanyJoinLimit, CompanyJoinOfferPending } from "../join/service.js";
import { HubMemberAddressError } from "../settings-member-address-policy.js";

export { HUB_HTTP_MIGRATIONS };
/** S5's lazy entry (HubHttpEntry): this module itself — `createHubHttp` and `migrations`. */
export const migrations = HUB_HTTP_MIGRATIONS;
export type { HubHttpDeps, HubTxDatabase };

/** The Hub's lazy modules a Hub page may load (the fleet's /ui/js/ modules are never served here). */
export const HUB_UI_MODULES = Object.freeze(["panel-hub.js", "hub-client.js", "hub-strings.js", "hub-chat-store.js", "hub-chat-strings.js", "hub-quota.js", "hub-owner-strings.js", "hub-grant-strings.js", "hub-button-actions.js", "hub-preview.js", "hub-attachments.js",
  // #3298 S-89 (lazy; loaded only when the session says "group-policy-v1"): the welcome, Group permissions and their words.
  "hub-welcome.js", "hub-group-policy.js", "hub-group-strings.js", "hub-read-strings.js", "hub-quick-pairing.js", "hub-quick-strings.js", "hub-company-join.js", "hub-company-join-strings.js", "hub-this-hub.js", "hub-directory-notices.js", "hub-directory-notice-strings.js", "hub-directory-editor.js", "hub-directory-editor-strings.js",
  // Hub UX U2 (M-2932): the group-search picker (its own words inside), shared with B2's join-code scope.
  "hub-group-search.js", "hub-join-steps.js", "hub-grant-picker.js",
  // B2: code management and the same-request Hub approval queue.
  "hub-enrolment-code.js", "hub-enrolment-code-strings.js", "hub-join-queue.js", "hub-join-approval.js", "hub-joincode-flow-strings.js"]);
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
  const core = new HubCore(deps, sql, () => !closed);
  const sharing = new HubSharingService(core);
  const sessions = new HubSessions(core), catalog = new HubCatalogService(core), policy = new HubPolicyService(core);
  const grantSearch = new HubGrantSearch(core);
  const rooms = new HubRoomsService(core, policy);
  const groupRooms = new HubGroupRooms(core);
  const quota = new HubQuotaService(core);
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
    // Composed routes, not enrollment authority or the administrator's on/off switch. Older Hubs omit unsupported cards.
    const offered = ["rooms-v1", ...(deps.refreshAuthorization ? ["sharing-pause-v1"] : []), ...(deps.groupHttp ? [GROUP_POLICY_FEATURE, ...(deps.pairingNotices ? ["quick-pairing-v1"] : [])] : []), ...(grantSubjectsOffered() ? ["grant-subjects-v1"] : []),
      ...(deps.companyJoin ? ["company-join-v1", "enrolment-code-v1"] : []), ...(deps.directoryNotices ? ["directory-security-notices-v1"] : []), ...(deps.memberAddressNotices ? ["member-address-notices-v1"] : []),
      ...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE, HUB_DIRECTORY_EDITOR_FEATURE] : [])];
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
        return send(res, 200, s ? { signedIn: true, displayName: s.displayName, login: s.login, admin: s.admin, csrf: s.csrf, hub: { name: deps.config.name }, ...features }
          : { signedIn: false, hub: { name: deps.config.name } });
      }
      if (method === "POST") {
        const b = await body();
        const out = await sessions.signIn(b.login, b.password);
        const { csrf: token, ...view } = out.view;
        return send(res, 200, { signedIn: true, displayName: view.displayName, login: view.login, admin: view.admin, csrf: token, hub: { name: deps.config.name }, ...features },
          { "Set-Cookie": hubSetCookie(deps.config.hubId, out.token, out.maxAgeMs) });
      }
      if (method === "DELETE") { csrf(); sessions.signOut(ctx.token); return send(res, 200, { signedIn: false }, { "Set-Cookie": hubClearCookie(deps.config.hubId) }); }
      throw new HttpError(405, "method");
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
        csrf(); const b = await body(); await guard(() => deps.pairing.revokeOwned(ctx, uuid(r![1]), int(b.generation)));
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
    if (path === "/hub/v1/exposures" || path === "/hub/v1/grants") {
      if (method === "GET") {
        signedIn(); const view = await guard(() => catalog.visible(ctx));
        return send(res, 200, { ...view, mine: view.mine.map(e => ({ ...e, quotaVisible: quota.visible(e.id), ...quota.projection(e.id) })) });
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
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/sharing$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => sharing.change(ctx, uuid(r![1]), b));
      return send(res, 200, { ok: true });
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/freeze$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => catalog.freeze(ctx, uuid(r![1]), int(b.revision), false)); return send(res, 200, { ok: true });
    }
    if ((r = m(/^\/hub\/v1\/exposures\/([^/]+)\/quota$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body();
      if (typeof b.visible !== "boolean" || Object.keys(b).some(k => !["revision", "visible"].includes(k))) throw new HubProtocolError("invalid");
      const exposureId = uuid(r[1]);
      await guard(() => quota.setVisible(ctx, exposureId, int(b.revision), b.visible as boolean));
      return send(res, 200, { quotaVisible: b.visible, ...quota.projection(exposureId) });
    }
    if (path === "/hub/v1/rooms/candidates") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); return send(res, 200, await guard(() => groupRooms.candidates(ctx, query.get("q") ?? "", query.get("kind") ?? "person")));
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
          if (event.audiencePerson) {
            const view = await rooms.view(ctx, event.roomId);
            if (event.type === "unread.changed") data = { roomId: event.roomId, unread: directUnread(core, view) };
            else if (event.type === "room.changed") data = { roomId: event.roomId, room: directRoomView(view, rooms.presence(view.exposureId), directUnread(core, view)) };
            else {
              const page = await rooms.readPage(ctx, event.roomId, 0, streamSession.sessionId, { before: null, limit: 100 });
              const message = directMessages(page.room, page.entries, streamSession.displayName).find(m => m.id === event.data.messageId);
              data = message ? { roomId: event.roomId, message } : null;
            }
          } else data = await groupRooms.event(ctx, event);
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
        if (query.get("v") !== "2") return send(res, 200, { rooms: view.rooms.map(room => ({ ...room, ...quota.roomProjection(room, view.grantProof) })) });
        const groups = await guard(() => groupRooms.list(ctx));
        return send(res, 200, { ...groups, rooms: [...groups.rooms, ...view.rooms.map(room => ({ ...directRoomView(room, rooms.presence(room.exposureId), directUnread(core, room)), ...quota.roomProjection(room, view.grantProof) }))] }); }
      if (method === "POST") {
        csrf(); const b = await body();
        if (b.exposureId === undefined) return send(res, 200, await guard(() => groupRooms.create(ctx, b)));
        const room = await guard(() => rooms.open(ctx, uuid(b.exposureId), uuid(b.grantId)));
        return send(res, 200, { room: { id: room.id, exposureId: room.exposureId, grantId: room.grantId, state: room.state, exposureName: room.exposure.displayName, features: rooms.features(room.exposure.fleetId), ...quota.roomProjection(room, room.grantProof) } });
      }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)$/))) {
      signedIn(); const roomId = uuid(r[1]);
      if (groupRooms.has(roomId)) {
        if (method === "GET") return send(res, 200, await guard(() => groupRooms.detail(ctx, roomId)));
        if (method === "PATCH") { csrf(); const b = await body(); return send(res, 200, await guard(() => groupRooms.patch(ctx, roomId, b))); }
      } else if (method === "GET") {
        const room = await guard(() => rooms.view(ctx, roomId)); const person = personKeyString(room.asker), name = signedIn().displayName;
        return send(res, 200, { room: directRoomView(room, rooms.presence(room.exposureId), directUnread(core, room)), me: { id: person, role: "member" },
          members: [{ id: person, kind: "person", name, role: "member", presence: "online" }, { id: room.exposureId, kind: "agent", name: room.exposureName,
            owner: { name: room.ownerName }, role: "member", presence: rooms.presence(room.exposureId), canAsk: room.state === "active" }],
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
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/buttons$/))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body();
      return send(res, 200, { receipt: await guard(() => rooms.buttons.click(ctx, uuid(r![1]), b)) });
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
        return send(res, 200, { entries, room: { ...view, ...quota.roomProjection(view, grantProof) }, messages, more: (more ?? false) || overflow });
      }
      if (method === "POST") {
        csrf(); const b = await body();
        const files = b.files === undefined ? [] : Array.isArray(b.files) && b.files.length <= 10 ? b.files.map(uuid) : (() => { throw new HubProtocolError("invalid"); })();
        if (b.mentions !== undefined && (!Array.isArray(b.mentions) || b.mentions.length)) throw new HubProtocolError("invalid");
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
        await guard(() => rooms.uploadAdmit(ctx, roomId, Number(declared)));
        const bytes = await readRaw(req, Number(declared)); if (!live()) throw new HubProtocolError("unavailable");
        if (bytes.length !== Number(declared)) throw new HubProtocolError("invalid");
        return send(res, 200, { file: await guard(() => rooms.upload(ctx, roomId, name, bytes)) });
      } finally {
        const n = (uploading.get(s.sessionId) ?? 1) - 1; if (n > 0) uploading.set(s.sessionId, n); else uploading.delete(s.sessionId); uploadingTotal--;
      }
    }
    // `/inline` (a plain path, as the shared thread's renderer takes it) is the same as `?inline=1`: images only.
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/files\/([^/]+)(\/inline)?$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      const roomId = uuid(r[1]), fileId = uuid(r[2]); signedIn();
      const file = await guard(() => rooms.download(ctx, roomId, fileId));
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
      ctx: { requestId: ctx.requestId, current: () => live() && ctx.isCurrent?.() === true, requireAdmin: () => ctx.requireAdmin(), requirePerson: () => ctx.requirePerson() } })) return;
    // M-2682: Administration → This Hub (what it is; its rename through the host's writer for sealed settings).
    if (await handleHubDirectorySettingsHttp(deps.directorySettings, { req, res, path, method, query, signedIn, csrf, body,
      send: (status, value) => send(res, status, value), sessions,
      ...(deps.directoryResponse ? { capture: (proof: () => boolean) => deps.directoryResponse!.capture(req, res, proof) } : {}),
      ctx: { token: ctx.token, requestId: ctx.requestId, current: () => live() && ctx.isCurrent?.() === true, requireAdmin: () => ctx.requireAdmin() } })) return;
    if (await handleHubSettingsHttp(deps.hubSettings ? { ...deps.hubSettings, name: deps.config.name } : undefined, { path, method, signedIn, csrf, body,
      send: (status, value) => send(res, status, value),
      ctx: { requestId: ctx.requestId, current: () => live() && ctx.isCurrent?.() === true, requireAdmin: () => ctx.requireAdmin() },
      audit: (event) => core.atomic((_db, tx) => core.audit(tx, { requestId: event.requestId, actor: { kind: "person", person: event.actor.person }, action: event.action,
        result: event.result, ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}) })) })) return;
    if (path.startsWith("/hub/v1/admin/")) return admin(req, res, path, ctx, method, signedIn, csrf, body, guard);
    throw new HttpError(404, "not-found");
  }

  async function admin(req: IncomingMessage, res: ServerResponse, path: string, ctx: ReturnType<HubSessions["context"]>, method: string,
    signedIn: () => unknown, csrf: () => unknown, body: () => Promise<Record<string, unknown>>, guard: <T>(w: () => Promise<T>) => Promise<T>): Promise<void> {
    let r: RegExpExecArray | null;
    if (path === "/hub/v1/admin/overview") {
      if (method !== "GET") throw new HttpError(405, "method");
      signedIn(); await guard(() => ctx.requireAdmin());
      const state = deps.store.read(), now = core.now();
      const name = (key: { realm: string; objectId: string }) => {
        const id = personKeyString(key);
        const row = core.atomic((db) => db.prepare("SELECT display_name, login_label FROM hub_people WHERE person=?").get(id) as { display_name: string; login_label: string } | undefined);
        return row ? { name: row.display_name, login: row.login_label } : null;
      };
      return send(res, 200, {
        fleets: state.fleets.map((f) => ({ id: f.id, status: f.status, generation: f.generation, owner: name(f.owner), label: f.label ?? null,
          ...(deps.companyJoin?.fleetDisplay(f.id) ?? { source: null, createdAt: null }) })),
        pairings: state.pairings.filter((p) => p.expiresAt > now && (p.state === "offered" || p.state === "pending"))
          .map((p) => ({ id: p.id, state: p.state, expiresAt: p.expiresAt, fingerprint: p.fingerprint, ownerConfirmed: p.ownerConfirmed, adminApproved: p.adminApproved, owner: name(p.owner) })),
      });
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
      csrf(); await guard(() => deps.pairing.revoke(ctx, uuid(r![1]))); deps.pairingNotices?.committed(); return send(res, 200, { ok: true });
    }
    if ((r = /^\/hub\/v1\/admin\/exposures\/([^/]+)\/freeze$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => catalog.freeze(ctx, uuid(r![1]), int(b.revision), true)); return send(res, 200, { ok: true });
    }
    void req;
    throw new HttpError(404, "not-found");
  }

  function fail(res: ServerResponse, e: unknown): void {
    if (e instanceof HubRoomRefusal) return send(res, e.status, { code: e.code });
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
      return send(res, status, { code: e.code }, status === 429 ? { "Retry-After": "10" } : {});
    }
    send(res, 500, { code: "unavailable" });
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://hub.invalid"); } catch { return false; }
    const path = url.pathname, method = req.method ?? "GET";
    if (deps.companyJoin && live() && handleCompanyJoin(req, res, deps.companyJoin)) return true;
    if (path.startsWith("/hub/v1/")) {
      void api(req, res, path, url.searchParams).catch((e) => fail(res, e));
      return true;
    }
    if (method !== "GET" && method !== "HEAD") return false;
    if (!live()) { send(res, 503, { code: "unavailable" }); return true; }
    if (path === "/") { res.writeHead(302, { Location: "/ui/hub", "Cache-Control": "no-store" }); res.end(); return true; }
    if (path === "/web" || path === "/ui" || path === "/ui/hub" || path === "/ui/hub/exposures" || path === "/ui/hub/admin") {
      serveHubWorkspaceShell(res, { name: deps.config.name, preview: deps.preview });
      return true;
    }
    if (path.startsWith("/ui/js/")) {
      const file = path.slice("/ui/js/".length);
      if (!HUB_UI_MODULES.includes(file)) return false;
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

  async function receive(frame: Exclude<HubMemberFrame, { type: "hello" }>, link: HubLinkContext): Promise<HubServerFrame | void> {
    if (!live() || !link.current()) throw new HubProtocolError("stale");
    rooms.noteLink(link);
    quota.noteLink(link);
    deps.pairingNotices?.noteLink(link);
    const reply = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
    switch (frame.type) {
      // Schemas shared with Track C; no group-agent dispatch is advertised before R2 is composed.
      case "room.answer": case "agent.state": throw new HubProtocolError("incompatible");
      case "exposure.snapshot": await catalog.receiveSnapshot(frame.payload, link, frame.requestId); quota.prune(); return;
      case "exposure.quota": quota.receive(frame.payload, link); return;
      case "pairing.notice-ack":
        if (!deps.pairingNotices) throw new HubProtocolError("incompatible");
        deps.pairingNotices.acknowledgeFleet(link, frame.payload.id); return;
      case "receipt": { const payload = rooms.receipt(frame.payload, link); directChanged(payload.messageId, false); return { ...reply, type: "receipt", payload }; }
      case "answer": { const payload = await rooms.answer(frame.payload, link); directChanged(payload.messageId, true); return { ...reply, type: "receipt", payload }; }
      case "authorize.request": return { ...reply, type: "authorize.result", payload: await policy.authorize(frame.payload, link) };
      case "reconcile": {
        const page = rooms.reconcile(frame.payload, link);
        // The link becomes ready once S1 has sent this last page; questions follow it (retrying briefly until it is).
        if (!page.more) flushSoon(link);
        return { ...reply, type: "reconcile", payload: page };
      }
      case "attachment.get": return { ...reply, type: "attachment.chunk", payload: await rooms.attachmentGet(frame.payload, link) };
      case "attachment.put": return { ...reply, type: "attachment.ack", payload: rooms.attachmentPut(frame.payload, link) };
      case "error": return;
    }
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
      void deps.pairingNotices?.flushFleet(link).catch(() => {});
    }, attempt === 0 ? 0 : 100 * attempt);
    t.unref?.();
  }

  rooms.buttons.start();
  return {
    directorySessions: Object.freeze({
      recentAuthentication: actor => sessions.recentAuthentication(actor),
      prepareDirectoryRotation: (token, actor) => sessions.prepareDirectoryRotation(token, actor),
      completeDirectoryRotation: (rotation, operationId) => sessions.completeDirectoryRotation(rotation, operationId),
    } satisfies HubDirectoryBrowserSessions),
    handle, receive, features: Object.freeze(["rooms-v1", ...(deps.refreshAuthorization ? ["sharing-pause-v1"] : []), ...(deps.groupHttp ? [GROUP_POLICY_FEATURE, ...(deps.pairingNotices ? ["quick-pairing-v1"] : [])] : []), ...(grantSubjectsOffered() ? ["grant-subjects-v1"] : []),
      ...(deps.directoryNotices ? ["directory-security-notices-v1"] : []), ...(deps.memberAddressNotices ? ["member-address-notices-v1"] : []), ...(deps.directorySettings ? [HUB_DIRECTORY_SETTINGS_FEATURE, HUB_DIRECTORY_CA_FEATURE, HUB_DIRECTORY_EDITOR_FEATURE] : [])]),
    async close() { closed = true; grantSearch.close(); for (const end of streams) end(); groupRooms.close(); await rooms.buttons.close(); rooms.forget(); quota.close(); },
  };
}
