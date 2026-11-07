import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLogoutProcess } from "../src/runtime-client.js";
import { ProcessNotConfirmedEnded } from "../src/runtime-remote-accounts.js";

afterEach(() => { vi.useRealTimers(); });
class Child extends EventEmitter { pid: number | undefined = 4711; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; }
const make = (pid: number | null = 4711) => { const child = new Child(); child.pid = pid === null ? undefined : pid; const spawned: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  return { child, spawned, spawn: ((command: string, args: readonly string[], options: unknown) => { spawned.push({ command, args, options }); return child as unknown as ChildProcess; }) as never }; };
const run = (m: ReturnType<typeof make>, kill = vi.fn()) => ({ kill, result: runLogoutProcess({ command: "claude.exe", args: ["--x"] }, ["auth", "logout"], { A: "1" }, 30_000, 5_000, m.spawn, kill) });

describe("claude auth logout as a process the Runtime owns", () => {
  it("runs the program with the fixed arguments, no shell, no output read, and resolves with its exit code when it closes", async () => {
    const m = make(), { result } = run(m); expect(m.spawned[0]).toMatchObject({ command: "claude.exe", args: ["--x", "auth", "logout"], options: { shell: false, stdio: "ignore", windowsHide: true, env: { A: "1" } } });
    m.child.emit("close", 0); await expect(result).resolves.toBe(0);
  });
  it("a program that never started (an error with no pid) has ended: null", async () => {
    const m = make(null), { result } = run(m); m.child.emit("error", new Error("spawn ENOENT C:\\secret")); await expect(result).resolves.toBeNull();
  });
  it("an `error` from a child that exists proves nothing: the call keeps waiting for `close`", async () => {
    vi.useFakeTimers(); const m = make(), { result } = run(m); let settled = false; result.then(() => { settled = true; }, () => { settled = true; });
    m.child.emit("error", new Error("kill EPERM")); await vi.advanceTimersByTimeAsync(1000); expect(settled).toBe(false);
    m.child.emit("close", 0); await expect(result).resolves.toBe(0);
  });
  it("on the time limit the process tree is killed, and a `close` that comes in the next five seconds is the answer", async () => {
    vi.useFakeTimers(); const m = make(), { result, kill } = run(m); await vi.advanceTimersByTimeAsync(30_000);
    expect(kill).toHaveBeenCalledTimes(1); expect(kill).toHaveBeenCalledWith(m.child); await vi.advanceTimersByTimeAsync(2000); m.child.emit("close", 1); await expect(result).resolves.toBe(1);
  });
  it("a delayed close after the kill: not finished early, the profile lock is not given up before the process is confirmed gone, then `ended` settles when it closes", async () => {
    vi.useFakeTimers(); const m = make(), { result } = run(m); const outcome = result.catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000 + 4_900);
    let early = false; outcome.then(() => { early = true; }); await Promise.resolve(); expect(early).toBe(false);                      // not before the wait is over
    await vi.advanceTimersByTimeAsync(200); const error = await outcome; expect(error).toBeInstanceOf(ProcessNotConfirmedEnded);
    let ended = false; (error as ProcessNotConfirmedEnded).ended.then(() => { ended = true; }); await vi.advanceTimersByTimeAsync(1000); expect(ended).toBe(false);   // still running
    m.child.emit("close", 1); await vi.advanceTimersByTimeAsync(0); expect(ended).toBe(true);
  });
  it("an error carries no output and no path: it is a typed marker with the `ended` promise only", async () => {
    vi.useFakeTimers(); const m = make(), { result } = run(m); const outcome = result.catch(error => error); await vi.advanceTimersByTimeAsync(40_000);
    const error = await outcome as ProcessNotConfirmedEnded; expect(error.message).toBe("The process could not be confirmed ended"); expect(Object.keys(error).sort()).toEqual(["ended", "name"]);
  });
});
