/**
 * M-2239 P2-5: no test can reach Windows. On a WSL host — the user's — a Windows program runs on the real Windows
 * through interop. The test process guard (tests/support/process-guard.cjs) refuses one in every form: the bridge's
 * powershell.exe under /mnt/c, wslpath, the Windows node.exe a native worker runs on, a drive path, a shell string.
 */
import { describe, expect, it } from "vitest";
import { checkTestProcess, processGuard } from "./support/process-guard.js";
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
});
