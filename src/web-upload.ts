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
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const UPLOAD_LIMITS = {
  /** One file. */
  maxFileBytes: 10 * 1024 * 1024,
  /** Files on one message. */
  maxFiles: 5,
  /** All files on one message together. */
  maxTotalBytes: 25 * 1024 * 1024,
} as const;

/** How long an uploaded file waits to be sent with a message before its id stops working. */
export const UPLOAD_TTL_MS = 30 * 60 * 1000;

/** An upload no message has taken yet is stored under this prefix; it drops the prefix when a message takes it. */
export const PENDING_PREFIX = "web-pending-";
function sentPath(p: string): string { const b = basename(p); return b.startsWith(PENDING_PREFIX) ? join(dirname(p), "web-" + b.slice(PENDING_PREFIX.length)) : p; }
function pendingPath(p: string): string { const b = basename(p); return b.startsWith("web-") && !b.startsWith(PENDING_PREFIX) ? join(dirname(p), PENDING_PREFIX + b.slice(4)) : p; }
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
  ".txt", ".md", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".xml", ".html", ".css",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".sh", ".sql", ".toml", ".ini", ".diff", ".patch",
]);

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/**
 * The type of an upload, from its bytes. Images by signature (PNG, JPEG, GIF, WebP), PDF by `%PDF-`,
 * text when it is valid UTF-8 with no NUL byte. Everything else is refused — no executable, archive or
 * office format is guessed at.
 */
export function sniffUpload(bytes: Uint8Array, name: string): SniffedType | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "photo", mime: "image/png", ext: ".png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "photo", mime: "image/jpeg", ext: ".jpg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: "photo", mime: "image/gif", ext: ".gif" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { kind: "photo", mime: "image/webp", ext: ".webp" };
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "document", mime: "application/pdf", ext: ".pdf" };
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const ext = extname(name).toLowerCase();
  return { kind: "document", mime: "text/plain; charset=utf-8", ext: TEXT_EXTENSIONS.has(ext) ? ext : ".txt" };
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
  /** The instance whose chat shows it. */
  instance: string;
  kind: UploadKind;
}

const ID_PATTERN = /^[0-9a-f]{32}$/;
export const isFileId = (id: string): boolean => ID_PATTERN.test(id);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8", ".json": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
};
/** Images the browser may show inline; everything else is served as a download. */
export const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Uploads waiting for their message, and every file the dashboard may fetch back. In memory: ids from
 * before a restart stop working (the files stay in the inbox, where the agent got them).
 */
export class WebFileLedger {
  private readonly uploads = new Map<string, UploadEntry>();
  private readonly served = new Map<string, ServedFile>();
  private readonly now: () => number;
  private readonly maxServed: number;

  constructor(opts: { now?: () => number; maxServed?: number } = {}) {
    // Elapsed time, like the sweep timer below: a wall-clock jump must neither expire an upload early nor keep
    // one past the timer that was meant to remove it (#1252 review).
    this.now = opts.now ?? (() => performance.now());
    this.maxServed = opts.maxServed ?? 2000;
  }

