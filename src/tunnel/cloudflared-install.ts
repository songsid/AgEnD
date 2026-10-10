/**
 * AgEnD's own cloudflared, for the one-tap public `/login` link (#1137).
 *
 * Used only after the admin pressed the public-link button, and only when no
 * `cloudflared` is on PATH (the user's own install always wins). Then:
 *
 *   - the source is Cloudflare's official GitHub release, at a version pinned
 *     here; a runtime never asks for "latest";
 *   - every asset's SHA256 is pinned here too, copied from that release's
 *     published checksums and reviewed with this file. A checksum fetched
 *     alongside the download would prove nothing, so none is;
 *   - it lands in AgEnD's own directory (`<AGEND_HOME>/bin`, 0700), never
 *     anywhere system-wide, never with sudo;
 *   - the download is streamed to a temp file in that directory and hashed as
 *     it arrives, then the file itself is hashed again from disk: only bytes
 *     that are on disk AND match the pin are made executable and renamed into
 *     place (atomic). A mismatch is deleted and nothing runs;
 *   - source order (#1554): on Linux the pinned build comes FIRST from Cloudflare's
 *     apt repository (pkg.cloudflare.com `.deb`; `usr/bin/cloudflared` extracted
 *     in Node) and falls back to the GitHub release asset when the package is
 *     missing, stalls, is too slow or is not what the pin says. macOS has no
 *     package there and uses GitHub only. Every source is checked against the
 *     SAME pinned SHA256 — those packages carry exactly the bare binary's bytes;
 *   - a download fails when no byte arrives for 60 s, under a 30 min ceiling —
 *     a slow link that keeps moving is not a dead one (#1554);
 *   - before every use the installed binary is checked against a stamp of the
 *     pinned version and its hash; a damaged or outdated one is replaced;
 *   - no lock (#1141 review): every file is written under a name of its own
 *     and only a verified one is renamed into place, so two installs racing —
 *     in two processes — each land the same pinned bytes and neither can see
 *     or remove the other's work. In this process they share one promise, so
 *     one login downloads once;
 *   - nothing in a directory someone else could write is trusted (#1141
 *     review): `<AGEND_HOME>` and its `bin` must be real directories owned by
 *     this user and closed to others; a `bin` that was open is closed and its
 *     contents fetched again. A bare binary is checked against the compiled
 *     pin itself; a macOS one (extracted from the .tgz) against a stamp that
 *     records the pinned archive hash it came from.
 *
 * Bumping the pin is a release-checklist step: new version, new hashes from
 * the release's "SHA256 Checksums", one download checked against them.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { resolveBinary } from "./cloudflared.js";
import { extractDebFile } from "./deb-extract.js";
import { performance } from "node:perf_hooks";

export const CLOUDFLARED_PIN = {
  version: "2026.9.3",
  assets: {
    "linux-x64": { name: "cloudflared-linux-amd64", sha256: "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2", archive: "binary", deb: "amd64" },
    "linux-arm64": { name: "cloudflared-linux-arm64", sha256: "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d", archive: "binary", deb: "arm64" },
    "linux-arm": { name: "cloudflared-linux-arm", sha256: "967dc371a3fedbf09e881c13ee7ba317155ebc336cbd4afb756b46fc6785e5af", archive: "binary", deb: "arm" },
    "linux-ia32": { name: "cloudflared-linux-386", sha256: "d6b2f917e2e78b3e3afba760af726e51751d10c2fcad4a2fb2a69feb4bd47421", archive: "binary", deb: "386" },
    "darwin-x64": { name: "cloudflared-darwin-amd64.tgz", sha256: "ab588b3b4db9cdb4476c30a3db2a72635b1d8327d44741fee6799a0f37b0ec07", archive: "tgz" },
    "darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", sha256: "5472c1a01c84bc31b3021056a73b4e5774ddddefc572124ea8fdf6c340639f32", archive: "tgz" },
  },
} as const;

/**
 * `deb`: the architecture of the same build in Cloudflare's apt repository (#1554), the first source on Linux.
 * Checked 2026-10-10 for 2026.9.3: the `usr/bin/cloudflared` inside the amd64, arm64, arm and 386 packages has exactly
 * the pinned SHA256 of the bare binary, so the same pin verifies it. NOT armhf: that package holds a different build
 * (a714b1bee87e…), so linux-arm uses the `arm` package. macOS has no package there. Bumping the pin re-checks this.
 */
