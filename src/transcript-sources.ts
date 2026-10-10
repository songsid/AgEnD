import { measureSyncWork } from "./sync-work-attribution.js";
/**
 * Per-backend tool-event sources for the transcript monitor.
 *
 * claude-code keeps its transcript path in statusline.json and is handled
 * inside TranscriptMonitor itself (it predates this file). The sources here
 * cover backends whose CLIs persist their conversation elsewhere:
 *
 *   codex     — rollout JSONL under <codex home>/sessions/YYYY/MM/DD/,
 *               matched to this instance by session_meta.cwd (sessions are a
 *               shared symlinked dir across instances, #507)
 *   kiro-cli  — primary sessions in ~/.local/share/kiro-cli/data.sqlite3
 *               (Kiro 2.19+), with ~/.kiro/sessions/cli JSONL fallback for
 *               older releases
 *   opencode  — $XDG_DATA_HOME/opencode/opencode.db `part` table rows of
 *               data JSON { type: "tool", tool, state.input }, matched by the
 *               `session` table's directory column
 *
 * Common rules, learned the hard way (#528 traps):
 *   - No persisted byte offsets. Codex writes a fresh rollout per process and
 *     kiro/opencode keep full history — a stale offset is meaningless at best
 *     and replays history at worst.
 *   - First attach to a PRE-EXISTING transcript baselines to its end: only
 *     new work emits. A transcript that APPEARS after the source was created
 *     is this instance's own new session and is read from the start.
 *   - Every poll re-resolves which transcript is active. Pinning to the first
 *     one found silently goes blind when the CLI starts a new session.
 */

import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sharedRolloutIndex, type RolloutIndex } from "./rollout-index.js";
import Database from "better-sqlite3";
import { sharedKiroTranscriptLane, type KiroDbLane, type KiroDbLease } from "./kiro-transcript-lane.js";
import type { KiroDbCursor } from "./kiro-db-reader.js";
export { extractKiroAssistantStrings } from "./kiro-db-reader.js";
import type { TranscriptTurnEvent } from "./transcript-turns.js";
import { lastLineBoundary, readNewLines } from "./transcript-jsonl.js";
import { museSessionCwd, readFileHeadSync } from "./backend/muse.js";
import { performance } from "node:perf_hooks";

export interface ToolUseEvent { name: string; input: unknown }

export interface TranscriptEvents {
  toolUses: ToolUseEvent[];
  toolResults: Array<{ name: string }>;
  assistantTexts: string[];
  /** #1510: turn boundaries, from a source that records them (codex). */
  turns?: TranscriptTurnEvent[];
}

export interface TranscriptCheckpoint {
  path: string;
  offset: number;
  /** Stable path/session identifier used to reject a different rollout. */
  sessionId: string;
}

export interface TranscriptSource {
  /** Read events that appeared since the previous call. Invoked serially. */
  poll(): Promise<TranscriptEvents>;
  /** Asynchronous baseline barrier, awaited before startup becomes accepting. */
  initialize?(): Promise<void>;
  /** Forget the current position; the next poll re-resolves and re-baselines. */
  reset(): void;
  /** Optional durable-delivery checkpoint taken immediately before pane paste. */
  checkpoint?(): Promise<TranscriptCheckpoint | null>;
  /** Release anything held between polls; the next poll may acquire it again. */
  close?(): void;
}

const EMPTY: TranscriptEvents = { toolUses: [], toolResults: [], assistantTexts: [] };

function emptyEvents(): TranscriptEvents {
  return { toolUses: [], toolResults: [], assistantTexts: [] };
}

/* ------------------------------------------------------------------ codex */

/**
 * Follows the newest rollout JSONL whose session_meta.cwd matches this
 * instance's working directory. Rollouts are date-sharded and shared across
 * instances, so cwd is the only reliable ownership signal.
 */
