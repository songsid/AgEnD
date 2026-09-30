/**
 * #1053: the Codex resume lookup answering "none" starts a new conversation,
 * and until now said nothing. "This workspace never had a conversation" and
 * "the lookup missed the one it had" looked the same: #1028 (the lookup read
 * a database this CODEX_HOME does not write) was a silent fresh start on every
 * restart, with the old conversation still in `codex resume`. The rollout
 * files are what the database indexes, so a turn recorded in one for this
 * directory is the evidence; with it the launch says which conversation to
 * resume, without it (a new workspace) the launch stays quiet.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { newestMissedCwdRollout } from "../src/backend/codex-session-lookup.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("./fixtures/codex-0157-state5-schema.sql", import.meta.url)), "utf8");
const OLD = "019fa7a4-1632-7693-a160-ea92d168a15b";
const NEWER = "01a05d1f-5eb4-7c60-9445-ea06e48af691";
const OTHER = "019feff4-3ce1-7c23-a479-538b04b1dada";

let root: string;
let shared: string;
const originalCodexHome = process.env.CODEX_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-1053-"));
  shared = join(root, "shared-codex-home");
  mkdirSync(join(shared, "sessions"), { recursive: true });
  process.env.CODEX_HOME = shared;
});
afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(root, { recursive: true, force: true });
});

/** The real 0.159 session_meta shape (keys read off real rollouts). */
function rollout(id: string, cwd: string, opts: { source?: unknown; turn?: boolean; mtime?: number } = {}): string {
  const dir = join(shared, "sessions", "2026", "09", "30");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-30T10-00-00-${id}.jsonl`);
  const lines = [
    { type: "session_meta", payload: { id, session_id: id, cwd, originator: "codex-tui", source: opts.source ?? "cli", cli_version: "0.159.2" } },
    { type: "event_msg", payload: { type: "thread_settings_applied" } },
    ...(opts.turn === false ? [] : [{ type: "event_msg", payload: { type: "task_started" } }, { type: "response_item", payload: { type: "message", role: "assistant", content: [] } }]),
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  if (opts.mtime) utimesSync(path, opts.mtime, opts.mtime);
  return path;
}

/** A readable state DB with no thread for `cwd` — what #1028 read. */
function emptyStateDb(path = join(shared, "state_5.sqlite")): void {
  const db = new Database(path);
  db.exec(SCHEMA);
  db.close();
}

function launch(workingDirectory: string) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  const backend = new CodexBackend(instanceDir);
  const config = { workingDirectory, instanceDir, instanceName: "worker", mcpServers: {}, peerWorkingDirectories: () => [] };
  backend.writeConfig(config); // links the instance home's sessions/ to the shared one
  const cmd = backend.buildCommand(config);
  return { cmd, warning: backend.consumeLaunchWarning() };
}

describe("newestMissedCwdRollout: this directory's conversation the lookup did not return", () => {
  it("is null for a workspace that never had one", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rollout(OTHER, join(root, "elsewhere"));
    expect(newestMissedCwdRollout(join(shared, "sessions"), ws)).toBeNull();
  });

  it("names the newest interactive rollout of this directory with a turn in it", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rollout(OLD, ws, { mtime: 1_000 });
    rollout(NEWER, ws, { mtime: 2_000 });
    rollout(OTHER, join(root, "elsewhere"), { mtime: 3_000 });
    expect(newestMissedCwdRollout(join(shared, "sessions"), ws)?.id).toBe(NEWER);
  });

  it("skips a thread nobody used, subagent threads and other front ends", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rollout(NEWER, ws, { turn: false, mtime: 4_000 });
    rollout(OTHER, ws, { source: { subagent: { thread_spawn: { depth: 1 } } }, mtime: 3_000 });
    rollout("01a0f048-a48e-7050-97c1-c79c1a2265d7", ws, { source: "vscode", mtime: 2_000 });
    expect(newestMissedCwdRollout(join(shared, "sessions"), ws)).toBeNull();
    rollout(OLD, ws, { mtime: 1_000 });
    expect(newestMissedCwdRollout(join(shared, "sessions"), ws)?.id).toBe(OLD);
  });

  it("matches the directory through a symlink, as the database lookup does", () => {
    const real = join(root, "real-ws"); mkdirSync(real);
    const link = join(root, "link-ws"); symlinkSync(real, link, "dir");
    rollout(OLD, real);
    expect(newestMissedCwdRollout(join(shared, "sessions"), link)?.id).toBe(OLD);
  });

  it("ignores a rollout whose first line is not a session_meta", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const dir = join(shared, "sessions", "2026", "09", "30"); mkdirSync(dir, { recursive: true });
    // Valid JSON naming this cwd, but not the thread's own header.
    writeFileSync(join(dir, `rollout-x-${OLD}.jsonl`), [
      { type: "turn_context", payload: { id: OLD, cwd: ws, source: "cli" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    ].map(l => JSON.stringify(l)).join("\n") + "\n");
    expect(newestMissedCwdRollout(join(shared, "sessions"), ws)).toBeNull();
    writeFileSync(join(dir, `rollout-y-${NEWER}.jsonl`), "not json\n");
    expect(newestMissedCwdRollout(join(shared, "sessions"), ws)).toBeNull();
  });
});

describe("a fresh Codex launch says so when this workspace had a conversation (#1053)", () => {
  it("the #1028 shape: lookup finds nothing, the rollout shows a turn → a new conversation, and the notice names the old one", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    emptyStateDb();
    rollout(OLD, ws);
    const { cmd, warning } = launch(ws);
    expect(cmd).not.toContain(" resume");
    expect(warning).toContain(ws);
    expect(warning).toContain(`codex resume ${OLD}`);
    expect(warning).toMatch(/NEW one/);
  });

  it("a workspace that never had a conversation starts fresh quietly", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    emptyStateDb();
    rollout(OTHER, join(root, "elsewhere"));
    const { cmd, warning } = launch(ws);
    expect(cmd).not.toContain(" resume");
    expect(warning).toBeNull();
  });

  it("a resumed launch does not look at rollouts or warn", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const db = new Database(join(shared, "state_5.sqlite"));
    db.exec(SCHEMA);
    db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, has_user_event, first_user_message, archived, recency_at_ms, updated_at_ms)
      VALUES (?, '/r.jsonl', 1, 1, 'cli', 'openai', ?, 't', 'danger-full-access', 'never', 0, 'a question', 0, 1, 1)`).run(OLD, ws);
    db.close();
    rollout(NEWER, ws);
    const { cmd, warning } = launch(ws);
    expect(cmd).toContain(` resume '${OLD}' `);
    expect(warning).toBeNull();
  });
});
