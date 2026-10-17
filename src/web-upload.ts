/**
 * Files in the web chat (web track C2): what a browser may upload, where it goes, and which files the
 * dashboard may fetch back.
 *
 * Telegram parity: a photo or document a user sends reaches the agent exactly as a Telegram one does —
 * the file in the instance's workspace inbox, a `[📷 Image: <path>]` / `[📎 File: <name> → <path>]`
 * line in the text and `image_path` / `attachment_path` in the meta. The files an agent attaches to
 * its reply are shown in the web chat too.
 *
 * Nothing the client says about a file is trusted: the type is read from the bytes (magic numbers, or
 * valid UTF-8 without NUL for text), the stored name is chosen here, the display name is reduced to a
 * label, and a file can be fetched back only by an id this process issued for it — never by a path.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";

const MB = 1024 * 1024;
/** #1937: the defaults; `web.upload_max_file_mb` / `web.upload_max_total_mb` change the two sizes (uploadLimits()). */
export const UPLOAD_LIMITS = {
  /** One file. */
  maxFileBytes: 50 * MB,
  /** Files on one message. */
  maxFiles: 5,
  /** All files on one message together. */
  maxTotalBytes: 100 * MB,
} as const;
/** #1937: what `web.upload_max_file_mb` and `web.upload_max_total_mb` may be — whole MB (MiB). */
export const UPLOAD_MB_RANGE = { min: 1, max: 500 } as const;
/**
 * #1937: one file over the public link. A Cloudflare quick tunnel carries a request body of about 100 MB at most, and
 * one upload is one request, so whatever the config says, a file through the tunnel stays under that.
 */
export const PUBLIC_LINK_MAX_FILE_BYTES = 95 * MB;

export interface UploadLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  /** The public link lowered the per-file cap below the configured one (its 413 says why). */
  publicLinkCapped?: true;
}
/** A configured size in MB, or the default when it is absent or not a whole number in UPLOAD_MB_RANGE (the validator says so). */
function configuredMb(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= UPLOAD_MB_RANGE.min && v <= UPLOAD_MB_RANGE.max ? v * MB : fallback;
}
/**
 * #1937: the limits in force — the one source the upload route, the send, the served-file cap, the page's own check
 * and its words all read. A file is never allowed more than a whole message is; over the public link a file is at most
 * PUBLIC_LINK_MAX_FILE_BYTES. Read on every request, so `agend reload` applies a change to the next upload.
 */
export function uploadLimits(web: { upload_max_file_mb?: unknown; upload_max_total_mb?: unknown } | null | undefined, opts: { publicLink?: boolean } = {}): UploadLimits {
  const total = configuredMb(web?.upload_max_total_mb, UPLOAD_LIMITS.maxTotalBytes);
  const file = Math.min(configuredMb(web?.upload_max_file_mb, UPLOAD_LIMITS.maxFileBytes), total);
  const capped = opts.publicLink === true && file > PUBLIC_LINK_MAX_FILE_BYTES;
  return { maxFileBytes: capped ? PUBLIC_LINK_MAX_FILE_BYTES : file, maxFiles: UPLOAD_LIMITS.maxFiles, maxTotalBytes: total, ...(capped ? { publicLinkCapped: true as const } : {}) };
}
/** A size in MB as the limits are worded ("50", "2.5"). */
export function mbText(bytes: number): string { return String(Math.round((bytes / MB) * 10) / 10); }
/** #1937: the 413 for one file, from the limits in force (never a constant's number). */
export function fileTooLargeText(limits: UploadLimits): string {
  return limits.publicLinkCapped
    ? `a file can be at most ${mbText(limits.maxFileBytes)} MB over the public link (its Cloudflare tunnel carries about 100 MB per request)`
    : `a file can be at most ${mbText(limits.maxFileBytes)} MB`;
}
/** #1937: how long an upload may go without a byte before it is dropped (its partial file with it). */
export const UPLOAD_STALL_MS = 60_000;
/** #1937: the longest one upload may take, start to end (at 95 MB, about 54 KB/s on average). */
export const UPLOAD_MAX_MS = 30 * 60 * 1000;
/** #1937: what a listener allows for receiving one request — above UPLOAD_MAX_MS, so an upload's own clocks decide. */
export const UPLOAD_REQUEST_TIMEOUT_MS = UPLOAD_MAX_MS + 60_000;
/** #1937: the one route whose body may take long to arrive (its own clocks bound it). */
export function isUploadRequest(req: { method?: string; url?: string }): boolean {
  return req.method === "POST" && (req.url ?? "").split("?")[0] === "/ui/upload";
}
/**
 * #1937: every other request keeps the listener's old bound on receiving it — not whole within `ms`, its connection is
 * dropped (what `server.requestTimeout` did before it was raised for uploads).
 */
