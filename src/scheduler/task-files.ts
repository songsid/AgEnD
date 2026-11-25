/**
 * Files on task cards. An agent hands the person what it made as a file ON the card — a design document, an
 * HTML prototype, a screenshot — instead of a path on its own machine the person cannot open.
 *
 * Two doors, both on the agent's side first:
 *  1. The agent's own process (the `agend-agent` CLI, or the instance's daemon for the MCP `task` tool) reads the file
 *     (readAgentFile: inside its working directory, no symlink, within the size limit) and STAGES it here in parts
 *     (`receive`): the fleet never opens a path an agent names. A staged file is one the fleet holds under an id.
 *  2. The write that carries the card's comment (update, move, attach) names the ids it staged, and the board LINKS them
 *     to that comment (`adopt` checks them, `commit` moves them under the card). One write: the comment, the files, and
 *     a status change if it came with one, all or nothing.
 *
 * On disk: `<AGEND_HOME>/task-files/<card uuid>/<id>` (0600 in a 0700 folder). The name on disk is the id alone; the
 * file's own name lives in the table (`task_attachments`) and is only ever a label. Staged files wait in
 * `task-files/pending/` until used, and leave after PENDING_TTL_MS. Nothing here is served as a page: the dashboard
 * sends a file as a download (an image only as an image), never as HTML (web-api.ts, GET /ui/tasks/files/<id>).
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TASK_FILE_LIMITS, TASK_FILE_MAX_PARTS, TASK_FILE_PART_BYTES } from "../task-file-limits.js";
import { UploadSniffer, displayName, isFileId } from "../web-upload.js";

export { TASK_FILE_LIMITS, TASK_FILE_MAX_PARTS, TASK_FILE_PART_BYTES };

const MiB = 1024 * 1024;

/** A staged file nobody used is dropped after this long; a part never finished too. */
export const PENDING_TTL_MS = 30 * 60_000;
/** Staged (finished, unused) files one instance may hold at once. */
export const MAX_STAGED_PER_INSTANCE = 20;

export class TaskFileError extends Error {}

export interface StagedFile {
  /** The id it will keep as an attachment: 32 hex. */
  id: string;
  instance: string;
  name: string;
  size: number;
  mime: string;
  kind: "photo" | "document";
  sha256: string;
}

interface Session {
  id: string;
  instance: string;
  name: string;
  count: number;
  bytes: number;
  sha256: string;
  next: number;
  written: number;
  fd: number;
  path: string;
  sniffer: UploadSniffer;
  hash: ReturnType<typeof createHash>;
  at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING = "pending";

/** What a part says, checked: every field is plain data from an agent, never trusted. */
function partOf(raw: unknown): { index: number; count: number; bytes: number; sha256: string; upload?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!whole(p.index) || !whole(p.count) || !whole(p.bytes) || typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) return null;
  if (p.upload !== undefined && (typeof p.upload !== "string" || !isFileId(p.upload))) return null;
  return { index: p.index, count: p.count, bytes: p.bytes, sha256: p.sha256, ...(p.upload ? { upload: p.upload } : {}) };
}

export class TaskFileStore {
  private readonly staged = new Map<string, StagedFile & { expiresAt: number }>();
  private readonly sessions = new Map<string, Session>();      // by instance: one file in parts at a time

  constructor(readonly dir: string, private readonly now: () => number = () => Date.now()) {}

  private pendingDir(): string { return join(this.dir, PENDING); }
  private folder(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }

  /**
   * One part (or the whole file, when it fits one message) of a file an agent stages. Part 0 opens the upload and answers
   * `{ upload }`; the last part finishes it and answers `{ upload, name, size, done: true }`, the same id. A file
   * that is empty, over the limit, out of order or whose bytes and sha256 do not match what part 0 declared is refused,
   * and the upload with it.
   */
  receive(instance: string, args: { name?: unknown; data_b64?: unknown; part?: unknown }): { upload: string; name: string; size?: number; done: boolean } {
    this.sweep();
    if (typeof args.data_b64 !== "string") throw new TaskFileError("data_b64 (the file's bytes, base64) is required");
    const chunk = Buffer.from(args.data_b64, "base64");
    const part = args.part === undefined ? null : partOf(args.part);
    if (args.part !== undefined && !part) throw new TaskFileError("the part is malformed");
    if (!part) {
      if (chunk.length > TASK_FILE_PART_BYTES) throw new TaskFileError(`a file over ${TASK_FILE_PART_BYTES} bytes comes in parts`);
      return this.finish(this.open(instance, args.name, 1, chunk.length, createHash("sha256").update(chunk).digest("hex")), chunk);
    }
    if (part.count < 1 || part.count > TASK_FILE_MAX_PARTS || part.index >= part.count) throw new TaskFileError("the part count is out of range");
    if (part.bytes < 1 || part.bytes > TASK_FILE_LIMITS.fileBytes) throw new TaskFileError(this.tooLarge(part.bytes));
    if (chunk.length > TASK_FILE_PART_BYTES) throw new TaskFileError("a part is too large");
    let session: Session | undefined;
    if (part.index === 0) session = this.open(instance, args.name, part.count, part.bytes, part.sha256);
    else {
      session = this.sessions.get(instance);
      if (!session || session.id !== part.upload || session.next !== part.index || session.count !== part.count || session.bytes !== part.bytes || session.sha256 !== part.sha256) {
        if (session) this.drop(session);
        throw new TaskFileError("the upload is out of order or expired; start the file again");
      }
    }
    return this.finish(session, chunk);
  }

