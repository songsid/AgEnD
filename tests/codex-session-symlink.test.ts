import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend } from "../src/backend/codex.js";

/**
 * #506: prepareIsolatedHome() only symlinked entries that already existed in
 * the shared ~/.codex. On a fresh install `sessions`/`archived_sessions` did
 * not exist yet, so no link was made — and when Codex later created them for
 * real inside the instance-private CODEX_HOME, that home forked permanently:
 * the terminal `codex` CLI could never see instance sessions, and deleting the
 * instance deleted the archives.
 */

let sharedHome: string;
let instanceDir: string;
const realCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  sharedHome = join(mkdtempSync(join(tmpdir(), "agend-codex-shared-")), ".codex");
  instanceDir = mkdtempSync(join(tmpdir(), "agend-codex-inst-"));
  process.env.CODEX_HOME = sharedHome; // deliberately NOT created — fresh install
});
afterEach(() => {
  if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome;
  rmSync(join(sharedHome, ".."), { recursive: true, force: true });
  rmSync(instanceDir, { recursive: true, force: true });
});

function prepare(): CodexBackend {
  const b = new CodexBackend(instanceDir);
  (b as any).prepareIsolatedHome();
  return b;
}

const isolated = (...p: string[]) => join(instanceDir, "codex-home", ...p);

describe("fresh install (#506 prevention)", () => {
  it("creates the shared session dirs and symlinks them into the isolated home", () => {
    prepare();

    for (const dir of ["sessions", "archived_sessions"]) {
      expect(existsSync(join(sharedHome, dir)), `shared ${dir}`).toBe(true);
      expect(lstatSync(isolated(dir)).isSymbolicLink(), `isolated ${dir} is a symlink`).toBe(true);
      expect(readlinkSync(isolated(dir))).toBe(join(sharedHome, dir));
    }
  });

  it("is idempotent — a second start changes nothing", () => {
    prepare();
    prepare();
    expect(lstatSync(isolated("sessions")).isSymbolicLink()).toBe(true);
  });
});

