/**
 * AGEND-119: what an Antigravity sign-in's folder says, read locally and never as a credential. agy keeps a sign-in in one file, `antigravity-oauth-token`, in its app-data folder: the default sign-in's
 * is `~/.gemini/antigravity-cli`, a named account's is its own folder under AgEnD's `credential-profiles` (backend/credential-profile.ts). No process is started and no request is made here, and only
 * shapes, dates and booleans leave this module: the file's text is parsed and dropped, never kept, logged or sent, and neither is its path.
 *
 * Built-ins only (it is read by the credential profile table, the keep-alive and the identity reader).
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const AGY_TOKEN_NAME = "antigravity-oauth-token";
const MAX_BYTES = 64 * 1024;

/** What the token file says: whether there is a login in it and when its access token lapses (dates and booleans only). */
export type AntigravityStoreMeta =
  | { state: "ok"; hasRefresh: boolean; expiresAt?: number }
  | { state: "missing" } | { state: "unreadable" };

/** The file's text, only from a regular file that is not a link and not too big; null when there is none, undefined when there is one that cannot be read. */
function readSmallFile(file: string): string | null | undefined {
  let fd: number | null = null;
  try {
    const before = lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES) return undefined;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    return buffer.subarray(0, length).toString("utf8");
  } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* read only */ } } }
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/** The token file's text (for the one reader that names the account), or null (no file) / undefined (not readable). Never keep, log or send it. */
export function readAntigravityTokenText(folder: string): string | null | undefined { return readSmallFile(join(folder, AGY_TOKEN_NAME)); }

/** The token file's own text, parsed and read for shape: `{ token: { access_token, refresh_token, expiry } }` (agy 1.5), or the same fields at the top (a flat file other versions write). */
export function antigravityTokenMeta(text: string): AntigravityStoreMeta {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { state: "unreadable" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "unreadable" };
  const top = value as Record<string, any>, nested = top.token && typeof top.token === "object" ? top.token as Record<string, any> : null;
  const token = nested && (nonEmpty(nested.access_token) || nonEmpty(nested.refresh_token)) ? nested : top;
  if (!nonEmpty(token.access_token) && !nonEmpty(token.refresh_token)) return { state: "missing" };
  const expiry = typeof token.expiry_date === "number" && Number.isFinite(token.expiry_date) ? token.expiry_date : typeof token.expiry === "string" ? Date.parse(token.expiry) : NaN;
  return { state: "ok", hasRefresh: nonEmpty(token.refresh_token), ...(Number.isFinite(expiry) && expiry > 0 ? { expiresAt: expiry } : {}) };
}

/** A folder's sign-in, as dates and booleans (`folder` holds `antigravity-oauth-token`). */
export function readAntigravityStoreMeta(folder: string): AntigravityStoreMeta {
  const text = readSmallFile(join(folder, AGY_TOKEN_NAME));
  if (text === null) return { state: "missing" };
  if (text === undefined) return { state: "unreadable" };
  return antigravityTokenMeta(text);
}

/**
 * Whether a folder holds an Antigravity sign-in: a token in `antigravity-oauth-token`. No file: signed out. A file that cannot be read or is not a token file and no proof in it: null — unknown, never
 * "signed out" (the same answer the other CLIs' readers give, backend/credential-profile.ts `hasLogin`).
 */
export function antigravityStoreHasLogin(folder: string): boolean | null {
  const meta = readAntigravityStoreMeta(folder);
  return meta.state === "ok" ? true : meta.state === "missing" ? false : null;
}
