/**
 * Unauthenticated, read-only delivery of the Windows Runtime installer:
 *   GET /runtime/install.ps1             the installer script, stamped with this server's runtime version and bundle SHA-256
 *   GET /runtime/v1/bundle/windows.zip   the same createRuntimeBundle() archive Settings offers as a download
 *   GET /runtime/v1/bundle/windows.json  the version, SHA-256 and size of that exact cached archive
 * These files are static for a given server version: the bundle is built once and kept, and the script is that bundle's
 * version and SHA-256 stamped into a fixed template. The script is built once as bytes and those exact bytes are what every
 * request receives (no newline rewriting, no compression, no per-request text), so the SHA-256 that Settings shows for it is
 * the hash of what is sent: the copied command downloads the script, checks that hash and only then runs it, so the check
 * does not depend on the TLS trust decision. The script in turn pins the bundle's hash. Nothing in a response depends on
 * the request (no Host header, query, cookie or caller), and nothing in it is a credential, pairing code, profile, user data
 * or server address: the page's command hands the server address to the script.
 * They are served only while runtimes.remote_runtime is on (otherwise they answer 404), never through a public gateway link
 * (404 there too), only over loopback or TLS (the installer must not travel over plain LAN HTTP), rate limited per client
 * address with a small burst, and never larger than the bundle's own cap.
 * Pairing stays exactly as it was: nothing here creates, accepts or approves a pairing.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRuntimeBundle, RUNTIME_MAX_ARCHIVE_BYTES, type RuntimeBundle } from "./runtime-bundle.js";
import { remoteRuntimeEnabled } from "./runtime-switches.js";
import { gatewayRequestContext } from "./web-request-context.js";

export const RUNTIME_INSTALL_SCRIPT_PATH = "/runtime/install.ps1";
export const RUNTIME_BUNDLE_PATH = "/runtime/v1/bundle/windows.zip";
export const RUNTIME_BUNDLE_METADATA_PATH = "/runtime/v1/bundle/windows.json";
/** Replaced in the template with values that were validated first; the script holds no other server-supplied text. */
export const RUNTIME_INSTALL_VERSION_TOKEN = "@@AGEND_RUNTIME_VERSION@@";
export const RUNTIME_INSTALL_SHA256_TOKEN = "@@AGEND_RUNTIME_SHA256@@";
export const RUNTIME_INSTALL_MAX_SCRIPT_BYTES = 64 * 1024;
/**
 * Token buckets: a person re-running an installer, not a crawler. Each client address may burst a few requests, then is held to the
 * refill rate; everything together is bounded too, because a reverse proxy makes every client look like one address.
 */
const LIMITS = {
  script: { burst: 10, perMinute: 30 },
  bundle: { burst: 4, perMinute: 12 },
  total: { burst: 60, perMinute: 240 },
  metadata: { burst: 20, perMinute: 120 },
  metadataTotal: { burst: 240, perMinute: 1200 },
} as const;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/, SHA256 = /^[a-f0-9]{64}$/;

