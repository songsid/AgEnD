/**
 * The readiness probe's way of seeing a tunnel the way a phone does.
 *
 * A brand-new `*.trycloudflare.com` name resolves instantly through a public
 * resolver and, on a corporate or WSL network, can take a minute or more
 * through the machine's own forwarder (measured: 1.1.1.1 in ~13 ms, the system
 * resolver 60 s+). Probing through the system resolver therefore reports a
 * tunnel that works as "never became reachable". So the probe asks a public
 * resolver, then connects to the address it was given with the real hostname
 * as SNI and `Host` — certificate verification still runs against the
 * hostname, so a wrong or forged answer yields a TLS failure, never a page.
 *
 * Only the probe does this. The browser that actually uses the tunnel resolves
 * however it resolves. The one thing that leaves the machine is a DNS query
 * for the tunnel's random hostname, sent to Cloudflare, who is already
 * carrying the tunnel.
 *
 * The system resolver stays as the fallback: a network that blocks outbound
 * DNS to 1.1.1.1 must not make a working tunnel look dead.
 */
import { isIPv4 } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { Resolver } from "node:dns/promises";

export const PUBLIC_RESOLVERS: readonly string[] = ["1.1.1.1", "1.0.0.1"];

/** One DNS attempt is short: the caller retries, and the whole probe has a deadline. */
const RESOLVE_TIMEOUT_MS = 3_000;
/** The probe wants a page, not a download. */
const MAX_PROBE_BODY = 256 * 1024;

export interface ProbeResponse { status: number; contentType: string; body: string }

export interface PublicFetchDeps {
  /** Public resolver addresses; empty disables the public path entirely. */
  resolvers?: readonly string[];
  /** Test seam: A records for a host. */
  resolve4?: (host: string) => Promise<string[]>;
  /** Test seam: the TLS request. */
  request?: typeof httpsRequest;
  /** What to do when the public path cannot answer (default: plain fetch through the system resolver). */
  fallback: (url: string, signal: AbortSignal) => Promise<ProbeResponse>;
}

/** Addresses a public resolver has no business returning for a Cloudflare edge name. */
export function isPublicIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number) as [number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;     // CGNAT
  if (a === 169 && b === 254) return false;               // link-local
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;                             // multicast / reserved
  return true;
}

function defaultResolve4(resolvers: readonly string[]): (host: string) => Promise<string[]> {
  const resolver = new Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 1 });
  resolver.setServers([...resolvers]);
  return host => resolver.resolve4(host);
}

export async function fetchViaPublicResolver(
  url: string,
  signal: AbortSignal,
  deps: PublicFetchDeps,
): Promise<ProbeResponse> {
  const resolvers = deps.resolvers ?? PUBLIC_RESOLVERS;
  let target: URL;
  try { target = new URL(url); } catch { return deps.fallback(url, signal); }
  if (resolvers.length === 0 || target.protocol !== "https:") return deps.fallback(url, signal);

  let address: string | undefined;
  try {
    const resolve4 = deps.resolve4 ?? defaultResolve4(resolvers);
    address = (await resolve4(target.hostname)).find(isPublicIPv4);
  } catch {
    address = undefined;
  }
  // No usable answer from the public resolver: say nothing about the tunnel,
  // just let the ordinary path try.
  if (!address) return deps.fallback(url, signal);
  return requestAt(address, target, signal, deps.request ?? httpsRequest);
}

function requestAt(address: string, target: URL, signal: AbortSignal, request: typeof httpsRequest): Promise<ProbeResponse> {
  return new Promise<ProbeResponse>((resolve, reject) => {
    const options: RequestOptions = {
      host: address,
      port: 443,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      // Both, and the hostname for both purposes: SNI picks the certificate,
      // `servername` is also what the certificate is verified against, and
      // `Host` is what the edge routes on. Never `rejectUnauthorized: false`.
      servername: target.hostname,
      headers: { host: target.hostname, "cache-control": "no-store" },
      signal,
    };
    const req = request(options, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PROBE_BODY) { req.destroy(new Error("probe response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        contentType: String(res.headers["content-type"] ?? ""),
        // Only a 200 can be the page; any other body is not looked at.
        body: res.statusCode === 200 ? Buffer.concat(chunks).toString("utf8") : "",
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
