/** Init preflight only: temporary TCP binds, no HTTP, TLS, directory calls or firewall changes. */
import { lookup } from "node:dns/promises";
import { createServer, isIP, type Server } from "node:net";
import { join } from "node:path";
import { loadRawFleetConfig } from "../../config.js";
import { previewSettings, type PreviewWebConfig } from "../../web-preview.js";
import { listenProblems } from "./initializer.js";
import type { HubInitPlan, HubListen } from "./types.js";

export type HubInitListeners = Pick<HubInitPlan, "webListen" | "memberListen">;
export type HubNetworkReason = "invalid" | "unresolved" | "interface" | "occupied" | "permission" | "reserved" | "unavailable";
export interface HubNetworkProblem { listener: "web" | "member"; reason: HubNetworkReason }
export type HubNetworkCheck = (listeners: HubInitListeners) => Promise<HubNetworkProblem[]>;

export interface HubNetworkOptions {
  /** The daemon's own loopback dashboard/preview listeners, even before it starts. */
  reserved?: readonly HubListen[];
  /** DNS seam: tests never resolve an external name. Numeric listener IPs do not use DNS. */
  resolve?: (host: string) => Promise<string>;
}

async function address(host: string, resolve: (host: string) => Promise<string>): Promise<string> {
  if (isIP(host)) return host;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([resolve(host), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("lookup deadline")), 2000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const unspecified = (host: string) => host === "0.0.0.0" || (isIP(host) === 6 && /^[:0]+$/.test(host.split("%")[0]!));
function mapped(host: string): string {
  if (isIP(host) !== 6) return host;
  try {
    const canonical = new URL(`http://[${host}]/`).hostname;
    return canonical === "[::ffff:7f00:1]" ? "127.0.0.1" : canonical;
  } catch { return host; }
}

/** Refresh config at each preflight; the Hub also starts the daemon's existing local dashboard/preview. */
export async function checkHubInitNetworkForHome(home: string, listeners: HubInitListeners): Promise<HubNetworkProblem[]> {
  const config = loadRawFleetConfig(join(home, "fleet.yaml"));
  const health = config.health_port ?? 19280;
  if (typeof health !== "number" || !Number.isInteger(health) || health < 0 || health > 65535) throw Error("invalid local dashboard port");
  const preview = previewSettings(config.web as PreviewWebConfig | undefined, health);
  const reserved: HubListen[] = [{ host: "127.0.0.1", port: health }];
  if (preview.enabled && preview.port !== null) reserved.push({ host: "127.0.0.1", port: preview.port });
  return checkHubInitNetwork(listeners, { reserved });
}

/** Hold both sockets together to detect alias conflicts; close every successful bind before returning. */
export async function checkHubInitNetwork(listeners: HubInitListeners, options: HubNetworkOptions = {}): Promise<HubNetworkProblem[]> {
  const servers: Server[] = [];
  let active: "web" | "member" = "web";
  const problems: HubNetworkProblem[] = [];
  try {
    for (const listener of ["web", "member"] as const) {
      active = listener;
      const input = listeners[`${listener}Listen`];
      if (listenProblems("listener", input).length) { problems.push({ listener, reason: "invalid" }); break; }
      let host: string;
      try { host = await address(input.host, options.resolve ?? (async name => (await lookup(name)).address)); }
      catch { problems.push({ listener, reason: "unresolved" }); break; }
      if (!isIP(host) || unspecified(host)) { problems.push({ listener, reason: "invalid" }); break; }
      if (options.reserved?.some(r => r.port === input.port && mapped(r.host) === mapped(host))) {
        problems.push({ listener, reason: "reserved" }); break;
      }
      const server = createServer(socket => socket.destroy());
      servers.push(server);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port: input.port, exclusive: true }, resolve);
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        const reason = code === "EADDRINUSE" ? "occupied" : code === "EADDRNOTAVAIL" ? "interface"
          : code === "EACCES" || code === "EPERM" ? "permission" : "unavailable";
        problems.push({ listener, reason }); break;
      }
    }
  } finally {
    for (const server of servers.reverse()) {
      if (server.listening) await new Promise<void>(resolve => server.close(err => {
        if (err) problems.push({ listener: active, reason: "unavailable" });
        resolve();
      }));
    }
  }
  return problems;
}
