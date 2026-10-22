/**
 * #2374: a child's stdio pipes are emitters of their own. An error on one that nobody hears is an uncaught exception,
 * which stops the fleet (#2243). src/child-process.ts guards every pipe; fleet code takes spawn/execFile/exec from it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec, execFile, guardStdio, spawn } from "../src/child-process.js";

const pipeError = () => Object.assign(new Error("read EIO"), { code: "EIO" });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let uncaught: ReturnType<typeof vi.fn<(err: Error) => void>>;
beforeEach(() => { uncaught = vi.fn<(err: Error) => void>(); process.on("uncaughtException", uncaught); });
afterEach(() => { process.off("uncaughtException", uncaught); });
const settle = () => new Promise(r => setTimeout(r, 20));

describe.skipIf(process.platform === "win32")("#2374 guarded child processes, real children", () => {
  it("spawn: a stdout pipe error kills the child, which closes with a signal; nothing goes uncaught", async () => {
    const child = spawn("sh", ["-c", "echo hi; exec sleep 30"], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(r => child.on("close", (code, signal) => r([code, signal])));
    await new Promise(r => child.stdout!.once("data", r));
    child.stdout!.destroy(pipeError());
    expect(await closed).toEqual([null, "SIGTERM"]);
    expect(alive(child.pid!)).toBe(false);
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("spawn: a stderr pipe error is heard too", async () => {
    const child = spawn("sh", ["-c", "echo oops >&2; exec sleep 30"], { stdio: ["ignore", "ignore", "pipe"] });
    const closed = new Promise(r => child.on("close", (_c, signal) => r(signal)));
    await new Promise(r => child.stderr!.once("data", r));
    child.stderr!.destroy(pipeError());
    expect(await closed).toBe("SIGTERM");
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("spawn: a stdin write error (the child closed its end) is heard", async () => {
    const child = spawn("sh", ["-c", "exec 0<&- sleep 30"], { stdio: ["pipe", "ignore", "ignore"] });
    const closed = new Promise(r => child.on("close", (_c, signal) => r(signal)));
    child.stdin!.destroy(pipeError());
    expect(await closed).toBe("SIGTERM");
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("spawn: a caller listening for the child's error gets the pipe error", async () => {
    const child = spawn("sh", ["-c", "echo hi; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
    const failed = new Promise<NodeJS.ErrnoException>(r => child.on("error", r));
    await new Promise(r => child.stdout!.once("data", r));
    child.stdout!.destroy(pipeError());
    expect((await failed).code).toBe("EIO");
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("execFile: the callback gets the pipe error, with what was read before it, never a success", async () => {
    let child!: ReturnType<typeof execFile>;
    const result = new Promise<{ err: { code?: unknown } | null; stdout: string }>(r => {
      child = execFile("sh", ["-c", "echo hi; exec sleep 30"], { encoding: "utf8" }, (err, stdout) => r({ err, stdout }));
    });
    await new Promise(r => child.stdout!.once("data", r));
    child.stdout!.destroy(pipeError());
    const { err, stdout } = await result;
    expect(err?.code).toBe("EIO");
    expect(stdout).toBe("hi\n");
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  // Prism on #2377: the kill alone cannot fail a call whose child exits 0 on SIGTERM, or has already exited 0.
  it("execFile: a child that exits 0 on SIGTERM still fails the call with the pipe error", async () => {
    let child!: ReturnType<typeof execFile>;
    const result = new Promise<{ err: { code?: unknown } | null; stdout: string }>(r => {
      child = execFile(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('partial'); setInterval(() => {}, 1000);"],
        { encoding: "utf8" }, (err, stdout) => r({ err, stdout }));
    });
    await new Promise(r => child.stdout!.once("data", r));
    child.stdout!.destroy(pipeError());
    const { err, stdout } = await result;
    expect([err?.code, stdout]).toEqual(["EIO", "partial"]);
    await vi.waitFor(() => expect(child.exitCode).toBe(0));        // it did exit 0: the error is what failed the call
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("execFile: the shell already exited 0 while a descendant holds the pipe: the call fails, not a short answer", async () => {
    let child!: ReturnType<typeof execFile>;
    const result = new Promise<{ err: { code?: unknown } | null; stdout: string }>(r => {
      child = execFile("sh", ["-c", "(printf head; sleep 1; printf tail) &"], { encoding: "utf8" }, (err, stdout) => r({ err, stdout }));
    });
    await new Promise(r => child.stdout!.once("data", r));
    await vi.waitFor(() => expect(child.exitCode).toBe(0));
    child.stdout!.destroy(pipeError());
    const { err, stdout } = await result;
    expect([err?.code, stdout]).toEqual(["EIO", "head"]);
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("promisify(execFile) keeps node's { stdout, stderr } answer, and a pipe error rejects it", async () => {
    const run = promisify(execFile);
    expect(await run("sh", ["-c", "printf out; printf err >&2"], { encoding: "utf8" })).toEqual({ stdout: "out", stderr: "err" });
    const pending = run("sh", ["-c", "echo hi; exec sleep 30"], { encoding: "utf8" });
    const child = (pending as unknown as { child: ReturnType<typeof execFile> }).child;
    await new Promise(r => child.stdout!.once("data", r));
    child.stdout!.destroy(pipeError());
    await expect(pending).rejects.toMatchObject({ code: "EIO", stdout: "hi\n" });
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("promisify(exec) is guarded the same way", async () => {
    const run = promisify(exec);
    expect(await run("printf ok", { encoding: "utf8" })).toEqual({ stdout: "ok", stderr: "" });
    const pending = run("echo hi; exec sleep 30", { encoding: "utf8" });
    const child = (pending as unknown as { child: ReturnType<typeof exec> }).child;
    await new Promise(r => child.stdout!.once("data", r));
    child.stdout!.destroy(pipeError());
    await expect(pending).rejects.toMatchObject({ code: "EIO" });
    await settle();
    expect(uncaught).not.toHaveBeenCalled();
  });
});

describe("#2374 guardStdio", () => {
  it("a caller's own response replaces the kill", () => {
    const listeners: Array<(e: Error) => void> = [];
    const stream = { on: (_e: string, l: (e: Error) => void) => { listeners.push(l); } };
    const kill = vi.fn(), onError = vi.fn();
    guardStdio({ stdin: stream, stdout: stream, stderr: null, kill }, onError);
    expect(listeners).toHaveLength(2);
    listeners[0]!(pipeError());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("a pipe the caller hears itself is left to the caller: no second kill", () => {
    const listeners: Array<(e: Error) => void> = [];
    const stream = { on: (_e: string, l: (e: Error) => void) => { listeners.push(l); }, listenerCount: () => listeners.length };
    const kill = vi.fn();
    guardStdio({ stdout: stream, kill });
    listeners[0]!(pipeError());
    expect(kill).toHaveBeenCalledTimes(1);          // alone: the guard kills
    stream.on("error", () => {});                   // the caller's own listener
    listeners[0]!(pipeError());
    expect(kill).toHaveBeenCalledTimes(1);          // heard: the caller's handling is the response
  });

  it("the pipe error goes on as the child's error only to a listener (unheard, it would be uncaught again)", () => {
    const listeners: Array<(e: Error) => void> = [];
    const stream = { on: (_e: string, l: (e: Error) => void) => { listeners.push(l); }, listenerCount: () => 1 };
    let childListeners = 0;
    const emit = vi.fn(() => true);
    guardStdio({ stdout: stream, kill: vi.fn(), emit, listenerCount: () => childListeners });
    listeners[0]!(pipeError());
    expect(emit).not.toHaveBeenCalled();
    childListeners = 1;
    const err = pipeError();
    listeners[0]!(err);
    expect(emit).toHaveBeenCalledWith("error", err);
  });

  it("test doubles without pipes, or no child at all, pass through untouched", () => {
    expect(guardStdio(undefined)).toBeUndefined();
    const fake = { pid: 1 };
    expect(guardStdio(fake)).toBe(fake);
    expect(guardStdio({ stdout: {} })).toEqual({ stdout: {} });
  });
});

describe("#2374 fleet code takes child processes from src/child-process.ts", () => {
  // The *Sync forms have no streams; types are free. Anything else must be the guarded one.
  const ALLOWED = new Set(["execFileSync", "execSync", "spawnSync", "ChildProcess", "SpawnOptions", "SpawnSyncReturns", "ExecFileOptions", "StdioOptions"]);
  const root = join(__dirname, "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mts)$/.test(n) && !/\.test\.ts$/.test(n) ? [p] : [];
  });

  it("no source file imports an unguarded spawn/execFile/exec/fork from node:child_process", () => {
    const offenders: string[] = [];
    for (const file of files(root)) {
      if (file.endsWith(join("src", "child-process.ts"))) continue;
      const text = readFileSync(file, "utf8");
      const names = [
        ...[...text.matchAll(/import\s+(?:type\s+)?\{([^{}]*)\}\s+from\s+["'](?:node:)?child_process["']/g)].map(m => m[1]!),
        ...[...text.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*["'](?:node:)?child_process["']\s*\)/g)].map(m => m[1]!),
      ].flatMap(list => list.split(",").map(n => n.trim().replace(/^type\s+/, "").split(/\s*(?:as|:)\s*/)[0]!).filter(Boolean));
      const bad = names.filter(n => !ALLOWED.has(n));
      if (/import\s+\*\s+as\s+\w+\s+from\s+["'](?:node:)?child_process["']/.test(text)) bad.push("* as");
      if (bad.length) offenders.push(`${relative(root, file)}: ${bad.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