  private tooLarge(bytes: number): string {
    return `a file is at most ${Math.floor(TASK_FILE_LIMITS.fileBytes / MiB)} MiB (this one is ${(bytes / MiB).toFixed(1)} MiB)`;
  }

  private open(instance: string, rawName: unknown, count: number, bytes: number, sha256: string): Session {
    if (bytes < 1) throw new TaskFileError("the file is empty");
    if (bytes > TASK_FILE_LIMITS.fileBytes) throw new TaskFileError(this.tooLarge(bytes));
    let held = 0;
    for (const f of this.staged.values()) if (f.instance === instance) held++;
    if (held >= MAX_STAGED_PER_INSTANCE) throw new TaskFileError(`${held} files are waiting for a comment already; attach them first`);
    const old = this.sessions.get(instance);
    if (old) this.drop(old);
    this.folder(this.pendingDir());
    const id = randomBytes(16).toString("hex");
    const path = join(this.pendingDir(), `${id}.part`);
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const session: Session = {
      id, instance, name: displayName(typeof rawName === "string" ? rawName : "", "file"), count, bytes, sha256, next: 0, written: 0, fd, path,
      sniffer: new UploadSniffer(), hash: createHash("sha256"), at: this.now(),
    };
    this.sessions.set(instance, session);
    return session;
  }

  private finish(session: Session, chunk: Buffer): { upload: string; name: string; size?: number; done: boolean } {
    try {
      if (session.written + chunk.length > session.bytes) throw new TaskFileError("more bytes than the file declared");
      if (chunk.length) {
        let off = 0;
        while (off < chunk.length) off += writeSync(session.fd, chunk, off, chunk.length - off);
        session.sniffer.push(chunk);
        session.hash.update(chunk);
        session.written += chunk.length;
      }
      session.next++;
      session.at = this.now();
      if (session.next < session.count) return { upload: session.id, name: session.name, done: false };
      if (session.written !== session.bytes) throw new TaskFileError("the parts do not add up to the file's size");
      if (session.hash.digest("hex") !== session.sha256) throw new TaskFileError("the file's checksum does not match");
      const type = session.sniffer.result(session.name);
      if (!type) throw new TaskFileError("the file is empty");
      closeSync(session.fd);
      session.fd = -1;
      const final = join(this.pendingDir(), session.id);
      renameSync(session.path, final);
      this.sessions.delete(session.instance);
      this.staged.set(session.id, {
        id: session.id, instance: session.instance, name: session.name, size: session.written, mime: type.mime, kind: type.kind, sha256: session.sha256,
        expiresAt: this.now() + PENDING_TTL_MS,
      });
      return { upload: session.id, name: session.name, size: session.written, done: true };
    } catch (err) {
      this.drop(session);
      throw err;
    }
  }

  private drop(session: Session): void {
    if (session.fd >= 0) { try { closeSync(session.fd); } catch { /* closed */ } session.fd = -1; }
    try { unlinkSync(session.path); } catch { /* gone */ }
    if (this.sessions.get(session.instance) === session) this.sessions.delete(session.instance);
  }

  /** Drop what waited too long: a part never finished, a staged file nobody used. */
  sweep(): void {
    const t = this.now();
    for (const s of this.sessions.values()) if (t - s.at > PENDING_TTL_MS) this.drop(s);
    for (const [id, f] of this.staged) {
      if (f.expiresAt > t) continue;
      this.staged.delete(id);
      try { unlinkSync(join(this.pendingDir(), id)); } catch { /* gone */ }
    }
  }

