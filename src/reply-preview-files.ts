import { constants } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { extname, sep } from "node:path";
import { workspaceRoot, placeOf, isHiddenPath, WorkspaceError, WORKSPACE_LIMITS } from "./agent-workspace.js";
import { isReplyPreviewPath } from "./reply-preview-spec.js";

export const REPLY_PREVIEW_ASSET_BYTES = 95 * 1024 * 1024;
const IMAGES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
export class ReplyPreviewError extends Error { constructor(readonly code: string, readonly size?: number) { super(code); } }
type Meta = { kind: "text"; path: string; size: number; text: string } | { kind: "image" | "pdf"; path: string; size: number; mime: string } | { kind: "binary" | "too_large"; path: string; size: number };
export type ReplyPreviewRead = { kind: "meta"; body: Meta } | { kind: "raw"; bytes: Buffer; mime: string; size: number; start: number; end: number; partial: boolean };
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
function rangeOf(value: string | undefined, size: number): { start: number; end: number; partial: boolean } {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2]) || !size) throw new ReplyPreviewError("range_not_satisfiable", size);
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size || (!m[1] && Number(m[2]) < 1)) throw new ReplyPreviewError("range_not_satisfiable", size);
  return { start, end, partial: true };
}
/** Read one file only. The opened descriptor, canonical path and current session/config must agree. */
export async function readReplyPreview(workingDirectory: string, stateDir: string, path: unknown, raw: boolean, current: () => boolean, range?: string): Promise<ReplyPreviewRead> {
  const check = () => { if (!current()) throw new ReplyPreviewError("preview_changed"); };
  if (typeof path !== "string" || !isReplyPreviewPath(path)) throw new ReplyPreviewError("outside");
  let fh: FileHandle | null = null;
  try {
    check(); const ws = await workspaceRoot(workingDirectory, stateDir); check();
    const place = await placeOf(ws, path); check();
    if (isHiddenPath(place.rel)) throw new ReplyPreviewError("hidden");
    const before = await lstat(place.abs); check();
    if (before.isSymbolicLink()) throw new ReplyPreviewError("symlink");
    if (!before.isFile()) throw new ReplyPreviewError("not_a_file");
    fh = await open(place.abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY); check();
    const opened = await fh.stat(); check();
    const canonical = await realpath(place.abs); check();
    const named = await stat(canonical); check();
    if (!under(canonical, ws.root) || (ws.state && under(canonical, ws.state))) throw new ReplyPreviewError("outside");
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.dev !== named.dev || opened.ino !== named.ino) throw new ReplyPreviewError("preview_changed");
    const size = opened.size, ext = extname(place.rel).toLowerCase(), mime = ext === ".pdf" ? "application/pdf" : IMAGES[ext];
    if (size > (mime ? REPLY_PREVIEW_ASSET_BYTES : WORKSPACE_LIMITS.fileBytes)) {
      if (raw) throw new ReplyPreviewError("too_large");
      return { kind: "meta", body: { kind: "too_large", path: place.rel, size } };
    }
    if (mime === "application/pdf") {
      const magic = Buffer.alloc(5); await fh.read(magic, 0, 5, 0); check();
      if (magic.toString() !== "%PDF-") throw new ReplyPreviewError("not_a_file");
    }
    if (!raw && mime) return { kind: "meta", body: { kind: ext === ".pdf" ? "pdf" : "image", path: place.rel, size, mime } };
    if (raw && !mime) throw new ReplyPreviewError("not_a_file");
    const slice = raw ? rangeOf(range, size) : { start: 0, end: size - 1, partial: false };
    const bytes = Buffer.alloc(Math.max(0, slice.end - slice.start + 1));
    let off = 0;
    while (off < bytes.length) { const r = await fh.read(bytes, off, bytes.length - off, slice.start + off); check(); if (!r.bytesRead) break; off += r.bytesRead; }
    const after = await fh.stat(); check();
    if (off !== bytes.length || after.size !== size || after.mtimeMs !== opened.mtimeMs) throw new ReplyPreviewError("preview_changed");
    if (raw) return { kind: "raw", bytes, mime: mime!, size, ...slice };
    return { kind: "meta", body: bytes.subarray(0, 8192).includes(0) ? { kind: "binary", path: place.rel, size } : { kind: "text", path: place.rel, size, text: new TextDecoder().decode(bytes) } };
  } catch (error) {
    if (error instanceof ReplyPreviewError) throw error;
    if (error instanceof WorkspaceError) throw new ReplyPreviewError(error.code);
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReplyPreviewError(code === "ENOENT" || code === "ENOTDIR" ? "not_found" : code === "ELOOP" ? "symlink" : "unavailable");
  } finally { if (fh) await fh.close(); }
}