export class CodexRolloutSource implements TranscriptSource {
  private currentFile: string | null = null;
  private byteOffset = 0;
  /** EOF snapshots taken when the monitor attaches; existing history is skipped. */
  private initialOffsets = new Map<string, number>();
  /** Files whose session_meta was read and did NOT match our cwd. */
  private rejected = new Set<string>();
  /**
   * Files whose session_meta WAS read and matches our cwd. The first line of a rollout
   * never changes, so this verdict is as final as a rejection: re-reading a 64 KiB head
   * of the active file on every poll bought nothing (#1161).
   */
  private accepted = new Set<string>();
  private readonly index: RolloutIndex;
  /** #1510: the turn the records being read belong to (its `task_started`), carried across polls of one file. */
  private openTurnId = "";

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"),
    _now = Date.now(),
    index?: RolloutIndex,
  ) {
    this.index = index ?? sharedRolloutIndex(sessionsDir);
    this.snapshotExistingFiles();
  }

  reset(): void {
    this.currentFile = null;
    this.byteOffset = 0;
    this.openTurnId = "";
    this.rejected.clear();
    this.accepted.clear();
    this.snapshotExistingFiles();
  }

  async checkpoint(): Promise<TranscriptCheckpoint | null> {
    const active = this.candidateFiles(true).find(file => this.fileBelongsToUs(file.path));
    if (!active) return null;
    try {
      // A line boundary, not the size: a record being written now is read once complete (#1250).
      const offset = await lastLineBoundary(active.path);
      this.currentFile = active.path;
      this.byteOffset = offset;
      return { path: active.path, offset, sessionId: active.path };
    } catch {
      return null;
    }
  }

  private snapshotExistingFiles(): void {
    this.initialOffsets = new Map(this.candidateFiles(true).map(file => [file.path, file.size]));
  }

  /**
   * Newest rollout files first.
   *
   * A resumed Codex session keeps writing to the date shard where it was first
   * created. Limiting discovery to today's/yesterday's directories therefore
   * makes a long-lived instance silently disappear from tool progress, so every
   * shard is considered. That tree only ever grows and every Codex instance reads
   * it, so the listing comes from one shared, incrementally refreshed index
   * (rollout-index.ts) instead of a private walk per instance per poll (#1161).
   * Baselines and checkpoints ask for a fresh listing; the 2 s poll takes the shared one.
   */
  private candidateFiles(fresh = false): readonly { path: string; mtimeMs: number; size: number }[] {
    return this.index.list(fresh);
  }

  private fileBelongsToUs(path: string): boolean {
    if (this.rejected.has(path)) return false;
    if (this.accepted.has(path)) return true;
    try {
      // session_meta is the first line. It can carry long instructions, so
      // give it headroom — but never read the whole rollout.
      const fd = openSync(path, "r");
      let head: string;
      try {
        const buf = Buffer.alloc(65536);
        const bytes = readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString("utf-8", 0, bytes);
      } finally {
        closeSync(fd);
      }
      const firstLine = head.split("\n")[0];
      const meta = JSON.parse(firstLine);
      const cwd = meta?.payload?.cwd;
      if (meta?.type === "session_meta" && cwd === this.workingDirectory) {
        this.accepted.add(path);
        return true;
      }
      this.rejected.add(path);
      return false;
    } catch {
      // First line unreadable/partial — retry next poll, do not cache the verdict.
      return false;
    }
  }

  async poll(): Promise<TranscriptEvents> {
    // Re-resolve every poll: a restarted codex writes a NEW rollout, and
    // staying pinned to the old one goes silently blind (#528 trap 1).
    const candidates = this.candidateFiles();
    const active = candidates.find(c => this.fileBelongsToUs(c.path));
    if (!active) return EMPTY;

    if (active.path !== this.currentFile) {
      // Existing rollout: continue at the EOF captured when the source was
      // created. New rollout: read from the start. Using current mtime here is
      // wrong because appending to a resumed rollout makes an old file look new.
      // The captured size is anchored to its last line boundary (#1250): a record mid-write at creation is kept.
      // Only an anchor that succeeded is committed (#1283 review): if the boundary cannot be read now, nothing is
      // adopted and the next poll tries again from the same captured size — never the raw size, mid-record.
      const captured = this.initialOffsets.get(active.path);
      let offset = 0;
      if (captured !== undefined) {
        try { offset = await lastLineBoundary(active.path, captured); } catch { return EMPTY; }
      }
      this.currentFile = active.path;
      this.byteOffset = offset;
      this.openTurnId = "";
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
    this.byteOffset = newOffset;

    const events = emptyEvents();
    const turns: TranscriptTurnEvent[] = [];
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      const p = entry.payload as Record<string, unknown> | undefined;
      if (!p) continue;
      // #1510: codex 0.162 writes one task_started per turn and ends it with task_complete (last_agent_message null
      // after a provider error) or turn_aborted; a steer lands inside the open turn as another user message.
      if (entry.type === "event_msg") {
        if (p.type === "task_started" && typeof p.turn_id === "string") {
          this.openTurnId = p.turn_id;
          turns.push({ kind: "start", turnId: p.turn_id });
        } else if ((p.type === "task_complete" || p.type === "turn_aborted") && typeof p.turn_id === "string") {
          const end = p.type === "turn_aborted" ? "aborted" : p.last_agent_message == null ? "error" : "complete";
          turns.push({ kind: "end", turnId: p.turn_id, end });
        }
        continue;
      }
      if (entry.type !== "response_item") continue;
      if (p.type === "message" && p.role === "user") {
        const text = (p.content as Array<Record<string, unknown>> | undefined ?? [])
          .map(block => typeof block.text === "string" ? block.text : "").join("\n");
        const at = Date.parse(String(entry.timestamp ?? ""));
        if (text.trim() && Number.isFinite(at)) turns.push({ kind: "user", turnId: this.openTurnId, text, at });
        continue;
      }
      if (p.type === "function_call") {
        let input: unknown = p.arguments;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* keep raw */ } }
        events.toolUses.push({ name: String(p.name ?? "unknown"), input });
      } else if (p.type === "custom_tool_call") {
        events.toolUses.push({ name: String(p.name ?? "unknown"), input: p.input });
      } else if (p.type === "local_shell_call") {
        const action = p.action as Record<string, unknown> | undefined;
        events.toolUses.push({ name: "shell", input: { command: action?.command } });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        events.toolResults.push({ name: String(p.name ?? "unknown") });
      } else if (p.type === "message" && p.role === "assistant") {
        const content = p.content as Array<Record<string, unknown>> | undefined;
        for (const block of content ?? []) {
          const text = block.text;
          if (typeof text === "string" && text.trim()) events.assistantTexts.push(text);
        }
      }
    }
    if (turns.length) events.turns = turns;
    return events;
  }
}

