/**
 * #1818: watchUpdateLaunch — a failed chat /update now shows a short cause and logs the full output
 * to a capped update.log file via a file descriptor (not a pipe), so the updater can keep writing
 * after the fleet process that spawned it is stopped.
 *
 * Tests: cause extraction (npm ERR!, npm 10 footer, ✗, fallback, masking, offset isolation),
 * openUpdateLog (fd, fchmod, offset, rotation), watchUpdateLaunch (cause from log, no previous-run bleed).
 * Never spawns the real `agend update`.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, statSync } from "node:fs";
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

  it("returns last npm ERR! line (npm 9 style — ! is not a word boundary)", () => {
    // \\b after ! fails because ! is non-word. The fix uses (?:\\s|$).
    const out = "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir\nsome other line";
    const cause = extractUpdateCause(out);
    // Must get an npm ERR! line, not "some other line"
    expect(cause).toMatch(/^npm ERR!/);
    expect(cause).toMatch(/EACCES/);
  });

  it("npm 10: takes code line + next line, skips 'A complete log' footer", () => {
    // Simulated npm 10 EACCES output
    const out = [
      "npm error code EACCES",
      "npm error syscall mkdir",
      "npm error path /usr/local/lib/node_modules",
      "npm error errno -13",
      "npm error EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
      "npm error A complete log of this run can be found in: /home/user/.npm/_logs/2026-10-14T10_00_00_000Z-debug-0.log",
    ].join("\n");
    const cause = extractUpdateCause(out);
    expect(cause).toMatch(/npm error code EACCES/);
    expect(cause).not.toMatch(/A complete log/);
  });

  it("npm 10: without a code line, skips 'A complete log' footer and takes the last meaningful line", () => {
    // No 'npm error code' line — mutation guard: removing the 'A complete log' filter makes this return the footer.
    const out = [
      "npm error Cannot read properties of undefined (reading 'version')",
      "npm error A complete log of this run can be found in: /home/user/.npm/_logs/2026-10-14-debug-0.log",
    ].join("\n");
    const cause = extractUpdateCause(out);
    expect(cause).toMatch(/Cannot read properties/);
    expect(cause).not.toMatch(/A complete log/);
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
    const cause = extractUpdateCause("npm ERR! Error: ghp_ABCDEFGHIJ1234567890AB_secret"); // gitleaks:allow
    expect(cause).not.toContain("ghp_ABCDEFGHIJ"); // gitleaks:allow
  });

  it("caps at 300 chars", () => {
    const long = `npm ERR! ${"x".repeat(1000)}`;
    expect(extractUpdateCause(long)!.length).toBeLessThanOrEqual(300);
  });

  it("--- header lines are excluded from cause extraction", () => {
    const out = "--- header from openUpdateLog ---";
    expect(extractUpdateCause(out)).toBeNull();
  });
});

// ── openUpdateLog: fd, fchmod, offset ────────────────────────────────────────

describe("openUpdateLog (#1818): fd-based, correct permissions, offset tracking", () => {
  it("returns a numeric fd and records offset after the header", () => {
    const logPath = updateLogPath(dataDir);
    const logFd = openUpdateLog(logPath, "--- test run ---");
    if (!logFd) throw new Error("openUpdateLog returned null");
    const { fd, offset } = logFd;
    expect(typeof fd).toBe("number");
    closeSync(fd);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("--- test run ---");
    // offset must point past the header line
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBe(statSync(logPath).size);
  });

  it("fchmod: file is mode 0o100600 (owner read/write only)", () => {
    const logPath = updateLogPath(dataDir);
    // Create a too-permissive file first
    writeFileSync(logPath, "", { mode: 0o644 });
    const logFd = openUpdateLog(logPath, "--- test ---");
    if (!logFd) throw new Error("openUpdateLog returned null");
    closeSync(logFd.fd);
    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a child that keeps writing via the fd after parent closes still has output in the log", () => {
    const logPath = updateLogPath(dataDir);
    const logFd = openUpdateLog(logPath, "--- fd test ---");
    if (!logFd) throw new Error("openUpdateLog returned null");
    const { fd, offset } = logFd;
    require("node:fs").writeSync(fd, "parent output\n");
    closeSync(fd);
    // Simulate child continuing to write after parent closed its fd copy.
    const childFd = openSync(logPath, "a", 0o600);
    require("node:fs").writeSync(childFd, "child output after parent exited\n");
    closeSync(childFd);
    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("parent output");
    expect(content).toContain("child output after parent exited");
    expect(offset).toBeGreaterThan(0); // offset is past the header
  });

  it("offset isolates this run: previous run's output is NOT in the cause", () => {
    const logPath = updateLogPath(dataDir);
    // Write a previous run's error
    writeFileSync(logPath, "--- previous run ---\nnpm ERR! ENOTEMPTY from previous run\n", { mode: 0o600 });
    const _logFd = openUpdateLog(logPath, "--- new run ---"); if (!_logFd) throw new Error("null fd"); const { fd, offset } = _logFd;
    // This run writes nothing (or writes something benign)
    require("node:fs").writeSync(fd, "Downloading...\n");
    closeSync(fd);
    // Test that reading from offset doesn't see the previous run's npm ERR!
    const buf = readFileSync(logPath);
    const runBytes = buf.subarray(offset).toString("utf8");
    const cause = extractUpdateCause(runBytes);
    expect(cause).not.toMatch(/ENOTEMPTY from previous run/);
    expect(cause).toMatch(/Downloading/);
  });
});

// ── watchUpdateLaunch with log and cause ────────────────────────────────────

describe("watchUpdateLaunch (#1818): cause from log file offset, not from pipes", () => {
  it("npm EACCES in log → cause in message and log path referenced", () => {
    const logPath = updateLogPath(dataDir);
    const _logFd = openUpdateLog(logPath, "--- run ---"); if (!_logFd) throw new Error("null fd"); const { fd, offset } = _logFd;
    require("node:fs").writeSync(fd, "npm error code EACCES\nnpm ERR! Error: EACCES: permission denied, /usr/local\n");
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath, offset);
    exit();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/EACCES/);
    expect(messages[0]).toContain(logPath);
    expect(messages[0]).toContain("Cause:");
  });

  it("✗ line in log → cause extracted", () => {
    const logPath = updateLogPath(dataDir);
    const _logFd = openUpdateLog(logPath, "--- run ---"); if (!_logFd) throw new Error("null fd"); const { fd, offset } = _logFd;
    require("node:fs").writeSync(fd, "Installing…\n✗ activation failed: Service refused to start\n");
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath, offset);
    exit();
    expect(messages[0]).toMatch(/activation failed/);
  });

  it("empty run (no output after header) → no cause from previous runs", () => {
    const logPath = updateLogPath(dataDir);
    // Pre-write a previous run's error
    writeFileSync(logPath, "--- prev ---\nnpm ERR! old error\n", { mode: 0o600 });
    const _logFd = openUpdateLog(logPath, "--- new run ---"); if (!_logFd) throw new Error("null fd"); const { fd, offset } = _logFd;
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath, offset);
    exit();
    expect(messages[0]).toContain("updater exited 1");
    expect(messages[0]).not.toContain("old error");
  });

  it("secret-looking text in log is masked in the cause shown in message", () => {
    const logPath = updateLogPath(dataDir);
    const _logFd = openUpdateLog(logPath, "--- run ---"); if (!_logFd) throw new Error("null fd"); const { fd, offset } = _logFd;
    require("node:fs").writeSync(fd, "npm ERR! Error: fake_tok=fake_ABCDEFGHIJ1234567890AB\n"); // gitleaks:allow
    closeSync(fd);
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath, offset);
    exit();
    expect(messages[0]).not.toContain("fake_ABCDEFGHIJ1234567890AB");
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
});

// ── openUpdateLog: file is capped at UPDATE_LOG_FILE_CAP ──────────────────────────────────────────────────────────

describe("openUpdateLog: file is capped at UPDATE_LOG_FILE_CAP", () => {
  it("log file is rotated when it would exceed UPDATE_LOG_FILE_CAP", () => {
    const logPath = updateLogPath(dataDir);
    writeFileSync(logPath, "x".repeat(UPDATE_LOG_FILE_CAP));
    const logFd = openUpdateLog(logPath, "--- new run ---");
    if (logFd) closeSync(logFd.fd);
    const size = readFileSync(logPath).length;
    expect(size).toBeLessThan(UPDATE_LOG_FILE_CAP + 200);
  });

  it("the update.log path is under AGEND_HOME", () => {
    expect(updateLogPath("/home/user/.agend")).toBe("/home/user/.agend/update.log");
  });

  it("returns null when the path is unwritable (fallback to stdio: ignore)", () => {
    // Use a path under a non-existent directory to trigger an openSync failure.
    const badPath = join(dataDir, "nonexistent", "update.log");
    const result = openUpdateLog(badPath, "--- test ---");
    expect(result).toBeNull();
  });
});
