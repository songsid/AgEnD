import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mcpServerState } from "../src/mcp-liveness.js";

/**
 * The daemon can only OBSERVE the MCP server (the CLI owns it), so the whole
 * feature rests on classifying channel.mcp.pid correctly. Getting this wrong is
 * either a false alarm on every healthy tick or silence during a real outage.
 */
describe("mcpServerState", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mcp-liveness-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (contents: string) => writeFileSync(join(dir, "channel.mcp.pid"), contents);

  it("reports 'unknown' when no pid file exists (not started, or clean exit)", () => {
    // The server unlinks its own pid file on a clean exit, so absence is normal —
    // treating it as death would alarm on every startup.
    expect(mcpServerState(dir)).toEqual({ state: "unknown" });
  });

  it("reports 'alive' for a running process", () => {
    write(String(process.pid));
    expect(mcpServerState(dir)).toEqual({ state: "alive", pid: process.pid });
  });

  it("reports 'dead' for a pid file left behind by a crash", async () => {
    // A real process that exits without cleaning up its pid file.
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},50)"]);
    const pid = child.pid!;
    write(String(pid));
    await new Promise<void>(resolve => child.on("exit", () => resolve()));
    await vi.waitFor(() => expect(mcpServerState(dir)).toEqual({ state: "dead", pid }));
  });

  it("treats a garbage or unsafe pid as 'unknown', never 'dead'", () => {
    for (const bad of ["", "   ", "not-a-pid", "0", "1", "-42", "9e99"]) {
      write(bad);
      expect(mcpServerState(dir).state).toBe("unknown");
    }
  });

  it("ignores surrounding whitespace/newline in the pid file", () => {
    write(`  ${process.pid}\n`);
    expect(mcpServerState(dir)).toEqual({ state: "alive", pid: process.pid });
  });
});