  /**
   * Store an upload in `inboxDir` under a name chosen here and register it. The directory is made
   * private (0700), the file 0600, written exclusively (never over an existing file).
   */
  storeUpload(input: { instance: string; inboxDir: string; bytes: Uint8Array; name: string; type: SniffedType }): UploadEntry {
    mkdirSync(input.inboxDir, { recursive: true, mode: 0o700 });
    const id = randomBytes(16).toString("hex");
    // Stored as web-pending-…: the name says on disk that no message has taken it yet, so a sweep after a restart
    // (which loses this ledger) can still tell an abandoned upload from one an agent got (#1273).
    const path = join(input.inboxDir, `${PENDING_PREFIX}${Date.now()}-${id.slice(0, 8)}${input.type.ext}`);
    writeFileSync(path, input.bytes, { mode: 0o600, flag: "wx" });
    const entry: UploadEntry = {
      id, instance: input.instance, path, kind: input.type.kind, mime: input.type.mime,
      name: displayName(input.name, "file"), size: input.bytes.length, expiresAt: this.now() + UPLOAD_TTL_MS, state: "pending",
    };
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
    if (ids.length > UPLOAD_LIMITS.maxFiles) return { ok: false, error: `at most ${UPLOAD_LIMITS.maxFiles} files per message` };
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
    if (total > UPLOAD_LIMITS.maxTotalBytes) return { ok: false, error: `the files together are over ${UPLOAD_LIMITS.maxTotalBytes / 1024 / 1024} MB` };
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
    if (to === e.path) return true;
    try { renameSync(e.path, to); } catch { return false; }
    e.path = to;
    const served = this.served.get(e.id);
    if (served) { try { served.realPath = realpathSync(to); } catch { this.served.delete(e.id); } }
    return true;
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
  registerServed(input: { id?: string; path: string; name?: string; mime?: string; instance: string; kind?: UploadKind }): ServedFile | null {
    let realPath: string;
    let size: number;
    try {
      realPath = realpathSync(input.path);
      const st = statSync(realPath);
      if (!st.isFile() || st.size > MAX_SERVED_BYTES) return null;
      size = st.size;
    } catch {
      return null;
    }
    const ext = extname(realPath).toLowerCase();
    const mime = input.mime ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
    const file: ServedFile = {
      id: input.id ?? randomBytes(16).toString("hex"),
      realPath, size, mime, instance: input.instance,
      name: displayName(input.name ?? basename(realPath), "file"),
      kind: input.kind ?? (INLINE_MIME.has(mime) ? "photo" : "document"),
    };
    this.served.set(file.id, file);
    while (this.served.size > this.maxServed) this.served.delete(this.served.keys().next().value!);
    return file;
  }

  /**
   * The bytes of a served file, re-checked at read time: opened without following a symlink, still a
   * regular file, still the size it was registered with. Null when any of that fails.
   */
  read(id: string): { file: ServedFile; bytes: Buffer } | null {
    const file = isFileId(id) ? this.served.get(id) : undefined;
    if (!file) return null;
    let fd: number | null = null;
    try {
      fd = openSync(file.realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== file.size) return null;
      const bytes = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, bytes, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      return off === st.size ? { file, bytes } : null;
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
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
      try { unlinkSync(e.path); } catch { /* already gone */ }
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

/**
 * At fleet startup (#1273): the ledger of uploads waiting for a message lives in memory, so after a restart an
 * upload no message took is nobody's — its id is gone. Remove each such file (named web-pending-…) in every
 * workspace inbox once it is older than the upload window. Files a message took (web-…, no "pending") are the
 * agent's and follow the inbox's ordinary 7-day rotation, exactly like a file from Telegram; nothing else in an
 * inbox is ever touched here.
 *
 * Age is the file's mtime against the wall clock — the only clock a file has. A future mtime (the clock was set
 * back) counts as just written, never as a negative age, so it is kept and looked at again later; a clock set
 * forward can only remove an upload early, and after a restart none of them can be sent anyway.
 * Returns how many were removed and, when younger ones remain, in how long the next one comes due.
 */
export function sweepOrphanedUploads(workspacesDir: string, nowMs: number = Date.now(), ttlMs: number = UPLOAD_TTL_MS): { deleted: number; nextDueInMs: number | null } {
  let deleted = 0;
  let nextDueInMs: number | null = null;
  let workspaces: string[];
  try { workspaces = existsSync(workspacesDir) ? readdirSync(workspacesDir) : []; } catch { return { deleted, nextDueInMs }; }
  for (const ws of workspaces) {
    const inbox = join(workspacesDir, ws, "inbox");
    let files: string[];
    try { files = readdirSync(inbox); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith(PENDING_PREFIX)) continue;
      const full = join(inbox, f);
      try {
        const st = lstatSync(full);                 // a symlink is not one of ours: never followed, never removed
        if (!st.isFile()) continue;
        const age = Math.max(0, nowMs - st.mtimeMs);
        if (age >= ttlMs) { unlinkSync(full); deleted++; continue; }
        const due = ttlMs - age;
        if (nextDueInMs === null || due < nextDueInMs) nextDueInMs = due;
      } catch { /* vanished or unreadable: leave it */ }
    }
  }
  return { deleted, nextDueInMs };
}
