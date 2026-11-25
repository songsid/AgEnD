/**
 * M-3770 slice 2.1a (design `docs/design/update-transaction-m3770.md` §2, §2.6, §7): the update attempt journal.
 *
 *   <home>/.update-journal/
 *     current                       the open attempt's id — THE authority for "an attempt is open" (§2.4/2.5)
 *     attempts/<id>/attempt.json    the record, replaced atomically
 *     attempts/<id>/inbox|deferred|cancel   the fleet's files (§2.6)
 *     marks.json                    append-only: versions that rolled back here
 *
 * Publication order (§2.4): an attempt's record is durable before `current` names it; a terminal record is durable
 * (and a rollback's mark before it) before `current` is cleared. Readers (§2.5): only an absent `current` is "none";
 * anything present but unreadable is "unknown", which blocks. Every durable step goes through `JournalIo.step`, so a
 * test can crash the writer after any one of them.
 *
 * Synchronous on purpose: the updater and a fleet start read and write it before anything else runs.
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, parse as parsePath } from "node:path";

export type Stage =
  | "opened" | "barrier" | "stopping" | "abandoning" | "abandoned"
  | "snapshotted" | "installing" | "trial" | "proving" | "committing" | "committed"
  | "rolling-back" | "rolled-back" | "manual-recovery";
export type Outcome = "committed" | "rolled-back" | "abandoned" | "manual-recovery";
export const TERMINAL: ReadonlySet<Stage> = new Set<Stage>(["committed", "rolled-back", "abandoned", "manual-recovery"]);

/** §2.3: the allowed transitions. `manual-recovery` is reachable from any non-terminal stage. */
const NEXT: Readonly<Record<Stage, readonly Stage[]>> = {
  opened: ["barrier", "abandoning"],
  barrier: ["stopping", "abandoning"],
  stopping: ["snapshotted", "abandoning"],
  abandoning: ["abandoned"],
  snapshotted: ["installing", "rolling-back"],
  installing: ["trial", "rolling-back"],
  trial: ["proving", "rolling-back"],
  proving: ["committing", "rolling-back"],
  committing: ["committed"],
  "rolling-back": ["rolled-back"],
  abandoned: [], committed: [], "rolled-back": [], "manual-recovery": [],
};

export function canAdvance(from: Stage, to: Stage): boolean {
  if (TERMINAL.has(from)) return false;
  return to === "manual-recovery" || NEXT[from].includes(to);
}

export interface Artifact { name: string; version: string; integrity: string | null }
export interface ProcessStartRecord { processStart: string; startTicks?: string; bootId?: string }

export interface AttemptRecord {
  schema: 1;
  id: string;
  kind: "update" | "go-back";
  createdAt: string;
  updater: { pid: number; start: ProcessStartRecord };
  from: Artifact;
  to: Artifact;
  stage: Stage;
  substep?: string;
  history: Array<{ stage: Stage; substep?: string; at: string; note?: string }>;
  outcome?: { kind: Outcome; reason?: string; at: string };
  goBackOf?: string;
  /** 2.1b/2.3 fill these (ownership, expected tuples, fleet generations, baseline); kept opaque here. */
  [extra: string]: unknown;
}

/**
 * The journal's I/O, as primitives (Prism #4494 4). Every primitive that changes the disk calls `step` right after it
 * with `<op>:<file name>`, so a test can stop the writer at any boundary: after a tmp file's fsync, after a rename,
 * after a directory fsync. `trace` records the order. (A process crash between steps is what this exercises; the
 * order itself is what a power loss relies on, and the trace test checks it.)
 */
export interface JournalIo {
  now(): Date;
  /** Create or truncate `path`, write `data`, fsync it. */
  writeSynced(path: string, data: string): void;
  rename(from: string, to: string): void;
  /** Hard-link `from` to `to`; throws with code EEXIST when `to` exists (a no-overwrite publication). */
  link(from: string, to: string): void;
  unlink(path: string): void;
  /** Create one directory (not recursive); throws with code EEXIST when it exists. */
  mkdir(path: string): void;
  fsyncDir(path: string): void;
  read(path: string): string | null;            // null: absent (ENOENT); throws on any other error
  list(path: string): string[];                 // [] when absent
  step(name: string): void;
}

const fsyncDirReal = (dir: string): void => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };

