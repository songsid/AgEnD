/**
 * #3153 P1: a read-only look at an agent's working directory, for the web's Files / Changes side panel.
 *
 * - **Scope:** only the agent's configured `working_directory` (realpath). Every path is resolved and must stay under
 *   it. A symlink is listed but never followed (its target is neither read nor described). `..`, absolute paths, NUL
 *   and device or FIFO files are refused. AgEnD's own state directory is never shown, even inside the folder.
 * - **Secrets:** a fixed deny-list by name (`.env*`, keys, certificates, credential and secret files, `.git`, `.ssh`,
 *   …). Such a file is listed as hidden; its contents are never read or sent, and its diff is left out.
 * - **Limits:**
 *   - a file over 1 MiB is not read;
 *   - the diff stops at 2 MiB or 500 files;
 *   - a directory lists at most 1,000 entries;
 *   - git runs with a timeout and a byte cap.
 *   Every cut is said, never silent.
 * - **git:** only read-only commands (`status`, `diff`, `ls-files`, `check-ignore`, `rev-parse`), never a pager, with
 *   `GIT_OPTIONAL_LOCKS=0` (no index refresh), and with fsmonitor, external diff and textconv switched off. Nothing in
 *   the folder is executed by this module, and nothing is written.
 *
 * Callers (web-api.ts) decide who may ask: the fleet's local admin session only.
 */
import { execFile } from "./child-process.js";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";

export const WORKSPACE_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  diffBytes: 2 * 1024 * 1024,
  diffFiles: 500,
  /** One file's share of the diff: a bigger one is listed as "too large to show" (the others still fit). */
  fileDiffBytes: 256 * 1024,
  dirEntries: 1000,
  untrackedDiffFiles: 50,
  gitTimeoutMs: 10_000,
});
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Names whose contents never leave the machine through this view (fixed in P1, #3153). Lowercase compare. */
const HIDDEN_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config", ".agend", ".claude", ".codex", ".kiro"]);
const HIDDEN_FILES = new Set([".npmrc", ".netrc", ".pypirc", ".git-credentials", ".pgpass", "credentials", "credentials.json", "auth.json", "secrets.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts", "authorized_keys", ".htpasswd",
  // Fable on #3158: tool credentials and shell histories (a history holds whatever was typed, tokens included).
  ".envrc", ".vault-token", ".s3cfg", ".boto", "kubeconfig", ".kubeconfig", "terraform.tfstate", "terraform.tfstate.backup"]);
/** Whether a path (relative, `/`-separated) is hidden: any part a hidden directory, or its name a secret-looking file. */
export function isHiddenPath(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  for (const p of parts.slice(0, -1)) if (HIDDEN_DIRS.has(p.toLowerCase())) return true;
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (HIDDEN_DIRS.has(name) || HIDDEN_FILES.has(name)) return true;
  if (/^\.env(?:$|[.-])/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name)) return true;
  if (/\.(?:pem|key|p12|p8|pfx|jks|keystore|kdbx|asc|gpg|ppk|token|env|tfvars|tfstate)$/.test(name) || /\.tfstate\./.test(name)) return true;
  if (/^service[-_]?account.*\.json$/.test(name) || /^\.[a-z0-9]*_?history$/.test(name) || /^\.?kubeconfig(?:[.-]|$)/.test(name)) return true;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwords|private[-_]?key)(?:[._-]|$)/.test(name)) return true;
  return false;
}

export type WorkspaceRefusal = "not_found" | "not_a_directory" | "outside" | "hidden" | "symlink" | "not_a_file" | "invalid";
export class WorkspaceError extends Error { constructor(readonly code: WorkspaceRefusal) { super(code); } }

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export interface WorkspaceRoot { root: string; state: string | null }
/** The agent's folder (realpath) and AgEnD's state directory, when it is inside the folder. */
export async function workspaceRoot(workingDirectory: string, agendHome: string): Promise<WorkspaceRoot> {
  if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) throw new WorkspaceError("not_a_directory");
  let root: string;
  try { root = await realpath(workingDirectory); } catch { throw new WorkspaceError("not_found"); }
  const st = await lstat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new WorkspaceError("not_a_directory");
  let state: string | null = null;
  try { const s = await realpath(agendHome); if (under(s, root)) state = s; } catch { /* no state directory */ }
  return { root, state };
}

