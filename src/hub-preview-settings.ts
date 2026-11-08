/**
 * M-2682 part B: fleet Settings → Hub → "HTML previews on this Hub" — the host owner switches the Hub's preview listener on
 * or off and picks its port, instead of editing hub.web.preview_port in fleet.yaml (721ca0c3).
 *
 * hub.web.preview_port is outside the Hub's sealed digest (hub/preview.ts: a local setting, part of the runtime's reload key),
 * so this is the ordinary single-file save — no reseal — through the fleet's synchronous writer, which is the same
 * serialization the sealed-settings writer commits under. While that writer has an unfinished commit, this waits (busy).
 *
 * Checks before saving (conflicts): the Hub's own rule (an integer 1–65535, not the Hub's web or member listener or origin
 * port), not this fleet's dashboard (health_port) or its own preview port, and free to listen on now on the Hub's web host.
 */
import { createServer } from "node:net";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface HubPreviewSettingsView {
  /** This fleet runs a Hub (hub.enabled is true): the card applies. */
  hosted: boolean;
  enabled: boolean;
  port: number | null;
  /** A port to offer when switching on: the Hub's web listener port + 1 when that is usable, else null. */
  suggested: number | null;
}
export type HubPreviewRefusal = "not_hosted" | "invalid_port" | "port_conflict" | "port_in_use" | "busy";

function fleetPorts(raw: Record<string, unknown>): number[] {
  const health = typeof raw.health_port === "number" ? raw.health_port : 19280;   // the fleet's default (cli.ts)
  const web = obj(raw.web), preview = typeof web.preview_port === "number" ? web.preview_port : health + 1;
  return [health, ...(web.preview === false ? [] : [preview])];
}

export function hubPreviewSettingsView(rawConfig: unknown): HubPreviewSettingsView {
  const raw = obj(rawConfig), hub = obj(raw.hub), web = obj(hub.web);
  const hosted = hub.enabled === true;
  const port = typeof web.preview_port === "number" ? web.preview_port : null;
  const webPort = typeof obj(hub.webListen).port === "number" ? (obj(hub.webListen).port as number) : null;
  const memberPort = typeof obj(hub.memberListen).port === "number" ? (obj(hub.memberListen).port as number) : null;
  const next = webPort !== null && webPort < 65535 ? webPort + 1 : null;
  const suggested = next !== null && next !== memberPort && !fleetPorts(raw).includes(next) ? next : null;
  return { hosted, enabled: port !== null, port, suggested };
}

/** Can a listener bind host:port right now? (Closed at once; never left open.) */
export function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/**
 * The patch for a requested state, or why not. `enabled: false` removes the key (previews off). Pure apart from the bind
 * check, which runs only when the port changes.
 */
export async function hubPreviewPatch(rawConfig: unknown, body: unknown, opts: { busy?: () => boolean; free?: (host: string, port: number) => Promise<boolean> } = {}):
  Promise<{ patch: { path: string[]; value?: unknown; remove?: true } } | { refused: HubPreviewRefusal }> {
  const raw = obj(rawConfig), hub = obj(raw.hub), b = obj(body);
  if (hub.enabled !== true) return { refused: "not_hosted" };
  if (opts.busy?.()) return { refused: "busy" };
  if (b.enabled === false) return { patch: { path: ["hub", "web", "preview_port"], remove: true } };
  if (b.enabled !== true) return { refused: "invalid_port" };
  const port = b.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return { refused: "invalid_port" };
  // The Hub's own rule, exactly as the mount will apply it (a refusal there would hold the Hub).
  const { hubPreviewSettings } = await import("./hub/preview.js");
  try {
    hubPreviewSettings({ web: { ...obj(hub.web), preview_port: port }, webOrigin: String(hub.webOrigin), memberOrigin: String(hub.memberOrigin),
      webListen: { host: String(obj(hub.webListen).host), port: Number(obj(hub.webListen).port) },
      memberListen: { host: String(obj(hub.memberListen).host), port: Number(obj(hub.memberListen).port) } });
  } catch { return { refused: "port_conflict" }; }
  if (fleetPorts(raw).includes(port)) return { refused: "port_conflict" };
  const current = obj(hub.web).preview_port;
  if (current !== port && !(await (opts.free ?? portFree)(String(obj(hub.webListen).host), port))) return { refused: "port_in_use" };
  return { patch: { path: ["hub", "web", "preview_port"], value: port } };
}