export const defaultJournalIo: JournalIo = {
  now: () => new Date(),
  writeSynced: (path, data) => { const fd = openSync(path, "w", 0o600); try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); } },
  rename: (from, to) => renameSync(from, to),
  link: (from, to) => linkSync(from, to),
  unlink: path => unlinkSync(path),
  mkdir: path => mkdirSync(path, { mode: 0o700 }),
  fsyncDir: fsyncDirReal,
  read: path => { try { return readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; } },
  list: path => { try { return readdirSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; } },
  step: () => {},
};

const tmpOf = (path: string) => `${path}.tmp-${process.pid}`;

/** Replace `path` atomically and durably: tmp written and fsynced, renamed over, the directory fsynced. */
function writeAtomic(io: JournalIo, path: string, data: string): void {
  const tmp = tmpOf(path);
  io.writeSynced(tmp, data); io.step(`write:${basename(tmp)}`);
  io.rename(tmp, path); io.step(`rename:${basename(path)}`);
  io.fsyncDir(dirname(path)); io.step(`fsync-dir:${basename(dirname(path))}`);
}

/**
 * Publish `path` only if it doesn't exist (Prism #4494 3): tmp written and fsynced, hard-linked into place (never
 * replacing anything), tmp removed, the directory fsynced. An exact retry (the same bytes already there) succeeds; a
 * conflicting one throws and the original stays.
 */
function writeNew(io: JournalIo, path: string, data: string): void {
  const tmp = tmpOf(path);
  io.writeSynced(tmp, data); io.step(`write:${basename(tmp)}`);
  try { io.link(tmp, path); }
  catch (err) {
    try { io.unlink(tmp); } catch { /* best effort */ }
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    if (io.read(path) === data) return;                                      // an exact retry: already published
    throw new Error(`${path} already exists with other content; the original is kept`);
  }
  io.step(`link:${basename(path)}`);
  io.unlink(tmp);
  io.fsyncDir(dirname(path)); io.step(`fsync-dir:${basename(dirname(path))}`);
}

/** Rename and make it durable: the destination's directory fsynced (and the source's, when different). */
function renameDurable(io: JournalIo, from: string, to: string): void {
  io.rename(from, to); io.step(`rename:${basename(to)}`);
  io.fsyncDir(dirname(to)); io.step(`fsync-dir:${basename(dirname(to))}`);
  if (dirname(from) !== dirname(to)) { io.fsyncDir(dirname(from)); io.step(`fsync-dir:${basename(dirname(from))}`); }
}

/**
 * Create a directory chain durably (Prism #4494 4): each missing component made, then its parent fsynced, so a durable
 * `current` can never name a directory whose link from its parent was lost. `exclusive`: the last component must not
 * exist yet (an attempt's directory is never reused).
 */
function mkdirDurable(io: JournalIo, path: string, exclusive = false): void {
  const parts: string[] = [];
  for (let p = path; p !== parsePath(p).root; p = dirname(p)) parts.unshift(p);
  parts.forEach((dir, i) => {
    const last = i === parts.length - 1;
    try { io.mkdir(dir); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (last && exclusive) throw new Error(`${dir} already exists; an attempt's directory is never reused`);
      return;
    }
    io.step(`mkdir:${basename(dir)}`);
    io.fsyncDir(dirname(dir)); io.step(`fsync-dir:${basename(dirname(dir))}`);
  });
}

export const journalDir = (home: string) => join(home, ".update-journal");
const currentPath = (home: string) => join(journalDir(home), "current");
export const attemptDir = (home: string, id: string) => join(journalDir(home), "attempts", id);
const recordPath = (home: string, id: string) => join(attemptDir(home, id), "attempt.json");
const marksPath = (home: string) => join(journalDir(home), "marks.json");

const ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
/** A time-sortable attempt id: `<UTC compact ISO>-<8 hex>`. */
export function newAttemptId(now: Date, hex8: string): string {
  if (!/^[0-9a-f]{8}$/.test(hex8)) throw new Error("hex8 must be 8 lowercase hex digits");
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${hex8}`;
}

const STAGES = new Set<Stage>(Object.keys(NEXT) as Stage[]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTime = (v: unknown): boolean => nonEmpty(v) && Number.isFinite(Date.parse(v));
const isPid = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0;
const isArtifact = (v: unknown): boolean => isObj(v) && nonEmpty(v.name) && nonEmpty(v.version) && (v.integrity === null || nonEmpty(v.integrity));
const isStart = (v: unknown): boolean => isObj(v) && nonEmpty(v.processStart)
  && (v.startTicks === undefined || (typeof v.startTicks === "string" && /^\d+$/.test(v.startTicks)))
  && (v.bootId === undefined || nonEmpty(v.bootId));

/**
 * Every required field, by shape (Prism #4494 2): a record that's valid JSON but malformed is invalid, so it reads
 * unknown and is never cleared. Future opaque fields (ownership, tuples, generations) are 2.1b's.
 */
function parseRecord(text: string, id: string): AttemptRecord | null {
  let r: unknown;
  try { r = JSON.parse(text); } catch { return null; }
  if (!isObj(r) || r.schema !== 1 || r.id !== id || !(r.kind === "update" || r.kind === "go-back") || !isTime(r.createdAt)) return null;
  if (!isObj(r.updater) || !isPid(r.updater.pid) || !isStart(r.updater.start) || !isArtifact(r.from) || !isArtifact(r.to)) return null;
  const stage = r.stage as Stage;
  if (!STAGES.has(stage) || (r.substep !== undefined && !nonEmpty(r.substep))) return null;
  if (r.goBackOf !== undefined && !(typeof r.goBackOf === "string" && ID.test(r.goBackOf))) return null;
  if (r.kind === "go-back" && r.goBackOf === undefined) return null;
  const h = r.history;
  if (!Array.isArray(h) || h.length === 0 || h[0]?.stage !== "opened") return null;
  for (const e of h) {
    if (!isObj(e) || !STAGES.has(e.stage as Stage) || !isTime(e.at) || (e.substep !== undefined && !nonEmpty(e.substep)) || (e.note !== undefined && typeof e.note !== "string")) return null;
  }
  if ((h[h.length - 1] as { stage: Stage }).stage !== stage) return null;
  const terminal = TERMINAL.has(stage);
  if (terminal !== (r.outcome !== undefined)) return null;
  if (terminal) {
    const o = r.outcome;
    if (!isObj(o) || o.kind !== stage || !isTime(o.at) || (o.reason !== undefined && typeof o.reason !== "string")) return null;
  }
  return r as AttemptRecord;
}

export type JournalRead =
  | { state: "none" }
  | { state: "unknown"; reason: string; path: string }
  | { state: "open"; attempt: AttemptRecord }
  | { state: "closing"; attempt: AttemptRecord }
  | { state: "manual"; attempt: AttemptRecord };

/** §2.5: the journal as every reader sees it. Only an absent `current` is "none". */
export function readCurrent(home: string, io: JournalIo = defaultJournalIo): JournalRead {
  let text: string | null;
  try { text = io.read(currentPath(home)); }
  catch (err) { return { state: "unknown", reason: `current can't be read (${(err as Error).message})`, path: currentPath(home) }; }
  if (text === null) return { state: "none" };
  const id = text.trim();
  if (!ID.test(id)) return { state: "unknown", reason: "current names no attempt", path: currentPath(home) };
  let body: string | null;
  try { body = io.read(recordPath(home, id)); }
  catch (err) { return { state: "unknown", reason: `the attempt record can't be read (${(err as Error).message})`, path: recordPath(home, id) }; }
  if (body === null) return { state: "unknown", reason: "current names an attempt with no record", path: recordPath(home, id) };
  const attempt = parseRecord(body, id);
  if (!attempt) return { state: "unknown", reason: "the attempt record isn't valid", path: recordPath(home, id) };
  if (attempt.stage === "manual-recovery") return { state: "manual", attempt };
  if (TERMINAL.has(attempt.stage)) return { state: "closing", attempt };
  return { state: "open", attempt };
}

/** §2.4 step 3, for a "closing" journal: clear `current` (rename it into the attempt). Only under the home lock. */
export function finishClosing(home: string, attempt: AttemptRecord, io: JournalIo = defaultJournalIo): void {
  if (!TERMINAL.has(attempt.stage) || attempt.stage === "manual-recovery") throw new Error(`attempt ${attempt.id} is not closing`);
  renameDurable(io, currentPath(home), join(attemptDir(home, attempt.id), "current.closed"));
  io.step("current-cleared");
}

export type OpenResult = { ok: true; attempt: AttemptRecord } | { ok: false; reason: string };