describe("diverged instance (#506 migration)", () => {
  it("merges a real private sessions dir into the shared home without overwriting, then symlinks", () => {
    // The fork: instance-private REAL dir with sessions of its own.
    mkdirSync(isolated("sessions", "2026", "08"), { recursive: true });
    writeFileSync(isolated("sessions", "2026", "08", "rollout-a.jsonl"), "private-a");
    writeFileSync(isolated("sessions", "2026", "08", "rollout-b.jsonl"), "private-b");
    // Shared home already has one colliding file (must be kept) and one of its own.
    mkdirSync(join(sharedHome, "sessions", "2026", "08"), { recursive: true });
    writeFileSync(join(sharedHome, "sessions", "2026", "08", "rollout-b.jsonl"), "shared-b");
    writeFileSync(join(sharedHome, "sessions", "2026", "08", "rollout-c.jsonl"), "shared-c");

    prepare();

    const at = (f: string) => readFileSync(join(sharedHome, "sessions", "2026", "08", f), "utf-8");
    expect(at("rollout-a.jsonl")).toBe("private-a");   // merged in
    expect(at("rollout-b.jsonl")).toBe("shared-b");    // collision: shared copy kept
    expect(at("rollout-c.jsonl")).toBe("shared-c");    // untouched
    expect(lstatSync(isolated("sessions")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(isolated("sessions"))).toBe(join(sharedHome, "sessions"));
    // And the merged file is reachable THROUGH the link (what codex sees).
    expect(readFileSync(isolated("sessions", "2026", "08", "rollout-a.jsonl"), "utf-8")).toBe("private-a");
  });

  it("keeps the private dir when migration fails, and retries cleanly next start", () => {
    mkdirSync(isolated("archived_sessions"), { recursive: true });
    writeFileSync(isolated("archived_sessions", "keep.jsonl"), "precious");
    // Force the failure: the shared entry exists as a FILE, so mkdir/cp throw.
    mkdirSync(sharedHome, { recursive: true });
    writeFileSync(join(sharedHome, "archived_sessions"), "not a directory");

    prepare();

    // Private data untouched, no symlink swap happened.
    expect(lstatSync(isolated("archived_sessions")).isDirectory()).toBe(true);
    expect(readFileSync(isolated("archived_sessions", "keep.jsonl"), "utf-8")).toBe("precious");

    // Obstacle removed → the next start heals it.
    rmSync(join(sharedHome, "archived_sessions"));
    prepare();
    expect(lstatSync(isolated("archived_sessions")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(sharedHome, "archived_sessions", "keep.jsonl"), "utf-8")).toBe("precious");
  });

  it("leaves an existing symlink alone — no migration churn on healthy instances", () => {
    mkdirSync(join(sharedHome, "sessions"), { recursive: true });
    writeFileSync(join(sharedHome, "sessions", "s.jsonl"), "x");
    prepare(); // creates the link
    const before = lstatSync(isolated("sessions")).mtimeMs;

    prepare(); // second run must not touch it

    expect(lstatSync(isolated("sessions")).isSymbolicLink()).toBe(true);
    expect(lstatSync(isolated("sessions")).mtimeMs).toBe(before);
  });
});

describe("SQLite sidecar isolation", () => {
  it("links a shared base database but never its WAL or SHM sidecars", () => {
    mkdirSync(sharedHome, { recursive: true });
    writeFileSync(join(sharedHome, "queue_1.sqlite"), "shared base");
    writeFileSync(join(sharedHome, "queue_1.sqlite-wal"), "shared wal");
    writeFileSync(join(sharedHome, "queue_1.sqlite-shm"), "shared shm");

    prepare();

    expect(lstatSync(isolated("queue_1.sqlite")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(isolated("queue_1.sqlite"))).toBe(join(sharedHome, "queue_1.sqlite"));
    expect(existsSync(isolated("queue_1.sqlite-wal"))).toBe(false);
    expect(existsSync(isolated("queue_1.sqlite-shm"))).toBe(false);
  });

  it("keeps sidecars local when the isolated base database is private and remains openable", () => {
    mkdirSync(sharedHome, { recursive: true });
    mkdirSync(isolated(), { recursive: true });

    const shared = new Database(join(sharedHome, "queue_1.sqlite"));
    try {
      shared.pragma("journal_mode = WAL");
      shared.exec("CREATE TABLE shared_only (value INTEGER); INSERT INTO shared_only VALUES (1)");

      const privateDb = new Database(isolated("queue_1.sqlite"));
      privateDb.pragma("journal_mode = WAL");
      privateDb.exec("CREATE TABLE private_only (value INTEGER); INSERT INTO private_only VALUES (9)");
      privateDb.close();

      prepare();

      expect(lstatSync(isolated("queue_1.sqlite")).isSymbolicLink()).toBe(false);
      expect(existsSync(isolated("queue_1.sqlite-wal"))).toBe(false);
      expect(existsSync(isolated("queue_1.sqlite-shm"))).toBe(false);
      const reopened = new Database(isolated("queue_1.sqlite"));
      try {
        expect(reopened.prepare("SELECT value FROM private_only").pluck().get()).toBe(9);
      } finally {
        reopened.close();
      }
    } finally {
      shared.close();
    }
  });

  it("heals legacy WAL and SHM links that point into the shared home", () => {
    mkdirSync(sharedHome, { recursive: true });
    mkdirSync(isolated(), { recursive: true });
    writeFileSync(join(sharedHome, "state_5.sqlite"), "shared base");
    writeFileSync(join(sharedHome, "state_5.sqlite-wal"), "shared wal");
    writeFileSync(join(sharedHome, "state_5.sqlite-shm"), "shared shm");
    writeFileSync(isolated("state_5.sqlite"), "private base");
    symlinkSync(join(sharedHome, "state_5.sqlite-wal"), isolated("state_5.sqlite-wal"));
    symlinkSync(join(sharedHome, "state_5.sqlite-shm"), isolated("state_5.sqlite-shm"));

    prepare();

    expect(lstatSync(isolated("state_5.sqlite")).isSymbolicLink()).toBe(false);
    expect(readFileSync(isolated("state_5.sqlite"), "utf-8")).toBe("private base");
    expect(existsSync(isolated("state_5.sqlite-wal"))).toBe(false);
    expect(existsSync(isolated("state_5.sqlite-shm"))).toBe(false);
  });

  it("does not remove real private sidecars", () => {
    mkdirSync(sharedHome, { recursive: true });
    mkdirSync(isolated(), { recursive: true });
    writeFileSync(join(sharedHome, "local.sqlite-wal"), "shared wal");
    writeFileSync(join(sharedHome, "local.sqlite-shm"), "shared shm");
    writeFileSync(isolated("local.sqlite-wal"), "private wal");
    writeFileSync(isolated("local.sqlite-shm"), "private shm");

    prepare();

    expect(readFileSync(isolated("local.sqlite-wal"), "utf-8")).toBe("private wal");
    expect(readFileSync(isolated("local.sqlite-shm"), "utf-8")).toBe("private shm");
  });

  it("never links rollback journals and heals an existing shared-home journal link", () => {
    mkdirSync(sharedHome, { recursive: true });
    mkdirSync(isolated(), { recursive: true });
    writeFileSync(join(sharedHome, "shared.sqlite"), "shared base");
    writeFileSync(join(sharedHome, "shared.sqlite-journal"), "shared journal");
    writeFileSync(join(sharedHome, "private.sqlite"), "other shared base");
    writeFileSync(join(sharedHome, "private.sqlite-journal"), "other shared journal");
    writeFileSync(isolated("private.sqlite"), "private base");
    symlinkSync(join(sharedHome, "private.sqlite-journal"), isolated("private.sqlite-journal"));

    prepare();

    expect(lstatSync(isolated("shared.sqlite")).isSymbolicLink()).toBe(true);
    expect(existsSync(isolated("shared.sqlite-journal"))).toBe(false);
    expect(lstatSync(isolated("private.sqlite")).isSymbolicLink()).toBe(false);
    expect(existsSync(isolated("private.sqlite-journal"))).toBe(false);
  });
});
