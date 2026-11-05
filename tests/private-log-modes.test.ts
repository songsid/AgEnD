/**
 * The AgEnD home's log and its rotated copies are private (0600) whatever the umask, through the writer that really
 * writes them: pino-pretty opens the file itself and takes no mode, so the file is created or repaired first, by
 * descriptor, never through a symlink. Scratch homes only.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivateLogFile, ensurePrivateLogFiles, rotateLogIfNeeded, rotateLogIfNeededAsync } from "../src/logger.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function scratch(): string { const d = fs.mkdtempSync(join(tmpdir(), "agend-logmode-")); dirs.push(d); return d; }
const mode = (p: string) => fs.statSync(p).mode & 0o777;
function withUmask<T>(mask: number, fn: () => T): T { const old = process.umask(mask); try { return fn(); } finally { process.umask(old); } }
const loggerUrl = new URL("../src/logger.ts", import.meta.url).href;

/** createLogger in a child process, as the fleet runs it, against a scratch AGEND_HOME under umask 022. */
function runLogger(home: string, module = loggerUrl) {
  const script = `process.umask(0o022); const { createLogger } = await import(${JSON.stringify(module)}); createLogger("info").info("mode-probe"); await new Promise(r => setTimeout(r, 400));`;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { ...process.env, AGEND_HOME: home, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

describe.skipIf(process.platform === "win32")("private log files", () => {
  it("creates a missing log 0600 under umask 022, repairs an existing 0644 one, and keeps its content", () => {
    const dir = scratch(), log = join(dir, "daemon.log");
    withUmask(0o022, () => ensurePrivateLogFile(log));
    expect(mode(log)).toBe(0o600);
    fs.writeFileSync(log, "kept\n"); fs.chmodSync(log, 0o644);
    ensurePrivateLogFile(log);
    expect(mode(log)).toBe(0o600);
    expect(fs.readFileSync(log, "utf8")).toBe("kept\n");
  });

  it("repairs existing rotated copies but never creates one", () => {
    const dir = scratch(), log = join(dir, "daemon.log");
    fs.writeFileSync(`${log}.1`, "a"); fs.chmodSync(`${log}.1`, 0o644);
    fs.writeFileSync(`${log}.3`, "c"); fs.chmodSync(`${log}.3`, 0o664);
    withUmask(0o022, () => ensurePrivateLogFiles(log));
    expect([mode(log), mode(`${log}.1`), mode(`${log}.3`)]).toEqual([0o600, 0o600, 0o600]);
    expect(fs.existsSync(`${log}.2`)).toBe(false);
  });

  it("never follows a symlink or blocks on a FIFO, and leaves their targets alone", () => {
    const dir = scratch(), target = join(dir, "elsewhere"), log = join(dir, "daemon.log");
    fs.writeFileSync(target, "x"); fs.chmodSync(target, 0o644); fs.symlinkSync(target, log);
    ensurePrivateLogFile(log);
    expect(mode(target)).toBe(0o644);
    expect(fs.lstatSync(log).isSymbolicLink()).toBe(true);
    const fifo = join(dir, "fifo.log");
    expect(spawnSync("mkfifo", ["-m", "644", fifo]).status).toBe(0);
    ensurePrivateLogFile(fifo);                                              // returns: O_NONBLOCK, and not a regular file
    expect(mode(fifo)).toBe(0o644);
  });

  it("a rotation's copy is private even when the live log was not", async () => {
    for (const rotate of [(p: string) => { rotateLogIfNeeded(p, 10); }, (p: string) => rotateLogIfNeededAsync(p, 10)]) {
      const dir = scratch(), log = join(dir, "output.log");
      fs.writeFileSync(log, "x".repeat(50)); fs.chmodSync(log, 0o644);
      await withUmask(0o022, () => rotate(log));
      expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(50));
      expect(mode(`${log}.1`)).toBe(0o600);
    }
  });

  it("end to end: the fleet logger's real writer leaves a fresh log, a legacy 0644 log and its rotations 0600, in a 0700 home", () => {
    // Control: the writer alone (pino-pretty to a path) creates its file 0644 under umask 022 — so the mode is ours.
    const control = scratch(), raw = join(control, "raw.log");
    const c = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `process.umask(0o022); const { default: pino } = await import("pino"); const t = pino.transport({ targets: [{ target: "pino-pretty", options: { destination: ${JSON.stringify(raw)}, colorize: false }, level: "info" }] }); pino(t).info("x"); await new Promise(r => setTimeout(r, 400));`],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
    expect(c.status, c.stderr).toBe(0);
    expect(mode(raw)).toBe(0o644);

    const fresh = join(scratch(), "home");
    let r = runLogger(fresh);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(join(fresh, "daemon.log"), "utf8")).toContain("mode-probe");
    expect([mode(fresh), mode(join(fresh, "daemon.log"))]).toEqual([0o700, 0o600]);

    const legacy = scratch();
    fs.chmodSync(legacy, 0o755);
    fs.writeFileSync(join(legacy, "daemon.log"), "old\n"); fs.chmodSync(join(legacy, "daemon.log"), 0o644);
    fs.writeFileSync(join(legacy, "daemon.log.2"), "older\n"); fs.chmodSync(join(legacy, "daemon.log.2"), 0o644);
    r = runLogger(legacy);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(join(legacy, "daemon.log"), "utf8")).toMatch(/^old\n[\s\S]*mode-probe/);
    expect([mode(legacy), mode(join(legacy, "daemon.log")), mode(join(legacy, "daemon.log.2"))]).toEqual([0o700, 0o600, 0o600]);
  });
});