/**
 * §2.4 "Open": the record first (durable), then `current`. Refused unless the journal reads "none"; a "closing" one is
 * finished first (the caller holds the home lock).
 */
export interface AttemptInit {
  id: string; kind: "update" | "go-back"; updater: { pid: number; start: ProcessStartRecord }; from: Artifact; to: Artifact;
  goBackOf?: string;
  /** 2.1b/2.3's fields (ownership, expected tuples, fleet generations, baseline). */
  extra?: Record<string, unknown>;
}

export function openAttempt(home: string, init: AttemptInit, io: JournalIo = defaultJournalIo): OpenResult {
  if (!ID.test(init.id)) return { ok: false, reason: "not an attempt id" };
  let read = readCurrent(home, io);
  if (read.state === "closing") { finishClosing(home, read.attempt, io); read = readCurrent(home, io); }
  if (read.state !== "none") return { ok: false, reason: read.state === "unknown" ? `the update journal is unknown: ${read.reason} (${read.path})` : `attempt ${read.attempt.id} is ${read.attempt.stage}` };
  const at = io.now().toISOString();
  const attempt: AttemptRecord = { ...(init.extra ?? {}), schema: 1, id: init.id, kind: init.kind, createdAt: at, updater: init.updater, from: init.from, to: init.to,
    ...(init.goBackOf ? { goBackOf: init.goBackOf } : {}), stage: "opened", history: [{ stage: "opened", at }] };
  // The chain .update-journal/attempts/<id> made durable first; the attempt's directory must be new (never rebound).
  mkdirDurable(io, attemptDir(home, init.id), true);
  writeNew(io, recordPath(home, init.id), JSON.stringify(attempt, null, 2) + "\n");
  io.step("record-written");
  writeAtomic(io, currentPath(home), init.id + "\n");
  io.step("current-written");
  return { ok: true, attempt };
}

function write(home: string, attempt: AttemptRecord, io: JournalIo, step: string): void {
  writeAtomic(io, recordPath(home, attempt.id), JSON.stringify(attempt, null, 2) + "\n");
  io.step(step);
}

/** §2.3: move to `to` (refused unless the table allows it). Returns the new record; the caller keeps using it. */
export function advance(home: string, attempt: AttemptRecord, to: Stage, opts: { substep?: string; note?: string } = {}, io: JournalIo = defaultJournalIo): AttemptRecord {
  if (TERMINAL.has(to)) throw new Error(`a terminal stage (${to}) is written by finish()`);
  if (!canAdvance(attempt.stage, to)) throw new Error(`attempt ${attempt.id}: ${attempt.stage} → ${to} is not allowed`);
  const at = io.now().toISOString();
  const next: AttemptRecord = { ...attempt, stage: to, history: [...attempt.history, { stage: to, at, ...(opts.substep ? { substep: opts.substep } : {}), ...(opts.note ? { note: opts.note } : {}) }] };
  if (opts.substep) next.substep = opts.substep; else delete next.substep;
  write(home, next, io, `stage-${to}`);
  return next;
}

/** A substep inside the current stage (§2.3 abandoning, §5.5, §6.3): journaled after its effect is durable. */
export function substep(home: string, attempt: AttemptRecord, name: string, io: JournalIo = defaultJournalIo): AttemptRecord {
  if (TERMINAL.has(attempt.stage)) throw new Error(`attempt ${attempt.id} is ${attempt.stage}`);
  const next: AttemptRecord = { ...attempt, substep: name, history: [...attempt.history, { stage: attempt.stage, substep: name, at: io.now().toISOString() }] };
  write(home, next, io, `substep-${name}`);
  return next;
}

/**
 * §2.4 "Terminal": a rollback's mark first, then the terminal record, then `current` cleared — except manual-recovery,
 * which keeps `current` until a person resolves it.
 */