/* -------------------------------------------------------------------- muse */

/**
 * #1510: muse's turn boundaries, from its session logs (`<root>/<YYYY>/<MM>/<DD>/<id>/session.jsonl`, recorded on
 * 1.4.4 in tests/fixtures/reply-guard-1510). Only turns are read; muse's tool activity is not.
 *
 * - a run is a turn: `runtime.session` run `started` → `terminal {reason}` (null: done; "cancelled …": the user
 *   stopped it; anything else: it failed);
 * - a message is `runtime.user_intent.accepted` (its text, surface "main") and lands in a run with
 *   `user_intent.materialized` — a new run, or the active one when it was typed mid-run;
 * - the end-of-turn reminder observers write their own session directories and no main-surface intents.
 *
 * Every log whose head names this working directory is followed: ownership is decided later, by the delivered text
 * (TranscriptTurnLedger), so two muse instances in one directory cannot vouch for each other. The directory tree is
 * re-listed at most every `listTtlMs`; between listings only the logs already known are read, and only when they grew.
 * Logs present when the source is created are read from their end (existing history is not this launch's).
 */
export class MuseSessionSource implements TranscriptSource {
  /**
   * session.jsonl path → where to read next (cwd-matched logs only): a byte offset, or `{ anchor }` for a log that
   * existed before this source (read from its last line boundary at `anchor` bytes, or at its size when first read
   * if its size was not known then — never from its start).
   */
  private files = new Map<string, number | { anchor: number | null }>();
  /** Every log present at the baseline, with its size then (null: it was there, its size could not be read). */
  private preexisting = new Map<string, number | null>();
  /** Whether the baseline listing saw the whole tree; if not, a log found later may be old and is read from its end. */
  private baselineComplete = false;
  private rejected = new Set<string>();
  private sizes = new Map<string, number>();
  private listedAt = Number.NEGATIVE_INFINITY;
  private baselined = false;
  /** intent_id → its text and time, until it materializes (bounded). */
  private intents = new Map<string, { text: string; at: number }>();

  constructor(
    private workingDirectory: string,
    private root = join(homedir(), ".local", "share", "muse", "sessions"),
    private listTtlMs = 30_000,
    private now: () => number = () => performance.now(),
  ) {}

  reset(): void {
    this.files.clear(); this.preexisting.clear(); this.rejected.clear(); this.sizes.clear(); this.intents.clear();
    this.listedAt = Number.NEGATIVE_INFINITY; this.baselined = false; this.baselineComplete = false;
  }

