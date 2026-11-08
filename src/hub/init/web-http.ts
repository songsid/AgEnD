/** Fleet listener only. Authority is obtained BEFORE importing/creating the Hub setup controller. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { HubInitHostOwner } from "./types.js";
import type { HubWebInitializer } from "./web.js";
import { HubWebInitError } from "./web-error.js";
import { parseStrictJson } from "../validation.js";
const prefix = "/api/settings/hub/setup";
const ref = z.string().regex(/^[A-Za-z0-9_-]{32}$/), withRef = z.strictObject({ ref });
export interface HubWebInitHttpDeps {
  hubSetupSession?(req: IncomingMessage): HubInitHostOwner | null;
  hubSetup?(): Promise<HubWebInitializer>;
}
function send(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded)
    return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" || req.headers["content-encoding"] !== undefined)
    throw new HubWebInitError("invalid");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Buffer);
    size += b.length;
    if (size > 192 * 1024) {
      req.resume();
      throw new HubWebInitError("invalid");
    }
    chunks.push(b);
  }
  try {
    return parseStrictJson(Buffer.concat(chunks), 192 * 1024);
  }
  catch {
    throw new HubWebInitError("invalid");
  }
}
export function handleHubWebInitHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: HubWebInitHttpDeps): boolean {
  const action = url.pathname.slice(prefix.length);
  if (!url.pathname.startsWith(prefix) || !["", "/prepare", "/test", "/commit", "/cancel", "/ca/inspect", "/ca/fetch"].includes(action))
    return false;
  if (!deps.hubSetup || !deps.hubSetupSession) {
    send(res, 404, { error: "unavailable" });
    return true;
  }
  const create = deps.hubSetup.bind(deps);
  let source: HubInitHostOwner | null;
  try {
    source = deps.hubSetupSession(req);
  }
  catch {
    source = null;
  }
  if (!source) {
    send(res, 403, { error: "host_session_required" });
    return true;
  }
  if (url.search || req.method !== (action ? "POST" : "GET")) {
    send(res, url.search ? 400 : 405, { error: "invalid" });
    return true;
  }
  let disconnected = false;
  res.once("close", () => { if (!res.writableEnded)
    disconnected = true; });
  const owner: HubInitHostOwner = { ...source, current: () => !disconnected && source.current() };
  void (async () => {
    if (!owner.current())
      throw new HubWebInitError("denied");
    const input = action ? await body(req) : undefined;
    if (!owner.current())
      throw new HubWebInitError("denied");
    const control = await create();
    if (!owner.current())
      throw new HubWebInitError("denied");
    let result: unknown;
    if (!action)
      result = await control.inspect(owner);
    else if (action === "/prepare")
      result = await control.prepare(input, owner);
    else if (action === "/test")
      result = await control.test(withRef.parse(input).ref, owner);
    else if (action === "/commit")
      result = await control.commit(withRef.parse(input).ref, owner);
    else if (action === "/cancel") {
      control.cancel(withRef.parse(input).ref, owner);
      result = { ok: true };
    }
    else if (action === "/ca/inspect") {
      const b = z.strictObject({ url: z.string().min(1).max(2048) }).parse(input);
      result = await control.inspectCa(b.url, owner);
    }
    else {
      const b = z.strictObject({ ref, fingerprint: z.string().min(1).max(95), bindDn: z.string().min(1).max(1024).optional(), bindPassword: z.string().min(1).max(4096).optional() })
        .refine(b => (b.bindDn === undefined) === (b.bindPassword === undefined)).parse(input);
      result = await control.fetchCa(b.ref, b.fingerprint, owner, b.bindDn && b.bindPassword ? { bindDn: b.bindDn, password: b.bindPassword } : undefined);
    }
    send(res, 200, result);
  })().catch(error => {
    const code = error instanceof HubWebInitError ? error.code : error instanceof z.ZodError ? "invalid" : "unavailable";
    const status = code === "invalid" ? 400 : code === "denied" || code === "trust" ? 403 : code === "expired" ? 410 : ["stale", "busy", "initialized", "incomplete"].includes(code) ? 409 : 503;
    send(res, status, { error: code });
  });
  return true;
}