export function finish(home: string, attempt: AttemptRecord, outcome: { kind: Outcome; reason?: string }, io: JournalIo = defaultJournalIo): AttemptRecord {
  const to = outcome.kind as Stage;
  const allowed = to === "manual-recovery" ? !TERMINAL.has(attempt.stage)
    : (to === "abandoned" && attempt.stage === "abandoning") || (to === "rolled-back" && attempt.stage === "rolling-back")
      || (to === "committed" && attempt.stage === "committing");
  if (!allowed) throw new Error(`attempt ${attempt.id}: ${attempt.stage} → ${to} is not allowed`);
  if (outcome.kind === "rolled-back") appendMark(home, { version: attempt.to.version, integrity: attempt.to.integrity, attemptId: attempt.id }, io);
  const at = io.now().toISOString();
  const next: AttemptRecord = { ...attempt, stage: to, history: [...attempt.history, { stage: to, at, ...(outcome.reason ? { note: outcome.reason } : {}) }],
    outcome: { kind: outcome.kind, ...(outcome.reason ? { reason: outcome.reason } : {}), at } };
  delete next.substep;
  write(home, next, io, `terminal-${to}`);
  if (to !== "manual-recovery") finishClosing(home, next, io);
  return next;
}

export interface Mark { version: string; integrity: string | null; attemptId: string; at?: string }
export type MarksRead = { ok: true; marks: Mark[] } | { ok: false; reason: string };

/** `marks.json`; unreadable is never "no marks" (§2.5): the caller refuses every automatic or required update. */
export function readMarks(home: string, io: JournalIo = defaultJournalIo): MarksRead {
  let text: string | null;
  try { text = io.read(marksPath(home)); } catch (err) { return { ok: false, reason: (err as Error).message }; }
  if (text === null) return { ok: true, marks: [] };
  try {
    const v = JSON.parse(text) as unknown;
    const valid = (m: unknown) => isObj(m) && nonEmpty(m.version) && (m.integrity === null || nonEmpty(m.integrity))
      && typeof m.attemptId === "string" && ID.test(m.attemptId) && isTime(m.at);
    if (!Array.isArray(v) || !v.every(valid)) return { ok: false, reason: "marks.json isn't a list of valid marks" };
    return { ok: true, marks: v as Mark[] };
  } catch { return { ok: false, reason: "marks.json isn't JSON" }; }
}

/** Append-only: the whole list rewritten atomically with the new mark (never pruned). Refuses on an unreadable list. */
export function appendMark(home: string, mark: Mark, io: JournalIo = defaultJournalIo): void {
  const read = readMarks(home, io);
  if (!read.ok) throw new Error(`marks.json can't be read, so no mark is written over it: ${read.reason}`);
  if (read.marks.some(m => m.attemptId === mark.attemptId)) return;           // a retry after the mark landed
  mkdirDurable(io, journalDir(home));
  writeAtomic(io, marksPath(home), JSON.stringify([...read.marks, { ...mark, at: mark.at ?? io.now().toISOString() }], null, 2) + "\n");
  io.step("mark-written");
}

/** Whether a version rolled back here (automatic and required updates never retry it). Unknown marks: "unknown". */
export function isMarked(home: string, artifact: { version: string; integrity: string | null }, io: JournalIo = defaultJournalIo): boolean | "unknown" {
  const read = readMarks(home, io);
  if (!read.ok) return "unknown";
  return read.marks.some(m => m.version === artifact.version && (m.integrity === null || artifact.integrity === null || m.integrity === artifact.integrity));
}

// ── §2.6: the fleet's files ─────────────────────────────────────────────────────────────────────────────────────────

export type InboxSource = "outbox" | "adapter" | "web" | "hub";
export type InboxItem = { kind: "reference"; deliveryId: string; createdSeq: number } | { kind: "copy"; body: unknown };
export const SEQ_WIDTH = 12;
const pad = (seq: number) => { if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("seq must be a non-negative integer"); return String(seq).padStart(SEQ_WIDTH, "0"); };
export const inboxName = (seq: number, source: InboxSource) => `${pad(seq)}-${source}.json`;
export const deferredName = (seq: number) => `${pad(seq)}.json`;
/** The outbox `source_key` a copy is admitted under: stable per attempt and seq, so a replay reuses its row (§2.6). */
export const handbackSourceKey = (attemptId: string, seq: number) => `update-handback:${attemptId}:${pad(seq)}`;

export function writeInboxItem(home: string, attemptId: string, seq: number, source: InboxSource, item: InboxItem, io: JournalIo = defaultJournalIo): void {
  const dir = join(attemptDir(home, attemptId), "inbox");
  mkdirDurable(io, dir);
  writeNew(io, join(dir, inboxName(seq, source)), JSON.stringify(item) + "\n");      // an accepted item is never replaced
  io.step(`inbox-${seq}`);
}

