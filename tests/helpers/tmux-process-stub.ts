import { basename } from "node:path";
import { promisify } from "node:util";
import { afterAll } from "vitest";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as ChildProcess from "node:child_process";

/** Metadata tests have no pane. A missing-pane result must not query live tmux. */
export function stubTmuxProcesses(real: typeof ChildProcess) {
  const execFileSync = (file: string, ...args: any[]) => {
    if (basename(file) !== "tmux") return (real.execFileSync as any)(file, ...args);
    if (args[0]?.includes("-V")) return "tmux 3.5 (fixture)";
    throw new Error("no tmux pane in this unit fixture");
  };
  const execFile = Object.assign((file: string, ...args: any[]) => {
    if (basename(file) !== "tmux") return (real.execFile as any)(file, ...args);
    const callback = [...args].reverse().find(arg => typeof arg === "function");
    queueMicrotask(() => callback?.(new Error("no tmux pane in this unit fixture"), "", ""));
    return { stdin: { on() {}, end() {} } };
  }, { [promisify.custom]: (file: string, ...args: any[]) => new Promise((resolve, reject) => {
    execFile(file, ...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
  }) });
  return { ...real, execFileSync, execFile };
}

/** Patch the native exports too: parallel dynamic imports can bypass vi.mock. */
export function installTmuxProcessFixture(): void {
  const native = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;
  const original = { ...native };
  const stub = stubTmuxProcesses(original);
  native.execFile = stub.execFile as unknown as typeof native.execFile;
  native.execFileSync = stub.execFileSync as typeof native.execFileSync;
  syncBuiltinESMExports();
  afterAll(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    native.execFile = original.execFile;
    native.execFileSync = original.execFileSync;
    syncBuiltinESMExports();
  });
}