export function limitRequestReceive(req: { complete?: boolean; socket?: { destroy(): void } | null; once?(event: "close", fn: () => void): unknown }, ms: number): void {
  if (req.complete !== false) return;                         // whole already (a request object always says)
  const t = setTimeout(() => { if (req.complete === false) req.socket?.destroy(); }, ms);
  t.unref?.();
  req.once?.("close", () => clearTimeout(t));
}

/** How long an uploaded file waits to be sent with a message before its id stops working. */
export const UPLOAD_TTL_MS = 30 * 60 * 1000;

/** An upload no message has taken yet is stored under this prefix; it drops the prefix when a message takes it. */
export const PENDING_PREFIX = "web-pending-";
function sentPath(p: string): string { const b = basename(p); return b.startsWith(PENDING_PREFIX) ? join(dirname(p), "web-" + b.slice(PENDING_PREFIX.length)) : p; }
function pendingPath(p: string): string { const b = basename(p); return b.startsWith("web-") && !b.startsWith(PENDING_PREFIX) ? join(dirname(p), PENDING_PREFIX + b.slice(4)) : p; }
/** #1937: an upload's bytes stream into this file first (pending prefix: a restart's sweep removes one left behind). */
export const PART_SUFFIX = ".part";
/**
 * #1937: a new, empty part file in `inboxDir` (made private, 0700), created exclusively, 0600, never through a link.
 * Its bytes are written through `fd` (never by reopening the name); the caller closes it. `discard()` removes the part
 * and the directories made for it, when they are still empty — an upload that ends in nothing leaves nothing behind
 * (an instance deleted while its body was arriving gets no inbox made back, #1252 review P2-3).
 */
export function createPartFile(inboxDir: string, open: typeof openSync = openSync): { path: string; fd: number; discard(): void } {
  const made = mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const path = join(inboxDir, `${PENDING_PREFIX}${Date.now()}-${randomBytes(6).toString("hex")}${PART_SUFFIX}`);
  const discard = () => {
    removeQuietly(path);
    if (!made) return;
    // From the inbox up to the first directory made here; rmdir only removes an empty one (never one that was there).
    for (let d = inboxDir; d.length >= made.length; d = dirname(d)) { try { rmdirSync(d); } catch { return; } if (d === made) return; }
  };
  // Prism #1941 P3-1: an open that fails (EMFILE, ENOSPC …) still takes back the directories made for it.
  let fd: number;
  try { fd = open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); } catch (err) { discard(); throw err; }
  return { path, fd, discard };
}
/** Remove a file of ours, if it is still there; never throws. */
export function removeQuietly(path: string): void { try { unlinkSync(path); } catch { /* already gone */ } }
/** The largest file the dashboard will serve back (a reply attachment can be anything the agent made). */
export const MAX_SERVED_BYTES = 50 * 1024 * 1024;

export type UploadKind = "photo" | "document";

export interface SniffedType {
  kind: UploadKind;
  mime: string;
  ext: string;
}

/** Text files keep a known extension from their name; anything else is stored as .txt. */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".xml", ".css",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".sh", ".sql", ".toml", ".ini", ".diff", ".patch",
]);
/** #1900: markup a browser would render or run. Valid text or not, it is stored under its own name and only downloaded. */
const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".shtml", ".svg", ".svgz", ".mht", ".mhtml", ".xsl", ".xslt"]);
/** Extensions of the types read from the bytes above: a file whose bytes are not that type does not keep the name. */
const SNIFFED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

/** #1900: any other file, as Discord and Telegram take it — a download (application/octet-stream), never shown. */
export const OTHER_FILE_MIME = "application/octet-stream";

/** The extension an upload of an unread type is stored under: its own, lower-cased, if short and plain; else .bin. */
export function storedExtension(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) && !SNIFFED_EXTENSIONS.has(ext) ? ext : ".bin";
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/**
 * The type of an upload, from its bytes. Images by signature (PNG, JPEG, GIF, WebP), PDF by `%PDF-`, text when it is
 * valid UTF-8 with no NUL byte and not markup. #1900: anything else (an archive, an office file, a binary, HTML, SVG …)
 * is taken too, as a document the dashboard only offers as a download. Null only for an empty file.
 */
export function sniffUpload(bytes: Uint8Array, name: string): SniffedType | null {
  return new UploadSniffer().push(bytes).result(name);
}