  async initialize(): Promise<void> { await this.list(); }

  private async list(): Promise<void> {
    this.listedAt = this.now();
    const { logs, complete } = await listMuseSessionLogs(this.root);
    if (!this.baselined) {
      // The baseline is every log there now, whatever its head says: history is not this launch's, and a log whose
      // cwd cannot be read yet is still history when it can.
      for (const path of logs) this.preexisting.set(path, await stat(path).then(st => st.size, () => null));
      this.baselineComplete = complete;
      this.baselined = true;
    }
    for (const path of logs) {
      if (this.files.has(path) || this.rejected.has(path)) continue;
      const head = readFileHeadSync(path, 65_536);
      if (head === null) continue;
      const cwd = museSessionCwd(head);
      if (cwd === null) {
        // A log being started names its cwd within moments; one that still does not a minute on never will (the
        // end-of-turn reminder observers write two such logs per turn) and is not read again.
        const mtime = await stat(path).then(st => st.mtimeMs, () => null);
        if (mtime !== null && Date.now() - mtime > 60_000) this.rejected.add(path);
        continue;
      }
      if (cwd !== this.workingDirectory) { this.rejected.add(path); continue; }
      // Read from the start only a log provably made after the baseline.
      const fresh = this.baselineComplete && !this.preexisting.has(path);
      this.files.set(path, fresh ? 0 : { anchor: this.preexisting.get(path) ?? null });
    }
  }

  async poll(): Promise<TranscriptEvents> {
    if (!this.baselined || this.now() - this.listedAt >= this.listTtlMs) await this.list();
    const turns: TranscriptTurnEvent[] = [];
    for (const [path, next] of this.files) {
      const size = await stat(path).then(st => st.size, () => null);
      if (size === null || size === this.sizes.get(path)) continue;
      let from: number;
      if (typeof next === "number") from = next;
      else {
        try { from = await lastLineBoundary(path, next.anchor ?? size); } catch { continue; }
      }
      let read: { lines: string[]; newOffset: number };
      try { read = await readNewLines(path, from); } catch { continue; }
      this.files.set(path, read.newOffset);
      this.sizes.set(path, size);
      // One record at a time: a record of an unexpected shape is skipped, never the batch it came in.
      for (const line of read.lines) {
        try { this.parse(line, turns); } catch { /* skipped */ }
      }
    }
    const events = emptyEvents();
    if (turns.length) events.turns = turns;
    return events;
  }

