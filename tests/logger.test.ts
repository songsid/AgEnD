import { describe, expect, it } from "vitest";
import { getStdoutPrettyOptions, rotateLogIfNeeded } from "../src/logger.js";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("logger stdout formatting", () => {
  it("keeps interactive console output compact", () => {
    expect(getStdoutPrettyOptions(false)).toMatchObject({
      colorize: true,
      translateTime: "SYS:HH:MM:ss",
    });
  });

  it("adds a date and removes ANSI colors when stdout is fleet.log", () => {
    expect(getStdoutPrettyOptions(true)).toMatchObject({
      colorize: false,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
    });
  });

  it("writes the full date when the process stdout fd is a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-logger-"));
    const fleetLog = join(dir, "fleet.log");
    const fd = openSync(fleetLog, "w");
    const loggerUrl = new URL("../src/logger.ts", import.meta.url).href;
    try {
      const child = spawnSync(process.execPath, [
        "--import", "tsx",
        "--input-type=module",
        "--eval",
        `import { createLogger } from ${JSON.stringify(loggerUrl)}; const logger = createLogger(); logger.info("date-probe"); await new Promise(resolve => setTimeout(resolve, 250));`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, AGEND_HOME: dir },
        stdio: ["ignore", fd, "pipe"],
        encoding: "utf-8",
      });
      expect(child.status, child.stderr).toBe(0);
    } finally {
      closeSync(fd);
    }

    const output = readFileSync(fleetLog, "utf-8");
    expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] INFO: date-probe/m);
    expect(output).not.toContain("\u001b[");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("rotateLogIfNeeded", () => {
  it("copytruncates when over maxSize", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-rotate-"));
    const log = join(dir, "output.log");
    writeFileSync(log, "x".repeat(100));
    rotateLogIfNeeded(log, 50, 3);
    expect(statSync(log).size).toBe(0);
    expect(existsSync(`${log}.1`)).toBe(true);
    expect(statSync(`${log}.1`).size).toBe(100);
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncates without copying when ballooned far past the limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-rotate-huge-"));
    const log = join(dir, "output.log");
    // maxSize 10 → balloon threshold 100; write 120 bytes
    writeFileSync(log, "y".repeat(120));
    writeFileSync(`${log}.1`, "old");
    rotateLogIfNeeded(log, 10, 3);
    expect(statSync(log).size).toBe(0);
    expect(existsSync(`${log}.1`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops when under maxSize", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-rotate-small-"));
    const log = join(dir, "output.log");
    writeFileSync(log, "tiny");
    rotateLogIfNeeded(log, 1000, 3);
    expect(statSync(log).size).toBe(4);
    expect(existsSync(`${log}.1`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