export type CloudflaredAsset = { name: string; sha256: string; archive: "binary" | "tgz"; deb?: string };

export type CloudflaredInstallErrorKind = "unsupported-platform" | "download-failed" | "checksum-mismatch" | "install-failed" | "cancelled";

export class CloudflaredInstallError extends Error {
  constructor(readonly kind: CloudflaredInstallErrorKind, detail: string) {
    super(detail);
    this.name = "CloudflaredInstallError";
  }
}

/** The pinned asset for this platform, or null where Cloudflare publishes none we pin. */
export function assetFor(platform: NodeJS.Platform, arch: string): CloudflaredAsset | null {
  return (CLOUDFLARED_PIN.assets as Record<string, CloudflaredAsset>)[`${platform}-${arch}`] ?? null;
}

export function releaseUrl(asset: CloudflaredAsset, version: string = CLOUDFLARED_PIN.version): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset.name}`;
}

/** #1554: the same pinned build as a package in Cloudflare's apt repository (Linux only). */
export function packageUrl(asset: CloudflaredAsset, version: string = CLOUDFLARED_PIN.version): string | null {
  return asset.deb ? `https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/cloudflared_${version}_${asset.deb}.deb` : null;
}

/** No cloudflared binary is this big; a response that is has gone wrong. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/**
 * #1554: a download fails when no byte has arrived for this long — not after a fixed total. A slow link that keeps
 * moving (11.5 / 38.3 MB in 5 min, reported from Taiwan) is not a dead one.
 */
const STALL_TIMEOUT_MS = 60_000;
/** The overall ceiling for one attempt, however steadily it moves. */
const DOWNLOAD_CEILING_MS = 30 * 60_000;
/**
 * With a second source to try (Linux), the first is given this long; if its pace then projects the whole file past
 * SLOW_PROJECTION_MS (the old fixed cap), the other source is tried instead of waiting it out.
 */
const SLOW_CHECK_MS = 25_000;
const SLOW_PROJECTION_MS = 5 * 60_000;
/** The failure detail of a download stopped for its pace (the one case where trying the other source is the point). */
const TOO_SLOW = "too slow to finish in reasonable time";

export interface EnsureCloudflaredOptions {
  /** AgEnD's data directory (`AGEND_HOME`); the binary goes in `<dataDir>/bin`. */
  dataDir: string;
  /** Public web refuses arbitrary PATH executables; existing callers retain their policy. */
  pinnedOnly?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Told once, right before a download starts (the caller posts a line in chat). */
  onDownloading?: (info: { version: string; asset: string }) => void | Promise<void>;
  /**
   * Where the install is, for a caller that shows it as it happens. Never awaited and never allowed to throw into
   * the install: `checked` says whether a download is needed, `downloading` follows the bytes (`total` is the
   * response's Content-Length, null when it sent none), `verifying` covers the checksum, extraction and rename.
   * Only the call that starts an install hears it; one that joins an install already running does not.
   */
  onProgress?: (progress: CloudflaredInstallProgress) => void;
  /** Test seams. */
  fetchImpl?: (url: string, init: { signal: AbortSignal; redirect: "follow" }) => Promise<Response>;
  extractTgz?: (archive: string, intoDir: string) => Promise<void>;
  pin?: { version: string; assets: Record<string, CloudflaredAsset> };
  /** The overall ceiling of one download attempt (default 30 min). */
  timeoutMs?: number;
  /** No bytes for this long fails the attempt (default 60 s). */
  stallMs?: number;
  /** When GitHub's pace is judged, and the projected total that sends the download to the package source. */
  slowCheckMs?: number;
  slowProjectionMs?: number;
  maxBytes?: number;
  /** Aborts the install, before or during the download (a `/login cancel`, a shutdown). */
  signal?: AbortSignal;
  /** Test seam: the uid AgEnD's directories must belong to (default: this process's). */
  uid?: number;
}

export type CloudflaredInstallProgress =
  | { readonly phase: "checked"; readonly download: boolean; readonly version: string }
  /** `fallback`: the bytes now come from GitHub, because the pkg.cloudflare.com package was too slow or failed (#1554). */
  | { readonly phase: "downloading"; readonly received: number; readonly total: number | null; readonly fallback?: { readonly reason: "slow" | "failed" } }
  | { readonly phase: "verifying" };

function tell(opts: EnsureCloudflaredOptions, progress: CloudflaredInstallProgress): void {
  try { opts.onProgress?.(progress); } catch { /* a display must never break the install */ }
}

export interface EnsureCloudflaredResult {
  path: string;
  /** `path`: the user's own, on PATH. `agend`: ours, already installed and verified. `downloaded`: ours, just now. */
  source: "path" | "agend" | "downloaded";
}

const inFlight = new Map<string, Promise<EnsureCloudflaredResult>>();

/** A cloudflared to run: the user's own on PATH, else AgEnD's verified copy (downloaded when needed). */
export async function ensureCloudflared(opts: EnsureCloudflaredOptions): Promise<EnsureCloudflaredResult> {
  throwIfCancelled(opts.signal);
  const onPath = opts.pinnedOnly ? null : resolveBinary("cloudflared", opts.env ?? process.env);
  if (onPath) return { path: onPath, source: "path" };
  const dir = join(opts.dataDir, "bin");
  const running = inFlight.get(dir);
  if (running) return running;
  const flight = installOrReuse(opts, dir).finally(() => inFlight.delete(dir));
  inFlight.set(dir, flight);
  return flight;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CloudflaredInstallError("cancelled", "cancelled");
}

async function installOrReuse(opts: EnsureCloudflaredOptions, dir: string): Promise<EnsureCloudflaredResult> {
  const pin = opts.pin ?? CLOUDFLARED_PIN;
  const asset = (pin.assets as Record<string, CloudflaredAsset>)[`${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`];
  if (!asset) {
    throw new CloudflaredInstallError("unsupported-platform",
      `no pinned cloudflared for ${opts.platform ?? process.platform}/${opts.arch ?? process.arch}`);
  }
  const uid = opts.uid ?? process.getuid?.();
  const target = join(dir, "cloudflared");
  // A bin someone else could have written: its contents are not ours to trust.
  if ((await privateDirectory(opts.dataDir, dir, uid)) === "was-open") await discardInstall(target);
  if (await installedAndIntact(target, pin.version, asset, uid)) {
    tell(opts, { phase: "checked", download: false, version: pin.version });
    return { path: target, source: "agend" };
  }
  tell(opts, { phase: "checked", download: true, version: pin.version });

  throwIfCancelled(opts.signal);
  await opts.onDownloading?.({ version: pin.version, asset: asset.name });
  // A cancel that arrived while the notice was being posted stops it here: no fetch starts.
  throwIfCancelled(opts.signal);
  await download(asset, pin.version, dir, target, opts);
  return { path: target, source: "downloaded" };
}

/**
 * `<dataDir>` and `<dataDir>/bin` must be real directories (not symlinks),
 * owned by `uid`, and not writable by anyone else; `bin` must be closed to
 * others entirely. Creates `bin` 0700. An open `bin` that is ours is closed
 * ("was-open": what it holds may have been planted). Anything else refuses.
 */
async function privateDirectory(dataDir: string, dir: string, uid: number | undefined): Promise<"ok" | "was-open"> {
  const home = await lstat(dataDir).catch(() => null);
  if (!home) throw new CloudflaredInstallError("install-failed", `${dataDir} does not exist`);
  // AGEND_HOME itself may be a symlink the user chose; what it points to must be theirs and closed to writes.
  const homeReal = home.isSymbolicLink() ? await stat(dataDir).catch(() => null) : home;
  if (!homeReal?.isDirectory() || (uid !== undefined && homeReal.uid !== uid) || (homeReal.mode & 0o022) !== 0) {
    throw new CloudflaredInstallError("install-failed", `${dataDir} is writable by another user — refusing to install cloudflared there`);
  }
  let st = await lstat(dir).catch(() => null);
  if (!st) {
    await mkdir(dir, { mode: 0o700 }).catch(err => { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; });
    st = await lstat(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new CloudflaredInstallError("install-failed", `${dir} is not a plain directory — refusing to install cloudflared there`);
  }
  if (uid !== undefined && st.uid !== uid) {
    throw new CloudflaredInstallError("install-failed", `${dir} belongs to another user — refusing to install cloudflared there`);
  }
  if ((st.mode & 0o077) !== 0) {
    await chmod(dir, 0o700);
    return "was-open";
  }
  return "ok";
}

async function discardInstall(target: string): Promise<void> {
  await rm(target, { force: true });
  await rm(stampPath(target), { force: true });
}

/** A regular file (not a symlink), owned by `uid`, writable only by its owner. */
async function trustedFile(path: string, uid: number | undefined): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return !!st && st.isFile() && (uid === undefined || st.uid === uid) && (st.mode & 0o022) === 0;
}

/**
 * The stamp written after a verified install:
 * `<version> <pinned sha256 of the asset it came from> <sha256 of the installed binary>`.
 */
function stampPath(target: string): string { return `${target}.sha256`; }

async function installedAndIntact(target: string, version: string, asset: CloudflaredAsset, uid: number | undefined): Promise<boolean> {
  if (!(await trustedFile(target, uid))) return false;
  let actual: string;
  try { actual = await sha256File(target); } catch { return false; }
  // A bare binary IS the asset: the compiled pin is the only authority.
  if (asset.archive === "binary") return actual === asset.sha256;
  // Extracted from an archive: the stamp says which pinned archive it came from.
  if (!(await trustedFile(stampPath(target), uid))) return false;
  let stamp: string;
  try { stamp = (await readFile(stampPath(target), "utf8")).trim(); } catch { return false; }
  const [stampedVersion, stampedAsset, stampedBinary] = stamp.split(/\s+/);
  return stampedVersion === version && stampedAsset === asset.sha256 && stampedBinary === actual;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", chunk => hash.update(chunk)).on("end", () => resolve()).on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Source order (#1554, user decision 2026-10-10): Cloudflare first. On Linux the pinned build comes from
 * pkg.cloudflare.com (`.deb`); GitHub's release asset is the fallback when the package is missing (404), stalls, is
 * too slow to finish in reasonable time, or is not a cloudflared package whose binary matches the pin. macOS has no
 * package there and uses GitHub only. Every source is checked against the SAME pinned SHA256. A cancel or a local
 * failure (disk, permissions) is never retried elsewhere.
 */
async function download(asset: CloudflaredAsset, version: string, dir: string, target: string, opts: EnsureCloudflaredOptions): Promise<void> {
  const packaged = packageUrl(asset, version);
  if (!packaged) return downloadRelease(asset, version, dir, target, opts, false);
  try {
    await downloadPackage(asset, packaged, dir, target, opts, true);
  } catch (err) {
    if (!(err instanceof CloudflaredInstallError) || !(err.kind === "download-failed" || err.kind === "checksum-mismatch" || err instanceof PackageFormatError)) throw err;
    throwIfCancelled(opts.signal);
    await downloadRelease(asset, version, dir, target, opts, false, err.message === TOO_SLOW ? "slow" : "failed");
  }
}

/** The package was fetched but is not a cloudflared `.deb` we can read: a source problem, so the fallback is tried. */
class PackageFormatError extends CloudflaredInstallError {
  constructor(detail: string) { super("install-failed", detail); }
}

/**
 * The package source: the `.deb` is streamed to a temp file under the same caps, `usr/bin/cloudflared` is taken out
 * of it in Node, and only bytes that match the pinned SHA256 — checked in memory and again from disk — are made
 * executable and renamed into place, exactly like a GitHub download.
 */
async function downloadPackage(asset: CloudflaredAsset, url: string, dir: string, target: string, opts: EnsureCloudflaredOptions,
  judgePace: boolean): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const debPart = join(dir, `.cloudflared.${tag}.deb.part`);
  const part = join(dir, `.cloudflared.${tag}.part`);
  try {
    await fetchToFile(url, debPart, opts, judgePace, (received, total) => tell(opts, { phase: "downloading", received, total }));
    tell(opts, { phase: "verifying" });
    throwIfCancelled(opts.signal);
    let binary: Buffer;
    try {
      binary = await extractDebFile(await readFile(debPart), "usr/bin/cloudflared", opts.maxBytes ?? MAX_DOWNLOAD_BYTES);
    } catch (err) {
      throw new PackageFormatError(`${url}: ${(err as Error).message}`);
    }
    const sha = createHash("sha256").update(binary).digest("hex");
    if (sha !== asset.sha256) {
      throw new CloudflaredInstallError("checksum-mismatch", `${url}: the cloudflared inside has SHA256 ${sha}, not the pinned ${asset.sha256}`);
    }
    const handle = await open(part, "wx", 0o600).catch(err => {
      throw new CloudflaredInstallError("install-failed", `cannot write ${part}: ${(err as Error).message}`);
    });
    try { await writeAll(handle, binary, part); } finally { await handle.close().catch(() => { /* already closed */ }); }
    const written = await sha256File(part);
    if (written !== asset.sha256) {
      throw new CloudflaredInstallError("install-failed", `${part} does not hold the binary it was given (SHA256 ${written})`);
    }
    throwIfCancelled(opts.signal);
    await chmod(part, 0o755);
    await rename(part, target);
  } catch (err) {
    if (err instanceof CloudflaredInstallError) throw err;
    throw new CloudflaredInstallError("install-failed", (err as Error).message);
  } finally {
    await rm(debPart, { force: true });
    await rm(part, { force: true });
  }
}

async function downloadRelease(asset: CloudflaredAsset, version: string, dir: string, target: string, opts: EnsureCloudflaredOptions,
  judgePace: boolean, fallbackReason?: "slow" | "failed"): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const part = join(dir, `.cloudflared.${tag}.part`);
  const unpack = `${part}.d`;
  const stampTmp = `${stampPath(target)}.${tag}`;
  try {
    const sha = await fetchToFile(releaseUrl(asset, version), part, opts, judgePace,
      (received, total) => tell(opts, { phase: "downloading", received, total, ...(fallbackReason ? { fallback: { reason: fallbackReason } } : {}) }));
    tell(opts, { phase: "verifying" });
    if (sha !== asset.sha256) {
      throw new CloudflaredInstallError("checksum-mismatch",
        `${asset.name}: SHA256 ${sha} does not match the pinned ${asset.sha256}`);
    }
    // What was received matched; what is on disk is what will run, so it must match too.
    const written = await sha256File(part);
    if (written !== asset.sha256) {
      throw new CloudflaredInstallError("install-failed", `${part} does not hold the download it was given (SHA256 ${written})`);
    }
    throwIfCancelled(opts.signal);
    let binary = part;
    if (asset.archive === "tgz") {
      await mkdir(unpack, { mode: 0o700 });
      await (opts.extractTgz ?? extractTgzWithTar)(part, unpack);
      binary = join(unpack, "cloudflared");
      if (!(await lstat(binary).then(st => st.isFile(), () => false))) {
        throw new CloudflaredInstallError("install-failed", `${asset.name} has no cloudflared inside`);
      }
    }
    await chmod(binary, 0o755);
    const installedHash = binary === part ? sha : await sha256File(binary);
    await rename(binary, target);
    await writeFile(stampTmp, `${version} ${asset.sha256} ${installedHash}\n`, { mode: 0o600, flag: "wx" });
    await rename(stampTmp, stampPath(target));
  } catch (err) {
    if (err instanceof CloudflaredInstallError) throw err;
    throw new CloudflaredInstallError("install-failed", (err as Error).message);
  } finally {
    await rm(part, { force: true });
    await rm(unpack, { recursive: true, force: true });
    await rm(stampTmp, { force: true });
  }
}

/**
 * Streams the response into `file` (created fresh, never through a link),
 * hashing as it goes; returns the hex SHA256. Every way out — success, a
 * disk error, a bad status, the size cap, a timeout, a cancel — settles the
 * promise, ends the response body and releases what this call opened.
 */
async function fetchToFile(url: string, file: string, opts: EnsureCloudflaredOptions, judgePace: boolean,
  report: (received: number, total: number | null) => void): Promise<string> {
  const abort = new AbortController();
  // Why this attempt was stopped by us (a cancel is the caller's own signal): no byte for stallMs, the overall
  // ceiling, or a pace that projects the file past slowProjectionMs while a second source exists.
  let stopped: "stalled" | "ceiling" | "slow" | null = null;
  const stop = (why: "stalled" | "ceiling" | "slow") => { stopped ??= why; abort.abort(); };
  const timer = setTimeout(() => stop("ceiling"), opts.timeoutMs ?? DOWNLOAD_CEILING_MS);
  timer.unref?.();
  let stall: ReturnType<typeof setTimeout> | undefined;
  const moved = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => stop("stalled"), opts.stallMs ?? STALL_TIMEOUT_MS);
    stall.unref?.();
  };
  moved();
  let pace: ReturnType<typeof setTimeout> | undefined;
  const onCancel = () => abort.abort();
  opts.signal?.addEventListener("abort", onCancel, { once: true });
  // A listener added after the abort never fires: a cancel that already happened is honoured here.
  if (opts.signal?.aborted) {
    clearTimeout(timer);
    if (stall) clearTimeout(stall);
    opts.signal.removeEventListener("abort", onCancel);
    throw new CloudflaredInstallError("cancelled", "cancelled");
  }
  const transport = opts.fetchImpl ? { fetch: opts.fetchImpl, close: async () => {} } : await defaultTransport(opts.env ?? process.env);
  const failed = (err: unknown): CloudflaredInstallError => {
    if (err instanceof CloudflaredInstallError) return err;
    if (opts.signal?.aborted) return new CloudflaredInstallError("cancelled", "cancelled");
    if (stopped === "slow") return new CloudflaredInstallError("download-failed", TOO_SLOW);
    if (stopped === "stalled") return new CloudflaredInstallError("download-failed", "stalled: no data for a while");
    if (abort.signal.aborted) return new CloudflaredInstallError("download-failed", "timed out");
    return new CloudflaredInstallError("download-failed", (err as Error).message);
  };
  let res: Response | null = null;
  try {
    try {
      res = await transport.fetch(url, { signal: abort.signal, redirect: "follow" });
    } catch (err) {
      throw failed(err);
    }
    if (!res.ok || !res.body) throw new CloudflaredInstallError("download-failed", `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const hash = createHash("sha256");
    const length = Number(res.headers?.get?.("content-length") ?? "");
    const total = Number.isSafeInteger(length) && length > 0 ? length : null;
    moved();
    report(0, total);
    const startedAt = performance.now();
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
    } catch (err) {
      throw new CloudflaredInstallError("install-failed", `cannot write ${file}: ${(err as Error).message}`);
    }
    let bytes = 0;
    if (judgePace && total) {
      // One look, SLOW_CHECK_MS in: at the pace so far, would the rest arrive within slowProjectionMs?
      pace = setTimeout(() => {
        const elapsed = performance.now() - startedAt;
        const projected = bytes > 0 ? elapsed * total / bytes : Number.POSITIVE_INFINITY;
        if (projected > (opts.slowProjectionMs ?? SLOW_PROJECTION_MS)) stop("slow");
      }, opts.slowCheckMs ?? SLOW_CHECK_MS);
      pace.unref?.();
    }
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch (err) { throw failed(err); }
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > (opts.maxBytes ?? MAX_DOWNLOAD_BYTES)) throw new CloudflaredInstallError("download-failed", "the download is larger than any cloudflared");
        hash.update(chunk.value);
        await writeAll(handle, chunk.value, file);
        moved();
        report(bytes, total);
      }
    } catch (err) {
      await reader.cancel().catch(() => { /* already over */ });
      throw err;
    } finally {
      await handle.close().catch(() => { /* already closed */ });
    }
    return hash.digest("hex");
  } catch (err) {
    abort.abort();
    // A response we stopped reading (bad status, size cap) is ended too, not left to the server.
    await res?.body?.cancel().catch(() => { /* locked or already over */ });
    throw failed(err);
  } finally {
    clearTimeout(timer);
    if (stall) clearTimeout(stall);
    if (pace) clearTimeout(pace);
    opts.signal?.removeEventListener("abort", onCancel);
    await transport.close().catch(() => { /* already closed */ });
  }
}