/**
 * A request's relative path → its place under the root, refused when it is not plainly inside: no absolute path, no
 * `..`, no NUL or control characters; and no part of it (or the place itself, via realpath) outside the root or in
 * AgEnD's state. `allowRoot`: the empty path is the root itself (a directory listing).
 */
export async function placeOf(ws: WorkspaceRoot, rel: unknown, allowRoot = false): Promise<{ abs: string; rel: string }> {
  if (typeof rel !== "string" || rel.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(rel)) throw new WorkspaceError("invalid");
  if (rel === "" || rel === "/") { if (allowRoot) return { abs: ws.root, rel: "" }; throw new WorkspaceError("invalid"); }
  if (isAbsolute(rel) || rel.startsWith("/")) throw new WorkspaceError("outside");
  const clean = rel.replace(/\/+$/g, "");
  if (clean.split("/").some((p) => p === "" || p === "." || p === "..")) throw new WorkspaceError("outside");
  const abs = resolve(ws.root, clean);
  if (!under(abs, ws.root)) throw new WorkspaceError("outside");
  // Every parent must be a real directory under the root (a symlinked directory is never walked through).
  let at = ws.root;
  for (const part of clean.split("/").slice(0, -1)) {
    at = join(at, part);
    const st = await lstat(at).catch(() => null);
    if (!st) throw new WorkspaceError("not_found");
    if (st.isSymbolicLink()) throw new WorkspaceError("symlink");
    if (!st.isDirectory()) throw new WorkspaceError("not_a_directory");
  }
  if (ws.state && under(abs, ws.state)) throw new WorkspaceError("hidden");
  return { abs, rel: clean };
}

// ── git ──

function git(root: string, args: readonly string[], maxBytes: number): Promise<{ ok: boolean; out: Buffer; cut: boolean }> {
  return new Promise((done) => {
    const child = execFile("git", ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.pager=cat",
      "-c", "diff.external=", "-c", "color.ui=false", ...args],
    { encoding: "buffer", timeout: WORKSPACE_LIMITS.gitTimeoutMs, maxBuffer: maxBytes, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } },
    (err, stdout) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
      const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
      if (e && e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") { done({ ok: true, out, cut: true }); return; }
      // `git diff --no-index` answers 1 when the files differ: that is its success.
      done({ ok: !e || (e as { code?: unknown }).code === 1, out, cut: false });
    });
    child.stdin?.end();
  });
}
async function isRepo(root: string): Promise<boolean> {
  const r = await git(root, ["rev-parse", "--is-inside-work-tree"], 4096);
  return r.ok && r.out.toString("utf8").trim() === "true";
}

export interface WorkspaceChange { path: string; status: string; adds: number | null; dels: number | null; binary: boolean; hidden: boolean; untracked: boolean; tooLarge?: boolean }
export interface WorkspaceChanges {
  repo: boolean; branch: string | null; files: WorkspaceChange[]; patch: string;
  cut: { files: boolean; bytes: boolean }; hiddenCount: number;
}

/**
 * Changes: git status plus the diff of everything uncommitted against HEAD (staged and unstaged together, P1), and the
 * untracked files git does not ignore, as additions. Hidden files are listed without their diff.
 */
