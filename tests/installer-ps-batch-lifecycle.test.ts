import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: () => ({ status: 0 }),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
      exitCode: number | null; signalCode: string | null; kill: () => void;
    };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    vi.spyOn(child.stdin, "write");
    child.stdin.on("finish", () => { child.exitCode = 0; child.emit("close", 0); });
    child.kill = vi.fn(() => { child.signalCode = "SIGTERM"; child.emit("close", null); });
    return child;
  }),
}));
import { spawn } from "node:child_process";
import { InstallerPsBatch } from "./support/installer-ps-batch.js";

const cases = ["close", "deadline", "stdin"] as const;
const batches = cases.map(() => new InstallerPsBatch({ helpers: "function F { 'ok' }" }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("terminal PowerShell worker failures", () => {
  it.each(cases)("retains the first %s failure and never writes or waits on that worker again", async kind => {
    vi.useFakeTimers();
    const batch = batches[cases.indexOf(kind)]!;
    const first = batch.run("helpers", "F").catch(error => error as Error);
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof spawn>;
    if (kind === "close") { child.exitCode = 23; child.emit("close", 23); }
    else if (kind === "deadline") { await vi.advanceTimersByTimeAsync(10_000); }
    else { child.stdin!.emit("error", new Error("fixture stdin closed")); }
    const failure = await first;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(kind === "close" ? "exited 23" : kind === "deadline" ? "10 s test budget" : "fixture stdin closed");
    const writes = vi.mocked(child.stdin!.write).mock.calls.length;
    const again = batch.run("helpers", "throw 'must never be sent'");
    void again.catch(() => {});
    expect(child.stdin!.write).toHaveBeenCalledTimes(writes);
    expect(vi.getTimerCount()).toBe(0);
    await expect(again).rejects.toBe(failure);
  });
});