/**
 * #1937: sniffUpload() as the bytes stream in — the upload is written to disk chunk by chunk, never held whole. Keeps
 * the first bytes (every signature is in the first 12), whether a NUL was seen, and whether everything so far is
 * valid UTF-8 (a streaming decoder: a character split across two chunks is still one character).
 */
export class UploadSniffer {
  private head = Buffer.alloc(0);
  private size = 0;
  private nul = false;
  private utf8 = true;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Uint8Array): this {
    if (chunk.length === 0) return this;
    this.size += chunk.length;
    if (this.head.length < 16) this.head = Buffer.concat([this.head, Buffer.from(chunk.subarray(0, 16 - this.head.length))]);
    if (!this.nul && chunk.includes(0)) this.nul = true;
    if (this.utf8 && !this.nul) {
      try { this.decoder.decode(chunk, { stream: true }); } catch { this.utf8 = false; }
    }
    return this;
  }

  /** The type of everything pushed (call once, at the end); null for an empty file. */
  result(name: string): SniffedType | null {
    if (this.size === 0) return null;
    const b = this.head;
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "photo", mime: "image/png", ext: ".png" };
    if (startsWith(b, [0xff, 0xd8, 0xff])) return { kind: "photo", mime: "image/jpeg", ext: ".jpg" };
    if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { kind: "photo", mime: "image/gif", ext: ".gif" };
    if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "photo", mime: "image/webp", ext: ".webp" };
    if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "document", mime: "application/pdf", ext: ".pdf" };
    const other: SniffedType = { kind: "document", mime: OTHER_FILE_MIME, ext: storedExtension(name) };
    const ext = extname(name).toLowerCase();
    if (MARKUP_EXTENSIONS.has(ext) || this.nul) return other;
    if (this.utf8) {
      try { this.decoder.decode(); } catch { this.utf8 = false; }      // a character cut off at the very end
    }
    if (!this.utf8) return other;
    return { kind: "document", mime: "text/plain; charset=utf-8", ext: TEXT_EXTENSIONS.has(ext) ? ext : ".txt" };
  }
}

/** A file name as a label only: no directory, no control characters, no leading dots, bounded. */
export function displayName(raw: string | undefined | null, fallback: string): string {
  let s = String(raw ?? "");
  try { s = decodeURIComponent(s); } catch { /* keep as sent */ }
  s = basename(s.replace(/\\/g, "/"));
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "").replace(/^\.+/, "").trim();
  // Bounded by code point, never by UTF-16 unit: cutting between the halves of an emoji left a lone surrogate,
  // which encodeURIComponent refuses with a throw — in the download header, on the fleet's own loop (#1252 review).
  const points = Array.from(s);
  if (points.length > 100) s = points.slice(0, 100).join("");
  return wellFormed(s) || fallback;
}

/** Any lone surrogate replaced by U+FFFD, so the name always encodes. */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

export interface UploadEntry {
  id: string;
  instance: string;
  path: string;
  kind: UploadKind;
  mime: string;
  name: string;
  size: number;
  /** On the ledger's own elapsed clock (not the wall clock): when the upload window closes. */
  expiresAt: number;
  /**
   * pending: uploaded, waiting for a message. reserved: a message has taken it and is being delivered (no other
   * message can take it, and no sweep may remove it). sent: delivered — the agent has it.
   */
  state: "pending" | "reserved" | "sent";
}

export interface ServedFile {
  id: string;
  /** realpath at registration: a later swap for a symlink does not change what is served. */
  realPath: string;
  name: string;
  mime: string;
  size: number;
  /** The file registered (device + inode): a file put in its place later is not served under this id (#1304 review). */
  dev: number;
  ino: number;
  /** The instance whose chat shows it. */
  instance: string;
  kind: UploadKind;
  /**
   * #1770: a reply file's snapshot (workspaces/<instance>/web-files): the fleet's own copy, kept as long as its message
   * — outside the served-id cap, and removed from disk when the message leaves the history (dropServed).
   */
  snapshot?: true;
}

const ID_PATTERN = /^[0-9a-f]{32}$/;
export const isFileId = (id: string): boolean => ID_PATTERN.test(id);

