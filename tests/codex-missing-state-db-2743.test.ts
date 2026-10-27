/**
 * #2743: a fresh one-click install's first Codex launch said "Codex session
 * database unreadable (SQLITE_CANTOPEN)" and ran `resume --last`. A Codex
 * home that never ran has no state_5.sqlite in either home (writeConfig links
 * only what the shared home has), and the read-only open refuses to create
 * one. Nothing to resume is a new conversation, quietly. A database that
 * exists but cannot be read, or a missing one next to this directory's
 * history, keeps the unreadable path.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBackend } from "../src/backend/codex.js";
import { codexStateDbAbsent } from "../src/backend/codex-session-lookup.js";

const OLD = "019fa7a4-1632-7693-a160-ea92d168a15b";

let root: string;
let shared: string;
const originalCodexHome = process.env.CODEX_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-2743-"));
  shared = join(root, "shared-codex-home");
  mkdirSync(shared, { recursive: true });
  process.env.CODEX_HOME = shared;
});
afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(root, { recursive: true, force: true });
});

function rolloutWithTurn(id: string, cwd: string, home = shared): void {
  const dir = join(home, "sessions", "2026", "10", "27");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id, session_id: id, cwd, originator: "codex-tui", source: "cli", cli_version: "0.159.2" } },
    { type: "event_msg", payload: { type: "task_started" } },
  ];
  writeFileSync(join(dir, `rollout-2026-10-27T10-00-00-${id}.jsonl`), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

function launch(workingDirectory: string, beforeBuild: (instanceHome: string) => void = () => {}) {
  const instanceDir = join(root, "instances", "worker");
  mkdirSync(instanceDir, { recursive: true });
  const backend = new CodexBackend(instanceDir);
  const config = { workingDirectory, instanceDir, instanceName: "worker", mcpServers: {}, peerWorkingDirectories: () => [] };
  backend.writeConfig(config);
  beforeBuild((backend as unknown as { isolatedCodexHome: string }).isolatedCodexHome);
  const cmd = backend.buildCommand(config);
  return { cmd, warning: backend.consumeLaunchWarning() };
}

describe("codexStateDbAbsent", () => {
  it("is true only when nothing is there", () => {
    const missing = join(root, "state_5.sqlite");
    expect(codexStateDbAbsent(missing)).toBe(true);
    const dangling = join(root, "dangling.sqlite");
    symlinkSync(join(root, "nowhere.sqlite"), dangling);
    expect(codexStateDbAbsent(dangling)).toBe(true);
    writeFileSync(missing, "");
    expect(codexStateDbAbsent(missing)).toBe(false);
    // A path through a file is ENOTDIR, not "never created".
    expect(codexStateDbAbsent(join(missing, "x"))).toBe(false);
  });
});

describe("a Codex home with no state database (#2743)", () => {
  it("fresh install: no database in either home, no history → a new conversation, no warning", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const { cmd, warning } = launch(ws);
    expect(cmd).not.toContain(" resume");
    expect(warning).toBeNull();
  });

  it("missing database but this directory has history → unchanged: unreadable, `--last` when alone, with the warning", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rolloutWithTurn(OLD, ws);
    const { cmd, warning } = launch(ws);
    expect(cmd).toContain(" resume --last ");
    expect(warning).toMatch(/SQLITE_CANTOPEN/);
  });

  it("the same when the history is in a private sessions dir of the instance home (a migration that failed)", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const { cmd, warning } = launch(ws, home => {
      expect(lstatSync(join(home, "sessions")).isSymbolicLink()).toBe(true);
      unlinkSync(join(home, "sessions"));
      rolloutWithTurn(OLD, ws, home);
    });
    expect(cmd).toContain(" resume --last ");
    expect(warning).toMatch(/SQLITE_CANTOPEN/);
  });

  it("a database that exists but cannot be read → unchanged: unreadable, `--last` with the warning", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    writeFileSync(join(shared, "state_5.sqlite"), "not a database");
    const { cmd, warning } = launch(ws);
    expect(cmd).toContain(" resume --last ");
    expect(warning).toMatch(/unreadable|SQLITE_NOTADB/i);
  });

  it.skipIf(process.getuid?.() === 0)("an existing database without read permission → unchanged: unreadable", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const db = join(shared, "state_5.sqlite");
    writeFileSync(db, "");
    chmodSync(db, 0o000);
    const { cmd, warning } = launch(ws);
    expect(cmd).toContain(" resume --last ");
    expect(warning).not.toBeNull();
  });
});
