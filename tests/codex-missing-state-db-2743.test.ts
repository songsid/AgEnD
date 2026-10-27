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
import { codexStateDbAbsent, cwdRolloutsProvenAbsent } from "../src/backend/codex-session-lookup.js";

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
/** Paths a test made unreadable; restored before cleanup. */
const locked: string[] = [];
function lock(path: string): void {
  chmodSync(path, 0o000);
  locked.push(path);
}
const asRoot = process.getuid?.() === 0;
afterEach(() => {
  for (const p of locked.splice(0).reverse()) chmodSync(p, 0o700); // outermost first
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(root, { recursive: true, force: true });
});

function rolloutWithTurn(id: string, cwd: string, home = shared): string {
  const dir = join(home, "sessions", "2026", "10", "27");
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "session_meta", payload: { id, session_id: id, cwd, originator: "codex-tui", source: "cli", cli_version: "0.159.2" } },
    { type: "event_msg", payload: { type: "task_started" } },
  ];
  const path = join(dir, `rollout-2026-10-27T10-00-00-${id}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return path;
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

describe("cwdRolloutsProvenAbsent: only a complete walk proves no history", () => {
  it("is true for an absent sessions dir and for rollouts of other directories only", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(true);
    rolloutWithTurn(OLD, join(root, "elsewhere"));
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(true);
  });

  it("is false for a rollout of this directory, turn or not", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const path = rolloutWithTurn(OLD, ws);
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: OLD, cwd: ws, source: "cli" } }) + "\n");
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(false);
  });

  it("is false for a rollout whose session_meta cannot be read", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    writeFileSync(rolloutWithTurn(OLD, join(root, "elsewhere")), "{not json\n");
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(false);
  });

  it("is false when an entry cannot be stat'ed (a link loop)", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rolloutWithTurn(OLD, join(root, "elsewhere"));
    symlinkSync("loop", join(shared, "sessions", "2026", "loop"));
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(false);
  });

  it.skipIf(asRoot)("is false when a directory cannot be read", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rolloutWithTurn(OLD, join(root, "elsewhere"));
    lock(join(shared, "sessions", "2026", "10"));
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(false);
    lock(join(shared, "sessions"));
    expect(cwdRolloutsProvenAbsent(join(shared, "sessions"), ws)).toBe(false);
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

  it.skipIf(asRoot)("missing databases with this directory's rollout in a sessions dir that cannot be read → unchanged: unreadable", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    rolloutWithTurn(OLD, ws);
    lock(join(shared, "sessions", "2026"));
    const { cmd, warning } = launch(ws);
    expect(cmd).toContain(" resume --last ");
    expect(warning).toMatch(/SQLITE_CANTOPEN/);
  });

  it.skipIf(asRoot)("a private database in an instance home that cannot be read is not an absent one → unchanged: unreadable", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const { cmd, warning } = launch(ws, home => {
      writeFileSync(join(home, "state_5.sqlite"), "");
      lock(home);
    });
    expect(cmd).toContain(" resume --last ");
    expect(warning).not.toBeNull();
  });

  it("a private database path that stat cannot resolve (a link loop) is not an absent one → unchanged: unreadable", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const { cmd, warning } = launch(ws, home => symlinkSync("state_5.sqlite", join(home, "state_5.sqlite")));
    expect(cmd).toContain(" resume --last ");
    expect(warning).not.toBeNull();
  });

  it.skipIf(asRoot)("an existing database without read permission → unchanged: unreadable", () => {
    const ws = join(root, "ws"); mkdirSync(ws);
    const db = join(shared, "state_5.sqlite");
    writeFileSync(db, "");
    chmodSync(db, 0o000);
    const { cmd, warning } = launch(ws);
    expect(cmd).toContain(" resume --last ");
    expect(warning).not.toBeNull();
  });
});