const TEXT_MIME = "text/plain; charset=utf-8";
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
  // #1589: media an agent sends is played in the page (by id, with Range); never anything a browser would run.
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  // Text, always served as text/plain (never text/html, never script): the page shows it escaped.
  ...Object.fromEntries([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".log", ".toml", ".yaml", ".yml", ".ini", ".cfg", ".conf",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".bash", ".zsh", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp",
    ".rb", ".php", ".swift", ".sql", ".css", ".scss", ".diff", ".patch", ".xml"].map((ext) => [ext, TEXT_MIME])),
};
/** Images the browser may show inline; everything else is served as a download. */
export const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** #1589: audio and video the page plays with <video>/<audio>: served inline, by id, with byte ranges. */
export const MEDIA_MIME = new Set(["video/mp4", "video/webm", "video/quicktime", "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg"]);
/** The most one range answer carries: a player asks again for the rest, nothing buffers a whole video. */
export const MEDIA_RANGE_MAX = 4 * 1024 * 1024;

/**
 * Uploads waiting for their message, and every file the dashboard may fetch back. In memory: ids from
 * before a restart stop working (the files stay in the inbox, where the agent got them).
 */
export class WebFileLedger {
  private readonly uploads = new Map<string, UploadEntry>();
  /** The file each upload was written as (device + inode): a rename moves only that file (#1304 review). */
  private readonly written = new WeakMap<UploadEntry, { dev: number; ino: number }>();
  private readonly served = new Map<string, ServedFile>();
  private readonly now: () => number;
  private readonly maxServed: number;
  /** #1937: the limits in force (the fleet's config, read each time): the send's count and total, the served-file cap. */
  readonly limits: () => UploadLimits;

  constructor(opts: { now?: () => number; maxServed?: number; limits?: () => UploadLimits } = {}) {
    // Elapsed time, like the sweep timer below: a wall-clock jump must neither expire an upload early nor keep
    // one past the timer that was meant to remove it (#1252 review).
    this.now = opts.now ?? (() => performance.now());
    this.maxServed = opts.maxServed ?? 2000;
    this.limits = opts.limits ?? (() => uploadLimits(null));
  }

  /** #1937: the largest file served back — MAX_SERVED_BYTES, or more when a file that large may be uploaded. */
  maxServedBytes(): number { return Math.max(MAX_SERVED_BYTES, this.limits().maxFileBytes); }

  /**
   * Store an upload in `inboxDir` under a name chosen here and register it. The directory is made
   * private (0700), the file 0600, written exclusively (never over an existing file).
   */
  storeUpload(input: { instance: string; inboxDir: string; bytes: Uint8Array; name: string; type: SniffedType }): UploadEntry {
    const part = createPartFile(input.inboxDir);
    try { writeFileSync(part.fd, input.bytes); } catch (err) { removeQuietly(part.path); throw err; } finally { closeSync(part.fd); }
    return this.storeUploadedFile({ instance: input.instance, partPath: part.path, name: input.name, type: input.type });
  }

  /**
   * #1937: register an upload that was streamed to `partPath` (createPartFile(), in the inbox it belongs to): it is
   * linked under its stored name — never over an existing file — and the part goes. The part is removed on failure too.
   */
  storeUploadedFile(input: { instance: string; partPath: string; name: string; type: SniffedType }): UploadEntry {
    const id = randomBytes(16).toString("hex");
    // Stored as web-pending-…: the name says on disk that no message has taken it yet, so a sweep after a restart
    // (which loses this ledger) can still tell an abandoned upload from one an agent got (#1273).
    const path = join(dirname(input.partPath), `${PENDING_PREFIX}${Date.now()}-${id.slice(0, 8)}${input.type.ext}`);
    try {
      const part = lstatSync(input.partPath);
      if (!part.isFile()) throw new Error("the upload's part file is not a regular file");
      linkSync(input.partPath, path);
    } finally { removeQuietly(input.partPath); }
    const st = lstatSync(path);
    const entry: UploadEntry = {
      id, instance: input.instance, path, kind: input.type.kind, mime: input.type.mime,
      name: displayName(input.name, "file"), size: st.size, expiresAt: this.now() + UPLOAD_TTL_MS, state: "pending",
    };
    this.written.set(entry, { dev: st.dev, ino: st.ino });
    this.prune();
    this.uploads.set(id, entry);
    this.registerServed({ id, path, name: entry.name, mime: entry.mime, instance: entry.instance, kind: entry.kind });
    // If no message takes it in time, the file goes when its id does, without waiting for the next upload.
    const sweep = setTimeout(() => this.prune(), UPLOAD_TTL_MS + 1_000);
    sweep.unref?.();
    return entry;
  }

