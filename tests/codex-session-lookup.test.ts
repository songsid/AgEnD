/**
 * #984 F3 phase 3.1: exact-cwd Codex session lookup.
 *
 * Every database here is built from the real codex-cli 0.157.0 state_5.sqlite
 * schema (tests/fixtures/codex-0157-state5-schema.sql, no rows) in WAL mode,
 * like the live file, and every case calls the production module.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexSiblingState,
  defaultGitCommonDir,
  findExactCwdCodexSession,
  openCodexStateReadonly,
  planCodexResume,
  rolloutRecordsTurn,
} from "../src/backend/codex-session-lookup.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-schema.sql", import.meta.url)), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix = "agend-codex-lookup-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

let seq = 0;
const uuid = () => `019f${String(++seq).padStart(4, "0")}-0000-7000-8000-${String(seq).padStart(12, "0")}`;

interface Thread {
  id?: string;
  cwd: string;
  recency: number;
  source?: string;
  archived?: 0 | 1;
  /** Real 0.157 sessions carry 0 here whatever they hold (#1017). */
  hasUserEvent?: 0 | 1;
  /** Empty exactly for a thread nobody wrote to. */
  firstUserMessage?: string;
  updated?: number;
}

/** A state_5.sqlite with the real 0.157.0 schema, closed so only the lookup holds it. */
function stateDb(threads: Thread[], dir = tempDir()): { path: string; ids: string[] } {
  const path = join(dir, "state_5.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
    VALUES (@id, '/r.jsonl', 1, 1, @source, 'openai', @cwd, 't', 'danger-full-access', 'never',
      @hasUserEvent, @firstUserMessage, @archived, @recency, @updated)
  `);
  const ids = threads.map(t => {
    const id = t.id ?? uuid();
    insert.run({
      id, cwd: t.cwd, recency: t.recency, source: t.source ?? "cli", archived: t.archived ?? 0,
      hasUserEvent: t.hasUserEvent ?? 0, firstUserMessage: t.firstUserMessage ?? "a question", updated: t.updated ?? t.recency,
    });
    return id;
  });
  db.close();
  return { path, ids };
}

/**
 * Rows exactly as Codex wrote them (redacted text), plus the structure of the
 * same threads' rollout heads, so the filter is judged against what real
 * sessions look like rather than what a fixture assumes.
 */
type RealRow = "resumable_0157" | "empty_0157" | "metadata_empty_real_0156" | "first_turn_no_tokens" | "goal_first_0157";
const REAL = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/codex-real-threads.json", import.meta.url)), "utf8")) as {
  rows: Record<RealRow, Record<string, unknown>>;
  rollout_heads: Record<"metadata_empty_real_0156" | "untouched_fork_0157" | "resumable_0157" | "goal_first_0157", unknown[]>;
  goal_first_heads: Record<"pattern_a_goal_context_first" | "pattern_b_leading_interrupted_turn", unknown[]>;
};
const HEAD_OF: Partial<Record<RealRow, keyof typeof REAL.rollout_heads>> = {
  resumable_0157: "resumable_0157", empty_0157: "untouched_fork_0157", metadata_empty_real_0156: "metadata_empty_real_0156",
  goal_first_0157: "goal_first_0157",
};
function realStateDb(rows: Array<{ name: RealRow; cwd: string; recency: number; rollout?: "real" | "missing" | unknown[]; id?: string }>): string {
  const dir = tempDir();
  const path = join(dir, "state_5.sqlite");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  for (const { name, cwd, recency, rollout = "real", id } of rows) {
    const row = id ? { ...REAL.rows[name], id } : REAL.rows[name];
    const rolloutPath = join(dir, `rollout-${String(row.id)}.jsonl`);
    const head = HEAD_OF[name];
    const lines = Array.isArray(rollout) ? rollout : rollout === "real" && head ? REAL.rollout_heads[head] : null;
    if (lines) writeFileSync(rolloutPath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    const values = { ...row, cwd, rollout_path: rolloutPath, recency_at_ms: recency, updated_at_ms: recency };
    const cols = Object.keys(values);
    db.prepare(`INSERT INTO threads (${cols.join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`).run(values);
  }
  db.close();
  return path;
}

describe("the lookup against real Codex thread rows (#1017)", () => {
  it("resumes a real 0.157 session even though Codex left has_user_event at 0", () => {
    expect(REAL.rows.resumable_0157.has_user_event).toBe(0); // what Codex really writes
    const path = realStateDb([{ name: "resumable_0157", cwd: "/w/app", recency: 100 }]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.resumable_0157.id });
  });

  it("resumes a real session whose provider reports no token usage", () => {
    expect(REAL.rows.first_turn_no_tokens.tokens_used).toBe(0);
    const path = realStateDb([{ name: "first_turn_no_tokens", cwd: "/w/app", recency: 100 }]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.first_turn_no_tokens.id });
  });

  it("resumes a real session whose list metadata is empty, by its rollout (cf. openai/codex#28423)", () => {
    expect(REAL.rows.metadata_empty_real_0156).toMatchObject({ first_user_message: "", tokens_used: 0 });
    const path = realStateDb([{ name: "metadata_empty_real_0156", cwd: "/w/app", recency: 100 }]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.metadata_empty_real_0156.id });
    // With no metadata sign at all (has_user_event 0, empty first message),
    // a missing rollout leaves nothing to resume.
    const gone = realStateDb([{ name: "goal_first_0157", cwd: "/w/app", recency: 100, rollout: "missing" }]);
    expect(findExactCwdCodexSession(gone, "/w/app")).toEqual({ kind: "none" });
  });

  it("resumes a REAL /goal-first 0.157 session, which Codex leaves with an empty first_user_message", () => {
    // Made for this review: `/goal <objective>` as the first input, one turn,
    // goal complete, resumed by id. openai/codex#28423 still holds in 0.157.
    expect(REAL.rows.goal_first_0157).toMatchObject({ cli_version: "0.157.0", first_user_message: "", has_user_event: 0 });
    expect(REAL.rows.goal_first_0157.tokens_used).toBeGreaterThan(0);
    const path = realStateDb([
      { name: "resumable_0157", cwd: "/w/app", recency: 100 },
      { name: "goal_first_0157", cwd: "/w/app", recency: 500 },
    ]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.goal_first_0157.id });
  });

  it.each(["pattern_a_goal_context_first", "pattern_b_leading_interrupted_turn"] as const)(
    "resumes a modelled /goal-first shape with empty list metadata (openai/codex#28423, %s)", (pattern) => {
      // The real metadata-empty row, carrying the rollout shape the issue documents.
      const path = realStateDb([
        { name: "resumable_0157", cwd: "/w/app", recency: 100 },
        { name: "metadata_empty_real_0156", cwd: "/w/app", recency: 500, rollout: REAL.goal_first_heads[pattern] },
      ]);
      expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.metadata_empty_real_0156.id });
    });

  it("looks past any number of newer empty threads to the older real session", () => {
    const path = realStateDb([
      { name: "resumable_0157", cwd: "/w/app", recency: 1 },
      ...Array.from({ length: 120 }, (_, i) => ({ name: "empty_0157" as const, cwd: "/w/app", recency: 1000 + i, id: `019f7777-0000-7000-8000-${String(i).padStart(12, "0")}` })),
    ]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.resumable_0157.id });
  });

  it("never resumes less than the #984 lookup: a has_user_event=1 thread is kept even with no other sign", () => {
    const row = { ...REAL.rows.empty_0157, id: "019f8888-0000-7000-8000-000000000001", has_user_event: 1 };
    const dir = tempDir();
    const path = join(dir, "state_5.sqlite");
    const db = new Database(path);
    db.exec(SCHEMA);
    const values = { ...row, cwd: "/w/app", rollout_path: join(dir, "missing.jsonl"), recency_at_ms: 1, updated_at_ms: 1 };
    const cols = Object.keys(values);
    db.prepare(`INSERT INTO threads (${cols.join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`).run(values);
    db.close();
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: row.id });
  });

  it("skips a real untouched fork for the older real session behind it", () => {
    const path = realStateDb([
      { name: "resumable_0157", cwd: "/w/app", recency: 100 },
      { name: "empty_0157", cwd: "/w/app", recency: 900 },
    ]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: REAL.rows.resumable_0157.id });
    const onlyEmpty = realStateDb([{ name: "empty_0157", cwd: "/w/app", recency: 900 }]);
    expect(findExactCwdCodexSession(onlyEmpty, "/w/app")).toEqual({ kind: "none" });
  });
});

describe("rolloutRecordsTurn", () => {
  const write = (lines: unknown[] | string) => {
    const path = join(tempDir(), "rollout.jsonl");
    writeFileSync(path, typeof lines === "string" ? lines : lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    return path;
  };
  it("is yes once any turn ran, however its first input arrived, and no for a thread nobody used", () => {
    expect(rolloutRecordsTurn(write(REAL.rollout_heads.untouched_fork_0157))).toBe(false);
    expect(rolloutRecordsTurn(write([{ type: "session_meta", payload: {} }, { type: "event_msg", payload: { type: "task_started" } }]))).toBe(true);
    expect(rolloutRecordsTurn(write([{ type: "session_meta", payload: {} }, { type: "turn_context", payload: {} }]))).toBe(true);
    expect(rolloutRecordsTurn(write([{ type: "session_meta", payload: {} }, { type: "response_item", payload: { type: "message", role: "developer" } }]))).toBe(true);
  });
  it("is no for a missing file, and yes for a file it cannot recognise as a Codex rollout (fail-safe)", () => {
    expect(rolloutRecordsTurn(join(tempDir(), "gone.jsonl"))).toBe(false);
    // "No" needs a recognisable rollout with no turn; anything else keeps the thread.
    expect(rolloutRecordsTurn(write('{"type":"response_item" broken\n'))).toBe(true);
    expect(rolloutRecordsTurn(write([{ type: "some_future_entry", payload: {} }]))).toBe(true);
    expect(rolloutRecordsTurn(write(""))).toBe(true);
  });
  it("is no only for the known untouched shape: anything else after session_meta keeps the thread", () => {
    // The real untouched fork, and the same shape with a huge session_meta.
    expect(rolloutRecordsTurn(write(REAL.rollout_heads.untouched_fork_0157))).toBe(false);
    // A newer Codex's entry type, or a line this code cannot parse, is not proof of emptiness.
    expect(rolloutRecordsTurn(write([{ type: "session_meta", payload: {} }, { type: "some_future_entry", payload: {} }]))).toBe(true);
    expect(rolloutRecordsTurn(write([{ type: "session_meta", payload: {} }, { type: "event_msg", payload: { type: "some_future_event" } }]))).toBe(true);
    expect(rolloutRecordsTurn(write('{"type":"session_meta","payload":{}}\n{broken\n'))).toBe(true);
  });
  it("reads past any head size: an oversized empty thread is no, a turn after a huge session_meta is yes", () => {
    // Real session_meta lines are ~22 KB; these are far past any chunk, with
    // multi-byte text straddling chunk edges.
    const meta = { type: "session_meta", payload: { base_instructions: "指令".repeat(700_000) } };
    expect(rolloutRecordsTurn(write([meta, { type: "event_msg", payload: { type: "thread_settings_applied" } }]))).toBe(false);
    expect(rolloutRecordsTurn(write([meta, { type: "event_msg", payload: { type: "task_started" } }]))).toBe(true);
  });
});

describe("findExactCwdCodexSession", () => {
  it("picks the instance's own newest thread even when a sibling worktree's is newer", () => {
    const { path, ids } = stateDb([
      { cwd: "/w/app-main", recency: 100 },
      { cwd: "/w/app-main", recency: 200 },
      { cwd: "/w/app-designer", recency: 900 },
    ]);
    expect(findExactCwdCodexSession(path, "/w/app-main")).toEqual({ kind: "found", id: ids[1] });
  });

  it("matches the cwd exactly — never a prefix, a longer sibling name or a subdirectory", () => {
    const { path, ids } = stateDb([
      { cwd: "/w/app", recency: 100 },
      { cwd: "/w/app-b", recency: 900 },
      { cwd: "/w/app/sub", recency: 900 },
      { cwd: "/w/ap", recency: 900 },
      { cwd: "/w/APP", recency: 900 },
    ]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: ids[0] });
    expect(findExactCwdCodexSession(path, "/w")).toEqual({ kind: "none" });
  });

  it("skips subagent and non-interactive threads, archived threads and threads with no user input", () => {
    const { path, ids } = stateDb([
      { cwd: "/w/app", recency: 100 },
      { cwd: "/w/app", recency: 900, source: JSON.stringify({ subagent: { thread_spawn: { depth: 1 } } }) },
      { cwd: "/w/app", recency: 900, source: "exec" },
      { cwd: "/w/app", recency: 900, archived: 1 },
      { cwd: "/w/app", recency: 900, firstUserMessage: "" },
    ]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: ids[0] });
  });

  it("orders by recency, then updated time", () => {
    const { path, ids } = stateDb([
      { cwd: "/w/app", recency: 300, updated: 1 },
      { cwd: "/w/app", recency: 300, updated: 5 },
      { cwd: "/w/app", recency: 100, updated: 999 },
    ]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: ids[1] });
  });

  it("reports none when this directory has no interactive thread", () => {
    const { path } = stateDb([{ cwd: "/w/other", recency: 100 }]);
    expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "none" });
  });

  it("matches a working directory reached through a symlink, whichever form Codex recorded", () => {
    const root = tempDir();
    const real = join(root, "real-app");
    mkdirSync(real);
    const link = join(root, "linked-app");
    symlinkSync(real, link);
    const recordedReal = stateDb([{ cwd: real, recency: 100 }]);
    expect(findExactCwdCodexSession(recordedReal.path, link)).toEqual({ kind: "found", id: recordedReal.ids[0] });
    const recordedLink = stateDb([{ cwd: link, recency: 100 }]);
    expect(findExactCwdCodexSession(recordedLink.path, link)).toEqual({ kind: "found", id: recordedLink.ids[0] });
  });

  it("treats a missing column, a missing table, a missing file and a non-UUID id as unreadable", () => {
    const dir = tempDir();
    const drifted = join(dir, "drifted.sqlite");
    const db = new Database(drifted);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, source TEXT, archived INTEGER, recency_at_ms INTEGER, updated_at_ms INTEGER)");
    db.close();
    expect(findExactCwdCodexSession(drifted, "/w/app")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("has_user_event") });

    const empty = join(dir, "empty.sqlite");
    new Database(empty).close();
    expect(findExactCwdCodexSession(empty, "/w/app").kind).toBe("unreadable");

    // The directory exists (like ~/.codex before Codex ever ran): the lookup
    // must not create the database there.
    const missing = join(dir, "state_5.sqlite");
    expect(findExactCwdCodexSession(missing, "/w/app").kind).toBe("unreadable");
    expect(existsSync(missing)).toBe(false);

    const bad = stateDb([{ id: "not-a-session-uuid", cwd: "/w/app", recency: 100 }]);
    expect(findExactCwdCodexSession(bad.path, "/w/app")).toMatchObject({ kind: "unreadable", reason: expect.stringContaining("UUID") });
  });

  it("opens Codex's database read-only and leaves the database bytes unchanged", () => {
    const dir = tempDir();
    const { path, ids } = stateDb([{ cwd: "/w/app", recency: 100 }], dir);
    const digest = (name: string) => createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
    const before = digest("state_5.sqlite");

    const probe = openCodexStateReadonly(path);
    expect(probe.readonly).toBe(true);
    expect(() => probe.prepare("UPDATE threads SET archived = 1").run()).toThrow(/readonly/i);
    probe.close();
    const open = vi.fn(openCodexStateReadonly);
    expect(findExactCwdCodexSession(path, "/w/app", open)).toEqual({ kind: "found", id: ids[0] });
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.results[0]?.value.readonly).toBe(true);
    expect(digest("state_5.sqlite")).toBe(before);
    // With no writer attached, SQLite's read-only WAL open recreates its own
    // sidecars — exactly the files Codex itself keeps there — and the WAL
    // stays empty: nothing was written.
    expect(readdirSync(dir).sort().filter(name => name !== "state_5.sqlite")
      .every(name => name === "state_5.sqlite-shm" || name === "state_5.sqlite-wal")).toBe(true);
    if (existsSync(`${path}-wal`)) expect(readFileSync(`${path}-wal`).length).toBe(0);
  });

  it("reads a live WAL database that another connection is writing", () => {
    const dir = tempDir();
    const { path, ids } = stateDb([{ cwd: "/w/app", recency: 100 }], dir);
    const writer = new Database(path);
    try {
      writer.prepare("UPDATE threads SET recency_at_ms = 500 WHERE id = ?").run(ids[0]);
      expect(findExactCwdCodexSession(path, "/w/app")).toEqual({ kind: "found", id: ids[0] });
    } finally { writer.close(); }
  });
});

describe("codexSiblingState", () => {
  const table = (map: Record<string, string | null | "unknown">) => (dir: string) => map[dir] ?? null;

  it("finds a sibling only in the same repository", () => {
    const git = table({ "/w/a": "/repo/.git", "/w/b": "/repo/.git", "/w/c": "/other/.git" });
    expect(codexSiblingState("/w/a", ["/w/b"], git)).toBe("siblings");
    expect(codexSiblingState("/w/a", ["/w/c", "/plain"], git)).toBe("alone");
    expect(codexSiblingState("/plain", ["/w/a"], git)).toBe("alone");
  });

  it("counts an undeterminable repository as a sibling", () => {
    expect(codexSiblingState("/w/a", [], table({ "/w/a": "unknown" }))).toBe("siblings");
    expect(codexSiblingState("/w/a", ["/w/x"], table({ "/w/a": "/repo/.git", "/w/x": "unknown" }))).toBe("siblings");
  });

  it("reads real git worktrees, plain directories and missing ones", () => {
    const root = tempDir();
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", join(root, "wa"), "-b", "wa"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", join(root, "wb"), "-b", "wb"]);
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(defaultGitCommonDir(join(root, "wa"))).toBe(defaultGitCommonDir(join(root, "wb")));
    expect(defaultGitCommonDir(plain)).toBeNull();
    expect(codexSiblingState(join(root, "wa"), [join(root, "wb")])).toBe("siblings");
    expect(codexSiblingState(join(root, "wa"), [plain])).toBe("alone");
    expect(defaultGitCommonDir(join(root, "does-not-exist"))).toBe("unknown");
  });
});

describe("planCodexResume", () => {
  const id = "019fa7a4-1632-7693-a160-ea92d168a15b";

  it("resumes the exact session and never asks about siblings when the lookup worked", () => {
    const siblings = vi.fn(() => "siblings" as const);
    expect(planCodexResume({ kind: "found", id }, siblings)).toEqual({ mode: "resume", id });
    expect(planCodexResume({ kind: "none" }, siblings)).toEqual({ mode: "fresh", reason: "no-session" });
    expect(siblings).not.toHaveBeenCalled();
  });

  it("on an unreadable database starts fresh with siblings and falls back to --last without", () => {
    const unreadable = { kind: "unreadable" as const, reason: "SQLITE_BUSY" };
    expect(planCodexResume(unreadable, () => "siblings")).toMatchObject({
      mode: "fresh", reason: "unreadable-with-siblings", warning: expect.stringContaining("SQLITE_BUSY"),
    });
    expect(planCodexResume(unreadable, () => "alone")).toMatchObject({ mode: "last", warning: expect.stringContaining("SQLITE_BUSY") });
  });
});
