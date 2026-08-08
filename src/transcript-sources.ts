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
 *   kiro-cli  — ~/.kiro/sessions/cli/<uuid>.jsonl with a sibling <uuid>.json
 *               carrying { cwd, updated_at }
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

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolUseEvent { name: string; input: unknown }

export interface TranscriptEvents {
  toolUses: ToolUseEvent[];
  toolResults: Array<{ name: string }>;
  assistantTexts: string[];
}

export interface TranscriptSource {
  /** Read events that appeared since the previous call. Invoked serially. */
  poll(): Promise<TranscriptEvents>;
  /** Forget the current position; the next poll re-resolves and re-baselines. */
  reset(): void;
}

const EMPTY: TranscriptEvents = { toolUses: [], toolResults: [], assistantTexts: [] };

function emptyEvents(): TranscriptEvents {
  return { toolUses: [], toolResults: [], assistantTexts: [] };
}

/** Shared JSONL tailer: byte-offset incremental reads of a single file. */
async function readNewLines(path: string, fromOffset: number): Promise<{ lines: string[]; newOffset: number }> {
  const stats = await stat(path);
  if (stats.size <= fromOffset) return { lines: [], newOffset: fromOffset };
  const fh = await open(path, "r");
  try {
    const length = stats.size - fromOffset;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, fromOffset);
    return { lines: buffer.toString("utf-8").split("\n").filter(l => l.trim()), newOffset: stats.size };
  } finally {
    await fh.close();
  }
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
  private readonly createdAt: number;
  /** Files whose session_meta was read and did NOT match our cwd. */
  private rejected = new Set<string>();

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions"),
    now = Date.now(),
  ) {
    this.createdAt = now;
  }

  reset(): void {
    this.currentFile = null;
    this.byteOffset = 0;
  }

  /** Newest rollout files first, bounded to the last two date shards. */
  private candidateFiles(): Array<{ path: string; mtimeMs: number }> {
    const out: Array<{ path: string; mtimeMs: number }> = [];
    const walk = (dir: string, depth: number): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      // Date-sharded YYYY/MM/DD tree: at each level only the two newest
      // subdirs can contain today's/yesterday's rollouts.
      const dirs: string[] = [];
      for (const e of entries) {
        const p = join(dir, e);
        try {
          const st = statSync(p);
          if (st.isDirectory()) dirs.push(e);
          else if (depth >= 3 && e.startsWith("rollout-") && e.endsWith(".jsonl")) {
            out.push({ path: p, mtimeMs: st.mtimeMs });
          }
        } catch { /* raced with deletion */ }
      }
      if (depth < 3) {
        for (const d of dirs.sort().reverse().slice(0, 2)) walk(join(dir, d), depth + 1);
      }
    };
    walk(this.sessionsDir, 0);
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  private fileBelongsToUs(path: string): boolean {
    if (this.rejected.has(path)) return false;
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
      if (meta?.type === "session_meta" && cwd === this.workingDirectory) return true;
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
      this.currentFile = active.path;
      // A rollout born after this source existed is our own fresh session —
      // read it from the start. A pre-existing one is history — baseline EOF.
      if (active.mtimeMs >= this.createdAt) {
        this.byteOffset = 0;
      } else {
        try { this.byteOffset = (await stat(active.path)).size; } catch { this.byteOffset = 0; }
        return EMPTY;
      }
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
    this.byteOffset = newOffset;

    const events = emptyEvents();
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "response_item") continue;
      const p = entry.payload as Record<string, unknown> | undefined;
      if (!p) continue;
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
    return events;
  }
}

/* -------------------------------------------------------------------- kiro */

/**
 * Follows the newest kiro session whose metadata cwd matches this instance's
 * working directory. Session transcript is <uuid>.jsonl; ownership and
 * recency come from the sibling <uuid>.json ({ cwd, updated_at,
 * session_created_reason }).
 */
export class KiroSessionSource implements TranscriptSource {
  private currentFile: string | null = null;
  private byteOffset = 0;
  private readonly createdAt: number;

  constructor(
    private workingDirectory: string,
    private sessionsDir = join(homedir(), ".kiro", "sessions", "cli"),
    now = Date.now(),
  ) {
    this.createdAt = now;
  }

  reset(): void {
    this.currentFile = null;
    this.byteOffset = 0;
  }

  private resolveActiveSession(): { jsonlPath: string; createdAtMs: number } | null {
    let entries: string[];
    try { entries = readdirSync(this.sessionsDir); } catch { return null; }
    let best: { jsonlPath: string; updated: number; createdAtMs: number } | null = null;
    for (const e of entries) {
      if (!e.endsWith(".json") || e.endsWith(".jsonl")) continue;
      const metaPath = join(this.sessionsDir, e);
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (meta.cwd !== this.workingDirectory) continue;
        // Subagent sessions are children of a turn already being reported.
        if (meta.session_created_reason === "subagent") continue;
        const updated = Date.parse(meta.updated_at ?? "") || 0;
        const created = Date.parse(meta.created_at ?? "") || 0;
        if (!best || updated > best.updated) {
          const jsonlPath = join(this.sessionsDir, e.replace(/\.json$/, ".jsonl"));
          best = { jsonlPath, updated, createdAtMs: created };
        }
      } catch { /* partially written metadata — next poll */ }
    }
    return best && existsSync(best.jsonlPath)
      ? { jsonlPath: best.jsonlPath, createdAtMs: best.createdAtMs }
      : null;
  }

  async poll(): Promise<TranscriptEvents> {
    const active = this.resolveActiveSession();
    if (!active) return EMPTY;

    if (active.jsonlPath !== this.currentFile) {
      this.currentFile = active.jsonlPath;
      if (active.createdAtMs >= this.createdAt) {
        this.byteOffset = 0; // our own fresh session — observable from the start
      } else {
        try { this.byteOffset = (await stat(active.jsonlPath)).size; } catch { this.byteOffset = 0; }
        return EMPTY;
      }
    }

    const { lines, newOffset } = await readNewLines(this.currentFile, this.byteOffset);
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
 * (antigravity, gemini-cli — nothing usable found on disk; grok has
 * events.jsonl with tool names only and can be added later).
 */
export function createTranscriptSource(
  backend: string,
  workingDirectory: string,
): TranscriptSource | null {
  switch (backend) {
    case "codex": return new CodexRolloutSource(workingDirectory);
    case "kiro-cli": return new KiroSessionSource(workingDirectory);
    case "opencode": return new OpenCodeDbSource(workingDirectory);
    default: return null;
  }
}
