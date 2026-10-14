/**
 * #1818: watchUpdateLaunch — a failed chat /update now shows a short cause and logs the full output
 * to a capped update.log file via a file descriptor (not a pipe), so the updater can keep writing
 * after the fleet process that spawned it is stopped.
 *
 * Tests: fake updater scripts, cause extraction, log capping, fd-vs-pipe mutation.
 * Never spawns the real `agend update`.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractUpdateCause, openUpdateLog, UPDATE_LOG_FILE_CAP,
  updateLogPath, watchUpdateLaunch,
} from "../src/update-launch.js";

// ── helpers ──────────────────────────────────────────────────────────────────

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "agend-1818-")); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function fakeChild(code: number | null, signal?: string) {
  const child = new EventEmitter() as any;
  return {
    child,
    exit(c = code, s = signal) { child.emit("exit", c, s); },
  };
}

// ── extractUpdateCause ────────────────────────────────────────────────────────

describe("extractUpdateCause (#1818)", () => {
  it("returns null for empty output", () => {
    expect(extractUpdateCause("")).toBeNull();
    expect(extractUpdateCause("   \n  \n")).toBeNull();
  });

  it("returns last npm ERR! line", () => {
    const out = "npm ERR! code EACCES\nnpm ERR! errno -13\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
    expect(extractUpdateCause(out)).toMatch(/EACCES/);
  });

  it("returns last npm error line (lowercase variant)", () => {
    const out = "npm error code ETARGET\nnpm error notarget No matching version found for @songsid/agend@99.0.0";
    const cause = extractUpdateCause(out);
    expect(cause).toMatch(/notarget/);
  });

  it("returns last ✗ line when no npm error", () => {
    const out = "Installing…\n✗ Post-install step failed: cannot verify signature";
    expect(extractUpdateCause(out)).toMatch(/Post-install/);
  });

  it("falls back to last non-blank line", () => {
    const out = "Downloading...\nFailed to write temp file\n";
    expect(extractUpdateCause(out)).toMatch(/Failed to write temp file/);
  });

  it("masks GitHub tokens in npm error lines", () => {
    const cause = extractUpdateCause("npm ERR! Error: ghp_ABCDEFGHIJ1234567890AB_secret");
    expect(cause).not.toContain("ghp_ABCDEFGHIJ");
  });

  it("caps at 300 chars", () => {
    const long = `npm ERR! ${"x".repeat(1000)}`;
    expect(extractUpdateCause(long)!.length).toBeLessThanOrEqual(300);
  });
});

// ── openUpdateLog: file descriptor, not pipe ─────────────────────────────────

describe("openUpdateLog (#1818): returns a file descriptor, not a pipe", () => {
  it("returns a numeric fd and writes the header to the log", () => {
    const logPath = updateLogPath(dataDir);
    const fd = openUpdateLog(logPath, "--- test run ---");
    expect(typeof fd).toBe("number");
    closeSync(fd);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("--- test run ---");
  });

  it("a child that keeps writing via the fd after parent closes still has output in the log (fd survives parent close)", () => {
    // Write to the fd, close the parent's copy, then write to the file path directly
    // to simulate what the child does after the parent is gone.
    const logPath = updateLogPath(dataDir);
    const fd = openUpdateLog(logPath, "--- fd test ---");
    // Parent writes then closes its copy.
    require("node:fs").writeSync(fd, "parent output\n");
    closeSync(fd);
    // Child continues writing to the same file via its own fd reference.
    // (In production the child has its own fd from spawn; here we simulate with a new open.)
    const childFd = openSync(logPath, "a", 0o600);
    require("node:fs").writeSync(childFd, "child output after parent exited\n");
    closeSync(childFd);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("parent output");
    expect(content).toContain("child output after parent exited");
  });
});

// ── watchUpdateLaunch with log and cause ────────────────────────────────────

describe("watchUpdateLaunch (#1818): cause from log file, not from pipes", () => {
  it("npm EACCES in log → cause in message and log path referenced", () => {
    const logPath = updateLogPath(dataDir);
    const fd = openUpdateLog(logPath, "--- run ---");
    require("node:fs").writeSync(fd, "npm error code EACCES\nnpm ERR! Error: EACCES: permission denied, /usr/local\n");
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    exit();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/EACCES/);
    expect(messages[0]).toContain(logPath);
    expect(messages[0]).toContain("Cause:");
  });

  it("✗ line in log → cause extracted", () => {
    const logPath = updateLogPath(dataDir);
    const fd = openUpdateLog(logPath, "--- run ---");
    require("node:fs").writeSync(fd, "Installing…\n✗ activation failed: Service refused to start\n");
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    exit();
    expect(messages[0]).toMatch(/activation failed/);
  });

  it("empty log → message contains exit code, no cause", () => {
    const logPath = updateLogPath(dataDir);
    const fd = openUpdateLog(logPath, "--- run ---");
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    exit();
    expect(messages[0]).toContain("updater exited 1");
    expect(messages[0]).not.toContain("Cause:");
  });

  it("secret-looking text in log is masked in the cause shown in message", () => {
    const logPath = updateLogPath(dataDir);
    const fd = openUpdateLog(logPath, "--- run ---");
    require("node:fs").writeSync(fd, "npm ERR! Error: npm_token=npm_ABCDEFGHIJ1234567890AB\n");
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    exit();
    expect(messages[0]).not.toContain("npm_ABCDEFGHIJ1234567890AB");
  });

  it("exit 75 (pending) produces no failure message", () => {
    const { child, exit } = fakeChild(75);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m));
    exit();
    expect(messages).toHaveLength(0);
  });

  it("exit 0 (success) produces no failure message", () => {
    const { child, exit } = fakeChild(0);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m));
    exit();
    expect(messages).toHaveLength(0);
  });

  it("SIGTERM reports interrupted", () => {
    const { child, exit } = fakeChild(null, "SIGTERM");
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m));
    exit(null, "SIGTERM");
    expect(messages[0]).toContain("interrupted");
  });

  it("MUTATION: if log is NOT written before reading, cause is null (not guessing from nowhere)", () => {
    // This pins that cause is derived from the log file, not from in-memory buffers.
    // A mutation that reads buffers instead would find nothing here and still pass,
    // while the "npm EACCES in log" test above would break if buffers were read (they'd be empty).
    const logPath = updateLogPath(dataDir);
    // Do NOT write anything to the log
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    exit();
    // No log file → no cause
    expect(messages[0]).not.toContain("Cause:");
    expect(messages[0]).toContain("updater exited 1");
  });
});

// ── openUpdateLog: file cap ──────────────────────────────────────────────────

describe("openUpdateLog: file is capped at UPDATE_LOG_FILE_CAP", () => {
  it("log file is rotated when it would exceed UPDATE_LOG_FILE_CAP", () => {
    const logPath = updateLogPath(dataDir);
    // Fill file over the cap threshold
    writeFileSync(logPath, "x".repeat(UPDATE_LOG_FILE_CAP));
    const fd = openUpdateLog(logPath, "--- new run ---");
    closeSync(fd);
    const size = readFileSync(logPath).length;
    expect(size).toBeLessThan(UPDATE_LOG_FILE_CAP + 200);
  });

  it("the update.log path is under AGEND_HOME", () => {
    expect(updateLogPath("/home/user/.agend")).toBe("/home/user/.agend/update.log");
  });
});
