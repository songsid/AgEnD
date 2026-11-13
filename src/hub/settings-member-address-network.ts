/** Temporary probe of the candidate member bind only; browser listeners and previews are never stopped. */
import { checkHubListeners } from "./init/network.js";
import { hubPreviewSettings } from "./preview.js";
import { previewSettings, type PreviewWebConfig } from "../web-preview.js";
import { HubMemberAddressError, type HubMemberAddressCandidate } from "./settings-member-address-policy.js";
const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
export async function probeHubMemberAddress(rawFleet: unknown, candidate: HubMemberAddressCandidate, running: boolean): Promise<void> {
  const fleet = obj(rawFleet), hub = obj(fleet.hub), web = hub.webListen as { host: string; port: number }, old = hub.memberListen as { host: string; port: number };
  const health = fleet.health_port ?? 19280;
  if (typeof health !== "number" || !Number.isInteger(health) || health < 0 || health > 65535) throw new HubMemberAddressError("invalid");
  const fleetPreview = previewSettings(fleet.web as PreviewWebConfig | undefined, health);
  const hubPreview = hubPreviewSettings({ web: hub.web, webOrigin: hub.webOrigin as string, memberOrigin: candidate.origin, webListen: web, memberListen: candidate.listen });
  const reserved = [web, { host: "127.0.0.1", port: health }, ...(fleetPreview.enabled && fleetPreview.port !== null ? [{ host: "127.0.0.1", port: fleetPreview.port }] : []), ...(hubPreview ? [{ host: hubPreview.host, port: hubPreview.port }] : [])];
  if (reserved.some(r => r.port === candidate.listen.port)) throw new HubMemberAddressError("port_conflict");
  const selected = !running || old.host !== candidate.listen.host || old.port !== candidate.listen.port ? ["member" as const] : [];
  const problems = await checkHubListeners({ webListen: web, memberListen: candidate.listen }, { reserved }, selected);
  if (problems.length) throw new HubMemberAddressError(problems.some(p => p.reason === "occupied") ? "port_in_use" : problems.some(p => p.reason === "reserved") ? "port_conflict" : "invalid");
}
