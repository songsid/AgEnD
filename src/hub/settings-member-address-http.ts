/** Fleet-origin host-owner D3 surface. No Hub-directory-admin, header token, guest or public-link substitute. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { HubInitHostOwner } from "./init/types.js";
import { readBoundedWebBody } from "../web-body.js";
import { parseStrictJson } from "./validation.js";
import { HubMemberAddressError } from "./settings-member-address-policy.js";
import type { HubMemberAddressControl } from "./settings-member-address-control.js";
export interface HubMemberAddressHttpDeps {
    hubSetupSession?(req: IncomingMessage): HubInitHostOwner | null;
    hubMemberAddress?(): Promise<HubMemberAddressControl>;
}
const prefix = "/api/settings/hub/member-address";
function send(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed || res.writableEnded)
        return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(JSON.stringify(body));
}
export function handleHubMemberAddressHttp(req: IncomingMessage, res: ServerResponse, url: URL, deps: HubMemberAddressHttpDeps): boolean {
    const noticeAck = new RegExp("^" + prefix + "/notices/([0-9a-f-]{36})/ack$").exec(url.pathname);
    if (![prefix, prefix + "/prepare", prefix + "/commit", prefix + "/notices"].includes(url.pathname) && !noticeAck)
        return false;
    if (!deps.hubSetupSession || !deps.hubMemberAddress) {
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
    const list = action === "/notices", before = url.searchParams.get("before");
    if ((!list && url.search) || (list && ([...url.searchParams.keys()].some(k => k !== "before") || url.searchParams.getAll("before").length > 1
        || before !== null && !/^[1-9][0-9]{0,15}$/.test(before))) || req.method !== (list || !action ? "GET" : "POST")) {
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
            throw new HubMemberAddressError("denied");
        let input: unknown;
        if (action && !list && !noticeAck) {
            if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" || req.headers["content-encoding"] !== undefined)
                throw new HubMemberAddressError("invalid");
            try {
                input = parseStrictJson(await readBoundedWebBody(req, 4096), 4096);
            }
            catch {
                throw new HubMemberAddressError("invalid");
            }
        }
        if (!current())
            throw new HubMemberAddressError("denied");
        const control = await deps.hubMemberAddress!();
        if (!current())
            throw new HubMemberAddressError("denied");
        const result = !action ? await control.read(ctx) : list ? await control.notices(ctx, before === null ? undefined : Number(before))
            : noticeAck ? await control.acknowledge(noticeAck[1]!, ctx) : action === "/prepare" ? await control.prepare(input, ctx) : await control.commit(input, ctx);
        if (!current())
            throw new HubMemberAddressError("denied");
        send(res, 200, result);
    })().catch(error => {
        const code = error instanceof HubMemberAddressError ? error.code : error instanceof z.ZodError ? "invalid" : "unavailable";
        const status = code === "denied" ? 403 : code === "expired" ? 410 : ["invalid", "certificate"].includes(code) ? 400 : ["stale", "busy", "joining", "port_conflict", "port_in_use", "unchanged"].includes(code) ? 409 : 503;
        const retry = error instanceof HubMemberAddressError && code === "joining" && Number.isSafeInteger(error.retryAt) && error.retryAt! > 0 ? { retryAt: error.retryAt } : {};
        send(res, status, { ok: false, code, ...retry });
    });
    return true;
}