export async function workspaceChanges(ws: WorkspaceRoot): Promise<WorkspaceChanges> {
  if (!(await isRepo(ws.root))) return { repo: false, branch: null, files: [], patch: "", cut: { files: false, bytes: false }, hiddenCount: 0 };
  const branchR = await git(ws.root, ["rev-parse", "--abbrev-ref", "HEAD"], 4096);
  const branch = branchR.ok ? branchR.out.toString("utf8").trim() || null : null;
  const hasHead = (await git(ws.root, ["rev-parse", "--verify", "-q", "HEAD"], 4096)).out.length > 0;
  const base = hasHead ? "HEAD" : EMPTY_TREE;
  const status = await git(ws.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], 4 * 1024 * 1024);
  const files: WorkspaceChange[] = [];
  const entries = status.out.toString("utf8").split("\u0000").filter(Boolean);
  let cutFiles = false;
  for (const e of entries) {
    if (files.length >= WORKSPACE_LIMITS.diffFiles) { cutFiles = true; break; }
    const code = e.slice(0, 2), path = e.slice(3);
    if (!path || (ws.state && under(resolve(ws.root, path), ws.state))) continue;
    const untracked = code === "??";
    files.push({ path, status: untracked ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : "modified",
      adds: null, dels: null, binary: false, hidden: isHiddenPath(path), untracked });
  }
  // Line counts for tracked changes (numstat: "-\t-" is binary).
  const numstat = await git(ws.root, ["diff", base, "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"], 4 * 1024 * 1024);
  const counts = new Map<string, { adds: number | null; dels: number | null; binary: boolean }>();
  for (const row of numstat.out.toString("utf8").split("\u0000").filter(Boolean)) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(row);
    if (m) counts.set(m[3]!, { adds: m[1] === "-" ? null : Number(m[1]), dels: m[2] === "-" ? null : Number(m[2]), binary: m[1] === "-" });
  }
  for (const f of files) { const c = counts.get(f.path); if (c) Object.assign(f, c); }
  // The patch: tracked changes (hidden paths excluded by pathspec), then untracked text files as additions.
  const visibleTracked = files.filter((f) => !f.untracked && !f.hidden).map((f) => f.path);
  // Each file's section is kept only within its own share and the whole budget: one huge file never starves the rest.
  let patch = "", cutBytes = false;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const take = (section: string, f: WorkspaceChange | undefined) => {
    const n = Buffer.byteLength(section);
    if (n > WORKSPACE_LIMITS.fileDiffBytes) { if (f) f.tooLarge = true; return; }
    if (Buffer.byteLength(patch) + n > WORKSPACE_LIMITS.diffBytes) { cutBytes = true; if (f) f.tooLarge = true; return; }
    patch += section;
  };
  if (visibleTracked.length) {
    const r = await git(ws.root, ["diff", base, "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3", "--", ...visibleTracked.map((p) => `:(literal)${p}`)], 16 * 1024 * 1024);
    if (r.cut) cutBytes = true;
    for (const section of r.out.toString("utf8").split(/(?=^diff --git )/m).filter(Boolean)) {
      const m = /^diff --git a\/(.*?) b\//.exec(section);
      take(section, m ? byPath.get(m[1]!) : undefined);
    }
  }
  let untrackedShown = 0;
  for (const f of files) {
    if (!f.untracked || f.hidden) continue;
    if (untrackedShown >= WORKSPACE_LIMITS.untrackedDiffFiles) { cutFiles = true; break; }
    const abs = resolve(ws.root, f.path);
    const st = await lstat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;                                          // a link or a special file: listed, no diff
    if (st.size > WORKSPACE_LIMITS.fileDiffBytes) { f.tooLarge = true; continue; }
    const r = await git(ws.root, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", f.path], WORKSPACE_LIMITS.fileDiffBytes * 2);
    const text = r.out.toString("utf8");
    if (/^Binary files /m.test(text)) { f.binary = true; continue; }
    f.adds = (text.match(/^\+(?!\+\+)/gm) ?? []).length; f.dels = 0;
    take(text, f); untrackedShown++;
  }
  return { repo: true, branch, files, patch, cut: { files: cutFiles, bytes: cutBytes }, hiddenCount: files.filter((f) => f.hidden).length };
}

// ── the tree ──