  private parse(line: string, turns: TranscriptTurnEvent[]): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const o = asRecord(parsed), p = asRecord(o?.payload);
    if (!o || !p) return;
    const type = o.payload_type;
    const at = typeof o.recorded_at === "number" && Number.isFinite(o.recorded_at) ? Math.floor(o.recorded_at / 1000) : NaN; // µs
    if (type === "runtime.user_intent.accepted") {
      if (p.surface !== "main" || typeof p.intent_id !== "string" || !Number.isFinite(at) || !Array.isArray(p.model_messages)) return;
      const parts: string[] = [];
      for (const message of p.model_messages) {
        const content = asRecord(message)?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          const b = asRecord(block);
          if (b?.kind === "text" && typeof b.text === "string") parts.push(b.text);
        }
      }
      const text = parts.join("\n");
      if (!text.trim()) return;
      this.intents.set(p.intent_id, { text, at });
      if (this.intents.size > 64) this.intents.delete(this.intents.keys().next().value as string);
    } else if (type === "runtime.user_intent.materialized") {
      const intent = typeof p.intent_id === "string" ? this.intents.get(p.intent_id) : undefined;
      const runId = asRecord(p.outcome)?.run_id;
      if (!intent || typeof runId !== "string") return;
      this.intents.delete(p.intent_id as string);
      turns.push({ kind: "user", turnId: runId, text: intent.text, at: intent.at });
    } else if (type === "runtime.session" && p.kind === "run" && typeof p.run_id === "string") {
      const event = asRecord(p.event);
      if (event?.kind === "started") turns.push({ kind: "start", turnId: p.run_id });
      else if (event?.kind === "terminal" && "reason" in event) {
        // Only what was recorded proves anything: an explicit null is a run that finished; a missing or unfamiliar
        // reason ends nothing (the turn stays open, and the guard's running cap stands it down).
        const reason = event.reason;
        if (reason === null) turns.push({ kind: "end", turnId: p.run_id, end: "complete" });
        else if (typeof reason === "string") turns.push({ kind: "end", turnId: p.run_id, end: reason.startsWith("cancelled") ? "aborted" : "error" });
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * `<root>/<YYYY>/<MM>/<DD>/<id>/session.jsonl` for every session directory. `complete` is false when a directory
 * that exists could not be read: what it holds is unknown. A root that does not exist yet is complete (empty).
 */
async function listMuseSessionLogs(root: string): Promise<{ logs: string[]; complete: boolean }> {
  let complete = true;
  const children = async (dir: string, isRoot = false): Promise<string[]> => {
    try { return await readdir(dir); } catch (err) {
      if (!(isRoot && (err as NodeJS.ErrnoException).code === "ENOENT")) complete = false;
      return [];
    }
  };
  const logs: string[] = [];
  for (const year of await children(root, true)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await children(join(root, year))) {
      for (const day of await children(join(root, year, month))) {
        for (const session of await children(join(root, year, month, day))) logs.push(join(root, year, month, day, session, "session.jsonl"));
      }
    }
  }
  return { logs, complete };
}

/* -------------------------------------------------------------------- kiro */

/**
 * The conversation database for one kiro store.
 *
 * With no store given this is the shared login's, exactly as before. A
 * credential profile has its own store and therefore its own conversations —
 * they are tables in the same file as the login, so an instance on a profile
 * writes its transcript somewhere this reader would never have looked.
 */
export function kiroStoreDbPath(storeHome?: string): string {
  const home = storeHome
    ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kiro-cli");
  return join(home, "data.sqlite3");
}

export interface KiroConversation {
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  /** Length of the stored value — part of the change signature. */
  size: number;
  /** Null when the row exists but its history is missing or unparseable. */
  history: unknown[] | null;
}

export function kiroWorkingDirectoryKeys(workingDirectory: string): string[] {
  const keys = new Set([workingDirectory, resolve(workingDirectory)]);
  try { keys.add(realpathSync(workingDirectory)); } catch { /* keep literal/absolute cwd */ }
  return [...keys];
}

/**
 * Discriminated read of the newest kiro conversation for a working directory.
 * Shared by the live monitor and the #995 forged-envelope scanner so both
 * resolve "this instance's conversation" the same way — and so a safety scan
 * can tell "no conversation" apart from "could not read the store" (#1007).
 */
export type KiroConversationRead =
  | { status: "ok"; conversation: KiroConversation }
  | { status: "no-row" }
  | { status: "error"; reason: string };

export function readKiroConversationStatus(
  dbPath: string,
  workingDirectory: string,
  /** False = metadata only (no value read, no JSON parse): the poll fast path. */
  includeHistory = true,
): KiroConversationRead {
  return measureSyncWork("kiro.conversationStatus", () => readKiroConversationStatusSync(dbPath, workingDirectory, includeHistory));
}
function readKiroConversationStatusSync(
  dbPath: string,
  workingDirectory: string,
  /** False = metadata only (no value read, no JSON parse): the poll fast path. */
  includeHistory = true,
): KiroConversationRead {
  if (!existsSync(dbPath)) return { status: "error", reason: `kiro store not found: ${dbPath}` };
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const keys = kiroWorkingDirectoryKeys(workingDirectory);
    const placeholders = keys.map(() => "?").join(", ");
    // Metadata first: length(value) sizes the change signature without
    // reading or parsing the (growing) transcript on every poll.
    const row = db.prepare(
      `SELECT conversation_id, created_at, updated_at, length(value) AS size
         ${includeHistory ? ", value" : ""}
       FROM conversations_v2 WHERE key IN (${placeholders})
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(...keys) as {
      conversation_id: string; created_at: number; updated_at: number; size: number; value?: string;
    } | undefined;
    if (!row) return { status: "no-row" };
    let history: unknown[] | null = null;
    if (includeHistory) {
      try {
        const parsed = JSON.parse(row.value ?? "") as { history?: unknown };
        history = Array.isArray(parsed.history) ? parsed.history : null;
      } catch { history = null; }
    }
    return {
      status: "ok",
      conversation: {
        conversationId: row.conversation_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        size: row.size,
        history,
      },
    };
  } catch (err) {
    return { status: "error", reason: (err as Error).message };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Follows the newest Kiro conversation whose cwd matches this instance.
 * Kiro 2.19 moved primary conversations to conversations_v2 in data.sqlite3;
 * legacy releases use <uuid>.jsonl plus sibling <uuid>.json metadata.
 */
/** The Kiro legacy fallback's scan bounds (#1490): see KiroSessionSource.resolveActiveSession. */
export const KIRO_FULL_SCAN_MS = 30_000;
export const KIRO_QUIET_MS = 10 * 60_000;
export const KIRO_SCAN_CONCURRENCY = 16;
const KIRO_HOT_DIR_MS = 2_000;

/** Run `task(0..count-1)`, at most `limit` at a time. */
async function forEachLimited(count: number, limit: number, task: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { while (next < count) await task(next++); };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}

export class KiroSessionSource implements TranscriptSource {
  private currentFile: string | null = null;
  private byteOffset = 0;
  private readonly createdAt: number;
  private generation = 0;
  private cursor: KiroDbCursor | undefined;
  private lease: KiroDbLease | null = null;
  private ready: Promise<void> | null = null;
  private needsBaseline = true;

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(homedir(), ".kiro", "sessions", "cli"),
    now = Date.now(),
    private dbPath = kiroStoreDbPath(),
    private lane: KiroDbLane = sharedKiroTranscriptLane,
  ) {
    this.createdAt = now;
    void this.initialize();
  }
  initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.lease ??= this.lane.acquire();
    const lease = this.lease, generation = this.generation;
    if (!this.needsBaseline) return Promise.resolve();
    this.ready = lease.read({ workingDirectory: this.workingDirectory, dbPath: this.dbPath, createdAt: this.createdAt, baseline: true }).then(reply => {
      if (generation !== this.generation || this.lease !== lease) return;
      this.cursor = reply?.cursor;
      this.needsBaseline = false;
    });
    return this.ready;
  }
  reset(): void {
    this.close();
    this.currentFile = null;
    this.byteOffset = 0;
    this.cursor = undefined;
    this.needsBaseline = true;
    void this.initialize();
  }
  close(): void {
    this.generation++;
    this.lease?.close();
    this.lease = null;
    this.ready = null;
  }
  private async pollDb(): Promise<TranscriptEvents | null> {
    const generation = this.generation;
    await this.initialize();
    if (generation !== this.generation || !this.lease) return EMPTY;
    const lease = this.lease;
    const reply = await lease.read({ workingDirectory: this.workingDirectory, dbPath: this.dbPath, createdAt: this.createdAt, baseline: false, cursor: this.cursor });
    if (generation !== this.generation || this.lease !== lease) return EMPTY;
    if (!reply) return null;
    this.cursor = reply.cursor;
    return reply.events;
  }

  /**
   * What each session's metadata said, keyed by file and valid for the mtime/size it was
   * read at (#1161): the fallback used to re-read and re-parse EVERY session's JSON on every
   * 2 s poll, for every instance; now an unchanged file costs one stat.
   * `null` = the file does not concern us (another cwd, or a subagent child).
   */
  private metaCache = new Map<string, { mtimeMs: number; size: number; meta: { updated: number; created: number } | null }>();
  /** The sessions directory as last listed: re-listed only when its mtime moves (a session added or removed). */
  private sessionsListing: { mtimeMs: number; names: string[]; hotWhenRead: boolean } | null = null;
  private fullScanAt = Number.NEGATIVE_INFINITY;
  /** Monotonic clock for the full-scan spacing; wall clock for comparing with file times. Test hooks. */
  private mono = (): number => performance.now();
  private wall = (): number => Date.now();

  /**
   * The newest session of this working directory, from its metadata (#1490). It used to run `readdirSync` plus a
   * `statSync` of every metadata file on the event loop, on every 2 s poll while the store had no row for us: 16–18 ms
   * per instance with 5,000 sessions. Now it is asynchronous and bounded:
   *   - the directory is listed again only when its mtime moved, or when it was read right after a change (file
   *     times are coarse: a session created in the same tick would share that mtime), or on a full scan;
   *   - a metadata file quiet for KIRO_QUIET_MS is not stat'ed again until the next full scan, so a poll costs one
   *     stat of the directory plus the recently active files; an old session resumed is seen within KIRO_FULL_SCAN_MS;
   *   - every full scan (each KIRO_FULL_SCAN_MS) re-stats everything, KIRO_SCAN_CONCURRENCY at a time.
   */
  private async resolveActiveSession(): Promise<{ jsonlPath: string; createdAtMs: number } | null> {
    const now = this.wall();
    const full = this.mono() - this.fullScanAt >= KIRO_FULL_SCAN_MS;
    let dirMtimeMs: number;
    try { dirMtimeMs = (await stat(this.sessionsDir)).mtimeMs; } catch { return null; }
    let listing = this.sessionsListing;
    if (full || !listing || listing.mtimeMs !== dirMtimeMs || listing.hotWhenRead) {
      let entries: string[];
      try { entries = await readdir(this.sessionsDir); } catch { return null; }
      listing = { mtimeMs: dirMtimeMs, names: entries.filter(e => e.endsWith(".json") && !e.endsWith(".jsonl")).sort(), hotWhenRead: now - dirMtimeMs < KIRO_HOT_DIR_MS };
      this.sessionsListing = listing;
    }
    if (full) this.fullScanAt = this.mono();

    const verdicts = new Array<{ updated: number; created: number } | null>(listing.names.length).fill(null);
    const names = listing.names;
    await forEachLimited(names.length, KIRO_SCAN_CONCURRENCY, async (i) => {
      const metaPath = join(this.sessionsDir, names[i]!);
      let cached = this.metaCache.get(metaPath);
      if (!full && cached && now - cached.mtimeMs > KIRO_QUIET_MS) { verdicts[i] = cached.meta; return; }
      try {
        const st = await stat(metaPath);
        if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
          const meta = JSON.parse(await readFile(metaPath, "utf-8"));
          // Subagent sessions are children of a turn already being reported.
          const ours = meta.cwd === this.workingDirectory && meta.session_created_reason !== "subagent";
          cached = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            meta: ours
              ? { updated: Date.parse(meta.updated_at ?? "") || 0, created: Date.parse(meta.created_at ?? "") || 0 }
              : null,
          };
          this.metaCache.set(metaPath, cached);
        }
        verdicts[i] = cached.meta;
      } catch { /* partially written metadata, or deleted meanwhile — next poll */ }
    });
    const seen = new Set(names.map(e => join(this.sessionsDir, e)));
    for (const known of this.metaCache.keys()) if (!seen.has(known)) this.metaCache.delete(known);

    let best: { jsonlPath: string; updated: number; createdAtMs: number } | null = null;
    names.forEach((e, i) => {
      const meta = verdicts[i];
      if (meta && (!best || meta.updated > best.updated)) {
        best = { jsonlPath: join(this.sessionsDir, e.replace(/\.json$/, ".jsonl")), updated: meta.updated, createdAtMs: meta.created };
      }
    });
    const chosen = best as { jsonlPath: string; createdAtMs: number } | null;
    if (!chosen) return null;
    try { await stat(chosen.jsonlPath); } catch { return null; }
    return { jsonlPath: chosen.jsonlPath, createdAtMs: chosen.createdAtMs };
  }

  async poll(): Promise<TranscriptEvents> {
    // Current Kiro stores the primary session in SQLite; JSONL is now mostly
    // used for subagents. Keep the legacy path as a compatibility fallback.
    const generation = this.generation;
    const dbEvents = await this.pollDb();
    if (generation !== this.generation) return EMPTY;
    if (dbEvents !== null) return dbEvents;

    const active = await this.resolveActiveSession();
    if (generation !== this.generation || !active) return EMPTY;

    if (active.jsonlPath !== this.currentFile) {
      if (active.createdAtMs >= this.createdAt) {
        this.currentFile = active.jsonlPath;
        this.byteOffset = 0; // our own fresh session — observable from the start
      } else {
        // An older session is attached at its last line boundary. If that cannot be read now, nothing is adopted
        // and the next poll tries again (#1283 review) — never offset 0, which would replay the whole session.
        let offset: number;
        try { offset = await lastLineBoundary(active.jsonlPath); } catch { return EMPTY; }
        if (generation !== this.generation) return EMPTY;
        this.currentFile = active.jsonlPath;
        this.byteOffset = offset;
        return EMPTY;
      }
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
    if (generation !== this.generation) return EMPTY;
    this.byteOffset = newOffset;

    const events = emptyEvents();
    for (const line of lines) {
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      collectKiroEvents(entry, events);
    }
    return events;
  }
}

/**
 * Kiro nests { kind: "toolUse", data: { name, input } } blocks inside
 * AssistantMessage content; exact nesting has shifted across kiro versions,
 * so walk the tree for the kind markers instead of hardcoding a path.
 */
function collectKiroEvents(node: unknown, out: TranscriptEvents, depth = 0): void {
  if (depth > 8 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectKiroEvents(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.kind === "toolUse" && obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    out.toolUses.push({ name: String(d.name ?? "unknown"), input: d.input });
    return;
  }
  if (obj.kind === "toolResult" && obj.data && typeof obj.data === "object") {
    out.toolResults.push({ name: "toolResult" });
    return;
  }
  for (const value of Object.values(obj)) collectKiroEvents(value, out, depth + 1);
}

/* ---------------------------------------------------------------- opencode */

interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
    close(): void;
  };
}

function loadSqlite(): SqliteModule | undefined {
  try {
    return (process as { getBuiltinModule?: (id: string) => unknown })
      .getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;
  } catch { return undefined; }
}

/**
 * Reads tool parts from opencode's sqlite DB for the newest top-level
 * session in this instance's working directory. Rows are cursored by
 * time_created, which is immutable — a part that later flips from `running`
 * to `completed` only changes time_updated, so each tool use emits once.
 *
 * Requires node:sqlite (Node ≥22.13); silently inert otherwise, matching the
 * session-resume feature's degradation.
 */
export class OpenCodeDbSource implements TranscriptSource {
  private sessionId: string | null = null;
  private partCursor = 0;
  private readonly createdAt: number;

  constructor(
    private workingDirectory: string,
    private dbPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db"),
    now = Date.now(),
  ) {
    this.createdAt = now;
  }

  reset(): void {
    this.sessionId = null;
    this.partCursor = 0;
  }

  async poll(): Promise<TranscriptEvents> {
    const sqlite = loadSqlite();
    if (!sqlite || !existsSync(this.dbPath)) return EMPTY;
    let db: InstanceType<SqliteModule["DatabaseSync"]>;
    try {
      db = new sqlite.DatabaseSync(this.dbPath, { readOnly: true });
    } catch { return EMPTY; }
    try {
      const session = db.prepare(
        "SELECT id, time_created FROM session WHERE directory = ? AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 1",
      ).get(this.workingDirectory) as { id: string; time_created: number } | undefined;
      if (!session) return EMPTY;

      if (session.id !== this.sessionId) {
        this.sessionId = session.id;
        // Fresh session started under us → report from its beginning;
        // pre-existing session → only new parts.
        this.partCursor = session.time_created >= this.createdAt ? 0 : Date.now();
      }

      const rows = db.prepare(
        "SELECT data, time_created FROM part WHERE session_id = ? AND time_created > ? ORDER BY time_created ASC LIMIT 100",
      ).all(this.sessionId, this.partCursor) as Array<{ data: string; time_created: number }>;

      const events = emptyEvents();
      for (const row of rows) {
        this.partCursor = Math.max(this.partCursor, row.time_created);
        let data: Record<string, unknown>;
        try { data = JSON.parse(row.data); } catch { continue; }
        if (data.type === "tool") {
          const state = data.state as Record<string, unknown> | undefined;
          events.toolUses.push({ name: String(data.tool ?? "unknown"), input: state?.input });
        } else if (data.type === "text") {
          const text = data.text;
          if (typeof text === "string" && text.trim()) events.assistantTexts.push(text);
        }
      }
      return events;
    } catch {
      return EMPTY;
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

/* ----------------------------------------------------------------- factory */

/**
 * Source for a backend, or null for backends handled elsewhere (claude-code
 * lives inside TranscriptMonitor) and backends with no known source
 * (antigravity — nothing usable found on disk; grok has
 * events.jsonl with tool names only and can be added later).
 */
export function createTranscriptSource(
  backend: string,
  workingDirectory: string,
  /** The credential profile's store, when this instance runs on one. */
  storeHome?: string,
): TranscriptSource | null {
  switch (backend) {
    case "codex": return new CodexRolloutSource(workingDirectory);
    case "muse": return new MuseSessionSource(workingDirectory);
    // undefined keeps each parameter's own default; only the store moves.
    case "kiro-cli": return new KiroSessionSource(workingDirectory, undefined, undefined, kiroStoreDbPath(storeHome));
    case "opencode": return new OpenCodeDbSource(workingDirectory);
    default: return null;
  }
}