/**
 * A write may put down fewer bytes than asked (a full disk, a file-size
 * limit): the rest is written again, and a write that makes no progress fails.
 */
async function writeAll(handle: FileHandle, data: Uint8Array, file: string): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await handle.write(data, offset, data.byteLength - offset));
    } catch (err) {
      throw new CloudflaredInstallError("install-failed", `cannot write ${file}: ${(err as Error).message}`);
    }
    if (bytesWritten <= 0) throw new CloudflaredInstallError("install-failed", `cannot write ${file}: no progress`);
    offset += bytesWritten;
  }
}

/** Global fetch, or undici with the environment's proxy when one is set (its agent closed after use). */
async function defaultTransport(env: NodeJS.ProcessEnv): Promise<{ fetch: NonNullable<EnsureCloudflaredOptions["fetchImpl"]>; close: () => Promise<void> }> {
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxied) return { fetch: (url, init) => fetch(url, init), close: async () => {} };
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici");
  const agent = new EnvHttpProxyAgent();
  return {
    fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent }) as unknown as Promise<Response>,
    close: () => agent.close(),
  };
}

/** The system tar, given only argv (no shell): Cloudflare's macOS .tgz holds the one binary. */
function extractTgzWithTar(archive: string, intoDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xzf", archive, "-C", intoDir, "cloudflared"], { stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk).slice(0, 500); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)));
  });
}
