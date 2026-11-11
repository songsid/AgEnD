/** Fleet-origin host-owner D3 surface. No Hub-directory-admin, header token, guest or public-link substitute. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { HubInitHostOwner } from "./init/types.js";
import { readBoundedWebBody } from "../web-body.js";
import { parseStrictJson } from "./validation.js";
import { HubWebAddressError } from "./settings-web-address-policy.js";
import type { HubWebAddressControl } from "./settings-web-address-control.js";
export interface HubWebAddressHttpDeps {
    hubSetupSession?(req: IncomingMessage): HubInitHostOwner | null;
    hubWebAddress?(): Promise<HubWebAddressControl>;
}
const prefix = "/api/settings/hub/web-address";
function send(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed || res.writableEnded)
        return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(JSON.stringify(body));
}
export function handleHubWebAddressHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: HubWebAddressHttpDeps): boolean {
    if (![prefix, prefix + "/prepare", prefix + "/commit"].includes(url.pathname))
        return false;
    if (!deps.hubSetupSession || !deps.hubWebAddress) {
        send(res, 404, { ok: false, code: "unavailable" });
        return true;
    }
    let owner: HubInitHostOwner | null;
    try {
        owner = deps.hubSetupSession(req);
    }
    catch {
        owner = null;
    }
    if (!owner) {
        send(res, 403, { ok: false, code: "host_session_required" });
        return true;
    }
    const action = url.pathname.slice(prefix.length);
    if (url.search || req.method !== (action ? "POST" : "GET")) {
        send(res, 400, { ok: false, code: "invalid" });
        return true;
    }
    const source = owner;
    let closed = false;
    res.once("close", () => {
        if (!res.writableEnded)
            closed = true;
    });
    const current = () => !closed && source.current() === true;
    const ctx = { actor: { kind: "host-owner" as const, sessionId: source.sessionId, requestId: source.requestId },
        ownerKey: source.ownerKey, authorityEpoch: source.authorityEpoch, current };
    void (async () => {
        if (!current())
            throw new HubWebAddressError("denied");
        let input: unknown;
        if (action) {
            if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" || req.headers["content-encoding"] !== undefined)
                throw new HubWebAddressError("invalid");
            try {
                input = parseStrictJson(await readBoundedWebBody(req, 192 * 1024), 192 * 1024);
            }
            catch {
                throw new HubWebAddressError("invalid");
            }
        }
        if (!current())
            throw new HubWebAddressError("denied");
        const control = await deps.hubWebAddress!();
        if (!current())
            throw new HubWebAddressError("denied");
        const result = !action ? await control.read(ctx) : action === "/prepare" ? await control.prepare(input, ctx) : await control.commit(input, ctx);
        if (!current())
            throw new HubWebAddressError("denied");
        send(res, 200, result);
    })().catch(error => {
        const code = error instanceof HubWebAddressError ? error.code : error instanceof z.ZodError ? "invalid" : "unavailable";
        const status = code === "denied" ? 403 : code === "expired" ? 410 : ["invalid", "certificate"].includes(code) ? 400 : ["stale", "busy", "port_conflict", "port_in_use", "unchanged"].includes(code) ? 409 : 503;
        send(res, status, { ok: false, code });
    });
    return true;
}
