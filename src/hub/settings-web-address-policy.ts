/** #3428: one closed candidate for the web listener; no member, directory or identity fields. */
import { z } from "zod";
import { listenProblems, originProblems } from "./init/initializer.js";
import { hubPreviewSettings } from "./preview.js";
export class HubWebAddressError extends Error {
    constructor(readonly code: "invalid" | "port_conflict" | "port_in_use" | "certificate" | "unavailable" | "stale" | "denied" | "busy" | "expired" | "unchanged" | "recovery") {
        super(code);
        this.name = "HubWebAddressError";
    }
}
const listen = z.strictObject({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535) });
const certificate = z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("keep") }),
    z.strictObject({ mode: z.literal("generate") }),
    z.strictObject({ mode: z.literal("import"), certPem: z.string().min(1).max(65536), keyPem: z.string().min(1).max(16384) }),
]);
const candidate = z.strictObject({ origin: z.string().min(1).max(2048), listen, certificate });
export type HubWebAddressCandidate = z.infer<typeof candidate>;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Only this boundary is retained across later legitimate rename/directory/certificate-selector operations. */
export function hubWebAddressBoundary(value: unknown): Record<string, unknown> {
    const hub = obj(value);
    return { webOrigin: hub.webOrigin, webListen: hub.webListen, webTls: hub.webTls, webAddress: hub.webAddress };
}
export function parseHubWebAddressCandidate(raw: unknown, currentHub: unknown): HubWebAddressCandidate {
    const parsed = candidate.safeParse(raw);
    if (!parsed.success)
        throw new HubWebAddressError("invalid");
    const p = parsed.data, hub = obj(currentHub), member = listen.safeParse(hub.memberListen);
    if (originProblems("webOrigin", p.origin).length || new URL(p.origin).hostname.endsWith(".")
        || listenProblems("webListen", p.listen).length || !member.success || typeof hub.memberOrigin !== "string")
        throw new HubWebAddressError("invalid");
    p.origin = new URL(p.origin).origin;
    // Reserve the port even through a DNS alias. The initializer/preview policy already forbids sharing these ports.
    if (p.origin === new URL(hub.memberOrigin).origin || p.listen.port === member.data.port)
        throw new HubWebAddressError("port_conflict");
    try {
        hubPreviewSettings({ web: hub.web, webOrigin: p.origin, memberOrigin: hub.memberOrigin,
            webListen: p.listen, memberListen: member.data });
    }
    catch {
        throw new HubWebAddressError("port_conflict");
    }
    return p;
}
