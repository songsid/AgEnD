/**
 * #984 F3 phase 3.1: exact-cwd Codex session lookup.
 *
 * Every database here is built from the real codex-cli 0.157.0 state_5.sqlite
 * schema (tests/fixtures/codex-0157-state5-schema.sql, no rows) in WAL mode,
 * like the live file, and every case calls the production module.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
  hasUserEvent?: 0 | 1;
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
      sandbox_policy, approval_mode, has_user_event, archived, recency_at_ms, updated_at_ms)
    VALUES (@id, '/r.jsonl', 1, 1, @source, 'openai', @cwd, 't', 'danger-full-access', 'never',
      @hasUserEvent, @archived, @recency, @updated)
  `);
  const ids = threads.map(t => {
    const id = t.id ?? uuid();
    insert.run({
      id, cwd: t.cwd, recency: t.recency, source: t.source ?? "cli", archived: t.archived ?? 0,
      hasUserEvent: t.hasUserEvent ?? 1, updated: t.updated ?? t.recency,
    });
    return id;
  });
  db.close();
  return { path, ids };
}

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
      { cwd: "/w/app", recency: 900, hasUserEvent: 0 },
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