  /**
   * The staged files `instance` no longer wants — the write that was to use them was refused, or the client gave up half-way: gone at once,
   * not after the wait, so a refused write tried again and again never fills the instance's room (MAX_STAGED_PER_INSTANCE). Another
   * instance's, an unknown id and one already used are left as they are. Returns how many were dropped.
   */
  release(instance: string, ids: readonly string[]): number {
    let dropped = 0;
    for (const id of ids) {
      const f = isFileId(id) ? this.staged.get(id) : undefined;
      if (!f || f.instance !== instance) continue;
      this.staged.delete(id);
      try { unlinkSync(join(this.pendingDir(), id)); } catch { /* gone */ }
      dropped++;
    }
    return dropped;
  }

  /**
   * The staged files `instance` names, checked — each one its own, finished, unused, not named twice — or an error that
   * says which. Nothing moves yet (`commit`), so a refusal later in the same write leaves them staged.
   */
  adopt(instance: string, ids: readonly string[]): StagedFile[] {
    this.sweep();
    if (!ids.length) return [];
    if (ids.length > TASK_FILE_LIMITS.perWrite) throw new TaskFileError(`at most ${TASK_FILE_LIMITS.perWrite} files in one write`);
    const seen = new Set<string>();
    return ids.map((id) => {
      const f = isFileId(id) ? this.staged.get(id) : undefined;
      if (!f || f.instance !== instance) throw new TaskFileError("an attached file is no longer staged (it waited too long, or was used); attach it again");
      if (seen.has(id)) throw new TaskFileError("the same file is named twice");
      seen.add(id);
      const { expiresAt: _e, ...file } = f;
      return file;
    });
  }

  /**
   * Move a staged file under its card; returns a function that moves it back (the write that linked it failed after).
   * A staged file is the fleet's own regular file (`receive` wrote it with O_EXCL, 0600): a final check that it still is.
   */
  commit(taskUuid: string, file: StagedFile): () => void {
    if (!UUID.test(taskUuid) || !isFileId(file.id)) throw new TaskFileError("not a card file");
    const from = join(this.pendingDir(), file.id);
    const folder = join(this.dir, taskUuid);
    this.folder(folder);
    const to = join(folder, file.id);
    const fd = openSync(from, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { if (!fstatSync(fd).isFile()) throw new TaskFileError("not a regular file"); } finally { closeSync(fd); }
    renameSync(from, to);
    this.staged.delete(file.id);
    return () => {
      try { renameSync(to, from); } catch { /* the sweep removes it */ }
      this.staged.set(file.id, { ...file, expiresAt: this.now() + PENDING_TTL_MS });
    };
  }

  /** A card's file on disk, by the ids the table holds; null when either is not what it should be, or the file is gone. */
  pathOf(taskUuid: string, id: string): { path: string; size: number } | null {
    if (!UUID.test(taskUuid) || !isFileId(id)) return null;
    const path = join(this.dir, taskUuid, id);
    try {
      const st = statSync(path);
      return st.isFile() ? { path, size: st.size } : null;
    } catch { return null; }
  }

  /** A card's folder and everything in it (the card was pruned). */
  removeCard(taskUuid: string): void {
    if (!UUID.test(taskUuid)) return;
    try { rmSync(join(this.dir, taskUuid), { recursive: true, force: true }); } catch { /* the next sweep tries again */ }
  }

  /** One file (its row is gone). */
  removeFile(taskUuid: string, id: string): void {
    if (!UUID.test(taskUuid) || !isFileId(id)) return;
    try { unlinkSync(join(this.dir, taskUuid, id)); } catch { /* gone */ }
  }

  /**
   * Files on disk the table does not know — a folder for a card that no longer exists, a file whose row never committed,
   * staged files from before a restart. `known(uuid)` lists the ids the table holds for a card, or null for a card the
   * board no longer has.
   */
  sweepOrphans(known: (taskUuid: string) => ReadonlySet<string> | null): number {
    let removed = 0;
    let entries: string[] = [];
    try { entries = readdirSync(this.dir); } catch { return 0; }
    const held = new Set<string>([...this.staged.keys(), ...[...this.sessions.values()].map((s) => `${s.id}.part`)]);
    for (const name of entries) {
      const folder = join(this.dir, name);
      if (name === PENDING) {
        let pend: string[] = [];
        try { pend = readdirSync(folder); } catch { continue; }
        for (const f of pend) {
          if (held.has(f)) continue;
          try { unlinkSync(join(folder, f)); removed++; } catch { /* gone */ }
        }
        continue;
      }
      if (!UUID.test(name)) continue;
      const ids = known(name);
      if (!ids) { this.removeCard(name); removed++; continue; }
      let files: string[] = [];
      try { files = readdirSync(folder); } catch { continue; }
      for (const f of files) if (!ids.has(f)) { try { unlinkSync(join(folder, f)); removed++; } catch { /* gone */ } }
    }
    return removed;
  }
}
