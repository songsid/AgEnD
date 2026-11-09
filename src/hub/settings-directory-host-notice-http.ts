/** Fleet listener only. Obtain the host's D3 proof before the lazy cold-state adapter, never a header/public-link authority. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubInitHostOwner } from "./init/types.js";
import type { HubDirectoryHostNotices } from "./settings-directory-host-notices.js";
import type { HubDirectoryNoticeQuery } from "./settings-directory-notices.js";
import { HubProtocolError, uuid, validated } from "./validation.js";

export interface HubDirectoryHostNoticeHttpDeps {
  hubSetupSession?(req: IncomingMessage): HubInitHostOwner | null;
  hubDirectoryNotices?(): Promise<HubDirectoryHostNotices>;
}
const prefix = "/api/settings/hub/security-notices/directory";
function send(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...(status === 429 ? { "Retry-After": "10" } : {}) });
  res.end(JSON.stringify(body));
}
export function handleHubDirectoryHostNoticeHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: HubDirectoryHostNoticeHttpDeps): boolean {
  const ack = /^\/api\/settings\/hub\/security-notices\/directory\/([^/]+)\/ack$/.exec(url.pathname);
  if (url.pathname !== prefix && !ack) return false;
  if (!deps.hubSetupSession || !deps.hubDirectoryNotices) { send(res, 404, { error: "unavailable" }); return true; }
  let source: HubInitHostOwner | null;
  try { source = deps.hubSetupSession(req); } catch { source = null; }
  if (!source) { send(res, 403, { error: "host_session_required" }); return true; }
  if (req.method !== (ack ? "POST" : "GET")) { send(res, 405, { error: "invalid" }); return true; }
  const create = deps.hubDirectoryNotices.bind(deps), sourceCurrent = source.current.bind(source);
  let disconnected = false;
  res.once("close", () => { if (!res.writableEnded) disconnected = true; });
  const owner: HubInitHostOwner = { ...source, current: () => !disconnected && sourceCurrent() === true };
  void (async () => {
    if (!owner.current()) throw new HubProtocolError("denied");
    const query: HubDirectoryNoticeQuery = {};
    if (ack && url.search) throw new HubProtocolError("invalid");
    if (!ack) {
      for (const key of url.searchParams.keys()) if (!["before", "limit", "unread"].includes(key) || url.searchParams.getAll(key).length !== 1) throw new HubProtocolError("invalid");
      if (url.searchParams.has("before")) query.before = validated(uuid, url.searchParams.get("before"));
      if (url.searchParams.has("limit")) {
        const value = url.searchParams.get("limit")!;
        if (!/^[0-9]{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new HubProtocolError("invalid");
        query.limit = Number(value);
      }
      if (url.searchParams.has("unread")) {
        if (!["0", "1"].includes(url.searchParams.get("unread")!)) throw new HubProtocolError("invalid");
        query.unread = url.searchParams.get("unread") === "1";
      }
    }
    const id = ack ? validated(uuid, ack[1]) : undefined;
    const control = await create();
    if (!owner.current()) throw new HubProtocolError("denied");
    const result = id ? (control.acknowledge(owner, id), { ok: true }) : control.read(owner, query);
    if (!owner.current()) throw new HubProtocolError("denied");
    send(res, 200, result);
  })().catch(error => {
    const code = error instanceof HubProtocolError ? error.code : "unavailable";
    const status = code === "invalid" ? 400 : ["denied", "revoked"].includes(code) ? 403 : code === "not-found" ? 404 : code === "conflict" ? 409 : code === "backpressure" ? 429 : 503;
    send(res, status, { error: code });
  });
  return true;
}
