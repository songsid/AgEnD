/**
 * M-2239 P2-5: no test can reach Windows. On a WSL host — the user's — a Windows program runs on the real Windows
 * through interop. The test process guard (tests/support/process-guard.cjs) refuses one in every form: the bridge's
 * powershell.exe under /mnt/c, wslpath, the Windows node.exe a native worker runs on, a drive path, a shell string.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { checkTestProcess, processGuard, registerExecutableFixture } from "./support/process-guard.js";
import { WindowsCliBridge } from "../src/windows-cli.js";

describe("M-2239 P2-5: the test process guard refuses Windows interop", () => {
  it.each([
    ["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive"]],
    ["wslpath", ["-u", "C:\\Program Files\\nodejs\\node.exe"]],
    ["/mnt/c/Program Files/nodejs/node.exe", ["C:\\AgEnD\\windows-cli-worker.js"]],
    ["C:\\Program Files\\nodejs\\node.exe", []],
    ["/home/u/.local/bin/codex.exe", ["--version"]],
    ["/bin/sh", ["-c", "cmd.exe /c dir"]],
    ["/mnt/d/tools/mytool", ["--version"]],         // a drvfs program without an extension
    ["D:\\tools\\agy", []],
  ])("refuses %s", (file, args) => {
    expect(() => checkTestProcess(file, args)).toThrow(/Windows program from a test is forbidden/);
  });

  it("leaves Linux programs alone", () => {
    for (const [file, args] of [["node", ["x.js"]], ["/bin/sh", ["-c", "echo hi"]], ["git", ["status"]]] as const) expect(() => checkTestProcess(file, [...args])).not.toThrow();
  });

  it("the bridge's real default launcher is refused before any Windows process starts", async () => {
    await expect(new WindowsCliBridge().probe({ force: true })).rejects.toThrow();
    // The refusal is recorded as a violation; this test asked for it, so it is taken here and not failed in afterEach.
    expect(processGuard.takeViolations().join("\n")).toMatch(/Windows program from a test is forbidden: powershell\.exe/);
  });

  // #2939 review: the program a wrapper runs is the one checked — `env <x>`, `timeout …`, and `sh -c 'exec "$@"' sh <x>`.
  // A private stand-in named like a Windows program writes a marker when it runs; it must never run unregistered.
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  function standIn(name: string) {
    const dir = mkdtempSync(join(tmpdir(), "agend-windows-standin-")); dirs.push(dir);
    const file = join(dir, name), marker = `${file}.started`;
    writeFileSync(file, `#!/bin/sh\nprintf started > '${marker}'\n`); chmodSync(file, 0o700);
    return { file, marker };
  }
  it.each([
    ["/usr/bin/env", (f: string) => [f]],
    ["/usr/bin/env", (f: string) => ["FOO=1", "-u", "BAR", f, "-NoProfile"]],
    ["timeout", (f: string) => ["-k", "1", "5", f]],
    ["nice", (f: string) => ["-n", "5", f]],
    ["/bin/sh", (f: string) => ["-c", 'exec "$@"', "sh", f, "-NoProfile"]],
    // #2939 review round 2: long options with a separate value, and a wrapper inside a literal shell command.
    ["/usr/bin/env", (f: string) => ["--unset", "BAR", f]],
    ["/usr/bin/env", (f: string) => ["--unset=BAR", "-uBAZ", f]],
    ["timeout", (f: string) => ["--kill-after", "1", "5", f]],
    ["/bin/sh", (f: string) => ["-c", `env -u BAR "${f}"`]],
    ["/bin/sh", (f: string) => ["-c", `timeout --kill-after 1 5 ${f}`]],
    ["/bin/sh", (f: string) => ["-c", `exec -a name ${f}`]],
  ] as const)("%s %# refuses a Windows program it would run, which never starts", (wrapper, args) => {
    const { file, marker } = standIn("powershell.exe");
    expect(() => { const r = spawnSync(wrapper, args(file)); if (r.error) throw r.error; }).toThrow(/Windows program from a test is forbidden/);
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations().join("\n")).toMatch(/Windows program from a test is forbidden: powershell\.exe/);
  });
  it.each([
    [["--not-an-env-option", "x"]],
    [["--block-signal=INT"]],        // a real env option the table does not model: refused, not guessed
  ])("an option the guard does not understand (%j) is refused before anything runs", options => {
    const { file, marker } = standIn("powershell.exe");
    expect(() => { const r = spawnSync("/usr/bin/env", [...options, file]); if (r.error) throw r.error; }).toThrow(/not an option the process guard understands/);
    expect(existsSync(marker)).toBe(false);
    expect(processGuard.takeViolations().join("\n")).toMatch(/not an option the process guard understands/);
  });

  it("a registered private fixture still runs through a wrapper; a Linux program too", () => {
    const { file, marker } = standIn("powershell.exe");
    registerExecutableFixture(file);
    expect(spawnSync("/usr/bin/env", [file]).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    const shell = standIn("tool");
    expect(spawnSync("/bin/sh", ["-c", 'exec "$@"', "sh", shell.file]).status).toBe(0);
    expect(existsSync(shell.marker)).toBe(true);
    const viaEnv = standIn("tool");
    expect(spawnSync("/bin/sh", ["-c", `env -u BAR --unset=BAZ ${viaEnv.file}`]).status).toBe(0);
    expect(existsSync(viaEnv.marker)).toBe(true);
    expect(processGuard.takeViolations()).toEqual([]);
  });

  it("on Windows itself the rule is off — Vitest's own node.exe workers must start there (#2936 review)", () => {
    const { isWindowsInterop } = createRequire(import.meta.url)("./support/process-guard.cjs") as { isWindowsInterop(file: string, platform?: string): boolean };
    for (const file of ["C:\\Program Files\\nodejs\\node.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", "wslpath"]) {
      expect(isWindowsInterop(file, "win32")).toBe(false);
      expect(isWindowsInterop(file, "linux")).toBe(true);
    }
  });
});
