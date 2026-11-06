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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HubProtocolError, parseStrictJson } from "../validation.js";
import { personKeyString } from "../identity.js";
import type { HubMemberFrame, HubServerFrame } from "../types.js";
import type { HubLinkContext } from "../server.js";
import { HubSessions, hubClearCookie, hubSetCookie } from "../sessions.js";
import { HubCatalogService } from "../catalog.js";
import { HubPolicyService } from "../policy.js";
import { HubRoomsService } from "../rooms.js";
import { HubAttachmentRefused } from "../attachments/store.js";
import { HubQuotaService } from "../quota.js";
import { HubCore, personByLogin } from "./core.js";
import { HUB_HTTP_MIGRATIONS } from "./schema.js";
import type { HubHttpDeps, HubTxDatabase } from "./deps.js";
import { serveHubWorkspaceShell } from "../../web-api.js";
import { servePublicAsset } from "../../auth-api.js";

export { HUB_HTTP_MIGRATIONS };
/** S5's lazy entry (HubHttpEntry): this module itself — `createHubHttp` and `migrations`. */
export const migrations = HUB_HTTP_MIGRATIONS;
export type { HubHttpDeps, HubTxDatabase };

/** The Hub's lazy modules a Hub page may load (the fleet's /ui/js/ modules are never served here). */
export const HUB_UI_MODULES = Object.freeze(["panel-hub.js", "hub-client.js", "hub-strings.js", "hub-chat-store.js", "hub-chat-strings.js", "hub-quota.js", "hub-owner-strings.js"]);
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
  const core = new HubCore(deps, sql);
  const sessions = new HubSessions(core), catalog = new HubCatalogService(core), policy = new HubPolicyService(core);
  const rooms = new HubRoomsService(core, policy);
  const quota = new HubQuotaService(core);
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "ui");
  let closed = false;
  const live = () => !closed && core.live();
  /** Upload bodies being read now, per session and in all (each up to the file limit in memory). */
  const uploading = new Map<string, number>(); let uploadingTotal = 0;

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
    let r: RegExpExecArray | null;

    if (path === "/hub/v1/session") {
      if (method === "GET") {
        const s = sessions.session(ctx.token);
        return send(res, 200, s ? { signedIn: true, displayName: s.displayName, login: s.login, admin: s.admin, csrf: s.csrf, hub: { name: deps.config.name } }
          : { signedIn: false, hub: { name: deps.config.name } });
      }
      if (method === "POST") {
        const b = await body();
        const out = await sessions.signIn(b.login, b.password);
        const { csrf: token, ...view } = out.view;
        return send(res, 200, { signedIn: true, displayName: view.displayName, login: view.login, admin: view.admin, csrf: token, hub: { name: deps.config.name } },
          { "Set-Cookie": hubSetCookie(deps.config.hubId, out.token, out.maxAgeMs) });
      }
      if (method === "DELETE") { csrf(); sessions.signOut(ctx.token); return send(res, 200, { signedIn: false }, { "Set-Cookie": hubClearCookie(deps.config.hubId) }); }
      throw new HttpError(405, "method");
    }
    if (path === "/hub/v1/exposures" || path === "/hub/v1/grants") {
      if (method === "GET") {
        signedIn(); const view = await guard(() => catalog.visible(ctx));
        return send(res, 200, { ...view, mine: view.mine.map(e => ({ ...e, quotaVisible: quota.visible(e.id), ...quota.projection(e.id) })) });
      }
      if (path === "/hub/v1/grants" && method === "POST") {
        csrf(); const b = await body();
        const g = await guard(() => catalog.grant(ctx, { exposureId: uuid(b.exposureId), exposureRevision: int(b.exposureRevision), login: str(b.login), days: int(b.days) }));
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
    if (path === "/hub/v1/rooms") {
      if (method === "GET") { signedIn(); return send(res, 200, { rooms: (await guard(() => rooms.list(ctx))).map(room => ({ ...room, ...quota.roomProjection(room) })) }); }
      if (method === "POST") {
        csrf(); const b = await body();
        const room = await guard(() => rooms.open(ctx, uuid(b.exposureId), uuid(b.grantId)));
        return send(res, 200, { room: { id: room.id, exposureId: room.exposureId, grantId: room.grantId, state: room.state, exposureName: room.exposure.displayName, features: rooms.features(room.exposure.fleetId), ...quota.projection(room.exposureId) } });
      }
      throw new HttpError(405, "method");
    }
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/messages$/))) {
      const roomId = uuid(r[1]);
      if (method === "GET") {
        const s = signedIn();
        // #3226 B + G: the room comes with its entries, fresh each poll — its view (state, grant's end, what its link
        // negotiated) and its quota projection (G; absent when hidden or not shared).
        const entries = await guard(() => rooms.read(ctx, roomId, int(query.get("after") ?? "0"), s.sessionId));
        const view = await guard(() => rooms.view(ctx, roomId));
        return send(res, 200, { entries, room: { ...view, ...quota.roomProjection(view) } });
      }
      if (method === "POST") {
        csrf(); const b = await body();
        const files = b.files === undefined ? [] : Array.isArray(b.files) && b.files.length <= 10 ? b.files.map(uuid) : (() => { throw new HubProtocolError("invalid"); })();
        return send(res, 200, { receipt: await guard(() => rooms.ask(ctx, roomId, uuid(b.idempotencyKey), typeof b.text === "string" ? b.text : "", files)) });
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
    if ((r = m(/^\/hub\/v1\/rooms\/([^/]+)\/files\/([^/]+)$/))) {
      if (method !== "GET") throw new HttpError(405, "method");
      const roomId = uuid(r[1]), fileId = uuid(r[2]); signedIn();
      const file = await guard(() => rooms.download(ctx, roomId, fileId));
      // Never executed or sniffed: a download, in a sandbox; only a magic-checked image may show inline when asked.
      const inline = query.get("inline") === "1" && file.image;
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
        fleets: state.fleets.map((f) => ({ id: f.id, status: f.status, generation: f.generation, owner: name(f.owner) })),
        pairings: state.pairings.filter((p) => p.expiresAt > now && (p.state === "offered" || p.state === "pending"))
          .map((p) => ({ id: p.id, state: p.state, expiresAt: p.expiresAt, fingerprint: p.fingerprint, ownerConfirmed: p.ownerConfirmed, adminApproved: p.adminApproved, owner: name(p.owner) })),
      });
    }
    if (path === "/hub/v1/admin/pairings") {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); const login = str(b.login).trim();
      await guard(() => ctx.requireAdmin());
      const owner = await personByLogin(core, login);
      if (!owner) throw new HubProtocolError("not-found");
      const offer = await guard(() => deps.pairing.create(ctx, owner));
      return send(res, 200, offer);
    }
    if ((r = /^\/hub\/v1\/admin\/pairings\/([^/]+)\/approve$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); const fp = str(b.fingerprint, 64);
      if (!HEX64.test(fp)) throw new HubProtocolError("invalid");
      await guard(() => deps.pairing.approve(ctx, uuid(r![1]), fp)); return send(res, 200, { ok: true });
    }
    if ((r = /^\/hub\/v1\/admin\/fleets\/([^/]+)\/revoke$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); await guard(() => deps.pairing.revoke(ctx, uuid(r![1]))); return send(res, 200, { ok: true });
    }
    if ((r = /^\/hub\/v1\/admin\/exposures\/([^/]+)\/freeze$/.exec(path))) {
      if (method !== "POST") throw new HttpError(405, "method");
      csrf(); const b = await body(); await guard(() => catalog.freeze(ctx, uuid(r![1]), int(b.revision), true)); return send(res, 200, { ok: true });
    }
    void req;
    throw new HttpError(404, "not-found");
  }

  function fail(res: ServerResponse, e: unknown): void {
    if (e instanceof SignedOut) return send(res, 401, { code: "signed-out" });
    if (e instanceof HttpError) return send(res, e.status, { code: e.code });
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
    if (path.startsWith("/hub/v1/")) {
      void api(req, res, path, url.searchParams).catch((e) => fail(res, e));
      return true;
    }
    if (method !== "GET" && method !== "HEAD") return false;
    if (!live()) { send(res, 503, { code: "unavailable" }); return true; }
    if (path === "/") { res.writeHead(302, { Location: "/ui/hub", "Cache-Control": "no-store" }); res.end(); return true; }
    if (path === "/web" || path === "/ui" || path === "/ui/hub" || path === "/ui/hub/exposures" || path === "/ui/hub/admin") {
      serveHubWorkspaceShell(res, { name: deps.config.name });
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
    const reply = { v: 1 as const, requestId: frame.requestId, linkEpoch: link.linkEpoch };
    switch (frame.type) {
      case "exposure.snapshot": catalog.receiveSnapshot(frame.payload, link); quota.prune(); return;
      case "exposure.quota": quota.receive(frame.payload, link); return;
      case "receipt": return { ...reply, type: "receipt", payload: rooms.receipt(frame.payload, link) };
      case "answer": return { ...reply, type: "receipt", payload: await rooms.answer(frame.payload, link) };
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
  function flushSoon(link: HubLinkContext, attempt = 0): void {
    const t = setTimeout(() => {
      if (!live() || !link.current()) return;
      void rooms.flush(link.fleetId).then((sent) => { if (!sent && attempt < 5) flushSoon(link, attempt + 1); }, () => {});
    }, attempt === 0 ? 0 : 100 * attempt);
    t.unref?.();
  }

  return {
    handle, receive,
    async close() { closed = true; rooms.forget(); quota.close(); },
  };
}
