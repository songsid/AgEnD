import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { preparePowerShell } from "../scripts/ci/prepare-pwsh.mjs";

const frames = (lines: string[]) => lines.map(line => JSON.parse(line.slice("[pwsh-preparation] ".length)));

describe("bounded CI PowerShell preparation", () => {
  it("runs two version queries and a tiny assembly/script compile, with separately measured bounded phases", () => {
    const lines: string[] = [];
    let clock = 0;
    const run = vi.fn(() => { clock += 125; return { status: 0, signal: null }; });
    preparePowerShell({ run, now: () => clock, log: line => lines.push(line) });
    expect(run).toHaveBeenCalledTimes(3);
    for (const [file, args, options] of run.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>) {
      expect(file).toBe("pwsh");
      expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      expect(options).toEqual({ stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL" });
    }
    const args = run.mock.calls as unknown as Array<[string, string[]]>;
    expect(args[0]![1][4]).toContain("$PSVersionTable.PSVersion");
    expect(args[1]![1][4]).toBe(args[0]![1][4]);
    expect(args[2]![1][4]).toContain("Add-Type -TypeDefinition");
    expect(args[2]![1][4]).toContain("[scriptblock]::Create");
    expect(frames(lines)).toEqual([
      { phase: "version-1", elapsedMs: 125, status: 0, signal: null, error: false },
      { phase: "version-2", elapsedMs: 125, status: 0, signal: null, error: false },
      { phase: "compile", elapsedMs: 125, status: 0, signal: null, error: false },
      { phase: "complete", elapsedMs: 375 },
    ]);
  });

  it.each([
    { status: 7, signal: null },
    { status: null, signal: "SIGTERM" },
    { status: null, signal: null, error: Object.assign(new Error("fixture"), { code: "ETIMEDOUT" }) },
    { status: 0, signal: null, error: new Error("fixture") },
  ])("stops at the first failed phase without emitting complete: %j", failure => {
    const lines: string[] = [];
    const run = vi.fn().mockReturnValueOnce({ status: 0, signal: null }).mockReturnValue(failure);
    expect(() => preparePowerShell({ run, now: () => 0, log: line => lines.push(line) })).toThrow("PowerShell preparation version-2 failed");
    expect(run).toHaveBeenCalledTimes(2);
    expect(frames(lines).map(line => line.phase)).toEqual(["version-1", "version-2"]);
  });

  it("the default duration clock survives wall-clock adjustments", () => {
    let tick = 0;
    const wall = vi.spyOn(Date, "now").mockImplementation(() => (++tick % 2 ? 1 : -1) * 1e12);
    const lines: string[] = [];
    try {
      preparePowerShell({ run: () => ({ status: 0 }), log: line => lines.push(line) });
      expect(frames(lines).every(line => line.elapsedMs >= 0 && line.elapsedMs < 1000)).toBe(true);
    } finally { wall.mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("the actual CLI returns failure when preparation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-pwsh-preparation-"));
    try {
      const stub = join(dir, "pwsh");
      writeFileSync(stub, "#!/bin/sh\nexit 23\n"); chmodSync(stub, 0o755);
      const result = spawnSync(process.execPath, [resolve("scripts/ci/prepare-pwsh.mjs")], {
        env: { ...process.env, PATH: dir }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("PowerShell preparation version-1 failed");
      expect(result.stdout).not.toContain('"phase":"complete"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
