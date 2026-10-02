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

  it("supports file-style console formatting for callers", () => {
    expect(getStdoutPrettyOptions(true)).toMatchObject({
      colorize: false,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
    });
  });

  it("writes structured entries only to daemon.log when service stdout/stderr share fleet.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-logger-"));
    const fleetLog = join(dir, "fleet.log");
    const fd = openSync(fleetLog, "w");
    const loggerUrl = new URL("../src/logger.ts", import.meta.url).href;
    try {
      const child = spawnSync(process.execPath, [
        "--import", "tsx",
        "--input-type=module",
        "--eval",
        `import { createLogger } from ${JSON.stringify(loggerUrl)}; const logger = createLogger("debug"); logger.info("date-probe"); logger.child({ instance: "worker" }, { level: "debug" }).debug("child-probe"); console.error("bootstrap-error"); process.emitWarning("other-warning", { code: "AGEND_TEST" }); await new Promise(resolve => setTimeout(resolve, 250));`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, AGEND_HOME: dir, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" },
        stdio: ["ignore", fd, fd],
        encoding: "utf-8",
        timeout: 8_000,
      });
      expect(child.status, child.stderr).toBe(0);
      const bootstrap = readFileSync(fleetLog, "utf-8");
      expect(bootstrap).not.toContain("date-probe");
      expect(bootstrap).not.toContain("child-probe");
      expect(bootstrap).toContain("bootstrap-error");
      expect(bootstrap).toContain("[AGEND_TEST] Warning: other-warning");
      const output = readFileSync(join(dir, "daemon.log"), "utf-8");
      expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] INFO: date-probe/m);
      expect(output.match(/date-probe/g)).toHaveLength(1);
      expect(output.match(/child-probe/g)).toHaveLength(1);
      expect(output).not.toContain("\u001b[");
      expect(output).not.toContain("bootstrap-error");
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("only mirrors structured logs to stdout for an interactive terminal (isTTY=%s)", isTTY => {
    const dir = mkdtempSync(join(tmpdir(), "agend-logger-console-"));
    try {
      const loggerUrl = new URL("../src/logger.ts", import.meta.url).href;
      const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval",
        `Object.defineProperty(process.stdout, "isTTY", { value: ${isTTY} }); const { createLogger } = await import(${JSON.stringify(loggerUrl)}); createLogger().info("console-probe"); await new Promise(resolve => setTimeout(resolve, 250));`,
      ], { cwd: process.cwd(), env: { ...process.env, AGEND_HOME: dir }, encoding: "utf8", timeout: 8_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.includes("console-probe")).toBe(isTTY);
      expect(readFileSync(join(dir, "daemon.log"), "utf8").match(/console-probe/g)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
