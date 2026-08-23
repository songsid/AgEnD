import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CodexRolloutSource, KiroSessionSource, OpenCodeDbSource } from "../src/transcript-sources.js";

const TEST_ROOT = "/tmp/ccd-test-transcript-sources";
const WORK_DIR = "/tmp/ccd-test-ts-workdir";

const sqlite = (process as { getBuiltinModule?: (id: string) => unknown })
  .getBuiltinModule?.("node:sqlite") as
  | { DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    } }
  | undefined;

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ codex */

describe("CodexRolloutSource", () => {
  const sessionsDir = join(TEST_ROOT, "codex-sessions");
  const dayDir = join(sessionsDir, "2026", "08", "08");

  function writeRollout(name: string, cwd: string, extraLines: string[] = []): string {
    mkdirSync(dayDir, { recursive: true });
    const path = join(dayDir, name);
    const meta = JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "x", cwd } });
    writeFileSync(path, [meta, ...extraLines].join("\n") + "\n");
    return path;
  }

  function functionCallLine(name: string, args: unknown): string {
    return JSON.stringify({ type: "response_item", payload: { type: "function_call", name, arguments: JSON.stringify(args) } });
  }

  it("reads tool calls only from the rollout whose session_meta cwd matches", async () => {
    const source = new CodexRolloutSource(WORK_DIR, sessionsDir, Date.now() - 1000);
    writeRollout("rollout-2026-08-08T01-owned.jsonl", WORK_DIR, [functionCallLine("shell", { command: ["bash", "-lc", "npm test"] })]);
    writeRollout("rollout-2026-08-08T02-foreign.jsonl", "/somewhere/else", [functionCallLine("shell", { command: ["bash", "-lc", "rm -rf /"] })]);

    const events = await source.poll();
    expect(events.toolUses).toHaveLength(1);
    expect(events.toolUses[0].name).toBe("shell");
    expect((events.toolUses[0].input as { command: string[] }).command[2]).toBe("npm test");
  });

  it("parses custom_tool_call payloads (codex exec)", async () => {
    const source = new CodexRolloutSource(WORK_DIR, sessionsDir, Date.now() - 1000);
    const line = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.view_image({})" } });
    writeRollout("rollout-2026-08-08T03-custom.jsonl", WORK_DIR, [line]);

    const events = await source.poll();
    expect(events.toolUses).toHaveLength(1);
    expect(events.toolUses[0].name).toBe("exec");
  });

  it("emits only new lines on subsequent polls", async () => {
    const source = new CodexRolloutSource(WORK_DIR, sessionsDir, Date.now() - 1000);
    const path = writeRollout("rollout-2026-08-08T04-inc.jsonl", WORK_DIR, [functionCallLine("shell", { command: ["bash", "-lc", "a"] })]);
    expect((await source.poll()).toolUses).toHaveLength(1);
    expect((await source.poll()).toolUses).toHaveLength(0);

    appendFileSync(path, functionCallLine("shell", { command: ["bash", "-lc", "b"] }) + "\n");
    expect((await source.poll()).toolUses).toHaveLength(1);
  });

  it("switches to a newer rollout when the CLI restarts (#528 trap 1)", async () => {
    const source = new CodexRolloutSource(WORK_DIR, sessionsDir, Date.now() - 1000);
    writeRollout("rollout-2026-08-08T05-old.jsonl", WORK_DIR, [functionCallLine("shell", { command: ["bash", "-lc", "old"] })]);
    await source.poll();

    // New rollout appears with a newer mtime — the source must follow it.
    await new Promise(r => setTimeout(r, 10));
    writeRollout("rollout-2026-08-08T06-new.jsonl", WORK_DIR, [functionCallLine("shell", { command: ["bash", "-lc", "fresh"] })]);
    const events = await source.poll();
    expect(events.toolUses.map(u => (u.input as { command: string[] }).command[2])).toContain("fresh");
  });

  it("follows a resumed rollout in an old date shard", async () => {
    const oldDir = join(sessionsDir, "2026", "01", "01");
    const recentDir = join(sessionsDir, "2026", "08", "23");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(recentDir, { recursive: true });
    const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { cwd } });
    const resumed = join(oldDir, "rollout-old-but-resumed.jsonl");
    writeFileSync(resumed, meta(WORK_DIR) + "\n");
    writeFileSync(join(recentDir, "rollout-recent-foreign.jsonl"), meta("/foreign") + "\n");

    const source = new CodexRolloutSource(WORK_DIR, sessionsDir);
    appendFileSync(resumed, functionCallLine("shell", { command: "resumed work" }) + "\n");

    const events = await source.poll();
    expect(events.toolUses).toEqual([{ name: "shell", input: { command: "resumed work" } }]);
  });

  it("baselines a pre-existing rollout to EOF instead of replaying history", async () => {
    writeRollout("rollout-2026-08-08T07-hist.jsonl", WORK_DIR, [functionCallLine("shell", { command: ["bash", "-lc", "history"] })]);
    // Source created AFTER the rollout existed (mtime in the past relative to createdAt)
    await new Promise(r => setTimeout(r, 10));
    const source = new CodexRolloutSource(WORK_DIR, sessionsDir);
    expect((await source.poll()).toolUses).toHaveLength(0); // history skipped

    appendFileSync(join(dayDir, "rollout-2026-08-08T07-hist.jsonl"), functionCallLine("shell", { command: ["bash", "-lc", "live"] }) + "\n");
    const events = await source.poll();
    expect(events.toolUses).toHaveLength(1);
    expect((events.toolUses[0].input as { command: string[] }).command[2]).toBe("live");
  });

  it("returns nothing when the sessions dir does not exist", async () => {
    const source = new CodexRolloutSource(WORK_DIR, join(TEST_ROOT, "missing"));
    expect((await source.poll()).toolUses).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------- kiro */

describe("KiroSessionSource", () => {
  const sessionsDir = join(TEST_ROOT, "kiro-sessions");
  const missingDb = join(TEST_ROOT, "missing-kiro.sqlite3");

  function writeSession(id: string, cwd: string, opts: { updatedAt?: string; createdAt?: string; reason?: string; lines?: string[] } = {}): string {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({
      session_id: id,
      cwd,
      created_at: opts.createdAt ?? new Date().toISOString(),
      updated_at: opts.updatedAt ?? new Date().toISOString(),
      ...(opts.reason ? { session_created_reason: opts.reason } : {}),
    }));
    const jsonl = join(sessionsDir, `${id}.jsonl`);
    writeFileSync(jsonl, (opts.lines ?? []).map(l => l + "\n").join(""));
    return jsonl;
  }

  // Real kiro shape: toolUse blocks nested inside AssistantMessage content.
  function assistantToolUse(name: string, input: unknown): string {
    return JSON.stringify({
      version: "v1",
      kind: "AssistantMessage",
      data: { content: [{ kind: "toolUse", data: { toolUseId: "t1", name, input } }] },
    });
  }

  it("follows the newest session for this cwd and parses nested toolUse blocks", async () => {
    const source = new KiroSessionSource(WORK_DIR, sessionsDir, Date.now() - 1000, missingDb);
    writeSession("aaa", WORK_DIR, { lines: [assistantToolUse("shell", { command: "npm test" })] });
    writeSession("bbb", "/other/dir", { lines: [assistantToolUse("shell", { command: "foreign" })] });

    const events = await source.poll();
    expect(events.toolUses).toHaveLength(1);
    expect(events.toolUses[0].name).toBe("shell");
    expect((events.toolUses[0].input as { command: string }).input ?? (events.toolUses[0].input as { command: string }).command).toBe("npm test");
  });

  it("skips subagent-created sessions", async () => {
    const source = new KiroSessionSource(WORK_DIR, sessionsDir, Date.now() - 1000, missingDb);
    writeSession("sub", WORK_DIR, { reason: "subagent", lines: [assistantToolUse("shell", { command: "sub work" })] });
    expect((await source.poll()).toolUses).toHaveLength(0);
  });

  it("baselines a pre-existing session to EOF, then reports only new lines", async () => {
    const jsonl = writeSession("ccc", WORK_DIR, {
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lines: [assistantToolUse("shell", { command: "history" })],
    });
    const source = new KiroSessionSource(WORK_DIR, sessionsDir, Date.now(), missingDb);
    expect((await source.poll()).toolUses).toHaveLength(0);

    appendFileSync(jsonl, assistantToolUse("shell", { command: "live" }) + "\n");
    const events = await source.poll();
    expect(events.toolUses).toHaveLength(1);
  });

  it("tails primary Kiro 2.19 conversations from data.sqlite3", async () => {
    const dbPath = join(TEST_ROOT, "kiro-data.sqlite3");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE conversations_v2 (
      key TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, conversation_id)
    )`);
    const oldHistory = [{ user: { content: { Prompt: {} } }, assistant: { Response: { content: "history" } } }];
    db.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)")
      .run(WORK_DIR, "conversation-live", JSON.stringify({ history: oldHistory }), Date.now() - 60_000, Date.now() - 10_000);

    const source = new KiroSessionSource(WORK_DIR, sessionsDir, Date.now(), dbPath);
    expect((await source.poll()).toolUses).toHaveLength(0);

    const liveEntry = {
      user: { content: { ToolUseResults: { tool_use_results: [] } } },
      assistant: { ToolUse: { tool_uses: [{ id: "tool-1", name: "execute_bash", args: { command: "npm test" } }] } },
    };
    db.prepare("UPDATE conversations_v2 SET value = ?, updated_at = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ history: [...oldHistory, liveEntry] }), Date.now(), "conversation-live");

    const events = await source.poll();
    expect(events.toolUses).toEqual([{ name: "execute_bash", input: { command: "npm test" } }]);
    db.close();
  });
});

/* ---------------------------------------------------------------- opencode */

describe.skipIf(!sqlite)("OpenCodeDbSource", () => {
  const dbPath = join(TEST_ROOT, "opencode.db");

  function seed(opts: {
    sessions: Array<{ id: string; directory: string; parentId?: string | null; created: number; updated: number }>;
    parts?: Array<{ id: string; sessionId: string; created: number; data: unknown }>;
  }): void {
    const db = new sqlite!.DatabaseSync(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)");
    for (const s of opts.sessions) {
      db.prepare("INSERT OR REPLACE INTO session VALUES (?, ?, ?, ?, ?)").run(s.id, s.directory, s.parentId ?? null, s.created, s.updated);
    }
    for (const p of opts.parts ?? []) {
      db.prepare("INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?)").run(p.id, p.sessionId, p.created, JSON.stringify(p.data));
    }
    db.close();
  }

  it("reports tool parts of a session created after the source existed", async () => {
    const source = new OpenCodeDbSource(WORK_DIR, dbPath, Date.now() - 1000);
    const now = Date.now();
    seed({
      sessions: [{ id: "ses_live", directory: WORK_DIR, created: now, updated: now }],
      parts: [
        { id: "p1", sessionId: "ses_live", created: now + 1, data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" } } } },
        { id: "p2", sessionId: "ses_live", created: now + 2, data: { type: "step-start" } },
      ],
    });

    const events = await source.poll();
    expect(events.toolUses).toHaveLength(1);
    expect(events.toolUses[0].name).toBe("bash");
    expect((events.toolUses[0].input as { command: string }).command).toBe("npm test");
  });

  it("cursors by time_created — each part emits exactly once", async () => {
    const source = new OpenCodeDbSource(WORK_DIR, dbPath, Date.now() - 1000);
    const now = Date.now();
    seed({
      sessions: [{ id: "ses_a", directory: WORK_DIR, created: now, updated: now }],
      parts: [{ id: "p1", sessionId: "ses_a", created: now + 1, data: { type: "tool", tool: "read", state: { input: { filePath: "/x" } } } }],
    });
    expect((await source.poll()).toolUses).toHaveLength(1);
    expect((await source.poll()).toolUses).toHaveLength(0);

    seed({ sessions: [{ id: "ses_a", directory: WORK_DIR, created: now, updated: now + 5 }], parts: [{ id: "p2", sessionId: "ses_a", created: now + 10, data: { type: "tool", tool: "bash", state: { input: { command: "x" } } } }] });
    expect((await source.poll()).toolUses).toHaveLength(1);
  });

  it("skips history of a session that predates the source", async () => {
    const past = Date.now() - 60_000;
    seed({
      sessions: [{ id: "ses_old", directory: WORK_DIR, created: past, updated: past }],
      parts: [{ id: "p1", sessionId: "ses_old", created: past + 1, data: { type: "tool", tool: "bash", state: { input: { command: "old" } } } }],
    });
    const source = new OpenCodeDbSource(WORK_DIR, dbPath);
    expect((await source.poll()).toolUses).toHaveLength(0);
  });

  it("ignores sessions from other directories and subagent children", async () => {
    const source = new OpenCodeDbSource(WORK_DIR, dbPath, Date.now() - 1000);
    const now = Date.now();
    seed({
      sessions: [
        { id: "ses_other", directory: "/elsewhere", created: now, updated: now + 10 },
        { id: "ses_child", directory: WORK_DIR, parentId: "ses_other", created: now, updated: now + 5 },
      ],
      parts: [{ id: "p1", sessionId: "ses_child", created: now + 1, data: { type: "tool", tool: "bash", state: { input: { command: "child" } } } }],
    });
    expect((await source.poll()).toolUses).toHaveLength(0);
  });

  it("is inert when the db file is missing", async () => {
    const source = new OpenCodeDbSource(WORK_DIR, join(TEST_ROOT, "nope.db"));
    expect((await source.poll()).toolUses).toHaveLength(0);
  });
});