  /**
   * The uploads a message names, all or nothing: each must exist, belong to this instance, not be
   * expired and be waiting for a message; together within the per-message limits. On success they are
   * RESERVED for this message — no other message can take them, no sweep removes them — until the caller
   * says how the delivery went: commit() when it was delivered, release() when it definitely was not.
   */
  takeForMessage(instance: string, ids: readonly string[]): { ok: true; entries: UploadEntry[] } | { ok: false; error: string } {
    const limits = this.limits();
    if (ids.length > limits.maxFiles) return { ok: false, error: `at most ${limits.maxFiles} files per message` };
    if (new Set(ids).size !== ids.length) return { ok: false, error: "the same file twice" };
    const entries: UploadEntry[] = [];
    let total = 0;
    for (const id of ids) {
      const e = isFileId(id) ? this.uploads.get(id) : undefined;
      if (!e || e.state !== "pending" || e.instance !== instance || this.now() >= e.expiresAt) {
        return { ok: false, error: "an attached file is unknown, expired, already sent, or for another chat — attach it again" };
      }
      total += e.size;
      entries.push(e);
    }
    if (total > limits.maxTotalBytes) return { ok: false, error: `the files together are over ${mbText(limits.maxTotalBytes)} MB` };
    // Each file gets its sent name now, before the delivery names it to the agent; all or nothing.
    const moved: UploadEntry[] = [];
    for (const e of entries) {
      if (!this.rename(e, sentPath(e.path))) {
        for (const m of moved) this.rename(m, pendingPath(m.path));
        return { ok: false, error: "an attached file could not be prepared — attach it again" };
      }
      moved.push(e);
    }
    for (const e of entries) e.state = "reserved";
    return { ok: true, entries };
  }

  /** Move an upload's file (same directory) and keep what is served for its id on the new path. */
  private rename(e: UploadEntry, to: string): boolean {
    // Only the regular file this ledger wrote moves (#1304 review): something swapped in on disk — a symlink,
    // a directory, another file (by inode) — is refused, never renamed and never resolved. Checked even when the
    // name is already right (a retry after a release that could not rename back): that is still a take.
    if (!this.isWritten(e, e.path)) return false;
    if (to === e.path) return true;
    try { renameSync(e.path, to); } catch { return false; }
    // And the same file arrived (a swap between the check and the rename): otherwise put it back and refuse.
    try {
      if (!this.isWritten(e, to)) throw new Error("swapped");
    } catch {
      try { renameSync(to, e.path); } catch { /* left under the other name: read() still refuses it */ }
      return false;
    }
    e.path = to;
    // The served path moves by NAME only, in the directory it was registered in: never realpath() the new name,
    // which would bind the id to whatever a link points at. read() still opens it O_NOFOLLOW and re-checks size.
    const served = this.served.get(e.id);
    if (served) served.realPath = join(dirname(served.realPath), basename(to));
    return true;
  }

  /** Is the file at `p` the one this ledger wrote for `e` (regular, same size, same device + inode)? */
  private isWritten(e: UploadEntry, p: string): boolean {
    const written = this.written.get(e);
    try {
      const st = lstatSync(p);
      return !!written && st.isFile() && st.size === e.size && st.dev === written.dev && st.ino === written.ino;
    } catch { return false; }
  }

  /** The files this process still owns — waiting for a message or on their way: a sweep must not touch them. */
  ownedPaths(): Set<string> {
    const out = new Set<string>();
    for (const e of this.uploads.values()) if (e.state !== "sent") out.add(e.path);
    return out;
  }

  /** The reserved uploads were delivered: they are the agent's now. */
  commit(entries: readonly UploadEntry[]): void {
    for (const e of entries) if (this.uploads.get(e.id) === e && e.state === "reserved") e.state = "sent";
  }

  /**
   * The delivery definitely did not happen: the uploads wait for a message again, and the user can retry with the
   * same ids. One whose window closed meanwhile is removed now (file and id) — its sweep has already run.
   */
  release(entries: readonly UploadEntry[]): void {
    for (const e of entries) {
      if (this.uploads.get(e.id) !== e || e.state !== "reserved") continue;
      e.state = "pending";
      this.rename(e, pendingPath(e.path));     // back to "not taken" on disk (if this fails it reads as sent: kept 7 days)
    }
    this.prune();
  }

