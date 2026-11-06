/** Paired-origin download and code-only ZIP validation. Does not select, install or execute a program. */
import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { validateRuntimeServer } from "./runtime-client-store.js";
import { runtimeCodeBuildId } from "./runtime-build-info.js";

export const RUNTIME_UPDATE_METADATA_PATH = "/runtime/v1/bundle/windows.json";
export const RUNTIME_UPDATE_ARCHIVE_PATH = "/runtime/v1/bundle/windows.zip";
export const RUNTIME_UPDATE_MAX_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export interface RuntimeUpdateMetadata { version: string; sha256: string; bytes: number }
export class RuntimeUpdateArtifactError extends Error {
  constructor(readonly reason: "metadata" | "transport" | "download" | "checksum" | "downgrade" | "archive") { super(`Runtime update ${reason} refused`); }
}
const fail = (reason: RuntimeUpdateArtifactError["reason"]): never => { throw new RuntimeUpdateArtifactError(reason); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function version(value: unknown): RegExpExecArray {
  if (typeof value !== "string" || value.length > 64) return fail("metadata");
  const parts = VERSION.exec(value);
  if (!parts || parts[4]?.split(".").some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith("0"))) return fail("metadata");
  return parts;
}
/** SemVer precedence; build metadata is identity, never an ordering signal. */
export function compareRuntimeVersions(left: string, right: string): -1 | 0 | 1 {
  const a = version(left), b = version(right);
  for (let i = 1; i <= 3; i++) if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) < BigInt(b[i]) ? -1 : 1;
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const ap = a[4].split("."), bp = b[4].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return BigInt(ap[i]) < BigInt(bp[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] < bp[i] ? -1 : 1;
  }
  return 0;
}
export function parseRuntimeUpdateMetadata(value: unknown): RuntimeUpdateMetadata {
  if (!object(value) || Object.keys(value).length !== 3 || Object.keys(value).some(k => !["version", "sha256", "bytes"].includes(k))) return fail("metadata");
  version(value.version);
  if (typeof value.sha256 !== "string" || !HASH.test(value.sha256) || !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0 || (value.bytes as number) > RUNTIME_UPDATE_MAX_BYTES) return fail("metadata");
  return { version: value.version as string, sha256: value.sha256, bytes: value.bytes as number };
}
export const runtimeUpdateEtag = (metadata: RuntimeUpdateMetadata): string => `"${metadata.version}-${metadata.sha256}"`;
/** A lower SemVer is refused even when it is the paired server's current artifact. */
export function runtimeUpdateNeeded(current: { version: string; sha256: string }, target: RuntimeUpdateMetadata, failedHash?: string): boolean {
  const next = parseRuntimeUpdateMetadata(target);
  if (!HASH.test(current.sha256)) return fail("metadata");
  if (compareRuntimeVersions(next.version, current.version) < 0) return fail("downgrade");
  return next.sha256 !== current.sha256 && next.sha256 !== failedHash;
}
interface Download { bytes: Buffer; etag: string | undefined }
const loopback = (address?: string): boolean => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "");
function download(origin: URL, path: string, limit: number, timeoutMs: number): Promise<Download> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined, settled = false;
    const finish = (error?: RuntimeUpdateArtifactError, value?: Download) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (error) { response?.destroy(); req.destroy(); reject(error); } else resolve(value!);
    };
    // A fixed origin/path, no redirects, proxy, browser cookies or machine credentials. TLS verification is explicit.
    const req = (origin.protocol === "https:" ? httpsRequest : httpRequest)(new URL(path, origin), {
      method: "GET", agent: false, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
      headers: { Accept: path === RUNTIME_UPDATE_METADATA_PATH ? "application/json" : "application/zip", "Accept-Encoding": "identity" },
    }, res => {
      response = res;
      if (res.statusCode !== 200 || (origin.protocol === "http:" && !loopback(res.socket.remoteAddress))
        || (res.headers["content-encoding"] !== undefined && res.headers["content-encoding"] !== "identity")) return finish(new RuntimeUpdateArtifactError("transport"));
      const declared = res.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) return finish(new RuntimeUpdateArtifactError("download"));
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) return finish(new RuntimeUpdateArtifactError("download"));
        chunks.push(chunk);
      });
      res.on("aborted", () => finish(new RuntimeUpdateArtifactError("download")));
      res.on("error", () => finish(new RuntimeUpdateArtifactError("download")));
      res.on("end", () => {
        if (declared !== undefined && size !== Number(declared)) return finish(new RuntimeUpdateArtifactError("download"));
        finish(undefined, { bytes: Buffer.concat(chunks, size), etag: res.headers.etag });
      });
    });
    const deadline = setTimeout(() => finish(new RuntimeUpdateArtifactError("download")), timeoutMs);
    req.on("error", () => finish(new RuntimeUpdateArtifactError("transport")));
    req.end();
  });
}
/** The caller supplies the profile's stored paired origin, not a URL from a response or an incoming task. */
export async function fetchRuntimeUpdateMetadata(pairedOrigin: string, timeoutMs = 10_000): Promise<RuntimeUpdateMetadata> {
  let origin: URL;
  try { origin = validateRuntimeServer(pairedOrigin); } catch { return fail("transport"); }
  const received = await download(origin, RUNTIME_UPDATE_METADATA_PATH, 4096, timeoutMs);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(received.bytes)); } catch { return fail("metadata"); }
  const metadata = parseRuntimeUpdateMetadata(value);
  if (received.etag !== runtimeUpdateEtag(metadata)) return fail("metadata");
  return metadata;
}
export async function fetchRuntimeUpdateArchive(pairedOrigin: string, metadata: RuntimeUpdateMetadata, timeoutMs = 60_000): Promise<Buffer> {
  const expected = parseRuntimeUpdateMetadata(metadata);
  let origin: URL;
  try { origin = validateRuntimeServer(pairedOrigin); } catch { return fail("transport"); }
  const received = await download(origin, RUNTIME_UPDATE_ARCHIVE_PATH, expected.bytes, timeoutMs);
  if (received.bytes.length !== expected.bytes || received.etag !== runtimeUpdateEtag(expected) || hash(received.bytes) !== expected.sha256) return fail("checksum");
  return received.bytes;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function relativePath(name: string): boolean {
  return name.length <= 240 && name.split("/").every(p => /^[A-Za-z0-9@_-][A-Za-z0-9@_.-]*$/.test(p)
    && !p.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
export interface RuntimeUpdateArchive { metadata: RuntimeUpdateMetadata; buildId: string; files: ReadonlyMap<string, Buffer> }
/** Accept only the producer's stored ZIP format. No platform extractor, compression, links, extra fields or hidden records. */
export function validateRuntimeUpdateArchive(archive: Buffer, input: RuntimeUpdateMetadata): RuntimeUpdateArchive {
  const metadata = parseRuntimeUpdateMetadata(input);
  if (archive.length !== metadata.bytes || hash(archive) !== metadata.sha256) return fail("checksum");
  try {
    const end = archive.length - 22;
    if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt32LE(end + 4) !== 0 || archive.readUInt16LE(end + 20) !== 0) return fail("archive");
    const count = archive.readUInt16LE(end + 10), start = archive.readUInt32LE(end + 16);
    if (!count || count > 512 || archive.readUInt16LE(end + 8) !== count || start + archive.readUInt32LE(end + 12) !== end) return fail("archive");
    const files = new Map<string, Buffer>(), names = new Set<string>(); let at = start, localAt = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > end || archive.readUInt32LE(at) !== 0x02014b50 || archive.readUInt16LE(at + 8) !== 0x0800 || archive.readUInt16LE(at + 10) !== 0
        || archive.readUInt16LE(at + 30) !== 0 || archive.readUInt16LE(at + 32) !== 0 || archive.readUInt16LE(at + 34) !== 0
        || archive.readUInt32LE(at + 38) !== ((0o100644 << 16) >>> 0)) return fail("archive");
      const size = archive.readUInt32LE(at + 24), nameLength = archive.readUInt16LE(at + 28), offset = archive.readUInt32LE(at + 42);
      if (size > 2 * 1024 * 1024 || size !== archive.readUInt32LE(at + 20) || at + 46 + nameLength > end || offset !== localAt || offset + 30 > start) return fail("archive");
      const nameBytes = archive.subarray(at + 46, at + 46 + nameLength), full = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
      if (!full.startsWith("agend-runtime/")) return fail("archive");
      const name = full.slice("agend-runtime/".length), lower = name.toLowerCase();
      if (!relativePath(name) || names.has(lower)) return fail("archive");
      names.add(lower);
      if (archive.readUInt32LE(offset) !== 0x04034b50 || archive.readUInt16LE(offset + 6) !== 0x0800 || archive.readUInt16LE(offset + 8) !== 0
        || archive.readUInt16LE(offset + 28) !== 0 || archive.readUInt16LE(offset + 26) !== nameLength
        || archive.readUInt32LE(offset + 18) !== size || archive.readUInt32LE(offset + 22) !== size
        || archive.readUInt32LE(offset + 14) !== archive.readUInt32LE(at + 16)
        || !archive.subarray(offset + 30, offset + 30 + nameLength).equals(nameBytes)) return fail("archive");
      localAt = offset + 30 + nameLength + size;
      if (localAt > start) return fail("archive");
      const bytes = archive.subarray(offset + 30 + nameLength, localAt);
      if (crc32(bytes) !== archive.readUInt32LE(at + 16)) return fail("archive");
      files.set(name, Buffer.from(bytes)); at += 46 + nameLength;
    }
    if (at !== end || localAt !== start) return fail("archive");
    // A file may not also be a directory (including Windows case aliases).
    for (const name of names) { const parts = name.split("/"); parts.pop(); while (parts.length) { if (names.has(parts.join("/"))) return fail("archive"); parts.pop(); } }
    const manifest = JSON.parse(files.get("bundle-manifest.json")!.toString("utf8"));
    if (!object(manifest) || manifest.version !== metadata.version || typeof manifest.buildId !== "string" || !HASH.test(manifest.buildId)
      || !Array.isArray(manifest.modules) || !manifest.modules.length || manifest.modules.length > 256 || !object(manifest.sha256)
      || Object.keys(manifest.sha256).length !== files.size - 1) return fail("archive");
    const modules = manifest.modules;
    if (modules.some(n => typeof n !== "string" || !/^[a-z0-9][a-z0-9.-]*\.(js|ps1)$/.test(n)) || new Set(modules).size !== modules.length
      || !["runtime-cli.js", "runtime-client.js", "runtime-protocol.js"].every(n => modules.includes(n))) return fail("archive");
    for (const [name, bytes] of files) if (name !== "bundle-manifest.json" && manifest.sha256[name] !== hash(bytes)) return fail("archive");
    if (runtimeCodeBuildId(metadata.version, modules.map(n => [n, files.get(`dist/${n}`)!] as const)) !== manifest.buildId) return fail("archive");
    const pkg = JSON.parse(files.get("package.json")!.toString("utf8"));
    if (!object(pkg) || pkg.name !== "@songsid/agend-runtime" || pkg.version !== metadata.version || pkg.type !== "module"
      || !object(pkg.bin) || pkg.bin["agend-runtime"] !== "./dist/runtime-cli.js" || files.has("agend-server.json")) return fail("archive");
    return { metadata, buildId: manifest.buildId, files };
  } catch (error) {
    if (error instanceof RuntimeUpdateArtifactError) throw error;
    return fail("archive");
  }
}
