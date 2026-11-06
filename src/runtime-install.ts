/**
 * Unauthenticated, read-only delivery of the Windows Runtime installer:
 *   GET /runtime/install.ps1             the installer script, stamped with this server's runtime version and bundle SHA-256
 *   GET /runtime/v1/bundle/windows.zip   the same createRuntimeBundle() archive Settings offers as a download
 * Both are static for a given server version: the bundle is built once and kept, and the script is that bundle's
 * version and SHA-256 stamped into a fixed template. Nothing in the response depends on the request (no Host header,
 * query, cookie or caller), and nothing in it is a credential, pairing code, profile, user data or server address:
 * the page's command hands the server address to the script.
 * They are served only while runtimes.remote_runtime is on (otherwise both answer 404), never through a public gateway link
 * (404 there too), only over loopback or TLS (the installer must not travel over plain LAN HTTP), rate limited, and never larger than the bundle's own cap.
 * The script pins the bundle's SHA-256 inside itself, not from the response that delivers the archive.
 * Pairing stays exactly as it was: nothing here creates, accepts or approves a pairing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRuntimeBundle, RUNTIME_MAX_ARCHIVE_BYTES, type RuntimeBundle } from "./runtime-bundle.js";
import { remoteRuntimeEnabled } from "./runtime-switches.js";
import { gatewayRequestContext } from "./web-request-context.js";

export const RUNTIME_INSTALL_SCRIPT_PATH = "/runtime/install.ps1";
export const RUNTIME_BUNDLE_PATH = "/runtime/v1/bundle/windows.zip";
/** Replaced in the template with values that were validated first; the script holds no other server-supplied text. */
export const RUNTIME_INSTALL_VERSION_TOKEN = "@@AGEND_RUNTIME_VERSION@@";
export const RUNTIME_INSTALL_SHA256_TOKEN = "@@AGEND_RUNTIME_SHA256@@";
export const RUNTIME_INSTALL_MAX_SCRIPT_BYTES = 64 * 1024;
/** Per peer address and per minute: a person re-running an installer, not a crawler. A reverse proxy shares one address, so the total below also bounds it. */
const SCRIPT_PER_PEER = 30, BUNDLE_PER_PEER = 12, TOTAL_PER_MINUTE = 120, WINDOW_MS = 60_000;
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
/** What is served for the life of this server process: the generic bundle and the script that pins its hash. */
interface RuntimeInstallFiles { bundle: RuntimeBundle; script: Buffer }
export class RuntimeInstallService {
  private readonly limits = new Map<string, { count: number; until: number }>();
  private files: RuntimeInstallFiles | undefined;
  constructor(private readonly options: RuntimeInstallOptions = {}) {}
  /** The total is charged first, so at most TOTAL_PER_MINUTE keys are ever created per window and expired ones are dropped here: the table stays small without a cap. */
  private charge(key: string, limit: number): boolean {
    const now = (this.options.now ?? Date.now)();
    for (const [id, row] of this.limits) if (row.until <= now) this.limits.delete(id);
    const row = this.limits.get(key) ?? { count: 0, until: now + WINDOW_MS };
    this.limits.set(key, row);
    return ++row.count <= limit;
  }
  /**
   * Built on first use and kept: a server version has one generic bundle, so the hash the script pins stays the hash of the
   * archive every later request receives. A failure is not remembered; the next request tries again (under the rate limit).
   */
  private build(): RuntimeInstallFiles {
    if (this.files) return this.files;
    const bundle = (this.options.bundle ?? createRuntimeBundle)();
    if (bundle.bytes.length > RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("Runtime bundle exceeded its archive size limit");
    const script = Buffer.from(renderRuntimeInstallScript((this.options.template ?? defaultTemplate)(), bundle), "utf8");
    return this.files = { bundle, script };
  }
  /** True when the request was one of the two install routes and has been answered (404 while they are off); false leaves every other path to the normal gate. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const isScript = url.pathname === RUNTIME_INSTALL_SCRIPT_PATH;
    if (!isScript && url.pathname !== RUNTIME_BUNDLE_PATH) return false;
    // Off, or reached through a public gateway link: these two routes do not exist there. 404 is the same answer as any
    // unknown route, and it does not reveal whether remote runtimes are configured. No bundle is built for it.
    if (!remoteRuntimeEnabled() || gatewayRequestContext(req)) { answer(res, 404, { error: "Not found" }); return true; }
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") { answer(res, 405, { error: "Runtime installer files are read-only" }, { Allow: "GET, HEAD" }); return true; }
    if (url.search) { answer(res, 400, { error: "Runtime installer files do not accept options" }); return true; }
    if (!protectedTransport(req)) { answer(res, 403, { error: "The Runtime installer is served only over HTTPS or localhost" }); return true; }
    const peer = req.socket.remoteAddress ?? "unknown";
    if (!this.charge("total", TOTAL_PER_MINUTE) || !this.charge(`${isScript ? "script" : "bundle"}:${peer}`, isScript ? SCRIPT_PER_PEER : BUNDLE_PER_PEER)) {
      answer(res, 429, { error: "Too many Runtime installer requests. Wait a minute and try again." }, { "Retry-After": "60" }); return true;
    }
    try {
      const { bundle, script } = this.build();
      const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (isScript) {
        res.writeHead(200, { ...common, "Content-Type": "text/plain; charset=utf-8", "Content-Length": script.length });
        res.end(method === "HEAD" ? undefined : script);
      } else {
        res.writeHead(200, { ...common, "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${bundle.filename}"`,
          "Content-Length": bundle.bytes.length, "X-Agend-SHA256": bundle.sha256 });
        res.end(method === "HEAD" ? undefined : bundle.bytes);
      }
    } catch {
      answer(res, 503, { error: "The Windows Runtime installer is unavailable on this host. Update or reinstall AgEnD and retry." });
    }
    return true;
  }
}
