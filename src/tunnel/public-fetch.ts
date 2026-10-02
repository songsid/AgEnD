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
/** The probe wants a page, not a download. Exactly this many bytes are accepted; one more is refused. */
export const MAX_PROBE_BODY = 256 * 1024;

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
      const status = res.statusCode ?? 0;
      const contentType = String(res.headers["content-type"] ?? "");
      res.on("error", reject);
      // Only a 200 can be the page. Any other body is discarded as it arrives, not collected.
      if (status !== 200) {
        res.on("end", () => resolve({ status, contentType, body: "" }));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PROBE_BODY) { req.destroy(new Error("probe response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * The ordinary path — the system resolver, a plain `fetch` — with the same limits as the public one.
 *
 * `res.text()` has no ceiling, and this is the path taken exactly when public DNS is unavailable, so the
 * cap has to live here too. A redirect is not this page, and following one would let the edge decide
 * what we call ready.
 */
export async function fetchViaSystemResolver(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResponse> {
  const res = await fetchImpl(url, { signal, redirect: "manual", cache: "no-store" });
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => { /* nothing to read */ });
    return { status: res.status, contentType, body: "" };
  }
  return { status: 200, contentType, body: await readBoundedText(res.body) };
}

async function readBoundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROBE_BODY) throw new Error("probe response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { /* already finished */ });
  }
  return Buffer.concat(chunks).toString("utf8");
}
