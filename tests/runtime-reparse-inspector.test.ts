import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ command: string; args: string[]; options: Record<string, any> }> = [];
let behave: (child: any) => void = () => {};
vi.mock("../src/child-process.js", () => ({
  spawn: (command: string, args: string[], options: Record<string, any>) => {
    const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.kill = vi.fn(); calls.push({ command, args, options }); queueMicrotask(() => behave(child)); return child;
  },
}));
const { windowsReparseInspector } = await import("../src/runtime-profile-ownership.js");
afterEach(() => { calls.length = 0; behave = () => {}; vi.useRealTimers(); });

describe("the Windows reparse-point inspector (review item 14)", () => {
  it("is asynchronous and starts PowerShell with the minimum environment: SystemRoot, windir, TEMP, TMP, a System32-only PATH, and the paths", async () => {
    behave = child => { child.stdout.write("0\n1\n"); child.emit("close", 0); };
    const answer = windowsReparseInspector(["C:\\a", "C:\\a\\b"]); expect(answer).toBeInstanceOf(Promise);
    expect(await answer).toEqual([false, true]);
    const { command, args, options } = calls[0]!;
    expect(command).toMatch(/System32.WindowsPowerShell.v1\.0.powershell\.exe$/); expect(args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    expect(Object.keys(options.env).sort()).toEqual(["AGEND_CHECK_PATHS", "PATH", "SystemRoot", "TEMP", "TMP", "windir"].sort());
    expect(options.env.AGEND_CHECK_PATHS).toBe("C:\\a|C:\\a\\b"); expect(options.env.PATH).toMatch(/System32$/); expect(options.env.PATH).not.toContain(";");
    expect(options.env.windir).toBe(options.env.SystemRoot);
    expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]); expect(options.windowsHide).toBe(true);
    expect(args.join(" ")).not.toContain("C:\\a");                                          // the paths never go into the command line
  });
  it("fails closed, with no path in the error, when PowerShell cannot be started, exits badly, or answers something else", async () => {
    for (const how of [(child: any) => child.emit("error", new Error("spawn C:\\secret ENOENT")), (child: any) => child.emit("close", 1),
      (child: any) => { child.stdout.write("0\n"); child.emit("close", 0); }, (child: any) => { child.stdout.write("x\ny\n"); child.emit("close", 0); }, (child: any) => child.emit("close", 0)]) {
      behave = how; const error = await windowsReparseInspector(["C:\\secret\\a", "C:\\secret\\b"]).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toMatch(/secret|C:\\/);
    }
  });
  it("gives up after twenty seconds and ends the child", async () => {
    vi.useFakeTimers(); const answer = windowsReparseInspector(["C:\\a"]).catch((e: Error) => e); await vi.advanceTimersByTimeAsync(20_100);
    expect(await answer).toMatchObject({ message: "Reparse point check timed out" });
  });
});