  /**
   * Make a file fetchable by id (an upload, or a file an agent attached to its reply). The path is
   * resolved now and must be a regular file within the size limit; null when it is not.
   */
  registerServed(input: { id?: string; path: string; name?: string; mime?: string; instance: string; kind?: UploadKind; snapshot?: boolean }): ServedFile | null {
    let realPath: string;
    let size: number;
    let dev: number;
    let ino: number;
    try {
      realPath = realpathSync(input.path);
      const st = statSync(realPath);
      if (!st.isFile() || st.size > this.maxServedBytes()) return null;
      ({ size, dev, ino } = st);
    } catch {
      return null;
    }
    const ext = extname(realPath).toLowerCase();
    const mime = input.mime ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
    const file: ServedFile = {
      id: input.id ?? randomBytes(16).toString("hex"),
      realPath, size, dev, ino, mime, instance: input.instance,
      name: displayName(input.name ?? basename(realPath), "file"),
      kind: input.kind ?? (INLINE_MIME.has(mime) ? "photo" : "document"),
      ...(input.snapshot ? { snapshot: true as const } : {}),
    };
    this.served.set(file.id, file);
    // The cap bounds what this process registered by path. A snapshot is bounded by the history it belongs to (#1770):
    // it leaves with its message, never here — dropping it here would lose a file its message still shows.
    let over = 0;
    for (const f of this.served.values()) if (!f.snapshot) over++;
    over -= this.maxServed;
    for (const [id, f] of this.served) {
      if (over <= 0) break;
      if (!f.snapshot) { this.served.delete(id); over--; }
    }
    return file;
  }

  /**
   * The bytes of a served file, re-checked at read time: opened without following a symlink, still a
   * regular file, still the file (device + inode) and size it was registered with. Null when any of that fails.
   */
  read(id: string): { file: ServedFile; bytes: Buffer } | null {
    const got = this.readSlice(id, 0, Number.MAX_SAFE_INTEGER);
    return got && got.start === 0 && got.bytes.length === got.file.size ? { file: got.file, bytes: got.bytes } : null;
  }

