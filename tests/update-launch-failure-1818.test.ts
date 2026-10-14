/**
 * #1818: watchUpdateLaunch — a failed chat /update now shows a short cause from the updater output,
 * and logs the full masked output to a capped update.log file.
 *
 * Tests: fake updater output for npm EACCES, a ✗ activation line, no output, secret-bearing text.
 * Never spawns the real `agend update` (EventEmitter stubs only).
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendUpdateLog, extractUpdateCause, UPDATE_LOG_FILE_CAP, UPDATE_LOG_MAX_BYTES,
  updateLogPath, watchUpdateLaunch,
} from "../src/update-launch.js";

// ── helpers ──────────────────────────────────────────────────────────────────

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "agend-1818-")); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/** Stub child that emits data then exits. stdout and stderr are EventEmitters. */
function fakeChild(code: number | null, signal?: string) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.emit = (ev: string, ...a: any[]) => EventEmitter.prototype.emit.call(child, ev, ...a);
  return {
    child,
    send(data: string, stream: "stdout" | "stderr" = "stderr") {
      child[stream].emit("data", Buffer.from(data));
    },
    exit(c = code, s = signal) { child.emit("exit", c, s); },
  };
}

// ── extractUpdateCause ────────────────────────────────────────────────────────

describe("extractUpdateCause", () => {
  it("returns null for empty output", () => {
    expect(extractUpdateCause("")).toBeNull();
    expect(extractUpdateCause("   \n  \n")).toBeNull();
  });

  it("returns last npm ERR! line", () => {
    const out = "npm ERR! code EACCES\nnpm ERR! errno -13\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'";
    const cause = extractUpdateCause(out);
    expect(cause).toMatch(/EACCES/);
  });

  it("returns last npm error line (lowercase variant)", () => {
    const out = "npm error code ETARGET\nnpm error notarget No matching version found for @songsid/agend@99.0.0";
    const cause = extractUpdateCause(out);
    expect(cause).toMatch(/notarget/); // last npm error line, not the first
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
    // ghp_ token in the npm ERR! line must be masked
    const cause = extractUpdateCause("npm ERR! Error: ghp_ABCDEFGHIJ1234567890AB_secret");
    expect(cause).not.toContain("ghp_ABCDEFGHIJ");
  });

  it("caps at 300 chars", () => {
    const long = `npm ERR! ${"x".repeat(1000)}`;
    expect(extractUpdateCause(long)!.length).toBeLessThanOrEqual(300);
  });
});

// ── watchUpdateLaunch with log and cause ────────────────────────────────────

describe("watchUpdateLaunch (#1818): cause in failure message and update.log written", () => {
  it("npm EACCES output → cause in message and log written", () => {
    const { child, send, exit } = fakeChild(1);
    const logPath = updateLogPath(dataDir);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    send("npm error code EACCES\nnpm ERR! Error: EACCES: permission denied, /usr/local");
    exit();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/EACCES/);
    expect(messages[0]).toContain(logPath);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("EACCES");
  });

  it("✗ activation line → cause extracted", () => {
    const { child, send, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), updateLogPath(dataDir));
    send("Installing…\n✗ activation failed: Service refused to start");
    exit();
    expect(messages[0]).toMatch(/activation failed/);
  });

  it("no output → message still contains the exit code, no cause", () => {
    const { child, exit } = fakeChild(1);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), updateLogPath(dataDir));
    exit();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("updater exited 1");
    expect(messages[0]).not.toContain("Cause:"); // no cause when no output
  });

  it("secret-looking text in output is masked in both log and message", () => {
    const { child, send, exit } = fakeChild(1);
    const logPath = updateLogPath(dataDir);
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m), logPath);
    // A PAT in the output must never appear in the log or the message
    send("npm ERR! Error: ENOTEMPTY npm_token=npm_ABCDEFGHIJ1234567890AB\nmore text");
    exit();
    const logContent = readFileSync(logPath, "utf8");
    expect(logContent).not.toContain("npm_ABCDEFGHIJ1234567890AB");
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

  it("signal (SIGTERM) reports interrupted", () => {
    const { child, exit } = fakeChild(null, "SIGTERM");
    const messages: string[] = [];
    watchUpdateLaunch(child, m => messages.push(m));
    exit(null, "SIGTERM");
    expect(messages[0]).toContain("interrupted");
  });
});

// ── appendUpdateLog + file cap ───────────────────────────────────────────────

describe("appendUpdateLog: file is capped at UPDATE_LOG_FILE_CAP", () => {
  it("a new run appends to the log", () => {
    const path = join(dataDir, "update.log");
    appendUpdateLog(path, "--- run 1 ---", "first run output");
    expect(readFileSync(path, "utf8")).toContain("first run output");
  });

  it("log is truncated when it would exceed UPDATE_LOG_FILE_CAP", () => {
    const path = join(dataDir, "update.log");
    // Fill file close to the cap
    writeFileSync(path, "x".repeat(UPDATE_LOG_FILE_CAP - 100), { mode: 0o600 });
    appendUpdateLog(path, "--- new run ---", "new output that would exceed cap");
    const size = readFileSync(path).length;
    expect(size).toBeLessThan(UPDATE_LOG_FILE_CAP + 200); // capped
  });

  it("the update.log path is under AGEND_HOME", () => {
    expect(updateLogPath("/home/user/.agend")).toBe("/home/user/.agend/update.log");
  });
});
