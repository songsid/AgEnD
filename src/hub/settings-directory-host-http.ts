/** Fleet listener only. The host's own D3 session can repair AD without signing in through that directory. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HubInitHostOwner } from "./init/types.js";
import type { HubDirectorySettingsControl } from "./settings-directory-control.js";
import { directorySettingsRefusal } from "./settings-directory-http.js";
import { HubProtocolError, parseStrictJson } from "./validation.js";
import { readBoundedWebBody } from "../web-body.js";

export interface HubDirectoryHostSettingsHttpDeps {
  hubSetupSession?(req: IncomingMessage): HubInitHostOwner | null;
  hubDirectorySettings?(): Promise<HubDirectorySettingsControl>;
}
const prefix = "/api/settings/hub/directory";
function send(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    ...(status === 429 ? { "Retry-After": "10" } : {}) });
  res.end(JSON.stringify(value));
}
export function handleHubDirectoryHostSettingsHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: HubDirectoryHostSettingsHttpDeps): boolean {
  if (url.pathname !== prefix && !["/prepare", "/test", "/save", "/cancel", "/ca/inspect", "/ca/fetch"].some(action => url.pathname === prefix + action)) return false;
  if (!deps.hubSetupSession || !deps.hubDirectorySettings) { send(res, 404, { ok: false, code: "unavailable" }); return true; }
  let owner: HubInitHostOwner | null;
  try { owner = deps.hubSetupSession(req); } catch { owner = null; }
  if (!owner) { send(res, 403, { ok: false, code: "host_session_required" }); return true; }
  const action = url.pathname.slice(prefix.length);
  if (url.search || req.method !== (action ? "POST" : "GET")) {
    send(res, url.search ? 400 : 405, { ok: false, code: "invalid" }); return true;
  }
  const create = deps.hubDirectorySettings.bind(deps), ownerCurrent = owner.current.bind(owner);
  const abort = new AbortController();
  const closed = () => { if (!res.writableEnded) abort.abort(); };
  res.once("close", closed);
  const current = () => !abort.signal.aborted && ownerCurrent() === true;
  const context = { actor: { kind: "host-owner" as const, sessionId: owner.sessionId, requestId: owner.requestId }, current, signal: abort.signal };
  void (async () => {
    if (!current()) throw new HubProtocolError("revoked");
    let input: unknown;
    if (action) {
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" || req.headers["content-encoding"] !== undefined)
        throw new HubProtocolError("invalid");
      try { input = parseStrictJson(await readBoundedWebBody(req, 192 * 1024), 192 * 1024); }
      catch { throw new HubProtocolError("invalid"); }
    }
    if (!current()) throw new HubProtocolError("revoked");
    const control = await create();
    if (!current()) throw new HubProtocolError("revoked");
    const result = !action ? control.read(context) : action === "/prepare" ? await control.prepare(input, context)
      : action === "/test" ? await control.test(input, context) : action === "/cancel" ? control.cancel(input, context)
      : action === "/ca/inspect" ? await control.inspectCa(input, context) : action === "/ca/fetch" ? await control.fetchCa(input, context)
      : await control.apply(input, context); // The fleet listener survives the Hub remount; no Hub cookie or response transfer.
    if (!current()) throw new HubProtocolError("revoked");
    send(res, action === "/save" && "state" in result && result.state === "restored" ? 503 : 200, result);
  })().catch(error => {
    const refusal = directorySettingsRefusal(error);
    send(res, refusal.status, { ok: false, code: refusal.code });
  }).finally(() => { res.removeListener("close", closed); });
  return true;
}
