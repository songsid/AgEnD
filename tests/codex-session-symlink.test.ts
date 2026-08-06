import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