export function writeDeferred(home: string, attemptId: string, seq: number, job: { scheduleId: string; runId: string }, io: JournalIo = defaultJournalIo): void {
  const dir = join(attemptDir(home, attemptId), "deferred");
  mkdirDurable(io, dir);
  writeNew(io, join(dir, deferredName(seq)), JSON.stringify({ seq, ...job }) + "\n");
  io.step(`deferred-${seq}`);
}

export type HandbackEntry =
  | { seq: number; kind: "inbox"; source: InboxSource; file: string; item: InboxItem; acked: boolean }
  | { seq: number; kind: "deferred"; file: string; job: { scheduleId: string; runId: string }; started: boolean; acked: boolean };

/**
 * Everything to hand back, in the one sequence order (§2.6). An unreadable or invalid item throws: hand-back never
 * skips an item it can't read.
 */
export function listHandback(home: string, attemptId: string, io: JournalIo = defaultJournalIo): HandbackEntry[] {
  const out: HandbackEntry[] = [];
  const inbox = join(attemptDir(home, attemptId), "inbox"), deferred = join(attemptDir(home, attemptId), "deferred");
  const inboxFiles = io.list(inbox), deferredFiles = io.list(deferred);
  for (const f of inboxFiles) {
    const m = /^(\d{12})-(outbox|adapter|web|hub)\.json$/.exec(f);
    if (!m) continue;
    const text = io.read(join(inbox, f));
    if (text === null) throw new Error(`inbox item ${f} vanished`);
    const item = JSON.parse(text) as InboxItem;
    if (!(item.kind === "reference" && typeof item.deliveryId === "string" && Number.isSafeInteger(item.createdSeq)) && !(item.kind === "copy" && "body" in item)) throw new Error(`inbox item ${f} isn't valid`);
    out.push({ seq: Number(m[1]), kind: "inbox", source: m[2] as InboxSource, file: join(inbox, f), item, acked: inboxFiles.includes(`${f}.acked`) });
  }
  for (const f of deferredFiles) {
    const m = /^(\d{12})\.json$/.exec(f);
    if (!m) continue;
    const text = io.read(join(deferred, f));
    if (text === null) throw new Error(`deferred job ${f} vanished`);
    const job = JSON.parse(text) as { seq: number; scheduleId: string; runId: string };
    if (job.seq !== Number(m[1]) || typeof job.scheduleId !== "string" || typeof job.runId !== "string") throw new Error(`deferred job ${f} isn't valid`);
    out.push({ seq: job.seq, kind: "deferred", file: join(deferred, f), job: { scheduleId: job.scheduleId, runId: job.runId },
      started: deferredFiles.includes(`${f}.started`), acked: deferredFiles.includes(`${f}.acked`) });
  }
  const seqs = out.map(e => e.seq);
  if (new Set(seqs).size !== seqs.length) throw new Error("two hand-back items share a sequence number");
  return out.sort((a, b) => a.seq - b.seq);
}

/** `<file>.started` (a deferred job, before it runs) and `<file>.acked` (after its hand-back took effect). */
export function markHandback(entry: HandbackEntry, mark: "started" | "acked", io: JournalIo = defaultJournalIo): void {
  if (mark === "started" && entry.kind !== "deferred") throw new Error("only a deferred job is marked started");
  const path = `${entry.file}.${mark}`;
  if (io.read(path) !== null) return;                                        // already marked: a mark is a fact, never rewritten
  writeNew(io, path, JSON.stringify({ at: io.now().toISOString(), ...(entry.kind === "deferred" ? { runId: entry.job.runId } : {}) }) + "\n");
  io.step(`${mark}-${entry.seq}`);
}

/**
 * What a resumed hand-back does with one entry (§2.6). A deferred job started but not acknowledged was interrupted: it
 * is recorded, never re-run (at most once).
 */
export function handbackAction(entry: HandbackEntry): "skip" | "claim" | "admit-then-claim" | "run" | "record-interrupted" {
  if (entry.acked) return "skip";
  if (entry.kind === "inbox") return entry.item.kind === "reference" ? "claim" : "admit-then-claim";
  return entry.started ? "record-interrupted" : "run";
}

/** The fleet's cancel request (§2.6): written only while the card is cancellable. */
export function writeCancel(home: string, attemptId: string, cancel: { reason: string; by: string }, io: JournalIo = defaultJournalIo): void {
  const path = join(attemptDir(home, attemptId), "cancel");
  if (io.read(path) !== null) return;                                        // one cancel stands; a second one adds nothing
  writeNew(io, path, JSON.stringify({ ...cancel, at: io.now().toISOString() }) + "\n");
  io.step("cancel-written");
}

