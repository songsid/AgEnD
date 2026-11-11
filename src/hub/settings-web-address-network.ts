/** Only temporary TCP probes on explicit candidate interfaces. Never bind the existing member endpoint. */
import { checkHubListeners } from "./init/network.js";
import { hubPreviewSettings } from "./preview.js";
import { previewSettings, type PreviewWebConfig } from "../web-preview.js";
import { HubWebAddressError, type HubWebAddressCandidate } from "./settings-web-address-policy.js";
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
export async function probeHubWebAddress(rawFleet: unknown, candidate: HubWebAddressCandidate, running: boolean): Promise<void> {
    const fleet = obj(rawFleet), hub = obj(fleet.hub), member = hub.memberListen as {
        host: string;
        port: number;
    }, old = hub.webListen as {
        host: string;
        port: number;
    };
    const health = fleet.health_port ?? 19280;
    if (typeof health !== "number" || !Number.isInteger(health) || health < 0 || health > 65535)
        throw new HubWebAddressError("invalid");
    const fleetPreview = previewSettings(fleet.web as PreviewWebConfig | undefined, health);
    const reserved = [{ host: "127.0.0.1", port: health }, ...(fleetPreview.enabled && fleetPreview.port !== null ? [{ host: "127.0.0.1", port: fleetPreview.port }] : []), member];
    const preview = hubPreviewSettings({ web: hub.web, webOrigin: candidate.origin, memberOrigin: hub.memberOrigin as string, webListen: candidate.listen, memberListen: member });
    const endpoints = { webListen: candidate.listen, memberListen: preview ? { host: preview.host, port: preview.port } : member };
    const selected: ("web" | "member")[] = [];
    if (!running || old.host !== candidate.listen.host || old.port !== candidate.listen.port)
        selected.push("web");
    if (preview && (!running || old.host !== preview.host))
        selected.push("member");
    const problems = await checkHubListeners(endpoints, { reserved }, selected);
    if (problems.length)
        throw new HubWebAddressError(problems.some(p => p.reason === "occupied") ? "port_in_use" : problems.some(p => p.reason === "reserved") ? "port_conflict" : "invalid");
}