function defaultTemplate(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "runtime-install", "install.ps1");
  const bytes = readFileSync(file);
  if (bytes.length > RUNTIME_INSTALL_MAX_SCRIPT_BYTES) throw new Error("Runtime installer script is too large");
  return bytes.toString("utf8");
}
/** Stamps the validated version and bundle hash into the template; an unvalidated value never reaches the script. */
export function renderRuntimeInstallScript(template: string, bundle: Pick<RuntimeBundle, "version" | "sha256">): string {
  if (!VERSION.test(bundle.version) || !SHA256.test(bundle.sha256)) throw new Error("Invalid runtime bundle identity");
  if (!template.includes(RUNTIME_INSTALL_VERSION_TOKEN) || !template.includes(RUNTIME_INSTALL_SHA256_TOKEN)) throw new Error("Runtime installer template has no placeholders");
  const script = template.replaceAll(RUNTIME_INSTALL_VERSION_TOKEN, bundle.version).replaceAll(RUNTIME_INSTALL_SHA256_TOKEN, bundle.sha256);
  if (/@@AGEND_RUNTIME_/.test(script) || Buffer.byteLength(script) > RUNTIME_INSTALL_MAX_SCRIPT_BYTES) throw new Error("Runtime installer script is invalid");
  return script;
}
const loopback = (address: string | undefined): boolean => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function protectedTransport(req: IncomingMessage): boolean {
  return loopback(req.socket.remoteAddress) || (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true;
}
function answer(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export interface RuntimeInstallOptions {
  /** Tests substitute fixtures; production builds the real bundle from this installation's compiled modules. */
  bundle?: () => RuntimeBundle;
  template?: () => string;
  now?: () => number;
}
/** What is served for the life of this server process: the generic bundle, its metadata and the script that pins its hash. */
interface RuntimeInstallFiles { bundle: RuntimeBundle; metadata: Buffer; script: Buffer; scriptSha256: string; etag: string }
/** What the dashboard shows an administrator so the copied command can pin the script. */
export interface RuntimeInstallerInfo { version: string; scriptSha256: string; scriptBytes: number; bundleSha256: string }
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export class RuntimeInstallService {
  private readonly buckets = new Map<string, { tokens: number; at: number; burst: number; perMs: number }>();
  private files: RuntimeInstallFiles | undefined;
  constructor(private readonly options: RuntimeInstallOptions = {}) {}
  /** Tokens a bucket holds right now. One nobody has used holds its whole burst, and holds no table row. */
  private tokens(key: string, limit: { burst: number }, now: number): number {
    const row = this.buckets.get(key);
    return row ? Math.min(row.burst, row.tokens + Math.max(0, now - row.at) * row.perMs) : limit.burst;
  }
  private spend(key: string, limit: { burst: number; perMinute: number }, now: number): void {
    const perMs = limit.perMinute / 60_000, row = this.buckets.get(key) ?? { tokens: limit.burst, at: now, burst: limit.burst, perMs };
    row.tokens = Math.min(row.burst, row.tokens + Math.max(0, now - row.at) * row.perMs) - 1; row.at = now;
    this.buckets.set(key, row);
  }
  /**
   * The address's own bucket is asked first. A request it refuses costs the total nothing, so one address that hammers a route is held by
   * its own bucket and cannot drain what everyone else shares. Only a request that bucket admits is charged to the total, and only then are
   * both spent. A bucket that has refilled to full is forgotten, and a row is only created by an admitted request, so the table stays small
   * without a cap.
   */
  private admit(peerKey: string, peerLimit: { burst: number; perMinute: number }, metadata = false): boolean {
    const now = (this.options.now ?? Date.now)();
    for (const [id, row] of this.buckets) if (row.tokens + (now - row.at) * row.perMs >= row.burst) this.buckets.delete(id);
    const totalKey = metadata ? "metadataTotal" : "total", totalLimit = metadata ? LIMITS.metadataTotal : LIMITS.total;
    if (this.tokens(peerKey, peerLimit, now) < 1 || this.tokens(totalKey, totalLimit, now) < 1) return false;
    this.spend(totalKey, totalLimit, now); this.spend(peerKey, peerLimit, now);
    return true;
  }
  /**
   * Built on first use and kept: a server version has one generic bundle, so the hash the script pins stays the hash of the
   * archive every later request receives, and one script, so the hash Settings shows is the hash of every script sent. A
   * failure is not remembered; the next request tries again (under the rate limit).
   */
  private build(): RuntimeInstallFiles {
    if (this.files) return this.files;
    const bundle = (this.options.bundle ?? createRuntimeBundle)();
    if (!bundle.bytes.length || bundle.bytes.length > RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("Runtime bundle exceeded its archive size limit");
    const script = Buffer.from(renderRuntimeInstallScript((this.options.template ?? defaultTemplate)(), bundle), "utf8");
    const metadata = Buffer.from(JSON.stringify({ version: bundle.version, sha256: bundle.sha256, bytes: bundle.bytes.length }) + "\n");
    return this.files = { bundle, metadata, script, scriptSha256: sha256(script), etag: `"${bundle.version}-${bundle.sha256}"` };
  }
  /** For the local administrator's dashboard. Throws when the installer cannot be built on this host. */
  installer(): RuntimeInstallerInfo {
    const { bundle, script, scriptSha256 } = this.build();
    return { version: bundle.version, scriptSha256, scriptBytes: script.length, bundleSha256: bundle.sha256 };
  }
  /** True for an install/metadata route (404 while off); false leaves every other path to the normal gate. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const isScript = url.pathname === RUNTIME_INSTALL_SCRIPT_PATH;
    const isMetadata = url.pathname === RUNTIME_BUNDLE_METADATA_PATH;
    if (!isScript && !isMetadata && url.pathname !== RUNTIME_BUNDLE_PATH) return false;
    // Off, or reached through a public gateway link: these routes do not exist there. 404 is the same answer as any
    // unknown route, and it does not reveal whether remote runtimes are configured. No bundle is built for it.
    if (!remoteRuntimeEnabled() || gatewayRequestContext(req)) { answer(res, 404, { error: "Not found" }); return true; }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") { answer(res, 405, { error: "Runtime installer files are read-only" }, { Allow: "GET, HEAD" }); return true; }
    if (url.search) { answer(res, 400, { error: "Runtime installer files do not accept options" }); return true; }
    if (!protectedTransport(req)) { answer(res, 403, { error: "The Runtime installer is served only over HTTPS or localhost" }); return true; }
    // Polling has a cheaper, independent allowance. HEAD/304 still spend it; polling cannot starve an actual install.
    const peer = req.socket.remoteAddress ?? "unknown", kind = isMetadata ? "metadata" : isScript ? "script" : "bundle";
    if (!this.admit(`${kind}:${peer}`, LIMITS[kind], isMetadata)) {
      answer(res, 429, { error: "Too many Runtime installer requests. Wait a minute and try again." }, { "Retry-After": "30" }); return true;
    }
    try {
      const { bundle, metadata, script, etag } = this.build();
      const common = { "X-Content-Type-Options": "nosniff" };
      if (isScript) {
        // never cached anywhere: a stale script would not match the hash the page shows
        res.writeHead(200, { ...common, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Content-Length": script.length });
        res.end(method === "HEAD" ? undefined : script);
      } else if ((req.headers["if-none-match"] ?? "").split(",").some(tag => tag.trim() === etag)) {
        // The archive is immutable for this server version, so a client may ask whether its copy is still current. The installer
        // still verifies the SHA-256 pinned in the script, so a cached copy is never trusted on its own.
        res.writeHead(304, { ...common, "Cache-Control": "no-cache", ETag: etag }); res.end();
      } else {
        const bytes = isMetadata ? metadata : bundle.bytes;
        res.writeHead(200, { ...common, "Cache-Control": "no-cache", ETag: etag,
          "Content-Type": isMetadata ? "application/json; charset=utf-8" : "application/zip",
          ...(isMetadata ? {} : { "Content-Disposition": `attachment; filename="${bundle.filename}"`, "X-Agend-SHA256": bundle.sha256 }),
          "Content-Length": bytes.length });
        res.end(method === "HEAD" ? undefined : bytes);
      }
    } catch {
      answer(res, 503, { error: "The Windows Runtime installer is unavailable on this host. Update or reinstall AgEnD and retry." });
    }
    return true;
  }
}