/**
 * The updater consumes a cancel by the stage it finds (§2.6), under the home lock, crash-safe (Prism #4494 1):
 *   honoured (opened, barrier, stopping with no snapshot): `abandoning` is journaled FIRST, then the marker becomes
 *     `cancel.consumed`. A retry finds either the marker still there with the attempt already abandoning (it only
 *     retires the marker), or no marker (nothing to do).
 *   too late: a history note is journaled first, then the marker becomes `cancel.ignored-<stage>`.
 * Returns the outcome and the attempt as now recorded.
 */
export function consumeCancel(home: string, attempt: AttemptRecord, snapshotPublished: boolean, io: JournalIo = defaultJournalIo):
  { result: "none" | "honoured" | "too-late"; attempt: AttemptRecord } {
  const path = join(attemptDir(home, attempt.id), "cancel");
  const text = io.read(path);
  if (text === null) return { result: "none", attempt };
  let reason = "cancelled";
  try { const c = JSON.parse(text) as { reason?: unknown }; if (nonEmpty(c.reason)) reason = c.reason; } catch { /* the request stands; its words don't */ }
  const honour = attempt.stage === "abandoning" || attempt.stage === "opened" || attempt.stage === "barrier" || (attempt.stage === "stopping" && !snapshotPublished);
  let next = attempt;
  if (honour) {
    if (attempt.stage !== "abandoning") next = advance(home, attempt, "abandoning", { note: `cancel: ${reason}` }, io);
    renameDurable(io, path, `${path}.consumed`);
    return { result: "honoured", attempt: next };
  }
  const note = `cancel too late at ${attempt.stage}: ${reason}`;
  if (attempt.history[attempt.history.length - 1]?.note !== note) {
    next = { ...attempt, history: [...attempt.history, { stage: attempt.stage, at: io.now().toISOString(), note }] };
    write(home, next, io, "cancel-ignored-noted");
  }
  renameDurable(io, path, `${path}.ignored-${attempt.stage}`);
  return { result: "too-late", attempt: next };
}

// ── §7: crash recovery ─────────────────────────────────────────────────────────────────────────────────────────────

export type UpdaterState = "live" | "gone" | "unknown";
export type RecoveryAction =
  | { kind: "start" }
  | { kind: "refuse"; reason: "unknown" | "manual" | "in-progress" | "updater-unknown"; attemptId?: string; stage?: Stage }
  | { kind: "finish-closing"; attemptId: string }
  | { kind: "resume-abandoning"; attemptId: string; substep?: string }
  | { kind: "resume-rolling-back"; attemptId: string; substep?: string }
  | { kind: "resume-committing"; attemptId: string; substep?: string };

/**
 * §7, a pure function: what a fleet start (or the recovery runner) does with the journal it read. `ownStart`: this start
 * holds the attempt's planned handoff nonce (it is the attempt's own start).
 */
export function recoveryPlan(read: JournalRead, updater: UpdaterState, ownStart = false): RecoveryAction {
  switch (read.state) {
    case "none": return { kind: "start" };
    case "unknown": return { kind: "refuse", reason: "unknown" };
    case "manual": return { kind: "refuse", reason: "manual", attemptId: read.attempt.id, stage: read.attempt.stage };
    case "closing": return { kind: "finish-closing", attemptId: read.attempt.id };
  }
  const a = read.attempt;
  if (updater === "live") return ownStart ? { kind: "start" } : { kind: "refuse", reason: "in-progress", attemptId: a.id, stage: a.stage };
  if (updater === "unknown") return { kind: "refuse", reason: "updater-unknown", attemptId: a.id, stage: a.stage };
  const sub = a.substep ? { substep: a.substep } : {};
  switch (a.stage) {
    case "opened": case "barrier": case "stopping": case "abandoning": return { kind: "resume-abandoning", attemptId: a.id, ...sub };
    case "snapshotted": case "installing": case "trial": case "proving": case "rolling-back": return { kind: "resume-rolling-back", attemptId: a.id, ...sub };
    case "committing": return { kind: "resume-committing", attemptId: a.id, ...sub };
    default: return { kind: "refuse", reason: "unknown" };
  }
}