export interface WorkspaceEntry { name: string; type: "dir" | "file" | "symlink" | "other"; size: number | null; hidden: boolean }
/** One directory's entries (directories first, then names), gitignored ones left out in a repository. */
export async function workspaceList(ws: WorkspaceRoot, rel: unknown): Promise<{ path: string; entries: WorkspaceEntry[]; cut: boolean }> {
  const place = await placeOf(ws, rel ?? "", true);
  const st = await lstat(place.abs).catch(() => null);
  if (!st) throw new WorkspaceError("not_found");
  if (st.isSymbolicLink()) throw new WorkspaceError("symlink");
  if (!st.isDirectory()) throw new WorkspaceError("not_a_directory");
  if (place.rel && isHiddenPath(place.rel)) throw new WorkspaceError("hidden");
  const names = (await readdir(place.abs)).sort();
  let ignored = new Set<string>();
  if (await isRepo(ws.root)) {
    const candidates = names.map((n) => (place.rel ? `${place.rel}/${n}` : n));
    if (candidates.length) {
      const r = await new Promise<Buffer>((done) => {
        const child = execFile("git", ["-C", ws.root, "-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
          { encoding: "buffer", timeout: WORKSPACE_LIMITS.gitTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } },
          (_err, out) => done(Buffer.isBuffer(out) ? out : Buffer.alloc(0)));
        child.stdin?.end(candidates.join("\u0000") + "\u0000");
      });
      ignored = new Set(r.toString("utf8").split("\u0000").filter(Boolean));
    }
  }
  const entries: WorkspaceEntry[] = [];
  let cut = false;
  for (const name of names) {
    const childRel = place.rel ? `${place.rel}/${name}` : name;
    if (ignored.has(childRel)) continue;
    const abs = join(place.abs, name);
    if (ws.state && under(abs, ws.state)) continue;
    if (entries.length >= WORKSPACE_LIMITS.dirEntries) { cut = true; break; }
    const s = await lstat(abs).catch(() => null);
    if (!s) continue;
    const type = s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
    entries.push({ name, type, size: type === "file" ? s.size : null, hidden: isHiddenPath(childRel) });
  }
  entries.sort((a, b) => (a.type === "dir") === (b.type === "dir") ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === "dir" ? -1 : 1);
  return { path: place.rel, entries, cut };
}

// ── one file ──

export type WorkspaceFile =
  | { kind: "text"; path: string; size: number; text: string }
  | { kind: "image"; path: string; size: number; mime: string }
  | { kind: "binary" | "too_large"; path: string; size: number };

/** Open a regular file under the root without following a symlink (O_NOFOLLOW), never waiting on a FIFO (O_NONBLOCK). */
async function openPlain(ws: WorkspaceRoot, rel: unknown) {
  const place = await placeOf(ws, rel);
  if (isHiddenPath(place.rel)) throw new WorkspaceError("hidden");
  const st = await lstat(place.abs).catch(() => null);
  if (!st) throw new WorkspaceError("not_found");
  if (st.isSymbolicLink()) throw new WorkspaceError("symlink");
  if (!st.isFile()) throw new WorkspaceError("not_a_file");
  const fh = await open(place.abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY).catch(() => { throw new WorkspaceError("not_a_file"); });
  const fst = await fh.stat();
  if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev) { await fh.close(); throw new WorkspaceError("not_a_file"); }
  return { place, fh, size: fst.size };
}

/** A file as the viewer shows it: text (UTF-8, up to 1 MiB), an image (served raw by `workspaceImage`), or why not. */
export async function workspaceFile(ws: WorkspaceRoot, rel: unknown): Promise<WorkspaceFile> {
  const { place, fh, size } = await openPlain(ws, rel);
  try {
    const mime = IMAGE_TYPES[extname(place.rel).toLowerCase()];
    if (mime) return { kind: size > WORKSPACE_LIMITS.fileBytes * 8 ? "too_large" : "image", path: place.rel, size, ...(size > WORKSPACE_LIMITS.fileBytes * 8 ? {} : { mime }) } as WorkspaceFile;
    if (size > WORKSPACE_LIMITS.fileBytes) return { kind: "too_large", path: place.rel, size };
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    const bytes = buf.subarray(0, bytesRead);
    if (bytes.subarray(0, 8192).includes(0)) return { kind: "binary", path: place.rel, size };
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return { kind: "text", path: place.rel, size, text };
  } finally { await fh.close(); }
}
/** An image's bytes for the viewer's <img> (a known image extension only, at most 8 MiB). */
export async function workspaceImage(ws: WorkspaceRoot, rel: unknown): Promise<{ mime: string; bytes: Buffer }> {
  const { place, fh, size } = await openPlain(ws, rel);
  try {
    const mime = IMAGE_TYPES[extname(place.rel).toLowerCase()];
    if (!mime || size > WORKSPACE_LIMITS.fileBytes * 8) throw new WorkspaceError("not_a_file");
    const buf = Buffer.alloc(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    return { mime, bytes: buf.subarray(0, bytesRead) };
  } finally { await fh.close(); }
}

export const workspaceName = (rel: string) => basename(rel);