  /**
   * #1937: a served file opened for streaming whole, with read()'s checks on the open descriptor (no symlink followed,
   * a regular file, the device + inode and size it was registered with). The caller closes `fd`. Null when any fails.
   */
  open(id: string): { file: ServedFile; fd: number } | null {
    const file = isFileId(id) ? this.served.get(id) : undefined;
    if (!file) return null;
    let fd: number | null = null;
    try {
      fd = openSync(file.realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (st.isFile() && st.size === file.size && st.dev === file.dev && st.ino === file.ino) { const out = { file, fd }; fd = null; return out; }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
    }
  }

  /** #1937: what is served under an id (no file is opened: open() and read() check the file itself). */
  servedFile(id: string): ServedFile | null {
    return (isFileId(id) ? this.served.get(id) : undefined) ?? null;
  }

  /** #1589: a served file that is audio or video (MEDIA_MIME), or null — the file route plays those by range. */
  mediaOf(id: string): ServedFile | null {
    const file = isFileId(id) ? this.served.get(id) : undefined;
    return file && MEDIA_MIME.has(file.mime) ? file : null;
  }

  /**
   * #1589: bytes `start`…`end` (inclusive, clamped to the file) of a served file, with the same re-checks as read():
   * opened without following a symlink, still a regular file, the same device + inode and size it was registered with.
   * Null when any of that fails, or the range starts past the end.
   */
  readSlice(id: string, start: number, end: number): { file: ServedFile; bytes: Buffer; start: number; end: number } | null {
    const file = isFileId(id) ? this.served.get(id) : undefined;
    if (!file || !Number.isSafeInteger(start) || start < 0) return null;
    let fd: number | null = null;
    try {
      fd = openSync(file.realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== file.size || st.dev !== file.dev || st.ino !== file.ino) return null;
      if (st.size === 0) return start === 0 ? { file, bytes: Buffer.alloc(0), start: 0, end: -1 } : null;
      if (start >= st.size) return null;
      const last = Math.min(end, st.size - 1);
      const length = last - start + 1;
      const bytes = Buffer.alloc(length);
      let off = 0;
      while (off < length) {
        const n = readSync(fd, bytes, off, length - off, start + off);
        if (n <= 0) break;
        off += n;
      }
      return off === length ? { file, bytes, start, end: last } : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  /**
   * #1565: the path to keep with a message's file id, so the file can be served again after a restart — null when
   * nothing is served under the id, or it is an upload no message has taken (web-pending-…): that is never kept.
   */
  storablePath(id: string): string | null {
    const file = isFileId(id) ? this.served.get(id) : undefined;
    return file && !basename(file.realPath).startsWith(PENDING_PREFIX) ? file.realPath : null;
  }

  /**
   * #1565: these ids are no longer shown (their message left the history's window): nothing is served under them.
   * #1770: a snapshot goes from disk with them — the file registered, still that file (device + inode), never a link.
   */
  dropServed(ids: Iterable<string>): void {
    for (const id of ids) {
      const f = this.served.get(id);
      this.served.delete(id);
      if (!f?.snapshot) continue;
      try {
        const st = lstatSync(f.realPath);
        if (st.isFile() && st.dev === f.dev && st.ino === f.ino) unlinkSync(f.realPath);
      } catch { /* already gone */ }
    }
  }

  /** #1770: the ids of an instance's snapshots served now — what a fleet start's sweep keeps. */
  heldSnapshots(instance: string): Set<string> {
    const out = new Set<string>();
    for (const f of this.served.values()) if (f.snapshot && f.instance === instance) out.add(f.id);
    return out;
  }

  /**
   * #1565: serve again, under the id it had, a file a message showed before the fleet restarted — only if it still
   * passes every check: an id of ours in shape; never an upload no message took (web-pending-…); the path itself not a
   * symlink, and a regular file within MAX_SERVED_BYTES; its real path inside this instance's inbox
   * (`workspaces/<instance>/inbox`, itself not a link elsewhere) — or (#1770) inside its reply snapshots
   * (`webFilesDir`, `workspaces/<instance>/web-files`, the same checks), then served as a snapshot again. Null when any
   * check fails (the message then shows the name as unavailable). (Within maxServedBytes(): #1937.) Fetched by id only, as ever: the stored path is the
   * fleet's own file, never a request's.
   */
  restoreServed(entry: { id: unknown; path: unknown; name?: unknown; mime?: unknown; kind?: unknown }, instance: string, inboxDir: string, webFilesDir?: string): ServedFile | null {
    if (typeof entry.id !== "string" || !isFileId(entry.id) || typeof entry.path !== "string" || !entry.path) return null;
    if (basename(entry.path).startsWith(PENDING_PREFIX)) return null;
    let real: string;
    let own: ReturnType<typeof lstatSync>;
    let snapshot = false;
    try {
      own = lstatSync(entry.path);
      if (own.isSymbolicLink() || !own.isFile() || own.size > this.maxServedBytes()) return null;
      real = realpathSync(entry.path);
      // The directory, resolved, must be itself (not a link elsewhere); the file's real path directly under one of them.
      const within = (dir: string | undefined): boolean => {
        if (!dir) return false;
        try {
          const d = realpathSync(dir);
          return d === join(realpathSync(dirname(dir)), basename(dir)) && real.startsWith(d + sep);
        } catch { return false; }
      };
      if (within(webFilesDir)) snapshot = true;
      else if (!within(inboxDir)) return null;
    } catch {
      return null;
    }
    const kind = entry.kind === "photo" || entry.kind === "document" ? entry.kind : undefined;
    const file = this.registerServed({ id: entry.id, path: real, instance, ...(snapshot ? { snapshot } : {}),
      ...(typeof entry.name === "string" ? { name: entry.name } : {}), ...(typeof entry.mime === "string" ? { mime: entry.mime } : {}), ...(kind ? { kind } : {}) });
    // The file checked is the file registered (nothing swapped in between).
    if (file && (file.realPath !== real || file.dev !== own.dev || file.ino !== own.ino)) { this.served.delete(file.id); return null; }
    return file;
  }

  /** Forget an instance's files (it was deleted). The files themselves are its workspace's to remove. */
  forget(instance: string): void {
    for (const [id, e] of this.uploads) if (e.instance === instance) this.uploads.delete(id);
    for (const [id, f] of this.served) if (f.instance === instance) this.served.delete(id);
  }

  /**
   * Drop what is done with. A sent upload leaves the list (the agent has it; the file stays in the inbox, as one
   * from Telegram does). One that expired before any message took it was never seen by anyone but this ledger:
   * its file is deleted with its id, so abandoned uploads do not pile up in the workspace.
   */
  prune(): void {
    const now = this.now();
    for (const [id, e] of this.uploads) {
      if (e.state === "sent") { this.uploads.delete(id); continue; }
      if (e.state === "reserved" || now < e.expiresAt) continue;
      // Only the file this ledger wrote: something swapped in under its name is not ours to delete.
      if (this.isWritten(e, e.path)) try { unlinkSync(e.path); } catch { /* already gone */ }
      this.uploads.delete(id);
      this.served.delete(id);
    }
  }
}

/**
 * The text and meta an agent gets for a message with files — the same tags and keys a Telegram
 * message produces (attachment-handler.ts), so agents need nothing new.
 */
export function attachmentDelivery(message: string, entries: readonly UploadEntry[]): { text: string; meta: Record<string, string> } {
  const photos = entries.filter(e => e.kind === "photo");
  const docs = entries.filter(e => e.kind === "document");
  const meta: Record<string, string> = {};
  const lines: string[] = [];
  if (photos.length) {
    meta.image_path = photos[0]!.path;
    if (photos.length > 1) meta.image_paths = photos.map(p => p.path).join(",");
    for (const p of photos) lines.push(`[📷 Image: ${p.path}]`);
  }
  if (docs.length) {
    meta.attachment_path = docs[0]!.path;
    if (docs.length > 1) meta.attachment_paths = docs.map(d => d.path).join(",");
    for (const d of docs) lines.push(`[📎 File: ${d.name} → ${d.path}]`);
  }
  return { text: lines.length ? `${lines.join("\n")}\n${message}` : message, meta };
}

/** What the chat shows for a file: never the path. */
export function publicAttachment(f: { id: string; kind: UploadKind; name: string; size: number; mime: string }): { id: string; kind: UploadKind; name: string; size: number; mime: string } {
  return { id: f.id, kind: f.kind, name: f.name, size: f.size, mime: f.mime };
}

/** Linux names an open directory by its descriptor: a path through it cannot be redirected by a renamed parent. */
const PROC_FD = process.platform === "linux" ? "/proc/self/fd" : null;

/**
 * At fleet startup (#1273): the ledger of uploads waiting for a message lives in memory, so after a restart an
 * upload no message took is nobody's — its id is gone. Remove each such file (named web-pending-…) in every
 * workspace inbox once it is older than the upload window. Files a message took (web-…, no "pending") are the
 * agent's and follow the inbox's ordinary 7-day rotation, exactly like a file from Telegram; nothing else in an
 * inbox is ever touched here.
 *
 * Age is the file's mtime against the wall clock — the only clock a file has. A future mtime (the clock was set
 * back) counts as just written, never as a negative age, so it is kept and looked at again later; a clock set
 * forward can only remove an upload early, and after a restart none of them can be sent anyway. The uploads this
 * process holds (`owned`, by inbox path) are skipped: their window is the ledger's elapsed time, not a file's mtime.
 * Returns how many were removed and, when younger ones remain, in how long the next one comes due.
 */
export function sweepOrphanedUploads(
  workspacesDir: string,
  nowMs: number = Date.now(),
  ttlMs: number = UPLOAD_TTL_MS,
  owned: ReadonlySet<string> = new Set(),
): { deleted: number; nextDueInMs: number | null } {
  let deleted = 0;
  let nextDueInMs: number | null = null;
  let workspaces: string[];
  let root: string;
  try {
    if (!existsSync(workspacesDir)) return { deleted, nextDueInMs };
    root = realpathSync(workspacesDir);
    workspaces = readdirSync(root);
  } catch { return { deleted, nextDueInMs }; }
  for (const ws of workspaces) {
    // Only real directories inside the workspaces tree (#1304 review): a workspace or an inbox that is a symlink
    // could lead the sweep to delete files anywhere it points.
    const wsDir = join(root, ws);
    const inbox = join(wsDir, "inbox");
    let fd: number | null = null;
    try {
      if (!lstatSync(wsDir).isDirectory() || !lstatSync(inbox).isDirectory()) continue;
      // Pin the inbox: opened as a directory, then checked to be the in-tree one. A parent swapped for a link after
      // this cannot redirect the deletes, which go through the open directory where the platform allows it.
      fd = openSync(inbox, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const pinned = fstatSync(fd);
      const here = lstatSync(inbox);
      if (realpathSync(inbox) !== inbox || pinned.dev !== here.dev || pinned.ino !== here.ino) continue;
      const anchor = PROC_FD && existsSync(`${PROC_FD}/${fd}`) ? `${PROC_FD}/${fd}` : inbox;
      const stillPinned = () => {
        if (anchor !== inbox) return true;
        const now = lstatSync(inbox);
        return now.isDirectory() && now.dev === pinned.dev && now.ino === pinned.ino && realpathSync(inbox) === inbox;
      };
      for (const f of readdirSync(anchor)) {
        if (!f.startsWith(PENDING_PREFIX)) continue;
        // An upload this process holds is governed by its ledger (elapsed time), never by this wall-clock sweep.
        if (owned.has(join(inbox, f))) continue;
        const full = join(anchor, f);
        try {
          const st = lstatSync(full);                 // a symlink is not one of ours: never followed, never removed
          if (!st.isFile()) continue;
          const age = Math.max(0, nowMs - st.mtimeMs);
          if (age >= ttlMs) {
            if (!stillPinned()) break;
            unlinkSync(full); deleted++; continue;
          }
          const due = ttlMs - age;
          if (nextDueInMs === null || due < nextDueInMs) nextDueInMs = due;
        } catch { /* vanished or unreadable: leave it */ }
      }
    } catch { continue; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
  }
  return { deleted, nextDueInMs };
}
