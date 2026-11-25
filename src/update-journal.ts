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
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** The I/O the journal does. `step` is called after every durable effect; a test throws there to crash the writer. */
export interface JournalIo {
  now(): Date;
  /** Write a file atomically and durably: tmp, fsync, rename, fsync the directory. */
  writeAtomic(path: string, data: string): void;
  /** Rename, then fsync the destination's directory. */
  renameDurable(from: string, to: string): void;
  mkdirp(path: string): void;
  read(path: string): string | null;            // null: absent (ENOENT); throws on any other error
  list(path: string): string[];                 // [] when absent
  step(name: string): void;
}

const fsyncDir = (dir: string): void => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };

export const defaultJournalIo: JournalIo = {
  now: () => new Date(),
  writeAtomic: (path, data) => {
    const tmp = `${path}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    fsyncDir(dirname(path));
  },
  renameDurable: (from, to) => { renameSync(from, to); fsyncDir(dirname(to)); if (dirname(from) !== dirname(to)) fsyncDir(dirname(from)); },
  mkdirp: path => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
  read: path => { try { return readFileSync(path, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; } },
  list: path => { try { return readdirSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; } },
  step: () => {},
};

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
function parseRecord(text: string, id: string): AttemptRecord | null {
  let r: unknown;
  try { r = JSON.parse(text); } catch { return null; }
  const a = r as Partial<AttemptRecord> | null;
  if (!a || a.schema !== 1 || a.id !== id || !STAGES.has(a.stage as Stage) || !Array.isArray(a.history)
    || typeof a.updater?.pid !== "number" || typeof a.updater?.start?.processStart !== "string") return null;
  if (TERMINAL.has(a.stage as Stage) && (!a.outcome || a.outcome.kind !== a.stage)) return null;
  return a as AttemptRecord;
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
  io.renameDurable(currentPath(home), join(attemptDir(home, attempt.id), "current.closed"));
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
  io.mkdirp(attemptDir(home, init.id));
  io.writeAtomic(recordPath(home, init.id), JSON.stringify(attempt, null, 2) + "\n");
  io.step("record-written");
  io.writeAtomic(currentPath(home), init.id + "\n");
  io.step("current-written");
  return { ok: true, attempt };
}

function write(home: string, attempt: AttemptRecord, io: JournalIo, step: string): void {
  io.writeAtomic(recordPath(home, attempt.id), JSON.stringify(attempt, null, 2) + "\n");
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
    if (!Array.isArray(v) || !v.every(m => m && typeof (m as Mark).version === "string" && typeof (m as Mark).attemptId === "string")) return { ok: false, reason: "marks.json isn't a list of marks" };
    return { ok: true, marks: v as Mark[] };
  } catch { return { ok: false, reason: "marks.json isn't JSON" }; }
}

/** Append-only: the whole list rewritten atomically with the new mark (never pruned). Refuses on an unreadable list. */
export function appendMark(home: string, mark: Mark, io: JournalIo = defaultJournalIo): void {
  const read = readMarks(home, io);
  if (!read.ok) throw new Error(`marks.json can't be read, so no mark is written over it: ${read.reason}`);
  if (read.marks.some(m => m.attemptId === mark.attemptId)) return;           // a retry after the mark landed
  io.mkdirp(journalDir(home));
  io.writeAtomic(marksPath(home), JSON.stringify([...read.marks, { ...mark, at: mark.at ?? io.now().toISOString() }], null, 2) + "\n");
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
  io.mkdirp(dir);
  io.writeAtomic(join(dir, inboxName(seq, source)), JSON.stringify(item) + "\n");
  io.step(`inbox-${seq}`);
}

export function writeDeferred(home: string, attemptId: string, seq: number, job: { scheduleId: string; runId: string }, io: JournalIo = defaultJournalIo): void {
  const dir = join(attemptDir(home, attemptId), "deferred");
  io.mkdirp(dir);
  io.writeAtomic(join(dir, deferredName(seq)), JSON.stringify({ seq, ...job }) + "\n");
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
  io.writeAtomic(`${entry.file}.${mark}`, JSON.stringify({ at: io.now().toISOString(), ...(entry.kind === "deferred" ? { runId: entry.job.runId } : {}) }) + "\n");
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
  io.writeAtomic(join(attemptDir(home, attemptId), "cancel"), JSON.stringify({ ...cancel, at: io.now().toISOString() }) + "\n");
  io.step("cancel-written");
}

/**
 * The updater consumes a cancel by the stage it finds (§2.6): honoured through `stopping` with no snapshot (the caller
 * then advances to abandoning), otherwise set aside as too late. Returns what was done.
 */
export function consumeCancel(home: string, attempt: AttemptRecord, snapshotPublished: boolean, io: JournalIo = defaultJournalIo): "none" | "honoured" | "too-late" {
  const path = join(attemptDir(home, attempt.id), "cancel");
  if (io.read(path) === null) return "none";
  const honour = (attempt.stage === "opened" || attempt.stage === "barrier" || (attempt.stage === "stopping" && !snapshotPublished));
  io.renameDurable(path, honour ? `${path}.consumed` : `${path}.ignored-${attempt.stage}`);
  io.step(honour ? "cancel-consumed" : "cancel-ignored");
  return honour ? "honoured" : "too-late";
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
